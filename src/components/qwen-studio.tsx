"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Star, Trash2, ChevronDown, ChevronUp, Mic, Square, X, ChevronRight, SlidersHorizontal, ServerCog } from "lucide-react";
import { DIM_POOLS, type DimKey } from "@/lib/prompt-variations";
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, getImageModel, cloudImageModel, isImageModelId, type ImageModel, type ImageModelId } from "@/lib/image-models";
import { useLocalFootprints } from "@/lib/use-local-footprints";
import ModelFootprint from "./model-footprint";
import { imageFootprint } from "@/lib/image-footprints";
import { ServiceControl, ServiceControls, ServiceStartupNote, serviceName, useServiceLifecycle } from "./service-control";
import CompareView from "./compare-view";
import { qwenCheckpointState } from "@/lib/qwen-checkpoint";

// ── types ───────────────────────────────────────────────────────────────────
type QwenHealth = {
  up: boolean;
  latency: number;
  statusCode?: number;
  model?: string;
  loaded?: boolean;
  load?: { state?: string; error?: string | null };
  mode?: string | null;
  edit?: { enabled: boolean; model: string; loaded: boolean };
  error?: string;
};

type ResourceSnapshot = {
  queue?: Array<{ owner?: string; workload?: string; lastDenial?: { message?: string } | null }>;
  leases?: Array<{ owner?: string; workload?: string }>;
  lastEvent?: { message?: string; type?: string } | null;
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
  batchJobId?: string;
  /** Which backend produced it. Rows predating the merge report "qwen-image". */
  model?: string;
};

const SIZE_PRESETS = [
  { label: "512×512 · fast draft", w: 512, h: 512 },
  { label: "1024×1024 · 1:1", w: 1024, h: 1024 },
  { label: "2048×2048 · HiDream native", w: 2048, h: 2048 },
  { label: "1024×768 · 4:3", w: 1024, h: 768 },
  { label: "768×1024 · 3:4", w: 768, h: 1024 },
  { label: "1280×720 · 16:9", w: 1280, h: 720 },
  { label: "720×1280 · 9:16", w: 720, h: 1280 },
  { label: "1080×1350 · Portrait", w: 1080, h: 1350 },
];

// value→label maps so the shadcn Select trigger shows labels, not raw values
const SIZE_ITEMS: Record<string, string> = Object.fromEntries(SIZE_PRESETS.map((p) => [`${p.w}x${p.h}`, p.label]));

function fmtBytes(n?: number) {
  if (!n) return "";
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

function fmtDur(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}

function Spinner() {
  return <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin align-[-2px]" />;
}

/**
 * A failed transcription, with the button that fixes it.
 *
 * Its own component because it owns a health poll for a service the studio
 * otherwise knows nothing about: `stt` can point at any local ASR service, or at
 * a cloud model — in which case there is no serviceId, nothing to start, and the
 * banner is just the sentence.
 *
 * This is the rule in service-control.tsx applied to voice: wherever the console
 * says a service isn't running, it offers the button. The mic used to report
 * "start its service" and stop there, on a surface with no way to do that and
 * with the recording already discarded.
 */
function VoiceErrorBanner({
  error,
  onRetry,
  canRetry,
  retrying,
  onDismiss,
}: {
  error: { message: string; serviceId?: string; model?: string };
  onRetry: () => void;
  canRetry: boolean;
  retrying: boolean;
  onDismiss: () => void;
}) {
  const id = error.serviceId;
  const [up, setUp] = useState<boolean | undefined>(undefined);

  const probe = useCallback(async () => {
    if (!id) return false;
    try {
      const rows = await fetch("/api/services", { cache: "no-store" }).then((r) => r.json());
      const row = Array.isArray(rows) ? rows.find((r: { id: string }) => r.id === id) : null;
      const alive = row?.status === "running";
      setUp(alive);
      return alive;
    } catch {
      setUp(false);
      return false;
    }
  }, [id]);

  useEffect(() => {
    if (id) void probe();
  }, [id, probe]);

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
      <div className="flex items-start gap-2">
        <Mic className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <p className="flex-1 leading-relaxed">{error.message}</p>
        <button onClick={onDismiss} aria-label="Dismiss" className="text-amber-300/60 hover:text-amber-100">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {(id || canRetry) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5.5">
          {id && <ServiceControl id={id} up={up} probe={probe} name={serviceName(id)} />}
          {canRetry && (
            <button
              onClick={onRetry}
              disabled={retrying}
              title="Send the recording you already made — no need to say it again"
              className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-100 transition hover:border-amber-400 disabled:opacity-50"
            >
              {retrying ? "Transcribing…" : "Retry with that recording"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StudioDialog({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="image-setup-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-setup-dialog-title"
      aria-describedby="image-setup-dialog-description"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="image-setup-dialog">
        <header className="image-setup-dialog-header">
          <div className="min-w-0">
            <h2 id="image-setup-dialog-title">{title}</h2>
            <p id="image-setup-dialog-description">{description}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={`Close ${title}`}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="image-setup-dialog-body">{children}</div>
      </div>
    </div>
  );
}

export default function QwenStudio() {
  const [health, setHealth] = useState<QwenHealth | null>(null);
  const [mode, setMode] = useState<"generate" | "batch" | "jobs" | "edit" | "compare">("generate");
  const [setupDialog, setSetupDialog] = useState<null | "model" | "runtime">(null);

  // Which model Generate targets. Qwen-Image is the resident service on :8021;
  // FLUX.1-schnell goes through ComfyUI on :8188 and is the fast-draft tier.
  // A cloud pick stores the ROUTER ALIAS here — generateAndSave treats anything
  // outside the local registry as one, so it needs no special case downstream.
  const [imageModel, setImageModel] = useState<string>(DEFAULT_IMAGE_MODEL);
  const [choiceRestored, setChoiceRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("betenshi:image-studio:model");
      if (isImageModelId(saved)) setImageModel(saved);
    } catch { /* Storage may be disabled. */ }
    setChoiceRestored(true);
  }, []);
  useEffect(() => {
    if (!choiceRestored) return;
    try {
      if (isImageModelId(imageModel)) localStorage.setItem("betenshi:image-studio:model", imageModel);
      else localStorage.removeItem("betenshi:image-studio:model");
    } catch { /* The active selection still works. */ }
  }, [imageModel, choiceRestored]);
  const [modelTab, setModelTab] = useState<"local" | "cloud">("local");
  /**
   * The router's image catalogue, for the Cloud side of the picker.
   *
   * This tab used to carry a second, separate ModelPicker above the studio just
   * to offer these. That put the model on screen twice — a routing card at the
   * top and the thing you generate with below — so it lives here now.
   */
  const [routerImages, setRouterImages] = useState<
    { id: string; local: boolean; provider: string; serviceId?: string; status: string }[]
  >([]);
  const [routedImage, setRoutedImage] = useState<string | null>(null);
  const [routerUp, setRouterUp] = useState(true);
  const [routingBusy, setRoutingBusy] = useState<string | null>(null);

  const cloudModels = useMemo(() => routerImages.filter((m) => !m.local), [routerImages]);
  /** The alias the router knows the local Qwen service by — derived, never hardcoded. */
  const qwenAlias = useMemo(
    () => routerImages.find((m) => m.local && m.serviceId === "qwen")?.id ?? null,
    [routerImages],
  );

  const activeModel = useMemo(() => {
    const local = IMAGE_MODELS.find((m) => m.id === imageModel);
    if (local) return local;
    const cloud = cloudModels.find((m) => m.id === imageModel);
    return cloudImageModel(imageModel, cloud?.provider);
  }, [imageModel, cloudModels]);
  /** ComfyUI's own health — only polled while FLUX is the selected model. */
  const [comfyHealth, setComfyHealth] = useState<{ up: boolean; error?: string } | null>(null);
  /** Memory cost per model, so the picker can say what each one holds. */
  const { footprints, liveMb } = useLocalFootprints();

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
  const [galleryBatchFilter, setGalleryBatchFilter] = useState<string | null>(null);
  const [confirmBulkCancelQueued, setConfirmBulkCancelQueued] = useState(false);
  const galleryRef = useRef<HTMLElement>(null);

  const [dragRel, setDragRel] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; folder: string } | null>(null);
  const [stackBusy, setStackBusy] = useState<null | "free" | "start">(null);
  const [rescanning, setRescanning] = useState(false);
  const [rescanResult, setRescanResult] = useState<string | null>(null);
  const FAV = "__fav__"; // pseudo-folder sentinel for the Favorites view
  // marquee (rubber-band) selection
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeBaseRef = useRef<{ additive: boolean; base: Set<string> }>({ additive: false, base: new Set() });
  /** Last pointer position in VIEWPORT coords; page coords are derived with the live scroll. */
  const lastClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
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
  const requestRef = useRef<{ id: string; started: number; controller: AbortController } | null>(null);
  /**
   * The run just finished. It carries WHICH model made it, because the same
   * panel now shows results from more than one: rerunOn() switches models
   * between runs, and an image with no model on it is worthless for comparing.
   */
  type StudioResult = {
    image: string;
    saved: string | null;
    latency: number;
    folder: string;
    modelId: string;
    modelName: string;
    steps: number;
    prompt: string;
  };
  const [lastResult, setLastResult] = useState<StudioResult | null>(null);
  /**
   * Results kept on screen for comparison.
   *
   * The Compare tab fans one prompt out to every model at once, which answers a
   * different question than "that was close — what does the other one do with
   * it?". This is the one-at-a-time version: each rerun pins the previous result
   * rather than overwriting it, so the comparison accumulates from the ordinary
   * Generate flow instead of requiring you to go somewhere else and start over.
   */
  const [pinnedResults, setPinnedResults] = useState<StudioResult[]>([]);
  const [galleryPicker, setGalleryPicker] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerFolder, setPickerFolder] = useState<string>("__all__");
  const [loadingReference, setLoadingReference] = useState(false);
  const outputFolder = selectedFolder && selectedFolder !== "__fav__" ? selectedFolder : "";
  const homeDraftApplied = useRef(false);

  // Home's multimodal composer hands image prompts to the studio through a
  // one-shot local draft. Consume it here so Run lands in the real generator
  // with the user's text intact, without coupling the two large components.
  useEffect(() => {
    const draft = window.localStorage.getItem("bt-qwen-draft");
    if (!draft) return;
    homeDraftApplied.current = true;
    setPrompt(draft);
    setMode("generate");
    window.localStorage.removeItem("bt-qwen-draft");
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [editNotice, setEditNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // live denoising progress from the server (step X/Y)
  const [serverProgress, setServerProgress] = useState<{ running: boolean; phase?: string; step: number; total: number; elapsed?: number; started?: number } | null>(null);
  const [resourceSnapshot, setResourceSnapshot] = useState<ResourceSnapshot | null>(null);
  const ownQueue = resourceSnapshot?.queue?.find((q) => q.owner === "console:image:" + requestRef.current?.id);
  const ownLease = resourceSnapshot?.leases?.find((q) => q.owner === "console:image:" + requestRef.current?.id);

  // edit inputs
  const [editImages, setEditImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // voice input — whatever the `stt` capability is pointed at
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [recMs, setRecMs] = useState(0);
  const mediaRecRef = useRef<MediaRecorder | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * A failed transcription, kept apart from `error` because it is the one failure
   * in this view with a specific fix: start the service that was unreachable.
   * Rendered as a banner with that service's own Start button rather than as a
   * sentence telling you to go and find it.
   */
  const [voiceError, setVoiceError] = useState<{ message: string; serviceId?: string; model?: string } | null>(null);
  /**
   * The audio behind that failure.
   *
   * Dropping it is what made "voice is off" cost a re-record: you spoke, the
   * service was down, the words were gone. Holding the blob makes Retry a real
   * button — start the service, press it, and the sentence you already said
   * lands in the prompt.
   */
  const lastRecordingRef = useRef<Blob | null>(null);

  // batch
  const [batchCount, setBatchCount] = useState(10);
  const [batchVary, setBatchVary] = useState<"template" | "ai" | "seed" | "manual">("template");
  const [batchSuffix, setBatchSuffix] = useState("");
  const [batchManual, setBatchManual] = useState("");
  const [batchDims, setBatchDims] = useState<Record<string, { on: boolean; locked: string }>>({
    style:   { on: true,  locked: "" },
    lighting:{ on: true,  locked: "" },
    mood:    { on: true,  locked: "" },
    palette: { on: false, locked: "" },
    lens:    { on: true,  locked: "" },
  });
  const [batchPrompts, setBatchPrompts] = useState<string[]>([]);
  const [batchShowPreview, setBatchShowPreview] = useState(false);
  const [batchDimsOpen, setBatchDimsOpen] = useState(false);
  const dimsPopRef = useRef<HTMLDivElement>(null);
  const [batchPlanning, setBatchPlanning] = useState(false);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  // server-side job queue
  type BatchJob = {
    id: string; status: "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
    idea: string; prompts: string[];
    params: {
      negative: string; width: number; height: number; steps: number; cfg: number;
      /** Absent on jobs queued before the queue became model-aware. */
      model?: ImageModelId;
    };
    completed: number; failed: number; total: number; currentIndex?: number;
    createdAt: string; startedAt?: string; doneAt?: string; lastError?: string;
  };
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const jobsActiveRef = useRef(false);
  const [confirmCancelJob, setConfirmCancelJob] = useState<string | null>(null);
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<string | null>(null);
  const [confirmClearCompleted, setConfirmClearCompleted] = useState(false);
  const [expandedJob, setExpandedJob] = useState<string | null>(null);
  const [detailJobId, setDetailJobId] = useState<string | null>(null);
  const [reSyncing, setReSyncing] = useState(false);
  const [queueStatus, setQueueStatus] = useState<{
    backend: { id: string; url: string; alive: boolean };
    parked: { since: string; reason: string } | null;
    counts: Record<string, number>;
  } | null>(null);

  // Returns the fresh verdict as well as storing it. The manager-side view of the
  // process (still starting? pid? log tail?) comes from useServiceLifecycle below,
  // which is shared with every other service surface in the console.
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/qwen/health");
      const h = await res.json();
      setHealth(h);
      return !!h.up;
    } catch {
      setHealth({ up: false, latency: 0, error: "unreachable" });
      return false;
    }
  }, []);

  const refreshGallery = useCallback(async () => {
    try {
      const res = await fetch("/api/qwen/images", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("Gallery refresh failed");
      const data = await res.json();
      setGallery(Array.isArray(data.images) ? data.images : []);
      setFolders(Array.isArray(data.folders) ? data.folders : []);
    } catch {
      /* keep prior list */
    }
    setGalleryLoading(false);
  }, []);

  const checkComfy = useCallback(async () => {
    try {
      const h = await fetch("/api/comfyui/health").then((r) => r.json());
      setComfyHealth(h);
      return !!h.up;
    } catch {
      setComfyHealth({ up: false, error: "unreachable" });
      return false;
    }
  }, []);

  /** Shared lifecycle: Start/Stop/Restart, plus the manager's view while it loads. */
  const lifecycle = useServiceLifecycle("qwen", health?.up, checkHealth);
  const svcStatus = lifecycle.managed;

  // FLUX runs on ComfyUI, so the studio needs that service's lifecycle too. The
  // hook only polls the manager while a service is down, so keeping this mounted
  // costs nothing once ComfyUI is up.
  const comfyLifecycle = useServiceLifecycle("comfyui", comfyHealth?.up, checkComfy);

  /** Whether the model the picker is pointing at can actually run right now. */
  const modelUp =
    activeModel.serviceId === null
      ? routerUp // cloud: no local process to be up, only the router matters
      : activeModel.serviceId === "comfyui"
        ? !!comfyHealth?.up
        : !!health?.up;

  /** True while Generate is starting the runtime it needs, before inference begins. */
  const [startingRuntime, setStartingRuntime] = useState(false);

  /**
   * Bring up whatever the given model needs, and report whether it got there.
   *
   * Generate used to be simply DISABLED whenever its runtime was down: you typed
   * a prompt, and the only button on the screen was grey. The fix the studio
   * wanted was two clicks away inside a modal, which is a strange thing to ask of
   * someone who has already said what they want. The button starts the service
   * itself now — `lifecycle.run("start")` already waits for the port to open, so
   * "start it, then run it" is one press.
   *
   * Cloud models are the exception: the router is not ours to start from here.
   */
  const ensureRuntime = useCallback(
    async (serviceId: "qwen" | "comfyui" | null): Promise<boolean> => {
      if (serviceId === null) return routerUp;
      const alreadyUp = serviceId === "comfyui" ? !!comfyHealth?.up : !!health?.up;
      if (alreadyUp) return true;
      const lc = serviceId === "comfyui" ? comfyLifecycle : lifecycle;
      setStartingRuntime(true);
      try {
        await lc.run("start");
        return serviceId === "comfyui" ? await checkComfy() : await checkHealth();
      } finally {
        setStartingRuntime(false);
      }
    },
    [routerUp, comfyHealth?.up, health?.up, comfyLifecycle, lifecycle, checkComfy, checkHealth],
  );

  /** The router's catalogue, for the Cloud side of the Model row. */
  const loadProviders = useCallback(async () => {
    try {
      const j = await fetch("/api/providers", { cache: "no-store" }).then((r) => r.json());
      setRouterUp(!!j.routerUp);
      const modes: string[] = j.capabilities?.find((c: { id: string }) => c.id === "image")?.modes ?? [];
      setRouterImages((j.models ?? []).filter((m: { mode: string }) => modes.includes(m.mode)));
      setRoutedImage(j.routing?.image ?? null);
    } catch {
      /* transient — the poll retries */
    }
  }, []);

  useEffect(() => {
    loadProviders();
    const t = setInterval(loadProviders, 6000);
    return () => clearInterval(t);
  }, [loadProviders]);

  /**
   * Point the studio at a model, and the box with it.
   *
   * Selecting here writes the router's `image` routing, which is what every
   * OTHER caller on this box resolves — quote-forge included. That side effect
   * is the reason the note under the row says so out loud. FLUX is the one
   * exception: it is a ComfyUI workflow with no router alias, so choosing it
   * changes what the studio generates with and deliberately leaves routing alone
   * rather than silently pointing the box at something it cannot serve.
   */
  const pickModel = useCallback(
    async (id: string, alias: string | null) => {
      setImageModel(id);
      if (!alias || alias === routedImage) return;
      setRoutingBusy(id);
      try {
        await fetch("/api/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: alias }),
        });
      } finally {
        setRoutingBusy(null);
        loadProviders();
      }
    },
    [routedImage, loadProviders],
  );

  // Only poll ComfyUI while it's the selected backend — it's a heavyweight app
  // and there's no reason to probe it while every generation is going to Qwen.
  useEffect(() => {
    if (activeModel.serviceId !== "comfyui" && setupDialog !== "model") return;
    checkComfy();
    const t = setInterval(checkComfy, comfyHealth?.up ? 30000 : 8000);
    return () => clearInterval(t);
  }, [activeModel.serviceId, checkComfy, comfyHealth?.up, setupDialog]);

  // Batch and Edit are Qwen-only (the queue drives :8021 directly, and FLUX
  // schnell has no edit endpoint), so selecting FLUX from one of those modes
  // has to land somewhere valid rather than leaving a dead Run button.
  useEffect(() => {
    if (mode === "batch" && !activeModel.supportsBatch) setMode("generate");
    if (mode === "edit" && !activeModel.supportsEdit) setMode("generate");
  }, [mode, activeModel.supportsBatch, activeModel.supportsEdit]);

  // Step counts aren't transferable between these two: 28 steps on a 4-step
  // distilled model is wasted time, 4 steps on Qwen is mush. Snap to the new
  // model's default on switch — but not on mount, which would stomp the
  // component's own initial values.
  const prevModelRef = useRef(imageModel);
  useEffect(() => {
    if (prevModelRef.current === imageModel) return;
    prevModelRef.current = imageModel;
    setSteps(activeModel.steps[0]);
    setCfg(activeModel.defaultCfg);
    setWidth(imageModel === "hidream-o1-dev" ? 2048 : 1024);
    setHeight(imageModel === "hidream-o1-dev" ? 2048 : 1024);
  }, [imageModel, activeModel.steps, activeModel.defaultCfg]);

  useEffect(() => {
    checkHealth();
    refreshGallery();
    // poll fast while loading, slow otherwise
    const interval = svcStatus?.status === "starting" ? 3000 : 15000;
    const refreshVisible = () => { if (!document.hidden) { void checkHealth(); void refreshGallery(); } };
    const t = setInterval(refreshVisible, interval);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { clearInterval(t); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [checkHealth, refreshGallery, svcStatus?.status]);

  // poll the server's live denoising progress while a generation or batch is running
  const hasRunningJob = useMemo(() => jobs.some((j) => j.status === "running" || j.status === "queued"), [jobs]);
  const activeJobs = useMemo(() => jobs.filter((j) => j.status === "running" || j.status === "queued" || j.status === "paused"), [jobs]);
  const completedJobs = useMemo(() => jobs.filter((j) => j.status === "done" || j.status === "cancelled" || j.status === "failed"), [jobs]);
  const failedCount = useMemo(() => jobs.filter((j) => j.status === "failed").length, [jobs]);
  const doneCount = useMemo(() => jobs.filter((j) => j.status === "done").length, [jobs]);
  const runningJob = useMemo(() => jobs.find((j) => j.status === "running"), [jobs]);
  // Aggregate image progress across every job — the headline number for the
  // collapsed summary, so you can tell at a glance how far the whole queue is.
  const jobTotals = useMemo(() => {
    let completed = 0, total = 0;
    for (const j of jobs) { completed += j.completed; total += j.total; }
    return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
  }, [jobs]);
  const runCount = useMemo(() => jobs.filter((j) => j.status === "running").length, [jobs]);
  const queueCount = useMemo(() => jobs.filter((j) => j.status === "queued").length, [jobs]);
  const pauseCount = useMemo(() => jobs.filter((j) => j.status === "paused").length, [jobs]);
  const activeJobCount = useMemo(() => activeJobs.length, [activeJobs]);
  const summaryParts = [
    runCount ? `${runCount} running` : null,
    queueCount ? `${queueCount} queued` : null,
    pauseCount ? `${pauseCount} paused` : null,
    doneCount ? `${doneCount} done` : null,
    failedCount ? `${failedCount} failed` : null,
  ].filter(Boolean).join(" · ");

  // Collapsed by default once you've got a big backlog; remembered across reloads.
  const [jobsExpanded, setJobsExpanded] = useState(true);
  const [completedExpanded, setCompletedExpanded] = useState(false);
  useEffect(() => {
    const v = localStorage.getItem("qwen.jobsExpanded");
    if (v !== null) setJobsExpanded(v === "1");
    const c = localStorage.getItem("qwen.completedExpanded");
    if (c !== null) setCompletedExpanded(c === "1");
  }, []);
  useEffect(() => { localStorage.setItem("qwen.jobsExpanded", jobsExpanded ? "1" : "0"); }, [jobsExpanded]);
  useEffect(() => { localStorage.setItem("qwen.completedExpanded", completedExpanded ? "1" : "0"); }, [completedExpanded]);
  useEffect(() => {
    if (!busy && !hasRunningJob) {
      setServerProgress(null);
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const d = await fetch("/api/qwen/progress").then((r) => r.json());
        if (active) setServerProgress(d);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { active = false; clearInterval(id); };
  }, [busy, hasRunningJob]);

  // close overlays on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setConfirmDelete(null);
        setLightbox(null);
        setCtxMenu(null);
        setNewFolderOpen(false);
        setConfirmFolderDelete(null);
        setBatchDimsOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // close dims popover on outside click
  useEffect(() => {
    if (!batchDimsOpen) return;
    function onDown(e: MouseEvent) {
      if (dimsPopRef.current && !dimsPopRef.current.contains(e.target as Node)) {
        setBatchDimsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [batchDimsOpen]);

  // restore batch form settings on mount
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("btc_batch") ?? "null");
      if (!s) return;
      if (s.batchCount) setBatchCount(s.batchCount);
      if (s.batchVary) setBatchVary(s.batchVary);
      if (s.batchSuffix !== undefined) setBatchSuffix(s.batchSuffix);
      if (s.batchManual !== undefined) setBatchManual(s.batchManual);
      if (s.batchDims) setBatchDims(s.batchDims);
      if (s.prompt !== undefined && !homeDraftApplied.current) setPrompt(s.prompt);
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // persist batch form settings
  useEffect(() => {
    try { localStorage.setItem("btc_batch", JSON.stringify({ prompt, batchCount, batchVary, batchSuffix, batchManual, batchDims })); }
    catch { /* ignore */ }
  }, [prompt, batchCount, batchVary, batchSuffix, batchManual, batchDims]);

  // job queue polling
  const refreshJobs = useCallback(async () => {
    try {
      const data = await fetch("/api/qwen/jobs").then((r) => r.json());
      if (Array.isArray(data)) {
        setJobs(data);
        const hasActive = data.some((j: BatchJob) => j.status === "running" || j.status === "queued" || j.status === "paused");
        jobsActiveRef.current = hasActive;
        if (hasActive) refreshGallery();
      }
    } catch { /* ignore */ }
    // Why-is-nothing-running signal: the queue parks itself when the image
    // backend is unreachable rather than burning jobs against a dead service.
    try {
      setQueueStatus(await fetch("/api/qwen/jobs/status").then((r) => r.json()));
    } catch { /* ignore */ }
  }, [refreshGallery]);

  /**
   * Free the GPU: hold every active job, then stop the Qwen service so the ~36 GB
   * the model pins is released. "Start everything" reverses it — the queue resumes
   * from each job's cursor once the model is loaded, regenerating nothing.
   */
  const stackAction = useCallback(async (action: "free" | "start") => {
    setStackBusy(action);
    try {
      const r = await fetch("/api/qwen/stack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).then((x) => x.json());
      if (r.error) setError(`${action === "free" ? "Free GPU" : "Start"} failed: ${r.error}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStackBusy(null);
      refreshJobs();
      checkHealth();
    }
  }, [refreshJobs, checkHealth]);


  useEffect(() => {
    refreshJobs();
    const tick = () => {
      refreshJobs();
      t = setTimeout(tick, jobsActiveRef.current ? 3000 : 15000);
    };
    let t = setTimeout(tick, jobsActiveRef.current ? 3000 : 15000);
    return () => clearTimeout(t);
  }, [refreshJobs]);

  function startTimer() {
    setElapsed(0);
    const t0 = Date.now();
    timerRef.current = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
  }
  function stopTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
  }
  useEffect(() => () => { requestRef.current?.controller.abort(); }, []);

  function beginImageRequest() {
    const request = { id: crypto.randomUUID(), started: Date.now(), controller: new AbortController() };
    requestRef.current = request;
    setResourceSnapshot(null);
    setServerProgress(null);
    setLastResult(null);
    return request;
  }

  // Surface resource admission while a request is waiting. Without this, a
  // valid GPU-capacity denial looks identical to a cold model start.
  useEffect(() => {
    if (!busy) return;
    let stopped = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/resources", { cache: "no-store" });
        const data = await r.json();
        if (!stopped) setResourceSnapshot(data);
      } catch { /* the existing server-progress message remains useful */ }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [busy]);

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
    if (!prompt.trim() || busy || startingRuntime) return;
    await runImageRequest("generate");
  }

  async function runEdit() {
    if (!prompt.trim() || !editImages.length || busy || startingRuntime) return;
    await runImageRequest("edit");
  }

  /**
   * Same prompt, next model, previous result kept beside it.
   *
   * Comparing two image models one at a time used to mean: note what you got,
   * open the model dialog, pick the other one, retype nothing but lose the
   * result, run, and hold the first image in your head. The comparison happened
   * in memory, which is exactly where it is least reliable.
   *
   * The model switch is persisted routing (see pickModel), so it is deliberately
   * the same act as choosing from the dialog — this is a shortcut to it, not a
   * second, hidden way to select a model.
   */
  async function rerunOn(target: ImageModel) {
    if (!prompt.trim() || busy || startingRuntime) return;
    if (lastResult) setPinnedResults((prev) => [lastResult, ...prev].slice(0, 3));
    const alias = target.serviceId === "qwen" ? qwenAlias : target.serviceId === null ? target.id : null;
    await pickModel(target.id, alias);
    await runImageRequest("generate", {
      model: target,
      steps: target.steps[0],
      cfg: target.defaultCfg,
    });
  }

  /** Models worth offering as the next comparison — everything but the one just run. */
  const rerunCandidates = useMemo<ImageModel[]>(() => {
    const cloud = cloudModels
      .filter((m) => m.status !== "no-key")
      .map((m) => cloudImageModel(m.id, m.provider));
    return [...IMAGE_MODELS, ...cloud].filter((m) => m.id !== lastResult?.modelId);
  }, [cloudModels, lastResult?.modelId]);

  /**
   * Run a model that is not the currently selected one — see rerunOn(). Carries
   * its own steps/cfg because those aren't transferable: 28 steps on a 4-step
   * distilled model is wasted minutes, 4 steps on Qwen is mush.
   */
  type RunOverride = { model: ImageModel; steps: number; cfg: number };

  async function runImageRequest(kind: "generate" | "edit", override?: RunOverride) {
    const target = override?.model ?? activeModel;

    // Start the backend before asking it for anything. Returning early with a
    // message beats the old behaviour — a dead button — but only just; the
    // common case is that this succeeds and the run simply proceeds.
    if (!(await ensureRuntime(target.serviceId))) {
      setError(
        target.serviceId === null
          ? "The AI Router is offline, so this cloud model can't be called."
          : `${target.serviceId === "comfyui" ? "ComfyUI" : "The Qwen-Image service"} did not come up — open Details in Run setup for its logs.`,
      );
      return;
    }

    // An ordinary run starts a new comparison. Only rerunOn() carries the
    // previous results forward — otherwise a fresh prompt would appear beside
    // images made from a different one, which is worse than no comparison.
    if (!override) setPinnedResults([]);

    const request = beginImageRequest();
    const folder = outputFolder;
    setBusy(true);
    setError(null);
    setEditNotice(null);
    startTimer();
    try {
      const res = await fetch(kind === "generate" ? "/api/image/generate" : target.serviceId === "comfyui" ? "/api/image/edit" : "/api/qwen/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: request.controller.signal,
        body: JSON.stringify({ model: target.id, prompt, images: kind === "edit" ? editImages : undefined,
          negative_prompt: negative, width, height, steps: override?.steps ?? steps, cfg: override?.cfg ?? cfg, seed: resolveSeed(), folder, requestId: request.id }),
      });
      const data = await res.json();
      if (res.ok && data.status === "success") {
        if (!lockSeed) setSeed(String(data.seed));
        setLastResult({
          image: data.image, saved: data.saved, latency: data.latency, folder,
          modelId: target.id, modelName: target.name, steps: override?.steps ?? steps, prompt,
        });
        setSelectedFolder(folder);
        setGalleryBatchFilter(null);
        setPage(1);
        if (!data.saved) setError("The image was generated, but saving failed. Download the result below.");
        // Rendering the result must not wait for a gallery refresh.
        void refreshGallery();
        void checkHealth();
      } else if (data.enabled === false) {
        setEditNotice(data.message || "Image editing is not enabled.");
      } else {
        setError(data.error || "Generation failed");
      }
    } catch (err) {
      setError(request.controller.signal.aborted ? "Stopped waiting. If inference already started, it may finish in Generation History." : err instanceof Error ? err.message : String(err));
    } finally {
      stopTimer();
      setBusy(false);
      setResourceSnapshot(null);
      requestRef.current = null;
    }
  }

  // Build the prompt list for a batch — template/AI variation, seed-only, or manual list.
  async function computePrompts(): Promise<string[]> {
    const idea = prompt.trim();
    if (batchVary === "seed") return Array.from({ length: batchCount }, () => idea);
    if (batchVary === "manual") {
      const lines = batchManual.split("\n").map((s) => s.trim()).filter(Boolean);
      return lines.slice(0, batchCount);
    }
    const res = await fetch("/api/qwen/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, count: batchCount, suffix: batchSuffix, dims: batchDims, mode: batchVary }),
    });
    const data = await res.json();
    return Array.isArray(data.prompts) ? data.prompts : [];
  }

  async function planPrompts() {
    const hasInput = batchVary === "manual" ? batchManual.trim() : prompt.trim();
    if (!hasInput || batchPlanning) return;
    setBatchPlanning(true);
    try { setBatchPrompts(await computePrompts()); }
    catch { /* ignore */ }
    setBatchPlanning(false);
  }

  async function submitBatch() {
    const hasInput = batchVary === "manual" ? batchManual.trim() : prompt.trim();
    if (batchSubmitting || !hasInput) return;
    setError(null);
    setBatchSubmitting(true);
    try {
      let prompts = batchPrompts.length ? batchPrompts.slice(0, batchCount) : [];
      if (prompts.length === 0) {
        setBatchPlanning(true);
        prompts = await computePrompts().catch(() => []);
        setBatchPlanning(false);
        setBatchPrompts(prompts);
      }
      if (prompts.length === 0) { setError("No prompts generated."); return; }
      await fetch("/api/qwen/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: (prompt || batchManual).split("\n")[0].slice(0, 80), prompts, negative, width, height, steps, cfg, model: imageModel }),
      });
      setBatchPrompts([]); // clear so next batch doesn't reuse stale prompts
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchSubmitting(false);
    }
  }

  // Pull a saved image back in as an edit reference (edit needs base64).
  async function sendToEdit(item: GalleryItem) {
    setLoadingReference(true);
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error("Image could not be loaded");
      const blob = await res.blob();
      const dataUrl = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
      setEditImages((prev) => [...prev, dataUrl]);
      setMode("edit");
      if (!activeModel.supportsEdit) setImageModel("flux2-klein-4b");
      setGalleryPicker(false);
      setPrompt("");
      setLightbox(null);
    } catch {
      setError("Couldn't load that image into the editor.");
    } finally {
      setLoadingReference(false);
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
    const onTile = (e.target as HTMLElement).closest("[data-rel]");
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey || e.altKey;
    // A plain press on a tile stays a click / native drag-to-move. Holding a
    // modifier rubber-bands from anywhere, tiles included — the gaps between
    // tiles are only a few pixels wide, which made starting a marquee fiddly.
    if (onTile && !modifier) return;
    e.preventDefault(); // also suppresses the native HTML5 drag when over a tile
    marqueeBaseRef.current = { additive: e.shiftKey || e.metaKey || e.ctrlKey, base: new Set(selected) };
    lastClientRef.current = { x: e.clientX, y: e.clientY };
    // PAGE coords, not viewport: the anchor must stay pinned to the document so
    // scrolling mid-drag extends the box instead of shifting it out from under you.
    const px = e.clientX + window.scrollX;
    const py = e.clientY + window.scrollY;
    setMarquee({ x0: px, y0: py, x1: px, y1: py });
  }

  /**
   * Bulk helper with bounded concurrency and progress. Select-all makes
   * 600-image selections one click away, and a strictly sequential loop over that
   * many requests looks like a hang.
   */
  async function runBulk<T>(items: T[], label: string, fn: (item: T) => Promise<unknown>, concurrency = 8) {
    let done = 0;
    setBulkProgress({ done: 0, total: items.length, label });
    const queue = [...items];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          try {
            await fn(item);
          } catch {
            /* keep going — one bad image must not abort the batch */
          }
          done++;
          setBulkProgress({ done, total: items.length, label });
        }
      }),
    );
    setBulkProgress(null);
  }

  // Move every selected image into a folder, then refresh once.
  async function moveSelected(toFolder: string) {
    const rels = [...selected];
    await runBulk(rels, "Moving", (rel) =>
      fetch("/api/qwen/images/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rel, toFolder }),
      }),
    );
    clearSelection();
    await refreshGallery();
  }

  // Favourite every selected image that isn't already favourited.
  async function favoriteSelected() {
    const items = [...selected]
      .map((rel) => gallery.find((g) => g.rel === rel))
      .filter((it): it is GalleryItem => !!it && !it.favorite);
    await runBulk(items, "Favouriting", (it) => toggleFavorite(it));
    clearSelection();
  }

  // Drop onto a folder: if the dragged item is part of a multi-selection, move
  // the whole selection; otherwise just the one.
  function dropToFolder(target: string) {
    setDropTarget(null);
    if (!dragRel) return;
    if (selected.has(dragRel) && selected.size > 1) moveSelected(target);
    else moveItem(dragRel, target);
  }

  /** Open the folder in Windows Explorer — these are real directories on disk. */
  async function revealFolder(folder: string) {
    setFolderMenu(null);
    try {
      await fetch("/api/qwen/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal", path: folder }),
      });
    } catch {
      setError("Couldn't open the folder.");
    }
  }

  /**
   * Reconcile the DB against disk. Refresh only re-reads the database, so a file
   * moved behind its back stays wrong no matter how often you hit it.
   */
  async function rescanDisk() {
    setRescanning(true);
    setRescanResult(null);
    try {
      const r = await fetch("/api/qwen/images/reconcile", { method: "POST" }).then((x) => x.json());
      const bits = [
        r.relocated ? `${r.relocated} relocated` : null,
        r.added ? `${r.added} added` : null,
        r.removed ? `${r.removed} removed` : null,
      ].filter(Boolean);
      setRescanResult(bits.length ? bits.join(" · ") : "already in sync");
      await refreshGallery();
    } catch {
      setRescanResult("rescan failed");
    } finally {
      setRescanning(false);
      setTimeout(() => setRescanResult(null), 6000);
    }
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
  // galleryBatchFilter overrides all folder selection to show a specific batch
  const visibleImages = useMemo(() => {
    if (galleryBatchFilter) return gallery.filter((g) => g.batchJobId === galleryBatchFilter);
    if (selectedFolder === null) return gallery;
    if (selectedFolder === FAV) return gallery.filter((g) => g.favorite);
    return gallery.filter((g) => g.folder === selectedFolder);
  }, [gallery, selectedFolder, galleryBatchFilter]);
  // ── paging ────────────────────────────────────────────────────────────────
  const [pageSize, setPageSize] = useState(100);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const v = localStorage.getItem("qwen.pageSize");
    if (v !== null) setPageSize(Number(v));
  }, []);
  useEffect(() => { localStorage.setItem("qwen.pageSize", String(pageSize)); }, [pageSize]);

  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(visibleImages.length / pageSize)) : 1;
  const pagedImages = useMemo(() => {
    if (pageSize <= 0) return visibleImages;
    const start = (page - 1) * pageSize;
    return visibleImages.slice(start, start + pageSize);
  }, [visibleImages, page, pageSize]);

  /**
   * Changing folder / batch filter / page size resets the view. The selection is
   * cleared with it: a selection carried over from a previous filter meant bulk
   * moves acted on images that were no longer on screen, which read as "move is
   * unreliable when a job filter is picked".
   */
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setAnchorRel(null);
  }, [selectedFolder, galleryBatchFilter, pageSize]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  /**
   * Selection is page-scoped: what you select is what you can see. Selecting 149
   * while the grid showed 100 made every bulk action reach off-screen images.
   * Crossing the whole filter is still possible, but only via an explicit link in
   * the selection bar.
   */
  const selectPage = useCallback(
    () => setSelected(new Set(pagedImages.map((g) => g.rel))),
    [pagedImages],
  );
  const selectEntireView = useCallback(
    () => setSelected(new Set(visibleImages.map((g) => g.rel))),
    [visibleImages],
  );
  const allPageSelected =
    pagedImages.length > 0 && pagedImages.every((g) => selected.has(g.rel));
  const allViewSelected =
    visibleImages.length > 0 && visibleImages.every((g) => selected.has(g.rel));

  // ⌘/Ctrl+A selects the visible set, unless a text field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "a" || !(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (pagedImages.length === 0) return;
      e.preventDefault();
      selectPage();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pagedImages, selectPage]);

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

    // Everything below is in page coords. Tile rects come back in viewport coords,
    // so they get the live scroll added before comparing.
    function recompute() {
      const px = lastClientRef.current.x + window.scrollX;
      const py = lastClientRef.current.y + window.scrollY;
      const rx0 = Math.min(x0, px), rx1 = Math.max(x0, px);
      const ry0 = Math.min(y0, py), ry1 = Math.max(y0, py);
      setMarquee((m) => (m ? { ...m, x1: px, y1: py } : m));
      const { additive, base } = marqueeBaseRef.current;
      const hits = new Set<string>(additive ? base : []);
      const sx = window.scrollX, sy = window.scrollY;
      gridRef.current?.querySelectorAll<HTMLElement>("[data-rel]").forEach((el) => {
        const r = el.getBoundingClientRect();
        const rel = el.getAttribute("data-rel");
        if (!rel) return;
        if (r.right + sx >= rx0 && r.left + sx <= rx1 && r.bottom + sy >= ry0 && r.top + sy <= ry1) hits.add(rel);
      });
      setSelected(hits);
    }
    // Pointer movement recomputes directly — the common path must never depend on
    // rAF, which is throttled to zero when the page isn't compositing.
    function onMove(e: MouseEvent) {
      lastClientRef.current = { x: e.clientX, y: e.clientY };
      recompute();
    }
    function onUp() { setMarquee(null); }
    function onScroll() { recompute(); }

    // Scrolling with the button held has to extend the box even though no
    // mousemove fires. Scroll events are not delivered in every host, so watch
    // the offset on rAF as well; the guard keeps it to real changes only.
    let raf = 0;
    let lastScroll = `${window.scrollX},${window.scrollY}`;
    const loop = () => {
      const now = `${window.scrollX},${window.scrollY}`;
      if (now !== lastScroll) {
        lastScroll = now;
        recompute();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("mouseup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll, true);
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
    for (const it of pagedImages) {
      const key = it.savedAt
        ? new Date(it.savedAt).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" })
        : "Undated";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return [...map.entries()];
  }, [pagedImages]);

  // folders the context-menu / move targets can use (everything except the item's own)
  const allFolderTargets = useMemo(() => ["", ...folders], [folders]);

  // ── voice → prompt ──────────────────────────────────────────────────────────
  async function transcribe(blob: Blob) {
    lastRecordingRef.current = blob;
    setTranscribing(true);
    setVoiceError(null);
    try {
      const form = new FormData();
      form.append("file", new File([blob], "rec.webm", { type: "audio/webm" }));
      // No `model` — the route resolves whatever the stt capability is pointed
      // at and sets it. Naming one here pinned voice input to whisper while the
      // picker said otherwise.
      const res = await fetch("/api/qwen/transcribe", { method: "POST", body: form });
      const data = await res.json();
      const text = (data.text ?? "").trim();
      if (text) {
        setPrompt((p) => (p.trim() ? p.trim() + " " : "") + text);
        lastRecordingRef.current = null;
      } else {
        // serviceId is the whole point: it turns "start its service" into a button.
        setVoiceError({
          message: data.error || "No speech detected.",
          serviceId: typeof data.serviceId === "string" ? data.serviceId : undefined,
          model: typeof data.model === "string" ? data.model : undefined,
        });
      }
    } catch {
      setVoiceError({ message: "Transcription failed — the console could not reach speech-to-text." });
    }
    setTranscribing(false);
  }

  /** Re-send the recording we kept, after the service behind it was started. */
  async function retryTranscription() {
    const blob = lastRecordingRef.current;
    if (!blob || transcribing) return;
    await transcribe(blob);
  }

  async function startRec() {
    setError(null);
    setVoiceError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // No serviceId — nothing on this box can fix a browser permission, so the
      // banner renders the sentence alone rather than an inert Start button.
      setVoiceError({ message: "Microphone access was denied. Allow it for this site in your browser, then try again." });
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
        aria-label={recording ? "Stop recording and transcribe" : "Dictate prompt with microphone"}
        className={`absolute top-2.5 right-2.5 h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs transition ${
          recording ? "bg-red-600 text-white animate-pulse shadow-[0_0_12px_rgba(239,68,68,0.4)]" : "bg-gray-700/70 hover:bg-gray-600 text-gray-300"
        } disabled:opacity-50`}
      >
        {transcribing ? (
          <span>transcribing…</span>
        ) : recording ? (
          <>
            <Square className="h-3.5 w-3.5" />
            <span className="tabular-nums">{(recMs / 1000).toFixed(1)}s</span>
          </>
        ) : (
          <Mic className="h-3.5 w-3.5" />
        )}
      </button>
    );
  }

  /** Shown directly under whichever prompt box the mic sits on. */
  function renderVoiceBanner() {
    if (!voiceError) return null;
    return (
      <VoiceErrorBanner
        error={voiceError}
        onRetry={retryTranscription}
        canRetry={!!lastRecordingRef.current}
        retrying={transcribing}
        onDismiss={() => setVoiceError(null)}
      />
    );
  }

  // Live server-side denoising progress ("step 12/24" + thin bar + elapsed).
  function renderStepProgress() {
    const p = serverProgress;
    if (busy && ownQueue) return <p className="text-xs text-amber-400 mt-2">Waiting for capacity: {ownQueue.lastDenial?.message || "Checking available resources…"}</p>;
    if (busy && activeModel.serviceId === "comfyui") return <p className="text-xs text-gray-400 mt-2">{ownLease ? `${activeModel.name} is loading or rendering in ComfyUI. The result will be saved to your selected gallery.` : "Checking capacity…"}</p>;
    // /progress is shared by all callers. An old 24/24 or another app's job
    // cannot be attributed to this UI request.
    if (busy && (!ownLease || !p?.started || p.started * 1000 < (requestRef.current?.started || 0))) {
      return <p className="text-xs text-gray-400 mt-2">{ownLease ? (mode === "edit" ? "Preparing the edit model; the generation model is unloaded automatically…" : "Preparing the image model…") : "Checking capacity…"}</p>;
    }
    if (p?.running && (p.phase === "load-model" || p.phase === "load-edit")) {
      return <p className="text-xs text-gray-400 mt-2">Loading {p.phase === "load-edit" ? "edit" : "generation"} checkpoint · {p.elapsed ?? 0}s. The other checkpoint is unloaded to make room.</p>;
    }
    if (!p || !p.running || !p.total) {
      return busy ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-gray-500">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
          Completing and saving the image…
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
  // The selected checkpoint and the shared process have independent statuses.
  const inEditMode = mode === "edit";
  const genModel = health?.model || "Qwen-Image";
  const editModel = health?.edit?.model || "Qwen-Image-Edit";
  const genResident = !!health?.up && !!health.loaded;
  const editResident = !!health?.up && !!health.edit?.loaded;
  // Loaded weights may be CPU-offloaded; this is not GPU residency.
  const activeResident = inEditMode ? editResident : genResident;
  const checkpoint = qwenCheckpointState(inEditMode, health,
    !!serverProgress?.running && serverProgress.phase === "load-edit");
  // Merges our own in-flight click with the manager reporting the process alive
  // while :8021 is still closed — see useServiceLifecycle for why both matter.
  const busyVerb = lifecycle.busyVerb;
  const dotColor = busyVerb
    ? "bg-amber-400"
    : !health
    ? "bg-gray-600"
    : health.up
      ? "bg-green-500"
      : "bg-red-500";
  const closeSetupDialog = useCallback(() => setSetupDialog(null), []);
  const runtimeName =
    activeModel.serviceId === "qwen"
      ? "Qwen-Image service"
      : activeModel.serviceId === "comfyui"
        ? "ComfyUI"
        : "AI Router";
  /**
   * What KIND of thing the runtime is, in plain words.
   *
   * The row used to be labelled "Runtime" for one model and "Shared service" for
   * another, so it never settled into a single idea you could learn once. It is
   * now always "Runs on", and this line says what that means here: a process on
   * this box that has to be alive, or someone else's machine reached through the
   * router. Everything else about the row — the dot, the status, the buttons —
   * follows from which of those two it is.
   */
  const runtimeKind =
    activeModel.serviceId === "qwen"
      ? "Local process · :8021 · serves Generate and Edit"
      : activeModel.serviceId === "comfyui"
        ? "Local process · :8188 · runs the workflow"
        : "Cloud · reached through the AI Router";
  /** The lifecycle behind the row's own Start/Stop; null for a cloud model. */
  const runtimeLifecycle =
    activeModel.serviceId === "comfyui" ? comfyLifecycle : activeModel.serviceId === "qwen" ? lifecycle : null;
  const runtimeReady =
    activeModel.serviceId === "qwen"
      ? !!health?.up
      : activeModel.serviceId === "comfyui"
        ? !!comfyHealth?.up
        : routerUp;
  const runtimeBusy =
    activeModel.serviceId === "qwen"
      ? busyVerb
      : activeModel.serviceId === "comfyui"
        ? comfyLifecycle.busyVerb
        : null;
  const runtimeDetail =
    activeModel.serviceId === "qwen"
      ? runtimeBusy
        ? runtimeBusy === "stop" ? "Stopping…" : runtimeBusy === "restart" ? "Restarting…" : "Starting…"
        : health?.up
          ? `Service online · ${health.latency}ms`
          : health ? "Service unavailable · Generate and Edit" : "Checking service…"
      : activeModel.serviceId === "comfyui"
        ? runtimeBusy
          ? runtimeBusy === "stop" ? "Stopping…" : runtimeBusy === "restart" ? "Restarting…" : "Starting…"
          : comfyHealth?.up
            ? `Running · ${activeModel.name}`
            : "Offline"
        : routerUp
          ? "Cloud · no local VRAM"
          : "Router offline";

  return (
    <div className="image-studio-grid">
      <aside className="image-runtime-rail" aria-label="Run setup">
        <section className="image-run-setup">
          <div className="image-run-setup-heading">
            <div>
              <p>Run setup</p>
              <span>{inEditMode ? "Which checkpoint, and where it runs" : "Which model, and where it runs"}</span>
            </div>
            <span className="is-mode">
              {inEditMode ? "Edit" : mode === "compare" ? "Compare" : "Generate"}
            </span>
          </div>
          <button type="button" className="image-run-setup-row" onClick={() => setSetupDialog("model")}>
            <span className="image-run-setup-icon" aria-hidden="true"><SlidersHorizontal className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1 text-left">
              <span className="image-run-setup-label">{inEditMode ? "Edit checkpoint" : "Generation model"}</span>
              <strong>{activeModel.serviceId === "qwen" ? checkpoint.name : activeModel.name}</strong>
              <span>{activeModel.serviceId === "qwen" ? checkpoint.status : activeModel.tier}</span>
            </span>
            <span className="image-run-setup-action">Change <ChevronRight className="h-3.5 w-3.5" /></span>
          </button>
          {/* Not a button any more: the row's own actions live ON it, and nesting
              them inside a button is both invalid and the wrong shape. Starting a
              runtime was two clicks and a modal over the thing you were trying to
              run — for the one action this row exists to enable. */}
          <div className="image-run-setup-row is-static">
            <span className="image-run-setup-icon" aria-hidden="true"><ServerCog className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1 text-left">
              <span className="image-run-setup-label">Runs on</span>
              <strong><span className={`image-run-setup-dot ${runtimeBusy ? "is-busy" : runtimeReady ? "is-ready" : "is-offline"}`} />{runtimeName}</strong>
              <span>{runtimeKind}</span>
            </span>
          </div>
          <div className="image-run-setup-actions">
            <span className="image-run-setup-status">{runtimeDetail}</span>
            {/* Start/Stop only. Restart, Logs and the checkpoint diagnostics are
                real but rarer, and the rail is a sidebar — they stay in Details. */}
            {runtimeLifecycle && (
              <ServiceControls
                lifecycle={runtimeLifecycle}
                actions={["stop"]}
                showLogs={false}
                stopTitle={
                  activeModel.serviceId === "qwen"
                    ? "Stop the shared service and unload its image checkpoint. Both Generate and Edit become unavailable."
                    : "Stop ComfyUI and free its VRAM."
                }
              />
            )}
            <button type="button" onClick={() => setSetupDialog("runtime")} className="image-run-setup-details">
              Details <ChevronRight className="h-3.5 w-3.5" />
            </button>
            {/* Only while it means something. A multi-minute weight load needs
                evidence it is progressing, and a start that died needs to say so
                here rather than behind Details. The plain "it's down" case is
                already the status line above. */}
            {runtimeLifecycle && (runtimeLifecycle.busyVerb === "start" || runtimeLifecycle.error) && (
              <ServiceStartupNote lifecycle={runtimeLifecycle} className="w-full" />
            )}
          </div>
          {activeModel.serviceId === "qwen" && <p className="image-run-setup-note">{checkpoint.note}</p>}
          {activeModel.serviceId === "comfyui" && <p className="image-run-setup-note">Weights load when you run and are released afterward when ComfyUI is idle. If capacity is unavailable, stop another GPU model from Details.</p>}
        </section>
      </aside>

      {setupDialog === "model" && (
        <StudioDialog
          title="Choose image model"
          description="Local models use this machine's GPU and RAM. Cloud models are billed by their provider."
          onClose={closeSetupDialog}
        >
      {/* ── MODEL PICKER ──
          Which backend Generate targets. These used to be two separate tabs
          ("Qwen Image" and "Creative"); the second had no gallery, no queue and
          lost its history on reload. The real difference between them is speed,
          so they're one surface with a picker.

          It leads the page because everything below follows from the answer:
          which service's health you see, and which modes are available. */}
      <div className="image-model-panel space-y-3" aria-label="Image model">
        <div className="flex items-center gap-2 pl-1">
          <span className="text-[10px] uppercase tracking-wide text-gray-600">Model</span>
          {/* Local vs cloud is a real split, not cosmetic: a local model is a
              process competing for one GPU, a cloud one is a key and a bill. */}
          <div className="ml-auto flex gap-1 rounded-lg bg-gray-900 border border-gray-800 p-0.5">
            {(["local", "cloud"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setModelTab(t)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                  modelTab === t ? "bg-gray-100 text-gray-900" : "text-gray-400 hover:text-gray-100"
                }`}
              >
                {t}
                {t === "cloud" && cloudModels.length ? ` (${cloudModels.length})` : ""}
              </button>
            ))}
          </div>
        </div>

        {modelTab === "local" && (
          <div className="flex gap-2 flex-wrap">
            {IMAGE_MODELS.map((m) => {
              const up = m.serviceId === "comfyui" ? comfyHealth?.up : health?.up;
              const active = m.id === imageModel;
              // Qwen is the router's local image model; FLUX has no alias, so
              // picking it moves the studio without moving the box.
              const alias = m.serviceId === "qwen" ? qwenAlias : null;
              return (
                <button
                  key={m.id}
                  onClick={() => { pickModel(m.id, alias); setSetupDialog(null); }}
                  aria-pressed={active}
                  disabled={routingBusy === m.id}
                  className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2 text-left transition ${
                    active
                      ? "border-pink-500/50 bg-pink-500/10"
                      : "border-gray-800 bg-gray-900 hover:border-gray-600"
                  }`}
                >
                  <span
                    title={up == null ? "checking service" : up ? "service running" : "service stopped"}
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${up ? "bg-emerald-500" : "bg-gray-600"}`}
                  />
                  <span>
                    <span className={`block text-sm font-medium ${active ? "text-gray-100" : "text-gray-300"}`}>{m.name}</span>
                    <span className="block text-[10px] text-gray-500">{m.tier}</span>
                    {/* One card, two models that can't both be resident — what each
                        costs belongs at the point you choose between them. */}
                    <ModelFootprint
                      footprint={imageFootprint(m.id)}
                      liveVramMb={m.serviceId === "qwen" ? liveMb.get(m.serviceId) : undefined}
                      className="mt-1"
                    />
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {modelTab === "cloud" && (
          !routerUp ? (
            <p className="text-xs text-gray-500 pl-1">AI Router is down — no cloud models can be listed.</p>
          ) : cloudModels.length === 0 ? (
            <p className="text-xs text-gray-500 pl-1">
              No cloud image models in the router. Add one to <code>config/ai-router.yaml</code>.
            </p>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {cloudModels.map((m) => {
                const active = m.id === imageModel;
                const keyMissing = m.status === "no-key";
                return (
                  <button
                    key={m.id}
                    onClick={() => { pickModel(m.id, m.id); setSetupDialog(null); }}
                    aria-pressed={active}
                    disabled={keyMissing || routingBusy === m.id}
                    title={keyMissing ? "This provider's API key is not set" : undefined}
                    className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2 text-left transition disabled:opacity-40 ${
                      active
                        ? "border-pink-500/50 bg-pink-500/10"
                        : "border-gray-800 bg-gray-900 hover:border-gray-600"
                    }`}
                  >
                    <span>
                      <span className={`block text-sm font-medium ${active ? "text-gray-100" : "text-gray-300"}`}>{m.id}</span>
                      <span className="block text-[10px] text-gray-500">
                        {m.provider}
                        {keyMissing ? " · needs an API key" : " · no VRAM, billed per image"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )
        )}

        {/* The pick is persisted routing, not a per-tab toggle: quote-forge and
            move-quest resolve the same file, so choosing a cloud model here sends
            their traffic off-box too. Worth saying out loud next to the button. */}
        <p className="pl-1 text-[10px] leading-snug text-gray-600">
          {routedImage ? (
            <>
              Box-wide image routing: <span className="text-gray-400">{routedImage}</span> — every caller on
              this box that asks for an image gets this model.
            </>
          ) : (
            "Saved box-wide — every caller on this box that asks for an image gets this model."
          )}
          {activeModel.serviceId === "comfyui" && " FLUX has no router alias, so it changes the studio only."}
        </p>
      </div>
        </StudioDialog>
      )}

      {setupDialog === "runtime" && (
        <StudioDialog
          title={`${runtimeName} controls`}
          description="Service lifecycle, live status, and checkpoint diagnostics for the selected model."
          onClose={closeSetupDialog}
        >
        <div className="image-runtime-dialog-stack">
      {/* ── HEALTH HEADER — Qwen-Image's own service ── */}
      {activeModel.serviceId === "qwen" && (
        <section className="image-service-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`w-2.5 h-2.5 rounded-full ${dotColor} ${busyVerb || (health?.up && !activeResident) ? "animate-pulse" : ""}`} />
            <span className="font-semibold text-sm">Qwen-Image service</span>
            <span className="text-xs text-gray-500">localhost:8021</span>
            {/* Process status only. Which CHECKPOINT is in VRAM is the row below —
                conflating the two is what made the two models look like one. */}
            {busyVerb ? (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                {busyVerb === "stop" ? "stopping…" : busyVerb === "restart" ? "restarting…" : "starting…"}
              </span>
            ) : health && (
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full ${
                  health.up ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
                }`}
              >
                {health.up ? "running · serves 2 checkpoints" : "offline"}
              </span>
            )}
            {health?.up && !busyVerb && <span className="text-[11px] text-gray-500 tabular-nums">{health.latency}ms ping</span>}

            {/* Right cluster: full service lifecycle, without leaving the studio */}
            <ServiceControls
              lifecycle={lifecycle}
              onRefresh={checkHealth}
              stopTitle="Stop the shared service and unload its image checkpoint. Both Generate and Edit become unavailable."
              className="ml-auto"
            />
          </div>

          {/* ── THE TWO CHECKPOINTS ──
              Both always visible, with the one this mode uses ringed. They are
              separate ~20B models sharing one process and one GPU: whichever you
              run evicts the other, which is why residency is per-checkpoint. */}
          <details className="group mt-3 rounded-lg border border-gray-800 bg-gray-950/25">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-medium text-gray-400 hover:text-gray-200">
              <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
              Checkpoint residency and swap behavior
              <span className="ml-auto text-[10px] text-gray-600">diagnostics</span>
            </summary>
          <div className="grid gap-2 border-t border-gray-800 p-3 sm:grid-cols-2">
            {([
              {
                name: genModel,
                modes: "Generate · Batch · Jobs",
                active: !inEditMode,
                resident: genResident,
                installed: true,
                tone: "pink",
                detail: !health?.up
                  ? "unknown — service offline"
                  : genResident
                    ? `loaded${health.mode ? ` · ${health.mode}` : ""}`
                    : "not loaded — loads on first run",
              },
              {
                name: editModel,
                modes: "Edit",
                active: inEditMode,
                resident: editResident,
                installed: editAvailable,
                tone: "purple",
                detail: !health?.up
                  ? "unknown — service offline"
                  : !editAvailable
                    ? "editing disabled on the server"
                    : editResident
                      ? "loaded · CPU offload"
                      : "not loaded — loads on first edit",
              },
            ] as const).map((c) => (
              <div
                key={c.modes}
                className={`rounded-lg border px-3 py-2 transition ${
                  c.active
                    ? c.tone === "purple"
                      ? "border-purple-500/60 bg-purple-500/5"
                      : "border-pink-500/60 bg-pink-500/5"
                    : "border-gray-800 bg-gray-800/30"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      !health?.up || !c.installed ? "bg-gray-600" : c.resident ? "bg-green-500" : "bg-yellow-500/70"
                    }`}
                  />
                  <span className={`text-xs font-medium ${c.active ? "text-gray-100" : "text-gray-400"}`}>{c.name}</span>
                  {c.active && (
                    <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 text-gray-900 font-bold">
                      this mode
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  {c.modes} · {c.detail}
                </p>
              </div>
            ))}
          </div>
          <p className="px-3 pb-3 text-[11px] text-gray-600">
            One process on :8021 serves both, keeping one checkpoint loaded with CPU offload — switching between Generate and Edit
            swaps the checkpoint on the next run, which is why the first request after a switch is slow.
          </p>
          </details>
          <ServiceStartupNote
            lifecycle={lifecycle}
            downMessage={`Server unreachable${health?.error ? ` — ${health.error}` : ""}.`}
            className="mt-2"
          />
        </section>
      )}

      {/* ── SERVICE HEADER — the backend the picker above just chose ──
          FLUX and Qwen-Image are different processes with different weights and
          different VRAM. Showing the Qwen service (and its two checkpoints) while
          FLUX was selected described a backend the studio wasn't about to call. */}
      {activeModel.serviceId === "comfyui" && (
        <section className="image-service-panel bg-gray-900 rounded-xl border border-gray-800 p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className={`w-2.5 h-2.5 rounded-full ${
              comfyLifecycle.busyVerb ? "bg-amber-400 animate-pulse"
              : !comfyHealth ? "bg-gray-600"
              : comfyHealth.up ? "bg-green-500"
              : "bg-red-500"
            }`} />
            <span className="font-semibold text-sm">ComfyUI</span>
            <span className="text-xs text-gray-500">localhost:8188</span>
            {comfyLifecycle.busyVerb ? (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                {comfyLifecycle.busyVerb === "stop" ? "stopping…" : comfyLifecycle.busyVerb === "restart" ? "restarting…" : "starting…"}
              </span>
            ) : comfyHealth && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${
                comfyHealth.up ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
              }`}>
                {comfyHealth.up ? `running · serves ${activeModel.name}` : "offline"}
              </span>
            )}
            <ServiceControls lifecycle={comfyLifecycle} onRefresh={checkComfy} className="ml-auto" />
          </div>
          <p className="mt-3 text-[11px] text-gray-600">
            {activeModel.name} is a workflow posted to ComfyUI on :8188 — a separate process from the
            Qwen-Image service, holding its own weights and its own VRAM.
          </p>
          <ServiceStartupNote
            lifecycle={comfyLifecycle}
            downMessage={`ComfyUI is not running${comfyHealth?.error ? ` — ${comfyHealth.error}` : ""}.`}
            className="mt-2"
          />
        </section>
      )}
      {activeModel.serviceId === null && (
        <section className="image-service-panel rounded-xl border border-gray-800 bg-gray-900 p-4">
          <div className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 rounded-full ${routerUp ? "bg-green-500" : "bg-red-500"}`} />
            <div>
              <p className="text-sm font-semibold">AI Router</p>
              <p className="text-xs text-gray-500">{routerUp ? "Online · the selected model runs off-box." : "Offline · cloud generation is unavailable."}</p>
            </div>
          </div>
        </section>
      )}
        </div>
        </StudioDialog>
      )}

      {/* ── MODE TOGGLE — grouped by model ──
          Generate / Batch / Jobs are three faces of the SAME Qwen-Image model;
          Edit is the separate Qwen-Image-Edit checkpoint that swaps into its VRAM.
          Two labelled groups make that split legible instead of implying four peers. */}
      <main className="image-workbench">
      <nav className="image-mode-nav" aria-label="Image workflow">
        <div className="image-mode-tabs" role="tablist">
          {(["generate", "edit", "batch", "compare", "jobs"] as const).map((mm) => {
            const disabled =
              (mm === "batch" && !activeModel.supportsBatch) ||
              (mm === "edit" && !activeModel.supportsEdit);
            return (
              <button
                key={mm}
                role="tab"
                aria-selected={mode === mm}
                onClick={() => setMode(mm)}
                disabled={disabled}
                title={
                  mm === "batch" && disabled
                    ? "Batch runs on Qwen-Image. Select Qwen-Image to use it."
                    : mm === "edit" && disabled
                      ? `${activeModel.name} has no image-edit endpoint.`
                      : undefined
                }
                className={mode === mm ? "is-active" : undefined}
              >
                <span className="capitalize">{mm}</span>
                {mm === "edit" && activeModel.serviceId === "qwen" && health?.up && !editAvailable && <span className="image-tab-note">Unavailable</span>}
                {mm === "jobs" && activeJobCount > 0 && <span className="image-tab-count">{activeJobCount}</span>}
              </button>
            );
          })}
        </div>
        <p className="image-mode-hint">
          {mode === "edit"
            ? activeModel.serviceId === "qwen" ? "Edit loads the separate Qwen-Image-Edit checkpoint on first run." : "FLUX.2 Klein uses the same checkpoint for generation and reference-image editing."
            : mode === "compare"
              ? "Run one prompt across several local and cloud models."
              : mode === "batch" || mode === "jobs"
                ? "Queue and manage multi-image Qwen-Image runs."
                : `Create with ${activeModel.name}.`}
        </p>
      </nav>

      <div className="image-mode-content">

      {mode === "compare" && <CompareView />}

      {/* ── INPUT PANEL (generate / edit) ── */}
      {mode !== "batch" && mode !== "jobs" && mode !== "compare" && (
      <section className="bg-gray-900 rounded-xl border border-gray-800 p-5 space-y-4">
        {mode === "edit" && (
          <div>
            <label className="text-xs text-gray-500 mb-2 block">Input images (choose gallery images or upload references)</label>
            <button type="button" onClick={() => { setGalleryPicker(true); setPickerFolder("__all__"); setPickerSearch(""); }} className="mb-3 border border-purple-600 rounded-lg px-3 py-2 text-sm text-purple-300">Choose from gallery</button>
            <p className="text-xs text-gray-500 mb-3">{activeModel.serviceId === "qwen" ? `Editing switches to ${health?.edit?.model || "Qwen-Image-Edit"} and unloads the generation model to make room.` : "Choose up to four reference images. Klein edits with its generation checkpoint; no second model is needed."}</p>
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

        {renderVoiceBanner()}

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
          {/* Distilled FLUX ignores guidance and negative conditioning, so the
              controls are hidden rather than left there doing nothing. */}
          {activeModel.supportsCfg && (
            <div className="flex items-center gap-2">
              <label className="text-gray-500">CFG</label>
              <input type="number" min={1} max={10} step={0.5} value={cfg} onChange={(e) => setCfg(Number(e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 tabular-nums" />
            </div>
          )}
          <button onClick={() => setAdvanced((a) => !a)} className="text-gray-500 hover:text-gray-300">
            {advanced ? "− less" : activeModel.supportsNegative ? "+ seed / negative" : "+ seed"}
          </button>
          {/* The button starts what it needs. It is disabled only for things it
              cannot fix itself — an empty prompt, no edit input, or a cloud model
              with the router down. "Your runtime is off" is not one of those. */}
          <button
            onClick={mode === "generate" ? runGenerate : runEdit}
            disabled={
              busy || startingRuntime || !prompt.trim() ||
              (mode === "edit" && editImages.length === 0) ||
              (activeModel.serviceId === null && !routerUp)
            }
            title={
              activeModel.serviceId === null && !routerUp
                ? "The AI Router is offline, so this cloud model can't be called."
                : !modelUp
                  ? `${runtimeName} isn't running — this will start it first.`
                  : undefined
            }
            className="ml-auto bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:hover:bg-pink-600 rounded-xl px-6 py-2.5 text-sm font-medium transition"
          >
            {startingRuntime
              ? `Starting ${runtimeName}…`
              : busy
                ? `Running… ${elapsed.toFixed(1)}s`
                : !modelUp && activeModel.serviceId !== null
                  ? `Start ${runtimeName} & ${mode === "generate" ? "Generate" : "Run Edit"}`
                  : mode === "generate" ? "Generate" : "Run Edit"}
          </button>
        </div>

        {advanced && (
          <div className="space-y-3 pt-1">
            {activeModel.supportsNegative && (
              <input
                value={negative}
                onChange={(e) => setNegative(e.target.value)}
                placeholder="Negative prompt — what to avoid (text, watermark, blurry…)"
                className="w-full bg-gray-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-pink-500/40 placeholder-gray-600"
              />
            )}
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

        <label className="flex items-center gap-3 text-xs text-gray-400">Save to gallery
          <select aria-label="Save to gallery" disabled={busy} value={outputFolder} onChange={(e) => { setSelectedFolder(e.target.value); setGalleryBatchFilter(null); }} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200">
            <option value="">Unfiled</option>
            {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
          </select>
        </label>
        {busy && <button onClick={() => requestRef.current?.controller.abort()} className="text-xs text-gray-400 underline">Stop waiting</button>}
        {busy && renderStepProgress()}
        {lastResult && <section aria-label="Latest image result" className="space-y-3 border border-gray-700 rounded-xl p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-green-400">{lastResult.saved ? "Saved to " + (lastResult.folder || "Unfiled") : "Image generated"}</p>
            {pinnedResults.length > 0 && (
              <button onClick={() => setPinnedResults([])} className="ml-auto text-[11px] text-gray-500 hover:text-gray-300 underline">
                Clear comparison
              </button>
            )}
          </div>

          {/* Side by side once there is something to compare against, full size
              until then — a lone result has no reason to be shrunk into a tile. */}
          <div className={pinnedResults.length ? "flex gap-3 overflow-x-auto pb-1" : ""}>
            {[lastResult, ...pinnedResults].map((r, i) => (
              <figure
                key={`${r.modelId}-${i}-${r.image.slice(-24)}`}
                className={pinnedResults.length ? `flex-shrink-0 w-56 rounded-lg border p-2 ${i === 0 ? "border-pink-500/50 bg-pink-500/5" : "border-gray-800 bg-gray-900/40"}` : ""}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.image}
                  alt={`Result from ${r.modelName}`}
                  className={pinnedResults.length ? "w-full rounded-md" : "max-h-80 rounded-lg"}
                />
                <figcaption className="mt-1.5 flex items-baseline gap-1.5 text-[11px]">
                  <span className={i === 0 ? "font-medium text-gray-100" : "text-gray-400"}>{r.modelName}</span>
                  <span className="text-gray-500 tabular-nums">{(r.latency / 1000).toFixed(1)}s · {r.steps} steps</span>
                </figcaption>
              </figure>
            ))}
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            <a href={lastResult.image} download="betenshi-image.png" className="text-xs underline">Download image</a>
            <button onClick={() => { setEditImages([lastResult.image]); if (!activeModel.supportsEdit) setImageModel("flux2-klein-4b"); setMode("edit"); setPrompt(""); }} className="text-sm text-purple-300">Edit this image</button>
          </div>

          {/* One prompt across models, one model at a time — the previous result
              stays on screen instead of living in your memory of it. */}
          <details className="group rounded-lg border border-gray-800 bg-gray-950/30">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px] font-medium text-gray-400 hover:text-gray-200">
              <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
              Run this same prompt on another model
              <span className="ml-auto text-[10px] text-gray-600">keeps this result beside it</span>
            </summary>
            <div className="flex flex-wrap gap-1.5 border-t border-gray-800 p-2.5">
              {rerunCandidates.map((m) => (
                <button
                  key={m.id}
                  onClick={() => rerunOn(m)}
                  disabled={busy || startingRuntime}
                  title={m.serviceId === null ? "Cloud model — billed by its provider" : "Local model — starts its runtime if it isn't running"}
                  className="rounded-lg border border-gray-800 bg-gray-900 px-2.5 py-1.5 text-left transition hover:border-gray-600 disabled:opacity-40"
                >
                  <span className="block text-[11px] font-medium text-gray-200">{m.name}</span>
                  <span className="block text-[10px] text-gray-500">{m.tier}</span>
                </button>
              ))}
            </div>
          </details>
        </section>}
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

          {/* ── Row 1: idea / manual list ── */}
          {batchVary === "manual" ? (
            <textarea
              value={batchManual}
              onChange={(e) => { setBatchManual(e.target.value); setBatchPrompts([]); }}
              placeholder={"One prompt per line — each line = one image.\n\nE.g.:\na lone lighthouse at dusk, cinematic, moody\nsame lighthouse at dawn, warm palette\n..."}
              rows={6}
              disabled={batchSubmitting}
              className="w-full bg-gray-800 rounded-xl px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-pink-500/50 placeholder-gray-600 resize-y disabled:opacity-60"
            />
          ) : (
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Base idea — the varier expands this into N distinct prompts."
                rows={2}
                disabled={batchSubmitting}
                className="w-full bg-gray-800 rounded-xl px-4 py-3 pr-28 text-sm focus:outline-none focus:ring-2 focus:ring-pink-500/50 placeholder-gray-500 resize-none disabled:opacity-60"
              />
              {!batchSubmitting && renderMic()}
            </div>
          )}

          {renderVoiceBanner()}

          {/* ── Row 2: count + vary ── */}
          <div className="flex items-center gap-2 flex-wrap text-xs text-gray-400">
            <span className="text-gray-600">Count</span>
            {[10, 25, 50, 100].map((n) => (
              <button key={n} onClick={() => setBatchCount(n)} disabled={batchSubmitting}
                className={`px-2 py-1 rounded-md border transition ${batchCount === n ? "bg-pink-600 border-pink-600 on-accent" : "border-gray-700 hover:border-gray-500"} disabled:opacity-50`}>
                {n}
              </button>
            ))}
            <input type="number" min={1} max={500} value={batchCount} disabled={batchSubmitting}
              onChange={(e) => setBatchCount(Math.max(1, Math.min(500, Number(e.target.value))))}
              className="w-14 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 tabular-nums" />

            <span className="text-gray-600 ml-2">Vary</span>
            <Select items={[]} value={batchVary} onValueChange={(v) => { if (!v) return; setBatchVary(v as typeof batchVary); setBatchPrompts([]); }} disabled={batchSubmitting}>
              <SelectTrigger className="h-7 bg-gray-800 border-gray-700 text-xs w-28"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                <SelectItem value="template">Template</SelectItem>
                <SelectItem value="ai">AI (LLM)</SelectItem>
                <SelectItem value="seed">Seed only</SelectItem>
                <SelectItem value="manual">Manual list</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* ── Row 3: quality + dims ── */}
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="text-gray-600">Size</span>
            <Select items={SIZE_ITEMS} value={`${width}x${height}`} disabled={batchSubmitting} onValueChange={(v) => { if (!v) return; const [w, h] = String(v).split("x").map(Number); setWidth(w); setHeight(h); }}>
              <SelectTrigger className="h-7 bg-gray-800 border-gray-700 text-xs w-36"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-gray-800 border-gray-700 text-gray-300">
                {SIZE_PRESETS.map((p) => <SelectItem key={p.label} value={`${p.w}x${p.h}`}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>

            <span className="text-gray-600 ml-2">Steps</span>
            <input type="number" min={1} max={50} value={steps} disabled={batchSubmitting}
              onChange={(e) => setSteps(Number(e.target.value))}
              className="w-12 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 tabular-nums" />

            {activeModel.supportsCfg && (
              <>
                <span className="text-gray-600 ml-1">CFG</span>
                <input type="number" min={1} max={20} step={0.5} value={cfg} disabled={batchSubmitting}
                  onChange={(e) => setCfg(Number(e.target.value))}
                  className="w-12 bg-gray-800 border border-gray-700 rounded-md px-2 py-1 tabular-nums" />
              </>
            )}

            {/* dims trigger — self-contained relative anchor */}
            {(batchVary === "template" || batchVary === "ai") && (() => {
              const activeDims = (["style", "lighting", "mood", "palette", "lens"] as DimKey[]).filter((d) => batchDims[d].on);
              const summary = activeDims.map((d) => batchDims[d].locked || d).join(" · ");
              return (
                <div className="relative ml-auto" ref={dimsPopRef}>
                  <button
                    onClick={() => setBatchDimsOpen((o) => !o)}
                    disabled={batchSubmitting}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition disabled:opacity-40 ${batchDimsOpen ? "border-pink-500/50 text-pink-300 bg-pink-500/10" : "border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200"}`}
                  >
                    <span className="max-w-[200px] truncate">{summary || "no dims"}</span>
                    <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform ${batchDimsOpen ? "rotate-180" : ""}`} />
                  </button>

                  {batchDimsOpen && (
                    <div className="absolute right-0 bottom-full mb-2 w-80 rounded-xl shadow-2xl p-3 space-y-2 z-30"
                      style={{ background: "rgb(20,20,28)", border: "1px solid rgba(255,255,255,0.1)" }}>
                      <p className="text-[10px] uppercase tracking-wider font-semibold pb-1" style={{ color: "rgba(255,255,255,0.35)" }}>Variation dimensions</p>
                      {(["style", "lighting", "mood", "palette", "lens"] as DimKey[]).map((dim) => {
                        const d = batchDims[dim];
                        const pool = DIM_POOLS[dim] as readonly string[];
                        return (
                          <div key={dim} className="flex items-center gap-2 text-xs">
                            <button
                              onClick={() => setBatchDims((prev) => ({ ...prev, [dim]: { ...prev[dim], on: !prev[dim].on } }))}
                              className={`w-7 h-3.5 rounded-full transition flex-shrink-0 ${d.on ? "bg-pink-500" : "bg-white/20"}`}
                            >
                              <span className={`block w-2.5 h-2.5 rounded-full bg-white mx-auto transition-transform ${d.on ? "translate-x-1" : "-translate-x-1"}`} />
                            </button>
                            <span className="w-12 flex-shrink-0 capitalize text-[11px]"
                              style={{ color: d.on ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.25)" }}>{dim}</span>
                            <Select
                              items={{ __rotate__: "rotate through all", ...Object.fromEntries(pool.map((v) => [v, v])) }}
                              value={d.locked || "__rotate__"} disabled={!d.on}
                              onValueChange={(v) => { setBatchDims((prev) => ({ ...prev, [dim]: { ...prev[dim], locked: v === "__rotate__" ? "" : (v ?? "") } })); setBatchPrompts([]); }}>
                              <SelectTrigger className="h-6 flex-1 min-w-0 text-[11px] transition"
                                style={d.on
                                  ? { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.85)" }
                                  : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.2)", opacity: 0.5 }}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-gray-900 border-gray-700 text-gray-200 text-xs max-h-52 overflow-y-auto">
                                <SelectItem value="__rotate__"><span className="italic" style={{ color: "rgba(255,255,255,0.4)" }}>rotate through all</span></SelectItem>
                                {pool.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      })}
                      <div className="pt-1.5" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                        <input
                          value={batchSuffix}
                          onChange={(e) => { setBatchSuffix(e.target.value); setBatchPrompts([]); }}
                          placeholder="Always append — e.g. 'shot on Kodak Portra, grain'"
                          className="w-full rounded-lg px-2.5 py-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-pink-500/40"
                          style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)" }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* ── Row 4: actions + preview ── */}
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={planPrompts} disabled={batchPlanning || batchSubmitting || !(batchVary === "manual" ? batchManual.trim() : prompt.trim())}
              className="text-xs border border-gray-700 hover:border-gray-500 text-gray-300 rounded-lg px-3 py-2 transition disabled:opacity-40 flex items-center gap-1">
              {batchPlanning ? "Planning…" : "Preview prompts"}
              {batchPrompts.length > 0 && !batchPlanning && (
                <span onClick={(e) => { e.stopPropagation(); setBatchShowPreview((p) => !p); }}
                  className="ml-1 text-gray-500 hover:text-gray-300">
                  {batchShowPreview ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </span>
              )}
            </button>
              <button onClick={submitBatch}
                disabled={!(batchVary === "manual" ? batchManual.trim() : prompt.trim()) || batchPlanning || batchSubmitting}
                className="bg-pink-600 hover:bg-pink-500 disabled:opacity-40 rounded-xl px-6 py-2.5 text-sm font-medium transition">
                {batchSubmitting ? "Queuing…" : `Queue batch (${batchVary === "manual" ? Math.min(batchCount, batchManual.split("\n").filter((l) => l.trim()).length) || batchCount : batchCount})`}
              </button>
          </div>

          {/* inline prompt preview */}
          {batchShowPreview && batchPrompts.length > 0 && (
            <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-3 space-y-1 max-h-52 overflow-y-auto">
              {batchPrompts.map((p, i) => (
                <p key={i} className="text-[11px] text-gray-400 font-mono leading-relaxed">
                  <span className="text-gray-600 select-none mr-2">{i + 1}.</span>{p}
                </p>
              ))}
            </div>
          )}


          {error && <div className="text-xs px-3 py-2 rounded-lg bg-red-500/10 text-red-400 border border-red-500/20">{error}</div>}

          {/* ── Jobs status link ── */}
          {activeJobCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-gray-500 border-t border-gray-800 pt-3">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              {activeJobCount} job{activeJobCount !== 1 ? "s" : ""} running
              <button onClick={() => setMode("jobs")} className="text-pink-400 hover:text-pink-300 underline underline-offset-2">
                View in Jobs →
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── JOBS PANEL ── */}
      {mode === "jobs" && (
        <section className="space-y-4">
          {/* Backend-down banner. Built from the inverting gray scale (see globals.css)
              plus red accents — the red palette does NOT invert, so red-on-red text
              is unreadable in light mode. */}
          {queueStatus && !queueStatus.backend.alive && (
            <div className="bg-gray-900 border border-red-500/40 rounded-xl p-4 flex items-start gap-3">
              <span className="mt-1.5 w-2 h-2 rounded-full bg-red-500 flex-shrink-0 animate-pulse" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-red-500">
                  Qwen-Image is down{queueCount > 0 && ` — ${queueCount} job${queueCount === 1 ? "" : "s"} held`}
                </p>
                <p className="text-xs text-gray-400 mt-1 leading-relaxed">
                  Nothing listening on <span className="font-mono text-gray-300">localhost:8021</span>.
                  Jobs keep their place and start on their own within 30s of the service coming up —
                  nothing is consumed or marked done while it&apos;s off.
                </p>
                {lifecycle.error && <p className="text-xs text-red-500 mt-2 font-mono break-all">{lifecycle.error}</p>}
                {queueStatus.parked && (
                  <p className="text-[11px] text-gray-600 mt-1 tabular-nums">
                    held since {new Date(queueStatus.parked.since).toLocaleTimeString()}
                  </p>
                )}
              </div>
              <button onClick={() => lifecycle.run("start")} disabled={!!lifecycle.busyVerb}
                className="flex-shrink-0 text-xs font-medium bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white rounded-lg px-3 py-2 transition cursor-pointer">
                {lifecycle.busyVerb ? "Starting…" : "Start service"}
              </button>
            </div>
          )}

          {/* Overall status header — always visible; the lists below collapse under it */}
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <button
              onClick={() => setJobsExpanded((v) => !v)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/40 transition cursor-pointer">
              <span className={`text-gray-600 text-[10px] flex-shrink-0 transition-transform ${jobsExpanded ? "rotate-90" : ""}`}>▶</span>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                runCount > 0 ? "bg-amber-400 animate-pulse"
                  : queueCount > 0 ? "bg-blue-400"
                  : failedCount > 0 ? "bg-red-500"
                  : jobs.length > 0 ? "bg-green-500" : "bg-gray-600"}`} />
              <span className="text-sm font-medium text-gray-200 flex-shrink-0">
                {runCount > 0 ? "Running" : queueCount > 0 ? "Queued" : pauseCount > 0 ? "Paused" : failedCount > 0 ? "Finished with failures" : jobs.length > 0 ? "All done" : "No jobs"}
              </span>
              {summaryParts && <span className="text-xs text-gray-500 tabular-nums truncate">{summaryParts}</span>}
              {!jobsExpanded && runningJob && (
                <span className="text-xs text-gray-600 truncate hidden sm:inline">— {runningJob.idea}</span>
              )}
              {jobTotals.total > 0 && (
                <span className="ml-auto flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-gray-500 tabular-nums">{jobTotals.completed}/{jobTotals.total} images</span>
                  <span className="w-20 h-1 rounded-full bg-gray-800 overflow-hidden hidden sm:block">
                    <span className="block h-full bg-pink-500 transition-all" style={{ width: `${jobTotals.pct}%` }} />
                  </span>
                </span>
              )}
            </button>
            {/* One toolbar. Every control is conditional on being meaningful right
                now — no "Start everything" offered while it is already running. */}
            {jobsExpanded && (
              <div className="px-4 pb-3 pt-1 flex items-center gap-2 flex-wrap border-t border-gray-800/60">
                {jobs.length === 0 && (
                  <span className="text-sm text-gray-600 py-1.5">
                    No jobs yet — use the <button onClick={() => setMode("batch")} className="text-gray-400 underline underline-offset-2">Batch tab</button> to queue one.
                  </span>
                )}

                {(runCount > 0 || queueCount > 0) && (
                  <button
                    onClick={() => fetch("/api/qwen/jobs/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause-all" }) }).then(refreshJobs)}
                    className="text-xs border border-violet-600/40 text-violet-400 hover:text-violet-300 hover:border-violet-500 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    ⏸ Pause all
                  </button>
                )}
                {pauseCount > 0 && (
                  <button
                    onClick={() => fetch("/api/qwen/jobs/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume-all" }) }).then(refreshJobs)}
                    className="text-xs border border-violet-600/40 text-violet-300 hover:text-violet-200 hover:border-violet-500 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    ▶ Resume {pauseCount}
                  </button>
                )}
                {failedCount > 0 && (
                  <button
                    onClick={() => fetch("/api/qwen/jobs/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry-failed" }) }).then(refreshJobs)}
                    className="text-xs border border-red-700/40 text-red-400 hover:text-red-300 hover:border-red-600 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    ↻ Retry {failedCount} failed
                  </button>
                )}
                {queueCount > 0 && (
                  <button onClick={() => setConfirmBulkCancelQueued(true)}
                    className="text-xs border border-gray-700 text-gray-400 hover:text-red-400 hover:border-red-700/50 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    ✕ Cancel queued
                  </button>
                )}
                {completedJobs.length > 0 && (
                  <button onClick={() => setConfirmClearCompleted(true)}
                    className="text-xs border border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    Clear done
                  </button>
                )}

                {/* GPU: exactly one action, chosen by whether the model is loaded */}
                {queueStatus && (
                  <span className="ml-auto flex items-center gap-2">
                    {queueStatus.backend.alive ? (
                      <button
                        onClick={() => stackAction("free")}
                        disabled={stackBusy !== null}
                        title="Pause every job and unload Qwen-Image — releases ~36 GB. Jobs hold at their cursor."
                        className="text-xs border border-gray-700 text-gray-400 hover:text-gray-100 hover:border-gray-500 rounded-lg px-3 py-1.5 transition disabled:opacity-50 cursor-pointer">
                        {stackBusy === "free" ? "Freeing…" : "⏏ Free GPU"}
                      </button>
                    ) : (
                      <button
                        onClick={() => stackAction("start")}
                        disabled={stackBusy !== null}
                        title="Load Qwen-Image and resume every held job from its cursor"
                        className="text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg px-3 py-1.5 transition disabled:opacity-50 cursor-pointer">
                        {stackBusy === "start" ? "Starting…" : "▶ Start everything"}
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Active jobs */}
          {jobsExpanded && activeJobs.length > 0 && (
            <div className="space-y-3">
              {(() => {
                const queuedIds = jobs.filter((j) => j.status === "queued").map((j) => j.id);
                return activeJobs.map((job) => {
                  const isRunning = job.status === "running";
                  const isQueued = job.status === "queued";
                  const isPaused = job.status === "paused";
                  const queuePos = queuedIds.indexOf(job.id);
                  const elapsedSec = job.startedAt ? Math.floor((Date.now() - new Date(job.startedAt).getTime()) / 1000) : 0;
                  const avgSecPerImage = job.completed > 0 && elapsedSec > 0 ? elapsedSec / job.completed : null;
                  const etaSec = avgSecPerImage ? Math.round((job.total - job.completed) * avgSecPerImage) : null;
                  const isExpanded = expandedJob === job.id;
                  const currentPrompt = isRunning && job.currentIndex != null ? job.prompts?.[job.currentIndex] : null;
                  const sp = serverProgress;
                  const showStepProgress = isRunning && sp?.running && (sp.total ?? 0) > 0;
                  const dotColor = isRunning ? "bg-amber-400 animate-pulse" : isQueued ? "bg-blue-400" : "bg-violet-400";
                  const statusLabel = isRunning ? "RUNNING" : isQueued ? `QUEUED #${queuePos + 1}` : "PAUSED";
                  const statusColor = isRunning ? "text-amber-400" : isQueued ? "text-blue-400" : "text-violet-400";
                  const borderColor = isRunning ? "border-amber-400/25" : isQueued ? "border-gray-800" : "border-violet-500/40";

                  return (
                    <div key={job.id} className={`bg-gray-900 rounded-xl border overflow-hidden ${borderColor} ${isPaused ? "opacity-70 border-l-2 border-l-violet-500" : ""}`}>
                      {/* Header */}
                      <div className="flex items-center gap-3 px-4 py-3">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <span className={`text-[10px] font-semibold tracking-wider flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
                            <span className="text-sm text-gray-200 truncate">{job.idea}</span>
                          </div>
                          {isQueued && job.params && (
                            <p className="text-[11px] text-gray-600 mt-0.5">
                              Waiting its turn · {getImageModel(job.params.model).name} · {job.total} imgs · {job.params.width}×{job.params.height} · {job.params.steps}st
                              {getImageModel(job.params.model).supportsCfg ? ` · cfg ${job.params.cfg}` : ""}
                            </p>
                          )}
                          {isPaused && (
                            <p className="text-[11px] text-violet-400/70 mt-0.5">
                              Held at {job.completed}/{job.total} — skipped by the queue until you press ▶
                            </p>
                          )}
                        </div>

                        {/* Elapsed */}
                        {(isRunning || isPaused) && job.startedAt && (
                          <span className="text-xs text-gray-600 tabular-nums flex-shrink-0">{fmtDur(elapsedSec)}</span>
                        )}

                        {/* Reorder for queued */}
                        {isQueued && (
                          <div className="flex flex-col gap-px flex-shrink-0">
                            <button onClick={() => fetch(`/api/qwen/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reorder", dir: "up" }) }).then(refreshJobs)}
                              disabled={queuePos <= 0}
                              className="text-gray-600 hover:text-gray-300 disabled:opacity-20 px-1 text-[11px] cursor-pointer disabled:cursor-not-allowed">▲</button>
                            <button onClick={() => fetch(`/api/qwen/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reorder", dir: "down" }) }).then(refreshJobs)}
                              disabled={queuePos < 0 || queuePos >= queuedIds.length - 1}
                              className="text-gray-600 hover:text-gray-300 disabled:opacity-20 px-1 text-[11px] cursor-pointer disabled:cursor-not-allowed">▼</button>
                          </div>
                        )}

                        {/* Progress count */}
                        <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">
                          {job.completed}/{job.total}
                          {job.failed > 0 && <span className="text-red-400"> · {job.failed}✗</span>}
                        </span>

                        {/* Pause / Resume */}
                        {(isRunning || isQueued) && (
                          <button onClick={() => fetch(`/api/qwen/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause" }) }).then(refreshJobs)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-700 text-gray-500 hover:text-violet-400 hover:border-violet-500/40 transition flex-shrink-0 cursor-pointer" title="Pause">⏸</button>
                        )}
                        {isPaused && (
                          <button onClick={() => fetch(`/api/qwen/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resume" }) }).then(refreshJobs)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg border border-violet-500/40 text-violet-400 hover:text-violet-200 hover:border-violet-400 transition flex-shrink-0 cursor-pointer" title="Resume">▶</button>
                        )}

                        {/* Cancel */}
                        <button onClick={() => setConfirmCancelJob(job.id)}
                          className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-800 text-gray-600 hover:text-red-400 hover:border-red-700/40 transition flex-shrink-0 cursor-pointer" title="Cancel">✕</button>
                      </div>

                      {/* Image progress bar */}
                      <div className="h-1 bg-gray-800">
                        <div className={`h-full transition-all ${isRunning ? "bg-amber-400/60" : isQueued ? "bg-blue-400/30" : "bg-violet-400/30"}`}
                          style={{ width: `${Math.min(100, (job.completed / Math.max(job.total, 1)) * 100)}%` }} />
                      </div>

                      {/* Running detail */}
                      {isRunning && (
                        <div className="px-4 py-3 space-y-2.5">
                          {/* Image progress label + ETA */}
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-400">Images {job.completed} / {job.total}</span>
                            {etaSec && etaSec > 0 && <span className="text-gray-600 tabular-nums">~{fmtDur(etaSec)} remaining</span>}
                          </div>

                          {/* Denoising step */}
                          {showStepProgress ? (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between text-[11px]">
                                <span className="text-gray-500">
                                  {sp!.step === 0 ? "Preparing · encoding prompt…" : `Step ${sp!.step} / ${sp!.total}`}
                                </span>
                                <span className="text-gray-700 tabular-nums">{sp!.elapsed ?? 0}s</span>
                              </div>
                              <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                                <div className="h-full bg-amber-400/70 rounded-full transition-all"
                                  style={{ width: sp!.step === 0 ? "5%" : `${Math.round((sp!.step / sp!.total!) * 100)}%` }} />
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-[11px] text-gray-700">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/40 animate-pulse" />
                              waiting for denoising to start…
                            </div>
                          )}

                          {/* Current prompt */}
                          {currentPrompt && (
                            <p className="text-[11px] text-gray-500 font-mono line-clamp-2 leading-relaxed">{currentPrompt}</p>
                          )}

                          {/* Expand prompts */}
                          <button onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                            className="text-[11px] text-gray-600 hover:text-gray-400 transition flex items-center gap-1 cursor-pointer">
                            {isExpanded ? "▲ Hide prompts" : `▼ All ${job.total} prompts`}
                          </button>
                        </div>
                      )}

                      {/* Paused detail */}
                      {isPaused && (
                        <div className="px-4 py-2">
                          <button onClick={() => setExpandedJob(isExpanded ? null : job.id)}
                            className="text-[11px] text-gray-600 hover:text-gray-400 transition cursor-pointer">
                            {isExpanded ? "▲ Hide prompts" : `▼ ${job.total} prompts · ${job.completed} done`}
                          </button>
                        </div>
                      )}

                      {/* Expanded prompts */}
                      {isExpanded && (
                        <div className="border-t border-gray-800 px-4 py-3 space-y-1 max-h-56 overflow-y-auto">
                          {(job.prompts ?? []).map((p, i) => {
                            const done = i < job.completed;
                            const active = isRunning && i === job.currentIndex;
                            return (
                              <div key={i} className="flex items-start gap-2 text-[11px]">
                                <span className={`flex-shrink-0 w-4 text-center font-mono ${done ? "text-green-400" : active ? "text-amber-400" : "text-gray-700"}`}>
                                  {done ? "✓" : active ? "▶" : String(i + 1)}
                                </span>
                                <span className={`font-mono leading-snug ${done ? "text-gray-600 line-through decoration-gray-700" : active ? "text-amber-200/90" : "text-gray-500"}`}>{p}</span>
                              </div>
                            );
                          })}
                          {job.lastError && (
                            <p className="pt-1 text-[10px] text-red-400/80 border-t border-gray-800">{job.lastError}</p>
                          )}
                        </div>
                      )}

                      {/* Error */}
                      {job.lastError && !isRunning && !isExpanded && (
                        <div className="border-t border-gray-800 px-4 py-2">
                          <p className="text-[11px] text-red-400/80 truncate">{job.lastError}</p>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}

          {/* Completed jobs — own collapse, since this list gets long */}
          {jobsExpanded && completedJobs.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <button onClick={() => setCompletedExpanded((v) => !v)}
                  className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-gray-600 hover:text-gray-400 font-semibold transition cursor-pointer">
                  <span className={`text-[9px] transition-transform ${completedExpanded ? "rotate-90" : ""}`}>▶</span>
                  Completed ({completedJobs.length})
                  {failedCount > 0 && <span className="text-red-500 normal-case tracking-normal">· {failedCount} failed</span>}
                </button>
                <button onClick={() => setConfirmClearCompleted(true)}
                  className="text-[11px] text-gray-600 hover:text-red-400 transition cursor-pointer">clear all</button>
              </div>
              {completedExpanded && completedJobs.map((job) => {
                const isDone = job.status === "done";
                const isFailed = job.status === "failed";
                const duration = job.startedAt && job.doneAt
                  ? Math.floor((new Date(job.doneAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
                  : null;
                return (
                  <div key={job.id} onClick={() => setDetailJobId(job.id)}
                    className="flex items-center gap-3 bg-gray-900/50 rounded-lg px-3 py-2 border border-gray-800/50 group cursor-pointer hover:border-gray-700 hover:bg-gray-900/80 transition">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isDone ? "bg-green-500" : isFailed ? "bg-red-500" : "bg-gray-600"}`} />
                    <span className="text-xs text-gray-400 truncate flex-1">{job.idea}</span>
                    <span className={`text-[11px] tabular-nums flex-shrink-0 ${isFailed ? "text-red-400" : "text-gray-600"}`}>{job.completed}/{job.total}</span>
                    {isFailed && <span className="text-[10px] font-semibold tracking-wider text-red-500 flex-shrink-0">FAILED</span>}
                    {duration != null && <span className="text-[11px] text-gray-700 tabular-nums flex-shrink-0">{fmtDur(duration)}</span>}
                    {(isDone || (isFailed && job.completed > 0)) && (
                      <button onClick={(e) => {
                        e.stopPropagation();
                        setGalleryBatchFilter(job.id);
                        setSelectedFolder(null);
                        galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                        className="text-[11px] text-blue-400 hover:text-blue-300 transition flex-shrink-0 opacity-0 group-hover:opacity-100 cursor-pointer">
                        images →
                      </button>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteJob(job.id); }}
                      title="Delete this job permanently"
                      className="text-[11px] text-gray-700 hover:text-red-400 transition flex-shrink-0 opacity-0 group-hover:opacity-100 cursor-pointer">✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {galleryPicker && <div role="dialog" aria-modal="true" aria-label="Choose an image to edit" className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
        <section className="bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-4xl max-h-[85vh] overflow-auto space-y-4">
          <div className="flex justify-between"><h2>Choose an image to edit</h2><button onClick={() => setGalleryPicker(false)}>Close picker</button></div>
          <div className="flex gap-3">
            <input aria-label="Search gallery images" placeholder="Search prompts…" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} className="bg-gray-800 rounded px-3 py-2 flex-1" />
            <select aria-label="Input gallery" value={pickerFolder} onChange={(e) => setPickerFolder(e.target.value)} className="bg-gray-800 rounded px-3 py-2">
              <option value="__all__">All images</option><option value="">Unfiled</option>
              {folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}
            </select>
          </div>
          {loadingReference && <p>Loading image…</p>}
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {gallery.filter((item) => (pickerFolder === "__all__" || item.folder === pickerFolder) && item.prompt.toLowerCase().includes(pickerSearch.toLowerCase())).slice(0, 100).map((item) => <button key={item.rel} disabled={loadingReference} onClick={() => void sendToEdit(item)} className="text-left text-xs space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img loading="lazy" src={item.url} alt={item.prompt || item.file} className="aspect-square object-cover rounded" /><span className="line-clamp-2">{item.prompt || item.file}</span>
            </button>)}
          </div>
          <p className="text-xs text-gray-500">Showing up to 100 matches. Search or choose a gallery to narrow the list.</p>
        </section>
      </div>}
      {/* ── HISTORY GALLERY (disk-backed, foldered) ── */}
      </div>
      </main>

      <section ref={galleryRef} className="image-history-panel">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            History {gallery.length > 0 && <span className="text-gray-600">({gallery.length})</span>}
          </h2>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {pagedImages.length > 0 && (
              <button
                onClick={() => (allPageSelected ? clearSelection() : selectPage())}
                title="⌘/Ctrl+A — selects what's on this page"
                className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
                {allPageSelected
                  ? "Deselect"
                  : pageCount > 1 ? `Select page (${pagedImages.length})` : `Select all (${pagedImages.length})`}
              </button>
            )}
            {rescanResult && <span className="text-[11px] text-gray-500">{rescanResult}</span>}
            <button onClick={rescanDisk} disabled={rescanning}
              title="Re-sync the index with the files actually on disk"
              className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition disabled:opacity-50">
              {rescanning ? "Rescanning…" : "Rescan disk"}
            </button>
            <button onClick={refreshGallery} className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition">
              Refresh
            </button>
          </div>
        </div>

        {galleryLoading ? (
          <p className="text-sm text-gray-600">Loading history…</p>
        ) : (
          <div className="flex flex-col gap-5 items-start lg:flex-row">
            {/* folder sidebar */}
            <aside className="w-full flex-shrink-0 space-y-1 rounded-xl border border-gray-800 bg-gray-900/40 p-2 lg:w-48 lg:border-0 lg:bg-transparent lg:p-0">
              <div className="flex items-center justify-between mb-1 px-1">
                <span className="text-[11px] uppercase tracking-wider text-gray-600">Galleries</span>
                <button onClick={() => { setNewFolderName(""); setNewFolderOpen(true); }} title="New folder (created inside the selected one)"
                  className="text-gray-400 hover:text-gray-100 text-base leading-none">＋</button>
              </div>

              {/* Batch filter badge */}
              {galleryBatchFilter && (
                <button onClick={() => setGalleryBatchFilter(null)}
                  className="w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between bg-amber-500/10 text-amber-300 border border-amber-500/20 mb-1">
                  <span className="truncate">Batch: {jobs.find((j) => j.id === galleryBatchFilter)?.idea?.slice(0, 22) || "…"}</span>
                  <span className="text-amber-400 ml-1 flex-shrink-0">✕</span>
                </button>
              )}

              <button onClick={() => { setSelectedFolder(null); setGalleryBatchFilter(null); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${!galleryBatchFilter && selectedFolder === null ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"}`}>
                <span>All images</span><span className="text-gray-600">{gallery.length}</span>
              </button>

              <button onClick={() => { setSelectedFolder(FAV); setGalleryBatchFilter(null); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${!galleryBatchFilter && selectedFolder === FAV ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"}`}>
                <span>★ Favorites</span><span className="text-gray-600">{favCount}</span>
              </button>

              <button onClick={() => { setSelectedFolder(""); setGalleryBatchFilter(null); }}
                onDragOver={(e) => { e.preventDefault(); setDropTarget(""); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => { e.preventDefault(); dropToFolder(""); }}
                className={`w-full text-left text-xs px-2 py-1.5 rounded-lg flex items-center justify-between transition ${!galleryBatchFilter && selectedFolder === "" ? "bg-pink-600/20 text-pink-300" : "text-gray-300 hover:bg-gray-800"} ${dropTarget === "" ? "ring-1 ring-pink-500 bg-pink-500/10" : ""}`}>
                <span>Unfiled</span><span className="text-gray-600">{folderCounts.get("") ?? 0}</span>
              </button>

              {folders.map((f) => {
                const depth = f.split("/").length - 1;
                const name = f.slice(f.lastIndexOf("/") + 1);
                return (
                  <div key={f} className="group/folder flex items-center"
                    onContextMenu={(e) => { e.preventDefault(); setFolderMenu({ x: e.clientX, y: e.clientY, folder: f }); }}
                    onDragOver={(e) => { e.preventDefault(); setDropTarget(f); }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => { e.preventDefault(); dropToFolder(f); }}>
                    <button onClick={() => { setSelectedFolder(f); setGalleryBatchFilter(null); }} style={{ paddingLeft: 8 + depth * 12 }}
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
                    : galleryBatchFilter
                      ? "No images from this batch yet. They'll appear here as they're generated."
                      : selectedFolder === ""
                        ? "All images are filed into folders. Switch to All images to see everything."
                        : "This gallery is empty. Drag images here or right-click an image to move it."}
                </p>
              ) : (
                <div className="space-y-8">
                  {/* Pager — page size is remembered across reloads */}
                  <div className="flex items-center gap-2 text-[11px] text-gray-500 flex-wrap">
                    <span className="tabular-nums">
                      {pageSize > 0
                        ? `${(page - 1) * pageSize + 1}–${(page - 1) * pageSize + pagedImages.length} of ${visibleImages.length}`
                        : `all ${visibleImages.length}`}
                    </span>
                    <span className="text-gray-700 hidden lg:inline">· shift-drag anywhere to rubber-band select</span>
                    {pageCount > 1 && (
                      <span className="flex items-center gap-1">
                        <button onClick={() => setPage(1)} disabled={page === 1}
                          className="px-1.5 py-0.5 rounded border border-gray-700 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 transition">«</button>
                        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                          className="px-1.5 py-0.5 rounded border border-gray-700 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 transition">‹</button>
                        <span className="px-1 tabular-nums text-gray-400">{page} / {pageCount}</span>
                        <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page === pageCount}
                          className="px-1.5 py-0.5 rounded border border-gray-700 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 transition">›</button>
                        <button onClick={() => setPage(pageCount)} disabled={page === pageCount}
                          className="px-1.5 py-0.5 rounded border border-gray-700 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 transition">»</button>
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1.5">
                      per page
                      {[50, 100, 250, 500, 0].map((n) => (
                        <button key={n} onClick={() => setPageSize(n)}
                          className={`px-1.5 py-0.5 rounded border transition tabular-nums ${
                            pageSize === n
                              ? "border-pink-500/50 bg-pink-600/15 text-pink-300"
                              : "border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-500"}`}>
                          {n === 0 ? "all" : n}
                        </button>
                      ))}
                    </span>
                  </div>
                  {selected.size > 0 && (
                    <div className="flex items-center gap-3 bg-pink-600/10 border border-pink-600/30 rounded-xl px-4 py-2 text-xs sticky top-[52px] z-[2] backdrop-blur-sm">
                      <span className="text-pink-300 font-medium">{selected.size} selected</span>
                      {!allPageSelected && pagedImages.length > selected.size && (
                        <button onClick={selectPage}
                          className="text-pink-300 hover:text-pink-200 underline underline-offset-2">
                          Select page ({pagedImages.length})
                        </button>
                      )}
                      {pageCount > 1 && !allViewSelected && (
                        <button onClick={selectEntireView}
                          title="Reaches past this page — every image in the current folder or batch"
                          className="text-pink-300/70 hover:text-pink-200 underline underline-offset-2">
                          Select all {visibleImages.length} across pages
                        </button>
                      )}
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
                        onClick={favoriteSelected}
                        disabled={!!bulkProgress}
                        className="text-yellow-400 hover:text-yellow-300 border border-yellow-600/30 rounded-md px-2 py-1 disabled:opacity-50"
                      >★ Favorite</button>
                      {bulkProgress && (
                        <span className="text-gray-400 tabular-nums">
                          {bulkProgress.label} {bulkProgress.done}/{bulkProgress.total}…
                        </span>
                      )}
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
                              className={`absolute top-1.5 left-1.5 w-6 h-6 rounded-md flex items-center justify-center text-xs transition border ${sel ? "bg-pink-600 border-pink-500 on-accent opacity-100" : "backdrop-blur-md bg-white/10 border-white/20 text-white opacity-0 group-hover:opacity-100"}`}>
                              {sel ? "✓" : ""}
                            </button>

                            {/* favorite + delete */}
                            <div className="absolute top-1.5 right-1.5 flex gap-1">
                              <button onClick={(e) => { e.stopPropagation(); toggleFavorite(it); }} title="Favorite (f)"
                                className={`w-7 h-7 rounded-lg backdrop-blur-md border flex items-center justify-center transition ${it.favorite ? "bg-amber-400/25 border-amber-400/40 text-amber-300 opacity-100" : "bg-white/10 border-white/20 text-white/60 opacity-0 group-hover:opacity-100 hover:bg-amber-400/20 hover:border-amber-400/30 hover:text-amber-300"}`}>
                                <Star className={`w-3.5 h-3.5 ${it.favorite ? "fill-amber-300" : ""}`} />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(it); }} title="Delete"
                                className="w-7 h-7 rounded-lg backdrop-blur-md bg-white/10 border border-white/20 text-white/60 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500/30 hover:border-red-400/40 hover:text-red-300 transition">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            <div className="p-2">
                              <p className="text-[11px] text-gray-400 line-clamp-1" title={it.prompt}>{it.prompt || <span className="italic text-gray-600">no prompt</span>}</p>
                              {it.model && <p className="text-[11px] font-medium mt-1">{IMAGE_MODELS.find(m => m.id === it.model)?.name || it.model}{it.latency != null ? ` · ${(it.latency / 1000).toFixed(1)}s` : ""}</p>}
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
                {/* The gallery mixes models now, so a bare "28st · cfg4" is ambiguous. */}
                <span className="text-gray-400">{lightbox.kind === "edit" ? lightbox.model : getImageModel(lightbox.model).name}</span>
                {lightbox.width && lightbox.height && <span>{lightbox.width}×{lightbox.height}</span>}
                {lightbox.seed != null && <span>seed {lightbox.seed}</span>}
                {lightbox.steps != null && (
                  <span>{lightbox.steps}st{getImageModel(lightbox.model).supportsCfg && lightbox.cfg != null ? ` · cfg${lightbox.cfg}` : ""}</span>
                )}
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

      {/* ── FOLDER CONTEXT MENU ── */}
      {folderMenu && (
        <div className="fixed inset-0 z-[55]" onClick={() => setFolderMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFolderMenu(null); }}>
          <div
            className="absolute bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px] text-xs"
            style={{ left: Math.min(folderMenu.x, window.innerWidth - 200), top: Math.min(folderMenu.y, window.innerHeight - 140) }}
            onClick={(e) => e.stopPropagation()}>
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600 truncate">📁 {folderMenu.folder}</div>
            <button onClick={() => revealFolder(folderMenu.folder)}
              className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-gray-800 transition">
              Reveal in Explorer
            </button>
            <button onClick={() => { const f = folderMenu.folder; setFolderMenu(null); setSelectedFolder(f); setGalleryBatchFilter(null); }}
              className="w-full text-left px-3 py-1.5 text-gray-300 hover:bg-gray-800 transition">
              Show only this folder
            </button>
            <div className="my-1 border-t border-gray-800" />
            <button onClick={() => { const f = folderMenu.folder; setFolderMenu(null); setConfirmFolderDelete(f); }}
              className="w-full text-left px-3 py-1.5 text-red-400 hover:bg-gray-800 transition">
              Delete folder…
            </button>
          </div>
        </div>
      )}

      {/* ── MARQUEE SELECTION BOX ── */}
      {marquee && (
        <div
          className="fixed z-40 border border-pink-400 bg-pink-400/10 pointer-events-none rounded-sm"
          // marquee is stored in page coords; this div is fixed, so subtract scroll
          style={{
            left: Math.min(marquee.x0, marquee.x1) - (typeof window !== "undefined" ? window.scrollX : 0),
            top: Math.min(marquee.y0, marquee.y1) - (typeof window !== "undefined" ? window.scrollY : 0),
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
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-600">
              {selected.has(ctxMenu.item.rel) && selected.size > 1 ? `Move ${selected.size} selected to` : "Move to"}
            </div>
            {allFolderTargets.map((f) => (
              <button key={f || "__root"}
                onClick={() => {
                  const it = ctxMenu.item;
                  setCtxMenu(null);
                  // Right-clicking inside a selection acts on the whole selection,
                  // matching drag-and-drop — it used to move only the clicked tile.
                  if (selected.has(it.rel) && selected.size > 1) moveSelected(f);
                  else moveItem(it.rel, f);
                }}
                disabled={ctxMenu.item.folder === f && !(selected.has(ctxMenu.item.rel) && selected.size > 1)}
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
                className="text-sm bg-pink-600 hover:bg-pink-500 on-accent rounded-lg px-4 py-1.5 disabled:opacity-40">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE JOB CONFIRM ── */}
      {confirmDeleteJob && (() => {
        const job = jobs.find((j) => j.id === confirmDeleteJob);
        if (!job) return null;
        return (
          <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmDeleteJob(null)}>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
              <p className="text-sm font-semibold text-gray-100 mb-1">Delete this job?</p>
              <p className="text-xs text-gray-500 mb-1 truncate">{job.idea}</p>
              <p className="text-xs text-gray-600 mb-4">
                Removes the record permanently ({job.completed}/{job.total} images).
                Already-generated images stay in your gallery.
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmDeleteJob(null)}
                  className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Keep</button>
                <button onClick={async () => {
                  const id = confirmDeleteJob;
                  setConfirmDeleteJob(null);
                  await fetch(`/api/qwen/jobs/${id}`, { method: "DELETE" });
                  refreshJobs();
                }} className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5">Delete</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── CLEAR COMPLETED CONFIRM ── */}
      {confirmClearCompleted && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmClearCompleted(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-gray-100 mb-1">
              Clear {completedJobs.length} finished job{completedJobs.length === 1 ? "" : "s"}?
            </p>
            <p className="text-xs text-gray-600 mb-4">
              Deletes every done, failed and cancelled record permanently. Queued and running
              jobs are untouched, and all generated images stay in your gallery.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmClearCompleted(false)}
                className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Keep</button>
              <button onClick={async () => {
                setConfirmClearCompleted(false);
                await fetch("/api/qwen/jobs/bulk", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "clear-completed" }),
                });
                refreshJobs();
              }} className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5">Clear all</button>
            </div>
          </div>
        </div>
      )}

      {/* ── CANCEL JOB CONFIRM ── */}
      {confirmCancelJob && (() => {
        const job = jobs.find((j) => j.id === confirmCancelJob);
        if (!job) return null;
        return (
          <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmCancelJob(null)}>
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-100 mb-1">Cancel this job?</h3>
              <p className="text-xs text-gray-400 mb-1 truncate">{job.idea}</p>
              <p className="text-[11px] text-gray-600 mb-4">
                {job.status === "running"
                  ? `Aborts the current image immediately. ${job.completed}/${job.total} completed so far.`
                  : `${job.completed}/${job.total} images completed — rest will be discarded.`}
              </p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmCancelJob(null)}
                  className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Keep</button>
                <button onClick={() => {
                  const id = confirmCancelJob;
                  // optimistic: mark cancelled immediately so it disappears from active view
                  setJobs((prev) => prev.map((j) => j.id === id ? { ...j, status: "cancelled" as const } : j));
                  setConfirmCancelJob(null);
                  // PATCH cancel, not DELETE — cancelling keeps the record.
                  fetch(`/api/qwen/jobs/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "cancel" }),
                  }).then(refreshJobs);
                }} className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5">Cancel job</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── JOB DETAIL MODAL ── */}
      {detailJobId && (() => {
        const job = jobs.find((j) => j.id === detailJobId);
        if (!job) return null;
        const isDone = job.status === "done";
        const isFailed = job.status === "failed";
        const duration = job.startedAt && job.doneAt
          ? Math.floor((new Date(job.doneAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
          : null;
        const jobImages = gallery.filter((img) => img.batchJobId === job.id);
        const imageMismatch = (isDone || isFailed) && jobImages.length < job.completed;

        const retryJob = async () => {
          await fetch(`/api/qwen/jobs/${job.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resume" }),
          });
          setDetailJobId(null);
          refreshJobs();
        };

        const cloneJob = async () => {
          await fetch("/api/qwen/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              idea: job.idea,
              prompts: job.prompts,
              negative: job.params.negative,
              width: job.params.width,
              height: job.params.height,
              steps: job.params.steps,
              cfg: job.params.cfg,
              // Without this a cloned FLUX job would silently re-queue on Qwen.
              model: job.params.model,
            }),
          });
          setDetailJobId(null);
          refreshJobs();
        };

        const openInBatch = () => {
          setPrompt(job.idea);
          setNegative(job.params.negative || "");
          setWidth(job.params.width);
          setHeight(job.params.height);
          setSteps(job.params.steps);
          setCfg(job.params.cfg);
          if (job.params.model) {
            // Adopt the job's own step count, not the model's default: moving the
            // ref forward first makes the switch invisible to the reset effect,
            // which would otherwise immediately overwrite the steps set above.
            prevModelRef.current = job.params.model;
            setImageModel(job.params.model);
          }
          setBatchVary("manual");
          setBatchManual(job.prompts.join("\n"));
          setMode("batch");
          setDetailJobId(null);
        };

        const resync = async () => {
          setReSyncing(true);
          try {
            await fetch(`/api/qwen/jobs/${job.id}/resync`, { method: "POST" });
            await refreshGallery();
          } finally {
            setReSyncing(false);
          }
        };

        return (
          <div className="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center p-4" onClick={() => setDetailJobId(null)}>
            <div className="bg-gray-950 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-start gap-3 px-5 pt-5 pb-4 border-b border-gray-800">
                <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${isDone ? "bg-green-500" : isFailed ? "bg-red-500" : "bg-gray-600"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-100 leading-snug">{job.idea}</p>
                  <p className="text-[11px] text-gray-600 mt-0.5">
                    {isDone ? "Completed" : isFailed ? <span className="text-red-400">Failed</span> : job.status} · {job.completed}/{job.total} images
                    {job.failed > 0 && <span className="text-red-400"> · {job.failed} failed</span>}
                    {duration != null && <span> · {fmtDur(duration)}</span>}
                  </p>
                  {isFailed && job.lastError && (
                    <p className="text-[10px] text-red-500/70 mt-1 font-mono break-all">{job.lastError}</p>
                  )}
                </div>
                <button onClick={() => setDetailJobId(null)} className="text-gray-600 hover:text-gray-300 text-lg leading-none flex-shrink-0">✕</button>
              </div>

              {/* Params */}
              <div className="px-5 py-3 border-b border-gray-800/60 flex flex-wrap gap-x-4 gap-y-1">
                {/* The queue holds jobs for either model now, so name it. */}
                <span className="text-[11px] text-gray-400">{getImageModel(job.params.model).name}</span>
                <span className="text-[11px] text-gray-500">{job.params.width}×{job.params.height}</span>
                <span className="text-[11px] text-gray-500">{job.params.steps} steps</span>
                {getImageModel(job.params.model).supportsCfg && (
                  <span className="text-[11px] text-gray-500">CFG {job.params.cfg}</span>
                )}
                {job.params.negative && (
                  <span className="text-[11px] text-gray-600 truncate max-w-full">neg: {job.params.negative}</span>
                )}
              </div>

              {/* Prompts list */}
              <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5 min-h-0">
                <p className="text-[10px] uppercase tracking-wider text-gray-700 mb-2">Prompts ({job.prompts.length})</p>
                {job.prompts.map((p, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className={`flex-shrink-0 w-4 text-center font-mono mt-0.5 ${i < job.completed ? "text-green-500" : "text-gray-700"}`}>
                      {i < job.completed ? "✓" : String(i + 1)}
                    </span>
                    <span className={`font-mono leading-snug break-all ${i < job.completed ? "text-gray-400" : "text-gray-600"}`}>{p}</span>
                  </div>
                ))}
              </div>

              {/* Images count / resync */}
              {(isDone || isFailed) && (
                <div className="px-5 py-3 border-t border-gray-800/60 flex items-center gap-3 text-[11px]">
                  <span className={`${imageMismatch ? "text-amber-400" : "text-gray-600"}`}>
                    {jobImages.length}/{job.completed} images in gallery
                    {imageMismatch && " — some may be missing from the index"}
                  </span>
                  {imageMismatch && (
                    <button onClick={resync} disabled={reSyncing}
                      className="text-amber-400 hover:text-amber-300 border border-amber-500/30 rounded px-2 py-0.5 disabled:opacity-50 transition cursor-pointer">
                      {reSyncing ? "Syncing…" : "Re-sync"}
                    </button>
                  )}
                  {jobImages.length > 0 && (
                    <button onClick={() => { setGalleryBatchFilter(job.id); setSelectedFolder(null); setDetailJobId(null); galleryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                      className="ml-auto text-blue-400 hover:text-blue-300 transition cursor-pointer">
                      images →
                    </button>
                  )}
                </div>
              )}

              {/* Footer actions */}
              <div className="px-5 py-4 border-t border-gray-800 flex gap-2 justify-between">
                <div className="flex gap-2">
                  {isFailed && (
                    <button onClick={retryJob}
                      className="text-xs text-red-300 hover:text-red-200 border border-red-500/40 hover:border-red-400/60 rounded-lg px-3 py-1.5 transition cursor-pointer">
                      ↻ Retry {job.total - job.completed} remaining
                    </button>
                  )}
                  <button onClick={openInBatch}
                    className="text-xs text-violet-300 hover:text-violet-200 border border-violet-500/30 hover:border-violet-400/50 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    Open in Batch ↗
                  </button>
                  <button onClick={cloneJob}
                    className="text-xs text-gray-300 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-lg px-3 py-1.5 transition cursor-pointer">
                    Queue again
                  </button>
                </div>
                <button onClick={() => setDetailJobId(null)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition cursor-pointer">
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── BULK CANCEL QUEUED CONFIRM ── */}
      {confirmBulkCancelQueued && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4" onClick={() => setConfirmBulkCancelQueued(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100 mb-1">Cancel all queued jobs?</h3>
            <p className="text-xs text-gray-400 mb-4">
              {queueCount} queued job{queueCount !== 1 ? "s" : ""} will be cancelled. Running jobs are not affected.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmBulkCancelQueued(false)}
                className="text-sm text-gray-300 hover:text-gray-100 border border-gray-700 rounded-lg px-4 py-1.5">Keep</button>
              <button onClick={async () => {
                setConfirmBulkCancelQueued(false);
                await fetch("/api/qwen/jobs/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel-queued" }) });
                refreshJobs();
              }} className="text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg px-4 py-1.5">Cancel queued</button>
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
              <h3 className="text-sm font-semibold text-gray-100 mb-1">Delete folder "{confirmFolderDelete}"?</h3>
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
