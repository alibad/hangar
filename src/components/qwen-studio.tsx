"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ── types ───────────────────────────────────────────────────────────────────
type QwenHealth = {
  up: boolean;
  latency: number;
  statusCode?: number;
  model?: string;
  loaded?: boolean;
  mode?: string | null;
  edit?: { enabled: boolean; model: string; loaded: boolean };
  error?: string;
};

type GalleryItem = {
  rel: string;
  folder: string;
  file: string;
  url: string;
  kind: "generate" | "edit";
  favorite?: boolean;
  prompt: string;
  seed?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  latency?: number;
  inputCount?: number;
  savedAt?: string;
  bytes?: number;
};

const SIZE_PRESETS = [
  { label: "1024×1024 · 1:1", w: 1024, h: 1024 },
  { label: "1024×768 · 4:3", w: 1024, h: 768 },
  { label: "768×1024 · 3:4", w: 768, h: 1024 },
  { label: "1280×720 · 16:9", w: 1280, h: 720 },
  { label: "720×1280 · 9:16", w: 720, h: 1280 },
  { label: "1080×1350 · Portrait", w: 1080, h: 1350 },
];

// value→label maps so the shadcn Select trigger shows labels, not raw values
const SIZE_ITEMS: Record<string, string> = Object.fromEntries(SIZE_PRESETS.map((p) => [`${p.w}x${p.h}`, p.label]));
const VARY_ITEMS: Record<string, string> = {
  template: "Template (instant, no LLM)",
  ai: "AI (uses LLM)",
  seed: "Same prompt, vary seed",
};

function fmtBytes(n?: number) {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

export default function QwenStudio() {
  const [health, setHealth] = useState<QwenHealth | null>(null);
  const [mode, setMode] = useState<"generate" | "batch" | "edit">("generate");

  // disk-backed history
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(""); // null = all, "" = unfiled (default)
  const [galleryLoading, setGalleryLoading] = useState(true);
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<GalleryItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // folders UI
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: GalleryItem } | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [confirmFolderDelete, setConfirmFolderDelete] = useState<string | null>(null);
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const FAV = "__fav__"; // pseudo-folder sentinel for the Favorites view
  // marquee (rubber-band) selection
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeBaseRef = useRef<{ additive: boolean; base: Set<string> }>({ additive: false, base: new Set() });
  const gridRef = useRef<HTMLDivElement>(null);
  const [anchorRel, setAnchorRel] = useState<string | null>(null); // shift-click range anchor

  // shared params
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(24);
  const [cfg, setCfg] = useState(4.0);
  const [seed, setSeed] = useState<string>("");
  const [lockSeed, setLockSeed] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // run state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // live denoising progress from the server (step X/Y)
  const [serverProgress, setServerProgress] = useState<{ running: boolean; step: number; total: number; elapsed?: number } | null>(null);

  // edit inputs
  const [editImages, setEditImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // voice input (local Whisper)
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // batch
  const [batchCount, setBatchCount] = useState(10);
  const [batchVary, setBatchVary] = useState<"template" | "ai" | "seed">("template");
  const [batchStyle, setBatchStyle] = useState("");
  const [batchPrompts, setBatchPrompts] = useState<string[]>([]);
  const [batchPlanning, setBatchPlanning] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchDone, setBatchDone] = useState(0);
  const [batchFailed, setBatchFailed] = useState(0);
  const [batchInfo, setBatchInfo] = useState<string | null>(null);
  const [batchTimes, setBatchTimes] = useState<number[]>([]);
  const stopRef = useRef(false);

  const checkHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/qwen/health");
      setHealth(await res.json());
    } catch {
      setHealth({ up: false, latency: 0, error: "unreachable" });
    }
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const res = await fetch("/api/qwen/images");
      const data = await res.json();
      setGallery(Array.isArray(data.images) ? data.images : []);
      setFolders(Array.isArray(data.folders) ? data.folders : []);
    } catch {
      /* keep prior list */
    }
    setGalleryLoading(false);
  }, []);

  useEffect(() => {
    checkHealth();
    refreshGallery();
    const t = setInterval(checkHealth, 15000);
    return () => clearInterval(t);
  }, [checkHealth, refreshGallery]);

  // poll the server's live denoising progress while a generation is in flight
  useEffect(() => {
    if (!busy && !batchRunning) {
      setServerProgress(null);
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const d = await fetch("/api/qwen/progress").then((r) => r.json());
        if (active) setServerProgress(d);
      } catch {
        /* ignore */
      }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [busy, batchRunning]);

  // close overlays on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setConfirmDelete(null);
        setLightbox(null);
        setCtxMenu(null);
        setNewFolderOpen(false);
        setConfirmFolderDelete(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function startTimer() {
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
  }
  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
  }

  async function addFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const urls = await Promise.all(
      arr.map(
        (f) =>
          new Promise<string>((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result as string);
            r.readAsDataURL(f);
          }),
      ),
    );
    setEditImages((prev) => [...prev, ...urls]);
  }

  function resolveSeed(): number | undefined {
    if (lockSeed && seed.trim() !== "") return Math.floor(Number(seed));
    return undefined;
  }

  async function runGenerate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    startTimer();
    try {
      const res = await fetch("/api/qwen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, negative_prompt: negative, width, height, steps, cfg, seed: resolveSeed() }),
      });
      const data = await res.json();
      if (data.status === "success") {
        if (!lockSeed) setSeed(String(data.seed));
        await refreshGallery();
      } else {
        setError(data.detail ? `${data.error}: ${data.detail}` : data.error || "Generation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    stopTimer();
    setBusy(false);
  }

  async function runEdit() {
    if (!prompt.trim() || editImages.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setEditNotice(null);
    startTimer();
    try {
      const res = await fetch("/api/qwen/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, images: editImages, negative_prompt: negative, steps, cfg, seed: resolveSeed() }),
      });
      const data = await res.json();
      if (data.status === "success") {
        if (!lockSeed) setSeed(String(data.seed));
        await refreshGallery();
      } else if (data.enabled === false) {
        setEditNotice(data.message || "Image-edit is not installed yet.");
      } else {
        setError(data.detail ? `${data.error}: ${data.detail}` : data.error || "Edit failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    stopTimer();
    setBusy(false);
  }

  // Build the prompt list for a batch — template/AI variation or seed-only.
  async function computePrompts(): Promise<string[]> {
    const idea = prompt.trim();
    if (batchVary === "seed") return Array.from({ length: batchCount }, () => idea);
    const res = await fetch("/api/qwen/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, count: batchCount, style: batchStyle, mode: batchVary }),
    });
    const data = await res.json();
    if (data.fellBack) setBatchInfo("LLM unavailable — used template variations instead.");
    else if (data.mode === "ai") setBatchInfo(`AI-varied via ${data.model}.`);
    else setBatchInfo(`${(data.prompts || []).length} template variations.`);
    return Array.isArray(data.prompts) ? data.prompts : [];
  }

  async function planPrompts() {
    if (!prompt.trim() || batchPlanning) return;
    setBatchPlanning(true);
    setBatchInfo(null);
    try {
      setBatchPrompts(await computePrompts());
    } catch {
      setBatchInfo("Couldn't plan prompts.");
    }
    setBatchPlanning(false);
  }

  async function runBatch() {
    if (batchRunning || !prompt.trim()) return;
    setError(null);
    setBatchInfo(null);
    let prompts = batchPrompts.length ? batchPrompts.slice(0, batchCount) : [];
    if (prompts.length === 0) {
      setBatchPlanning(true);
      try {
        prompts = await computePrompts();
      } catch {
        /* ignore */
      }
      setBatchPlanning(false);
      setBatchPrompts(prompts);
    }
    if (prompts.length === 0) {
      setBatchInfo("No prompts to run.");
      return;
    }

    // Don't hammer a dead server with 100 doomed requests — check it's up first.
    try {
      const h = await fetch("/api/qwen/health").then((r) => r.json());
      if (!h.up) {
        setError("Qwen server (:8021) is down — start it before running a batch.");
        return;
      }
    } catch {
      setError("Couldn't reach the Qwen server — is it running on :8021?");
      return;
    }

    stopRef.current = false;
    setBatchRunning(true);
    setBatchDone(0);
    setBatchFailed(0);
    setBatchTimes([]);
    let ok = 0;
    let fail = 0;
    let consecutive = 0;
    for (let i = 0; i < prompts.length; i++) {
      if (stopRef.current) break;
      const t0 = Date.now();
      let success = false;
      try {
        const res = await fetch("/api/qwen/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompts[i], negative_prompt: negative, width, height, steps, cfg }),
        });
        const data = await res.json();
        if (data.status === "success") success = true;
        else setError(`Image ${i + 1}: ${data.error || "failed"}${data.detail ? ` — ${data.detail}` : ""}`);
      } catch (err) {
        setError(`Image ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (success) {
        ok++;
        consecutive = 0;
      } else {
        fail++;
        consecutive++;
        setBatchFailed(fail);
      }
      setBatchTimes((prev) => [...prev, (Date.now() - t0) / 1000]);
      setBatchDone(i + 1);
      await refreshGallery();
      // The server likely died mid-batch — stop instead of racking up failures.
      if (consecutive >= 3) {
        setError(`Stopped after 3 failures in a row — the Qwen server looks unreachable. ${ok} generated before it dropped.`);
        break;
      }
    }
    setBatchRunning(false);
    setBatchInfo(`Done — ${ok} generated${fail ? `, ${fail} failed` : ""}.`);
  }

  // Pull a saved image back in as an edit reference (edit needs base64).
  async function sendToEdit(item: GalleryItem) {
    try {
      const res = await fetch(item.url);
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
      setEditImages((prev) => [...prev, dataUrl]);
      setMode("edit");
      setLightbox(null);
    } catch {
      setError("Couldn't load that image into the editor.");
    }
  }

  async function doDelete(item: GalleryItem) {
    setDeleting(true);
    try {
      await fetch(`/api/qwen/images/file?rel=${encodeURIComponent(item.rel)}`, { method: "DELETE" });
      setGallery((prev) => prev.filter((g) => g.rel !== item.rel));
      if (lightbox?.rel === item.rel) setLightbox(null);
    } catch {
      setError("Delete failed.");
    }
    setDeleting(false);
    setConfirmDelete(null);
  }

  // ── folders / move ──────────────────────────────────────────────────────────
  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    const parent = selectedFolder && selectedFolder !== "" ? selectedFolder : "";
    const full = parent ? `${parent}/${name}` : name;
    try {
      const res = await fetch("/api/qwen/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", path: full }),
      });
      const data = await res.json();
      if (data.ok) {
        await refreshGallery();
        setSelectedFolder(data.path);
      } else {
        setError(data.error || "Couldn't create folder.");
      }
    } catch {
      setError("Couldn't create folder.");
    }
    setNewFolderName("");
    setNewFolderOpen(false);
  }

  async function moveItem(rel: string, toFolder: string) {
    setCtxMenu(null);
    try {
      const res = await fetch("/api/qwen/images/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel, toFolder }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else await refreshGallery();
    } catch {
      setError("Move failed.");
    }
  }

  async function toggleFavorite(item: GalleryItem) {
    const next = !item.favorite;
    // optimistic
    setGallery((prev) => prev.map((g) => (g.rel === item.rel ? { ...g, favorite: next } : g)));
    setLightbox((lb) => (lb && lb.rel === item.rel ? { ...lb, favorite: next } : lb));
    try {
      await fetch("/api/qwen/images/favorite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel: item.rel, favorite: next }),
      });
    } catch {
      setError("Couldn't update favorite.");
      setGallery((prev) => prev.map((g) => (g.rel === item.rel ? { ...g, favorite: !next } : g)));
    }
  }

  function toggleSelect(rel: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });
  }
  const clearSelection = () => setSelected(new Set());

  // Click handling on a tile: plain = open viewer, ⌘/Ctrl = toggle, Shift = range.
  function onTileClick(e: React.MouseEvent, it: GalleryItem) {
    if (e.shiftKey && anchorRel) {
      e.preventDefault();
      const a = visibleImages.findIndex((g) => g.rel === anchorRel);
      const b = visibleImages.findIndex((g) => g.rel === it.rel);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        const range = visibleImages.slice(lo, hi + 1).map((g) => g.rel);
        setSelected((prev) => new Set([...(e.metaKey || e.ctrlKey ? prev : []), ...range]));
      }
    } else if (e.metaKey || e.ctrlKey) {
      toggleSelect(it.rel);
      setAnchorRel(it.rel);
    } else {
      setLightbox(it);
    }
  }

  // Start a marquee when the drag begins on empty grid space (not on a tile).
  function onGridMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-rel]")) return; // let tiles drag/click
    e.preventDefault();
    marqueeBaseRef.current = { additive: e.shiftKey || e.metaKey || e.ctrlKey, base: new Set(selected) };
    setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }

  // Move every selected image into a folder, then refresh once.
  async function moveSelected(toFolder: string) {
    const rels = [...selected];
    for (const rel of rels) {
      try {
        await fetch("/api/qwen/images/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rel, toFolder }),
        });
      } catch {
        /* keep going */
      }
    }
    clearSelection();
    await refreshGallery();
  }

  // Drop onto a folder: if the dragged item is part of a multi-selection, move
  // the whole selection; otherwise just the one.
  function dropToFolder(target: string) {
    setDropTarget(null);
    if (!dragRel) return;
    if (selected.has(dragRel) && selected.size > 1) moveSelected(target);
    else moveItem(dragRel, target);
  }

  async function deleteFolder(folderPath: string) {
    try {
      const res = await fetch("/api/qwen/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", path: folderPath }),
      });
      const data = await res.json();
      if (data.ok) {
        if (selectedFolder === folderPath || (selectedFolder && selectedFolder.startsWith(folderPath + "/"))) setSelectedFolder(null);
        await refreshGallery();
      } else {
        setError(data.error || "Couldn't delete folder.");
      }
    } catch {
      setError("Couldn't delete folder.");
    }
    setConfirmFolderDelete(null);
  }

  // images in the selected folder (null = all, "" = unfiled/root, FAV = favorites)
  const visibleImages = useMemo(
    () =>
      selectedFolder === null
        ? gallery
        : selectedFolder === FAV
          ? gallery.filter((g) => g.favorite)
          : gallery.filter((g) => g.folder === selectedFolder),
    [gallery, selectedFolder],
  );
  const favCount = useMemo(() => gallery.filter((g) => g.favorite).length, [gallery]);
  // value→label map for the "Move to" selects (root + every folder)
  const moveItems = useMemo<Record<string, string>>(
    () => ({ __root__: "Unfiled", ...Object.fromEntries(folders.map((f) => [f, f])) }),
    [folders],
  );

  // Jump to the prev/next image in the current view from inside the lightbox.
  function navLightbox(dir: 1 | -1) {
    setLightbox((lb) => {
      if (!lb) return lb;
      const i = visibleImages.findIndex((g) => g.rel === lb.rel);
      if (i < 0) return lb;
      const j = i + dir;
      return j >= 0 && j < visibleImages.length ? visibleImages[j] : lb;
    });
  }

  // Arrow-key navigation while the lightbox is open (needs live visibleImages).
  useEffect(() => {
    if (!lightbox) return;
    function onArrow(e: KeyboardEvent) {
      if (e.key === "ArrowRight") { e.preventDefault(); navLightbox(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); navLightbox(-1); }
      else if (e.key.toLowerCase() === "f") { e.preventDefault(); if (lightbox) toggleFavorite(lightbox); }
    }
    window.addEventListener("keydown", onArrow);
    return () => window.removeEventListener("keydown", onArrow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, visibleImages]);

  // Drive the marquee: on drag, recompute which tiles the box intersects.
  useEffect(() => {
    if (!marquee) return;
    const { x0, y0 } = marquee;
    function onMove(e: MouseEvent) {
      const rx0 = Math.min(x0, e.clientX), rx1 = Math.max(x0, e.clientX);
      const ry0 = Math.min(y0, e.clientY), ry1 = Math.max(y0, e.clientY);
      setMarquee((m) => (m ? { ...m, x1: e.clientX, y1: e.clientY } : m));
      const { additive, base } = marqueeBaseRef.current;
      const hits = new Set<string>(additive ? base : []);
      gridRef.current?.querySelectorAll<HTMLElement>("[data-rel]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const rel = el.getAttribute("data-rel");
        if (rel && r.right >= rx0 && r.left <= rx1 && r.bottom >= ry0 && r.top <= ry1) hits.add(rel);
      });
      setSelected(hits);
    }
    function onUp() { setMarquee(null); }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marquee?.x0, marquee?.y0]);

  // direct image count per folder path (for the tree)
  const folderCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of gallery) m.set(g.folder, (m.get(g.folder) ?? 0) + 1);
    return m;
  }, [gallery]);

  // group the visible images by day, newest first
  const groups = useMemo(() => {
    const map = new Map<string, GalleryItem[]>();
    for (const it of visibleImages) {
      const key = it.savedAt
        ? new Date(it.savedAt).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" })
        : "Undated";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()];
  }, [visibleImages]);

  // folders the context-menu / move targets can use (everything except the item's own)
  const allFolderTargets = useMemo(() => ["", ...folders], [folders]);

  // ── voice → prompt (local Whisper) ──────────────────────────────────────────
  async function transcribe(blob: Blob) {
    setTranscribing(true);
    try {
      const form = new FormData();
      form.append("file", new File([blob], "rec.webm", { type: "audio/webm" }));
      form.append("model", "whisper-1");
      const res = await fetch("/api/qwen/transcribe", { method: "POST", body: form });
      const data = await res.json();
      const text = (data.text ?? "").trim();
      if (text) setPrompt((p) => (p.trim() ? p.trim() + " " : "") + text);
      else setError(data.error || "No speech detected.");
    } catch {
      setError("Transcription failed.");
    }
    setTranscribing(false);
  }

  async function startRec() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was denied.");
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      transcribe(new Blob(chunks, { type: "audio/webm" }));
    };
    rec.start();
    mediaRecRef.current = rec;
    setRecording(true);
    setRecMs(0);
    recTimerRef.current = setInterval(() => setRecMs((m) => m + 100), 100);
  }

  function stopRec() {
    mediaRecRef.current?.stop();
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    setRecording(false);
  }

  // Mic button, positioned inside a `relative` textarea wrapper. Records → local
  // Whisper → appends the transcript to the prompt.
  function renderMic() {
    return (
      <button
        type="button"
        onClick={recording ? stopRec : startRec}
        disabled={transcribing}
        title={recording ? "Stop & transcribe" : "Dictate with mic (local Whisper)"}
        className={`absolute top-2.5 right-2.5 h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs transition ${
          recording ? "bg-red-600 text-white animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.4)]" : "bg-gray-700/70 hover:bg-gray-600 text-gray-300"
        } disabled:opacity-50`}
      >
        {transcribing ? (
          <span>transcribing…</span>
        ) : recording ? (
          <>
            <span>⏹</span>
            <span className="tabular-nums">{(recMs / 1000).toFixed(1)}s</span>
          </>
        ) : (
          <span>🎙</span>
        )}
      </button>
    );
  }

  // Live server-side denoising progress ("step 12/24" + thin bar + elapsed).
  function renderStepProgress() {
    const p = serverProgress;
    if (!p || !p.running || !p.total) {
      return (busy || batchRunning) ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          waiting on the server (cold start / queued)…
        </div>
      ) : null;
    }
    const pct = Math.min(100, Math.round((p.step / p.total) * 100));
    // step 0 = still encoding the prompt / streaming weights (offload preamble)
    const label = p.step === 0 ? "Preparing · encoding prompt…" : `Denoising · step ${p.step}/${p.total}`;
    return (
      <div className="mt-2">
        <div className="flex items-center justify-between text-[11px] text-gray-400 mb-1">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-pink-500 animate-pulse" />
            {label}
          </span>
          <span className="tabular-nums text-gray-500">{p.elapsed != null ? `${p.elapsed}s` : ""}</span>
        </div>
        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${p.step === 0 ? "bg-yellow-500 animate-pulse w-1/4" : "bg-pink-500"}`} style={p.step === 0 ? undefined : { width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  const editAvailable = health?.edit?.enabled ?? false;
  const dotColor = !health
    ? "bg-gray-600"
    : health.up && health.loaded
      ? "bg-green-500"
      : health.up
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <div className="space-y-6">
      {/* ── HEALTH HEADER ── */}
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className={`w-2.5 h-2.5 rounded-full ${dotColor} ${health?.up && !health?.loaded ? "animate-pulse" : ""}`} />
          <span className="font-semibold text-sm">{health?.model || "Qwen-Image"}</span>
          <span className="text-xs text-gray-500">localhost:8021</span>
          {health && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full ${
                health.up && health.loaded
                  ? "bg-green-500/10 text-green-400"
                  : health.up
                    ? "bg-yellow-500/10 text-yellow-400"
                    : "bg-red-500/10 text-red-400"
              }`}
            >
              {!health.up ? "offline" : health.loaded ? `loaded · ${health.mode}` : "up · cold (loads on first run)"}
            </span>
          )}
          {health?.up && <span className="text-[11px] text-gray-500 tabular-nums">{health.latency}ms ping</span>}
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ml-auto ${
              editAvailable ? "bg-purple-500/10 text-purple-400" : "bg-gray-700/40 text-gray-500"
            }`}
            title={health?.edit?.model}
          >
            edit: {editAvailable ? (health?.edit?.loaded ? "ready" : "enabled") : "not installed"}
          </span>
          <button onClick={checkHealth} className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
            Refresh
          </button>
        </div>
        {health && !health.up && (
          <p className="text-xs text-red-400/80 mt-2">
            Server unreachable{health.error ? ` — ${health.error}` : ""}. Start it: <code className="text-gray-400">python quote-forge/server/qwen_image.py</code>
          </p>
        )}
      </section>

      {/* ── MODE TOGGLE ── */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(["generate", "batch", "edit"] as const).map((mm) => (
          <button
            key={mm}
            onClick={() => setMode(mm)}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition capitalize ${
              mode === mm ? "bg-pink-600 text-white" : "text-gray-400 hover:text-gray-100"
            }`}
          >
            {mm}
            {mm === "edit" && !editAvailable && <span className="ml-1.5 text-[10px] opacity-60">stub</span>}
          </button>
        ))}
      </div>

      {/* ── INPUT PANEL (generate / edit) ── */}
      {mode !== "batch" && (
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        {mode === "edit" && (
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Input images (one or more — Qwen blends/edits across them)</label>
            <div
              className={`rounded-xl border-2 border-dashed transition p-4 text-center cursor-pointer ${
                dragOver ? "border-pink-500 bg-pink-500/5" : "border-gray-700 hover:border-gray-500"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileRef.current?.click()}
            >
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
              {editImages.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">Drop images or click to upload</p>
              ) : (
                <div className="flex flex-wrap gap-2 justify-center" onClick={(e) => e.stopPropagation()}>
                  {editImages.map((img, i) => (
                    <div key={i} className="relative group">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img} alt={`input ${i + 1}`} className="h-20 w-20 object-cover rounded-lg border border-gray-700" />
                      <button
                        onClick={() => setEditImages((prev) => prev.filter((_, j) => j !== i))}
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                      >×</button>
                    </div>
                  ))}
                  <button
                    onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
                    className="h-20 w-20 rounded-lg border border-dashed border-gray-600 text-gray-500 hover:text-gray-300 hover:border-gray-400 text-2xl"
                  >+</button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") (mode === "generate" ? runGenerate() : runEdit()); }}
            placeholder={mode === "generate" ? "Describe the image you want…" : "Describe the edit — e.g. 'put the person from image 1 into the scene in image 2, cinematic lighting'"}
            rows={3}
            className="w-full bg-gray-800 rounded-xl px-4 py-3 pr-28 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/50 placeholder-gray-500 resize-none"
          />
          {renderMic()}
        </div>

        <div className="flex items-center gap-4 flex-wrap text-xs">
          {mode === "generate" && (
            <div className="flex items-center gap-2">
              <label className="text-gray-500">Size</label>
              <Select items={SIZE_ITEMS} value={`${width}x${height}`} onValueChange={(v) => { if (!v) return; const [w, h] = String(v).split("x").map(Number); setWidth(w); setHeight(h); }}>
                <SelectTrigger className="h-8 bg-gray-800 border-gray-700 text-xs text-gray-300"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                  {SIZE_PRESETS.map((p) => <SelectItem key={p.label} value={`${p.w}x${p.h}`}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex items-center gap-2">
            <label className="text-gray-500">Steps</label>
            <input type="number" min={1} max={50} value={steps} onChange={(e) => setSteps(Number(e.target.value))}
              className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-gray-500">CFG</label>
            <input type="number" min={1} max={10} step={0.5} value={cfg} onChange={(e) => setCfg(Number(e.target.value))}
              className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums" />
          </div>
          <button onClick={() => setAdvanced((a) => !a)} className="text-gray-500 hover:text-gray-300">
            {advanced ? "− less" : "+ seed / negative"}
          </button>
          <button
            onClick={mode === "generate" ? runGenerate : runEdit}
            disabled={busy || !prompt.trim() || (mode === "edit" && editImages.length === 0)}
            className="ml-auto bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:hover:bg-pink-600 rounded-xl px-6 py-2.5 text-sm font-medium transition"
          >
            {busy ? `Running… ${elapsed.toFixed(1)}s` : mode === "generate" ? "Generate" : "Run Edit"}
          </button>
        </div>

        {advanced && (
          <div className="space-y-3 pt-1">
            <input
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
              placeholder="Negative prompt — what to avoid (text, watermark, blurry…)"
              className="w-full bg-gray-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-pink-500/40 placeholder-gray-600"
            />
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 text-gray-400 cursor-pointer">
                <input type="checkbox" checked={lockSeed} onChange={(e) => setLockSeed(e.target.checked)} />
                Lock seed
              </label>
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                disabled={!lockSeed}
                placeholder="random"
                className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums disabled:opacity-40"
              />
              <button onClick={() => setSeed(String(Math.floor(Math.random() * 2_147_483_647)))} disabled={!lockSeed}
                className="text-gray-500 hover:text-gray-300 disabled:opacity-40">🎲 random</button>
            </div>
          </div>
        )}

        {busy && renderStepProgress()}
        {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">{error}</div>}
        {mode === "edit" && editNotice && (
          <div className="text-xs px-3 py-2.5 rounded-lg bg-amber-500/10 text-amber-300 border border-amber-500/20 leading-relaxed">
            <span className="font-medium">Edit isn&apos;t installed yet.</span> {editNotice}
          </div>
        )}
      </section>
      )}

      {/* ── BATCH PANEL ── */}
      {mode === "batch" && (
        <section className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Base idea — e.g. 'a cozy coffee shop interior'. The varier expands this into N distinct prompts."
              rows={2}
              disabled={batchRunning}
              className="w-full bg-gray-800 rounded-xl px-4 py-3 pr-28 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/50 placeholder-gray-500 resize-none disabled:opacity-60"
            />
            {!batchRunning && renderMic()}
          </div>

          <div className="flex items-center gap-4 flex-wrap text-xs">
            <div className="flex items-center gap-2">
              <label className="text-gray-500">Count</label>
              {[10, 25, 50, 100].map((n) => (
                <button key={n} onClick={() => setBatchCount(n)} disabled={batchRunning}
                  className={`px-2.5 py-1.5 rounded-lg border transition ${batchCount === n ? "bg-pink-600 border-pink-600 text-white" : "bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500"} disabled:opacity-50`}>
                  {n}
                </button>
              ))}
              <input type="number" min={1} max={200} value={batchCount} disabled={batchRunning}
                onChange={(e) => setBatchCount(Math.max(1, Math.min(200, Number(e.target.value))))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-gray-500">Vary</label>
              <Select items={VARY_ITEMS} value={batchVary} onValueChange={(v) => { if (!v) return; setBatchVary(v as typeof batchVary); setBatchPrompts([]); }} disabled={batchRunning}>
                <SelectTrigger className="h-8 bg-gray-800 border-gray-700 text-xs text-gray-300"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                  <SelectItem value="template">Template (instant, no LLM)</SelectItem>
                  <SelectItem value="ai">AI (uses LLM)</SelectItem>
                  <SelectItem value="seed">Same prompt, vary seed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-gray-500">Size</label>
              <Select items={SIZE_ITEMS} value={`${width}x${height}`} disabled={batchRunning} onValueChange={(v) => { if (!v) return; const [w, h] = String(v).split("x").map(Number); setWidth(w); setHeight(h); }}>
                <SelectTrigger className="h-8 bg-gray-800 border-gray-700 text-xs text-gray-300"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                  {SIZE_PRESETS.map((p) => <SelectItem key={p.label} value={`${p.w}x${p.h}`}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-gray-500">Steps</label>
              <input type="number" min={1} max={50} value={steps} disabled={batchRunning} onChange={(e) => setSteps(Number(e.target.value))}
                className="w-14 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums" />
            </div>
          </div>

          {batchVary !== "seed" && (
            <input
              value={batchStyle}
              onChange={(e) => setBatchStyle(e.target.value)}
              placeholder="Optional style hint applied to every variation — e.g. 'shot on film, muted tones'"
              disabled={batchRunning}
              className="w-full bg-gray-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-pink-500/40 placeholder-gray-600"
            />
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={planPrompts} disabled={batchPlanning || batchRunning || !prompt.trim()}
              className="text-xs border border-gray-700 hover:border-gray-500 text-gray-300 rounded-lg px-3 py-2 transition disabled:opacity-40">
              {batchPlanning ? "Planning…" : "Preview prompts"}
            </button>
            {!batchRunning ? (
              <button onClick={runBatch} disabled={!prompt.trim() || batchPlanning}
                className="bg-pink-600 hover:bg-pink-500 disabled:opacity-40 rounded-xl px-6 py-2.5 text-sm font-medium transition">
                Start batch ({batchCount})
              </button>
            ) : (
              <button onClick={() => { stopRef.current = true; }}
                className="bg-red-600 hover:bg-red-500 rounded-xl px-6 py-2.5 text-sm font-medium transition">
                Stop after current
              </button>
            )}
            {batchInfo && <span className="text-xs text-gray-500">{batchInfo}</span>}
          </div>

          {/* progress */}
          {(batchRunning || batchDone > 0) && (
            <div className="bg-gray-800/50 rounded-xl p-4 space-y-2">
              {(() => {
                const total = batchPrompts.length || batchCount;
                const avg = batchTimes.length ? batchTimes.reduce((a, b) => a + b, 0) / batchTimes.length : 0;
                const remaining = Math.max(0, total - batchDone);
                const eta = avg * remaining;
                return (
                  <>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-300">
                        {batchRunning ? "Generating…" : "Batch finished"} {batchDone}/{total}
                        {batchFailed > 0 && <span className="text-red-400"> · {batchFailed} failed</span>}
                      </span>
                      <span className="text-gray-500 tabular-nums">
                        {avg > 0 && `~${avg.toFixed(0)}s/img`}{batchRunning && remaining > 0 && avg > 0 && ` · ETA ${eta > 90 ? `${Math.ceil(eta / 60)}m` : `${Math.round(eta)}s`}`}
                      </span>
                    </div>
                    <div className="h-2 bg-gray-700 rounded-full overflow-hidden flex">
                      <div className="h-full bg-pink-500 transition-all" style={{ width: `${((batchDone - batchFailed) / total) * 100}%` }} />
                      <div className="h-full bg-red-500/70 transition-all" style={{ width: `${(batchFailed / total) * 100}%` }} />
                    </div>
                    {batchRunning && renderStepProgress()}
                    {batchRunning && batchPrompts[batchDone] && (
                      <p className="text-[11px] text-gray-500 line-clamp-1">next: {batchPrompts[batchDone]}</p>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* editable planned prompts */}
          {batchPrompts.length > 0 && !batchRunning && (
            <div>
              <label className="text-[11px] text-gray-500 mb-1 block">Planned prompts ({batchPrompts.length}) — editable, one per line</label>
              <textarea
                value={batchPrompts.join("\n")}
                onChange={(e) => setBatchPrompts(e.target.value.split("\n").filter((l) => l.trim()))}
                rows={Math.min(10, batchPrompts.length)}
                className="w-full bg-gray-800 rounded-lg px-3 py-2 text-[11px] font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-pink-500/30 resize-y"
              />
            </div>
          )}

          {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">{error}</div>}
        </section>
      )}

      {/* ── HISTORY GALLERY (disk-backed, foldered) ── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            History {gallery.length > 0 && <span className="text-gray-600">({gallery.length})</span>}
          </h2>
          <button onClick={refreshGallery} className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
            Refresh
          </button>
        </div>

        {galleryLoading ? (
          <p className="text-sm text-gray-600">Loading history…</p>
        ) : (
          <div className="flex gap-5 items-start">
            {/* folder sidebar */}
            <aside className="w-48 flex-shrink-0 space-y-1">
              <div className="flex items-center justify-between mb-1 px-1">
                <span className="text-[11px] uppercase tracking-wider text-gray-600">Galleries</span>
                <button onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }} title="New folder (created inside the selected one)"
                  className="text-gray-400 hover:text-gray-100 text-base leading-none">＋</button>
              </div>

              <button onClick={() => setSelectedFolder(null)}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${selectedFolder === null ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"}`}>
                <span>All images</span><span className="text-gray-600">{gallery.length}</span>
              </button>

              <button onClick={() => setSelectedFolder(FAV)}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${selectedFolder === FAV ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"}`}>
                <span>★ Favorites</span><span className="text-gray-600">{favCount}</span>
              </button>

              <button onClick={() => setSelectedFolder("")}
                onDragOver={(e) => { e.preventDefault(); setDropTarget(""); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => { e.preventDefault(); dropToFolder(""); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${selectedFolder === "" ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"} ${dropTarget === "" ? "ring-1 ring-pink-500 bg-pink-500/10" : ""}`}>
                <span>Unfiled</span><span className="text-gray-600">{folderCounts.get("") ?? 0}</span>
              </button>

              {folders.map((f) => {
                const depth = f.split("/").length - 1;
                const name = f.slice(f.lastIndexOf("/") + 1);
                return (
                  <div key={f} className="group/folder flex items-center"
                    onDragOver={(e) => { e.preventDefault(); setDropTarget(f); }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => { e.preventDefault(); dropToFolder(f); }}>
                    <button onClick={() => setSelectedFolder(f)} style={{ paddingLeft: 8 + depth * 12 }}
                      className={`flex-1 min-w-0 text-left text-xs pr-2 py-1.5 rounded-lg flex items-center justify-between transition ${selectedFolder === f ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"} ${dropTarget === f ? "ring-1 ring-pink-500 bg-pink-500/10" : ""}`}>
                      <span className="truncate">📁 {name}</span><span className="text-gray-600 ml-1 flex-shrink-0">{folderCounts.get(f) ?? 0}</span>
                    </button>
                    <button onClick={() => setConfirmFolderDelete(f)} title="Delete folder"
                      className="opacity-0 group-hover/folder:opacity-100 text-gray-600 hover:text-red-400 px-1 flex-shrink-0">×</button>
                  </div>
                );
              })}
              {folders.length === 0 && (
                <p className="text-[10px] text-gray-700 px-2 pt-1 leading-relaxed">No folders yet. ＋ to add one, then drag images onto it (or right-click an image → Move).</p>
              )}
            </aside>

            {/* gallery grid */}
            <div ref={gridRef} onMouseDown={onGridMouseDown} className={`flex-1 min-w-0 ${marquee ? "select-none" : ""}`}>
              {visibleImages.length === 0 ? (
                <p className="text-sm text-gray-600">
                  {gallery.length === 0
                    ? "No images yet — every result is saved to disk automatically."
                    : selectedFolder === ""
                      ? "🎉 All images are filed into folders — nothing left unfiled. Switch to “All images” to see everything."
                      : "This gallery is empty. Drag images here from “All images”, or right-click an image to move it."}
                </p>
              ) : (
                <div className="space-y-8">
                  {selected.size > 0 && (
                    <div className="flex items-center gap-3 bg-pink-600/10 border border-pink-600/30 rounded-xl px-4 py-2 text-xs sticky top-[52px] z-[2] backdrop-blur-sm">
                      <span className="text-pink-300 font-medium">{selected.size} selected</span>
                      <label className="flex items-center gap-1.5 text-gray-400">
                        Move to
                        <Select items={moveItems} value="" onValueChange={(v) => { if (v) moveSelected(v === "__root__" ? "" : String(v)); }}>
                          <SelectTrigger className="h-7 bg-gray-800 border-gray-700 text-xs text-gray-300"><SelectValue placeholder="choose…" /></SelectTrigger>
                          <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                            <SelectItem value="__root__">Unfiled</SelectItem>
                            {folders.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </label>
                      <button
                        onClick={async () => { for (const rel of [...selected]) { const it = gallery.find((g) => g.rel === rel); if (it && !it.favorite) await toggleFavorite(it); } clearSelection(); }}
                        className="text-yellow-400 hover:text-yellow-300 border border-yellow-600/30 rounded-md px-2 py-1"
                      >★ Favorite</button>
                      <button onClick={clearSelection} className="ml-auto text-gray-400 hover:text-gray-100 border border-gray-700 rounded-md px-2 py-1">Clear</button>
                    </div>
                  )}
                  {groups.map(([day, items]) => (
                    <div key={day}>
                      <h3 className="text-xs text-gray-500 mb-3 sticky top-[57px] bg-gray-950/90 backdrop-blur-sm py-1 z-[1]">
                        {day} <span className="text-gray-700">· {items.length}</span>
                      </h3>
                      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                        {items.map((it) => {
                          const sel = selected.has(it.rel);
                          return (
                          <div key={it.rel}
                            data-rel={it.rel}
                            draggable
                            onDragStart={(e) => { setDragRel(it.rel); e.dataTransfer.setData("text/plain", it.rel); e.dataTransfer.effectAllowed = "move"; }}
                            onDragEnd={() => { setDragRel(null); setDropTarget(null); }}
                            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, item: it }); }}
                            className={`group relative bg-gray-900 rounded-xl border overflow-hidden transition ${sel ? "border-pink-500 ring-2 ring-pink-500/50" : "border-gray-800"} ${dragRel === it.rel ? "opacity-40" : ""}`}>
                            <button onClick={(e) => onTileClick(e, it)}
                              className="block w-full aspect-square bg-black/40" title="Click to view · drag a box over images to select · Shift/⌘-click to multi-select · drag to a folder">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={it.url} alt={it.prompt} loading="lazy" draggable={false} className="w-full h-full object-cover group-hover:opacity-90 transition" />
                            </button>

                            {/* select checkbox */}
                            <button onClick={(e) => { e.stopPropagation(); toggleSelect(it.rel); setAnchorRel(it.rel); }} title="Select"
                              className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-md flex items-center justify-center text-xs transition ${sel ? "bg-pink-600 text-white opacity-100" : "bg-black/60 text-gray-200 opacity-0 group-hover:opacity-100"}`}>
                              {sel ? "✓" : "○"}
                            </button>

                            {/* favorite + delete */}
                            <div className="absolute top-1.5 right-1.5 flex gap-1">
                              <button onClick={(e) => { e.stopPropagation(); toggleFavorite(it); }} title="Favorite (f)"
                                className={`w-7 h-7 rounded-lg bg-black/60 flex items-center justify-center text-sm transition ${it.favorite ? "text-yellow-400 opacity-100" : "text-gray-200 opacity-0 group-hover:opacity-100 hover:text-yellow-400"}`}>
                                {it.favorite ? "★" : "☆"}
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(it); }} title="Delete"
                                className="w-7 h-7 rounded-lg bg-black/60 hover:bg-red-600 text-white text-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition">🗑</button>
                            </div>

                            <div className="p-2">
                              <p className="text-[11px] text-gray-400 line-clamp-1" title={it.prompt}>{it.prompt || <span className="italic text-gray-600">no prompt</span>}</p>
                              <div className="flex items-center gap-2 text-[10px] text-gray-600 mt-0.5 tabular-nums">
                                <span className={it.kind === "edit" ? "text-purple-400" : "text-pink-400"}>{it.kind}</span>
                                {it.width && it.height && <span>{it.width}×{it.height}</span>}
                                {selectedFolder === null && it.folder && <span className="text-gray-700 truncate">📁 {it.folder}</span>}
                              </div>
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── LIGHTBOX ── */}
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <div className="max-w-6xl w-full max-h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex-1 min-h-0 flex items-center justify-center relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightbox.url} alt={lightbox.prompt} className="max-h-[80vh] max-w-full object-contain rounded-lg" />
              {visibleImages.length > 1 && (
                <>
                  <button onClick={() => navLightbox(-1)} title="Previous (←)"
                    className="absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 hover:bg-black/80 text-white text-2xl flex items-center justify-center transition">‹</button>
                  <button onClick={() => navLightbox(1)} title="Next (→)"
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/50 hover:bg-black/80 text-white text-2xl flex items-center justify-center transition">›</button>
                </>
              )}
            </div>
            <div className="mt-3 bg-gray-900/90 border border-gray-800 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <p className="text-sm text-gray-200 flex-1">{lightbox.prompt || <span className="italic text-gray-500">no prompt</span>}</p>
                <button onClick={() => toggleFavorite(lightbox)} title="Favorite (f)"
                  className={`text-lg leading-none ${lightbox.favorite ? "text-yellow-400" : "text-gray-500 hover:text-yellow-400"}`}>{lightbox.favorite ? "★" : "☆"}</button>
                <span className="text-[11px] text-gray-500 tabular-nums self-center">{visibleImages.findIndex((g) => g.rel === lightbox.rel) + 1} / {visibleImages.length}</span>
                <button onClick={() => setLightbox(null)} className="text-gray-400 hover:text-gray-100 text-sm border border-gray-700 rounded-md px-2 py-1">Close ✕</button>
              </div>
              <div className="flex items-center gap-3 flex-wrap text-[11px] text-gray-500 mt-2 tabular-nums">
                <span className={`px-1.5 py-0.5 rounded ${lightbox.kind === "edit" ? "bg-purple-500/15 text-purple-300" : "bg-pink-500/15 text-pink-300"}`}>{lightbox.kind}</span>
                {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
                {lightbox.seed != null && <span>seed {lightbox.seed}</span>}
                {lightbox.steps != null && <span>{lightbox.steps}st · cfg{lightbox.cfg}</span>}
                {lightbox.latency != null && <span className="text-green-500/80">{(lightbox.latency / 1000).toFixed(1)}s</span>}
                {lightbox.inputCount != null && <span>{lightbox.inputCount} inputs</span>}
                {lightbox.bytes != null && <span>{fmtBytes(lightbox.bytes)}</span>}
                {lightbox.savedAt && <span>{new Date(lightbox.savedAt).toLocaleString()}</span>}
                <span className="text-gray-700 font-mono truncate max-w-[260px]" title={lightbox.file}>{lightbox.file}</span>
              </div>
              <div className="flex items-center gap-3 text-xs mt-3">
                <a href={lightbox.url} download={lightbox.file} className="text-gray-300 hover:text-gray-100 border border-gray-700 rounded-md px-3 py-1.5">Download</a>
                <button onClick={() => { setPrompt(lightbox.prompt); setLightbox(null); }} className="text-gray-300 hover:text-gray-100 border border-gray-700 rounded-md px-3 py-1.5">Reuse prompt</button>
                <button onClick={() => sendToEdit(lightbox)} className="text-purple-300 hover:text-purple-200 border border-purple-700/40 rounded-md px-3 py-1.5">Send to Edit →</button>
                <label className="ml-auto flex items-center gap-1.5 text-gray-500">
                  Move to
                  <Select items={moveItems} value={lightbox.folder === "" ? "__root__" : lightbox.folder} onValueChange={(v) => { if (!v) return; moveItem(lightbox.rel, v === "__root__" ? "" : String(v)); setLightbox(null); }}>
                    <SelectTrigger className="h-8 bg-gray-800 border-gray-700 text-xs text-gray-300"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                      <SelectItem value="__root__">Unfiled</SelectItem>
                      {folders.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <button onClick={() => setConfirmDelete(lightbox)} className="text-red-400 hover:text-red-300 border border-red-700/40 rounded-md px-3 py-1.5">Delete</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MARQUEE SELECTION BOX ── */}
      {marquee && (
        <div
          className="fixed z-40 border border-pink-400 bg-pink-400/10 pointer-events-none rounded-sm"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {/* ── DELETE CONFIRM ── */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => !deleting && setConfirmDelete(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100 mb-1">Delete this image?</h3>
            <p className="text-xs text-gray-400 mb-1">This permanently removes it (and its metadata) from disk. This can&apos;t be undone.</p>
            <p className="text-[11px] text-gray-600 font-mono break-all mb-4">{confirmDelete.file}</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} disabled={deleting}
                className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5 disabled:opacity-40">Cancel</button>
              <button onClick={() => doDelete(confirmDelete)} disabled={deleting}
                className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5 disabled:opacity-40">
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RIGHT-CLICK MOVE MENU ── */}
      {ctxMenu && (
        <div className="fixed inset-0 z-[55]" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}>
          <div
            className="absolute bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px] max-h-[60vh] overflow-y-auto"
            style={{ left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 200), top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600">Move to</div>
            {allFolderTargets.map((f) => (
              <button key={f || "__root"} onClick={() => moveItem(ctxMenu.item.rel, f)} disabled={ctxMenu.item.folder === f}
                className="w-full text-left text-xs px-3 py-1.5 text-gray-300 hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-between">
                <span className="truncate">{f === "" ? "Unfiled" : `📁 ${f}`}</span>
                {ctxMenu.item.folder === f && <span className="text-gray-600 ml-2">✓</span>}
              </button>
            ))}
            <div className="border-t border-gray-800 my-1" />
            <button onClick={() => { setNewFolderName(""); setNewFolderOpen(true); setCtxMenu(null); }}
              className="w-full text-left text-xs px-3 py-1.5 text-gray-400 hover:bg-gray-800">＋ New folder…</button>
            <button onClick={() => { setConfirmDelete(ctxMenu.item); setCtxMenu(null); }}
              className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:bg-gray-800">Delete image</button>
          </div>
        </div>
      )}

      {/* ── NEW FOLDER ── */}
      {newFolderOpen && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setNewFolderOpen(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100 mb-1">New folder</h3>
            <p className="text-[11px] text-gray-500 mb-3">
              Created inside: <span className="text-gray-300 font-mono">{selectedFolder ? selectedFolder : "root (Unfiled)"}</span>
            </p>
            <input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
              placeholder="Folder name"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/40 mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setNewFolderOpen(false)} className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Cancel</button>
              <button onClick={createFolder} disabled={!newFolderName.trim()}
                className="text-sm bg-pink-600 hover:bg-pink-500 text-white rounded-lg px-4 py-1.5 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE FOLDER CONFIRM ── */}
      {confirmFolderDelete != null && (() => {
        const inside = gallery.filter((g) => g.folder === confirmFolderDelete || g.folder.startsWith(confirmFolderDelete + "/")).length;
        return (
          <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmFolderDelete(null)}>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-100 mb-1">Delete folder “{confirmFolderDelete}”?</h3>
              <p className="text-xs text-gray-400 mb-4">
                {inside > 0
                  ? `This folder and the ${inside} image${inside === 1 ? "" : "s"} inside it will be permanently deleted from disk. This can’t be undone.`
                  : "This empty folder will be removed from disk."}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmFolderDelete(null)} className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Cancel</button>
                <button onClick={() => deleteFolder(confirmFolderDelete)} className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5">
                  Delete {inside > 0 ? `folder + ${inside}` : "folder"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
