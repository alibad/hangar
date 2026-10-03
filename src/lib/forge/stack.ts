/**
 * Every story film is made with its own stack — the video model, the voice,
 * the score's style, the upscaler — chosen per film from the options used
 * least lately, and credited at the end of the film. Over many films, Montage
 * compares what each option gave (vision scores, render time, your verdicts).
 *
 * Import-free (types only), so the tests load this exact file.
 */

import type { FormatId, StoryCharacter, StoryShot, StoryStack } from "./story";

type Option = { key: string; label: string; weight?: number };

/** Measured on the first bake-off night (2 Oct): all four fit beside the night's services, H3 did not. */
export const VIDEO_OPTIONS: (Option & { videoModel: string; tier: "low" | "high"; steps?: number })[] = [
  { key: "wan5b", label: "Wan 2.2 5B", videoModel: "wan2.2-ti2v-5b", tier: "high" },
  { key: "wan14b", label: "Wan 2.2 14B", videoModel: "wan2.2-14b", tier: "high" },
  { key: "ltx", label: "LTX-2.5", videoModel: "ltx-2.5", tier: "high" },
  { key: "hunyuan", label: "HunyuanVideo 1.5", videoModel: "hunyuanvideo-1.5", tier: "low" },
];

/**
 * The quality slot (the owner's choice, 3 Oct): about one film in three made
 * with Wan 2.2 14B at its full 20 steps and real CFG, without the 4-step
 * lightx2v LoRA — sharper motion and faces, ~4× slower (~9 min a clip).
 */
export const QUALITY_VIDEO = { key: "wan14b-full", label: "Wan 2.2 14B (full, 20 steps)", videoModel: "wan2.2-14b", tier: "high" as const, steps: 20 };

export type VoiceOption = Option & { engine: "chatterbox" | "kokoro"; voice: string; gender: "female" | "male"; pair: string };

/** The lead voice. `pair` is the same engine's voice of the other gender, for a speaker who needs it. */
export const VOICE_OPTIONS: VoiceOption[] = [
  { key: "chatterbox", label: "Chatterbox (built-in voice)", engine: "chatterbox", voice: "default", gender: "female", pair: "clone-ali-b" },
  { key: "clone-ali-b", label: "Chatterbox (your cloned voice)", engine: "chatterbox", voice: "ali-b", gender: "male", pair: "chatterbox" },
  { key: "kokoro-af_heart", label: "Kokoro (af_heart)", engine: "kokoro", voice: "af_heart", gender: "female", pair: "kokoro-am_michael" },
  { key: "kokoro-am_michael", label: "Kokoro (am_michael)", engine: "kokoro", voice: "am_michael", gender: "male", pair: "kokoro-af_heart" },
  { key: "kokoro-bf_emma", label: "Kokoro (bf_emma)", engine: "kokoro", voice: "bf_emma", gender: "female", pair: "kokoro-bm_george" },
  { key: "kokoro-bm_george", label: "Kokoro (bm_george)", engine: "kokoro", voice: "bm_george", gender: "male", pair: "kokoro-bf_emma" },
];

/** Second and third speakers in a conversation: Kokoro voices other than the lead's. */
const SUPPORTING: Record<"female" | "male", string[]> = {
  female: ["af_bella", "bf_isabella", "af_nicole", "af_heart", "bf_emma"],
  male: ["bm_lewis", "am_fenrir", "am_puck", "am_michael", "bm_george"],
};

/** Light young voices for children. */
const CHILD = ["af_sky", "bf_isabella", "af_nicole"];

export const SCORE_OPTIONS: (Option & { style?: string })[] = [
  { key: "brief", label: "the writer's own brief" },
  { key: "piano", label: "solo piano", style: "intimate solo felt piano, sparse and slow, soft sustain pedal, a quiet motif that returns at the end" },
  { key: "strings", label: "string quartet", style: "warm string quartet, legato, slow harmonic movement, a singing cello melody, chamber music" },
  { key: "ambient", label: "ambient", style: "ambient soundscape, warm analog synth pads, soft field recordings of wind and water, slow evolving texture" },
  { key: "folk", label: "acoustic folk", style: "fingerpicked nylon-string guitar and kalimba, soft hand percussion, a gentle folk lullaby" },
];

/** Real-ESRGAN costs ~80 s a clip on the card (18 min a film): tried one film in four. */
export const FINISH_OPTIONS: (Option & { key: "lanczos" | "esrgan" })[] = [
  { key: "lanczos", label: "Lanczos upscale", weight: 3 },
  { key: "esrgan", label: "Real-ESRGAN ×2 upscale", weight: 1 },
];

/** The option used least (for its weight) among recent films; ties at random. */
function leastUsed<T extends Option>(options: T[], used: (string | undefined)[], rand: () => number): T {
  const score = (o: T) => used.filter((u) => u === o.key).length / (o.weight ?? 1);
  const least = Math.min(...options.map(score));
  const best = options.filter((o) => score(o) === least);
  return best[Math.floor(rand() * best.length)];
}

/**
 * The stack for a newly written story. Each part is chosen on its own, so over
 * a night every video model meets every voice and score. First-person films
 * get a voice of their speaker's gender (the same engine's pair); a
 * conversation's other speakers get Kokoro voices of their own.
 */
export function pickStack(
  story: { format?: FormatId; characters: StoryCharacter[]; shots: Pick<StoryShot, "speaker">[] },
  recent: StoryStack[],
  opts: { video?: string[]; quality?: boolean } = {},
  rand = Math.random,
): StoryStack {
  const window = recent.slice(0, 16);
  const videos = opts.video?.length ? VIDEO_OPTIONS.filter((v) => opts.video!.includes(v.key)) : VIDEO_OPTIONS;
  const video = opts.quality ? QUALITY_VIDEO : leastUsed(videos.length ? videos : VIDEO_OPTIONS, window.map((s) => s.video.key), rand);
  const score = leastUsed(SCORE_OPTIONS, window.map((s) => s.score.key), rand);
  const finish = leastUsed(FINISH_OPTIONS, window.map((s) => s.finish.key), rand);
  const stack: StoryStack = {
    pickedAt: new Date().toISOString(),
    video: { key: video.key, label: video.label, videoModel: video.videoModel, tier: video.tier, ...(video.steps ? { steps: video.steps } : {}) },
    score: { key: score.key, label: score.label, ...(score.style ? { style: score.style } : {}) },
    finish: { key: finish.key, label: finish.label },
  };
  if (story.format === "silent") return stack;

  const lead = leastUsed(VOICE_OPTIONS, window.map((s) => s.voice?.key), rand);
  stack.voice = { key: lead.key, label: lead.label };
  const byName = new Map(story.characters.map((c) => [c.name, c]));
  const speakers = [...new Set(story.shots.map((s) => s.speaker ?? "Narrator"))];
  const firstPerson = story.format === "monologue" || story.format === "letter";
  const asVoice = (o: VoiceOption) => ({ key: o.key, engine: o.engine, voice: o.voice, label: o.label });
  const voices: NonNullable<StoryStack["voices"]> = {};
  const taken = new Set<string>([lead.voice]);
  // The lead reads the narrator — or, in a first-person film, the one who speaks.
  const leadSpeaker = firstPerson ? (speakers.find((s) => s !== "Narrator") ?? "Narrator") : "Narrator";
  const leadGender = byName.get(leadSpeaker)?.gender;
  const leadChar = byName.get(leadSpeaker);
  // A child telling their own story gets a child's voice, whatever the rotation offered.
  const childLead = leadChar?.age === "child" ? ({ key: `kokoro-${CHILD[0]}`, label: `Kokoro (${CHILD[0]})`, engine: "kokoro", voice: CHILD[0], gender: "female", pair: "" } as VoiceOption) : null;
  const leadVoice = childLead ?? (leadGender && leadGender !== "none" && leadGender !== lead.gender ? VOICE_OPTIONS.find((o) => o.key === lead.pair) ?? lead : lead);
  voices[leadSpeaker] = asVoice(leadVoice);
  taken.add(leadVoice.voice);
  for (const sp of speakers) {
    if (voices[sp]) continue;
    const c = byName.get(sp);
    const gender: "female" | "male" = c?.gender === "female" || c?.gender === "male" ? c.gender : leadVoice.gender === "female" ? "male" : "female";
    // Kokoro has no child voices; a light young voice reads a child of either
    // gender (the first conversation gave a boy am_fenrir, a deep adult voice).
    const pool = c?.age === "child" ? CHILD : SUPPORTING[gender];
    const pick = pool.find((v) => !taken.has(v)) ?? pool[0];
    taken.add(pick);
    voices[sp] = { key: `kokoro-${pick}`, engine: "kokoro", voice: pick, label: `Kokoro (${pick})` };
  }
  stack.voices = voices;
  return stack;
}

/** Every option of every part, for the lab and Montage's comparison. */
export const STACK_OPTIONS = { video: VIDEO_OPTIONS, voice: VOICE_OPTIONS, score: SCORE_OPTIONS, finish: FINISH_OPTIONS };
