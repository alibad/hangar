// Thin, zero-resource prompt variation. No model, no network — just curated
// modifier pools recombined so a single idea fans out into N distinct prompts.
// Used as the default batch varier and as the fallback when the LLM is down.

const STYLES = [
  "photorealistic", "cinematic film still", "watercolor painting", "3D render, octane",
  "oil painting, thick brushwork", "anime illustration", "isometric low-poly",
  "vintage 35mm photo", "studio product photography", "concept art, matte painting",
  "pencil sketch", "pop-art, bold ink", "claymation style", "long-exposure photograph",
];
const LIGHTING = [
  "golden hour light", "soft studio softbox lighting", "moody backlight", "neon glow",
  "overcast diffused light", "dramatic chiaroscuro", "rim lighting", "candlelit warmth",
  "cool blue hour", "high-key bright lighting",
];
const MOOD = [
  "serene", "dramatic", "playful", "mysterious", "nostalgic", "energetic", "minimal", "epic",
];
const PALETTE = [
  "warm earthy tones", "cool teal and orange", "pastel palette", "monochrome",
  "vivid saturated colors", "muted desaturated tones", "rich jewel tones",
];
const LENS = [
  "wide-angle", "85mm portrait, shallow depth of field", "macro close-up",
  "aerial top-down", "fish-eye", "tilt-shift miniature", "telephoto compression",
];

function pick<T>(arr: T[], i: number, salt: number): T {
  return arr[((i * salt) % arr.length + arr.length) % arr.length];
}

/**
 * Expand `idea` into `count` varied prompts. Each index draws from the pools at
 * a different phase, so the combinations spread out and stay distinct. An
 * optional `style` hint is appended to every variation.
 */
export function varyPrompts(idea: string, count: number, style?: string): string[] {
  const base = (idea || "").trim();
  const hint = (style || "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const parts = [
      base,
      // salts are chosen coprime with each pool's length so indices cycle
      // through every option instead of repeating.
      pick(STYLES, i, 1),
      pick(LIGHTING, i, 3),
      pick(MOOD, i, 5),
      pick(PALETTE, i, 3),
      pick(LENS, i, 2),
    ].filter(Boolean);
    if (hint) parts.push(hint);
    let p = parts.join(", ");
    if (seen.has(p)) p += `, variation ${i + 1}`;
    seen.add(p);
    out.push(p);
  }
  return out;
}
