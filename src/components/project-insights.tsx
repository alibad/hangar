"use client";
import { useEffect, useState } from "react";
import { ArrowRight, GitCommitHorizontal, Network, RefreshCw, Tag } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import "./project-insights.css";

type Module = { id: string; label: string; files: number; examples: string[] };
type Edge = { from: string; to: string; count: number; evidence: { from: string; to: string }[] };
type Commit = { sha: string; at: string; subject: string };
type Insights = { available: boolean; reason?: string; observedAt: string; architecture: { nodes: Module[]; edges: Edge[]; frameworks: string[]; languages: Record<string, number>; trackedFiles: number; scannedSources: number; omittedModules: number; basis: string }; timeline: { chapters: { month: string; count: number; themes: string[]; highlights: Commit[] }[]; tags: { name: string; at: string }[]; commits: number; truncated: boolean; basis: string; createdAt?: string } };
function githubCommit(repoUrl: string | undefined, sha: string) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repoUrl || "") || !/^[a-f\d]{40}$/i.test(sha)) return undefined;
  return `${repoUrl!.replace(/\/$/, "")}/commit/${sha}`;
}
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
    {data?.available && view === "timeline" && t && <>
      <p className="pi-basis">{t.basis}</p><p>{t.commits.toLocaleString()} commits · {t.chapters.length} active months · {t.tags.length} tags</p>
      {t.truncated && <p role="status">Showing the newest 20,000 commits. Older history is outside this view.</p>}
      <div className="pi-timeline">{t.chapters.map((chapter, i) => <details key={chapter.month} open={i === 0}><summary><GitCommitHorizontal size={20} /><div><b>{new Date(`${chapter.month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b><small>{chapter.count} commits · {chapter.themes.join(" / ")}</small></div></summary>
        {t.tags.filter(tag => tag.at.startsWith(chapter.month)).map(tag => <p className="pi-tag" key={tag.name}><Tag size={14} />{tag.name}</p>)}
        <ul>{chapter.highlights.map(c => <li key={c.sha}>{githubCommit(repoUrl, c.sha) ? <a href={githubCommit(repoUrl, c.sha)} target="_blank" rel="noopener noreferrer">{c.subject}</a> : <span>{c.subject}</span>}<small>{c.at.slice(0,10)} · {c.sha.slice(0,7)}</small></li>)}</ul>
        {chapter.count > chapter.highlights.length && <p className="pi-basis">{chapter.count - chapter.highlights.length} more commits in this month.</p>}
      </details>)}</div>
      {t.createdAt && <p className="pi-origin">Repository created {new Date(t.createdAt).toLocaleDateString()}</p>}
      {!t.chapters.length && <p>No local Git commits were available. This may be an empty or shallow checkout.</p>}
    </>}
  </section>;
}
