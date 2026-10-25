"use client";

/** A theme colour as #rrggbb, by painting it once on a 1×1 canvas. */
function hexOf(name: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The theme colours the embedded world and repository tools use for their labels, controls and 3D gates. */
export function mapPalette() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string) => css.getPropertyValue(name).trim();
  return {
    accent: read("--hangar-primary"), "accent-soft": read("--hangar-primary-soft"), secondary: read("--hangar-secondary"), ok: read("--ok-500"),
    panel: read("--workspace-panel"), line: read("--workspace-line"), ink: read("--workspace-ink"), muted: read("--workspace-muted"),
    // The 3D gates and selection ring need plain hex: the renderer cannot read CSS colour functions.
    door: hexOf("--accent-600"), glow: hexOf("--warn-300"), beam: hexOf("--warn-200"),
  };
}
