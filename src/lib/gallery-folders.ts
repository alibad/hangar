/**
 * The Image Studio's folder sidebar as a tree: order, counts, what is shown.
 *
 * Folders arrive as flat paths ("RTS AI/china/r2qilin"). Three things went wrong
 * rendering them straight:
 * - Plain string order puts "3d-bench" before "3d/<job>" ('-' sorts before '/'),
 *   so another folder's children appeared to belong to it.
 * - A parent counted only its own images, so a folder full of subfolders read 0.
 * - Every directory showed, however empty, and none could be collapsed.
 *
 * Pure and dependency-free, so scripts/gallery-folders.test.mjs loads it as is.
 */

/**
 * Top-level folders under the gallery's root that belong to another lab: the
 * 3D Lab's per-job folders (MESH_ROOT in mesh3d-shared.ts: source and cutout
 * PNGs beside meshes) and the Video Lab's clips and frames (videoRoot() in
 * video-jobs.ts). Neither is a gallery. Listing them filled the sidebar with
 * "0" folders whose delete would remove a lab's jobs, and a disk rescan would
 * have imported their PNGs as gallery images. Kept literal so this module
 * stays import-free; the test checks it against MESH_ROOT.
 */
export const LAB_STORAGE_ROOTS: readonly string[] = ["3d", "video"];

/** True for a gallery-relative path inside another lab's storage. */
export function isLabStorage(rel: string): boolean {
  return LAB_STORAGE_ROOTS.includes(rel.split("/")[0]);
}

export type FolderRow = {
  path: string;
  name: string;
  depth: number;
  /** Images in this folder and every folder below it. */
  count: number;
  /** Has at least one child that is itself shown. */
  hasChildren: boolean;
  expanded: boolean;
  /** Image files on disk here (and below) that the gallery has no row for yet: a rescan adds them. */
  unindexed: number;
};

function segments(p: string): string[] {
  return p.split("/");
}

/** Parent before children, siblings by name (natural order, case-insensitive). */
export function treeOrder(folders: string[]): string[] {
  return [...new Set(folders)].sort((a, b) => {
    const sa = segments(a);
    const sb = segments(b);
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
      const c = sa[i].localeCompare(sb[i], undefined, { numeric: true, sensitivity: "base" });
      if (c !== 0) return c;
    }
    return sa.length - sb.length;
  });
}

/** Every proper ancestor of a folder path, outermost first. */
export function ancestors(folder: string): string[] {
  const s = segments(folder);
  return s.slice(0, -1).map((_, i) => s.slice(0, i + 1).join("/"));
}

/** An image whose folder is `folder` or anywhere beneath it. */
export function inFolder(imageFolder: string, folder: string): boolean {
  return imageFolder === folder || imageFolder.startsWith(folder + "/");
}

/** Images per folder including everything beneath it, from per-folder direct counts. */
export function subtreeCounts(folders: string[], direct: Map<string, number>): Map<string, number> {
  const total = new Map<string, number>();
  for (const f of folders) total.set(f, 0);
  for (const [folder, n] of direct) {
    if (!folder) continue;
    for (const f of [...ancestors(folder), folder]) total.set(f, (total.get(f) ?? 0) + n);
  }
  return total;
}

/**
 * The rows the sidebar renders.
 * - `direct` is the gallery's own rows per folder; `onDisk`, when given, is the
 *   image files actually in each directory. A folder counts as empty only when
 *   both are zero beneath it: images written straight to disk (not through
 *   the gallery) are real, just not indexed yet.
 * - An empty folder is hidden unless `showEmpty`, or it is in `keep` (the
 *   selected folder, one created this session).
 * - A folder is listed only when every ancestor is expanded. The ancestors of
 *   anything in `keep` count as expanded, so the selection is never buried.
 */
export function folderRows(opts: {
  folders: string[];
  direct: Map<string, number>;
  onDisk?: Map<string, number>;
  expanded: Set<string>;
  showEmpty: boolean;
  keep?: Iterable<string>;
}): { rows: FolderRow[]; hiddenEmpty: number } {
  const ordered = treeOrder([...opts.folders, ...[...(opts.keep ?? [])].filter(Boolean)]);
  const counts = subtreeCounts(ordered, opts.direct);
  const disk = subtreeCounts(ordered, opts.onDisk ?? new Map());
  const keep = new Set([...(opts.keep ?? [])].filter(Boolean));
  const keepAncestors = new Set([...keep].flatMap(ancestors));
  const hasImages = (f: string) => (counts.get(f) ?? 0) > 0 || (disk.get(f) ?? 0) > 0;
  const isShown = (f: string) => opts.showEmpty || hasImages(f) || keep.has(f) || keepAncestors.has(f);
  const isExpanded = (f: string) => opts.expanded.has(f) || keepAncestors.has(f);

  const shown = ordered.filter(isShown);
  const shownSet = new Set(shown);
  const withChildren = new Set(shown.flatMap((f) => ancestors(f).slice(-1)));
  const rows: FolderRow[] = [];
  for (const f of shown) {
    if (!ancestors(f).every((a) => shownSet.has(a) && isExpanded(a))) continue;
    rows.push({
      path: f,
      name: f.slice(f.lastIndexOf("/") + 1),
      depth: segments(f).length - 1,
      count: counts.get(f) ?? 0,
      hasChildren: withChildren.has(f),
      expanded: isExpanded(f),
      unindexed: Math.max(0, (disk.get(f) ?? 0) - (counts.get(f) ?? 0)),
    });
  }
  return { rows, hiddenEmpty: ordered.length - shown.length };
}
