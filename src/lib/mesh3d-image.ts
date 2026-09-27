import sharp from "sharp";

/**
 * Image work for the 3D pipeline, kept free of the app's path aliases so
 * scripts/mesh3d.test.mjs can run it: the cutout is the one step whose failure
 * is invisible downstream (a mesh model given no alpha just mattes the image
 * itself), so it is tested directly.
 */

/** RGB + L mask → RGBA, cropped to the box plus 12% margin, padded square and transparent. */
export async function applyMask(image: Buffer, mask: Buffer, box: [number, number, number, number]): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const alpha = await sharp(mask).resize(width, height).extractChannel(0).toColourspace("b-w").raw().toBuffer();
  // RGB is materialised first on purpose: in ONE sharp pipeline removeAlpha()
  // runs after joinChannel() whatever order they are written in, so the mask
  // was joined and then stripped — a 3-channel "cutout" that the mesh models
  // silently re-matted with their own background removal.
  const rgb = await sharp(image).removeAlpha().raw().toBuffer();
  const rgba = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const [x1, y1, x2, y2] = box;
  const side = Math.ceil(Math.max(x2 - x1, y2 - y1) * 1.24);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const left = Math.round(cx - side / 2);
  const top = Math.round(cy - side / 2);
  // Extract what lies inside the image, then pad back out to the full square.
  const ex = { left: Math.max(0, left), top: Math.max(0, top) };
  const ew = Math.min(width, left + side) - ex.left;
  const eh = Math.min(height, top + side) - ex.top;
  return sharp(rgba)
    .extract({ ...ex, width: Math.max(1, ew), height: Math.max(1, eh) })
    .extend({
      left: ex.left - left,
      top: ex.top - top,
      right: Math.max(0, left + side - Math.min(width, left + side)),
      bottom: Math.max(0, top + side - Math.min(height, top + side)),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}
