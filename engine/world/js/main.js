// Hangar: load the map, build the world, and draw only when something changes.
import * as THREE from "three";
import { createWorld, detectQuality } from "./world.js";
import { layout } from "./layout.js";
import { Building, buildIsland, buildSheds, createShared, decorate } from "./city.js";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { lensById, pending, CHANGE } from "./lenses.js";
import { createUI } from "./ui.js";
import { icon } from "./icons.js";
import { sound } from "./sound.js";
import { createLife } from "./life.js";
import { clamp, easeInOut, lerp } from "./util.js";
import { api, embedded, tellHost, listenHost } from "./host.js";
import { createHarbors } from "./harbors.js";
import { homeView } from "./camera-view.js";

const params = new URLSearchParams(location.search);
document.body.classList.toggle("hangar-embedded", embedded);
let hostHidden = false;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const loading = document.getElementById("loading");

async function loadDoc() {
  try {
    const r = await fetch(api("/api/atlas"), { cache: "no-store" });
    if (r.ok) return { doc: await r.json(), local: true };
  } catch {}
  const r = await fetch("atlas.json", { cache: "no-store" });
  if (!r.ok) throw new Error("No map data. Start Hangar with `py engine/main.py`, or publish one with `py engine/main.py publish`.");
  return { doc: await r.json(), local: false };
}

async function boot() {
  if (embedded && ["repo", "tools"].includes(params.get("pane"))) {
    const { doc } = await loadDoc();
    const { startProjectPane } = await import("./project-pane.js");
    return startProjectPane(doc, params);
  }
  const quality = detectQuality(params.get("quality"));
  if (quality.tier === "none") throw new Error("This browser cannot draw 3D (WebGL is off). Try another browser, or turn on hardware acceleration.");
  const { doc, local } = await loadDoc();
  if (!doc.repos?.length) throw new Error("The map is empty. Run `py engine/main.py scan` and reload.");
  const app = start(doc, local, quality);
  window.atlas = app; // for the console and for tests
}

function start(doc, local, quality) {
  const canvas = document.getElementById("scene");
  const world = createWorld(canvas, document.getElementById("labels"), quality);
  const { scene, camera, controls } = world;
  const shadows = quality.tier === "high";
  document.body.classList.toggle("lite", quality.tier === "low");

  // ---------- build ----------
  const plan = layout(doc);
  const shared = createShared();
  const islands = [], buildings = [], byRepo = new Map();
  for (const spot of plan.islands) {
    const isl = buildIsland(spot, shared, shadows);
    isl.shadows = shadows;
    scene.add(isl.group);
    islands.push(isl);
    const here = [];
    for (const cell of spot.cells) {
      const b = new Building(cell.repo, cell, isl, shared, shadows);
      buildings.push(b);
      here.push(b);
      byRepo.set(cell.repo.id, b);
    }
    isl.sheds = buildSheds(isl, here, shared, shadows);
    decorate(isl, shared, shadows, quality.tier === "low");
    isl.buildings = here;
    isl.label.addEventListener("click", (e) => { e.stopPropagation(); focusIsland(isl); });
  }
  world.frame(plan.extent);
  const life = createLife(world, islands, quality);
  const harbors = embedded ? createHarbors(islands) : null;
  const pickables = buildings.flatMap((b) => b.pickables);
  const pennants = buildings.filter((b) => b.pennant).map((b) => b.pennant);

  // A small marker over every building with something waiting: uncommitted, to push, to pull, pull requests.
  const markers = [];
  for (const b of buildings) {
    const p = pending(b.repo);
    if (!p.any) continue;
    const tag = document.createElement("button");
    tag.className = "pending";
    tag.title = [p.dirty && `${p.dirty} uncommitted`, p.push && "not pushed", p.pull && "needs a pull", p.prs && `${p.prs} pull requests`].filter(Boolean).join(", ");
    tag.innerHTML = [
      p.dirty ? `<span style="--c:${CHANGE.commit}">${icon("edit")}${p.dirty}</span>` : "",
      p.push ? `<span style="--c:${CHANGE.push}">${icon("up")}</span>` : "",
      p.pull ? `<span style="--c:${CHANGE.pull}">${icon("down")}</span>` : "",
      p.prs ? `<span style="--c:${CHANGE.prs}">${icon("pr")}${p.prs}</span>` : "",
    ].join("");
    tag.addEventListener("click", (e) => { e.stopPropagation(); select(b.repo, { fly: true }); });
    const obj = new CSS2DObject(tag);
    obj.position.set(0, Math.max(b.height, b.flagTop || 0) + 2.6, 0);
    obj.visible = false;
    b.group.add(obj);
    b.marker = obj;
    markers.push(obj);
  }

  // Markers are HTML: cheap at rest, costly in motion (a layout and repaint per frame each). They hide while the
  // camera moves and come back when it rests, so moving costs what it did before there were markers.
  let markersShown = true;
  function syncMarkers() {
    for (const m of markers) m.visible = markersShown && state.lens === "changes" && m.parent !== state.selected?.group;
    let appLabels = 0;
    for (const [repo, mk] of runMarks) {
      const match = !state.filter || state.filter.has(repo);
      const close = camera.position.distanceTo(controls.target) < plan.extent;
      mk.visible = markersShown && mk.userData.live && match && (!embedded || innerWidth >= 600 || close || appLabels++ < 2);
    }
    for (const mk of workMarks.values()) mk.visible = markersShown && mk.userData.live;
  }

  // A green tag over every repo whose app is running on this machine, in every lens; kept fresh from /api/apps.
  const runMarks = new Map();
  const workMarks = new Map();
  let workSignature = "";
  function showWork(jobs) {
    const active = new Map((Array.isArray(jobs) ? jobs : []).filter(j => ["running", "stopping"].includes(j.state)).map(j => [j.repo, j]));
    const signature = JSON.stringify([...active].map(([repo, j]) => [repo, j.id, j.provider, j.state]));
    if (signature === workSignature) return;
    workSignature = signature;
    harbors?.setWork([...active.values()]);
    for (const b of buildings) {
      const job = active.get(b.repo.id);
      let marker = workMarks.get(b.repo.id);
      if (job && !marker) {
        const tag = document.createElement("button");
        tag.className = "work-mark";
        marker = new CSS2DObject(tag);
        marker.position.set(0, Math.max(b.height, b.flagTop || 0) + 8, 0);
        b.group.add(marker);
        workMarks.set(b.repo.id, marker);
        tag.addEventListener("click", (e) => { e.stopPropagation(); select(b.repo, { fly: true }); tellHost("job", { id: marker.userData.job }); });
      }
      if (marker) {
        marker.userData.live = !!job;
        if (job) {
          marker.userData.job = job.id;
          const label = `${job.provider === "claude" ? "Claude" : "Codex"} · ${job.state === "stopping" ? "stopping" : "working"}`;
          if (marker.element.textContent !== label) marker.element.textContent = label;
        }
      }
    }
    if (state.lens === "working") setLens("working");
    syncMarkers(); wake();
  }
  let appTimer;
  async function refreshApps() {
    clearTimeout(appTimer);
    try {
      const s = await (await fetch(api("/api/apps"), { cache: "no-store" })).json();
      app.apps = s;
      let touched = false;
      for (const b of buildings) {
        const live = s.apps.find((a) => a.repo === b.repo.id)?.running || [];
        let mk = runMarks.get(b.repo.id);
        if (live.length && !mk) {
          const tag = document.createElement("button");
          tag.className = "run-mark";
          tag.addEventListener("click", (e) => { e.stopPropagation(); select(b.repo, { fly: true }); });
          mk = new CSS2DObject(tag);
          mk.position.set(0, Math.max(b.height, b.flagTop || 0) + (b.marker ? 4.8 : 2.6), 0);
          b.group.add(mk);
          runMarks.set(b.repo.id, mk);
        }
        if (mk) {
          const ports = live.map((x) => `:${x.port}`).join(" ");
          if (mk.userData.ports !== ports) {  // touch the page only when something changed
            const logo = (b.repo.sites || []).find((s) => s.logo)?.logo;
            mk.element.innerHTML = (logo ? `<img class="logo" alt="" src="${api(`/api/logo?repo=${encodeURIComponent(b.repo.id)}&v=${logo.hash}`)}">` : icon("play"))
              + `<span>${ports}</span>`;
            mk.element.title = `${b.repo.name} is running`;
            mk.userData.ports = ports;
            mk.userData.live = live.length > 0;
            touched = true;
          }
        }
      }
      if (touched) { syncMarkers(); wake(); }
      ui.apps(s);
    } catch { /* the server is restarting: try again shortly */ }
    if (document.hidden || hostHidden) return;
    const busy = app.apps?.apps?.some((a) => Object.values(a.jobs || {}).some((j) => j.state === "starting"));
    appTimer = setTimeout(refreshApps, busy ? 2000 : 8000);
  }
  /** Start, stop or open a repo's app; the server picks the command and the process. */
  async function appAction(action, repo, extra = {}) {
    try {
      const res = await post("/api/apps", { action, repo: repo.id, ...extra });
      ui.toast({ start: `Starting ${repo.name}`, stop: `Stopped ${repo.name}`, open: `Opening ${repo.name}` }[action] || "Done");
      setTimeout(refreshApps, 700);
      return res;
    } catch (e) { ui.toast(e.message, true); }
  }
  const islandMeshes = islands.flatMap((i) => [i.rock, i.plots]);

  const ringGeo = new THREE.RingGeometry(3.6, 4.3, 48).rotateX(-Math.PI / 2);
  const selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: "#ff8a3d", transparent: true, opacity: 0.95, depthWrite: false }));
  const hoverRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.55, depthWrite: false }));
  selRing.visible = hoverRing.visible = false;
  const selTagEl = document.createElement("div");
  selTagEl.className = "selected-tag";
  const selTag = new CSS2DObject(selTagEl);
  selTag.visible = false;
  selRing.renderOrder = hoverRing.renderOrder = 2;

  // ---------- state ----------
  const state = {
    lens: "map", night: 0, nightTarget: 0, time: null, hover: null, selected: null, fly: null, filter: null,
    dirty: true, lastInput: performance.now(), autoRotate: quality.tier !== "low" && !reducedMotion,
    moving: new Set(), renderMs: [], downgraded: false, started: performance.now(),
  };

  const app = {
    doc, local, world, islands, buildings, quality,
    setLens, select, deselect, setTime, toggleNight, open, changes, sync, appAction, apps: null, rescan, copy, saveNotes, setAttention, sound,
    focusIsland: (id) => { const isl = islands.find((i) => i.spot.id === id); if (isl) focusIsland(isl); },
    step: (d) => {
      const b = state.selected;
      if (!b) return;
      const list = b.island.buildings, next = list[(list.indexOf(b) + d + list.length) % list.length];
      select(next.repo, { fly: true });
    },
  };
  const ui = createUI(app);

  // ---------- camera ----------
  // Far enough that every island fits, seen from a little above so near and far districts overlap less.
  const home = () => {
    const view = homeView(plan.extent, embedded, innerWidth, innerHeight);
    return { ...view, target: new THREE.Vector3(view.target.x, view.target.y, view.target.z) };
  };
  const sphericalOf = (pos, target) => new THREE.Spherical().setFromVector3(pos.clone().sub(target));
  function place(view) {
    controls.target.copy(view.target);
    camera.position.copy(view.target).add(new THREE.Vector3().setFromSpherical(new THREE.Spherical(view.radius, view.phi, view.theta)));
    camera.lookAt(view.target);
    controls.update();
  }
  function flyTo(target, radius, phi, ms = 1100, targetTheta) {
    if (![target.x, target.y, target.z, radius].every(Number.isFinite) || radius <= 0) return;
    if (ms >= 900 && state.ready) sound.fly();
    const from = sphericalOf(camera.position, controls.target);
    if (!(from.radius > 0)) from.radius = radius;
    const theta = Number.isFinite(targetTheta) ? targetTheta : from.theta;
    state.fly = {
      t0: performance.now(), ms: reducedMotion ? 1 : ms,
      fromTarget: controls.target.clone(), toTarget: target.clone(),
      from: { r: from.radius, phi: from.phi, theta: from.theta },
      to: { r: radius, phi: phi ?? clamp(from.phi, 0.7, 1.1), theta },
    };
    state.autoRotate = false;
    controls.enabled = false;
    setHover(null);
    ui.tip(null);
    wake();
  }
  function stepFly(now) {
    const f = state.fly;
    const k = easeInOut(clamp((now - f.t0) / f.ms, 0, 1));
    const target = f.fromTarget.clone().lerp(f.toTarget, k);
    const r = Math.exp(lerp(Math.log(f.from.r), Math.log(f.to.r), k));
    const lift = Math.sin(k * Math.PI) * 0.12;
    const s = new THREE.Spherical(r, clamp(lerp(f.from.phi, f.to.phi, k) - lift, 0.15, 1.35), lerp(f.from.theta, f.to.theta, k));
    controls.target.copy(target);
    camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(s));
    camera.lookAt(target);
    if (k >= 1) {
      state.fly = null;
      controls.enabled = true;
      controls.update();
    }
  }
  /** Aim a little to the right of the subject when the card is open, so the subject lands in the visible part. */
  function besideCard(target, radius, phi) {
    const card = document.getElementById("card");
    if (card.hidden || !innerWidth || !innerHeight) return target; // a window with no size has no "beside"
    const theta = sphericalOf(camera.position, controls.target).theta;
    if (innerWidth < 860) {
      // A bottom sheet: aim nearer the camera on the ground so the subject rises into the open sky above it.
      const toward = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
      const unitsPerPx = (2 * radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
      return target.clone().addScaledVector(toward, (card.offsetHeight / 2) * unitsPerPx / Math.cos(phi));
    }
    const dir = new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta));
    const right = new THREE.Vector3().crossVectors(dir.negate(), camera.up).normalize();
    const unitsPerPx = (2 * radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / innerHeight;
    return target.clone().addScaledVector(right, (card.offsetWidth / 2 + 7) * unitsPerPx);
  }
  const focusBuilding = (b) => {
    const top = b.group.localToWorld(new THREE.Vector3(0, b.height * 0.45, 0));
    const radius = clamp(b.height * 2.4 + 42, 52, 150);
    flyTo(besideCard(top, radius, 0.98), radius, 0.98);
  };
  function focusIsland(isl, notify = true) {
    deselect(false);
    ui.showDistrict(isl.spot);
    if (notify) tellHost("district", { family: isl.spot.id });
    const radius = isl.spot.radius * 2.7 + 46;
    flyTo(besideCard(isl.group.position.clone(), radius, 0.9), radius, 0.9);
  }

  // ---------- lenses, time, night ----------
  function setLens(id) {
    const lens = lensById(id);
    if (state.ready && lens.id !== state.lens) sound.click();
    state.lens = lens.id;
    for (const b of buildings) {
      const target = lens.target(b.repo, b);
      if (lens.id === "working") {
        target.dim = workMarks.get(b.repo.id)?.userData.live ? 0 : 0.85;
        target.glow = workMarks.get(b.repo.id)?.userData.live ? 1 : 0;
      }
      if (state.filter && !state.filter.has(b.repo.id)) target.dim = Math.max(target.dim, 0.9);
      b.setTarget(target);
      state.moving.add(b);
    }
    ui.showLens(lens.id);
    syncMarkers();
    if (lens.id === "where" || lens.id === "map") for (const i of islands) i.sheds && (i.sheds.visible = true);
    wake();
  }
  function setTime(t, user) {
    state.time = t;
    for (const b of buildings) {
      const born = Date.parse(b.repo.createdAt || b.repo.lastActivity || "");
      b.setTarget({ born: t == null ? 1 : Number.isFinite(born) && born <= t ? 1 : 0 });
      state.moving.add(b);
    }
    for (const i of islands) if (i.sheds) i.sheds.visible = t == null;
    if (user) state.autoRotate = false;
    wake();
  }
  function toggleNight(force) {
    state.nightTarget = force ?? (state.nightTarget > 0.5 ? 0 : 1);
    sound.night(state.nightTarget > 0.5);
    ui.showNight(state.nightTarget > 0.5);
    try { localStorage.setItem("atlas.night", String(state.nightTarget)); } catch {}
    wake();
  }

  // ---------- selection ----------
  function select(repo, { fly = false } = {}) {
    const b = byRepo.get(repo.id);
    if (!b) return;
    state.selected = b;
    b.island.group.add(selRing);
    selRing.position.set(b.cell.x, 0.68, b.cell.z);
    selRing.visible = true;
    selTagEl.textContent = repo.name;
    b.group.add(selTag);
    selTag.position.set(0, Math.max(b.height, b.flagTop || 0) + 2.4, 0);
    selTag.visible = true;
    syncMarkers();
    sound.pick();
    if (!reducedMotion) { b.state.hover = 2.4; b.setTarget({ hover: state.hover === b ? 1 : 0 }); state.moving.add(b); }
    ui.showRepo(repo);
    tellHost("select", { repo: repo.id });
    ui.toggleList(false);
    history.replaceState(null, "", `#repo=${encodeURIComponent(repo.id)}`);
    if (fly) focusBuilding(b);
    wake();
  }
  function deselect(clearHash = true) {
    state.selected = null;
    selRing.visible = false;
    selTag.visible = false;
    selTag.removeFromParent();
    syncMarkers();
    ui.hideCard();
    tellHost("select", { repo: null });
    if (clearHash) history.replaceState(null, "", location.pathname + location.search);
    wake();
  }

  // ---------- picking ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let pointer = null, down = null;
  const pick = (x, y) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false).find((h) => h.object.userData.building?.group.visible);
    if (hit) return { building: hit.object.userData.building };
    const land = ray.intersectObjects(islandMeshes, false)[0];
    return land ? { island: islands.find((i) => i.spot === land.object.userData.island) } : {};
  };
  function setHover(b) {
    if (state.hover === b) return;
    if (state.hover) { state.hover.setTarget({ hover: 0 }); state.moving.add(state.hover); }
    state.hover = b;
    if (b) {
      b.setTarget({ hover: 1 });
      state.moving.add(b);
      b.island.group.add(hoverRing);
      hoverRing.position.set(b.cell.x, 0.66, b.cell.z);
    }
    hoverRing.visible = !!b && b !== state.selected;
    document.body.classList.toggle("hovering", !!b);
    wake();
  }
  canvas.addEventListener("pointermove", (e) => { pointer = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener("pointerleave", () => { pointer = null; setHover(null); ui.tip(null); });
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    document.body.classList.add("dragging");
    interacted();
  });
  window.addEventListener("pointerup", () => document.body.classList.remove("dragging"));
  canvas.addEventListener("click", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const p = pick(e.clientX, e.clientY);
    if (p.building) select(p.building.repo, { fly: true });
    else if (p.island) focusIsland(p.island);
    else deselect();
  });
  canvas.addEventListener("dblclick", (e) => {
    const p = pick(e.clientX, e.clientY);
    if (p.building) return;
    const hit = ray.intersectObjects(islandMeshes, false)[0];
    if (hit) flyTo(hit.point, Math.max(controls.minDistance * 1.6, camera.position.distanceTo(controls.target) * 0.5));
  });
  // A right click opens actions; a right drag still rotates the world.
  canvas.addEventListener("contextmenu", (e) => {
    if (!embedded) return;
    e.preventDefault();
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
    const target = pick(e.clientX, e.clientY);
    if (target.building) tellHost("context", { repo: target.building.repo.id, x: e.clientX, y: e.clientY });
    else if (target.island) tellHost("island-context", { family: target.island.spot.id });
  });
  document.getElementById("labels").addEventListener("contextmenu", e => {
    if (!embedded) return;
    const label = e.target.closest(".district-label");
    const island = islands.find(i => i.label === label);
    if (island) { e.preventDefault(); tellHost("island-context", { family: island.spot.id }); }
  });
  controls.addEventListener("start", () => { interacted(); ui.tip(null); });
  controls.addEventListener("change", () => (state.dirty = true));

  function interacted() {
    state.lastInput = performance.now();
    if (state.autoRotate) state.autoRotate = false;
    if (!document.getElementById("hint").hidden && performance.now() - state.started > 1500) ui.hideHint();
    wake();
  }

  // ---------- keys and the pad ----------
  controls.listenToKeyEvents(window);
  const turn = (a) => {
    const s = sphericalOf(camera.position, controls.target);
    flyTo(controls.target.clone(), s.radius, s.phi, 420, s.theta + a);
  };
  const zoom = (f) => {
    const s = sphericalOf(camera.position, controls.target);
    flyTo(controls.target.clone(), clamp(s.radius * f, controls.minDistance, controls.maxDistance), s.phi, 380);
  };
  const goHome = (notify = true) => { deselect(); if (notify) tellHost("district", { family: null }); const h = home(); flyTo(h.target, h.radius, h.phi); };
  const PAD = { in: () => zoom(0.7), out: () => zoom(1.4), left: () => turn(Math.PI / 4), right: () => turn(-Math.PI / 4), home: goHome };
  for (const b of document.querySelectorAll(".pad button")) b.addEventListener("click", () => { interacted(); PAD[b.dataset.pad](); });
  document.querySelector(".brand").addEventListener("click", (e) => { e.preventDefault(); goHome(); });
  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === "/") { e.preventDefault(); if (embedded) tellHost("search"); else document.getElementById("q").focus(); }
    else if (k === "Escape") { if (!document.getElementById("list").hidden) ui.toggleList(false); else deselect(); ui.hideHint(); }
    else if (k >= "1" && k <= "5") setLens(["map", "changes", "where", "activity", "shipped"][+k - 1]);
    else if (k === "n" || k === "N") toggleNight();
    else if (k === "m" || k === "M") document.getElementById("btn-sound").click();
    else if ((k === "[" || k === "]") && state.selected) app.step(k === "]" ? 1 : -1);
    else if (k === "l" || k === "L") ui.toggleList();
    else if (k === "h" || k === "H") goHome();
    else if (k === "q" || k === "Q") turn(Math.PI / 6);
    else if (k === "e" || k === "E") turn(-Math.PI / 6);
    else if (k === "+" || k === "=") zoom(0.75);
    else if (k === "-" || k === "_") zoom(1.33);
    else if (k === "f" || k === "F") state.selected && focusBuilding(state.selected);
    else if (k === "?") document.getElementById("btn-help").click();
    else return;
    interacted();
  });

  // ---------- local actions ----------
  async function post(path, body) {
    const r = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1", "X-Hangar": "1" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  async function open(repo, site, how, intent) {
    const a = (doc.apps || []).find((x) => x.id === how);
    try {
      await post("/api/open", { repo: repo.id, site, with: how, intent });
      ui.toast(a?.kind === "agent" ? `Starting ${a.name} in ${repo.name}` : how === "folder" ? "Opening the folder" : `Opening in ${a?.name || how}`);
    } catch (e) { ui.toast(e.message, true); }
  }
  /** Pull or push repos (the server decides which folders), then let the map offer itself fresh when the rescan ends. */
  async function sync(action, repos) {
    const { results } = await post("/api/git", { action, repos });
    ui.scanning(true, "Updating the map...");
    const watch = async () => {
      const s = await (await fetch(api("/api/status"), { cache: "no-store" })).json().catch(() => ({}));
      if (s.scanning) return setTimeout(watch, 1500);
      ui.scanning(false);
      if (s.generatedAt && s.generatedAt !== doc.generatedAt) ui.news();
    };
    setTimeout(watch, 1500);
    return results;
  }
  /** The exact files, commits and pull requests waiting on a repo, read live by the local server. */
  async function changes(repo) {
    const r = await fetch(api(`/api/changes?repo=${encodeURIComponent(repo.id)}`), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function rescan() {
    try {
      await post("/api/rescan", { github: true });
      ui.scanning(true, "Scanning GitHub and this machine...");
      ui.toast("Scanning GitHub and this machine");
      const was = doc.generatedAt;
      const poll = async () => {
        const s = await (await fetch(api("/api/status"), { cache: "no-store" })).json();
        if (s.scanning) return setTimeout(poll, 1500);
        ui.scanning(false);
        if (s.error) return ui.toast(s.error, true);
        if (s.generatedAt !== was) location.reload();
      };
      setTimeout(poll, 1500);
    } catch (e) { ui.toast(e.message, true); }
  }
  /** Focus, Park, Hide or none: saved in the spine, then the map is redrawn around it. */
  async function setAttention(repo, state) {
    try {
      await post("/api/notes", { repo: repo.id, fields: { focus: state === "focus", parked: state === "parked", hidden: state === "hidden" } });
      ui.toast({ focus: "Moved to Focus", parked: "Parked", hidden: "Hidden from the map" }[state] || "Back in its district");
      const keep = state === "hidden" ? "" : `#repo=${encodeURIComponent(repo.id)}`;
      setTimeout(() => { location.replace(location.pathname + location.search + keep); location.reload(); }, 450);
    } catch (e) { ui.toast(e.message, true); }
  }
  async function saveNotes(repo, fields) {
    const before = repo.family;
    const res = await post("/api/notes", { repo: repo.id, fields });
    Object.assign(repo, res.repo);
    ui.toast("Saved");
    if (res.repo.family !== before) return location.reload();
    ui.showRepo(repo);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); ui.toast("Copied"); } catch { ui.toast("Copy failed", true); }
  }

  // ---------- loop ----------
  function wake() { state.dirty = true; }
  const ambient = () => quality.tier !== "low" && !reducedMotion && !document.hidden && !hostHidden && performance.now() - state.lastInput < 45000;
  let last = performance.now(), labelTick = 0, lastDraw = 0, sharpAt = 0, soft = false, lastMove = 0;
  const lastCam = new THREE.Vector3(), lastTarget = new THREE.Vector3();
  const fullRatio = world.renderer.getPixelRatio();
  function loop(now) {
    requestAnimationFrame(loop);
    if (hostHidden || document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let changed = state.dirty, ambientOnly = !state.dirty, moved = false, labelsNow = false;
    if (state.fly) { stepFly(now); changed = true; ambientOnly = false; moved = true; }
    if (!Number.isFinite(camera.position.x + camera.position.y + camera.position.z + controls.target.x + controls.target.y + controls.target.z)) {
      // Never leave the camera lost in NaN (it can only draw black from there): go back to the whole map.
      state.fly = null;
      controls.enabled = true;
      place(home());
      changed = true;
      moved = true;
    }
    if (state.autoRotate && !state.fly && performance.now() - state.started < 90000) {
      const s = sphericalOf(camera.position, controls.target);
      s.theta += dt * 0.035;
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(s));
      camera.lookAt(controls.target);
      changed = true;
      labelsNow = true;  // slow enough to keep the markers, at the ambient 30 frames a second
    }
    if (controls.enabled && controls.update(dt)) {
      changed = true;
      ambientOnly = false;
      // The tail of a drag's glide is too slow to notice: the markers come back during it, not after it.
      const step = camera.position.distanceTo(lastCam) + controls.target.distanceTo(lastTarget);
      if (step > 0.0015 * camera.position.distanceTo(controls.target)) moved = true;
    }
    lastCam.copy(camera.position);
    lastTarget.copy(controls.target);
    if (moved) lastMove = now;
    const resting = now - lastMove > 160;
    if (resting !== markersShown) { markersShown = resting; syncMarkers(); changed = true; ambientOnly = false; }
    if (Math.abs(state.nightTarget - state.night) > 0.001) {
      state.night = lerp(state.night, state.nightTarget, 1 - Math.exp(-dt * 3.2));
      if (Math.abs(state.nightTarget - state.night) < 0.003) state.night = state.nightTarget;
      world.setNight(state.night);
      for (const b of buildings) b.setNight(state.night);
      life.setNight(state.night);
      changed = true;
      ambientOnly = false;
    }
    if (state.moving.size) {
      for (const b of state.moving) if (!b.step(dt)) state.moving.delete(b);
      changed = true;
      ambientOnly = false;
    }
    if (ambient()) {
      const t = now / 1000;
      world.drift(t);
      life.update(t);
      for (const i of islands) i.group.position.y = i.spot.y + Math.sin(t * 0.35 + i.bob) * 0.5;
      const pulse = 0.75 + Math.sin(t * 2.4) * 0.25;
      shared.beacon.color.setRGB(1, 0.91 * pulse + 0.09, 0.66 * pulse + 0.1);
      shared.red.color.setRGB(Math.sin(t * 3) > 0 ? 1 : 0.35, 0.22, 0.2);
      if (selRing.visible) selRing.material.opacity = 0.65 + Math.sin(t * 4) * 0.3;
      changed = true;
    }
    if (pointer && !state.fly) {
      const p = pick(pointer.x, pointer.y);
      setHover(p.building || null);
      ui.tip(p.building?.repo, pointer.x, pointer.y);
      pointer = null;
    }
    // On the light tier, draw at reduced resolution while things move and once more at full size when they stop.
    if (quality.tier === "low") {
      if (changed && !soft) { world.renderer.setPixelRatio(fullRatio * 0.6); world.resize(); soft = true; }
      if (changed) sharpAt = now + 180;
      else if (soft && now >= sharpAt) { world.renderer.setPixelRatio(fullRatio); world.resize(); soft = false; changed = true; }
    }
    if (!changed) return;
    // Pennants turn to face the camera, so a flag is never seen edge-on.
    if (pennants.length) {
      const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
      const flutter = ambient() ? now / 1000 : 0;
      pennants.forEach((p, i) => (p.rotation.y = az + (flutter ? Math.sin(flutter * 2.2 + i) * 0.18 : 0)));
    }
    // Slow ambient motion (clouds, bobbing, beacons) needs no more than 30 frames a second.
    if (ambientOnly && now - lastDraw < 33) return;
    lastDraw = now;
    if (++labelTick % 6 === 0 || state.fly) cullLabels();
    const t0 = performance.now();
    world.render(labelsNow || !ambientOnly);  // the ambient drift alone never needs the labels laid out again
    watch(performance.now() - t0);
    state.dirty = false;
  }

  // Far out, only the bigger districts keep their names; zoom in and the rest appear.
  const bySize = [...islands].sort((a, b) => b.spot.cells.length - a.spot.cells.length);
  const rank = new Map(bySize.map((isl, i) => [isl, i]));
  function cullLabels() {
    const d = camera.position.distanceTo(controls.target);
    const keep = d > plan.extent * 1.5 ? (embedded && innerWidth < 600 ? 3 : 9) : d > plan.extent * 1.05 ? 14 : islands.length;
    for (const i of islands) {
      const far = camera.position.distanceTo(i.group.position) > d * 1.9 + 160 || rank.get(i) >= keep;
      i.label.classList.toggle("far", far);
      i.label.inert = far;
    }
    syncMarkers();
  }

  /** If drawing is slow on the high tier, drop shadows and bloom once, and say so. */
  function watch(ms) {
    if (state.downgraded || quality.tier !== "high") return;
    state.renderMs.push(ms);
    if (state.renderMs.length < 60) return;
    const avg = state.renderMs.reduce((a, b) => a + b, 0) / state.renderMs.length;
    state.renderMs = [];
    if (avg < 26) return;
    state.downgraded = true;
    world.lite();
    ui.toast("Switched to lighter graphics to keep things smooth");
  }

  // ---------- go ----------
  window.addEventListener("resize", () => { world.resize(); if (embedded && !state.selected) { state.fly = null; controls.enabled = true; place(home()); } wake(); });
  document.addEventListener("visibilitychange", wake);
  world.resize();
  let night = params.get("night");
  if (night == null) try { night = localStorage.getItem("atlas.night"); } catch {}
  const hour = new Date().getHours();
  const startNight = night != null ? +night > 0.5 : hour < 6 || hour >= 19;
  state.night = state.nightTarget = startNight ? 1 : 0;
  world.setNight(state.night);
  for (const b of buildings) b.setNight(state.night);
  life.setNight(state.night);
  life.update(0);
  ui.showNight(startNight);
  place(home());
  setLens(params.get("lens") || (local ? "changes" : "map"));
  for (const b of buildings) {
    Object.assign(b.state, { dim: b.target.dim, glow: b.target.glow, born: b.target.born });
    b.state.tint.copy(b.target.tint);
    if (b.state.ghost !== b.target.ghost) b.setGhost((b.state.ghost = b.target.ghost));
    b.apply();
  }
  state.moving.clear();

  function freshVisit() {
    try {
      const last = +localStorage.getItem("atlas.lastOpen") || 0;
      localStorage.setItem("atlas.lastOpen", String(Date.now()));
      return Date.now() - last > 30 * 60000;
    } catch { return true; }
  }
  const deep = decodeURIComponent((location.hash.match(/repo=([^&]+)/) || [])[1] || "");
  if (deep && byRepo.has(deep)) setTimeout(() => select(byRepo.get(deep).repo, { fly: true }), 400);
  else if (quality.tier !== "low" && !reducedMotion && innerWidth > 0 && innerHeight > 0 && freshVisit()) {
    // The opening: the camera sweeps in from high above while the city rises, island by island from the middle out.
    // Only on a fresh visit: reloading after a rescan should not make anyone wait for it again.
    const t0 = performance.now();
    for (const b of buildings) {
      const d = Math.hypot(b.island.spot.x + b.cell.x, b.island.spot.z + b.cell.z);
      b.state.born = 0;
      b.apply();
      b.delayUntil = t0 + 350 + d * 4 + (b.cell.x * 7 + b.cell.z * 3) % 90;
      b.setTarget({ born: 1 });
      state.moving.add(b);
    }
    const h = home();
    place({ ...h, radius: h.radius * 1.85, phi: 0.36, theta: h.theta - 0.6 });
    flyTo(h.target, h.radius, h.phi, 2800, h.theta);
    state.autoRotate = true;
  }

  const notes = (doc.warnings || []).map((w) => w.replace(/[<>&]/g, ""));
  if (quality.software) notes.push("Your browser is drawing 3D on the processor, so Hangar is using light graphics. Turn on <b>hardware acceleration</b> in the browser's settings for the full view.");
  if (notes.length) ui.notice(`${icon(quality.software && notes.length === 1 ? "cpu" : "alert")}<span>${notes.join("<br>")}</span>`);
  let seen = false;
  try { seen = localStorage.getItem("atlas.hint") === "1"; localStorage.setItem("atlas.hint", "1"); } catch {}
  if (!seen) ui.showHint();

  if (local) refreshApps();
  document.addEventListener("visibilitychange", () => { if (local && !document.hidden) refreshApps(); });

  // While Hangar runs locally it rescans in the background; offer the new map instead of reloading under the person.
  if (local) {
    const check = async () => {
      try {
        if (hostHidden || document.hidden) { setTimeout(check, 60000); return; }
        const s = await (await fetch(api("/api/status"), { cache: "no-store" })).json();
        if (!s.scanning && s.generatedAt && s.generatedAt !== doc.generatedAt) ui.news();
        else setTimeout(check, 60000);
      } catch { setTimeout(check, 120000); }
    };
    setTimeout(check, 60000);
  }
  state.ready = true;
  listenHost((message) => {
    if (message.type === "select") {
      const repo = byRepo.get(message.repo)?.repo;
      if (repo) select(repo, { fly: true });
      else if (message.repo === null) goHome(false);
    }
    if (message.type === "lens" && ["map", "changes", "where", "activity", "shipped", "working"].includes(message.lens)) setLens(message.lens);
    if (message.type === "district") {
      const island = islands.find(i => i.spot.id === message.family);
      // The host already applied this choice. Echoing it can erase a newer search.
      if (island) focusIsland(island, false); else if (message.family === null) goHome(false);
    }
    if (message.type === "filter") {
      state.filter = Array.isArray(message.repos) ? new Set(message.repos.filter(id => typeof id === "string")) : null;
      setLens(state.lens);
    }
    if (message.type === "theme") toggleNight(message.night ? 1 : 0);
    if (message.type === "map-controls") document.body.classList.toggle("show-map-controls", !!message.visible);
    if (message.type === "work") showWork(message.jobs);
    if (message.type === "visibility") {
      hostHidden = !message.visible;
      if (hostHidden) { clearTimeout(appTimer); state.autoRotate = false; }
      else { world.resize(); wake(); if (local) refreshApps(); }
    }
  });
  tellHost("ready");
  requestAnimationFrame(loop);
  world.render();
  setTimeout(() => { loading.classList.add("gone"); document.body.classList.remove("booting"); }, 60);
  setTimeout(() => loading.remove(), 800);
  return app;
}

// Installable: the service worker, and an Install button whenever the browser offers to install Hangar.
if (!embedded && "serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Hangar: offline shell unavailable", e));
}
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const b = document.getElementById("btn-install");
  b.innerHTML = `${icon("download")}<span>Install app</span>`;
  b.hidden = false;
  b.onclick = async () => {
    b.hidden = true;
    await installPrompt.prompt();
    installPrompt = null;
  };
});
window.addEventListener("appinstalled", () => (document.getElementById("btn-install").hidden = true));

boot().catch((e) => {
  tellHost("error", { message: String(e.message || e) });
  loading.classList.add("error");
  loading.innerHTML = `<p>${String(e.message || e).replace(/[<>&]/g, "")}</p>`;
  console.error(e);
});
