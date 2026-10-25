"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import "./project-insights.css";
import ProjectTimeline from "./project-timeline";
import type { TimelineData } from "@/lib/project-timeline";

type Insights = { available: boolean; reason?: string; observedAt: string; timeline: TimelineData };
export default function ProjectInsights({ machine, repo, repoUrl }: { machine: string; repo: string; repoUrl?: string }) {
  const [data, setData] = useState<Insights | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    fetch(`/api/world/${machine}/proxy/insights?repo=${encodeURIComponent(repo)}`, { signal: controller.signal, cache: "no-store" })
      .then(r => workspaceResponse<Insights>(r)).then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [machine, repo, revision]);
  const t = data?.timeline;
  return <section className="project-insights" aria-label="Project timeline">
    <div className="pi-heading"><h2>The project story</h2><button aria-label="Refresh project evidence" onClick={() => setRevision(n => n + 1)}><RefreshCw size={16} /></button></div>
    {error && <p role="alert">{error}</p>}{!data && !error && <p role="status">Reading Git history on this machine…</p>}
    {data && !data.available && <p>{data.reason}</p>}
    {data?.available && t && <ProjectTimeline key={`${machine}-${repo}-${revision}`} timeline={t} repoUrl={repoUrl} />}
  </section>;
}
