"use client";

import { useEffect, useState } from "react";
import { ServiceControl } from "@/components/service-control";
import Markdown from "@/components/markdown";
import BpmnView from "./bpmn-view";
import { KindBadge, StepHelp } from "./parts";
import { batchLabel } from "./results";
import { lab, type Guide, type LabStatus, type Overview } from "./api";

/**
 * How it's built — for whoever wants the machinery: the programs it runs on
 * (with Start/Stop and logs), the whole process as a BPMN diagram with help on
 * every step, the rule tables, the batches run so far, and the report.
 */
export default function HowItsBuilt({
  status,
  ov,
  guide,
  probe,
  doc,
}: {
  status: LabStatus | null;
  ov: Overview;
  guide: Guide | null;
  probe: (id: string) => () => Promise<boolean>;
  doc?: string;
}) {
  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-gray-400">
        The lab is a real workflow setup, the kind businesses use: each case runs as a <b className="text-gray-200">BPMN</b> process on a process engine (Operaton), the written rules are{" "}
        <b className="text-gray-200">DMN</b> decision tables on the same engine, and the steps that need judgement call AI — a small decision model (Laya) first, then a large language model
        (local first, the cloud when the GPU is busy). Everything below is that machinery.
      </p>
      <Programs status={status} ov={ov} probe={probe} />
      <Process ov={ov} guide={guide} />
      <Rules ov={ov} />
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-100">Batches of pretend clients</h3>
        <ul className="space-y-1.5 text-xs">
          {ov.runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-gray-300">{batchLabel(r)}</span>
              <span className="font-mono text-[11px] text-gray-600">
                {r.id} · 1 day = {r.config?.secondsPerDay}s · {r.config?.autoHuman === false ? "you answer" : "pretend consultant"}
              </span>
            </li>
          ))}
          {!ov.runs.length && <li className="text-gray-600">None yet.</li>}
        </ul>
      </section>
      <Report path={doc} />
    </div>
  );
}

function Programs({ status, ov, probe }: { status: LabStatus | null; ov: Overview; probe: (id: string) => () => Promise<boolean> }) {
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900">
      <h3 className="px-4 pt-3 text-sm font-semibold text-gray-100">What it runs on</h3>
      <ul className="divide-y divide-gray-800">
        {status?.services.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
            <span className={`size-2 shrink-0 rounded-full ${s.up ? "bg-emerald-400" : s.onHost ? "bg-gray-600" : "bg-gray-800"}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-gray-100">{s.name}</span>
              <span className="block text-[11px] text-gray-500">{s.onHost ? s.role : `${s.role} — not on this host`}</span>
            </span>
            {s.id === "process-engine" && s.up && (
              <span className="flex gap-3 text-[11px]">
                <a href={ov.engineUi.cockpit} target="_blank" rel="noreferrer" className="text-gray-300 underline">
                  Cockpit
                </a>
                <a href={ov.engineUi.tasklist} target="_blank" rel="noreferrer" className="text-gray-300 underline">
                  Tasklist
                </a>
                <span className="text-gray-600">the engine&apos;s own screens · demo / demo</span>
              </span>
            )}
            {s.id === "process-lab" && s.up && (
              <span className="text-[11px] text-gray-500">
                {ov.workers.busy.length ? `working: ${ov.workers.busy.map((b) => `${b.caseKey} ${b.activityId}`).join(", ")}` : "idle"} · {ov.workers.processed} tasks done
                {ov.workers.failed ? ` · ${ov.workers.failed} failed` : ""}
              </span>
            )}
            {s.onHost && <ServiceControl id={s.id} up={s.up ?? undefined} probe={probe(s.id)} actions={["stop"]} name={s.name} />}
          </li>
        ))}
        {!status && <li className="px-4 py-3 text-xs text-gray-500">Checking…</li>}
      </ul>
      <p className="px-4 pb-3 pt-1 text-[11px] text-gray-500">
        AI steps go to {ov.ai.models.local} first; when the GPU is taken they {ov.ai.whenLocalUnavailable === "cloud" ? `fall back to ${ov.ai.models.cloud}, and the case records the cost and why` : "wait for it"}.
      </p>
    </section>
  );
}

function Process({ ov, guide }: { ov: Overview; guide: Guide | null }) {
  const [xml, setXml] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const def = ov.definitions[0];
  // Keyed on the id: the overview (and so `def`) is a new object every poll.
  const defId = def?.id;
  useEffect(() => {
    if (!defId) return;
    lab<{ bpmn20Xml: string }>(`api/definitions/${encodeURIComponent(defId)}/xml`).then((r) => setXml(r.bpmn20Xml), () => {});
  }, [defId]);
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-sm font-semibold text-gray-100">The process every case follows</h3>
      <p className="mb-3 text-[11px] text-gray-500">
        {def ? `${def.name} (BPMN, version ${def.version}). ` : ""}Defined in process-lab/scripts/build-bpmn.mjs, which writes bpmn/relocation-case.bpmn — including the explanation of every step.
      </p>
      {xml ? <BpmnView xml={xml} height={380} selected={step} onSelect={setStep} legend={false} /> : <p className="text-xs text-gray-500">Loading the diagram…</p>}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <StepList guide={guide} selected={step} onSelect={setStep} />
        <div className="lg:sticky lg:top-40 lg:self-start">
          <StepHelp id={step} guide={guide} />
        </div>
      </div>
    </section>
  );
}

/**
 * The same process in words: every named step, stage by stage, in order. The
 * full diagram is 26 columns wide, so its boxes are too small to read or click
 * until you zoom; this list is the way in, and picking a step zooms the
 * diagram to it.
 */
function StepList({ guide, selected, onSelect }: { guide: Guide | null; selected: string | null; onSelect: (id: string) => void }) {
  if (!guide) return null;
  const steps = Object.values(guide.steps).filter((s) => s.name && s.type !== "boundaryEvent");
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">The steps in words — pick one to see what it does and where it sits on the diagram.</p>
      {guide.stages.map((st, i) => (
        <div key={st.id}>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            {i + 1} · {st.label} <span className="font-normal normal-case tracking-normal text-gray-600">— {st.about}</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {steps
              .filter((s) => s.stage === st.id)
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${selected === s.id ? "border-orange-400 bg-orange-500/10 text-orange-100" : "border-gray-700 text-gray-300 hover:border-gray-500"}`}
                >
                  {s.kind && <KindBadge kind={s.kind} />}
                  {s.name}
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type Catalog = {
  agency: string;
  source: string;
  services: { id: string; name: string; summary: string; authority: string; decisionPoints: string[]; terms: Record<string, { fee: number; slaDays: number }>; documents: Record<string, string[]> }[];
};

function Rules({ ov }: { ov: Overview }) {
  const [c, setC] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    lab<Catalog>("api/catalog").then(setC, (e) => setErr(String(e)));
  }, []);
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <h3 className="text-sm font-semibold text-gray-100">The rules</h3>
      <p className="mb-3 text-[11px] text-gray-500">
        Prices, deadlines and documents for each service, as the rule tables on the engine give them right now{c?.source ? ` (${c.source})` : ""}.
      </p>
      {err && <p className="text-xs text-red-300">{err}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] text-gray-500">
            <tr>
              <th className="py-1">Service</th>
              <th className="py-1 text-right">Price (standard / express)</th>
              <th className="py-1 text-right">Done within (days)</th>
              <th className="py-1">Documents</th>
              <th className="py-1">Decisions in it</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {c?.services.map((s) => (
              <tr key={s.id} className="align-top">
                <td className="py-2 pr-3">
                  <span className="text-gray-200">{s.name}</span>
                  <span className="block text-[11px] text-gray-500">{s.summary}</span>
                </td>
                <td className="py-2 text-right tabular-nums text-gray-300">
                  €{s.terms.standard?.fee} / €{s.terms.express?.fee}
                </td>
                <td className="py-2 text-right tabular-nums text-gray-300">
                  {s.terms.standard?.slaDays} / {s.terms.express?.slaDays}
                </td>
                <td className="py-2 pl-3 text-gray-400">
                  {Object.entries(s.documents).map(([p, docs]) => (
                    <span key={p} className="block">
                      {p !== "any" && <span className="text-gray-500">{p}: </span>}
                      {docs.join(", ")}
                    </span>
                  ))}
                </td>
                <td className="py-2 pl-3 text-gray-400">{s.decisionPoints.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4 className="mb-2 mt-4 text-xs font-semibold text-gray-300">Deployed on the engine</h4>
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {ov.definitions.map((d) => (
          <li key={d.id} className="text-gray-300">
            <span className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">BPMN</span> {d.name} <span className="text-gray-500">({d.key} v{d.version})</span>
          </li>
        ))}
        {ov.decisions.map((d) => (
          <li key={d.id} className="text-gray-300">
            <span className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">DMN</span> {d.name} <span className="text-gray-500">({d.key} v{d.version} · {d.resource})</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11px] text-gray-500">
        When the AI is less than {Math.round(ov.ai.classifyThreshold * 100)}% sure what a client wants, or less than {Math.round(ov.ai.readThreshold * 100)}% sure of a document, a person decides. The tables
        are written in process-lab/scripts/build-dmn.mjs; open the deployed ones in Cockpit.
      </p>
    </section>
  );
}

function Report({ path }: { path?: string }) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!path) return null;
  return (
    <details
      className="rounded-xl border border-gray-800 bg-gray-900/40"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || md || err) return;
        fetch(`/api/labs/doc?path=${encodeURIComponent(path)}`)
          .then((r) => r.json())
          .then((j) => (j.markdown ? setMd(j.markdown) : setErr(j.error ?? "Could not load.")))
          .catch((e) => setErr(String(e)));
      }}
    >
      <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-gray-200">
        What we learned building it <span className="ml-1 text-[11px] font-normal text-gray-500">{path}</span>
      </summary>
      <div className="max-h-[32rem] overflow-y-auto border-t border-gray-800 px-4 py-3">
        {err ? <p className="text-xs text-red-300">{err}</p> : md ? <Markdown>{md}</Markdown> : <p className="text-xs text-gray-500">Loading…</p>}
      </div>
    </details>
  );
}
