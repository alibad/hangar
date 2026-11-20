// A single measurement contract for the canvas, the project pane, and the map legend.
const STAGES = ["tent", "house", "midrise", "tower", "skyscraper"];
const LIMITS = {
  commits: [15, 60, 250, 1000, 10000],
  megabytes: [300, 5000, 50000, 500000, 5000000],
};
const count = new Intl.NumberFormat(undefined);
const size = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** @param {{commitCount?: number|null, sizeKB?: number|null, empty?: boolean}} repo
 * @param {"commits"|"megabytes"} by */
export function projectMeasurement(repo, by) {
  const raw = by === "commits" ? repo.commitCount : repo.sizeKB;
  // The scanner also uses zero KB for unknown remote sizes on local-only projects.
  // An observed zero commit count, or an explicitly empty repository, is a real zero.
  const value = typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    && (by === "commits" || raw > 0 || repo.empty === true) ? raw : null;
  if (value === null) return { value, stage: "house", t: 0 };
  if (!value) return { value, stage: "lot", t: 0 };
  const bands = LIMITS[by];
  const found = bands.findIndex(limit => value < limit);
  const index = found === -1 ? bands.length - 1 : found;
  const low = bands[index - 1] || 1, high = bands[index];
  const t = Math.max(0, Math.min(1, Math.log(Math.max(value, 1) / low) / Math.log(high / low)));
  return { value, stage: STAGES[index], t };
}

/** @param {{commitCount?: number|null, sizeKB?: number|null, empty?: boolean}} repo
 * @param {"commits"|"megabytes"} by */
export function projectMeasurementText(repo, by) {
  const { value } = projectMeasurement(repo, by);
  if (value === null) return by === "commits" ? "Commit count unavailable" : "Repository size unavailable";
  if (by === "commits") return `${count.format(value)} ${value === 1 ? "commit" : "commits"}`;
  return value > 0 && value < 10.24 ? "<0.01 MB" : `${size.format(value / 1024)} MB`;
}
