// Rock profiles are decorative. Project size controls the vertical scale of each profile.
import * as THREE from "three";
import { rng } from "./util.js";

// Each contour gives height, two radii and a horizontal shift along the ridge.
const PROFILES = [
  { // Granite spire, with a narrow summit and a blue-grey snowline.
    contours: [[-.23, 1, .69, 0], [.12, .91, .60, -.02], [.43, .57, .35, -.13], [.7, .30, .22, -.24], [.9, .10, .09, -.32]],
    colors: ["#5c7183", "#9fbacb", "#e9f5fa"], snow: true,
  },
  { // Sandstone mesa, with ledges inset above the cliffs.
    contours: [[-.22, 1, .86, 0], [.17, .98, .81, .03], [.28, .80, .73, .03], [.51, .76, .69, .06], [.62, .64, .60, .06], [.98, .60, .55, .1]],
    colors: ["#a65338", "#d4794c", "#f4b775"], bands: true,
  },
  { // Folded ridge, wider along its crest and cut by uneven slopes.
    contours: [[-.22, 1, .66, 0], [.18, .91, .57, -.05], [.44, .81, .37, -.08], [.71, .70, .16, -.15], [.89, .48, .06, -.22]],
    colors: ["#674c3d", "#ad8158", "#d7ba82"],
  },
  { // Glacial cirque, with off-center shoulders and a broad snow field.
    contours: [[-.22, 1, .90, 0], [.2, .94, .74, .03], [.44, .73, .55, .08], [.59, .54, .42, .16], [.79, .41, .27, .29], [.95, .20, .13, .37]],
    colors: ["#5e5c86", "#9d9fcf", "#ebf6ff"], snow: true,
  },
  { // Green volcanic dome, with a rounded crest and exposed dark bluffs.
    contours: [[-.22, 1, .95, 0], [.23, .99, .88, .02], [.51, .90, .76, .04], [.77, .74, .56, .04], [.94, .40, .34, .04]],
    colors: ["#38524f", "#72926e", "#b3bc86"],
  },
];

/** Reuse each tessellated landform for all seats that share its profile. */
export function createMountainGeometry() {
  return PROFILES.map(({ contours, colors, snow, bands }, profile) => {
    const sides = 12, rand = rng(271 + profile * 37);
    const ribs = Array.from({ length: sides }, () => 0.76 + rand() * 0.29);
    const offset = Array.from({ length: sides }, () => (rand() - 0.5) * 0.10);
    const rows = contours.map(([y, rx, rz, shift], ring) => ribs.map((rib, i) => {
      const a = i / sides * Math.PI * 2 + (ring % 2) * 0.085;
      // The mesa is level along its top, while rock joints cut diagonally across the slopes.
      return [shift + Math.cos(a) * rx * rib, y + offset[i] * (bands && ring === contours.length - 1 ? .22 : 1), Math.sin(a) * rz * rib];
    }));
    const positions = [], tints = [];
    const [foot, rock, cap] = colors.map(color => new THREE.Color(color));
    const face = (a, b, c, ring) => {
      const height = (a[1] + b[1] + c[1]) / 3;
      const color = foot.clone().lerp(rock, Math.max(0, Math.min(1, height * 1.35 + .14)));
      if (snow && height > (profile === 3 ? .51 : .67)) color.copy(cap);
      if (bands && ring % 2 === 1) color.lerp(cap, .52);
      if (height > .88) color.lerp(cap, .86);
      color.multiplyScalar(.85 + rand() * .22);
      positions.push(...a, ...b, ...c);
      for (let i = 0; i < 3; i++) tints.push(color.r, color.g, color.b);
    };
    for (let j = 1; j < rows.length; j++) {
      for (let i = 0; i < sides; i++) {
        const next = (i + 1) % sides;
        face(rows[j - 1][i], rows[j][i], rows[j][next], j);
        face(rows[j - 1][i], rows[j][next], rows[j - 1][next], j);
      }
    }
    const rim = rows.at(-1), summit = [contours.at(-1)[3], 1, 0];
    for (let i = 0; i < sides; i++) face(rim[i], summit, rim[(i + 1) % sides], rows.length);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(tints, 3));
    geometry.computeVertexNormals();
    return geometry;
  });
}
