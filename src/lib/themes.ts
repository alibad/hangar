// The palettes offered in the theme picker. Each one is an AI product's brand
// reduced to four semantic roles. The actual color ramps are generated from
// these same source colors by scripts/gen-themes.mjs into src/app/themes.css —
// the hexes here are only used to draw the picker's swatches, so if you change
// a palette, change it in both places and re-run the generator.

export type ThemeId =
  | "claude" | "hangar" | "openai" | "gemini" | "grok"
  | "mistral" | "stability" | "perplexity" | "huggingface" | "nvidia";

export type ThemeMeta = {
  id: ThemeId;
  name: string;
  source: string;
  accent: string;
  ok: string;
  warn: string;
  err: string;
  canvas: string;
};

export const DEFAULT_THEME: ThemeId = "claude";

export const THEMES: ThemeMeta[] = [
  { id: "claude",      name: "Claude clay",       source: "Anthropic",     accent: "#D97757", ok: "#6FA86B", warn: "#E0A54A", err: "#C85A4E", canvas: "#1A1917" },
  { id: "hangar",      name: "Hangar native",      source: "Your logo",     accent: "#4E60C8", ok: "#34D399", warn: "#FBBF24", err: "#F87171", canvas: "#0F0F1A" },
  { id: "openai",      name: "OpenAI mono",       source: "ChatGPT",       accent: "#10A37F", ok: "#10A37F", warn: "#E5A00D", err: "#EF4146", canvas: "#0D0D0D" },
  { id: "gemini",      name: "Gemini spectrum",   source: "Google",        accent: "#4285F4", ok: "#34A853", warn: "#FBBC04", err: "#EA4335", canvas: "#131314" },
  { id: "grok",        name: "Grok void",         source: "xAI",           accent: "#8E8E93", ok: "#00D26A", warn: "#FFB800", err: "#FF3B30", canvas: "#000000" },
  { id: "mistral",     name: "Mistral flame",     source: "Mistral AI",    accent: "#FF7000", ok: "#A3E635", warn: "#FFD800", err: "#FF4B4B", canvas: "#0C0C0C" },
  { id: "stability",   name: "Stability magenta", source: "Stability AI",  accent: "#D946EF", ok: "#2DD4A7", warn: "#FBBF24", err: "#FB5E5E", canvas: "#0D0A10" },
  { id: "perplexity",  name: "Perplexity cyan",   source: "Perplexity",    accent: "#20B8CD", ok: "#3FB950", warn: "#D29922", err: "#F0664F", canvas: "#091717" },
  { id: "huggingface", name: "Hugging Face sun",  source: "Hugging Face",  accent: "#FFD21E", ok: "#6EE7A8", warn: "#FF9D00", err: "#FF6B6B", canvas: "#0B0B0F" },
  { id: "nvidia",      name: "NVIDIA rig",        source: "GPU-native",    accent: "#76B900", ok: "#76B900", warn: "#FFC107", err: "#FF4757", canvas: "#0A0A0A" },
];

export const THEME_IDS = THEMES.map(t => t.id);

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as string[]).includes(v);
}
