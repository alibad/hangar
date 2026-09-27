"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Download, RotateCcw } from "lucide-react";

/**
 * An interactive GLB viewer: orbit, three lighting set-ups, wireframe, clay
 * (textures off) and a turntable — plus the numbers that decide what a mesh is
 * good for: triangles, texture size, and whether the surface is closed.
 *
 * Built on the `three` the console already ships, not on
 * <model-viewer> or react-three-fiber, so it adds no dependency. Rendering is
 * event-driven: nothing draws while nothing moves, except
 * while the turntable is on.
 */

export type MeshStats = {
  triangles: number;
  vertices: number;
  /** Largest texture edge in pixels, or null for an untextured / vertex-coloured mesh. */
  textureSize: number | null;
  textureCount: number;
  vertexColors: boolean;
  materials: number;
  /** Edges used by exactly one triangle, after welding UV-seam duplicates. 0 = closed. */
  openEdges: number;
  /** Edges shared by more than two triangles. 0 = manifold. */
  nonManifoldEdges: number;
  /** Bounding box, in the file's units, Y-up. */
  size: [number, number, number];
};

type Lighting = "studio" | "flat" | "dramatic";

const LIGHTING: { id: Lighting; label: string; hint: string }[] = [
  { id: "studio", label: "Studio", hint: "Image-based lighting — how PBR materials are meant to look" },
  { id: "flat", label: "Flat", hint: "Even light — shows the baked albedo, hides the shape" },
  { id: "dramatic", label: "Raking", hint: "One low key light — shows surface detail and faceting" },
];

/**
 * Topology from the triangles themselves. GLB exporters split vertices wherever
 * UVs or normals differ, so an honest open-edge count must first weld by
 * position; otherwise every UV seam reads as a hole.
 */
export function analyzeTopology(root: THREE.Object3D): Pick<MeshStats, "openEdges" | "nonManifoldEdges" | "triangles" | "vertices"> {
  const edgeUse = new Map<string, number>();
  const weld = new Map<string, number>();
  let triangles = 0;
  let vertices = 0;
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute("position");
    if (!pos) return;
    vertices += pos.count;
    // Weld tolerance: 1e-5 of the part's size is far below any real feature.
    g.computeBoundingBox();
    const span = g.boundingBox ? g.boundingBox.getSize(new THREE.Vector3()).length() : 1;
    const q = 1 / Math.max(span * 1e-5, 1e-9);
    const ids = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.round(v.x * q)},${Math.round(v.y * q)},${Math.round(v.z * q)}`;
      let id = weld.get(key);
      if (id === undefined) {
        id = weld.size;
        weld.set(key, id);
      }
      ids[i] = id;
    }
    const index = g.getIndex();
    const n = index ? index.count : pos.count;
    const at = (k: number) => ids[index ? index.getX(k) : k];
    for (let k = 0; k + 2 < n; k += 3) {
      const a = at(k), b = at(k + 1), c = at(k + 2);
      if (a === b || b === c || a === c) continue; // degenerate after welding
      triangles++;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const key = x < y ? `${x}_${y}` : `${y}_${x}`;
        edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
      }
    }
  });
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const c of edgeUse.values()) {
    if (c === 1) openEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  return { openEdges, nonManifoldEdges, triangles, vertices };
}

function collectStats(root: THREE.Object3D): MeshStats {
  const topo = analyzeTopology(root);
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  let vertexColors = false;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry.getAttribute("color")) vertexColors = true;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(m);
      const std = m as THREE.MeshStandardMaterial;
      for (const t of [std.map, std.normalMap, std.roughnessMap, std.metalnessMap, std.emissiveMap, std.aoMap]) {
        if (t) textures.add(t);
      }
    }
  });
  let textureSize: number | null = null;
  for (const t of textures) {
    const img = t.image as { width?: number; height?: number } | undefined;
    if (img?.width) textureSize = Math.max(textureSize ?? 0, img.width, img.height ?? 0);
  }
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return {
    ...topo,
    textureSize,
    textureCount: textures.size,
    vertexColors,
    materials: materials.size,
    size: [size.x, size.y, size.z],
  };
}

export default function MeshViewer({
  url,
  downloadName,
  onStats,
  className = "",
}: {
  /** A GLB the browser can fetch. */
  url: string;
  downloadName?: string;
  onStats?: (s: MeshStats) => void;
  className?: string;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctx = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    env: THREE.Texture;
    lights: THREE.Group;
    grid: THREE.GridHelper;
  } | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const wireRef = useRef<THREE.Group | null>(null);
  const originals = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>());
  const frameRef = useRef<() => void>(() => {});
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  const [lighting, setLighting] = useState<Lighting>("studio");
  const [wireframe, setWireframe] = useState(false);
  const [clay, setClay] = useState(false);
  const [spin, setSpin] = useState(false);
  const [grid, setGrid] = useState(true);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<MeshStats | null>(null);

  const renderNow = useCallback(() => {
    const c = ctx.current;
    if (c) c.renderer.render(c.scene, c.camera);
  }, []);

  // Renderer, scene, camera, controls: once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      setState("error");
      setError(`WebGL unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const w = mount.clientWidth || 480;
    const h = mount.clientHeight || 480;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);
    const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 1000);
    camera.position.set(0, 0.4, 2.4);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const lights = new THREE.Group();
    scene.add(lights);
    const gridHelper = new THREE.GridHelper(4, 16, 0x3a3f4b, 0x1f232b);
    scene.add(gridHelper);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.addEventListener("change", renderNow);

    ctx.current = { renderer, scene, camera, controls, env, lights, grid: gridHelper };

    const ro = new ResizeObserver(() => {
      const cw = mount.clientWidth || 480;
      const ch = mount.clientHeight || 480;
      renderer.setSize(cw, ch);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderNow();
    });
    ro.observe(mount);

    return () => {
      ro.disconnect();
      controls.removeEventListener("change", renderNow);
      controls.dispose();
      env.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      ctx.current = null;
    };
  }, [renderNow]);

  // Lighting rig.
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.lights.clear();
    c.scene.environment = null;
    c.renderer.toneMappingExposure = 1;
    if (lighting === "studio") {
      c.scene.environment = c.env;
      const key = new THREE.DirectionalLight(0xffffff, 0.6);
      key.position.set(2, 3, 2);
      c.lights.add(key);
    } else if (lighting === "flat") {
      c.lights.add(new THREE.AmbientLight(0xffffff, 2.2));
      c.renderer.toneMappingExposure = 0.9;
    } else {
      c.lights.add(new THREE.AmbientLight(0xffffff, 0.08));
      const key = new THREE.DirectionalLight(0xfff1e0, 3.2);
      key.position.set(3, 0.6, 1.2);
      c.lights.add(key);
      const rim = new THREE.DirectionalLight(0x7aa2ff, 0.8);
      rim.position.set(-2, 1.5, -2.5);
      c.lights.add(rim);
    }
    renderNow();
  }, [lighting, renderNow]);

  // Load the model.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !url) return;
    let cancelled = false;
    setState("loading");
    setError(null);
    setStats(null);
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (cancelled) return;
        if (modelRef.current) {
          c.scene.remove(modelRef.current);
          disposeTree(modelRef.current);
        }
        if (wireRef.current) {
          c.scene.remove(wireRef.current);
          disposeOverlay(wireRef.current);
          wireRef.current = null;
        }
        originals.current.clear();
        const model = gltf.scene;
        // Normalise: centred on the origin, standing on the grid, ~1.6 units tall
        // at most. Reconstruction models disagree about scale and origin.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const s = 1.6 / Math.max(size.x, size.y, size.z, 1e-6);
        model.scale.setScalar(s);
        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) originals.current.set(m, m.material);
        });
        c.scene.add(model);
        modelRef.current = model;

        const st = collectStats(model);
        // Report the file's own bounding box, not the normalised one.
        st.size = [size.x, size.y, size.z];
        setStats(st);
        onStatsRef.current?.(st);
        frameRef.current();
        setState("ready");
      },
      undefined,
      (err) => {
        if (cancelled) return;
        setState("error");
        setError(err instanceof Error ? err.message : "Could not load the GLB");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  const frame = useCallback(() => {
    const c = ctx.current;
    const model = modelRef.current;
    if (!c || !model) return;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const r = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
    const dist = (r / Math.sin((c.camera.fov * Math.PI) / 360)) * 1.05;
    c.controls.target.copy(center);
    c.camera.position.set(center.x + dist * 0.45, center.y + dist * 0.25, center.z + dist * 0.85);
    c.camera.near = Math.max(0.001, r / 200);
    c.camera.far = r * 200;
    c.camera.updateProjectionMatrix();
    c.controls.update();
    renderNow();
  }, [renderNow]);
  frameRef.current = frame;

  // Clay: swap every material for one neutral grey, keep the originals to restore.
  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    const claymat = new THREE.MeshStandardMaterial({ color: 0xb8b2a7, roughness: 0.85, metalness: 0 });
    for (const [mesh, mat] of originals.current) mesh.material = clay ? claymat : mat;
    renderNow();
    return () => claymat.dispose();
  }, [clay, state, renderNow]);

  // Wireframe: an overlay of the triangle edges, so it reads over textures.
  useEffect(() => {
    const c = ctx.current;
    const model = modelRef.current;
    if (!c || !model) return;
    if (wireRef.current) {
      c.scene.remove(wireRef.current);
      disposeOverlay(wireRef.current);
      wireRef.current = null;
    }
    if (wireframe) {
      const group = new THREE.Group();
      model.updateMatrixWorld(true);
      const mat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.35, depthTest: true });
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const w = new THREE.Mesh(m.geometry, mat);
        w.matrixAutoUpdate = false;
        w.matrix.copy(m.matrixWorld);
        w.renderOrder = 1;
        group.add(w);
      });
      c.scene.add(group);
      wireRef.current = group;
    }
    renderNow();
  }, [wireframe, state, renderNow]);

  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    c.grid.visible = grid;
    renderNow();
  }, [grid, renderNow]);

  // Turntable: the one case that needs a render loop.
  useEffect(() => {
    const c = ctx.current;
    if (!c || !spin) return;
    c.controls.autoRotate = true;
    c.controls.autoRotateSpeed = 2.5;
    let raf = 0;
    const tick = () => {
      c.controls.update();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      c.controls.autoRotate = false;
    };
  }, [spin]);

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) => (
    <label title={title} className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-gray-400">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="accent-emerald-500" /> {label}
    </label>
  );

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex overflow-hidden rounded-md border border-gray-800" role="radiogroup" aria-label="Lighting">
          {LIGHTING.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={lighting === l.id}
              title={l.hint}
              onClick={() => setLighting(l.id)}
              className={`px-2.5 py-1 text-[11px] ${lighting === l.id ? "bg-gray-700 text-gray-100" : "text-gray-400 hover:bg-gray-800"}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        {toggle(wireframe, setWireframe, "wireframe", "Overlay the triangle edges")}
        {toggle(clay, setClay, "clay", "Hide the textures: judge the shape alone")}
        {toggle(spin, setSpin, "turntable", "Rotate continuously")}
        {toggle(grid, setGrid, "grid", "Ground grid")}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={frame}
            title="Reset the camera"
            className="flex items-center gap-1 rounded-md border border-gray-800 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
          >
            <RotateCcw className="h-3 w-3" /> Reset view
          </button>
          <a
            href={url}
            download={downloadName ?? "mesh.glb"}
            className="flex items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-900/30 px-2 py-1 text-[11px] text-emerald-200 hover:bg-emerald-900/50"
          >
            <Download className="h-3 w-3" /> GLB
          </a>
        </div>
      </div>
      <div className="relative">
        <div
          ref={mountRef}
          data-testid="mesh-viewer"
          className="aspect-square w-full cursor-grab touch-none overflow-hidden rounded-lg border border-gray-800 bg-black active:cursor-grabbing"
        />
        {state !== "ready" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-xs text-gray-400">
            {state === "loading" ? "Loading mesh…" : <span className="text-red-300">{error}</span>}
          </div>
        )}
      </div>
      {stats && <StatsLine stats={stats} />}
    </div>
  );
}

function StatsLine({ stats }: { stats: MeshStats }) {
  const closed = stats.openEdges === 0;
  const manifold = stats.nonManifoldEdges === 0;
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4" data-testid="mesh-stats">
      <div>
        <dt className="text-gray-600">Triangles</dt>
        <dd className="tabular-nums text-gray-200">{fmt(stats.triangles)}</dd>
      </div>
      <div>
        <dt className="text-gray-600">Texture</dt>
        <dd className="tabular-nums text-gray-200">
          {stats.textureSize ? `${stats.textureSize}² × ${stats.textureCount}` : stats.vertexColors ? "vertex colours" : "none"}
        </dd>
      </div>
      <div title="Edges used by one triangle only, after welding UV seams. Zero means a closed surface.">
        <dt className="text-gray-600">Surface</dt>
        <dd className={closed ? "text-emerald-300" : "text-amber-300"}>
          {closed ? "closed" : `${fmt(stats.openEdges)} open edges`}
          {!manifold && <span className="text-amber-300"> · {fmt(stats.nonManifoldEdges)} non-manifold</span>}
        </dd>
      </div>
      <div title="A slicer needs a closed, manifold surface.">
        <dt className="text-gray-600">Printable as-is</dt>
        <dd className={closed && manifold ? "text-emerald-300" : "text-amber-300"}>{closed && manifold ? "yes" : "needs repair"}</dd>
      </div>
    </dl>
  );
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const n = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    n.geometry?.dispose?.();
    const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose();
      m.dispose();
    }
  });
}

/** The wireframe overlay shares the model's geometry: free only its material. */
function disposeOverlay(group: THREE.Object3D) {
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m && !Array.isArray(m)) mats.add(m);
  });
  for (const m of mats) m.dispose();
}
