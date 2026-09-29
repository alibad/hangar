"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import BpmnView from "./bpmn-view";
import { ACTOR, KIND_STYLE, fileUrl, fmtCost, fmtMs, lab, type CaseDetail, type CaseRow, type Decision, type Guide, type Stage, type StoryEntry } from "./api";

/**
 * The case list, and one case told as a story.
 *
 * A case opens on what a person needs first — what is happening now, which of
 * the six stages it is in, and what has happened so far in plain words. The
 * BPMN diagram and the raw decision table are still here, folded away below:
 * they are how an engineer checks the story, not how anyone should read it.
 */
export default function CasesView({
  runFilter,
  onRunFilter,
  runs,
  guide,
  onOpenInbox,
}: {
  runFilter: string;
  onRunFilter: (r: string) => void;
  runs: { id: string }[];
  guide: Guide | null;
  onOpenInbox: () => void;
}) {
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await lab<CaseRow[]>(`api/cases?limit=80${runFilter ? `&run=${encodeURIComponent(runFilter)}` : ""}`));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [runFilter]);

  useEffect(() => {
    load();
    const iv = setInterval(() => !document.hidden && load(), 4000);
    return () => clearInterval(iv);
  }, [load]);

  const stepName = (id: string) => guide?.steps[id]?.name ?? id;
  const stageLabel = (id: string) => guide?.stages.find((s) => s.id === guide?.steps[id]?.stage)?.label ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
        <label className="flex items-center gap-2">
          Run
          <select value={runFilter} onChange={(e) => onRunFilter(e.target.value)} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
            <option value="">all cases</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>{r.id}</option>
            ))}
          </select>
        </label>
        {rows && <span>{rows.filter((r) => r.state === "ACTIVE").length} active · {rows.length} shown · click a case to read its story</span>}
      </div>
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-gray-900/80 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Case</th>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Service</th>
              <th className="px-3 py-2">Now / outcome</th>
              <th className="px-3 py-2 text-right">Age (days)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows?.map((r) => (
              <tr
                key={r.caseKey}
                onClick={() => setSelected(selected === r.caseKey ? null : r.caseKey)}
                className={`cursor-pointer hover:bg-gray-800/40 ${selected === r.caseKey ? "bg-orange-500/[0.06]" : ""}`}
              >
                <td className="px-3 py-2">
                  <span className="font-mono text-gray-200">{r.caseKey}</span>
                  {r.label && <span className="block text-[11px] text-gray-500">{r.label}</span>}
                </td>
                <td className="px-3 py-2 text-gray-300">
                  {r.clientName}
                  <span className="block text-[11px] text-gray-500">→ {r.destination}</span>
                </td>
                <td className="px-3 py-2 text-gray-300">{r.service ?? <span className="text-gray-600">not yet known</span>}</td>
                <td className="px-3 py-2">
                  {r.state === "ACTIVE" ? (
                    <span className="text-orange-300">
                      {r.current.map(stepName).join(", ") || "—"}
                      {r.current[0] && stageLabel(r.current[0]) && <span className="ml-1.5 text-[10px] text-gray-500">({stageLabel(r.current[0])})</span>}
                    </span>
                  ) : (
                    <span className={r.outcome === "completed" ? "text-emerald-300" : "text-gray-400"}>{r.outcome}</span>
                  )}
                  {r.incidents > 0 && <span className="ml-2 rounded bg-red-950 px-1.5 text-[10px] text-red-300">stuck</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-400">{r.ageDays}</td>
              </tr>
            ))}
            {rows && !rows.length && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-gray-500">No cases yet. Start a simulation, or a single case, from Simulate.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {selected && <CaseDetailView caseKey={selected} guide={guide} onOpenInbox={onOpenInbox} />}
    </div>
  );
}

function CaseDetailView({ caseKey, guide, onOpenInbox }: { caseKey: string; guide: Guide | null; onOpenInbox: () => void }) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await lab<CaseDetail>(`api/cases/${encodeURIComponent(caseKey)}`);
        if (alive) {
          setD(c);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const iv = setInterval(() => !document.hidden && load(), 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [caseKey]);

  const defId = d?.definitionId;
  useEffect(() => {
    if (!defId) return;
    lab<{ bpmn20Xml: string }>(`api/definitions/${encodeURIComponent(defId)}/xml`).then((r) => setXml(r.bpmn20Xml), (e) => setErr(String(e)));
  }, [defId]);

  const visited = useMemo(() => [...new Set((d?.activities ?? []).filter((a) => a.end).map((a) => a.id))], [d]);

  // A failed refresh keeps the last good story on screen; only a case that
  // never loaded shows the error in its place.
  if (!d) return err ? <p className="text-xs text-red-300">{err}</p> : <p className="text-xs text-gray-500">Loading {caseKey}…</p>;

  const v = d.variables;
  const service = v.service ? `a ${String(v.service).replace(/-/g, " ")}` : "something not yet clear";
  return (
    <section className="tool-panel space-y-5 rounded-xl border border-gray-800 bg-gray-900 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-100">
            {String(v.clientName ?? "")} <span className="font-normal text-gray-400">wants {service}{v.purpose ? ` (${String(v.purpose)})` : ""} in {String(v.destination)}</span>
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            <span className="font-mono">{d.caseKey}</span> · {String(v.passportCountry)} passport · writes in {String(v.clientLanguage)}
            {v.agencyFee != null && ` · fee €${String(v.agencyFee)}, promised within ${String(v.slaDays)} days`} · day {d.ageDays}
          </p>
        </div>
        {d.truth && (
          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400" title="This is a simulated client; the simulation knows what should happen.">
            simulated · should end: {String(d.truth.expected)}
          </span>
        )}
      </header>

      <NowBanner now={d.now} onOpenInbox={onOpenInbox} />
      {err && <p className="-mt-3 text-[11px] text-amber-300">Couldn&apos;t refresh just now ({err}); showing the last update.</p>}
      <StageBar stages={d.stages} />

      {d.state === "ACTIVE" && d.current.includes("gw_wait") && !v.simulated && <Upload caseKey={d.caseKey} />}

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-gray-100">What has happened</h4>
          <ActorLegend />
        </div>
        <Story entries={d.story} stages={d.stages} />
      </div>

      <Fold title="The process diagram" hint="the same case on the engine's BPMN map — click any step to see what it does">
        {xml ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
            <BpmnView xml={xml} current={d.current} visited={visited} failed={d.incidents.map((i) => i.activityId)} selected={step} onSelect={setStep} />
            <StepHelp id={step} guide={guide} story={d.story} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">Loading diagram…</p>
        )}
      </Fold>

      {d.incidents.length > 0 && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-200">
          {d.incidents.map((i) => (
            <p key={i.activityId + i.time}>
              <b>{guide?.steps[i.activityId]?.name ?? i.activityId}</b>: {i.message}
            </p>
          ))}
          <p className="mt-1 text-red-300/70">Retry it from Cockpit (Incidents → Increment retries), or fix the cause and wait for the next retry.</p>
        </div>
      )}

      <Fold title="Every decision, in detail" hint={`${plural(d.decisions.length, "decision")} with model, confidence, time and cost`}>
        <DecisionTable decisions={d.decisions} />
      </Fold>

      <Fold title="Documents and emails" hint={`${plural(d.documents.length, "document")} · ${plural(d.emails.length, "email")}`} open={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            {d.documents.length === 0 && <p className="text-xs text-gray-600">None received.</p>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {d.documents.map((doc) => (
                <a key={doc.id} href={fileUrl(doc.url)} target="_blank" rel="noreferrer" className="block rounded-lg border border-gray-800 p-1.5 hover:border-gray-600">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={fileUrl(doc.url)} alt={`document ${doc.id}`} className="h-20 w-full rounded object-cover object-top" />
                  <p className="mt-1 truncate text-[11px] text-gray-300">
                    {String(doc.extraction?.docType ?? "unread")} {doc.extraction?.language ? `(${String(doc.extraction.language)})` : ""}
                  </p>
                  <p className={`truncate text-[10px] ${doc.accepted ? "text-emerald-400" : doc.problem ? "text-amber-300" : "text-gray-500"}`}>
                    round {doc.round} · {doc.accepted ? "accepted" : doc.problem ?? "not read yet"}
                  </p>
                </a>
              ))}
            </div>
            {d.artifacts.filter((a) => a.kind === "audio").map((a) => (
              <div key={a.id} className="mt-3">
                <p className="mb-1 text-[11px] text-gray-500">Spoken status update ({String(a.detail?.service ?? "")}, {fmtMs(Number(a.detail?.latencyMs))})</p>
                <audio controls src={fileUrl(a.url)} className="w-full" />
              </div>
            ))}
          </div>
          <div className="space-y-2">
            {d.emails.length === 0 && <p className="text-xs text-gray-600">None yet.</p>}
            {d.emails.map((e) => (
              <details key={e.id} className="rounded-lg border border-gray-800 px-3 py-2">
                <summary className="cursor-pointer text-xs text-gray-200">
                  <span className="mr-2 rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">{e.purpose}</span>
                  {e.subject}
                </summary>
                <p dir={e.language === "ar" ? "rtl" : "ltr"} className="mt-2 whitespace-pre-wrap text-xs text-gray-400">{e.body}</p>
              </details>
            ))}
          </div>
        </div>
      </Fold>
    </section>
  );
}

// ── the story ─────────────────────────────────────────────────────────────

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Status colours only from the theme's semantic families (emerald = ok,
// amber = needs someone, red = error). sky/cyan/violet are category hues the
// theme derives from the accent, and can come out red.
const TONE = {
  working: "border-gray-600 bg-gray-800/50 text-gray-100",
  person: "border-amber-600/70 bg-amber-950/40 text-amber-100",
  done: "border-emerald-700/60 bg-emerald-950/30 text-emerald-100",
  closed: "border-gray-700 bg-gray-950/60 text-gray-200",
  bad: "border-red-700/70 bg-red-950/40 text-red-100",
} as const;

function NowBanner({ now, onOpenInbox }: { now: CaseDetail["now"]; onOpenInbox: () => void }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${TONE[now.tone] ?? TONE.working}`}>
      <p className="text-sm">
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide opacity-70">{now.tone === "done" || now.tone === "closed" ? "Outcome" : "Right now"}</span>
        {now.text}
      </p>
      {now.needsPerson && (
        <button onClick={onOpenInbox} className="rounded-md border border-amber-500 bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/30">
          This is waiting for you — open the Inbox
        </button>
      )}
    </div>
  );
}

function StageBar({ stages }: { stages: Stage[] }) {
  return (
    <ol className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-6">
      {stages.map((s, i) => {
        const style =
          s.state === "done"
            ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-200"
            : s.state === "current"
              ? "border-orange-500 bg-orange-500/15 text-orange-100"
              : s.state === "skipped"
                ? "border-gray-800 bg-transparent text-gray-600 line-through"
                : "border-gray-800 bg-gray-950/40 text-gray-500";
        return (
          <li key={s.id} className={`rounded-lg border px-3 py-2 ${style}`} title={s.about}>
            <span className="text-[10px] opacity-70">
              {i + 1} · {s.state === "done" ? "done" : s.state === "current" ? "now" : s.state === "skipped" ? "not reached" : "next"}
            </span>
            <span className="block text-sm font-medium">{s.label}</span>
            <span className="block text-[10px] leading-snug opacity-70">{s.about}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** **bold** in the lab's sentences → <b>. Nothing else is interpreted. */
function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") ? <b key={i} className="font-semibold text-gray-50">{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

export function ActorBadge({ kind }: { kind: string }) {
  const a = ACTOR[kind] ?? ACTOR.system;
  return (
    <span className="inline-block w-[7.5rem] shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-center text-[10px] font-medium" style={{ borderColor: a.hex, color: a.hex, background: `${a.hex}1a` }} title={a.explain}>
      {a.label}
    </span>
  );
}

function ActorLegend() {
  return (
    <details className="text-[11px] text-gray-500">
      <summary className="cursor-pointer">Who does what?</summary>
      <ul className="mt-2 space-y-1 rounded-lg border border-gray-800 bg-gray-950/60 p-3">
        {["client", "dmn", "decision-model", "llm", "human", "system", "wait"].map((k) => (
          <li key={k} className="flex items-start gap-2">
            <ActorBadge kind={k} />
            <span className="text-gray-400">{ACTOR[k].explain}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Story({ entries, stages }: { entries: StoryEntry[]; stages: Stage[] }) {
  const label = (id: string | null) => stages.find((s) => s.id === id)?.label ?? "";
  let lastStage: string | null = null;
  return (
    <ol className="space-y-0">
      {entries.map((e, i) => {
        const header = e.stage && e.stage !== lastStage;
        lastStage = e.stage ?? lastStage;
        return (
          <Fragment key={i}>
            {header && <li className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label(e.stage)}</li>}
            <li className={`flex items-start gap-3 rounded-md px-2 py-1.5 ${e.active ? "bg-orange-500/[0.07]" : ""}`}>
              {e.active ? (
                <span className="w-14 shrink-0 pt-0.5 text-right text-[11px] font-semibold text-orange-300" title={`Since day ${e.day}`}>now</span>
              ) : (
                <span className="w-14 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-gray-500">day {e.day}</span>
              )}
              <ActorBadge kind={e.kind} />
              <div className="min-w-0 text-[13px] leading-snug text-gray-300">
                {rich(e.text)}
                {e.active && <span className="ml-2 animate-pulse text-[11px] text-orange-300">in progress</span>}
                {e.flag && <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-[10px] text-red-300">{e.flag}</span>}
                {e.docUrl && (
                  <a href={fileUrl(e.docUrl)} target="_blank" rel="noreferrer" className="ml-2 text-[11px] text-gray-500 underline">
                    view document
                  </a>
                )}
                {e.detail && <p className="mt-1 border-l-2 border-gray-700 pl-2 text-[12px] text-gray-400">{e.detail}</p>}
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

function StepHelp({ id, guide, story }: { id: string | null; guide: Guide | null; story: StoryEntry[] }) {
  if (!id) {
    return (
      <aside className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-xs text-gray-400">
        <p className="mb-2 font-medium text-gray-300">Reading the diagram</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Each box is a step; arrows are the order they happen in.</li>
          <li>
            <span className="text-orange-300">Orange</span> is where this case is now; <span className="text-emerald-300">green</span> is where it has been.
          </li>
          <li>The tag on a box says who decides there: a rule, a decision model, an AI, a person.</li>
          <li>Diamonds are forks: the case goes one way or the other depending on an answer.</li>
          <li>Drag to pan, scroll to zoom. Click a step to see what it does.</li>
        </ul>
      </aside>
    );
  }
  const s = guide?.steps[id];
  const here = story.filter((e) => e.activityId === id);
  return (
    <aside className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-xs">
      <p className="text-sm font-semibold text-gray-100">{s?.name ?? id}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
        {s?.kind && <ActorBadge kind={s.kind} />}
        {s?.stage && <span>stage: {guide?.stages.find((x) => x.id === s.stage)?.label}</span>}
      </p>
      <p className="mt-2 text-gray-300">{s?.doc ?? "No description for this step."}</p>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">In this case</p>
      {here.length ? (
        <ul className="mt-1 space-y-1 text-gray-400">
          {here.map((e, i) => (
            <li key={i}>
              day {e.day}: {rich(e.text)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-gray-500">Nothing recorded here for this case (not reached, or a fork that just routes).</p>
      )}
    </aside>
  );
}

function Fold({ title, hint, children, open = false }: { title: string; hint: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-lg border border-gray-800" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-sm text-gray-200">
        {title} <span className="ml-1 text-[11px] text-gray-500">— {hint}</span>
      </summary>
      <div className="border-t border-gray-800 p-3">{children}</div>
    </details>
  );
}

// ── the technical view ─────────────────────────────────────────────────────

export function DecisionTable({ decisions }: { decisions: Decision[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-gray-900/80 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Question → decided</th>
            <th className="px-3 py-2 text-right">Confidence</th>
            <th className="px-3 py-2 text-right">Took</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {decisions.map((x, i) => {
            const failedLocal = x.detail?.attempts?.filter((a) => !a.ok) ?? [];
            // A decision model's unsure answer goes to the LLM tier, not to a
            // person; only the final answer can hand a question to a person.
            const handedTo = x.escalated ? (x.detail?.escalatedTo === "llm" ? "to LLM" : "to a person") : null;
            return (
              <tr key={(x.id ?? "") + x.at + i} className={x.rootDecisionInstanceId ? "opacity-60" : ""}>
                <td className="px-3 py-2 align-top">
                  <KindBadge kind={x.kind} />
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="text-gray-500">{x.question}</span>
                  <span className="block text-gray-200">{x.decided}</span>
                  {typeof x.detail?.summary === "string" && <span className="mt-1 block text-[11px] text-gray-400">{x.detail.summary}</span>}
                </td>
                <td className="px-3 py-2 text-right align-top tabular-nums text-gray-300">{x.confidence == null ? "—" : x.confidence.toFixed(2)}</td>
                <td className="px-3 py-2 text-right align-top tabular-nums text-gray-400">{fmtMs(x.latencyMs)}</td>
                <td className="px-3 py-2 align-top text-gray-400">
                  {x.model ?? (x.kind === "dmn" ? "engine" : "—")}
                  {x.provider === "cloud" && <span className="block text-[10px] text-gray-400">cloud ·{fmtCost(x.costUsd, x.provider)}</span>}
                  {failedLocal.length > 0 && (
                    <span className="block text-[10px] text-amber-300" title={failedLocal.map((a) => `${a.model}: ${a.why}`).join("\n")}>
                      after {failedLocal.map((a) => a.model).join(", ")} failed
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-[10px]">
                  {handedTo && <span className="mr-1 rounded bg-amber-950 px-1.5 py-0.5 text-amber-300">{handedTo}</span>}
                  {x.overridden && <span className="mr-1 rounded bg-red-950 px-1.5 py-0.5 text-red-300">overridden</span>}
                  {x.correct === true && <span className="mr-1 text-emerald-400">✓ truth</span>}
                  {x.correct === false && <span className="mr-1 text-red-400">✗ truth</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Explicit colours: the console theme remaps Tailwind's palette, and these must stay distinct. */
export function KindBadge({ kind }: { kind: string }) {
  const k = KIND_STYLE[kind as keyof typeof KIND_STYLE] ?? KIND_STYLE.system;
  return (
    <span className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: k.hex, color: k.hex, background: `${k.hex}1f` }}>
      {k.label}
    </span>
  );
}

/** The client's side of a manual case: send the documents the agency asked for. */
function Upload({ caseKey }: { caseKey: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toData = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-orange-700/50 bg-orange-950/20 p-3 text-xs text-orange-100">
      <span>Waiting for the client. As the client, send documents (PNG or JPEG scans):</span>
      <input type="file" multiple accept="image/png,image/jpeg" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      <button
        disabled={busy || !files.length}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const payload = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await toData(f) })));
            const r = await lab<{ round: number; files: number }>(`api/cases/${encodeURIComponent(caseKey)}/documents`, { method: "POST", body: JSON.stringify({ files: payload }) });
            setMsg(`Sent ${r.files} as round ${r.round}.`);
            setFiles([]);
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-md border border-orange-600 bg-orange-600/20 px-3 py-1 font-medium disabled:opacity-50"
      >
        Send
      </button>
      {msg && <span className="text-orange-200">{msg}</span>}
    </div>
  );
}
