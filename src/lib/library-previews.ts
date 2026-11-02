// Previews for the Library's wall: a poster for every picture, clip and model,
// a strip of frames a clip's tile scrubs through on hover, a sound's waveform,
// and a dataset's 2×2 mosaic.
//
// Made on first request (sharp for pictures, ffmpeg for clips and sounds, both
// on the CPU) and cached under the Library's cacheDir, keyed by the file's path,
// size and time, so a changed file gets a new preview and nothing is ever made
// twice. The media itself is only read.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { normPath } from "@/lib/library-classify";
import type { ServedFile } from "@/lib/library";

export type PreviewVariant = "poster" | "scrub" | "wave";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const SCRUB_FRAMES = 12;
/** Bumped when a preview's look changes, so cached ones are made again. */
const PREVIEW_VERSION = 2;

/** At most `n` jobs at once; previews are asked for a hundred at a time. */
function gate(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

const g = globalThis as typeof globalThis & {
  __libraryPreviewGates?: { ffmpeg: ReturnType<typeof gate>; sharp: ReturnType<typeof gate> };
  __libraryPreviewInflight?: Map<string, Promise<string | null>>;
};
const gates = (g.__libraryPreviewGates ??= { ffmpeg: gate(3), sharp: gate(6) });
const inflight = (g.__libraryPreviewInflight ??= new Map());

function exec(cmd: string, args: string[], timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-300)}`));
    });
  });
}

async function duration(file: string): Promise<number | null> {
  try {
    const out = await exec(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], 20_000);
    const d = Number(out.toString().trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/** One frame of a clip at `t` seconds, as a JPEG buffer. */
async function frameAt(file: string, t: number, width: number): Promise<Buffer | null> {
  try {
    const buf = await exec(FFMPEG, ["-v", "error", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "pipe:1"], 30_000);
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

async function writeAtomic(target: string, data: Buffer) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, data);
  await fsp.rename(temp, target).catch(async (err) => {
    await fsp.unlink(temp).catch(() => {});
    // Another request made the same preview first.
    if (!(await fsp.stat(target).catch(() => null))) throw err;
  });
}

const picture = (input: string | Buffer, width: number) =>
  sharp(input, { failOn: "none", limitInputPixels: 400_000_000 })
    .rotate()
    .resize({ width, height: Math.round(width * 1.6), fit: "inside", withoutEnlargement: true })
    .webp({ quality: 76 })
    .toBuffer();

async function make(file: ServedFile, variant: PreviewVariant, width: number, samples: string[]): Promise<Buffer | null> {
  if (file.kind === "collection") {
    // Four samples, each cropped square, in a 2×2 mosaic.
    const cell = Math.round(width / 2);
    const tiles = (
      await Promise.all(samples.slice(0, 4).map((s) => gates.sharp(() => sharp(s, { failOn: "none" }).resize(cell, cell, { fit: "cover" }).webp().toBuffer()).catch(() => null)))
    ).filter((t): t is Buffer => !!t);
    if (!tiles.length) return null;
    return sharp({ create: { width: cell * 2, height: cell * 2, channels: 3, background: "#1b1b1f" } })
      .composite(tiles.map((input, i) => ({ input, left: (i % 2) * cell, top: Math.floor(i / 2) * cell })))
      .webp({ quality: 76 })
      .toBuffer();
  }
  if (file.kind === "image" || file.kind === "model") return gates.sharp(() => picture(file.path, width));
  if (file.kind === "video" && variant === "poster") {
    return gates.ffmpeg(async () => {
      const d = await duration(file.path);
      const frame = (await frameAt(file.path, d ? Math.min(d * 0.15, 20) : 1, width)) ?? (await frameAt(file.path, 0, width));
      return frame ? picture(frame, width) : null;
    });
  }
  if (file.kind === "video" && variant === "scrub") {
    return gates.ffmpeg(async () => {
      const d = (await duration(file.path)) ?? 0;
      const w = Math.min(width, 320);
      const frames: Buffer[] = [];
      for (let i = 0; i < SCRUB_FRAMES; i++) {
        const f = await frameAt(file.path, d ? (d * (i + 0.5)) / SCRUB_FRAMES : i, w);
        if (f) frames.push(f);
      }
      if (!frames.length) return null;
      const meta = await sharp(frames[0]).metadata();
      const h = meta.height ?? Math.round((w * 9) / 16);
      return sharp({ create: { width: w * frames.length, height: h, channels: 3, background: "#000" } })
        .composite(await Promise.all(frames.map(async (f, i) => ({ input: await sharp(f).resize(w, h, { fit: "cover" }).toBuffer(), left: i * w, top: 0 }))))
        .webp({ quality: 70 })
        .toBuffer();
    });
  }
  if (file.kind === "sound" && variant === "wave") {
    return gates.ffmpeg(() =>
      // A square-root scale, so a quiet sound still draws a shape you can read.
      exec(FFMPEG, ["-v", "error", "-i", file.path, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=800x200:colors=0xffffffff:scale=sqrt:draw=full", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], 60_000),
    );
  }
  return null;
}

/**
 * The cached preview for a file, made now if it isn't cached yet. `samples`
 * are a collection's sample paths (its mosaic is made from them).
 */
export async function previewFor(file: ServedFile, variant: PreviewVariant, opts: { cacheDir: string; width: number; samples?: string[] }): Promise<{ path: string; type: string } | null> {
  const type = variant === "wave" ? "image/png" : "image/webp";
  const key = crypto.createHash("sha1").update([PREVIEW_VERSION, normPath(file.path), file.size, file.mtime, variant, opts.width, file.kind].join("|")).digest("hex");
  const out = path.join(opts.cacheDir, key.slice(0, 2), `${key}.${variant === "wave" ? "png" : "webp"}`);
  if (await fsp.stat(out).catch(() => null)) return { path: out, type };
  let job = inflight.get(key);
  if (!job) {
    job = (async () => {
      const data = await make(file, variant, opts.width, opts.samples ?? []).catch(() => null);
      if (!data?.length) return null;
      await writeAtomic(out, data);
      return out;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return (await job) ? { path: out, type } : null;
}
