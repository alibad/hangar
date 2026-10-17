import { validateAudioRecipe, type AudioEvent, type AudioRecipe } from "./audio-project";

/** Empty drafts are useful in the editor; rendering still requires real layers. */
export function emptyAudioEvent(id = "workspace", label = "Untitled sound"): AudioEvent {
  return { id, label, kind: "effect", currentUrl: null, recipe: { layers: [], length: 3.2, loop: false, notes: "" } };
}

export function validAudioDraft(value: unknown): value is AudioRecipe {
  if (validateAudioRecipe(value)) return true;
  if (!value || typeof value !== "object") return false;
  const recipe = value as AudioRecipe;
  return Array.isArray(recipe.layers) && recipe.layers.length === 0 && Number.isFinite(recipe.length) && recipe.length >= .1 && recipe.length <= 60 && typeof recipe.loop === "boolean" && typeof recipe.notes === "string" && recipe.notes.length <= 4000;
}

export function restoreAudioEvents(value: unknown): AudioEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((event): event is AudioEvent => Boolean(event && typeof event.id === "string" && /^[a-z0-9-]{1,60}$/.test(event.id) && typeof event.label === "string" && event.label.trim() && event.label.length <= 160 && validAudioDraft(event.recipe))).slice(0, 100).map(event => ({ id: event.id, label: event.label.trim(), recipe: event.recipe, kind: "effect", currentUrl: null }));
}
