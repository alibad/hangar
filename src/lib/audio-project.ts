/** Portable recipes: seconds, decibels and semitones, never machine paths. */
export type AudioLayer = {
  id: string; name: string; url: string; duration: number;
  start: number; end: number; offset: number; gainDb: number; pitch: number;
  fadeIn: number; fadeOut: number; lowpass: number; pan: number; muted: boolean; solo: boolean;
};
export type AudioRecipe = { layers: AudioLayer[]; length: number; loop: boolean; notes: string };
export type AudioEvent = { id: string; label: string; kind: string; currentUrl: string | null; recipe: AudioRecipe; note?: string };
export type AudioRevision = { id: string; event: string; name: string; url: string; created: string; recipe: AudioRecipe; peakDb: number; rmsDb: number; status: "draft" | "approved" | "rejected"; notes: string };
export type AudioPilot = { name: string; actor: string; faction: string; actorName: string; viewerOrigin: string; events: AudioEvent[]; provenance: { license: string; sources: unknown[]; recipeSource: string } };
export type AudioLibrary = { revisions: AudioRevision[]; assets: { id: string; name: string; url: string; license: string }[] };

const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
export function audioAssetUrl(url: unknown): url is string {
  return typeof url === "string" && (/^\/audio-lab\/pilot\/[a-z0-9-]+\.wav$/.test(url) || /^\/api\/audio-lab\/asset\/[a-f0-9-]{36}\.(wav|mp3|ogg|flac|webm|m4a)$/.test(url));
}
export function validateAudioRecipe(value: unknown): value is AudioRecipe {
  if (!value || typeof value !== "object") return false;
  const r = value as AudioRecipe;
  return finite(r.length, .1, 60) && typeof r.loop === "boolean" && typeof r.notes === "string" && r.notes.length <= 4000 && Array.isArray(r.layers) && r.layers.length > 0 && r.layers.length <= 12 &&
    new Set(r.layers.map(l => l?.id)).size === r.layers.length && r.layers.every(l => l && typeof l.id === "string" && l.id.length <= 100 && typeof l.name === "string" && l.name.length <= 160 && audioAssetUrl(l.url) &&
      finite(l.duration, .001, 600) && finite(l.start, 0, l.duration) && finite(l.end, l.start + .001, l.duration + .001) && finite(l.offset, 0, 60) && finite(l.gainDb, -60, 12) && finite(l.pitch, -24, 24) && finite(l.fadeIn, 0, 60) && finite(l.fadeOut, 0, 60) && finite(l.lowpass, 40, 24000) && finite(l.pan, -1, 1) && typeof l.muted === "boolean" && typeof l.solo === "boolean");
}

/** PCM16 stereo WAV; exported bytes are the actual auditioned render. */
export function encodeAudioWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const n = channels[0].length, count = channels.length;
  const bytes = new ArrayBuffer(44 + n * count * 2), v = new DataView(bytes);
  const str = (offset: number, s: string) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, bytes.byteLength - 8, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, count, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * count * 2, true); v.setUint16(32, count * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * count * 2, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < count; c++) { const x = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(44 + (i * count + c) * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true); }
  return bytes;
}

export function peakAndRms(channels: Float32Array[]) {
  let peak = 0, sum = 0, n = 0;
  for (const ch of channels) for (const x of ch) { peak = Math.max(peak, Math.abs(x)); sum += x * x; n++; }
  return { peakDb: Math.max(-120, 20 * Math.log10(peak || 1e-6)), rmsDb: Math.max(-120, 20 * Math.log10(Math.sqrt(sum / Math.max(1, n)) || 1e-6)) };
}
