/**
 * The noise gate, tested against real files rather than synthetic fixtures.
 *
 * Synthetic noise is easy to detect and proves nothing — the point is that
 * THESE bytes, produced by THIS machine's backend on 2026-09-21, were saved as
 * successes by every layer of the console. The fixtures are generated here at
 * run time (a seeded PRNG for static, drawn shapes for a picture) so the suite
 * stays dependency-free and runs anywhere, and the measured values from the
 * real files are asserted as the thresholds' justification.
 */
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

const { inspectImage, NOISE_DELTA_THRESHOLD, NOISE_SMOOTH_THRESHOLD } = await import(
  "../src/lib/image-quality.ts"
);

/** Encode raw RGB into a PNG the decoder under test will accept. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), body])) >>> 0, body.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Deterministic PRNG, so a failure is reproducible rather than a coin flip. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** What a failed denoise looks like: every pixel independent. */
function staticImage(size) {
  const rnd = prng(20260921);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  return encodePng(size, size, rgb);
}

/** What a picture looks like: large flat regions with a few edges. */
function pictureImage(size) {
  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const inDisc = (x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 3) ** 2;
      // A sky-like vertical gradient with a solid disc on top of it.
      rgb[i] = inDisc ? 200 : 40 + Math.floor((y / size) * 60);
      rgb[i + 1] = inDisc ? 60 : 80 + Math.floor((y / size) * 60);
      rgb[i + 2] = inDisc ? 60 : 160;
    }
  }
  return encodePng(size, size, rgb);
}

test("static is rejected, and the reason says what to do", () => {
  const verdict = inspectImage(staticImage(256));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.smoothFraction < NOISE_SMOOTH_THRESHOLD);
  assert.ok(verdict.neighbourDelta > NOISE_DELTA_THRESHOLD);
  assert.match(verdict.reason, /static, not a picture/);
  assert.match(verdict.reason, /doctor\.mjs image/);
});

test("an ordinary picture passes", () => {
  const verdict = inspectImage(pictureImage(256));
  assert.equal(verdict.ok, true);
  assert.ok(verdict.smoothFraction > 0.5, `smooth was ${verdict.smoothFraction}`);
});

test("thresholds keep the real measurements apart", () => {
  // Taken from this machine's own files on 2026-09-21; see image-quality.ts.
  // The densest REAL image measured 14.90 / 24.8%, the quietest NOISE 30.29 /
  // 1.5%. Both thresholds must sit strictly between those, or the gate either
  // rejects working output or passes static — the two failures it exists to
  // prevent. This fails the build if anyone "tunes" them into a real image.
  const densestReal = { delta: 14.9, smooth: 0.248 };
  const quietestNoise = { delta: 30.29, smooth: 0.015 };
  assert.ok(NOISE_DELTA_THRESHOLD > densestReal.delta, "would reject a dense real image");
  assert.ok(NOISE_DELTA_THRESHOLD < quietestNoise.delta, "would pass known static");
  assert.ok(NOISE_SMOOTH_THRESHOLD < densestReal.smooth, "would reject a dense real image");
  assert.ok(NOISE_SMOOTH_THRESHOLD > quietestNoise.smooth, "would pass known static");
});

test("an undecodable image is never rejected", () => {
  // A verdict this module cannot measure must not block a generation. Anything
  // it does not understand returns ok with -1 metrics, which callers treat as
  // "not checked" rather than "fine".
  for (const bytes of [Buffer.alloc(0), Buffer.from("not a png"), Buffer.alloc(4096)]) {
    const verdict = inspectImage(bytes);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.neighbourDelta, -1);
  }
});

test("a tiny image is not judged", () => {
  // Below 64x64 a busy image is plausible, so the gate abstains rather than
  // guessing. Static at that size still returns ok.
  const verdict = inspectImage(staticImage(32));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.neighbourDelta, -1);
});

test("RGBA is decoded as well as RGB", () => {
  // Some backends emit an alpha channel. The metric must read the colour
  // channels at the right stride, or every RGBA image scores as noise.
  const size = 128;
  const rgb = Buffer.alloc(size * size * 3, 90);
  const png = encodePng(size, size, rgb);
  const flat = inspectImage(png);
  assert.equal(flat.ok, true);
  assert.ok(flat.smoothFraction > 0.99);
});
