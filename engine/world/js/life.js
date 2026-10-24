// Small signs of life: waterfalls spilling off the edges of the biggest green islands, and a flock of birds circling
// the busiest district. They move only while ambient motion is on, so an idle map still draws nothing.
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

  // Birds: small V shapes circling above the island with the most activity.
  const home = islands[0];
  if (home && quality.tier !== "low") {
    const wing = new THREE.BufferGeometry();
    wing.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, -1.4, 0.35, -0.5, -1.4, 0, 0.5, 0, 0, 0, 1.4, 0.35, -0.5, 1.4, 0, 0.5], 3));
    wing.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: "#2c3340", side: THREE.DoubleSide });
    const rand = rng(77);
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Mesh(wing, mat);
      b.userData = { r: home.spot.radius * (0.8 + rand() * 0.7), y: 42 + rand() * 20, speed: 0.12 + rand() * 0.08, phase: rand() * 6.28, flap: 6 + rand() * 3 };
      b.scale.setScalar(0.9 + rand() * 0.4);
      world.scene.add(b);
      birds.push(b);
    }
    birds.centre = home.group.position;
  }

  return {
    update(t) {
      for (const f of falls) {
        f.tex.offset.y = -t * 0.9;
        f.puff.material.opacity = 0.42 + Math.sin(t * 1.4 + f.phase) * 0.12;
      }
      for (const b of birds) {
        const u = b.userData, a = t * u.speed + u.phase, c = birds.centre;
        b.position.set(c.x + Math.cos(a) * u.r, c.y + u.y + Math.sin(t * 0.7 + u.phase) * 2, c.z + Math.sin(a) * u.r);
        b.rotation.set(0, -a, Math.sin(t * u.flap + u.phase) * 0.45);
      }
    },
    setNight(n) {
      for (const f of falls) f.puff.material.color.setScalar(1 - n * 0.65);
      for (const b of birds) b.visible = n < 0.6;
    },
  };
}
