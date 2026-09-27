import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import path from "path";

/**
 * The music gallery: every generated track kept on disk beside a `.json`
 * sidecar, the way the Image Studio keeps PNGs.
 *
 * Its own root rather than a folder under `generated/`: the Image Studio treats
 * every directory there as an image gallery, and a "music" folder would show up
 * in it as an empty one. Override with MUSIC_OUTPUT_DIR. Gitignored.
 *
 * No database table: the runs record (`lab_runs`) already holds the numbers for
 * every run and points here through `output_path`; the sidecar is what makes a
 * track re-usable (seed, lyrics, what the planner decided) without that DB.
 */
export function musicDir(): string {
  return process.env.MUSIC_OUTPUT_DIR || path.join(process.cwd(), "generated-music");
}

export const AUDIO_TYPES: Record<string, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

/** What the service reports about one generation (X-Music-Meta), plus what we add. */
export type MusicMeta = {
  task: string;
  seed: number;
  dit: string | null;
  lm: string | null;
  latency_ms: number;
  audio_seconds: number | null;
  src_seconds?: number | null;
  steps?: number;
  resolved?: {
    bpm?: number | null;
    keyscale?: string | null;
    timesignature?: string | null;
    duration?: number | null;
    vocal_language?: string | null;
    caption?: string | null;
  };
  time_costs?: Record<string, number>;
  peak_allocated_gb?: number;
  peak_reserved_gb?: number;
  card_before_gb?: number;
  /** 0..1 amplitude envelope for drawing a waveform without decoding the file. */
  peaks?: number[];
};

export type MusicTrack = {
  /** Base filename without extension; stable, URL-safe. */
  id: string;
  file: string;
  format: string;
  bytes: number;
  savedAt: string;
  caption: string;
  lyrics: string;
  instrumental: boolean;
  /** The language the vocals were asked for (the planner may not report one). */
  vocalLanguage?: string | null;
  requestedDuration: number | null;
  /** The track this one was made from (extend / repaint / remix / stem). */
  sourceId?: string | null;
  sourceName?: string | null;
  track?: string | null;
  runId?: string | null;
  meta: MusicMeta;
};

const ID_RE = /^[A-Za-z0-9._-]+$/;

function stamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function slug(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Absolute path of a track's audio, or null for an id that is not one of ours. */
export async function trackAudioPath(id: string): Promise<{ path: string; format: string } | null> {
  if (!ID_RE.test(id)) return null;
  const t = await readTrack(id);
  if (!t) return null;
  const p = path.join(musicDir(), t.file);
  return { path: p, format: t.format };
}

export async function readTrack(id: string): Promise<MusicTrack | null> {
  if (!ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(musicDir(), `${id}.json`), "utf8")) as MusicTrack;
  } catch {
    return null;
  }
}

export async function saveTrack(
  audio: Buffer,
  format: string,
  info: Omit<MusicTrack, "id" | "file" | "format" | "bytes" | "savedAt">,
): Promise<MusicTrack> {
  const dir = musicDir();
  await mkdir(dir, { recursive: true });
  const label = info.caption || info.meta.resolved?.caption || info.meta.task;
  const id = [stamp(new Date()), info.meta.task, info.meta.seed, slug(label)].filter((x) => x !== "" && x != null).join("-");
  const file = `${id}.${format}`;
  await writeFile(path.join(dir, file), audio);
  const track: MusicTrack = { id, file, format, bytes: audio.length, savedAt: new Date().toISOString(), ...info };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(track, null, 2));
  return track;
}

/** Rewrite a track's sidecar (e.g. to link it to its runs-record row). */
export async function updateTrack(track: MusicTrack): Promise<void> {
  if (!ID_RE.test(track.id)) return;
  await writeFile(path.join(musicDir(), `${track.id}.json`), JSON.stringify(track, null, 2));
}

export async function listTracks(limit = 60): Promise<MusicTrack[]> {
  let names: string[];
  try {
    names = (await readdir(musicDir())).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  // Filenames start with a local timestamp, so name order is age order.
  names.sort().reverse();
  const out: MusicTrack[] = [];
  for (const n of names.slice(0, limit)) {
    const t = await readTrack(n.slice(0, -5));
    if (t) out.push(t);
  }
  return out;
}

export async function deleteTrack(id: string): Promise<boolean> {
  const t = await readTrack(id);
  if (!t) return false;
  const dir = musicDir();
  await rm(path.join(dir, t.file), { force: true });
  await rm(path.join(dir, `${id}.json`), { force: true });
  return true;
}

export async function fileSize(p: string): Promise<number> {
  return (await stat(p)).size;
}
