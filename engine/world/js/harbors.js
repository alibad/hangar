// Small architectural portals at the island edge. Only observed work lights a beam.
import * as THREE from "three";

export function createHarbors(islands) {
  const basalt = new THREE.MeshStandardMaterial({ color: "#171b24", roughness: 0.85 });
  const cobalt = new THREE.MeshStandardMaterial({ color: "#174bff", roughness: 0.5, metalness: 0.18 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const diamond = new THREE.OctahedronGeometry(0.8);
  const beamGeometry = new THREE.CylinderGeometry(0.1, 1.1, 14, 8, 1, true);
  const docks = [];
  function add(island) {
    const group = new THREE.Group();
    group.position.set(0, 0.8, island.spot.radius * 0.87);
    const floor = new THREE.Mesh(box, basalt);
    floor.scale.set(7, 0.7, 4); group.add(floor);
    for (const side of [-1, 1]) {
      const door = new THREE.Mesh(box, cobalt);
      door.scale.set(0.8, 5, 2.6); door.position.set(side * 2, 2.7, 0);
      door.rotation.y = side * -0.35; group.add(door);
    }
    const glow = new THREE.MeshBasicMaterial({ color: "#ffb85c" });
    const core = new THREE.Mesh(diamond, glow); core.position.y = 2.8; group.add(core);
    const beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({ color: "#ffca81", transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.y = 10; beam.visible = false; group.add(beam);
    island.group.add(group);
    docks.push({ island, group, core, beam });
  }
  islands.forEach(add);
  return {
    add,
    setWork(jobs) {
      const active = new Set(jobs.filter(j => ["running", "stopping"].includes(j.state)).map(j => j.repo));
      for (const dock of docks) {
        const visible = dock.island.buildings.filter(b => b.onMap !== false);
        const count = visible.filter(b => active.has(b.repo.id)).length;
        dock.group.position.z = dock.island.spot.radius * 0.87;
        dock.beam.visible = count > 0;
        dock.core.scale.setScalar(count ? 1.3 : 1);
        dock.island.label.classList.toggle("has-work", count > 0);
        dock.island.label.setAttribute("aria-label", `Explore ${dock.island.spot.family.name}, ${visible.length} projects${count ? `, ${count} active coding jobs` : ""}`);
      }
    },
  };
}
