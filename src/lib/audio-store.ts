import { mkdir, readFile, readdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateAudioRecipe, type AudioLibrary, type AudioRevision } from "./audio-project";

export const audioDir = () => process.env.AUDIO_LAB_DIR || path.join(process.cwd(), "var", "audio-lab");
export const audioFile = (name: string) => /^[a-f0-9-]{36}\.(wav|mp3|ogg|flac|webm|m4a|json)$/.test(name) ? path.join(audioDir(), name) : null;
export async function audioLibrary(): Promise<AudioLibrary> {
  await mkdir(audioDir(), { recursive: true });
  const entries = await Promise.all((await readdir(audioDir())).filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(async file => {
    const data = JSON.parse(await readFile(path.join(audioDir(), file), "utf8"));
    if (data.type === "revision") {
      try { Object.assign(data, JSON.parse(await readFile(path.join(audioDir(), `${data.id}.review.json`), "utf8"))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return data;
  }));
  return { revisions: entries.filter(e => e.type === "revision").sort((a, b) => b.created.localeCompare(a.created)), assets: entries.filter(e => e.type === "asset") };
}
export function validateRenderWave(bytes: Buffer) {
  return bytes.length >= 44 && bytes.length <= 12000000 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE" && bytes.toString("ascii", 12, 16) === "fmt " && bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 2 && bytes.readUInt32LE(24) === 48000 && bytes.readUInt16LE(34) === 16 && bytes.toString("ascii", 36, 40) === "data" && bytes.readUInt32LE(40) === bytes.length - 44 && (bytes.length - 44) % 4 === 0;
}
export async function saveAudioRevision(bytes: Buffer, value: Omit<AudioRevision, "id" | "url" | "created" | "status">) {
  if (!validateAudioRecipe(value.recipe) || !validateRenderWave(bytes) || !/^[a-z0-9-]{1,60}$/.test(value.event) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 160 || typeof value.notes !== "string" || value.notes.length > 4000 || !Number.isFinite(value.peakDb) || !Number.isFinite(value.rmsDb)) throw new Error("Invalid render or recipe");
  const seconds = (bytes.length - 44) / (48000 * 4);
  if (Math.abs(seconds - value.recipe.length) > .001) throw new Error("Render duration does not match recipe");
  // Measure saved samples; metadata must describe the bytes, not an unchecked client claim.
  let peak = 0, squares = 0;
  for (let i = 44; i < bytes.length; i += 2) { const x = bytes.readInt16LE(i) / 32768; peak = Math.max(peak, Math.abs(x)); squares += x * x; }
  const id = randomUUID(), revision: AudioRevision = { ...value, peakDb: Math.max(-120, 20 * Math.log10(peak || 1e-6)), rmsDb: Math.max(-120, 20 * Math.log10(Math.sqrt(squares / ((bytes.length - 44) / 2)) || 1e-6)), id, url: `/api/audio-lab/asset/${id}.wav`, created: new Date().toISOString(), status: "draft" };
  await mkdir(audioDir(), { recursive: true });
  await writeFile(path.join(audioDir(), `${id}.wav`), bytes, { flag: "wx" });
  await writeFile(path.join(audioDir(), `${id}.json`), JSON.stringify({ type: "revision", ...revision }, null, 2), { flag: "wx" });
  return revision;
}
export async function saveAudioImport(bytes: Buffer, name: string, ext: string, license: string) {
  if (!/^(wav|mp3|ogg|flac|webm|m4a)$/.test(ext) || !bytes.length || bytes.length > 20000000 || !license.trim() || license.length > 1000 || name.length > 160) throw new Error("Invalid import: add a source/license note and an audio file under 20 MB");
  const id = randomUUID(), item = { id, name, license, url: `/api/audio-lab/asset/${id}.${ext}` };
  await mkdir(audioDir(), { recursive: true });
  await writeFile(path.join(audioDir(), `${id}.${ext}`), bytes, { flag: "wx" });
  await writeFile(path.join(audioDir(), `${id}.json`), JSON.stringify({ type: "asset", ...item }, null, 2), { flag: "wx" });
  return item;
}
export async function reviewAudioRevision(id: string, status: AudioRevision["status"], notes: string) {
  const file = audioFile(`${id}.json`);
  if (!file || !["draft", "approved", "rejected"].includes(status) || typeof notes !== "string" || notes.length > 4000) throw new Error("Invalid review");
  const item = JSON.parse(await readFile(file, "utf8"));
  if (item.type !== "revision") throw new Error("Not an audio revision");
  const tmp = path.join(audioDir(), `${id}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify({ status, notes }));
  await rename(tmp, path.join(audioDir(), `${id}.review.json`));
}
