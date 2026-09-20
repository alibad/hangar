"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronRight,
  Database,
  Eye,
  File,
  Folder,
  HardDrive,
  LoaderCircle,
  MoveRight,
  Play,
  Radar,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { ToolPageHeader } from "@/components/tool-page";

type Drive = {
  root: string;
  label: string;
  kind: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  indexedBytes: number;
  fileCount: number;
  dirCount: number;
  scannedAt: string | null;
  status: "never" | "scanning" | "ready" | "error";
  dirty: boolean;
  watching: boolean;
  lastError: string | null;
};

type IndexedItem = {
  path: string;
  root: string;
  parent: string;
  name: string;
  kind: "file" | "folder";
  extension?: string;
  ext?: string;
  size: number;
  fileCount?: number;
  dirCount?: number;
  modifiedAt?: number;
  mtime_ms?: number;
};

type Overview = {
  drives: Drive[];
  scan: {
    state: "idle" | "scanning" | "complete" | "error";
    root?: string;
    files?: number;
    folders?: number;
    bytes?: number;
    errors?: number;
    currentPath?: string;
    startedAt?: string;
    error?: string;
  };
  watchers: Record<string, { pid?: number; state?: string; alive?: boolean; updatedAt?: string }>;
  topFolders: Array<Record<string, unknown>>;
  largestFiles: Array<Record<string, unknown>>;
  recentChanges: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  summaries: Record<string, { status: string; pid?: number; updated_at?: string; error?: string | null }>;
  duplicateCandidates: Array<Record<string, unknown>>;
  scanErrors: Array<Record<string, unknown>>;
};

const EMPTY_OVERVIEW: Overview = {
  drives: [],
  scan: { state: "idle" },
  watchers: {},
  topFolders: [],
  largestFiles: [],
  recentChanges: [],
  operations: [],
  categories: [],
  summaries: {},
  duplicateCandidates: [],
  scanErrors: [],
};

const CATEGORY_COLORS: Record<string, string> = {
  "AI models": "bg-violet-500",
  Video: "bg-pink-500",
  Images: "bg-sky-500",
  Archives: "bg-amber-500",
  Audio: "bg-emerald-500",
  Code: "bg-blue-500",
  Documents: "bg-orange-500",
  Applications: "bg-red-500",
  Other: "bg-gray-500",
};

function formatBytes(value: number, precision = 1) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : precision)} ${units[index]}`;
}

function relativeTime(value: string | number | null | undefined) {
  if (!value) return "never";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function driveBadge(drive: Drive) {
  if (/^[a-z]:\\/i.test(drive.root)) return drive.root.slice(0, 2).toUpperCase();
  if (drive.root === "/") return "HD";
  return (drive.label || drive.root).slice(0, 2).toUpperCase();
}

function storageName(value: unknown) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || String(value || "");
}

function storageParent(value: unknown) {
  const path = String(value || "");
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator < 0) return "";
  if (separator === 0) return "/";
  if (/^[a-z]:\\/i.test(path) && separator === 2) return path.slice(0, 3);
  return path.slice(0, separator);
}

function itemFromRow(row: Record<string, unknown>, kind: "file" | "folder"): IndexedItem {
  return {
    path: String(row.path || ""),
    root: String(row.root || ""),
    parent: String(row.parent || ""),
    name: String(row.name || ""),
    kind,
    extension: String(row.ext || ""),
    size: Number(row.size || 0),
    fileCount: Number(row.file_count || (kind === "file" ? 1 : 0)),
    dirCount: Number(row.dir_count || 0),
    modifiedAt: Number(row.mtime_ms || 0),
  };
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function Modal({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("button, input")?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !ref.current) return;
      const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="storage-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="storage-dialog-title" aria-describedby="storage-dialog-description" className="storage-modal">
        <div className="storage-modal-header">
          <div><h2 id="storage-dialog-title">{title}</h2><p id="storage-dialog-description">{description}</p></div>
          <button type="button" onClick={onClose} aria-label={`Close ${title}`}><X className="h-4 w-4" /></button>
        </div>
        <div className="storage-modal-body">{children}</div>
      </div>
    </div>
  );
}

export default function StorageManager() {
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeDrive, setActiveDrive] = useState<string>("");
  const [mode, setMode] = useState<"overview" | "explorer" | "changes" | "duplicates">("overview");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [currentParent, setCurrentParent] = useState<string | null>(null);
  const [items, setItems] = useState<IndexedItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [duplicateCandidates, setDuplicateCandidates] = useState<Array<Record<string, unknown>>>([]);
  const [loadingDuplicates, setLoadingDuplicates] = useState(false);
  const [selected, setSelected] = useState<IndexedItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<IndexedItem | null>(null);
  const [destination, setDestination] = useState("");
  const [conflict, setConflict] = useState<"error" | "rename">("error");
  const [categoryDetail, setCategoryDetail] = useState<{ name: string; size: number; files: number } | null>(null);
  const [categoryFiles, setCategoryFiles] = useState<IndexedItem[]>([]);
  const [loadingCategory, setLoadingCategory] = useState(false);

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await jsonRequest("/api/storage");
      setOverview(data);
      setError(null);
      setActiveDrive((current) => current || data.drives.find((drive: Drive) => drive.scannedAt)?.root || data.drives[0]?.root || "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const browse = useCallback(async (target: string) => {
    setBusy("browse");
    try {
      const data = await jsonRequest(`/api/storage?view=browse&path=${encodeURIComponent(target)}`);
      setCurrentPath(data.path);
      setCurrentParent(typeof data.parent === "string" ? data.parent : null);
      setItems(Array.isArray(data.items) ? data.items : []);
      setSelected(null);
      setMode("explorer");
      setError(null);
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : String(browseError));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => {
    const interval = window.setInterval(() => void loadOverview(true), overview.scan.state === "scanning" ? 1200 : 5000);
    return () => window.clearInterval(interval);
  }, [loadOverview, overview.scan.state]);
  useEffect(() => {
    if (mode !== "duplicates" || !activeDrive) return;
    let cancelled = false;
    setLoadingDuplicates(true);
    void jsonRequest(`/api/storage?view=duplicates&root=${encodeURIComponent(activeDrive)}`)
      .then((data) => { if (!cancelled) setDuplicateCandidates(Array.isArray(data.items) ? data.items : []); })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError)); })
      .finally(() => { if (!cancelled) setLoadingDuplicates(false); });
    return () => { cancelled = true; };
  }, [mode, activeDrive]);

  const active = overview.drives.find((drive) => drive.root === activeDrive) || overview.drives[0];
  const physicalDrives = overview.drives.filter((drive) => drive.kind !== "network");
  const totalUsed = physicalDrives.reduce((sum, drive) => sum + drive.usedBytes, 0);
  const totalCapacity = physicalDrives.reduce((sum, drive) => sum + drive.totalBytes, 0);
  const indexedTotal = overview.drives.reduce((sum, drive) => sum + drive.indexedBytes, 0);
  const topFolders = useMemo(() => overview.topFolders.map((row) => itemFromRow(row, "folder")).filter((item) => !activeDrive || item.root === activeDrive).slice(0, 12), [overview.topFolders, activeDrive]);
  const largestFiles = useMemo(() => overview.largestFiles.map((row) => itemFromRow(row, "file")).filter((item) => !activeDrive || item.root === activeDrive).slice(0, 20), [overview.largestFiles, activeDrive]);
  const categories = useMemo(() => overview.categories.filter((row) => !activeDrive || String(row.root) === activeDrive).map((row) => ({ name: String(row.category || "Other"), size: Number(row.size || 0), files: Number(row.files || 0) })), [overview.categories, activeDrive]);
  const categoryTotal = categories.reduce((sum, category) => sum + category.size, 0);
  const summaryState = activeDrive ? overview.summaries[activeDrive] : undefined;

  async function action(name: string, body: Record<string, unknown>) {
    setBusy(name);
    try {
      await jsonRequest("/api/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (name === "scan" && typeof body.root === "string") {
        setOverview((current) => ({ ...current, scan: { state: "scanning", root: body.root as string, files: 0, folders: 0, bytes: 0, errors: 0, currentPath: body.root as string } }));
      }
      await loadOverview(true);
      setError(null);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    if (searchQuery.trim().length < 2) return;
    setSearching(true);
    try {
      const data = await jsonRequest(`/api/storage?view=search&q=${encodeURIComponent(searchQuery)}${activeDrive ? `&root=${encodeURIComponent(activeDrive)}` : ""}`);
      setItems(Array.isArray(data.items) ? data.items : []);
      setCurrentPath(`Search: ${searchQuery}`);
      setCurrentParent(null);
      setSelected(null);
      setMode("explorer");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setSearching(false);
    }
  }

  async function openCategory(category: { name: string; size: number; files: number }) {
    if (!activeDrive) return;
    setCategoryDetail(category);
    setCategoryFiles([]);
    setLoadingCategory(true);
    try {
      const data = await jsonRequest(`/api/storage?view=category&root=${encodeURIComponent(activeDrive)}&category=${encodeURIComponent(category.name)}`);
      setCategoryFiles(Array.isArray(data.items) ? data.items : []);
    } catch (categoryError) {
      setError(categoryError instanceof Error ? categoryError.message : String(categoryError));
    } finally {
      setLoadingCategory(false);
    }
  }

  function goBackFromExplorer() {
    if (currentParent) {
      void browse(currentParent);
      return;
    }
    setSelected(null);
    setMode("overview");
  }

  async function submitMove() {
    if (!moveTarget || !destination.trim()) return;
    await action("move", { action: "move", source: moveTarget.path, destinationDirectory: destination.trim(), conflict });
    setMoveTarget(null);
    setSelected(null);
  }

  return (
    <div className="tool-page storage-page">
      <ToolPageHeader
        eyebrow="Local operations"
        title="Storage Manager"
        description="Map every drive, cache the index locally, watch filesystem changes, and reorganize files without sending metadata to an AI model."
        icon={<HardDrive className="h-5 w-5" />}
        meta={<span className="tool-page-chip is-ready"><ShieldCheck className="h-3 w-3" /> Zero-token analysis</span>}
        actions={<button type="button" onClick={() => void loadOverview()} disabled={loading} className="storage-button"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button>}
      />

      {error && <div className="storage-alert" role="alert"><AlertTriangle className="h-4 w-4" /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X className="h-3.5 w-3.5" /></button></div>}

      <section className="storage-kpis" aria-label="Storage summary">
        <div><span>Physical usage</span><strong>{formatBytes(totalUsed)}</strong><small>{formatBytes(Math.max(0, totalCapacity - totalUsed))} free</small></div>
        <div><span>Indexed metadata</span><strong>{formatBytes(indexedTotal)}</strong><small>{overview.drives.reduce((sum, drive) => sum + drive.fileCount, 0).toLocaleString()} files understood</small></div>
        <div><span>Change stream</span><strong>{overview.recentChanges.length.toLocaleString()}</strong><small>{Object.values(overview.watchers).filter((watcher) => watcher.alive).length} drives listening</small></div>
        <div><span>Potential duplicates</span><strong>{duplicateCandidates.length || "—"}</strong><small>open Duplicates to analyze</small></div>
      </section>

      <section className="storage-drive-strip" aria-label="Drives">
        {overview.drives.map((drive) => {
          const usedPercent = drive.totalBytes ? Math.min(100, drive.usedBytes / drive.totalBytes * 100) : 0;
          const isScanning = overview.scan.state === "scanning" && overview.scan.root === drive.root;
          const watcher = overview.watchers[drive.root];
          return (
            <article key={drive.root} className={`storage-drive-card ${activeDrive === drive.root ? "is-active" : ""}`} onClick={() => setActiveDrive(drive.root)}>
              <button type="button" className="storage-drive-main" onClick={() => { setActiveDrive(drive.root); if (drive.scannedAt) void browse(drive.root); }}>
                <span className="storage-drive-letter">{driveBadge(drive)}</span>
                <span className="min-w-0 flex-1 text-left"><strong>{drive.label || drive.root}</strong><small>{formatBytes(drive.usedBytes)} of {formatBytes(drive.totalBytes)}</small></span>
                <span className="tabular-nums">{usedPercent.toFixed(0)}%</span>
              </button>
              <div className="storage-capacity-track"><span style={{ width: `${usedPercent}%` }} /></div>
              <div className="storage-drive-meta">
                <span>{drive.scannedAt ? `indexed ${relativeTime(drive.scannedAt)}` : "not indexed"}{drive.dirty ? " · changes pending" : ""}</span>
                <span>{drive.fileCount.toLocaleString()} files</span>
              </div>
              <div className="storage-drive-actions">
                <button type="button" disabled={Boolean(busy) || isScanning} onClick={(event) => { event.stopPropagation(); void action("scan", { action: "scan", root: drive.root }); }}>
                  {isScanning ? <LoaderCircle className="animate-spin" /> : <Play />} {drive.scannedAt ? "Rescan" : "Scan drive"}
                </button>
                <button type="button" disabled={Boolean(busy) || !drive.scannedAt} onClick={(event) => { event.stopPropagation(); void action("watch", { action: "watch", root: drive.root, enabled: !watcher?.alive }); }}>
                  {watcher?.alive ? <Square /> : <Radar />} {watcher?.alive ? "Stop watching" : "Watch changes"}
                </button>
              </div>
            </article>
          );
        })}
        {!loading && overview.drives.length === 0 && <div className="storage-empty">No local drives were discovered.</div>}
      </section>

      {overview.scan.state === "scanning" && (
        <section className="storage-scan-progress" aria-live="polite">
          <LoaderCircle className="h-5 w-5 animate-spin" />
          <div className="min-w-0 flex-1"><strong>Scanning {overview.scan.root}</strong><p className="truncate">{overview.scan.currentPath}</p></div>
          <div><strong>{(overview.scan.files || 0).toLocaleString()}</strong><span>files</span></div>
          <div><strong>{formatBytes(overview.scan.bytes || 0)}</strong><span>indexed</span></div>
          <div><strong>{(overview.scan.errors || 0).toLocaleString()}</strong><span>skipped</span></div>
          <button type="button" className="storage-button" disabled={busy === "cancel-scan"} onClick={() => void action("cancel-scan", { action: "cancel-scan" })}><Square className="h-3 w-3" /> Stop</button>
        </section>
      )}

      <nav className="storage-tabs" aria-label="Storage Manager views">
        {(["overview", "explorer", "changes", "duplicates"] as const).map((tab) => (
          <button key={tab} type="button" aria-current={mode === tab ? "page" : undefined} onClick={() => { setMode(tab); if (tab === "explorer" && active?.scannedAt) void browse(currentPath && !currentPath.startsWith("Search:") ? currentPath : active.root); }}>
            {tab === "overview" ? "Space map" : tab === "explorer" ? "Files" : tab === "changes" ? "Changes" : "Duplicates"}
          </button>
        ))}
      </nav>

      {mode === "overview" && (
        <div className="storage-overview-grid">
          <section className="storage-panel storage-space-map">
            <div className="storage-panel-heading"><div><p>Indexed composition</p><h2>Where the space goes</h2></div><span>{active?.scannedAt ? `${formatBytes(active.indexedBytes)} indexed` : "scan a drive to begin"}</span></div>
            {categories.length ? (
              <>
                <div className="storage-category-bar" aria-label="Storage categories">
                  {categories.map((category) => <button type="button" key={category.name} aria-label={`Open ${category.name} details`} onClick={() => void openCategory(category)} className={CATEGORY_COLORS[category.name] || CATEGORY_COLORS.Other} style={{ width: `${Math.max(1.5, categoryTotal ? category.size / categoryTotal * 100 : 0)}%` }} title={`${category.name}: ${formatBytes(category.size)}`} />)}
                </div>
                <div className="storage-category-grid">
                  {categories.map((category) => (
                    <button type="button" key={category.name} onClick={() => void openCategory(category)} aria-label={`Open ${category.name} details`}><span className={`storage-category-dot ${CATEGORY_COLORS[category.name] || CATEGORY_COLORS.Other}`} /><p>{category.name}</p><strong>{formatBytes(category.size)}</strong><small>{category.files.toLocaleString()} files</small></button>
                  ))}
                </div>
              </>
            ) : active?.scannedAt && ["starting", "running"].includes(summaryState?.status || "") ? (
              <div className="storage-empty" aria-live="polite"><LoaderCircle className="h-6 w-6 animate-spin" /><strong>Building cached space map…</strong><span>This older index is being upgraded locally. You can keep using the console while it finishes.</span></div>
            ) : active?.scannedAt && summaryState?.status === "error" ? (
              <div className="storage-empty"><AlertTriangle className="h-6 w-6" /><strong>Space map migration failed</strong><span>{summaryState.error || "Rescan this drive to rebuild its cached composition."}</span></div>
            ) : active?.scannedAt ? (
              <div className="storage-empty"><Database className="h-6 w-6" /><strong>No categorized files found</strong><span>Rescan this drive to rebuild its cached composition.</span></div>
            ) : <div className="storage-empty"><Database className="h-6 w-6" /><strong>No cached analysis yet</strong><span>Choose a drive and start its first scan. The worker runs locally and can continue while you use the rest of the console.</span></div>}
          </section>

          <section className="storage-panel">
            <div className="storage-panel-heading"><div><p>Largest folders</p><h2>Best cleanup targets</h2></div>{active?.scannedAt && <button type="button" onClick={() => void browse(active.root)}>Browse drive <ChevronRight /></button>}</div>
            <div className="storage-ranking">
              {topFolders.map((folder) => {
                const max = topFolders[0]?.size || 1;
                return <button key={folder.path} type="button" onClick={() => void browse(folder.path)}><span className="storage-rank-icon"><Folder /></span><span className="min-w-0 flex-1"><strong title={folder.path}>{folder.name}</strong><small>{folder.path}</small><span className="storage-rank-track"><i style={{ width: `${Math.max(2, folder.size / max * 100)}%` }} /></span></span><b>{formatBytes(folder.size)}</b></button>;
              })}
              {active?.scannedAt && topFolders.length === 0 && <div className="storage-empty">No indexed folders found for this drive.</div>}
            </div>
          </section>

          <section className="storage-panel storage-largest-files">
            <div className="storage-panel-heading"><div><p>Largest files</p><h2>Heavy individual items</h2></div></div>
            <div className="storage-file-list">
              {largestFiles.slice(0, 10).map((file) => <button key={file.path} type="button" onClick={() => { setSelected(file); setMode("explorer"); setItems(largestFiles); setCurrentPath("Largest files"); }}><File /><span><strong>{file.name}</strong><small>{file.parent}</small></span><b>{formatBytes(file.size)}</b></button>)}
            </div>
          </section>

          <section className="storage-panel storage-safety-panel">
            <div className="storage-panel-heading"><div><p>Safety model</p><h2>Local and guarded</h2></div></div>
            <ul>
              <li><Check /> Metadata stays in the local SQLite cache.</li>
              <li><Check /> No prompts, embeddings, or AI model calls.</li>
              <li><Check /> Operating-system and application directories are move-protected.</li>
              <li><Check /> Cross-drive moves copy before source removal.</li>
              <li><Check /> Conflicts stop by default; renaming is opt-in.</li>
            </ul>
          </section>
        </div>
      )}

      {mode === "explorer" && (
        <section className="storage-panel storage-explorer">
          <div className="storage-explorer-toolbar">
            <button type="button" className="storage-icon-button" disabled={!currentPath && !active?.scannedAt} onClick={goBackFromExplorer} aria-label={currentParent ? "Open parent folder" : "Back to space map"}><ArrowLeft /></button>
            <div className="storage-path"><HardDrive /><span>{currentPath || activeDrive || "Choose a drive"}</span></div>
            <form onSubmit={(event) => { event.preventDefault(); void search(); }} className="storage-search"><Search /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search cached names…" aria-label="Search indexed files and folders" /><button type="submit" disabled={searching || searchQuery.trim().length < 2}>{searching ? <LoaderCircle className="animate-spin" /> : "Search"}</button></form>
          </div>
          <div className="storage-explorer-grid">
            <div className="storage-table-wrap">
              <table className="storage-table">
                <thead><tr><th>Name</th><th>Size</th><th>Contents</th><th>Modified</th></tr></thead>
                <tbody>
                  {items.map((item) => <tr key={item.path} className={selected?.path === item.path ? "is-selected" : ""} onClick={() => setSelected(item)} onDoubleClick={() => { if (item.kind === "folder") void browse(item.path); }}><td><span className="storage-name-cell">{item.kind === "folder" ? <Folder /> : <File />}<span><strong>{item.name}</strong><small>{item.path}</small></span></span></td><td>{formatBytes(item.size)}</td><td>{item.kind === "folder" ? `${(item.fileCount || 0).toLocaleString()} files · ${(item.dirCount || 0).toLocaleString()} folders` : item.extension || item.ext || "file"}</td><td>{relativeTime(item.modifiedAt || item.mtime_ms)}</td></tr>)}
                </tbody>
              </table>
              {!busy && items.length === 0 && <div className="storage-empty"><Folder className="h-6 w-6" /><strong>No cached items here</strong><span>Scan this drive first, or try another folder.</span></div>}
            </div>
            <aside className="storage-inspector" aria-label="Selected item">
              {selected ? <><span className="storage-inspector-icon">{selected.kind === "folder" ? <Folder /> : <File />}</span><p>{selected.kind}</p><h3>{selected.name}</h3><code>{selected.path}</code><dl><div><dt>Size</dt><dd>{formatBytes(selected.size, 2)}</dd></div>{selected.kind === "folder" && <><div><dt>Files</dt><dd>{(selected.fileCount || 0).toLocaleString()}</dd></div><div><dt>Folders</dt><dd>{(selected.dirCount || 0).toLocaleString()}</dd></div></>}<div><dt>Modified</dt><dd>{relativeTime(selected.modifiedAt || selected.mtime_ms)}</dd></div></dl><button type="button" onClick={() => void action("reveal", { action: "reveal", path: selected.path })}><Eye /> Reveal in file manager</button><button type="button" className="is-primary" onClick={() => { setMoveTarget(selected); setDestination(selected.parent || selected.root); }}><MoveRight /> Move item…</button></> : <div className="storage-empty"><Search className="h-6 w-6" /><strong>Select an item</strong><span>Inspect its exact path and size, reveal it, or prepare a guarded move.</span></div>}
            </aside>
          </div>
        </section>
      )}

      {mode === "changes" && (
        <section className="storage-panel">
          <div className="storage-panel-heading"><div><p>Filesystem listener</p><h2>Recent changes</h2></div><span>Newest first · retained locally</span></div>
          <div className="storage-change-list">
            {overview.recentChanges.map((row) => <div key={String(row.id)}><span className={`storage-change-kind is-${String(row.event)}`}>{String(row.event)}</span><span><strong>{storageName(row.path)}</strong><small>{String(row.path)}</small></span><b>{row.new_size != null ? formatBytes(Number(row.new_size)) : row.old_size != null ? `was ${formatBytes(Number(row.old_size))}` : "folder"}</b><time>{relativeTime(String(row.observed_at))}</time></div>)}
            {overview.recentChanges.length === 0 && <div className="storage-empty"><Activity className="h-6 w-6" /><strong>No captured changes</strong><span>Index a drive, then turn on Watch changes to begin the local activity stream.</span></div>}
          </div>
        </section>
      )}

      {mode === "duplicates" && (
        <section className="storage-panel">
          <div className="storage-panel-heading"><div><p>Cleanup candidates</p><h2>Potential duplicate groups</h2></div><span>Same byte size · not auto-deleted</span></div>
          <p className="storage-note"><AlertTriangle /> These are fast metadata candidates, not content-hash proof. Review them before moving or deleting anything.</p>
          <div className="storage-duplicate-list">
            {duplicateCandidates.map((row, index) => { const paths = String(row.paths || "").split("\n").filter(Boolean); return <details key={`${row.size}-${index}`}><summary><span><strong>{Number(row.files).toLocaleString()} files</strong><small>{formatBytes(Number(row.size))} each</small></span><b>{formatBytes(Number(row.size) * (Number(row.files) - 1))} potentially recoverable</b><ChevronRight /></summary><div>{paths.map((itemPath) => <button key={itemPath} type="button" onClick={() => { const item = largestFiles.find((file) => file.path === itemPath) || { path: itemPath, root: activeDrive, parent: storageParent(itemPath), name: storageName(itemPath), kind: "file" as const, size: Number(row.size) }; setItems([item]); setSelected(item); setCurrentPath("Duplicate candidates"); setMode("explorer"); }}><File /><span>{itemPath}</span></button>)}</div></details>; })}
            {loadingDuplicates && <div className="storage-empty"><LoaderCircle className="animate-spin" /> Finding same-size candidates…</div>}
            {!loadingDuplicates && duplicateCandidates.length === 0 && <div className="storage-empty">No same-size candidates over 10 MB in the current cache.</div>}
          </div>
        </section>
      )}

      {categoryDetail && (
        <Modal title={`${categoryDetail.name} files`} description={`Largest indexed ${categoryDetail.name.toLowerCase()} files on ${activeDrive}. Nothing is moved or deleted from this view.`} onClose={() => setCategoryDetail(null)}>
          <div className="storage-category-detail-summary">
            <div><span>Category size</span><strong>{formatBytes(categoryDetail.size)}</strong></div>
            <div><span>Drive share</span><strong>{categoryTotal ? `${(categoryDetail.size / categoryTotal * 100).toFixed(1)}%` : "0%"}</strong></div>
            <div><span>Indexed files</span><strong>{categoryDetail.files.toLocaleString()}</strong></div>
          </div>
          <div className="storage-category-detail-list">
            {categoryFiles.slice(0, 30).map((file) => <button type="button" key={file.path} onClick={() => { setItems(categoryFiles); setSelected(file); setCurrentPath(`${categoryDetail.name} files`); setMode("explorer"); setCategoryDetail(null); }}><File /><span><strong>{file.name}</strong><small>{file.parent}</small></span><b>{formatBytes(file.size)}</b><ChevronRight /></button>)}
            {loadingCategory && <div className="storage-empty"><LoaderCircle className="h-5 w-5 animate-spin" /><strong>Loading largest files…</strong></div>}
            {!loadingCategory && categoryFiles.length === 0 && <div className="storage-empty">No indexed files were found in this category.</div>}
          </div>
        </Modal>
      )}

      {moveTarget && (
        <Modal title="Move item" description="The source is removed only after the destination succeeds. Protected system paths are blocked." onClose={() => setMoveTarget(null)}>
          <div className="storage-move-form">
            <label>Source<input value={moveTarget.path} readOnly /></label>
            <label>Destination folder<input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="/Volumes/Archive or D:\\Archive" /></label>
            <fieldset><legend>If the name already exists</legend><label><input type="radio" checked={conflict === "error"} onChange={() => setConflict("error")} /> Stop and report the conflict</label><label><input type="radio" checked={conflict === "rename"} onChange={() => setConflict("rename")} /> Keep both by adding a number</label></fieldset>
            <div className="storage-move-summary"><MoveRight /><span><strong>{moveTarget.name}</strong><small>Same-volume rename when possible; cross-volume moves copy before removing the source</small></span></div>
            <div className="storage-modal-actions"><button type="button" onClick={() => setMoveTarget(null)}>Cancel</button><button type="button" className="is-primary" disabled={!destination.trim() || busy === "move"} onClick={() => void submitMove()}>{busy === "move" ? <LoaderCircle className="animate-spin" /> : <MoveRight />} Start move</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}
