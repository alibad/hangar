"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, GitCommitHorizontal, Tag } from "lucide-react";
import { monthLabel, periodLabel, timelinePeriods, type TimelineData } from "@/lib/project-timeline";
import "./project-timeline.css";

function commitUrl(repoUrl: string | undefined, sha: string) {
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repoUrl || "") || !/^[a-f\d]{40}$/i.test(sha)) return undefined;
  return `${repoUrl!.replace(/\/$/, "")}/commit/${sha}`;
}

export default function ProjectTimeline({ timeline, repoUrl }: { timeline: TimelineData; repoUrl?: string }) {
  const { periods, monthsPerPeriod } = useMemo(() => timelinePeriods(timeline), [timeline]);
  const [selected, setSelected] = useState("");
  const track = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const index = Math.max(0, selected ? periods.findIndex(p => p.id === selected) : periods.length - 1);
  const current = periods[index];
  const peak = Math.max(1, ...periods.map(p => p.count));
  useEffect(() => {
    const container = track.current, button = container?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (container && button) container.scrollLeft = button.offsetLeft - container.offsetLeft - (container.clientWidth - button.clientWidth) / 2;
  }, [current?.id]);
  if (!current) return <p>No local Git history is available yet. This may be an empty checkout.</p>;
  return <div className="project-timeline">
    <div className="pt-summary"><div><span className="pt-eyebrow">PROJECT HISTORY</span><h3>{monthLabel(periods[0].id, true)}{periods.length > 1 ? ` — ${monthLabel(periods.at(-1)!.end, true)}` : ""}</h3></div><p><b>{timeline.commits.toLocaleString()}</b> commits <span>·</span> <b>{timeline.tags.length}</b> tags</p></div>
    <section className="pt-overview" aria-label="Project activity timeline">
      <div className="pt-chart-heading"><span>Commits over time</span><span className="pt-tag-key"><Tag size={13} />Local tag</span></div>
      <div className="pt-track" ref={track} role="group" aria-label={`Select ${monthsPerPeriod === 1 ? "a month" : "a period"} to explore`} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const focused = buttons.indexOf(event.target as HTMLButtonElement);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const direction = (event.key === "ArrowRight" ? 1 : -1) * (rtl ? -1 : 1);
        const next = event.key === "Home" ? 0 : event.key === "End" ? periods.length - 1 : Math.max(0, Math.min(periods.length - 1, focused + direction));
        setSelected(periods[next].id); buttons[next]?.focus({ preventScroll: true });
      }}>
        {periods.map(period => <button key={period.id} className={`pt-period ${period.count ? "" : "is-quiet"}`} aria-pressed={period.id === current.id} aria-controls={detailId} aria-label={`${periodLabel(period)}: ${period.count} commits, ${period.tags.length} tags`} onClick={() => setSelected(period.id)}>
          <span className="pt-count">{period.count.toLocaleString()}</span>
          <span className="pt-bar-space" aria-hidden="true"><span className="pt-bar" style={{ height: `${period.count / peak * 100}%` }} /></span>
          <span className="pt-axis" aria-hidden="true"><i />{period.tags.length > 0 && <Tag size={13}/>}</span>
          <span className="pt-period-label">{monthsPerPeriod === 1 ? new Date(`${period.id}-01T12:00:00Z`).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) : monthLabel(period.id, true)}</span>
          {monthsPerPeriod === 1 && <span className="pt-year">{period.id.slice(0, 4)}</span>}
        </button>)}
      </div>
      <div className="pt-chart-foot"><span>Earlier → later · {monthsPerPeriod === 1 ? "monthly activity" : `up to ${monthsPerPeriod} months per bar`}</span><span>Select a bar to explore</span></div>
    </section>
    <section className="pt-chapter" id={detailId} aria-label="Selected timeline period">
      <header><div aria-live="polite"><span className="pt-eyebrow">{index + 1} / {periods.length} · {current.count ? "ACTIVE PERIOD" : "QUIET PERIOD"}</span><h3>{periodLabel(current)}</h3><p>{current.count.toLocaleString()} commits{current.tags.length ? ` · ${current.tags.length} tags` : ""}</p></div><div className="pt-navigation"><button aria-label="Previous timeline period" disabled={index === 0} onClick={() => setSelected(periods[index - 1].id)}><ArrowLeft size={17}/></button><button aria-label="Next timeline period" disabled={index === periods.length - 1} onClick={() => setSelected(periods[index + 1].id)}><ArrowRight size={17}/></button></div></header>
      {current.themes.length > 0 && <div className="pt-themes" aria-label="Commit subject prefixes">{current.themes.map(theme => <span key={theme}>{theme}</span>)}</div>}
      {current.tags.length > 0 && <div className="pt-tags" aria-label="Tags in this period">{current.tags.map(tag => <div key={tag.name}><Tag size={17}/><b>{tag.name}</b><time dateTime={tag.at}>{tag.at.slice(0, 10)}</time></div>)}</div>}
      {!current.count && <p className="pt-quiet">No commits recorded in this interval of the available local history.</p>}
      <ol className="pt-events">{current.highlights.map(commit => <li key={commit.sha}><time dateTime={commit.at}>{new Date(`${commit.at.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}</time><span className="pt-event-node" aria-hidden="true"><GitCommitHorizontal size={17}/></span><div>{commitUrl(repoUrl, commit.sha) ? <a href={commitUrl(repoUrl, commit.sha)} target="_blank" rel="noopener noreferrer">{commit.subject}<ArrowRight size={14}/></a> : <span>{commit.subject}</span>}<small>{commit.sha.slice(0, 7)}</small></div></li>)}</ol>
      {current.count > current.highlights.length && <p className="pt-more">{current.highlights.length} recent commit highlights · {current.count - current.highlights.length} more commits in this period</p>}
    </section>
    <details className="pt-evidence"><summary>About this history{timeline.truncated ? " · limited to 20,000 commits" : ""}</summary><p>{timeline.basis}</p>{timeline.truncated && <p>Older commits are outside this view.</p>}{timeline.createdAt && <p>Repository created {new Date(timeline.createdAt).toLocaleDateString()}.</p>}<p>Bar height shows commit count, not effort or business impact. Tags are repository labels, not verified launches.</p></details>
  </div>;
}
