// An embedded world can boot before its parent panel has a measurable size.
// Use the desktop framing until the resize handler receives real dimensions.
export function homeView(extent, embedded, width, height) {
  const theta = 0.72;
  const toward = extent * 0.2;
  const aspect = width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : 1.4;
  const fit = embedded ? Math.max(1, 1.4 / Math.max(0.4, aspect)) : 1;
  return {
    target: { x: Math.sin(theta) * toward, y: -6, z: Math.cos(theta) * toward },
    radius: extent * 2 * fit,
    phi: embedded ? 1 : 0.8,
    theta,
  };
}
