/**
 * One model, wherever it happens to live.
 *
 * The Models page used to have three lists, because the data arrives in three
 * shapes: the router's catalogue (what is wired), llm-stats (what exists), and
 * vendor discovery (what you could buy). They are not three kinds of thing —
 * they are one kind of thing at three distances. This module flattens them into
 * a single `Entry` so the page can rank a downloadable 27B against a wired cloud
 * model in the same list, which is the comparison someone deciding what to run
 * is actually making.
 */

export type Fit = {
  verdict: "fits" | "tight" | "swap" | "no" | "off-box";
  headline: string;
  vramNeededGb: number;
  ramNeededGb: number;
  diskNeededGb: number;
  displaces: string[];
  reasons: string[];
  basis?: string;
};

export type PrecisionFit = {
  precision: string;
  label: string;
  note: string;
  requirement: { vramGb?: number; ramGb?: number; diskGb?: number; basis?: string };
  fit: Fit;
};

/**
 * Another machine's answer for the same model.
 *
 * The server sends these only where the answer DIFFERS from the live machine's,
 * so their presence is itself the signal — a row with none is one both boxes
 * agree about, and the column stays empty rather than repeating itself.
 */
export type HostBest = {
  hostId: string;
  hostName: string;
  verdict: Fit["verdict"];
  /** The rung that machine would run it at. Absent when none does. */
  label?: string;
  vramGb?: number;
};

/** One row of the weekly scout report, as the API sends it. */
export type ScoutCandidateEntry = {
  id: string;
  name: string;
  kind: "local" | "cloud";
  capability: string;
  why: string;
  checkpoint?: string;
  target?: string;
  mode?: string;
  params?: string;
  released?: string;
  license?: string;
  docs?: string;
  paper?: string;
  fit: Fit;
  elsewhere?: { hostId: string; hostName: string; live: boolean; fit: Fit }[];
  alreadyWired?: string;
};

export type Stats = {
  model_id: string;
  name: string;
  organization: string;
  gpqa_score: number | null;
  swe_bench_verified_score: number | null;
  hle_score: number | null;
  context: number | null;
  param_count: number | null;
  input_price: number | null;
  output_price: number | null;
  throughput: number | null;
  is_open_source: boolean;
  release_date: string | null;
};

export type CatalogModel = {
  id: string;
  target: string;
  provider: string;
  mode: string;
  local: boolean;
  serviceId?: string;
  status: "ready" | "no-key" | "model-missing" | "service-stopped" | "router-offline";
  detail?: string;
  checkpoint?: string;
  params?: string;
  released?: string;
  docs?: string;
  note?: string;
  footprint?: { vramGb?: number; ramGb?: number; idleVramGb?: number; kind?: string; basis?: string };
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  /** Leaderboard row, joined server-side. Present for cloud models. */
  stats?: Stats;
};

export type DownloadJob = {
  repo: string;
  status: "running" | "done" | "failed";
  percent?: number;
  detail?: string;
  startedAt: string;
  kind?: "download" | "runtime-install";
  runtime?: "ollama";
  runtimeModel?: string;
  file?: string;
};

export type Machine = {
  gpuName: string;
  vramTotalGb: number;
  vramFreeGb: number;
  ramTotalGb: number;
  ramFreeGb: number;
  weightsDiskFreeGb: number;
  weightsDiskLabel: string;
  weightsDiskTotalGb?: number;
  weightsUsedGb?: number;
  weightsPath?: string;
  weightsIndexed?: boolean;
};

export type Occupant = { serviceId: string; name: string; vramGb: number; ramGb: number };

export type Payload = {
  machine: Machine;
  occupants: Occupant[];
  /**
   * Every machine the console can answer for, live one first. Only the live
   * entry has telemetry; the rest are declared in config/hosts.
   */
  machines?: {
    hostId: string;
    hostName: string;
    live: boolean;
    machine: {
      gpuName: string;
      runtime?: string;
      memoryModel?: "discrete" | "unified";
      vramTotalGb: number;
      ramTotalGb: number;
      vramBasis?: string;
    };
  }[];
  /** The weekly report's picks, each already judged against every machine. */
  candidates?: ScoutCandidateEntry[];
  report: { generatedAt?: string; stale: boolean; notes: string[]; upgrades: { alias: string; from: string; to: string; why: string }[] };
  discovery: {
    provider: string;
    keyEnv: string;
    reachable: boolean;
    error?: string;
    models: { provider: string; modelId: string; target: string; mode: string; released?: string; wiredAs?: string; supersedes?: string; stats?: Stats }[];
  }[];
  wired: { alias: string; target: string; provider: string; mode: string; addedAt: string }[];
  handWritten: string[];
  leaderboard: {
    fetchedAt: string;
    source: string;
    stale?: boolean;
    error?: string;
    total: number;
    runnable: number;
    /** How many of `openWeights` each machine can run. Live host first. */
    runnableByHost?: { hostId: string; hostName: string; live: boolean; runnable: number }[];
    openWeights: { stats: Stats; paramsB: number; best: PrecisionFit | null; rungs: PrecisionFit[]; scored: boolean; elsewhere?: HostBest[] }[];
  };
  routerUp: boolean;
  catalogue: CatalogModel[];
  routing: Record<string, string>;
  capabilities: { id: string; label: string; modes: readonly string[]; hint: string }[];
  downloads: DownloadJob[];
  installed: { repo: string; bytes: number }[];
};

/** Router `mode` → capability id. Mirrors CAPABILITIES in src/lib/providers.ts. */
export const CAP_OF_MODE: Record<string, string[]> = {
  chat: ["text", "vision"],
  completion: ["text"],
  image_generation: ["image"],
  audio_transcription: ["stt"],
  audio_speech: ["tts"],
  embedding: ["embedding"],
  video_generation: ["video"],
};

/**
 * Availability, and ONLY availability.
 *
 * Being the active route for a capability is a separate fact and lives in
 * `activeFor`. Folding the two together produced cards reading "active" next to
 * "Whisper STT isn't running", offering a Stop button for a stopped service —
 * a model can perfectly well be what text is routed to while its service is
 * cold, and that combination is exactly what you need to see to fix it.
 */
export type EntryStatus =
  | "ready"         // wired and usable
  | "stopped"       // installed, service down
  | "installed"     // weights on disk, not wired to the router
  | "downloading"
  | "available"     // could be downloaded or wired
  | "no-key"
  | "missing"
  | "wont-fit";

export type Entry = {
  key: string;
  kind: "local" | "cloud";
  name: string;
  /** Second line: the checkpoint, repo or vendor target. */
  sub: string;
  org?: string;
  alias?: string;
  suggestedAlias?: string;
  /**
   * Wired from this page, so unwire() can actually remove it.
   *
   * Aliases written by hand into ai-router.yaml are deliberately outside the
   * console's managed block — offering Remove on those was a button that would
   * have restarted the router and changed nothing.
   */
  consoleWired?: boolean;
  target?: string;
  mode?: string;
  serviceId?: string;
  status: EntryStatus;
  detail?: string;
  /** Capability ids this can serve. */
  capabilities: string[];
  /** Which capabilities it is the active route for. */
  activeFor: string[];
  runsHere: boolean;
  /** Local sizing. */
  vramGb?: number;
  diskGb?: number;
  quant?: string;
  verdict?: Fit["verdict"];
  fit?: Fit;
  rungs?: PrecisionFit[];
  /** Other machines whose answer differs from this one's. Usually empty. */
  elsewhere?: HostBest[];
  /** Runs on some OTHER configured machine, even if not on this one. */
  runsElsewhere?: boolean;
  paramsB?: number;
  measured?: boolean;
  /** Cloud economics. */
  inPrice?: number;
  outPrice?: number;
  throughput?: number;
  /** Quality. */
  gpqa?: number | null;
  swe?: number | null;
  hle?: number | null;
  context?: number | null;
  released?: string | null;
  docs?: string;
  note?: string;
  /**
   * The report's argument for this model — comparative, and the only field on
   * the page that is an opinion rather than a reading. Rendered as such.
   */
  why?: string;
  license?: string;
  paper?: string;
  /** Hub repo, when known — what a download would pull. */
  repo?: string;
  download?: DownloadJob;
  /** Rank within its lane. Higher is better. */
  score: number;
  supersedes?: string;
};

/**
 * Sorting, for the list view.
 *
 * "default" is the server's own ranking — runnable first, then quality by
 * percentile — and it stays the default because it already encodes the judgement
 * a column sort cannot: that a model which does not fit is not a candidate
 * however well it scores. Every other key is a plain column sort, so a reader
 * can check the ordering against the number in front of them.
 */
export type SortKey =
  | "default"
  | "name"
  | "size"
  | "vram"
  | "disk"
  | "gpqa"
  | "swe"
  | "hle"
  | "in"
  | "out"
  | "speed"
  | "ctx";

export type Sort = { key: SortKey; dir: "asc" | "desc" };

const SORT_VALUE: Record<Exclude<SortKey, "default" | "name">, (e: Entry) => number | null | undefined> = {
  size: (e) => e.paramsB,
  vram: (e) => e.vramGb,
  disk: (e) => e.diskGb,
  gpqa: (e) => e.gpqa,
  swe: (e) => e.swe,
  hle: (e) => e.hle,
  in: (e) => e.inPrice,
  out: (e) => e.outPrice,
  speed: (e) => e.throughput,
  ctx: (e) => e.context,
};

export function sortEntries(entries: Entry[], sort: Sort): Entry[] {
  if (sort.key === "default") return entries;
  const out = [...entries];
  const sign = sort.dir === "asc" ? 1 : -1;

  if (sort.key === "name") {
    return out.sort((a, b) => sign * a.name.localeCompare(b.name));
  }

  const read = SORT_VALUE[sort.key];
  return out.sort((a, b) => {
    const va = read(a);
    const vb = read(b);
    // Missing values sink in BOTH directions. A model with no GPQA score is not
    // the cheapest or the best at anything — it is unmeasured, and floating it
    // to the top of an ascending sort would read as a claim.
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (va - vb);
  });
}

/**
 * A parameter count, at a precision that does not lie.
 *
 * Math.round turned Kokoro's 82M into "0B" and Whisper's 1.5B into "2B" — the
 * first says the model has no size, the second inflates it by a third. Sub-1B
 * models get their real unit; single digits keep a decimal.
 */
export function fmtParams(b?: number): string {
  if (b == null || !Number.isFinite(b) || b <= 0) return "—";
  if (b < 1) return `${Math.round(b * 1000)}M`;
  if (b < 10) return `${(Math.round(b * 10) / 10).toString()}B`;
  return `${Math.round(b)}B`;
}

export function fmtGb(n?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n < 1 ? `${Math.round(n * 1000)} MB` : `${Math.round(n * 10) / 10} GB`;
}

/**
 * Normalise a model name for cross-source matching.
 *
 * llm-stats says "qwen3.8-27b", the Hub says "Qwen/Qwen3.8-27B", and
 * model-meta says "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ". Stripping
 * everything but alphanumerics and lowercasing is crude, but the alternative is
 * a fuzzy matcher that confidently pairs the wrong things — and a wrong
 * "installed" badge is worse than a duplicate row.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pull a number and a quantisation out of model-meta's prose `params` field.
 *
 * That field is written for humans — "30B (A3B MoE, ~3B active) · AWQ 4-bit",
 * "20.4B denoiser · 28.8B loaded", "82M" — so the Size and Runs-at columns sat
 * empty for every installed model while the string sat right there. Takes the
 * FIRST magnitude, which is the model's own size; a second one is always a
 * derived figure (loaded weights, active experts).
 */
export function parseParams(s?: string): { paramsB?: number; quant?: string } {
  if (!s) return {};
  let paramsB: number | undefined;
  const b = s.match(/([\d.]+)\s*B\b/);
  const m = s.match(/([\d.]+)\s*M\b/);
  if (b) paramsB = Number(b[1]);
  else if (m) paramsB = Number(m[1]) / 1000;
  if (paramsB != null && !Number.isFinite(paramsB)) paramsB = undefined;

  const q = s.match(/\b(NVFP4|AWQ 4-bit|AWQ|GPTQ|GGUF[\w-]*|fp8|int8|int4|4-bit|8-bit|bf16|fp16)/i);
  return { paramsB, quant: q?.[0] };
}

/** Does an installed repo look like this leaderboard model? */
function matchesRepo(modelId: string, repo: string): boolean {
  const a = norm(modelId);
  const b = norm(repo.split("/").pop() ?? repo);
  if (!a || !b) return false;
  // Containment either way: the Hub name usually carries extra words the
  // leaderboard id drops ("-Instruct", "-AWQ"), and occasionally the reverse.
  return a.length >= 6 && b.length >= 6 && (b.includes(a) || a.includes(b));
}

/**
 * Everything on the page, as one list.
 *
 * Order of precedence matters: a model the router already serves is described by
 * the ROUTER, not by the leaderboard, because the router knows its measured
 * footprint and whether its service is up. The leaderboard only fills in what
 * the router cannot know — benchmarks, prices, and the existence of models that
 * are not here at all.
 */
export function buildEntries(p: Payload): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<string>();

  const activeFor = (alias: string) =>
    Object.entries(p.routing)
      .filter(([, v]) => v === alias)
      .map(([k]) => k);

  const statsByNorm = new Map<string, Stats>();
  for (const c of p.leaderboard.openWeights) statsByNorm.set(norm(c.stats.model_id), c.stats);

  const consoleWired = new Set(p.wired.map((w) => w.alias));

  // ── 1. what the router serves ─────────────────────────────────────────────
  for (const m of p.catalogue) {
    const caps = CAP_OF_MODE[m.mode] ?? [];
    const active = activeFor(m.id);
    // Cloud models are joined server-side by vendor id; local ones are matched
    // here against the open-weights index by checkpoint name.
    const stats =
      m.stats ??
      (m.checkpoint
        ? [...statsByNorm.entries()].find(([k]) => matchesRepo(k, m.checkpoint!))?.[1]
        : undefined);

    const { paramsB, quant } = parseParams(m.params);
    // What it actually occupies on the weights drive, when we can identify it.
    const installedHere = m.checkpoint
      ? p.installed.find((r) => matchesRepo(m.checkpoint!.split("/").pop() ?? "", r.repo))
      : undefined;

    const status: EntryStatus =
      m.status === "ready"
        ? "ready"
        : m.status === "model-missing"
          ? "missing"
        : m.status === "service-stopped"
          ? "stopped"
          : m.status === "no-key"
            ? "no-key"
            : "ready";

    out.push({
      key: `alias:${m.id}`,
      kind: m.local ? "local" : "cloud",
      name: m.id,
      sub: m.checkpoint ?? m.target,
      org: m.local ? undefined : m.provider,
      alias: m.id,
      consoleWired: consoleWired.has(m.id),
      target: m.target,
      mode: m.mode,
      serviceId: m.serviceId,
      status,
      detail: m.detail,
      capabilities: caps,
      activeFor: active,
      // A local alias only runs on this host when it resolves to a registered
      // service and that runtime confirms the exact model is installed. This
      // keeps aliases for the other Hangar host out of the default view.
      runsHere: m.local
        ? Boolean(m.serviceId) && m.status !== "model-missing"
        : true,
      vramGb: m.footprint?.vramGb,
      measured: !!m.footprint,
      fit: undefined,
      verdict: m.local ? (m.footprint?.vramGb ? "fits" : undefined) : "off-box",
      paramsB,
      quant,
      diskGb: installedHere ? Math.round((installedHere.bytes / 1024 ** 3) * 10) / 10 : undefined,
      repo: installedHere?.repo,
      inPrice: m.costPerMTokIn,
      outPrice: m.costPerMTokOut,
      throughput: stats?.throughput ?? undefined,
      gpqa: stats?.gpqa_score ?? null,
      swe: stats?.swe_bench_verified_score ?? null,
      hle: stats?.hle_score ?? null,
      context: stats?.context ?? null,
      released: m.released ?? stats?.release_date ?? null,
      docs: m.docs,
      note: m.note,
      score: 1000 + (active.length ? 500 : 0) + (m.status === "ready" ? 100 : 0),
    });
    seen.add(norm(m.id));
    if (m.checkpoint) seen.add(norm(m.checkpoint.split("/").pop() ?? ""));
  }

  // ── 1b. the weekly report's picks ─────────────────────────────────────────
  //
  // Placed above the leaderboard because they are a different KIND of claim: a
  // routine compared each of these against what is already installed and wrote
  // down why it wins. llm-stats can rank a 27B; it cannot say "this replaces
  // whisper on the service that already exists". They were shipped to the
  // browser for weeks and rendered only as prose notes at the foot of the page.
  for (const c of p.candidates ?? []) {
    const key = norm(c.checkpoint?.split("/").pop() ?? c.id);
    if (seen.has(key)) continue;
    const installedRepo = c.checkpoint
      ? p.installed.find((r) => matchesRepo(c.checkpoint!.split("/").pop() ?? "", r.repo))
      : undefined;
    const dl = c.checkpoint ? p.downloads.find((d) => matchesRepo(c.checkpoint!, d.repo)) : undefined;
    const runsHere = c.fit.verdict !== "no";
    const elsewhere = (c.elsewhere ?? []).filter((h) => h.fit.verdict !== c.fit.verdict);

    out.push({
      key: `scout:${c.id}`,
      kind: c.kind,
      name: c.name,
      sub: c.checkpoint ?? c.target ?? c.id,
      alias: c.alreadyWired,
      target: c.target,
      mode: c.mode,
      status: dl?.status === "running"
        ? "downloading"
        : installedRepo
          ? "installed"
          : c.alreadyWired
            ? "ready"
            : runsHere || c.kind === "cloud"
              ? "available"
              : "wont-fit",
      capabilities: [c.capability],
      activeFor: [],
      runsHere: c.kind === "cloud" ? true : runsHere,
      runsElsewhere: elsewhere.some((h) => h.fit.verdict !== "no"),
      vramGb: c.fit.vramNeededGb || undefined,
      diskGb: c.fit.diskNeededGb || undefined,
      verdict: c.fit.verdict,
      fit: c.fit,
      elsewhere: elsewhere.length
        ? elsewhere.map((h) => ({
            hostId: h.hostId,
            hostName: h.hostName,
            verdict: h.fit.verdict,
            vramGb: h.fit.vramNeededGb || undefined,
          }))
        : undefined,
      why: c.why,
      license: c.license,
      paper: c.paper,
      docs: c.docs,
      released: c.released ?? null,
      repo: installedRepo?.repo ?? dl?.repo ?? c.checkpoint,
      download: dl,
      // Above every leaderboard row and below what is already wired: a
      // considered recommendation outranks a ranked list, and both lose to a
      // model that is already serving traffic.
      score: 960,
    });
    seen.add(key);
    seen.add(norm(c.id));
  }

  // ── 2. open weights from the leaderboard ──────────────────────────────────
  p.leaderboard.openWeights.forEach((c, i) => {
    const key = norm(c.stats.model_id);
    if (seen.has(key)) return;
    const installedRepo = p.installed.find((r) => matchesRepo(c.stats.model_id, r.repo));
    const dl = p.downloads.find((d) => matchesRepo(c.stats.model_id, d.repo));
    const best = c.best;

    out.push({
      key: `ow:${c.stats.model_id}`,
      kind: "local",
      name: c.stats.name,
      sub: c.stats.model_id,
      org: c.stats.organization,
      status: dl?.status === "running"
        ? "downloading"
        : installedRepo
          ? "installed"
          : best
            ? "available"
            : "wont-fit",
      // Text-generation is what llm-stats tracks; a downloaded checkpoint is not
      // wired to anything yet, so it can serve nothing until a service fronts it.
      capabilities: ["text"],
      activeFor: [],
      runsHere: !!best,
      vramGb: best?.requirement.vramGb,
      diskGb: best?.requirement.diskGb,
      quant: best?.label,
      verdict: best?.fit.verdict ?? "no",
      fit: best?.fit,
      rungs: c.rungs,
      elsewhere: c.elsewhere?.length ? c.elsewhere : undefined,
      runsElsewhere: !!c.elsewhere?.some((h) => h.verdict !== "no"),
      paramsB: c.paramsB,
      measured: false,
      gpqa: c.stats.gpqa_score,
      swe: c.stats.swe_bench_verified_score,
      hle: c.stats.hle_score,
      context: c.stats.context,
      released: c.stats.release_date,
      repo: installedRepo?.repo ?? dl?.repo,
      download: dl,
      // Preserve the server's ranking, which already put runnable-and-good
      // first. Re-scoring here would silently disagree with it.
      score: 900 - i,
    });
    seen.add(key);
  });

  // ── 3. cloud models the vendors offer but the router does not serve ───────
  for (const prov of p.discovery) {
    for (const m of prov.models) {
      if (m.wiredAs) continue;
      const key = norm(m.modelId);
      if (seen.has(key)) continue;
      const s = m.stats;
      out.push({
        key: `disc:${m.target}`,
        kind: "cloud",
        name: m.modelId,
        sub: m.target,
        org: prov.provider,
        suggestedAlias: m.modelId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64),
        target: m.target,
        mode: m.mode,
        status: "available",
        capabilities: CAP_OF_MODE[m.mode] ?? [],
        activeFor: [],
        runsHere: true,          // cloud always "runs" — it is not this machine's problem
        verdict: "off-box",
        inPrice: s?.input_price ?? undefined,
        outPrice: s?.output_price ?? undefined,
        throughput: s?.throughput ?? undefined,
        gpqa: s?.gpqa_score ?? null,
        swe: s?.swe_bench_verified_score ?? null,
        hle: s?.hle_score ?? null,
        context: s?.context ?? null,
        released: m.released ?? null,
        supersedes: m.supersedes,
        score: 500 + (m.supersedes ? 200 : 0) + (s?.gpqa_score ?? 0) * 100,
      });
      seen.add(key);
    }
  }

  return out.sort((a, b) => b.score - a.score);
}
