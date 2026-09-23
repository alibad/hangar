/**
 * Is this actually a picture, or is it static?
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * On 2026-09-21 an audit found that every image this console had produced on
 * B5 since 2026-09-20 was high-frequency colour noise. Nothing noticed. The
 * PNGs were structurally perfect — signature, per-chunk CRC, IEND all valid —
 * so `file` was happy, the adapter returned the bytes, generateAndSave() saved
 * them, the gallery rendered them with a latency badge, and the Requests feed
 * logged a 200. A model emitting static was indistinguishable from a working
 * one at every layer.
 *
 * The cause was environmental (Draw Things' CLI ships Metal 4 tensor shaders
 * that this machine's Metal compiler rejects; the same weights render fine in
 * the GUI app). It will happen again, in a different shape, on a different
 * box: a half-loaded checkpoint, a dtype mismatch, a VAE that decoded to
 * garbage. The engine is not the lesson. The lesson is that NOTHING in the
 * stack looked at the output.
 *
 * So: a capability is verified by its output, never by a 200.
 *
 * ── HOW IT DECIDES ──────────────────────────────────────────────────────────
 * Natural images are spatially CORRELATED — a pixel strongly predicts its
 * neighbour, because real scenes are made of surfaces, not of independent
 * samples. Diffusion static is the opposite: neighbouring pixels are drawn
 * near-independently, so the mean absolute difference between horizontally
 * adjacent pixels is enormous.
 *
 * Two measurements, both taken on this machine's own files on 2026-09-21:
 *
 *   `delta`  mean |difference| to the pixel on the right, over RGB, 0-255
 *   `smooth` share of adjacent pairs differing by <=2 on every channel
 *
 *                                            delta   smooth
 *   real  FLUX mug (CLI, 2026-09-03)          1.69    71.7%
 *   real  FLUX pear (app, 2026-09-20)         1.92    78.6%
 *   real  FLUX wrapper check 512²             1.27    84.1%
 *   real  a screenshot (worst case for delta) 1.27    97.5%
 *   real  4K grayscale samurai, very dense   14.90    24.8%
 *   noise CLI offline, 2026-09-21            33.52     1.5%
 *   noise CLI with fresh settings            32.29     0.9%
 *   noise adapter :8111                      35.35     0.6%
 *   noise console route, saved to gallery    30.29     1.1%
 *
 * `smooth` is the load-bearing one. Real images always contain flat regions —
 * sky, a studio background, a surface — so a quarter of their neighbouring
 * pairs match even in the densest example here. Static has essentially none:
 * the worst real case (24.8%) is sixteen times the best noise case (1.5%).
 *
 * DELIBERATELY NOT a quality judgement. It cannot tell a good image from an
 * ugly one, a wrong subject from a right one, or six fingers from five. It
 * answers exactly one question — "did the denoiser actually converge, or is
 * this the latent it started from?" — and that is the question that went
 * unasked for four days.
 *
 * Pure and dependency-free so `node --test` can run it over real fixtures
 * without a bundler, and so the adapter (plain JS, no build step) can use the
 * same rule by shelling out to the same logic.
 */

import zlib from "node:zlib";

export type ImageVerdict = {
  ok: boolean;
  /** Mean absolute difference between horizontally adjacent pixels, 0-255. */
  neighbourDelta: number;
  /** Share (0-1) of adjacent pairs that match within 2 on every channel. */
  smoothFraction: number;
  width: number;
  height: number;
  /** Populated when ok is false — a sentence fit to show a user. */
  reason?: string;
};

/**
 * Noise is flagged only when BOTH signals agree.
 *
 * `delta` alone was the first attempt and it is not enough: a legitimately
 * dense image (the 4K grayscale samurai above) reaches 14.9, only 2x below the
 * quietest real noise at 30.3. That margin is too thin to bet a user's
 * generation on. `smooth` separates the same two sets by 16x, so it carries
 * the decision and `delta` confirms it.
 *
 * Requiring both means a false REJECT — blocking a machine that works — needs
 * two independent measurements to be wrong at once. A false ACCEPT is the
 * failure we already had and is strictly no worse than today.
 */
export const NOISE_DELTA_THRESHOLD = 22;
export const NOISE_SMOOTH_THRESHOLD = 0.08;

/**
 * Minimum pixels before the verdict means anything. A thumbnail-sized sample
 * of a real image can legitimately be busy; there is no reason to generate one
 * that small, so this only guards against a caller passing a stray icon.
 */
const MIN_PIXELS = 64 * 64;

type Decoded = { width: number; height: number; channels: number; data: Buffer };

/**
 * Minimal PNG decoder: 8-bit truecolour, non-interlaced, which is what every
 * local diffusion backend here emits.
 *
 * Written out rather than pulled from npm because this module is the thing
 * that decides whether output is trustworthy, and a 300-line dependency with
 * its own CVE surface is a poor foundation for that. Returns null for anything
 * it does not understand, and a null verdict never blocks a generation — an
 * undecodable image is a different problem, reported elsewhere.
 */
function decodePng(png: Buffer): Decoded | null {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return null;

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colourType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }

  // 2 = RGB, 6 = RGBA. Palette and greyscale are not produced by any backend
  // here; refusing them is honest, and yields a null (unknown) verdict.
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6) || interlace !== 0) return null;
  if (!width || !height || !idat.length) return null;

  const channels = colourType === 2 ? 3 : 4;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-scanline filters. Straight from the PNG spec's five filter
  // types; `out` accumulates the reconstructed image so each row can reference
  // the one above it.
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0; // pixel to the left
      const b = prev ? prev[i] : 0; // pixel above
      const c = prev && i >= channels ? prev[i - channels] : 0; // above-left
      let value: number;
      switch (filter) {
        case 0: value = src[i]; break;
        case 1: value = src[i] + a; break;
        case 2: value = src[i] + b; break;
        case 3: value = src[i] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      cur[i] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

/**
 * Mean absolute difference between horizontally adjacent pixels, over RGB.
 *
 * Horizontal only, and every row: vertical would measure the same property at
 * twice the cost, and sampling rows would make the verdict non-deterministic,
 * which is the last thing a gate like this should be.
 */
function measure(img: Decoded): { delta: number; smooth: number } {
  const { width, height, channels, data } = img;
  let total = 0;
  let channelPairs = 0;
  let flat = 0;
  let pixelPairs = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width * channels;
    for (let x = 0; x + 1 < width; x++) {
      const i = row + x * channels;
      const j = i + channels;
      const dr = Math.abs(data[i] - data[j]);
      const dg = Math.abs(data[i + 1] - data[j + 1]);
      const db = Math.abs(data[i + 2] - data[j + 2]);
      total += dr + dg + db;
      channelPairs += 3;
      if (dr <= 2 && dg <= 2 && db <= 2) flat++;
      pixelPairs++;
    }
  }
  return {
    delta: channelPairs ? total / channelPairs : 0,
    smooth: pixelPairs ? flat / pixelPairs : 1,
  };
}

/**
 * Judge a generated PNG.
 *
 * Returns `ok: true` with `neighbourDelta: -1` for anything undecodable, so an
 * exotic-but-valid PNG is never rejected by a decoder limitation. The gate only
 * ever fires on an image it genuinely measured.
 */
export function inspectImage(png: Buffer): ImageVerdict {
  const img = decodePng(png);
  if (!img) return { ok: true, neighbourDelta: -1, smoothFraction: -1, width: 0, height: 0 };
  if (img.width * img.height < MIN_PIXELS) {
    return { ok: true, neighbourDelta: -1, smoothFraction: -1, width: img.width, height: img.height };
  }

  const { delta, smooth } = measure(img);
  const base = { neighbourDelta: delta, smoothFraction: smooth, width: img.width, height: img.height };

  if (smooth < NOISE_SMOOTH_THRESHOLD && delta > NOISE_DELTA_THRESHOLD) {
    return {
      ...base,
      ok: false,
      reason:
        `The backend returned static, not a picture: only ${(smooth * 100).toFixed(1)}% of ` +
        `neighbouring pixels match (a real image has at least 25%), and they differ by ` +
        `${delta.toFixed(1)} on average. The PNG itself is valid, so this is the model or its ` +
        `runtime failing to denoise, not a transfer problem. Run ` +
        `\`node scripts/doctor.mjs image\` to re-test this machine's image runtime.`,
    };
  }
  return { ...base, ok: true };
}
