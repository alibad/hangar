"use client";

// The hosted-model half of the Image Studio's form, drawn from the capability
// registry (src/lib/cloud-image-models.ts): a control exists only when the
// selected model takes that parameter AND the router can deliver it, every
// value offered is one the model accepts, and the run is costed before it is
// made. Also: the gallery's "parameters used" panel with Recreate.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ROUTER_EDIT_DROPS,
  estimateCloudImageCost,
  flexibleSizeProblems,
  parseSize,
  validateCloudImageParams,
  type CloudImageKind,
  type CloudImageParams,
  type CloudImageSpec,
  type OutputFormat,
} from "@/lib/cloud-image-models";

/** Grey checkerboard, the usual "this pixel is transparent" backdrop. */
export const CHECKERBOARD: CSSProperties = {
  backgroundColor: "#9ca3af",
  backgroundImage: "repeating-conic-gradient(#6b7280 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** Problems that would make the server refuse this form, for disabling Run. */
export function cloudFormErrors(spec: CloudImageSpec, value: CloudImageParams, ctx: { kind: CloudImageKind; imageCount?: number; hasMask?: boolean }): string[] {
  const v = validateCloudImageParams(spec, value, ctx);
  return v.ok ? [] : v.errors;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="w-24 shrink-0 text-gray-500" title={hint}>{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options, value, onChange, disabled, label, render, isDisabled, titleFor,
}: {
  options: T[];
  value: T | undefined;
  onChange: (v: T) => void;
  disabled?: boolean;
  label: string;
  render?: (v: T) => ReactNode;
  isDisabled?: (v: T) => boolean;
  titleFor?: (v: T) => string | undefined;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-gray-700 bg-gray-800 p-0.5">
      {options.map((o) => {
        const active = o === value;
        const off = disabled || isDisabled?.(o);
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={off}
            title={titleFor?.(o)}
            onClick={() => onChange(o)}
            className={`rounded-md px-2.5 py-1 text-xs transition disabled:opacity-35 ${
              active ? "bg-pink-600 text-white" : "text-gray-300 hover:text-gray-100"
            }`}
          >
            {render ? render(o) : o}
          </button>
        );
      })}
    </div>
  );
}

const QUALITY_HINT: Record<string, string> = {
  auto: "The model picks; the price lands anywhere from low to the highest tier",
  low: "Drafts — fastest and cheapest",
  medium: "Balanced",
  high: "Final assets",
  xhigh: "2.5 only — above high",
  max: "2.5 only — the most detail and cost",
};

export default function CloudImageControls({
  spec, kind, value, onChange, imageCount = 0, promptChars = 0, hasMask = false, disabled,
}: {
  spec: CloudImageSpec;
  kind: CloudImageKind;
  value: CloudImageParams;
  onChange: (next: CloudImageParams) => void;
  imageCount?: number;
  promptChars?: number;
  hasMask?: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<CloudImageParams>) => onChange({ ...value, ...patch });
  const rule = spec.size;

  // Custom size is typed, so it holds text until it parses.
  const custom = rule.kind === "flexible" && !!value.size && value.size !== "auto" && !rule.presets.includes(value.size);
  const [customMode, setCustomMode] = useState(custom);
  const [cw, setCw] = useState(() => String(parseSize(value.size ?? "")?.w ?? 1536));
  const [ch, setCh] = useState(() => String(parseSize(value.size ?? "")?.h ?? 864));
  useEffect(() => { setCustomMode(custom); }, [spec.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // No references yet is not an error worth shouting about: Run is disabled
  // until one is added. Too many is, so the real count is checked past one.
  const v = useMemo(
    () => validateCloudImageParams(spec, value, { kind, imageCount: kind === "edit" ? Math.max(1, imageCount) : imageCount, hasMask }),
    [spec, value, kind, imageCount, hasMask],
  );
  const estimate = useMemo(
    () => estimateCloudImageCost(spec, v.ok ? v.params : value, { kind, imageCount, promptChars }),
    [spec, v, value, kind, imageCount, promptChars],
  );
  const sizeProblems = rule.kind === "flexible" && customMode
    ? (() => { const w = Number(cw), h = Number(ch); return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? flexibleSizeProblems(rule, w, h) : ["Whole numbers, please."]; })()
    : [];
  const fmt = value.output_format ?? spec.outputFormat?.default;
  const transparent = value.background === "transparent";
  const editDrops = kind === "edit" && spec.family === "openai"
    ? ROUTER_EDIT_DROPS.filter((k) => k === "moderation" ? value.moderation === "low" : k === "output_format" ? fmt && fmt !== "png" : false)
    : [];

  return (
    <section aria-label={`${spec.label} parameters`} className="space-y-2.5 rounded-xl border border-gray-800 bg-gray-950/40 p-3 text-xs">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium text-gray-200">{spec.label}</span>
        <span className="text-[11px] text-gray-500">{spec.blurb}</span>
        {spec.status && spec.status !== "stable" && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300" title={spec.statusNote}>{spec.status}</span>
        )}
        <a href={spec.docs[0]} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-gray-500 underline hover:text-gray-300">docs</a>
      </div>

      {spec.quality && (
        <Row label="Quality">
          <Segmented label="Quality" options={spec.quality.values} value={value.quality ?? spec.quality.default} onChange={(q) => set({ quality: q })} disabled={disabled} titleFor={(q) => QUALITY_HINT[q]} />
        </Row>
      )}

      {/* Size: pixels for OpenAI (fixed list or validated custom), aspect + tier for Gemini. */}
      {rule.kind === "fixed" && (
        <Row label="Size">
          <Segmented label="Size" options={["auto", ...rule.sizes]} value={value.size ?? rule.default} onChange={(s) => set({ size: s })} disabled={disabled}
            render={(s) => (s === "auto" ? "auto" : s === "1024x1024" ? "1:1 · 1024²" : s === "1536x1024" ? "3:2 · 1536×1024" : "2:3 · 1024×1536")} />
        </Row>
      )}
      {rule.kind === "flexible" && (
        <Row label="Size" hint="Multiples of 16, between 1:3 and 3:1, no edge over 3840px, 655,360–8,294,400 pixels">
          <select
            aria-label="Size"
            disabled={disabled}
            value={customMode ? "__custom__" : value.size ?? rule.default}
            onChange={(e) => {
              if (e.target.value === "__custom__") { setCustomMode(true); set({ size: `${cw}x${ch}` }); }
              else { setCustomMode(false); set({ size: e.target.value }); }
            }}
            className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-300"
          >
            <option value="auto">auto (model picks)</option>
            {rule.presets.map((p) => <option key={p} value={p}>{p.replace("x", " × ")}{parseSize(p)!.w * parseSize(p)!.h > rule.experimentalAbovePixels ? " · experimental" : ""}</option>)}
            <option value="__custom__">Custom…</option>
          </select>
          {customMode && (
            <span className="inline-flex items-center gap-1">
              <input aria-label="Custom width" inputMode="numeric" value={cw} disabled={disabled}
                onChange={(e) => { setCw(e.target.value); set({ size: `${e.target.value}x${ch}` }); }}
                className="w-20 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 tabular-nums text-gray-300" />
              <span className="text-gray-500">×</span>
              <input aria-label="Custom height" inputMode="numeric" value={ch} disabled={disabled}
                onChange={(e) => { setCh(e.target.value); set({ size: `${cw}x${e.target.value}` }); }}
                className="w-20 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 tabular-nums text-gray-300" />
            </span>
          )}
          {customMode && sizeProblems.length > 0 && <span role="alert" className="basis-full pl-[6.5rem] text-[11px] text-red-400">{sizeProblems.join(" ")}</span>}
        </Row>
      )}
      {rule.kind === "gemini" && (
        <>
          <Row label="Aspect ratio" hint="Unset = match the first reference image, or 1:1">
            <select aria-label="Aspect ratio" disabled={disabled} value={value.aspect_ratio ?? ""} onChange={(e) => set({ aspect_ratio: e.target.value || undefined })}
              className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-300">
              <option value="">auto ({kind === "edit" ? "match input" : "1:1"})</option>
              {rule.aspectRatios.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Row>
          {rule.imageSizes && rule.imageSizes.length > 1 && (
            <Row label="Resolution">
              <Segmented label="Resolution" options={rule.imageSizes} value={value.image_size ?? rule.default} onChange={(s) => set({ image_size: s })} disabled={disabled} />
            </Row>
          )}
        </>
      )}

      {spec.n.max > 1 && (
        <Row label="Images" hint={`1 to ${spec.n.max} per call; each is saved to the gallery`}>
          <input type="number" aria-label="Number of images" min={1} max={spec.n.max} value={value.n} disabled={disabled}
            onChange={(e) => set({ n: Math.max(1, Math.min(spec.n.max, Math.floor(Number(e.target.value) || 1))) })}
            className="w-16 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 tabular-nums text-gray-300" />
          <span className="text-[11px] text-gray-500">of up to {spec.n.max}</span>
        </Row>
      )}

      {spec.background && (
        <Row label="Background">
          <Segmented
            label="Background"
            options={spec.background.values}
            value={value.background ?? spec.background.default}
            onChange={(b) => set({ background: b, ...(b === "transparent" && fmt === "jpeg" ? { output_format: "png" as OutputFormat, output_compression: undefined } : {}) })}
            disabled={disabled}
            render={(b) => (
              <span className="inline-flex items-center gap-1.5">
                {b !== "auto" && (
                  <span aria-hidden className="inline-block h-3 w-3 rounded-sm border border-gray-500" style={b === "transparent" ? CHECKERBOARD : { background: "#e5e7eb" }} />
                )}
                {b}
              </span>
            )}
          />
          {spec.background.transparentNote && <span className="text-[11px] text-gray-500">{spec.background.transparentNote}</span>}
        </Row>
      )}

      {spec.outputFormat && (
        <Row label="Format">
          <Segmented
            label="Output format"
            options={spec.outputFormat.values}
            value={fmt}
            onChange={(f) => set({ output_format: f, output_compression: f === "png" ? undefined : value.output_compression })}
            disabled={disabled}
            isDisabled={(f) => transparent && f === "jpeg"}
            titleFor={(f) => (transparent && f === "jpeg" ? "JPEG has no alpha channel" : undefined)}
          />
          {spec.outputCompression && (fmt === "jpeg" || fmt === "webp") && (
            <label className="inline-flex items-center gap-2 text-gray-500" title="OpenAI's output_compression. Measured: it acts as a quality level — 100 (default) is the largest file, lower is smaller.">
              level
              <input type="range" min={0} max={100} value={value.output_compression ?? 100} disabled={disabled}
                onChange={(e) => set({ output_compression: Number(e.target.value) })} aria-label="Compression level" />
              <span className="w-8 tabular-nums text-gray-300">{value.output_compression ?? 100}</span>
            </label>
          )}
        </Row>
      )}

      {spec.moderation && (
        <Row label="Moderation" hint="OpenAI's content filter strictness for this request">
          <Segmented label="Moderation" options={spec.moderation.values} value={value.moderation ?? spec.moderation.default} onChange={(m) => set({ moderation: m })} disabled={disabled}
            titleFor={(m) => (m === "low" ? "Less restrictive filtering" : "Standard filtering")} />
        </Row>
      )}

      {spec.webSearch && kind === "generate" && (
        <Row label="Grounding">
          <label className="inline-flex items-center gap-1.5 text-gray-400">
            <input type="checkbox" checked={!!value.web_search} disabled={disabled} onChange={(e) => set({ web_search: e.target.checked || undefined })} />
            Google Search (current facts, real places)
          </label>
        </Row>
      )}

      {kind === "edit" && spec.edit?.inputFidelity && (
        <Row label="Fidelity" hint="How closely the edit preserves the reference images' details">
          <Segmented label="Input fidelity" options={spec.edit.inputFidelity.values} value={value.input_fidelity ?? spec.edit.inputFidelity.default} onChange={(f) => set({ input_fidelity: f })} disabled={disabled} />
        </Row>
      )}

      <div className="flex items-baseline gap-2 flex-wrap border-t border-gray-800 pt-2">
        <span className="text-gray-500">Estimated</span>
        <span className="font-medium tabular-nums text-gray-100" aria-label="Estimated cost">
          {estimate.high > estimate.low * 1.05 ? `${fmtUsd(estimate.low)}–${fmtUsd(estimate.high)}` : fmtUsd(estimate.usd)}
        </span>
        <span className="text-[11px] text-gray-500">{estimate.basis}{estimate.rough ? " The router's actual cost is shown after the run." : ""}</span>
      </div>

      {kind === "edit" && spec.edit?.note && <p className="text-[11px] text-gray-500">{spec.edit.note}</p>}
      {editDrops.length > 0 && (
        <p className="text-[11px] text-amber-300/90">
          The AI Router (LiteLLM 1.94.0) drops {editDrops.join(" and ")} on edits until its patch is live.
          {editDrops.includes("output_format") ? " The console converts the result to the format you picked and records that it did." : ""}
          {editDrops.includes("moderation") ? " Moderation stays at the default for this edit." : ""}
        </p>
      )}
      {v.warnings.length > 0 && <p className="text-[11px] text-gray-500">{v.warnings.join(" ")}</p>}
      {/* A custom-size problem is already shown beside the size inputs. */}
      {!v.ok && v.errors.some((e) => !(customMode && e.startsWith("size "))) && (
        <p role="alert" className="text-[11px] text-red-400">{v.errors.filter((e) => !(customMode && e.startsWith("size "))).join(" ")}</p>
      )}
    </section>
  );
}

// ── gallery details: the parameters an image was made with ──────────────────

type CloudSidecar = {
  model?: string;
  prompt?: string;
  kind?: string;
  format?: string;
  cloud?: {
    alias?: string;
    vendor?: string;
    params?: CloudImageParams;
    warnings?: string[];
    index?: number;
    count?: number;
    costUsd?: number;
    costUsdTotal?: number;
    costSource?: string;
    usage?: { inputTokens?: number; outputTokens?: number; inputImageTokens?: number } | null;
    response?: Record<string, string>;
    revisedPrompt?: string | null;
    transcoded?: boolean;
    referenceCount?: number;
    mask?: boolean;
    source?: string;
  };
};

const LABELS: Record<string, string> = {
  quality: "quality", size: "size", n: "images", background: "background", output_format: "format",
  output_compression: "level", moderation: "moderation", input_fidelity: "fidelity",
  aspect_ratio: "aspect", image_size: "resolution", web_search: "search",
};

/**
 * The hosted-model parameters behind a gallery image, read from its sidecar.
 * Renders nothing for local images (they have no `cloud` block).
 */
export function CloudParamsDetails({ rel, onRecreate }: { rel: string; onRecreate: (meta: { model: string; prompt: string; kind: string; params: CloudImageParams; referenceCount?: number }) => void }) {
  const [meta, setMeta] = useState<CloudSidecar | null>(null);
  useEffect(() => {
    let live = true;
    setMeta(null);
    fetch(`/api/qwen/images/meta?rel=${encodeURIComponent(rel)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (live) setMeta(m); })
      .catch(() => {});
    return () => { live = false; };
  }, [rel]);
  const c = meta?.cloud;
  if (!c?.params) return null;
  const entries = Object.entries(c.params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-[11px] text-gray-400" aria-label="Parameters used">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-gray-300">Parameters used</span>
        {entries.map(([k, val]) => (
          <span key={k} className="rounded bg-gray-800 px-1.5 py-0.5 tabular-nums">
            <span className="text-gray-500">{LABELS[k] ?? k}</span> {String(val)}
          </span>
        ))}
        {c.count && c.count > 1 && <span className="text-gray-500">image {c.index} of {c.count}</span>}
        {c.referenceCount ? <span className="text-gray-500">{c.referenceCount} reference{c.referenceCount > 1 ? "s" : ""}{c.mask ? " + mask" : ""}</span> : null}
        <button
          type="button"
          onClick={() => onRecreate({ model: c.alias || meta?.model || "", prompt: meta?.prompt || "", kind: meta?.kind || "generate", params: c.params!, referenceCount: c.referenceCount })}
          className="ml-auto rounded-md border border-pink-600/50 px-3 py-1.5 text-xs text-pink-200 hover:bg-pink-600/10"
        >
          Recreate with these settings
        </button>
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap tabular-nums">
        {c.costUsd != null && (
          <span title={c.costSource === "router" ? "The router's own price for the call (x-litellm-response-cost), split across its images" : "Estimated — the router sent no price"}>
            {fmtUsd(c.costUsd)}{c.count && c.count > 1 ? ` (of ${fmtUsd(c.costUsdTotal ?? c.costUsd)})` : ""} · {c.costSource === "router" ? "router-reported" : "estimate"}
          </span>
        )}
        {c.usage?.outputTokens != null && <span>{c.usage.outputTokens.toLocaleString()} output tokens{c.usage.inputImageTokens ? ` · ${c.usage.inputImageTokens.toLocaleString()} image input` : ""}</span>}
        {c.response && Object.keys(c.response).length > 0 && (
          <span title="What the provider says it produced">provider: {Object.entries(c.response).map(([k, v]) => `${k} ${v}`).join(", ")}</span>
        )}
        {meta?.format && <span>file {meta.format}</span>}
        {c.transcoded && <span className="text-amber-300/90" title="The router dropped output_format, so the console converted the image">converted by the console</span>}
        {c.source && <span className="text-gray-600">via {c.source}</span>}
      </div>
      {c.revisedPrompt && <p className="mt-1.5 text-gray-500">Revised prompt: {c.revisedPrompt}</p>}
      {c.warnings && c.warnings.length > 0 && <p className="mt-1.5 text-gray-600">{c.warnings.join(" ")}</p>}
    </div>
  );
}
