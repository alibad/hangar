/**
 * "Would this model actually run on this box, and what would it cost me?"
 *
 * The Models tab could always answer that for models already wired into the
 * router — config/model-meta.json carries a measured footprint for each. It
 * could not answer it for a model that is NOT here yet, which is the only
 * question worth asking when a new checkpoint lands. This module closes that
 * gap: given what a candidate needs and what this machine has, it returns a
 * verdict plus the specific services you would have to stop to make room.
 *
 * Deliberately dependency-free — no `fs`, no `os`, no fetch — for the same
 * reason src/lib/ram-budget.ts is: the API route, the browser, and the tests
 * must run identical arithmetic, and a number that disagrees with itself across
 * two surfaces is worse than no number.
 *
 * ── On honesty ──────────────────────────────────────────────────────────────
 * Every figure here carries a `basis`, following the rule config/model-meta.json
 * already sets: do not print a number you cannot source. A requirement measured
 * or published by the model's authors is used as-is. Only when none exists do we
 * fall back to estimateFromParams(), and that path says so in its basis string
 * rather than quietly passing an estimate off as a measurement.
 *
 * ── On machines ─────────────────────────────────────────────────────────────
 * This module was written against one box — a discrete RTX 5090 — and three of
 * its assumptions turned out to be facts about that box rather than about
 * hardware in general. All three are now read off the MachineProfile:
 *
 *   1. VRAM and host RAM are separate budgets. False on unified memory, where
 *      they are the same silicon and adding them double-counts.
 *   2. NVFP4 is a quantisation worth trying. True only on Blackwell; on Metal
 *      the equivalent rung is MLX 4-bit and NVFP4 will not load at all.
 *   3. A diffusion model pays for CPU offload in standing host RAM. True only
 *      when there is somewhere to offload TO. On unified memory the weights are
 *      already in the pool the GPU reads from.
 *
 * The consequence worth stating plainly, because docs/models.md used to state
 * the opposite as a law: "host RAM is the tighter constraint, not VRAM" is a
 * finding about the 5090 box. It is not true of a unified-memory machine.
 */

/**
 * Weight precision, as bytes per parameter.
 *
 * These are the storage costs of the weights themselves, before any runtime
 * overhead. 4-bit schemes do not reach a clean 0.5 B/param: AWQ and GPTQ keep
 * fp16 scales and zero-points per group (typically 128), and GGUF's K-quants mix
 * block scales in, so ~0.55 is the realistic figure. Using 0.5 here understated
 * the local-coder 30B by roughly 1.5 GB.
 */
export const BYTES_PER_PARAM: Record<string, number> = {
  fp32: 4,
  bf16: 2,
  fp16: 2,
  fp8: 1,
  int8: 1,
  "gguf-q8": 1.1,
  awq4: 0.55,
  gptq4: 0.55,
  "gguf-q4": 0.6,
  int4: 0.55,
  // Blackwell's native 4-bit format, which this card (sm_120) executes in
  // hardware rather than dequantising first. Same storage cost as the other
  // 4-bit schemes — the win is throughput, not size.
  nvfp4: 0.55,
  // Apple's MLX quantisations, which are what a Metal machine actually runs.
  // Same group-scale overhead as AWQ for the same reason: 4-bit weights plus
  // fp16 scales and biases per group of 64.
  mlx8: 1.1,
  mlx4: 0.55,
  "gguf-q3": 0.45,
  "gguf-q2": 0.35,
};

export type Precision = keyof typeof BYTES_PER_PARAM | string;

/**
 * How a machine executes weights. This is not a performance detail — it decides
 * whether a checkpoint loads at all. An MLX repo is Metal-only and will not run
 * on CUDA at any quantisation, which is a verdict no amount of size arithmetic
 * can reach.
 */
export type Runtime = "cuda" | "metal" | "rocm" | "cpu";

/**
 * Whether the GPU has its own memory or shares the host's.
 *
 * `discrete` — VRAM and host RAM are separate pools. A model can be offloaded
 * from one to the other, and a Requirement's two figures are two real costs.
 * `unified` — Apple silicon. There is one pool; the two figures in a
 * Requirement describe the same bytes, and the GPU's share of that pool is
 * additionally capped by the OS.
 */
export type MemoryModel = "discrete" | "unified";

/**
 * Runtime overhead above the weights: CUDA context, activations, the framework's
 * own allocator slack. 15% is the low end of what vLLM and diffusers actually
 * show on this card, so it errs toward optimism on purpose — the pessimism lives
 * in the safety margins below, where it is visible and adjustable.
 */
const RUNTIME_OVERHEAD = 1.15;

/**
 * KV cache, in GB per 1k tokens of context per billion parameters, at fp16.
 *
 * A single constant cannot be right, because KV size scales with layers and
 * key/value heads, not with parameter count — but a scouting report has a
 * parameter count and nothing else, so a constant is what there is. These are
 * the numbers it is calibrated against, all grouped-query at fp16:
 *
 *   Qwen2.5-7B   28 layers,  4 kv heads, d=128 → 56 KB/token → 0.9 GB at 16k
 *                                                        → 0.0077 per k per B
 *   Qwen3-32B    64 layers,  8 kv heads, d=128 → 256 KB/token → 8.0 GB at 32k
 *                                                        → 0.0078 per k per B
 *   Qwen3-30B-A3B 48 layers, 4 kv heads, d=128 → 96 KB/token → 3.0 GB at 32k
 *                                                        → 0.0031 per k per B
 *
 * Dense models land near 0.0078 and MoE models near half that, since an MoE's
 * parameters are mostly experts that add no KV at all. 0.006 sits between them:
 * it slightly over-reserves for MoE and slightly under-reserves for dense, and
 * the safety margins below absorb the difference.
 *
 * The earlier value here was 0.0125, guessed from vLLM's --gpu-memory-utilization
 * flag — which is a number vLLM CLAIMS, not one it needs. It over-reserved by
 * ~6 GB on a 32B and pushed models onto Q3 quantisation that run fine at 4-bit.
 */
const KV_GB_PER_K_PER_B = 0.006;

export type MachineProfile = {
  gpuName: string;
  /** What the GPU can execute. Decides loadability before any size question. */
  runtime: Runtime;
  /** Whether vramTotalGb and ramTotalGb describe separate pools or one. */
  memoryModel: MemoryModel;
  /** CUDA compute capability, e.g. "12.0" for sm_120. Absent off CUDA. */
  computeCapability?: string;
  vramTotalGb: number;
  vramFreeGb: number;
  /**
   * Where vramTotalGb came from. On CUDA it is the card, reported by the
   * driver. On unified memory there is no such number to read — it is whatever
   * the OS lets the GPU wire, which is a policy rather than a physical limit,
   * so it gets a basis like every other unmeasurable figure in this codebase.
   */
  vramBasis?: string;
  ramTotalGb: number;
  ramFreeGb: number;
  /** Free space on the drive Hugging Face weights land on (D: here). */
  weightsDiskFreeGb: number;
  weightsDiskLabel: string;
  /** Capacity of that drive, for the "x of y" the free figure alone can't give. */
  weightsDiskTotalGb?: number;
  /** What the weights already there occupy, per the storage index. */
  weightsUsedGb?: number;
  /** Where they live, so a full drive names the folder to go clear out. */
  weightsPath?: string;
  /** False when the storage index has never scanned that drive — then weightsUsedGb is unknown, not zero. */
  weightsIndexed?: boolean;
};

/** What a model needs to run. Numbers only — provenance lives in `basis`. */
export type Requirement = {
  vramGb?: number;
  ramGb?: number;
  /** Download size of the weights. Absent for cloud models. */
  diskGb?: number;
  basis?: string;
  /** True when these came out of estimateFromParams() rather than a source. */
  estimated?: boolean;
  /**
   * Runtimes these weights can execute on. Omit when the checkpoint is portable
   * (plain safetensors, GGUF); set it when the repo is tied to one stack, which
   * is the case llm-stats and a parameter count between them cannot see. An MLX
   * repo is `["metal"]` and does not run on this card at any quantisation.
   */
  runtimes?: Runtime[];
};

/** Enough to estimate a requirement when nobody published one. */
export type ParamSpec = {
  paramsB: number;
  precision: Precision;
  contextK?: number;
  /** Diffusion models stream weights from host RAM; LLM servers do not. */
  kind?: "llm" | "diffusion" | "audio";
  /**
   * Defaults to "discrete". On "unified" the CPU-offload cost below is dropped,
   * because there is nowhere to offload to — the weights are already in the
   * pool the GPU reads from, and charging for them twice would refuse models
   * that run fine.
   */
  memoryModel?: MemoryModel;
};

/**
 * Left free for Windows, the console, a browser, and whatever else is up.
 * Mirrors RAM_SAFETY_GB in ram-budget.ts and vramSafetyGb in
 * config/resource-policy.json — a projection that exactly fills the machine
 * reads as "fits" right up to the moment it starts swapping.
 */
export const RAM_SAFETY_GB = 4;
/**
 * VRAM is different: the card has no pagefile, so the failure mode is a hard
 * CUDA OOM rather than a slowdown. Reserve more of it, proportionally.
 */
export const VRAM_SAFETY_GB = 1;
/** Below this share of the card left over, a model runs but nothing fits beside it. */
const TIGHT_HEADROOM_FRACTION = 0.12;

/**
 * A requirement worked out from parameter count alone.
 *
 * Only for candidates whose authors published nothing usable. The returned
 * `basis` shows the whole calculation so a reader can disagree with it, and
 * `estimated` is set so the UI can mark it differently from a measured figure.
 */
export function estimateFromParams(spec: ParamSpec): Requirement {
  const bpp = BYTES_PER_PARAM[spec.precision] ?? 2;
  const weightsGb = spec.paramsB * bpp;
  const kind = spec.kind ?? "llm";

  // Only autoregressive servers hold a KV cache. A diffusion model's "context"
  // is a latent, sized by resolution and step count, not by token count.
  const contextK = kind === "llm" ? (spec.contextK ?? 32) : 0;
  const kvGb = contextK * spec.paramsB * KV_GB_PER_K_PER_B;

  const vramGb = round1(weightsGb * RUNTIME_OVERHEAD + kvGb);

  // Diffusion pipelines on a DISCRETE card are run with CPU offload, which is
  // what lets a 20B image model share a 32 GB card at all — but it makes the
  // host RAM cost permanent for as long as the service is loaded. See the
  // local-qwen-image footprint note in config/model-meta.json for the
  // measurement that taught us to count this. LLM servers keep the weights on
  // the card and cost host RAM only for the process itself.
  //
  // On unified memory the offload does not exist: host and GPU read the same
  // bytes, so the second charge is a double-count that would refuse models the
  // machine runs comfortably.
  const offloads = kind === "diffusion" && spec.memoryModel !== "unified";
  const ramGb = offloads ? round1(spec.paramsB * bpp) : 1;

  const parts = [
    // Rounded: a parameter count derived from a byte count arrives as
    // 27.781427952, and printing that in an explanation of an ESTIMATE claims a
    // precision the whole calculation does not have.
    `Estimated, not measured: ${round1(spec.paramsB)}B params x ${bpp} bytes/param (${spec.precision}) = ${round1(weightsGb)} GB of weights`,
    `x ${RUNTIME_OVERHEAD} runtime overhead`,
    contextK ? `+ ${round1(kvGb)} GB KV cache for ${contextK}k context` : null,
    offloads
      ? `Host RAM assumes CPU offload, which keeps the full ${round1(weightsGb)} GB resident for as long as the service runs.`
      : null,
    kind === "diffusion" && !offloads
      ? `No separate host-RAM charge: on unified memory there is nowhere to offload to, so the ${round1(weightsGb)} GB is counted once.`
      : null,
  ].filter(Boolean);

  return { vramGb, ramGb, diskGb: round1(weightsGb), basis: parts.join(" "), estimated: true };
}

export type FitVerdict =
  | "fits"       // runs, and leaves room for something else
  | "tight"      // runs alone on an idle card, nothing fits beside it
  | "swap"       // does not fit right now, but would if named services stopped
  | "no"         // exceeds the machine even with everything else stopped
  | "off-box";   // cloud model — costs money, not memory

/** A GPU service currently holding memory, and how much. */
export type Occupant = { serviceId: string; name: string; vramGb: number; ramGb: number };

export type Fit = {
  verdict: FitVerdict;
  /** One line, written for someone deciding whether to click Install. */
  headline: string;
  vramNeededGb: number;
  ramNeededGb: number;
  diskNeededGb: number;
  /** VRAM left on an otherwise idle card after this model loads. */
  headroomGb: number;
  /** Services to stop first, when verdict is "swap". */
  displaces: string[];
  /** Everything worth knowing, in the order it matters. */
  reasons: string[];
  basis?: string;
  estimated: boolean;
};

/**
 * The verdict.
 *
 * Judged against an IDLE machine, then adjusted for what is running now. That
 * order matters: "this model cannot run here" and "this model cannot run here
 * while Qwen-Image is loaded" are different answers, and only the first is a
 * reason not to download 20 GB of weights.
 */
export function evaluateFit(opts: {
  requirement: Requirement;
  machine: MachineProfile;
  /** Services holding GPU or host memory right now. */
  occupants?: Occupant[];
  ramSafetyGb?: number;
  vramSafetyGb?: number;
}): Fit {
  const {
    requirement,
    machine,
    occupants = [],
    ramSafetyGb = RAM_SAFETY_GB,
    vramSafetyGb = VRAM_SAFETY_GB,
  } = opts;

  const vramNeededGb = requirement.vramGb ?? 0;
  const ramNeededGb = requirement.ramGb ?? 0;
  const diskNeededGb = requirement.diskGb ?? 0;
  const reasons: string[] = [];

  // Cloud models have no local cost at all. Saying "0 GB" would imply they were
  // measured and found free; "off-box" says the honest thing.
  if (!vramNeededGb && !ramNeededGb && !diskNeededGb) {
    return {
      verdict: "off-box",
      headline: "Runs on the provider's hardware — costs money per call, no local memory.",
      vramNeededGb: 0,
      ramNeededGb: 0,
      diskNeededGb: 0,
      headroomGb: machine.vramTotalGb,
      displaces: [],
      reasons: [],
      estimated: false,
    };
  }

  // Can this machine execute these weights AT ALL? Asked before any size
  // question, because the answer is not a quantity and no quantisation rescues
  // it. This is the case a leaderboard cannot reach: an MLX repo has a real
  // parameter count and a real byte count, both of which say "fits", and it
  // will not load on a CUDA card.
  if (requirement.runtimes?.length && !requirement.runtimes.includes(machine.runtime)) {
    const wants = requirement.runtimes.join(" or ");
    return {
      verdict: "no",
      headline: `Wrong runtime — these weights are ${wants}, this machine is ${machine.runtime}.`,
      vramNeededGb, ramNeededGb, diskNeededGb,
      headroomGb: round1(machine.vramTotalGb - vramNeededGb),
      displaces: [],
      reasons: [
        `Built for ${wants}; ${machine.gpuName} runs ${machine.runtime}. No quantisation changes this — the weights are in a format this machine cannot execute.`,
        `It would otherwise have fit: ${fmtGb(vramNeededGb)} against ${fmtGb(machine.vramTotalGb)}.`,
      ],
      basis: requirement.basis,
      estimated: !!requirement.estimated,
    };
  }

  const unified = machine.memoryModel === "unified";

  // On unified memory a Requirement's two figures describe the SAME bytes: the
  // weights sit in one pool that both the CPU and the GPU address. Adding them
  // would charge twice for one copy. `max` is the honest collapse — whichever
  // figure is larger is the resident working set.
  //
  // Requirements in config/model-scout.json were authored against the discrete
  // box, so they carry a CPU-offload host-RAM figure even for models that would
  // never offload here. This is where that gets undone, whether or not the
  // estimator already knew better.
  const poolNeededGb = round1(Math.max(vramNeededGb, ramNeededGb));

  const vramBudget = machine.vramTotalGb - vramSafetyGb;
  const ramBudget = machine.ramTotalGb - ramSafetyGb;
  // One margin for one pool. Two would reserve 5 GB of the same memory twice.
  const poolBudget = round1(machine.ramTotalGb - ramSafetyGb);
  const headroomGb = unified
    ? round1(poolBudget - poolNeededGb)
    : round1(vramBudget - vramNeededGb);
  /** What "leaves nothing beside it" is measured against on this machine. */
  const capacityGb = unified ? machine.ramTotalGb : machine.vramTotalGb;

  // Explained only when there is something to explain. Every LLM requirement
  // carries ramGb: 1 for the server process, which is a genuinely separate cost
  // and not a second copy of the weights — saying "the same bytes" about it
  // would be wrong. The note belongs to requirements carrying a real offload
  // charge, which is where the collapse changes the answer.
  if (unified && ramNeededGb > 1) {
    reasons.push(
      `Unified memory: ${machine.gpuName} shares one ${fmtGb(machine.ramTotalGb)} pool with the host, so the ${fmtGb(ramNeededGb)} of "host RAM" in this requirement is the same bytes as the VRAM figure, not a second cost. Counted once, at ${fmtGb(poolNeededGb)}.`,
    );
  }

  // Disk is checked first and separately: it is the one constraint that blocks
  // you before the model ever runs, and it is also the easiest to fix.
  const diskShort = diskNeededGb > machine.weightsDiskFreeGb;
  if (diskShort) {
    reasons.push(
      `Needs ${fmtGb(diskNeededGb)} of weights but ${machine.weightsDiskLabel} has ${fmtGb(machine.weightsDiskFreeGb)} free.`,
    );
  }

  // Does it fit on an empty machine at all?
  const tooBig = (reason: string, headline: string): Fit => {
    reasons.unshift(reason);
    return {
      verdict: "no",
      headline,
      vramNeededGb, ramNeededGb, diskNeededGb,
      headroomGb,
      displaces: [],
      reasons,
      basis: requirement.basis,
      estimated: !!requirement.estimated,
    };
  };

  if (unified) {
    if (poolNeededGb > poolBudget) {
      return tooBig(
        `Needs ${fmtGb(poolNeededGb)} of the shared pool; this machine has ${fmtGb(machine.ramTotalGb)}, ${fmtGb(poolBudget)} usable after the safety margin.`,
        `Too big for this machine — ${fmtGb(poolNeededGb)} needed against a shared ${fmtGb(machine.ramTotalGb)}.`,
      );
    }
    // The second, less obvious ceiling: the pool may be large enough while the
    // OS still refuses to let the GPU wire that much of it. A model can fail
    // here with tens of gigabytes apparently free.
    if (vramNeededGb > vramBudget) {
      return tooBig(
        `Needs ${fmtGb(vramNeededGb)} resident on the GPU, but this machine only lets it wire ${fmtGb(machine.vramTotalGb)} of the shared pool.${machine.vramBasis ? ` ${machine.vramBasis}` : ""}`,
        `Over the GPU's share of memory — ${fmtGb(vramNeededGb)} against a ${fmtGb(machine.vramTotalGb)} limit.`,
      );
    }
  } else {
    if (vramNeededGb > vramBudget) {
      return tooBig(
        `Needs ${fmtGb(vramNeededGb)} of VRAM; ${machine.gpuName} has ${fmtGb(machine.vramTotalGb)} total, ${fmtGb(vramBudget)} usable after the safety margin.`,
        `Too big for this card — ${fmtGb(vramNeededGb)} needed against ${fmtGb(machine.vramTotalGb)}.`,
      );
    }
    if (ramNeededGb > ramBudget) {
      return tooBig(
        `Needs ${fmtGb(ramNeededGb)} of host RAM; this box has ${fmtGb(machine.ramTotalGb)}, ${fmtGb(ramBudget)} usable after the safety margin.`,
        `Too big for host RAM — ${fmtGb(ramNeededGb)} needed against ${fmtGb(machine.ramTotalGb)}.`,
      );
    }
  }

  // It fits on an idle machine. Does it fit on THIS machine, right now?
  //
  // On unified memory an occupant's two figures collapse the same way the
  // candidate's do: one service holds one copy of its weights in the shared
  // pool, so its cost is max(vram, ram), not the sum.
  const poolCostOf = (o: Occupant) => Math.max(o.vramGb, o.ramGb);
  const heldVram = occupants.reduce((a, o) => a + o.vramGb, 0);
  const heldRam = occupants.reduce((a, o) => a + o.ramGb, 0);
  const heldPool = occupants.reduce((a, o) => a + poolCostOf(o), 0);
  /** Enough room right now, given this much free VRAM and free RAM/pool. */
  const roomFor = (freeVram: number, freeRam: number) =>
    unified
      ? poolNeededGb <= freeRam - ramSafetyGb && vramNeededGb <= vramBudget
      : vramNeededGb <= freeVram - vramSafetyGb && ramNeededGb <= freeRam - ramSafetyGb;

  if (!roomFor(machine.vramFreeGb, machine.ramFreeGb) && occupants.length > 0) {
    // Free the biggest holders first, and stop as soon as there is room — the
    // point is the SHORTEST list of things to stop, not a tidy sort order.
    const byCost = [...occupants].sort((a, b) =>
      unified ? poolCostOf(b) - poolCostOf(a) : (b.vramGb + b.ramGb) - (a.vramGb + a.ramGb),
    );
    const displaces: string[] = [];
    let freeVram = machine.vramFreeGb;
    let freeRam = machine.ramFreeGb;
    for (const o of byCost) {
      if (roomFor(freeVram, freeRam)) break;
      displaces.push(o.serviceId);
      freeVram += o.vramGb;
      freeRam += unified ? poolCostOf(o) : o.ramGb;
    }
    if (roomFor(freeVram, freeRam)) {
      const names = displaces
        .map((id) => occupants.find((o) => o.serviceId === id)?.name ?? id)
        .join(" and ");
      reasons.unshift(
        unified
          ? `${fmtGb(heldPool)} of the shared pool is held by services that are up right now.`
          : `${fmtGb(heldVram)} VRAM and ${fmtGb(heldRam)} RAM are held by services that are up right now.`,
      );
      return {
        verdict: diskShort ? "no" : "swap",
        headline: diskShort
          ? `No room on ${machine.weightsDiskLabel} for the weights.`
          : `Fits once you stop ${names}.`,
        vramNeededGb, ramNeededGb, diskNeededGb,
        headroomGb,
        displaces,
        reasons,
        basis: requirement.basis,
        estimated: !!requirement.estimated,
      };
    }
  }

  // Room on an idle machine, but not enough left over to matter.
  const tight = headroomGb < capacityGb * TIGHT_HEADROOM_FRACTION;
  if (tight) {
    reasons.unshift(
      unified
        ? `Leaves ${fmtGb(Math.max(0, headroomGb))} of the shared pool — effectively the whole machine, so nothing else can be loaded while it runs.`
        : `Leaves ${fmtGb(Math.max(0, headroomGb))} on the card — effectively the whole GPU, so nothing else can be loaded while it runs.`,
    );
  } else {
    reasons.unshift(
      unified
        ? `Leaves ${fmtGb(headroomGb)} of the shared pool free — room for a small model or an image run beside it.`
        : `Leaves ${fmtGb(headroomGb)} of VRAM free — room for a small model or an image run beside it.`,
    );
  }
  if (requirement.estimated) {
    reasons.push("Requirement is estimated from parameter count, not measured. Verify before relying on it.");
  }

  return {
    verdict: diskShort ? "no" : tight ? "tight" : "fits",
    headline: diskShort
      ? `No room on ${machine.weightsDiskLabel} for the weights.`
      : tight
        ? `Fits, but takes the whole ${unified ? "machine" : "card"} — ${fmtGb(unified ? poolNeededGb : vramNeededGb)} of ${fmtGb(capacityGb)}.`
        : `Fits comfortably — ${fmtGb(unified ? poolNeededGb : vramNeededGb)} of ${fmtGb(capacityGb)}, ${fmtGb(headroomGb)} spare.`,
    vramNeededGb, ramNeededGb, diskNeededGb,
    headroomGb,
    displaces: [],
    reasons,
    basis: requirement.basis,
    estimated: !!requirement.estimated,
  };
}

/**
 * Quantisations worth trying, best quality first.
 *
 * The order is the trade you actually make: every step down is smaller and
 * worse, so the useful answer to "does this 235B run here" is not yes/no but
 * "at which precision, and what did that cost you". bf16 is the reference;
 * fp8 is near-lossless on modern checkpoints; 4-bit is a real but usually
 * acceptable hit; 3-bit and below are included because on a 32 GB card they are
 * sometimes the difference between running a model and not, and the UI should
 * say so rather than pretend the option does not exist.
 */
export const PRECISION_LADDER: { id: Precision; label: string; note: string }[] = [
  { id: "bf16", label: "bf16", note: "Full precision — the reference the model was released at." },
  { id: "fp8", label: "fp8", note: "Half the weights, close to lossless on checkpoints trained for it." },
  { id: "nvfp4", label: "NVFP4", note: "Blackwell's native 4-bit — this card executes it in hardware. Small quality cost." },
  { id: "awq4", label: "AWQ 4-bit", note: "Widely available 4-bit. Small quality cost, large memory win." },
  { id: "gguf-q3", label: "GGUF Q3", note: "Noticeably degraded. Worth it only to fit a model that otherwise cannot run." },
  { id: "gguf-q2", label: "GGUF Q2", note: "Heavily degraded. A curiosity on this card, not a working configuration." },
];

/** The same trade, in the formats a Metal machine can actually load. */
const METAL_LADDER: { id: Precision; label: string; note: string }[] = [
  { id: "bf16", label: "bf16", note: "Full precision — the reference the model was released at." },
  { id: "mlx8", label: "MLX 8-bit", note: "Apple's 8-bit. Close to lossless, and the common MLX conversion." },
  { id: "mlx4", label: "MLX 4-bit", note: "Apple's 4-bit — the format most MLX community repos ship. Small quality cost." },
  { id: "gguf-q4", label: "GGUF Q4", note: "llama.cpp's 4-bit, Metal-accelerated. The portable alternative to MLX." },
  { id: "gguf-q3", label: "GGUF Q3", note: "Noticeably degraded. Worth it only to fit a model that otherwise cannot run." },
  { id: "gguf-q2", label: "GGUF Q2", note: "Heavily degraded. A curiosity, not a working configuration." },
];

/**
 * Which quantisations are worth offering on THIS machine.
 *
 * The ladder used to be a constant, which quietly asserted that every machine
 * is a Blackwell card: NVFP4 is not a format a Metal GPU can load, and fp8 has
 * no hardware path there either, so recommending them is recommending a
 * download that will not run. The reverse holds too — MLX on CUDA is not a
 * lower-quality option, it is not an option.
 *
 * Note this is about LOADABILITY, not speed. A rung that the machine cannot
 * execute must not appear at all, because bestPrecisionFor() returns the first
 * rung that fits and a phantom rung at the top would mask the real answer.
 */
export function precisionLadderFor(
  machine: Pick<MachineProfile, "runtime" | "computeCapability">,
): { id: Precision; label: string; note: string }[] {
  if (machine.runtime === "metal") return METAL_LADDER;
  if (machine.runtime !== "cuda") {
    // CPU and ROCm: no vendor 4-bit path we have measured, so offer the
    // portable GGUF rungs rather than inventing one.
    return PRECISION_LADDER.filter((r) => r.id !== "nvfp4");
  }
  // NVFP4 is hardware on sm_120 (compute 12.0) and emulated or absent below it.
  // An unknown capability keeps the rung: machine.ts always reports one on
  // CUDA, so the gap only happens for a hand-built profile, and dropping the
  // rung there would understate this box by a whole tier.
  const major = Number.parseInt(machine.computeCapability ?? "", 10);
  const blackwell = Number.isFinite(major) ? major >= 12 : true;
  return blackwell ? PRECISION_LADDER : PRECISION_LADDER.filter((r) => r.id !== "nvfp4");
}

export type PrecisionFit = {
  precision: Precision;
  label: string;
  note: string;
  requirement: Requirement;
  fit: Fit;
};

/**
 * The best precision this machine can actually run a model at, if any.
 *
 * Answers the question a parameter count alone cannot: a 235B is hopeless here
 * at any quantisation, a 30B is comfortable at 4-bit and impossible at bf16, and
 * only walking the ladder distinguishes those. Returns the first rung that fits
 * on an idle machine, plus every rung evaluated so the UI can show what was
 * given up to get there.
 */
export function bestPrecisionFor(opts: {
  paramsB: number;
  machine: MachineProfile;
  contextK?: number;
  kind?: ParamSpec["kind"];
  occupants?: Occupant[];
}): { best: PrecisionFit | null; rungs: PrecisionFit[] } {
  const rungs = precisionLadderFor(opts.machine).map(({ id, label, note }) => {
    const requirement = estimateFromParams({
      paramsB: opts.paramsB,
      precision: id,
      contextK: opts.contextK,
      kind: opts.kind,
      memoryModel: opts.machine.memoryModel,
    });
    return {
      precision: id,
      label,
      note,
      requirement,
      fit: evaluateFit({ requirement, machine: opts.machine, occupants: opts.occupants }),
    };
  });
  // "swap" counts as fitting: it means the model runs here once something else
  // stops, which is a scheduling decision, not a hardware limit.
  const best = rungs.find((r) => r.fit.verdict !== "no") ?? null;
  return { best, rungs };
}

export const VERDICT_LABEL: Record<FitVerdict, string> = {
  fits: "fits",
  tight: "fits alone",
  swap: "needs a swap",
  no: "won't fit",
  "off-box": "off-box",
};

/** Sort order for a list a human is scanning: actionable first, hopeless last. */
export const VERDICT_RANK: Record<FitVerdict, number> = {
  fits: 0,
  tight: 1,
  swap: 2,
  "off-box": 3,
  no: 4,
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtGb(n: number): string {
  return n < 1 ? `${Math.round(n * 1000)} MB` : `${round1(n)} GB`;
}
