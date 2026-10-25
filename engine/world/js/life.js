// Small signs of life: waterfalls spilling off the edges of the biggest green islands, and a flock of birds circling
// the biggest green islands. They move only while ambient motion is on, so an idle map still draws nothing.
import * as THREE from "three";
import { rng } from "./util.js";

const DRY = new Set(["vendor", "offmap", "attic", "parked"]);

function streakTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(170,215,240,0.55)";
  g.fillRect(0, 0, 64, 256);
  const rand = rng(11);
  for (let i = 0; i < 70; i++) {
    const x = rand() * 64, w = 1 + rand() * 3, y = rand() * 256, h = 30 + rand() * 90;
    g.fillStyle = `rgba(255,255,255,${0.35 + rand() * 0.5})`;
    g.fillRect(x, y, w, h);
    g.fillRect(x, y - 256, w, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function mistTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createLife(world, islands, quality) {
  const falls = [], birds = [];
  const streaks = streakTexture(), mist = mistTexture();
  const green = islands.filter((i) => !DRY.has(i.spot.id)).sort((a, b) => b.spot.radius - a.spot.radius).slice(0, quality.tier === "low" ? 1 : 3);
  for (const isl of green) {
    const spot = isl.spot, rand = rng(spot.seed ^ 0x5bd1e995);
    const a = rand() * Math.PI * 2, r = spot.radius * 0.995, depth = Math.min(70, spot.radius * 1.4);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = -a + Math.PI / 2;
    const tex = streaks.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, depth / 30);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(4.2, depth, 1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.85 }));
    water.position.set(0, -depth / 2, 0.4);
    group.add(water);
    const spring = new THREE.Mesh(new THREE.CircleGeometry(2.6, 18).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: "#7cc3e8", roughness: 0.25, metalness: 0.1 }));
    spring.position.set(0, 0.06, -2.2);
    group.add(spring);
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: mist, transparent: true, opacity: 0.55, depthWrite: false }));
    puff.scale.set(16, 9, 1);
    puff.position.set(0, -depth + 2, 1.2);
    group.add(puff);
    isl.group.add(group);
    falls.push({ tex, puff, phase: rand() * 6 });
  }

  // Birds: a loose flock that roams over the biggest green islands. Each bird has two hinged wings that beat and then
  // glide, banks into the turns, and fades out near the camera so it never fills the view as a flat black wedge.
  const flock = green.length ? green : islands.slice(0, 1);
  if (flock.length && quality.tier !== "low") {
    const wingL = new THREE.BufferGeometry();
    wingL.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.32, 0, 0, -0.28, -1.5, 0.06, -0.55], 3));
    const wingR = new THREE.BufferGeometry();
    wingR.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.32, 1.5, 0.06, -0.55, 0, 0, -0.28], 3));
    const body = new THREE.ConeGeometry(0.16, 1.1, 5).rotateX(Math.PI / 2);
    const rand = rng(77);
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: "#3a4150", side: THREE.DoubleSide, transparent: true, depthWrite: false });
      const bird = new THREE.Group(), left = new THREE.Mesh(wingL, mat), right = new THREE.Mesh(wingR, mat);
      bird.add(new THREE.Mesh(body, mat), left, right);
      // Each bird keeps its own place in the flock, drifting a little around it.
      bird.userData = { left, right, mat, slot: new THREE.Vector3((rand() - 0.5) * 14, (rand() - 0.5) * 5, -rand() * 16), lag: rand() * 0.02, phase: rand() * 6.28, beat: 7 + rand() * 3 };
      bird.scale.setScalar(0.85 + rand() * 0.35);
      world.scene.add(bird);
      birds.push(bird);
    }
    birds.flock = flock;
  }
  const route = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], true, "centripetal");
  const ahead = new THREE.Vector3(), here = new THREE.Vector3(), next = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  // A lazy loop over each visible flock island in turn; with one island it circles that island.
  const pool = [];
  function plan() {
    const shown = birds.flock.filter((isl) => isl.group.visible);
    if (!shown.length) return false;
    let n = 0;
    for (const [k, isl] of shown.entries()) {
      const c = isl.group.position, r = isl.spot.radius * 0.75, turns = shown.length === 1 ? 4 : 2;
      for (let j = 0; j < turns; j++, n++) {
        const a = (j / turns) * Math.PI * 2 + k * 1.3;
        (pool[n] ||= new THREE.Vector3()).set(c.x + Math.cos(a) * r, c.y + 46 + (j % 2) * 6, c.z + Math.sin(a) * r);
      }
    }
    if (route.points.length !== n || route.points[0] !== pool[0]) route.points = pool.slice(0, n);
    return true;
  }

  return {
    update(t) {
      for (const f of falls) {
        f.tex.offset.y = -t * 0.9;
        f.puff.material.opacity = 0.42 + Math.sin(t * 1.4 + f.phase) * 0.12;
      }
      if (!birds.length) return;
      const flying = world.night < 0.6 && plan();
      const lap = route.points.length * 26;
      for (const b of birds) {
        b.visible = flying;
        if (!flying) continue;
        const u = b.userData, at = (((t / lap - u.lag) % 1) + 1) % 1;
        route.getPoint(at, here);
        route.getPoint((at + 0.004) % 1, next);
        route.getPoint((at + 0.012) % 1, ahead);
        const heading = Math.atan2(next.x - here.x, next.z - here.z), later = Math.atan2(ahead.x - next.x, ahead.z - next.z);
        let turn = later - heading;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        // Place the bird in its slot in the flock, measured from the flight direction.
        side.set(Math.cos(heading), 0, -Math.sin(heading));
        b.position.copy(here).addScaledVector(side, u.slot.x + Math.sin(t * 0.5 + u.phase) * 1.5)
          .addScaledVector(up, u.slot.y + Math.sin(t * 0.8 + u.phase) * 1.2)
          .add(next.sub(here).normalize().multiplyScalar(u.slot.z));
        b.rotation.set(0, heading, 0);
        b.rotateZ(-THREE.MathUtils.clamp(turn * 14, -0.6, 0.6));
        // Beat for a while, then glide with the wings held slightly up.
        const beating = Math.sin(t * 0.45 + u.phase) > -0.2, flap = beating ? Math.sin(t * u.beat + u.phase) * 0.7 : 0.12;
        u.left.rotation.z = -flap;
        u.right.rotation.z = flap;
        const near = world.camera.position.distanceTo(b.position);
        u.mat.opacity = THREE.MathUtils.clamp((near - 22) / 40, 0, 0.9);
        b.visible = u.mat.opacity > 0.02;
      }
    },
    setNight(n) {
      for (const f of falls) f.puff.material.color.setScalar(1 - n * 0.65);
      for (const b of birds) b.visible = n < 0.6 && b.visible;
    },
  };
}
