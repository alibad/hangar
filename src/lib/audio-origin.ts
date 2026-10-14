/** Compare the incoming Host, not Next's internal localhost URL. */
export function sameAudioOrigin(origin: string | null, host: string | null) {
  if (!origin) return true; // Local CLI clients do not send browser Origin headers.
  try { const url = new URL(origin); return ["http:", "https:"].includes(url.protocol) && url.host === host; } catch { return false; }
}
