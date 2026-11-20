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

/** Fit the projected footprint at the view's preferred angle. A bounding
 * sphere wastes most of the canvas on rectangular or oblique layouts. */
export function fitWorld(points, theta, phi, aspect, fov, { minimum = 42, padX = 9, padY = 13 } = {}) {
  const sin = Math.sin, cos = Math.cos;
  const across = Math.tan(fov / 2) * Math.max(0.2, aspect) * 0.89;
  const vertical = Math.tan(fov / 2) * 0.83;
  let distance = minimum;
  for (const { x, y, z } of points) {
    const right = x * cos(theta) - z * sin(theta);
    const forward = x * sin(theta) + z * cos(theta);
    const up = y * sin(phi) - forward * cos(phi);
    const depth = forward * sin(phi) + y * cos(phi);
    distance = Math.max(distance, depth + Math.max((Math.abs(right) + padX) / across, (Math.abs(up) + padY) / vertical));
  }
  return distance;
}
