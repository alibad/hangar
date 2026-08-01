// Thin, zero-resource prompt variation. No model, no network — just curated
// modifier pools recombined so a single idea fans out into N distinct prompts.
// Used as the default batch varier and as the fallback when the LLM is down.

export const DIM_POOLS = {
  style: [
    "photorealistic", "cinematic film still", "watercolor painting", "3D render, octane",
    "oil painting, thick brushwork", "anime illustration", "isometric low-poly",
    "vintage 35mm photo", "studio product photography", "concept art, matte painting",
    "pencil sketch", "pop-art, bold ink", "claymation style", "long-exposure photograph",
    "ink wash painting, guohua", "woodblock print, ukiyo-e", "medical illustration",
    "editorial photography", "brutalist architecture photography", "surrealist digital art",
  ],
  lighting: [
    "golden hour light", "soft studio softbox lighting", "moody backlight", "neon glow",
    "overcast diffused light", "dramatic chiaroscuro", "rim lighting", "candlelit warmth",
    "cool blue hour", "high-key bright lighting", "bioluminescent glow",
    "harsh midday sun", "foggy ambient light", "lightning flash",
  ],
  mood: [
    "serene", "dramatic", "playful", "mysterious", "nostalgic", "energetic",
    "minimal", "epic", "unsettling", "melancholic", "frenetic", "desolate",
    "transcendent", "violent", "erotic", "meditative",
  ],
  palette: [
    "warm earthy tones", "cool teal and orange", "pastel palette", "monochrome",
    "vivid saturated colors", "muted desaturated tones", "rich jewel tones",
    "neon on black", "sepia and rust", "ice blue and silver",
  ],
  lens: [
    "wide-angle", "85mm portrait, shallow depth of field", "macro close-up",
    "aerial top-down", "fish-eye", "tilt-shift miniature", "telephoto compression",
    "extreme wide 14mm", "over-the-shoulder POV", "worm's-eye view",
  ],
} as const;

export type DimKey = keyof typeof DIM_POOLS;

export interface DimConfig {
  style?:   { on: boolean; locked?: string };
  lighting?:{ on: boolean; locked?: string };
  mood?:    { on: boolean; locked?: string };
  palette?: { on: boolean; locked?: string };
  lens?:    { on: boolean; locked?: string };
}

function pick<T>(arr: readonly T[], i: number, salt: number): T {
  return arr[((i * salt) % arr.length + arr.length) % arr.length];
}

/**
 * Expand `idea` into `count` varied prompts.
 * Each active dim is rotated through its pool unless locked to a specific value.
 * `suffix` is appended verbatim to every prompt.
 */
export function varyPrompts(
  idea: string,
  count: number,
  dims: DimConfig = {},
  suffix?: string,
): string[] {
  const base = (idea || "").trim();
  const sfx = (suffix || "").trim();
  const out: string[] = [];
  const seen = new Set<string>();

  const dimStyle   = dims.style   ?? { on: true };
  const dimLight   = dims.lighting?? { on: true };
  const dimMood    = dims.mood    ?? { on: true };
  const dimPalette = dims.palette ?? { on: false };
  const dimLens    = dims.lens    ?? { on: true };

  for (let i = 0; i < count; i++) {
    const parts = [base];

    if (dimStyle.on)   parts.push(dimStyle.locked   || pick(DIM_POOLS.style,   i, 1));
    if (dimLight.on)   parts.push(dimLight.locked   || pick(DIM_POOLS.lighting, i, 3));
    if (dimMood.on)    parts.push(dimMood.locked    || pick(DIM_POOLS.mood,     i, 5));
    if (dimPalette.on) parts.push(dimPalette.locked || pick(DIM_POOLS.palette,  i, 3));
    if (dimLens.on)    parts.push(dimLens.locked    || pick(DIM_POOLS.lens,     i, 2));

    if (sfx) parts.push(sfx);

    let p = parts.join(", ");
    if (seen.has(p)) p += `, variation ${i + 1}`;
    seen.add(p);
    out.push(p);
  }
  return out;
}
