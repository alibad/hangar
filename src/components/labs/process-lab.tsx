"use client";

import { useCallback, useEffect, useState } from "react";
import { Workflow } from "lucide-react";
import { ToolPageHeader } from "@/components/tool-page";
import { ServiceControl } from "@/components/service-control";
import Markdown from "@/components/markdown";
import type { LabComponentProps } from "@/lib/labs";
import { lab, type LabStatus, type Overview } from "./process/api";
import CasesView from "./process/case-view";
import InboxView from "./process/inbox-view";
import { NumbersView, SimulateView } from "./process/sim-view";

/**
 * The Process Lab — the console's entry point to the process lab
 * (C:\Users\Admin\Code\AI\process-lab): a simulated relocation agency whose
 * processes run on a real BPMN engine, whose rules are DMN tables, and whose
 * judgement steps call a decision model or an LLM.
 *
 * Not on LabShell: the shell is built around picking a model and running one
 * input through it, and here the unit is a case moving through a process. The
 * Lab contract is kept anyway — the services it runs on with Start/Stop, a way
 * to try it (Simulate, or a single case), latency on every decision, the cloud
 * beside the local model per decision, and the experiment doc.
 */

type Sub = "cases" | "inbox" | "simulate" | "numbers" | "catalog";

export default function ProcessLab({ lab: def }: LabComponentProps) {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>("cases");
  const [run, setRun] = useState("");

  const loadStatus = useCallback(async () => {
    const s = await fetch("/api/labs/process/status", { cache: "no-store" }).then((r) => r.json() as Promise<LabStatus>);
    setStatus(s);
    return s;
  }, []);
  const loadOverview = useCallback(async () => {
    try {
      setOv(await lab<Overview>("api/overview"));
      setOvErr(null);
    } catch (e) {
      setOvErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadOverview();
    const iv = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
      loadOverview();
    }, 5000);
    return () => clearInterval(iv);
  }, [loadStatus, loadOverview]);

  const probe = (id: string) => async () => !!(await loadStatus()).services.find((s) => s.id === id)?.up;
  const labUp = status?.services.find((s) => s.id === "process-lab")?.up;

  if (status && !status.lab) {
    return (
      <div className="space-y-5">
        <Header def={def} />
        <p className="rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          Nothing on this machine serves business processes. The process lab runs on BeTenshi; to run it here, declare a service with{" "}
          <code>&quot;serves&quot;: {"{"} &quot;process&quot;: &quot;relocation-case&quot; {"}"}</code> in this host&apos;s <code>config/hosts/&lt;host&gt;.json</code>.
        </p>
      </div>
    );
  }

  const tabs: { id: Sub; label: string; badge?: number }[] = [
    { id: "cases", label: "Cases", badge: ov?.counts.activeCases },
    { id: "inbox", label: "Inbox", badge: ov?.counts.openTasks },
    { id: "simulate", label: "Simulate" },
    { id: "numbers", label: "Numbers" },
    { id: "catalog", label: "Catalog & rules" },
  ];

  return (
    <div className="space-y-5">
      <Header
        def={def}
        meta={
          ov?.engine.up ? (
            <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400">
              Operaton {ov.engine.version} · {ov.definitions.length} process · {ov.decisions.length} decisions
            </span>
          ) : null
        }
      />

      <section className="rounded-xl border border-gray-800 bg-gray-900">
        <ul className="divide-y divide-gray-800">
          {status?.services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
              <span className={`size-2 shrink-0 rounded-full ${s.up ? "bg-emerald-400" : s.onHost ? "bg-gray-600" : "bg-gray-800"}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-gray-100">{s.name}</span>
                <span className="block text-[11px] text-gray-500">{s.onHost ? s.role : `${s.role} — not on this host`}</span>
              </span>
              {s.id === "process-engine" && s.up && ov && (
                <span className="flex gap-3 text-[11px]">
                  <a href={ov.engineUi.cockpit} target="_blank" rel="noreferrer" className="text-sky-300 underline">Cockpit</a>
                  <a href={ov.engineUi.tasklist} target="_blank" rel="noreferrer" className="text-sky-300 underline">Tasklist</a>
                  <span className="text-gray-600">on this machine · demo / demo</span>
                </span>
              )}
              {s.id === "process-lab" && s.up && ov && (
                <span className="text-[11px] text-gray-500">
                  {ov.workers.busy.length ? `working: ${ov.workers.busy.map((b) => `${b.caseKey} ${b.activityId}`).join(", ")}` : "idle"} · {ov.workers.processed} tasks done
                  {ov.workers.failed ? ` · ${ov.workers.failed} failed` : ""}
                </span>
              )}
              {s.onHost && <ServiceControl id={s.id} up={s.up ?? undefined} probe={probe(s.id)} actions={["stop"]} name={s.name} />}
            </li>
          ))}
          {!status && <li className="px-4 py-3 text-xs text-gray-500">Checking services…</li>}
        </ul>
      </section>

      {labUp === false && (
        <p className="rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          The process lab is not running. Start it above (and the process engine before it).
        </p>
      )}
      {ovErr && labUp && <p className="text-xs text-red-300">{ovErr}</p>}

      {ov && labUp && (
        <>
          <nav className="flex flex-wrap gap-1 border-b border-gray-800">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setSub(t.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${sub === t.id ? "border-orange-500 text-gray-100" : "border-transparent text-gray-400 hover:text-gray-200"}`}
              >
                {t.label}
                {!!t.badge && <span className="ml-1.5 rounded-full bg-gray-800 px-1.5 text-[10px] text-gray-300">{t.badge}</span>}
              </button>
            ))}
          </nav>
          {sub === "cases" && <CasesView runFilter={run} onRunFilter={setRun} runs={ov.runs} />}
          {sub === "inbox" && <InboxView onDone={loadOverview} />}
          {sub === "simulate" && (
            <SimulateView
              overview={ov}
              onStarted={(id) => {
                setRun(id);
                setSub("cases");
                loadOverview();
              }}
            />
          )}
          {sub === "numbers" && <NumbersView runs={ov.runs} run={run} onRun={setRun} />}
          {sub === "catalog" && <CatalogView ov={ov} />}
        </>
      )}

      <Doc path={def.doc} />
    </div>
  );
}

function Header({ def, meta }: { def: LabComponentProps["lab"]; meta?: React.ReactNode }) {
  return <ToolPageHeader eyebrow="Lab" title={def.label} description={def.hint} icon={<Workflow className="h-5 w-5" />} meta={meta} />;
}

type Catalog = {
  agency: string;
  source: string;
  services: { id: string; name: string; summary: string; authority: string; decisionPoints: string[]; terms: Record<string, { fee: number; slaDays: number }>; documents: Record<string, string[]> }[];
};

function CatalogView({ ov }: { ov: Overview }) {
  const [c, setC] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    lab<Catalog>("api/catalog").then(setC, (e) => setErr(String(e)));
  }, []);
  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-red-300">{err}</p>}
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="text-sm font-semibold text-gray-100">{c?.agency ?? "Service catalog"}</h3>
        <p className="mb-3 text-[11px] text-gray-500">{c?.source}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[11px] text-gray-500">
              <tr>
                <th className="py-1">Service</th>
                <th className="py-1 text-right">Fee (std / express)</th>
                <th className="py-1 text-right">SLA days</th>
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
      </section>
      <section className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-100">Deployed on the engine</h3>
        <ul className="grid gap-1 text-xs sm:grid-cols-2">
          {ov.definitions.map((d) => (
            <li key={d.id} className="text-gray-300">
              <span className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">BPMN</span> {d.name} <span className="text-gray-500">({d.key} v{d.version})</span>
            </li>
          ))}
          {ov.decisions.map((d) => (
            <li key={d.id} className="text-gray-300">
              <span className="rounded bg-sky-950 px-1.5 text-[10px] text-sky-300">DMN</span> {d.name} <span className="text-gray-500">({d.key} v{d.version} · {d.resource})</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-gray-500">
          Thresholds: a decision-model answer below {ov.ai.classifyThreshold} and a document reading below {ov.ai.readThreshold} go to a person. Edit the tables in
          process-lab/scripts/build-dmn.mjs, or open the deployed ones in Cockpit.
        </p>
      </section>
    </div>
  );
}

function Doc({ path }: { path?: string }) {
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
        What we learned <span className="ml-1 text-[11px] font-normal text-gray-500">{path}</span>
      </summary>
      <div className="max-h-[32rem] overflow-y-auto border-t border-gray-800 px-4 py-3">
        {err ? <p className="text-xs text-red-300">{err}</p> : md ? <Markdown>{md}</Markdown> : <p className="text-xs text-gray-500">Loading…</p>}
      </div>
    </details>
  );
}
