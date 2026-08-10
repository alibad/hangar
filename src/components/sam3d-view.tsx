"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ServiceControls, ServiceStartupNote, useServiceLifecycle } from "./service-control";
import { PersonArmsSpread } from "@phosphor-icons/react";
import { ToolPageHeader } from "./tool-page";

type Health = {
  up: boolean;
  latency: number;
  ready?: boolean;
  device?: string;
  model?: string;
  vram?: { used_gb: number; total_gb: number };
  error?: string;
};

type PoseResult = {
  ok: boolean;
  error?: string;
  width?: number;
  height?: number;
  keypoints_3d_mhr70?: number[][];
  global_rot?: number[];
  mediapipe33?: { landmarks: number[][]; image: number[][] };
  vertices?: number[][];
  faces?: number[][] | null;
};

// MediaPipe Pose 33-landmark skeleton connections.
const POSE_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-gray-600">{k}</dt>
      <dd className="text-gray-300 text-right break-all">{v}</dd>
    </div>
  );
}

// ── interactive 3D viewer (WebGL via three.js, orbit with OrbitControls) ──────
// Real GPU rendering: the full shaded body mesh + skeleton, orbited/zoomed with
// OrbitControls. Rendering is event-driven (render on control 'change' / resize),
// so drag is buttery and idle GPU cost is zero. The camera auto-frames the model.
function Pose3D({ landmarks, vertices, faces }: { landmarks?: number[][]; vertices?: number[][]; faces?: number[][] | null }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const [showMesh, setShowMesh] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [glError, setGlError] = useState<string | null>(null);

  const renderNow = useCallback(() => {
    const r = rendererRef.current, s = sceneRef.current, c = cameraRef.current;
    if (r && s && c) r.render(s, c);
  }, []);

  // Create renderer / scene / camera / controls / lights once, on mount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (e) {
      setGlError(e instanceof Error ? e.message : "WebGL unavailable");
      return;
    }
    const w = mount.clientWidth || 380, h = mount.clientHeight || 380;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070d);

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
    camera.position.set(0, 0, 3);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    mount.appendChild(renderer.domElement);

    // Soft sky/ground fill + a key light and a violet rim so the body reads as 3D.
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2140, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(1, 2, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8b7bff, 0.5);
    rim.position.set(-2, 1, -2);
    scene.add(rim);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false; // event-driven render → smooth drag, zero idle GPU
    controls.rotateSpeed = 0.9;
    controls.addEventListener("change", renderNow);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;

    const ro = new ResizeObserver(() => {
      const cw = mount.clientWidth || 380, ch = mount.clientHeight || 380;
      renderer.setSize(cw, ch);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
      renderNow();
    });
    ro.observe(mount);
    renderNow();

    return () => {
      ro.disconnect();
      controls.removeEventListener("change", renderNow);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      rendererRef.current = sceneRef.current = null as never;
      cameraRef.current = controlsRef.current = null as never;
    };
  }, [renderNow]);

  // (Re)build the model geometry whenever the data changes, then frame it.
  useEffect(() => {
    const scene = sceneRef.current, camera = cameraRef.current, controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    if (contentRef.current) {
      scene.remove(contentRef.current);
      contentRef.current.traverse((o) => {
        const n = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
        n.geometry?.dispose?.();
        if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose());
        else n.material?.dispose?.();
      });
      contentRef.current = meshRef.current = null;
    }

    const group = new THREE.Group();
    const FY = -1; // SAM 3D returns Y-down (image space); flip to Y-up so the body stands upright.

    if (vertices && vertices.length && faces && faces.length) {
      const pos = new Float32Array(vertices.length * 3);
      for (let i = 0; i < vertices.length; i++) {
        pos[i * 3] = vertices[i][0];
        pos[i * 3 + 1] = vertices[i][1] * FY;
        pos[i * 3 + 2] = vertices[i][2];
      }
      const idx = new Uint32Array(faces.length * 3);
      for (let i = 0; i < faces.length; i++) {
        idx[i * 3] = faces[i][0]; idx[i * 3 + 1] = faces[i][1]; idx[i * 3 + 2] = faces[i][2];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x6366f1, metalness: 0.05, roughness: 0.78, side: THREE.DoubleSide, wireframe });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = showMesh;
      meshRef.current = mesh;
      group.add(mesh);
    }

    // Skeleton (MediaPipe-33 world landmarks): bones as line segments + joints as points.
    const skel = (landmarks ?? []).map((p) => (p && p[3] !== 0 ? new THREE.Vector3(p[0], p[1] * FY, p[2]) : null));
    if (skel.some(Boolean)) {
      const bonePts: number[] = [];
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = skel[a], pb = skel[b];
        if (pa && pb) bonePts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
      if (bonePts.length) {
        const bg = new THREE.BufferGeometry();
        bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bonePts), 3));
        group.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0x818cf8 })));
      }
      const jointPts: number[] = [];
      for (const p of skel) if (p) jointPts.push(p.x, p.y, p.z);
      if (jointPts.length) {
        const jg = new THREE.BufferGeometry();
        jg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(jointPts), 3));
        group.add(new THREE.Points(jg, new THREE.PointsMaterial({ color: 0xf43f5e, size: 5, sizeAttenuation: false })));
      }
    }

    scene.add(group);
    contentRef.current = group;

    // Frame the model: target its center, pull the camera back to fit the bounding sphere.
    const box = new THREE.Box3().setFromObject(group);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const r = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
      controls.target.copy(center);
      const dist = (r / Math.sin(((camera.fov * Math.PI) / 180) / 2)) * 1.15;
      camera.position.set(center.x + dist * 0.22, center.y + dist * 0.08, center.z + dist);
      camera.near = Math.max(0.001, r / 100);
      camera.far = r * 100;
      camera.updateProjectionMatrix();
      controls.update();
    }
    renderNow();
    // Rebuild only on data change; showMesh/wireframe are applied live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landmarks, vertices, faces, renderNow]);

  // Toggle mesh visibility / wireframe without rebuilding or resetting the view.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.visible = showMesh;
    (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
    renderNow();
  }, [showMesh, wireframe, renderNow]);

  const hasMesh = !!(vertices && vertices.length && faces && faces.length);

  return (
    <div>
      <div className="flex items-center justify-between mb-2 gap-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">3D pose · drag to orbit · scroll to zoom</h3>
        {hasMesh && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={showMesh} onChange={(e) => setShowMesh(e.target.checked)} /> mesh
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
              <input type="checkbox" checked={wireframe} onChange={(e) => setWireframe(e.target.checked)} /> wire
            </label>
          </div>
        )}
      </div>
      {glError ? (
        <div className="w-full max-w-[380px] aspect-square rounded-lg border border-gray-800 bg-black grid place-items-center text-[11px] text-red-400/80 px-4 text-center">
          WebGL unavailable: {glError}
        </div>
      ) : (
        <div
          ref={mountRef}
          className="w-full max-w-[380px] aspect-square rounded-lg border border-gray-800 bg-black overflow-hidden cursor-grab active:cursor-grabbing touch-none"
        />
      )}
    </div>
  );
}

export default function Sam3dView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [includeMesh, setIncludeMesh] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PoseResult | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Returns the fresh verdict as well as storing it, so the lifecycle hook can
  // poll it after a Start until the service is really up.
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const h: Health = await fetch("/api/sam3d/health").then((r) => r.json());
      setHealth(h);
      return !!h.up;
    } catch {
      setHealth({ up: false, latency: 0, error: "unreachable" });
      return false;
    }
  }, []);
  useEffect(() => {
    checkHealth();
    const t = setInterval(checkHealth, 15000);
    return () => clearInterval(t);
  }, [checkHealth]);

  const lifecycle = useServiceLifecycle("sam3d", health?.up, checkHealth);

  function pickFile(f: File) {
    if (!f.type.startsWith("image/")) return;
    setFile(f);
    setResult(null);
    setError(null);
    setImgUrl(URL.createObjectURL(f));
  }

  async function analyze() {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const t0 = Date.now();
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("mediapipe", "true");
      fd.append("include_mesh", includeMesh ? "true" : "false");
      const data = await fetch("/api/sam3d/pose", { method: "POST", body: fd }).then((r) => r.json());
      setLatency(Date.now() - t0);
      if (data.ok) setResult(data);
      else setError(data.error || "Pose estimation failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  // 2D overlay: draw the image + skeleton from normalized image coords.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgUrl) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 380 / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const pts = result?.mediapipe33?.image;
      if (pts) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "rgba(99,102,241,0.9)";
        for (const [a, b] of POSE_CONNECTIONS) {
          const pa = pts[a], pb = pts[b];
          if (!pa || !pb || pa[2] < 0.3 || pb[2] < 0.3) continue;
          ctx.beginPath(); ctx.moveTo(pa[0] * w, pa[1] * h); ctx.lineTo(pb[0] * w, pb[1] * h); ctx.stroke();
        }
        for (const p of pts) {
          if (!p || p[2] < 0.3) continue;
          ctx.beginPath(); ctx.arc(p[0] * w, p[1] * h, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "#f43f5e"; ctx.fill();
        }
      }
    };
    img.src = imgUrl;
  }, [result, imgUrl]);

  const ready = !!(health?.up && health?.ready);
  const fmtRot = (r?: number[]) => (r ? r.map((v) => v.toFixed(2)).join(", ") : "—");

  return (
    <div className="tool-page vision-page sam3d-page space-y-6">
      <ToolPageHeader
        eyebrow="3D vision"
        title="3D Body"
        description="Turn one person photo into a rotatable pose, landmark set, and optional body mesh on your GPU."
        icon={<PersonArmsSpread size={24} weight="duotone" />}
        meta={<span className={`tool-page-chip ${ready ? "is-ready" : "is-offline"}`}>{ready ? "Model ready" : "On demand"}</span>}
      />
      {/* health header */}
      <section className="tool-panel service-status-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`w-2.5 h-2.5 rounded-full ${
            lifecycle.busyVerb ? "bg-amber-400 animate-pulse"
            : !health ? "bg-gray-600"
            : ready ? "bg-green-500"
            : health.up ? "bg-yellow-500 animate-pulse"
            : "bg-red-500"
          }`} />
          <span className="font-semibold text-sm">SAM 3D Body</span>
          <span className="text-xs text-gray-500">localhost:8009</span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${
            lifecycle.busyVerb ? "bg-amber-500/10 text-amber-400"
            : !health?.up ? "bg-red-500/10 text-red-400"
            : ready ? "bg-green-500/10 text-green-400"
            : "bg-yellow-500/10 text-yellow-400"
          }`}>
            {lifecycle.busyVerb
              ? `${lifecycle.busyVerb === "stop" ? "stopping" : lifecycle.busyVerb === "restart" ? "restarting" : "starting"}…`
              : !health?.up ? "offline"
              : ready ? `ready · ${health.device}`
              : "loading model…"}
          </span>
          {health?.vram && <span className="text-[11px] text-gray-500 tabular-nums">VRAM {health.vram.used_gb}/{health.vram.total_gb} GB</span>}
          {/* Lifecycle where the problem is reported — not "go to another tab". */}
          <ServiceControls lifecycle={lifecycle} onRefresh={checkHealth} className="ml-auto" />
        </div>
        <ServiceStartupNote lifecycle={lifecycle} downMessage="SAM 3D Body isn't running." className="mt-2" />
      </section>

      {/* uploader + options */}
      <section className="tool-panel vision-workspace bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        <p className="text-xs text-gray-500">Upload a photo of a person → SAM 3D Body recovers a full-body 3D pose: 70 joints, global rotation, MediaPipe-33, and an optional body mesh.</p>
        <div
          className={`rounded-xl border-2 border-dashed transition p-6 text-center cursor-pointer ${dragOver ? "border-indigo-500 bg-indigo-500/5" : "border-gray-700 hover:border-gray-500"}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) pickFile(f); }}
          onClick={() => fileRef.current?.click()}
        >
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
          {file ? <p className="text-sm text-gray-300">{file.name} — click to change</p> : <p className="text-sm text-gray-400 py-2">Drop a photo, or click to upload</p>}
        </div>
        <div className="flex items-center gap-4 flex-wrap text-xs">
          <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer select-none">
            <input type="checkbox" checked={includeMesh} onChange={(e) => setIncludeMesh(e.target.checked)} /> include body mesh
          </label>
          <button
            onClick={analyze}
            disabled={!file || busy || !ready}
            className="ml-auto bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl px-6 py-2.5 text-sm font-medium transition"
          >
            {busy ? "Analyzing…" : "Analyze pose"}
          </button>
        </div>
        {!ready && health?.up && <p className="text-[11px] text-amber-400">Model still loading — give it a moment.</p>}
        {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">{error}</div>}
      </section>

      {/* results */}
      {(imgUrl || result) && (
        <section className="space-y-5">
          <div className="grid md:grid-cols-2 gap-5">
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Image overlay</h3>
              {/* eslint-disable-next-line @next/next/no-img-element -- canvas, not img */}
              <canvas ref={canvasRef} className="w-full max-w-[380px] rounded-lg border border-gray-800 bg-black" />
              {!result && imgUrl && <p className="text-[11px] text-gray-600 mt-2">Run “Analyze pose” to overlay the skeleton.</p>}
            </div>
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
              {result ? (
                <Pose3D landmarks={result.mediapipe33?.landmarks} vertices={result.vertices} faces={result.faces} />
              ) : (
                <p className="text-[11px] text-gray-600">The rotatable 3D pose appears here after analysis.</p>
              )}
            </div>
          </div>

          {result && (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-2 text-xs">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Result</h3>
              <dl className="grid sm:grid-cols-2 gap-x-8 gap-y-1.5">
                <Row k="3D keypoints (MHR-70)" v={String(result.keypoints_3d_mhr70?.length ?? 0)} />
                <Row k="global rotation" v={fmtRot(result.global_rot)} />
                <Row k="MediaPipe-33" v={result.mediapipe33 ? "yes" : "no"} />
                <Row k="body mesh" v={result.vertices ? `${result.vertices.length} verts · ${result.faces?.length ?? 0} faces` : "not requested"} />
                <Row k="image size" v={`${result.width}×${result.height}`} />
                <Row k="latency" v={latency != null ? `${(latency / 1000).toFixed(1)}s` : "—"} />
              </dl>
              <details className="mt-2">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-300">raw response</summary>
                <pre className="mt-2 text-[10px] font-mono bg-gray-800 rounded-lg p-2 overflow-auto max-h-64 text-gray-300">
{JSON.stringify(
  {
    ...result,
    keypoints_3d_mhr70: result.keypoints_3d_mhr70 ? `[${result.keypoints_3d_mhr70.length} × 3]` : undefined,
    mediapipe33: result.mediapipe33 ? "{ landmarks[33], image[33] }" : undefined,
    vertices: result.vertices ? `[${result.vertices.length} × 3]` : undefined,
    faces: result.faces ? `[${result.faces.length} × 3]` : undefined,
  },
  null,
  2,
)}
                </pre>
              </details>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
