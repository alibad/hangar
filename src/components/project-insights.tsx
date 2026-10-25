"use client";
import { useEffect, useState } from "react";
import { ArrowRight, Network, RefreshCw } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import "./project-insights.css";
import ProjectTimeline from "./project-timeline";
import type { TimelineData } from "@/lib/project-timeline";

type Module = { id: string; label: string; files: number; examples: string[] };
type Edge = { from: string; to: string; count: number; evidence: { from: string; to: string }[] };
type Insights = { available: boolean; reason?: string; observedAt: string; architecture: { nodes: Module[]; edges: Edge[]; frameworks: string[]; languages: Record<string, number>; trackedFiles: number; scannedSources: number; omittedModules: number; basis: string }; timeline: TimelineData };
export default function ProjectInsights({ machine, repo, repoUrl, view }: { machine: string; repo: string; repoUrl?: string; view: "architecture" | "timeline" }) {
  const [data, setData] = useState<Insights | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0), [selected, setSelected] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(""); setSelected("");
    fetch(`/api/world/${machine}/proxy/insights?repo=${encodeURIComponent(repo)}`, { signal: controller.signal, cache: "no-store" })
      .then(r => workspaceResponse<Insights>(r)).then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [machine, repo, revision]);
  const a = data?.architecture, t = data?.timeline;
  const chosen = a?.nodes.find(n => n.id === selected);
  return <section className="project-insights" aria-label={view === "architecture" ? "Project architecture" : "Project timeline"}>
    <div className="pi-heading"><h2>{view === "architecture" ? "Inside this project" : "The project story"}</h2><button aria-label="Refresh project evidence" onClick={() => setRevision(n => n + 1)}><RefreshCw size={16} /></button></div>
    {error && <p role="alert">{error}</p>}{!data && !error && <p role="status">Reading tracked files and Git history on this machine…</p>}
    {data && !data.available && <p>{data.reason}</p>}
    {data?.available && view === "architecture" && a && <>
      <p className="pi-basis">{a.basis}</p><div className="pi-stack">{a.frameworks.map(f => <span key={f}>{f}</span>)}{Object.entries(a.languages).map(([name, count]) => <span key={name}>{name} · {count}</span>)}</div>
      <p>{a.trackedFiles.toLocaleString()} tracked files · {a.scannedSources} sources inspected{a.omittedModules ? ` · ${a.omittedModules} smaller folders omitted` : ""}</p>
      <div className="pi-module-map" aria-label="Architecture modules">{a.nodes.map(n => <button key={n.id} aria-pressed={selected === n.id} onClick={() => setSelected(n.id)}><Network size={19} /><b>{n.label}</b><small>{n.files.toLocaleString()} files</small></button>)}</div>
      {chosen && <section className="pi-module-detail"><h3>{chosen.label}</h3><p>Tracked file examples</p><ul>{chosen.examples.map(p => <li key={p}><code>{p}</code></li>)}</ul></section>}
      <h3>Observed connections</h3><p className="pi-basis">Arrows represent resolved source imports.</p>
      <div className="pi-connections">{a.edges.filter(e => !selected || e.from === selected || e.to === selected).map(e => <details key={`${e.from}-${e.to}`}><summary><span>{e.from}</span><ArrowRight size={15} /><span>{e.to}</span><small>{e.count} imports</small></summary><ul>{e.evidence.map((x, i) => <li key={`${x.from}-${x.to}-${i}`}><code>{x.from}</code> → <code>{x.to}</code></li>)}</ul></details>)}</div>
      {!a.edges.length && <p>No cross-module JS/TS imports resolved in the inspected files. Folder structure alone does not establish how these modules communicate.</p>}
      {selected && <button onClick={() => setSelected("")}>Show all connections</button>}
    </>}
    {data?.available && view === "timeline" && t && <ProjectTimeline key={`${machine}-${repo}-${revision}`} timeline={t} repoUrl={repoUrl} />}
  </section>;
}
