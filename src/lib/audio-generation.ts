export const EFFECTS_MODEL = "Stable Audio 3 Small SFX";
export type EffectRequest = { prompt: string; length: number; seed: number; event: string; name: string };

export function validEffectRequest(value: unknown): value is EffectRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as EffectRequest;
  return typeof v.prompt === "string" && v.prompt.trim().length > 0 && v.prompt.length <= 4000 &&
    typeof v.length === "number" && Number.isFinite(v.length) && v.length >= .1 && v.length <= 30 &&
    Number.isInteger(v.seed) && v.seed >= 0 && v.seed <= 2147483647 &&
    typeof v.event === "string" && /^[a-z0-9-]{1,60}$/.test(v.event) &&
    typeof v.name === "string" && v.name.trim().length > 0 && v.name.length <= 130;
}
