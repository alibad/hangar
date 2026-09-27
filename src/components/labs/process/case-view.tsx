"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import BpmnView from "./bpmn-view";
import { KIND_STYLE, fileUrl, fmtCost, fmtMs, lab, type CaseDetail, type CaseRow, type Decision } from "./api";

/** The case list, and one case on its diagram with every decision taken in it. */
export default function CasesView({ runFilter, onRunFilter, runs }: { runFilter: string; onRunFilter: (r: string) => void; runs: { id: string }[] }) {
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
        {rows && <span>{rows.filter((r) => r.state === "ACTIVE").length} active · {rows.length} shown</span>}
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
                    <span className="text-orange-300">{r.current.join(", ") || "—"}</span>
                  ) : (
                    <span className={r.outcome === "completed" ? "text-emerald-300" : "text-gray-400"}>{r.outcome}</span>
                  )}
                  {r.incidents > 0 && <span className="ml-2 rounded bg-red-950 px-1.5 text-[10px] text-red-300">incident</span>}
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
      {selected && <CaseDetailView caseKey={selected} />}
    </div>
  );
}

function CaseDetailView({ caseKey }: { caseKey: string }) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const c = await lab<CaseDetail>(`api/cases/${encodeURIComponent(caseKey)}`);
        if (alive) setD(c);
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

  if (err) return <p className="text-xs text-red-300">{err}</p>;
  if (!d) return <p className="text-xs text-gray-500">Loading {caseKey}…</p>;

  const v = d.variables;
  return (
    <section className="tool-panel space-y-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">
            {d.caseKey} · {String(v.clientName ?? "")}
          </h3>
          <p className="text-xs text-gray-400">
            {String(v.passportCountry)} passport → {String(v.destination)} · {String(v.service ?? "service not yet known")}
            {v.purpose ? ` (${String(v.purpose)})` : ""} · language {String(v.clientLanguage)}
            {v.agencyFee != null && ` · fee €${String(v.agencyFee)}, SLA ${String(v.slaDays)} days`}
          </p>
          <p className="mt-1 text-xs text-gray-500">&ldquo;{String(v.requestText ?? "")}&rdquo;</p>
        </div>
        <div className="text-right text-xs">
          <p className={d.state === "ACTIVE" ? "text-orange-300" : d.outcome === "completed" ? "text-emerald-300" : "text-gray-300"}>
            {d.state === "ACTIVE" ? `at ${d.current.join(", ")}` : d.outcome}
          </p>
          <p className="text-gray-500">{d.ageDays} simulated days</p>
          {d.truth && (
            <p className="text-[11px] text-gray-500" title="The simulation's ground truth — what should happen.">
              expected: {String(d.truth.expected)}
            </p>
          )}
        </div>
      </div>

      {xml ? (
        <BpmnView xml={xml} current={d.current} visited={visited} failed={d.incidents.map((i) => i.activityId)} />
      ) : (
        <p className="text-xs text-gray-500">Loading diagram…</p>
      )}

      {d.incidents.length > 0 && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-200">
          {d.incidents.map((i) => (
            <p key={i.activityId + i.time}>
              <b>{i.activityId}</b>: {i.message}
            </p>
          ))}
          <p className="mt-1 text-red-300/70">Retry it from Cockpit (Incidents → Increment retries), or fix the cause and wait for the next retry.</p>
        </div>
      )}

      {d.state === "ACTIVE" && d.current.includes("gw_wait") && !v.simulated && <Upload caseKey={d.caseKey} />}

      <DecisionTable decisions={d.decisions} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Documents</h4>
          {d.documents.length === 0 && <p className="text-xs text-gray-600">None received.</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {d.documents.map((doc) => (
              <a key={doc.id} href={fileUrl(doc.url)} target="_blank" rel="noreferrer" className="block rounded-lg border border-gray-800 p-1.5 hover:border-gray-600">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(doc.url)} alt={`document ${doc.id}`} className="h-20 w-full rounded object-cover object-top" />
                <p className="mt-1 truncate text-[11px] text-gray-300">
                  #{doc.id} {String(doc.extraction?.docType ?? "unread")} {doc.extraction?.language ? `(${String(doc.extraction.language)})` : ""}
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
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Emails to the client</h4>
          {d.emails.length === 0 && <p className="text-xs text-gray-600">None yet.</p>}
          <div className="space-y-2">
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
      </div>
    </section>
  );
}

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
                  {x.provider === "cloud" && <span className="block text-[10px] text-sky-300">cloud · {fmtCost(x.costUsd, x.provider)}</span>}
                  {failedLocal.length > 0 && (
                    <span className="block text-[10px] text-amber-300" title={failedLocal.map((a) => `${a.model}: ${a.why}`).join("\n")}>
                      after {failedLocal.map((a) => a.model).join(", ")} failed
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-[10px]">
                  {x.escalated && <span className="mr-1 rounded bg-amber-950 px-1.5 py-0.5 text-amber-300">to a person</span>}
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
