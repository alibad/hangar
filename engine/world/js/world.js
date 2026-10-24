// The stage: renderer, sky, light, cloud sea, camera and controls, at a quality the machine can afford.
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { clamp, lerp, rng } from "./util.js";

/** Software WebGL (Chrome with hardware acceleration off draws on the CPU) gets the light tier. */
export function detectQuality(forced) {
  if (forced === "low" || forced === "medium" || forced === "high") return { tier: forced, renderer: "forced", software: false };
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return { tier: "none", renderer: "", software: true };
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const software = /swiftshader|warp|basic render|llvmpipe|softpipe|software/i.test(name);
  const mobile = /android|iphone|ipad/i.test(navigator.userAgent);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return { tier: software ? "low" : mobile ? "medium" : "high", renderer: String(name), software };
}

const DAY = {
  top: new THREE.Color("#4d8fdb"), horizon: new THREE.Color("#bcd9f0"), bottom: new THREE.Color("#dce9f2"),
  sun: new THREE.Color("#fff1d8"), sunI: 3.3, hemiSky: new THREE.Color("#d6ebff"), hemiGround: new THREE.Color("#6f7d5c"),
  hemiI: 0.78, fog: new THREE.Color("#c4dcee"), exposure: 1.02,
};
const NIGHT = {
  top: new THREE.Color("#101827"), horizon: new THREE.Color("#334666"), bottom: new THREE.Color("#1c2539"),
  sun: new THREE.Color("#c4d0f5"), sunI: 1.25, hemiSky: new THREE.Color("#788bb1"), hemiGround: new THREE.Color("#272d3b"),
  hemiI: 0.8, fog: new THREE.Color("#1c2941"), exposure: 1.15,
};

export function createWorld(canvas, labelsEl, quality) {
  const tier = quality.tier;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: tier !== "low", powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier === "high" ? 2 : tier === "medium" ? 1.5 : 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = tier === "high";
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(DAY.fog.clone(), 260, 900);
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 4000);
  camera.position.set(160, 190, 230);

  const labels = new CSS2DRenderer({ element: labelsEl });

  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.minDistance = 18;
  controls.maxDistance = 900;
  controls.minPolarAngle = 0.18;
  controls.maxPolarAngle = 1.32;
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 1.0;
  controls.keyPanSpeed = 22;

  // Sky dome: a gradient with a soft glow where the sun or moon is.
  const skyU = {
    top: { value: DAY.top.clone() }, horizon: { value: DAY.horizon.clone() }, bottom: { value: DAY.bottom.clone() },
    sunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() }, glow: { value: 1 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2800, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform float glow; varying vec3 vDir;
        void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, bottom, pow(clamp(-h,0.0,1.0), 0.4));
          float s = max(dot(normalize(vDir), sunDir), 0.0); c += glow * (pow(s, 64.0) * 0.6 + pow(s, 6.0) * 0.12) * vec3(1.0, 0.92, 0.8);
          gl_FragColor = vec4(c, 1.0); }`,
    }),
  );
  sky.renderOrder = -10;
  scene.add(sky);

  // Stars, faded in at night.
  const starRand = rng(7);
  const starPos = new Float32Array(1600 * 3);
  for (let i = 0; i < 1600; i++) {
    const u = starRand() * 2 - 1, a = starRand() * Math.PI * 2, r = 2600;
    const y = Math.abs(u) * 0.95 + 0.05;
    const k = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(a) * k * r, y * r, Math.sin(a) * k * r], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: "#ffffff", size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  scene.add(stars);

  const hemi = new THREE.HemisphereLight(DAY.hemiSky.clone(), DAY.hemiGround.clone(), DAY.hemiI);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(DAY.sun.clone(), DAY.sunI);
  sun.position.set(220, 320, 160);
  sun.castShadow = renderer.shadowMap.enabled;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }
  scene.add(sun, sun.target);

  // A cloud sea below the islands and a few puffs drifting between them.
  const clouds = new THREE.Group();
  scene.add(clouds);
  const puff = cloudTexture();

  let composer = null, bloom = null;
  if (tier === "high") {
    composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.42, 0.9);
    bloom.enabled = false;
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  const world = {
    THREE, renderer, scene, camera, controls, labels, sun, hemi, sky, stars, clouds, composer, bloom, tier, night: 0,
    extent: 300, isLite: tier === "low",
    /** One way: no shadows and no bloom from now on. */
    lite() {
      world.isLite = true;
      renderer.shadowMap.enabled = false;
      sun.castShadow = false;
      if (bloom) bloom.enabled = false;
      scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    },
    frame(extent) {
      world.extent = extent;
      const r = extent;
      scene.fog.near = r * 1.7;
      scene.fog.far = r * 5.5;
      controls.maxDistance = Math.max(260, r * 3.2);
      if (sun.castShadow) {
        const s = sun.shadow.camera;
        s.left = s.bottom = -r * 1.05;
        s.right = s.top = r * 1.05;
        s.near = 10;
        s.far = r * 4;
        s.updateProjectionMatrix();
      }
      sun.position.set(r * 0.75, r * 1.1, r * 0.55);
      skyU.sunDir.value.copy(sun.position).normalize();
      buildClouds(clouds, puff, r, tier);
    },
    /** 0 = day, 1 = night; everything that depends on the hour follows this one number. */
    setNight(n) {
      world.night = n = clamp(n, 0, 1);
      skyU.top.value.lerpColors(DAY.top, NIGHT.top, n);
      skyU.horizon.value.lerpColors(DAY.horizon, NIGHT.horizon, n);
      skyU.bottom.value.lerpColors(DAY.bottom, NIGHT.bottom, n);
      skyU.glow.value = lerp(1, 0.35, n);
      scene.fog.color.lerpColors(DAY.fog, NIGHT.fog, n);
      sun.color.lerpColors(DAY.sun, NIGHT.sun, n);
      sun.intensity = lerp(DAY.sunI, NIGHT.sunI, n);
      hemi.color.lerpColors(DAY.hemiSky, NIGHT.hemiSky, n);
      hemi.groundColor.lerpColors(DAY.hemiGround, NIGHT.hemiGround, n);
      hemi.intensity = lerp(DAY.hemiI, NIGHT.hemiI, n);
      renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure, n);
      stars.material.opacity = clamp((n - 0.35) / 0.5, 0, 1);
      for (const c of clouds.children) {
        c.material.opacity = c.userData.alpha * lerp(1, c.userData.high ? 0.1 : 0.2, n);
        c.material.color.setScalar(lerp(1, 0.22, n));
      }
      if (bloom) bloom.enabled = n > 0.45 && !world.isLite;
    },
    resize() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      composer?.setSize(w, h);
      bloom?.setSize(w, h);
    },
    /** withLabels false: the 3D scene only. Floating labels are HTML, and moving dozens of them costs the browser a
     *  layout and a repaint every frame, so callers skip them when the camera has not moved. */
    render(withLabels = true) {
      if (composer && bloom?.enabled && !world.isLite) composer.render();
      else renderer.render(scene, camera);
      if (withLabels) labels.render(scene, camera);
    },
    drift(t) {
      for (const c of clouds.children) {
        const u = c.userData;
        c.position.x = u.x + Math.sin(t * u.speed + u.phase) * u.amp;
        c.position.z = u.z + Math.cos(t * u.speed * 0.7 + u.phase) * u.amp * 0.6;
      }
    },
  };
  return world;
}

function cloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildClouds(group, tex, r, tier) {
  for (const c of [...group.children]) {
    group.remove(c);
    c.material.dispose();
  }
  const rand = rng(42);
  const below = tier === "low" ? 26 : 60, between = tier === "low" ? 6 : 16;
  const add = (x, y, z, size, alpha, high = false) => {
    const m = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: alpha, depthWrite: false, fog: true });
    const s = new THREE.Sprite(m);
    s.scale.set(size, size * 0.55, 1);
    s.position.set(x, y, z);
    s.userData = { x, z, alpha, high, amp: 4 + rand() * 10, speed: 0.02 + rand() * 0.04, phase: rand() * 6.28 };
    group.add(s);
  };
  for (let i = 0; i < below; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r * 1.5;
    add(Math.cos(a) * d, -60 - rand() * 30, Math.sin(a) * d, 90 + rand() * 120, 0.55 + rand() * 0.3);
  }
  for (let i = 0; i < between; i++) {
    const a = rand() * Math.PI * 2, d = r * (0.85 + rand() * 0.6);
    add(Math.cos(a) * d, 45 + rand() * 50, Math.sin(a) * d, 40 + rand() * 50, 0.22 + rand() * 0.16, true);
  }
}
