export type QwenCheckpointHealth = {
  up: boolean;
  model?: string;
  loaded?: boolean;
  load?: { state?: string; error?: string | null };
  edit?: { enabled: boolean; model: string; loaded: boolean };
};

/** Selection, service availability, and loaded weights are independent states. */
export function qwenCheckpointState(
  editing: boolean,
  health: QwenCheckpointHealth | null,
  loadingEdit = false,
) {
  const name = (editing ? health?.edit?.model : health?.model) || (editing ? "Qwen-Image-Edit" : "Qwen-Image");
  const loaded = !!health?.up && !!(editing ? health.edit?.loaded : health.loaded);
  let status: string;
  if (!health) status = "Checking service…";
  else if (!health.up) status = "Selected · service unavailable";
  else if (editing && health.edit?.enabled === false) status = "Editing disabled on service";
  else if (loaded) status = "Loaded · ready to run";
  else if (editing ? loadingEdit : health.load?.state === "loading") status = "Loading checkpoint…";
  else if (!editing && health.load?.state === "error") status = "Checkpoint load failed";
  else if (editing && !health.edit) status = "Edit availability unknown";
  else status = "Selected · not loaded";

  const note = !health?.up
    ? "Generate and Edit share one service. Start it to use either checkpoint; selecting a mode does not start it."
    : loaded
      ? "This checkpoint is loaded. Running the other mode unloads it and loads the other checkpoint."
      : editing && health.edit?.enabled === false
        ? "Enable editing in the service configuration before running an edit."
        : `Selecting a mode does not load its checkpoint. ${editing ? "Run Edit" : "Generate"} loads it when needed, unloading the other checkpoint first.`;
  return { name, loaded, status, note };
}
