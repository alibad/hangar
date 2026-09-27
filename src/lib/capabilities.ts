/**
 * Every capability id a host profile may declare in a service's `serves`.
 *
 * Two lists used to answer this and neither was the whole answer. CAPABILITIES
 * in providers.ts is the set the AI Router can ROUTE — each entry needs a
 * LiteLLM `mode` and a default model — and host-profiles.test.mjs carried a
 * hand-copied mirror of it. Music, 3D, video and decision models have no router
 * mode and may never get one, but a host still has to be able to say "this
 * service makes music" so a Lab can find it. This is that vocabulary; the
 * routable set is a subset of it, and providers.ts is type-checked against it.
 *
 * Pure data with no imports, so the browser bundle, the Node test runner and
 * the server can all read the same list.
 */
export const CAPABILITY_IDS = [
  "text",
  "vision",
  "image",
  "stt",
  "tts",
  "music",
  "3d",
  "video",
  "decision",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Short phrases, because they land mid-sentence ("nothing here serves …"). */
export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  text: "text generation",
  vision: "vision",
  image: "image generation",
  stt: "speech-to-text",
  tts: "text-to-speech",
  music: "music generation",
  "3d": "3D generation",
  video: "video generation",
  decision: "typed decisions",
};

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}
