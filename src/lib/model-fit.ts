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
  "gguf-q3": 0.45,
  "gguf-q2": 0.35,
};

export type Precision = keyof typeof BYTES_PER_PARAM | string;

/**
 * Runtime overhead above the weights: CUDA context, activations, the framework's
 * own allocator slack. 15% is the low end of what vLLM and diffusers actually
 * show on this card, so it errs toward optimism on purpose — the pessimism lives
 * in the safety margins below, where it is visible and adjustable.
 */
const RUNTIME_OVERHEAD = 1.15;

/**
 * KV cache, per 1k tokens of context, per billion parameters, at fp16.
 *
 * Derived from this box rather than from a general formula, because a general
 * formula needs layer/head/head_dim counts that a scouting report will not have.
 * local-small is the anchor: Qwen2.5-7B-AWQ at 16k context runs under
 * --gpu-memory-utilization 0.55 (17.5 GB) holding ~4.3 GB of weights, so the KV
 * allocation is roughly 13 GB — but vLLM claims the whole utilisation figure
 * whatever it needs, so that is an upper bound, not a measurement. The 0.0125
 * below is the conservative middle: it puts a 7B at 16k near 1.4 GB of KV, which
 * matches what modern GQA models actually report. Treat it as an order of
 * magnitude, which is all a "will it fit" verdict needs.
 */
const KV_GB_PER_K_PER_B = 0.0125;

export type MachineProfile = {
  gpuName: string;
  vramTotalGb: number;
  vramFreeGb: number;
  ramTotalGb: number;
  ramFreeGb: number;
  /** Free space on the drive Hugging Face weights land on (D: here). */
  weightsDiskFreeGb: number;
  weightsDiskLabel: string;
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
};

/** Enough to estimate a requirement when nobody published one. */
export type ParamSpec = {
  paramsB: number;
  precision: Precision;
  contextK?: number;
  /** Diffusion models stream weights from host RAM; LLM servers do not. */
  kind?: "llm" | "diffusion" | "audio";
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

  // Diffusion pipelines on this box are run with CPU offload, which is what lets
  // a 20B image model share a 32 GB card at all — but it makes the host RAM cost
  // permanent for as long as the service is loaded. See the local-qwen-image
  // footprint note in config/model-meta.json for the measurement that taught us
  // to count this. LLM servers keep the weights on the card and cost host RAM
  // only for the process itself.
  const ramGb = kind === "diffusion" ? round1(spec.paramsB * bpp) : 1;

  const parts = [
    `Estimated, not measured: ${spec.paramsB}B params x ${bpp} bytes/param (${spec.precision}) = ${round1(weightsGb)} GB of weights`,
    `x ${RUNTIME_OVERHEAD} runtime overhead`,
    contextK ? `+ ${round1(kvGb)} GB KV cache for ${contextK}k context` : null,
    kind === "diffusion"
      ? `Host RAM assumes CPU offload, which keeps the full ${round1(weightsGb)} GB resident for as long as the service runs.`
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

  const vramBudget = machine.vramTotalGb - vramSafetyGb;
  const ramBudget = machine.ramTotalGb - ramSafetyGb;
  const headroomGb = round1(vramBudget - vramNeededGb);

  // Disk is checked first and separately: it is the one constraint that blocks
  // you before the model ever runs, and it is also the easiest to fix.
  const diskShort = diskNeededGb > machine.weightsDiskFreeGb;
  if (diskShort) {
    reasons.push(
      `Needs ${fmtGb(diskNeededGb)} of weights but ${machine.weightsDiskLabel} has ${fmtGb(machine.weightsDiskFreeGb)} free.`,
    );
  }

  // Does it fit on an empty machine at all?
  if (vramNeededGb > vramBudget) {
    reasons.unshift(
      `Needs ${fmtGb(vramNeededGb)} of VRAM; ${machine.gpuName} has ${fmtGb(machine.vramTotalGb)} total, ${fmtGb(vramBudget)} usable after the safety margin.`,
    );
    return {
      verdict: "no",
      headline: `Too big for this card — ${fmtGb(vramNeededGb)} needed against ${fmtGb(machine.vramTotalGb)}.`,
      vramNeededGb, ramNeededGb, diskNeededGb,
      headroomGb,
      displaces: [],
      reasons,
      basis: requirement.basis,
      estimated: !!requirement.estimated,
    };
  }
  if (ramNeededGb > ramBudget) {
    reasons.unshift(
      `Needs ${fmtGb(ramNeededGb)} of host RAM; this box has ${fmtGb(machine.ramTotalGb)}, ${fmtGb(ramBudget)} usable after the safety margin.`,
    );
    return {
      verdict: "no",
      headline: `Too big for host RAM — ${fmtGb(ramNeededGb)} needed against ${fmtGb(machine.ramTotalGb)}.`,
      vramNeededGb, ramNeededGb, diskNeededGb,
      headroomGb,
      displaces: [],
      reasons,
      basis: requirement.basis,
      estimated: !!requirement.estimated,
    };
  }

  // It fits on an idle machine. Does it fit on THIS machine, right now?
  const heldVram = occupants.reduce((a, o) => a + o.vramGb, 0);
  const heldRam = occupants.reduce((a, o) => a + o.ramGb, 0);
  const vramShortNow = vramNeededGb > machine.vramFreeGb - vramSafetyGb;
  const ramShortNow = ramNeededGb > machine.ramFreeGb - ramSafetyGb;

  if ((vramShortNow || ramShortNow) && occupants.length > 0) {
    // Free the biggest holders first, and stop as soon as there is room — the
    // point is the SHORTEST list of things to stop, not a tidy sort order.
    const byCost = [...occupants].sort(
      (a, b) => (b.vramGb + b.ramGb) - (a.vramGb + a.ramGb),
    );
    const displaces: string[] = [];
    let freeVram = machine.vramFreeGb;
    let freeRam = machine.ramFreeGb;
    for (const o of byCost) {
      if (vramNeededGb <= freeVram - vramSafetyGb && ramNeededGb <= freeRam - ramSafetyGb) break;
      displaces.push(o.serviceId);
      freeVram += o.vramGb;
      freeRam += o.ramGb;
    }
    if (vramNeededGb <= freeVram - vramSafetyGb && ramNeededGb <= freeRam - ramSafetyGb) {
      const names = displaces
        .map((id) => occupants.find((o) => o.serviceId === id)?.name ?? id)
        .join(" and ");
      reasons.unshift(
        `${fmtGb(heldVram)} VRAM and ${fmtGb(heldRam)} RAM are held by services that are up right now.`,
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

  // Room on an idle card, but not enough left over to matter.
  const tight = headroomGb < machine.vramTotalGb * TIGHT_HEADROOM_FRACTION;
  if (tight) {
    reasons.unshift(
      `Leaves ${fmtGb(Math.max(0, headroomGb))} on the card — effectively the whole GPU, so nothing else can be loaded while it runs.`,
    );
  } else {
    reasons.unshift(
      `Leaves ${fmtGb(headroomGb)} of VRAM free — room for a small model or an image run beside it.`,
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
        ? `Fits, but takes the whole card — ${fmtGb(vramNeededGb)} of ${fmtGb(machine.vramTotalGb)}.`
        : `Fits comfortably — ${fmtGb(vramNeededGb)} of ${fmtGb(machine.vramTotalGb)}, ${fmtGb(headroomGb)} spare.`,
    vramNeededGb, ramNeededGb, diskNeededGb,
    headroomGb,
    displaces: [],
    reasons,
    basis: requirement.basis,
    estimated: !!requirement.estimated,
  };
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
