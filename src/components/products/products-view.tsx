"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, ArrowUpRight, Check, Copy, FolderGit2, GitCommitHorizontal, Globe, Lock, Megaphone, MessageSquare, Plus, RefreshCw, Rocket, Star, Target, Users, X } from "lucide-react";
import { age, placeUrl, type FeedbackIssue, type Product, type ProductsResponse } from "@/lib/products-shared";
import { openProject } from "@/lib/project-nav";
import { MAX_FOCUS, MAX_GOALS, emptyFocus, isoWeek, lastWeek, quarter, weekMonday, type FocusData, type Metric } from "@/lib/focus-board";
import "./products.css";

type Filter = "focus" | "attention" | "all" | "quiet";
const FILTERS: Filter[] = ["focus", "attention", "all", "quiet"];
const FILTER_KEY = "hangar-products-filter";
const INBOX_SHOWN = 6;

/** A repository as Hangar's World knows it: its project id, name, logo and whether it is checked out here. */
type Logo = { id: string; name: string; hash?: string; here: boolean; dirty: number };

/** The World's projects by owner/name, so a product can show its repositories' logos and open them as projects. */
function useRepoLogos() {
  const [logos, setLogos] = useState<Map<string, Logo>>(new Map());
  useEffect(() => {
    let live = true;
    fetch("/api/world/local/proxy/atlas").then((r) => (r.ok ? r.json() : null)).then((atlas) => {
      if (!live || !atlas?.repos) return;
      const next = new Map<string, Logo>();
      for (const r of atlas.repos as { id: string; name: string; fullName?: string | null; onMachine?: boolean; sites?: { dirty?: number; logo?: { hash: string } }[] }[]) {
        // A folder with no GitHub remote has no fullName; it can't be any product's repository.
        if (r.fullName) next.set(r.fullName.toLowerCase(), { id: r.id, name: r.name, hash: r.sites?.find((s) => s.logo)?.logo?.hash, here: !!r.onMachine,
          dirty: (r.sites ?? []).reduce((n, s) => n + (s.dirty || 0), 0) });
      }
      setLogos(next);
    }).catch(() => { /* initials instead */ });
    return () => { live = false; };
  }, []);
  return logos;
}
const logoUrl = (l: Logo) => `/api/world/local/proxy/logo?repo=${encodeURIComponent(l.id)}&v=${encodeURIComponent(l.hash ?? "")}`;

/** A product's repositories, each opening its project in Hangar (or GitHub, when Hangar's map doesn't have it). */
/** Every repository a product names (its own and its sites'), as lower-case owner/name. */
const productRepos = (p: Product) => [...new Set([...p.repos, ...p.sites.map((s) => s.repo).filter(Boolean) as string[]].map((r) => r.toLowerCase()))];

function ProductProjects({ product: p, logos }: { product: Product; logos: Map<string, Logo> }) {
  const repos = productRepos(p);
  if (!repos.length) return null;
  return <div className="pr-projects"><span className="pr-projects-label"><FolderGit2 size={14} aria-hidden="true" />{repos.length === 1 ? "Project" : `Projects · ${repos.length}`}</span>
    {repos.map((full) => {
      const known = logos.get(full), name = full.split("/")[1] ?? full;
      return known ? <span key={full} className="pr-project">
        <button type="button" onClick={() => openProject(known.id)} title={`Open ${known.name} in Hangar: its work, sessions, changes and apps`}>
          <span className="pr-emblem" style={{ width: 20, height: 20 }} aria-hidden="true">{known.hash ? <img src={logoUrl(known)} alt="" width={20} height={20} loading="lazy" /> : <b>{known.name.slice(0, 1).toUpperCase()}</b>}</span>
          <b>{known.name}</b>{!known.here && <small>GitHub only</small>}<ArrowRight size={13} aria-hidden="true" />
        </button>
        <a href={`https://github.com/${full}`} target="_blank" rel="noreferrer" aria-label={`${known.name} on GitHub`} title="On GitHub"><ArrowUpRight size={13} /></a>
      </span> : <span key={full} className="pr-project is-away"><a href={`https://github.com/${full}`} target="_blank" rel="noreferrer" title="Not on Hangar's map: open it on GitHub"><b>{name}</b><ArrowUpRight size={13} aria-hidden="true" /></a></span>;
    })}
  </div>;
}

function Emblem({ product, logos, size = 40 }: { product: Product; logos: Map<string, Logo>; size?: number }) {
  const sources = useMemo(() => {
    // The live site's own icon first (what people see), then the repository's logo, then the site's favicon.ico.
    const out: string[] = product.icon ? [product.icon] : [];
    const repos = [...product.sites.map((s) => s.repo).filter(Boolean) as string[], ...product.repos];
    for (const r of repos) {
      const l = logos.get(r.toLowerCase());
      if (l?.hash) { out.push(logoUrl(l)); break; }
    }
    if (product.domain && !product.domain.endsWith(".vercel.app")) out.push(`https://${product.domain}/favicon.ico`);
    return out;
  }, [product, logos]);
  const [tried, setTried] = useState(0);
  useEffect(() => setTried(0), [sources]);
  const src = sources[tried];
  return <span className="pr-emblem" style={{ width: size, height: size }} aria-hidden="true">
    {src ? <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setTried((n) => n + 1)} /> : <b>{product.name.slice(0, 2).toUpperCase()}</b>}
  </span>;
}

function change(week: number | null, previous: number | null) {
  if (week == null || previous == null || previous === 0) return null;
  return Math.round(((week - previous) / previous) * 100);
}

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function Tile({ icon, value, label, tone, sub, onClick }: { icon: ReactNode; value: string; label: string; tone: string; sub?: ReactNode; onClick?: () => void }) {
  const body = <><span className="pr-tile-icon">{icon}</span><span className="pr-tile-value">{value}</span><span className="pr-tile-label">{label}</span>{sub && <span className="pr-tile-sub">{sub}</span>}</>;
  return onClick ? <button type="button" className={`pr-tile is-${tone}`} onClick={onClick}>{body}</button> : <div className={`pr-tile is-${tone}`}>{body}</div>;
}

function IssueRow({ issue, product, logos }: { issue: FeedbackIssue; product?: Product; logos: Map<string, Logo> }) {
  return <li>
    <a href={issue.url} target="_blank" rel="noreferrer" title={`${issue.repo} #${issue.number}`}>
      {product && <span className="pr-issue-product"><Emblem product={product} logos={logos} size={20} /><span>{product.name}</span></span>}
      <i className={issue.open ? "is-open" : "is-closed"} title={issue.open ? "Open" : "Closed"} aria-label={issue.open ? "Open" : "Closed"} />
      <span className="pr-issue-title">{issue.title || "(no title)"}</span>
      <small title={new Date(issue.at).toLocaleString()}>{age(issue.at)}</small>
      <ArrowUpRight size={14} aria-hidden="true" />
    </a>
  </li>;
}

function StarButton({ product: p, starred, onStar }: { product: Product; starred: boolean; onStar: () => void }) {
  return <button type="button" className={`pr-star${starred ? " is-on" : ""}`} aria-pressed={starred} onClick={onStar}
    aria-label={starred ? `Take ${p.name} out of Focus` : `Add ${p.name} to Focus`} title={starred ? "In Focus. Click to take it out." : "Add to Focus"}>
    <Star size={16} fill={starred ? "currentColor" : "none"} aria-hidden="true" />
  </button>;
}

function ProductCard({ product: p, logos, open, onToggle, starred, onStar }: { product: Product; logos: Map<string, Logo>; open: boolean; onToggle: () => void; starred: boolean; onStar: () => void }) {
  const tone = p.releases.failed ? "fail" : p.feedback.week ? "new" : p.publicRepos.length ? "public" : p.quiet ? "quiet" : "calm";
  const delta = change(p.usage.week, p.usage.previous);
  const last = p.releases.last;
  return <article className={`pr-card is-${tone}${open ? " is-open" : ""}${starred ? " is-starred" : ""}`}>
    <StarButton product={p} starred={starred} onStar={onStar} />
    <button type="button" className="pr-card-main" aria-expanded={open} onClick={onToggle}>
      <span className="pr-card-head">
        <Emblem product={p} logos={logos} />
        <span className="pr-card-name"><b>{p.name}</b><small>{p.domain ?? p.repos[0] ?? "No site"}</small></span>
        {p.publicRepos.length > 0 && <span className="pr-flag" title={`Public repository: feedback filed in ${p.publicRepos.join(", ")} is public`}><Globe size={13} />Public</span>}
      </span>
      <span className="pr-card-stats">
        <span className={`pr-stat${p.feedback.week ? " is-hot" : ""}`} title={`${p.feedback.week} new this week · ${p.feedback.open} open · ${p.feedback.total} ever`}>
          <MessageSquare size={14} aria-hidden="true" />
          {p.feedback.week ? <><b>{p.feedback.week}</b><span>new</span></> : <b className="is-dim">{p.feedback.open || "–"}</b>}
          {p.feedback.week > 0 && p.feedback.open > 0 && <small>{p.feedback.open} open</small>}
          {!p.feedback.week && p.feedback.open > 0 && <span>open</span>}
        </span>
        <span className="pr-stat" title={p.usage.properties.length ? `Active users this week, from ${p.usage.properties.map((x) => x.name).join(", ")}` : "No Google Analytics property found for this product"}>
          <Users size={14} aria-hidden="true" />
          {p.usage.week != null ? <><b>{compact(p.usage.week)}</b>{delta != null && <small className={delta >= 0 ? "is-up" : "is-down"}>{delta >= 0 ? "▲" : "▼"}{Math.abs(delta)}%</small>}</> : <b className="is-dim">–</b>}
        </span>
        <span className={`pr-stat is-release is-${p.releases.failed ? "error" : last?.state ?? "none"}`} title={last ? `${last.project}: ${last.message ?? "released"} (${new Date(last.at).toLocaleString()})${p.releases.failed ? ` · ${p.releases.failed} failed this week` : ""}` : "Not on Vercel"}>
          {p.releases.failed ? <AlertTriangle size={14} aria-hidden="true" /> : <Rocket size={14} aria-hidden="true" />}
          {last ? <b>{age(last.at)}</b> : <b className="is-dim">–</b>}
          {p.releases.failed > 0 ? <small>{p.releases.failed} failed</small> : p.releases.week > 1 ? <small>×{p.releases.week}</small> : null}
        </span>
      </span>
    </button>
    {open && <div className="pr-detail">
      <ProductProjects product={p} logos={logos} />
      <section>
        <h4><MessageSquare size={14} />Feedback{p.feedback.total > 0 && <small>{p.feedback.open} open · {p.feedback.total} ever</small>}</h4>
        {p.feedback.latest.length ? <ul className="pr-issues">{p.feedback.latest.map((i) => <IssueRow key={i.url} issue={i} logos={logos} />)}</ul>
          : <p className="pr-none">{p.feedback.where.length ? "No reports yet." : "No feedback button sends reports to GitHub yet."}</p>}
        {p.feedback.where.length > 0 && <p className="pr-where"><span>Reports land in</span>{p.feedback.where.map((w) =>
          <a key={`${w.repo}${w.label ?? ""}`} className={w.public ? "is-public" : ""} href={placeUrl(w)} target="_blank" rel="noreferrer" title={w.public ? "Public repository: anyone can read these reports" : "Private repository"}>
            {w.public ? <Globe size={12} /> : <Lock size={12} />}{w.repo.split("/")[1]}{w.label ? ` · ${w.label}` : ""}<small>{w.open}</small>
          </a>)}</p>}
      </section>
      <section>
        <h4><Rocket size={14} />Releases<small>{p.releases.week} this week</small></h4>
        {last ? <p className={`pr-release is-${last.state}`}><i />{last.project} · {age(last.at)} ago{last.message && <span> · {last.message}</span>}</p> : <p className="pr-none">Not on Vercel.</p>}
        {p.releases.lastFailure && <p className="pr-release is-error"><i />Failed: {p.releases.lastFailure.project}{p.releases.lastFailure.target ? ` (${p.releases.lastFailure.target})` : ""} · {age(p.releases.lastFailure.at)} ago</p>}
        {p.sites.length > 0 && <ul className="pr-sites">{p.sites.map((s) => <li key={s.project}>{s.domain ? <a href={`https://${s.domain}`} target="_blank" rel="noreferrer">{s.domain}<ArrowUpRight size={12} /></a> : <span>{s.project}</span>}</li>)}</ul>}
      </section>
      <section>
        <h4><Users size={14} />People</h4>
        {p.usage.week != null ? <p className="pr-usage"><b>{p.usage.week.toLocaleString()}</b> this week{p.usage.previous != null && <span> · {p.usage.previous.toLocaleString()} the week before</span>}</p>
          : <p className="pr-none">{p.usage.properties.length ? "Not read yet." : "No Analytics property found."}</p>}
      </section>
    </div>}
  </article>;
}

/** A number you type for this week. Saves when you leave the box or press Enter; empty clears it. */
function NumberTile({ label, value, previous, onSave }: { label: string; value?: number; previous?: number; onSave: (value: number | null) => void }) {
  const shown = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown), [bad, setBad] = useState(false);
  useEffect(() => { setDraft(shown); setBad(false); }, [shown]);
  const commit = () => {
    const clean = draft.replace(/[\s,]/g, "");
    if (clean === shown) return;
    if (clean && !/^\d{1,10}$/.test(clean)) { setBad(true); return; }
    onSave(clean ? Number(clean) : null);
  };
  const diff = value !== undefined && previous !== undefined ? value - previous : null;
  return <label className={`pf-tile is-typed${value === undefined ? " is-empty" : ""}${bad ? " is-bad" : ""}`}>
    <input inputMode="numeric" aria-label={label} aria-invalid={bad} value={draft} placeholder="–" onChange={(e) => { setDraft(e.target.value); setBad(false); }} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setDraft(shown); setBad(false); } }} />
    <small>{bad ? "Use a whole number" : label}</small>
    {diff !== null && diff !== 0 && <em className={diff > 0 ? "is-up" : "is-down"}>{diff > 0 ? "+" : "−"}{Math.abs(diff).toLocaleString()} on last week</em>}
  </label>;
}

function Known({ value, label, sub, tone }: { value: string; label: string; sub?: ReactNode; tone?: string }) {
  return <div className={`pf-tile${tone ? ` is-${tone}` : ""}`}><b>{value}</b><small>{label}</small>{sub && <em>{sub}</em>}</div>;
}

/** One starred product: its goals, then what Hangar knows (building, people) beside what you type (marketing). */
function FocusCard({ product: p, logos, commits, focus, change: act, onStar }: {
  product: Product; logos: Map<string, Logo>; commits: Map<string, number>; focus: FocusData; change: (action: Record<string, unknown>) => Promise<boolean>; onStar: () => void;
}) {
  const [goal, setGoal] = useState(""), [goalError, setGoalError] = useState("");
  const week = isoWeek(), before = lastWeek();
  const known = productRepos(p).map((r) => logos.get(r)).filter(Boolean) as Logo[];
  const here = known.filter((k) => k.here);
  const counted = here.filter((k) => commits.has(k.id));
  const made = counted.reduce((n, k) => n + (commits.get(k.id) ?? 0), 0);
  const unsaved = here.reduce((n, k) => n + k.dirty, 0);
  const goals = focus.goals.filter((g) => g.product === p.id);
  const numbers = focus.weeks[p.id]?.[week] ?? {}, previous = focus.weeks[p.id]?.[before] ?? {};
  const delta = change(p.usage.week, p.usage.previous);
  const save = (metric: Metric, value: number | null) => void act({ action: "set-number", product: p.id, week, metric, value });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) { setGoalError("Write the goal first."); return; }
    if (await act({ action: "add-goal", product: p.id, text: goal })) setGoal("");
  };
  return <article className="pf-card" aria-label={p.name}>
    <header className="pf-head">
      <Emblem product={p} logos={logos} size={36} />
      <span className="pr-card-name"><b>{p.name}</b><small>{p.domain ?? "No site"}{known.length > 1 ? ` · ${known.length} projects` : ""}</small></span>
      {p.domain && <a className="pr-icon" href={`https://${p.domain}`} target="_blank" rel="noreferrer" aria-label={`Open ${p.domain}`} title={`Open ${p.domain}`}><ArrowUpRight size={15} /></a>}
      <StarButton product={p} starred onStar={onStar} />
    </header>

    <section className="pf-goals" aria-label={`${p.name} goals`}>
      {goals.length > 0 && <ul>{goals.map((g) => <li key={g.id} className={g.done ? "is-done" : ""}>
        <button type="button" className="pf-check" aria-pressed={g.done} aria-label={g.done ? `Mark "${g.text}" not done` : `Mark "${g.text}" done`} onClick={() => void act({ action: "update-goal", id: g.id, done: !g.done })}>{g.done && <Check size={13} />}</button>
        <span>{g.text}</span>
        <button type="button" className="pf-x" aria-label={`Remove goal "${g.text}"`} title="Remove goal" onClick={() => void act({ action: "remove-goal", id: g.id })}><X size={14} /></button>
      </li>)}</ul>}
      {goals.length < MAX_GOALS && <form className="pf-add" onSubmit={add}>
        <Target size={15} aria-hidden="true" />
        <input aria-label={`New goal for ${p.name}`} aria-invalid={!!goalError} maxLength={140} value={goal} onChange={(e) => { setGoal(e.target.value); setGoalError(""); }} placeholder={goals.length ? "Another goal" : "A goal for this product"} />
        <button type="submit" aria-label="Add goal"><Plus size={15} /></button>
      </form>}
      {goalError && <p className="pf-error">{goalError}</p>}
    </section>

    <div className="pf-row"><span className="pf-label"><GitCommitHorizontal size={14} aria-hidden="true" />Building</span>
      <Known value={!here.length ? "–" : counted.length < here.length ? "…" : `${made}`} label={!known.length ? "no repository linked" : !here.length ? "not on this machine" : "commits, 7 days"} />
      <Known value={here.length ? `${unsaved}` : "–"} label="not saved to git" tone={unsaved > 9 ? "warn" : undefined} />
    </div>
    <div className="pf-row"><span className="pf-label"><Users size={14} aria-hidden="true" />People</span>
      <Known value={p.usage.week != null ? compact(p.usage.week) : "–"} label={p.usage.week != null ? "people this week" : p.usage.properties.length ? "not read yet" : "no Analytics yet"}
        sub={delta != null ? <span className={delta >= 0 ? "is-up" : "is-down"}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}% on last week</span> : undefined} />
      <Known value={`${p.feedback.week}`} label="new feedback" sub={p.feedback.open ? `${p.feedback.open} open` : undefined} tone={p.feedback.week ? "new" : undefined} />
    </div>
    <div className="pf-row"><span className="pf-label"><Megaphone size={14} aria-hidden="true" />Marketing</span>
      <NumberTile label="posts this week" value={numbers.posts} previous={previous.posts} onSave={(v) => save("posts", v)} />
      <NumberTile label="visits from posts" value={numbers.visits} previous={previous.visits} onSave={(v) => save("visits", v)} />
    </div>
    <ProductProjects product={p} logos={logos} />
  </article>;
}

/** The Focus filter: the products you starred, each with its goals and this week's numbers. */
function ProductFocus({ products, logos, focus, change: act, onShowAll }: {
  products: Product[]; logos: Map<string, Logo>; focus: FocusData; change: (action: Record<string, unknown>) => Promise<boolean>; onShowAll: () => void;
}) {
  // Commits in the last 7 days on each starred product's repositories that are on this machine.
  const ids = useMemo(() => [...new Set(products.flatMap((p) => productRepos(p).map((r) => logos.get(r)).filter((k): k is Logo => !!k?.here).map((k) => k.id)))].sort().join(","), [products, logos]);
  const [commits, setCommits] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const controller = new AbortController();
    for (const id of ids ? ids.split(",") : []) {
      fetch(`/api/world/local/proxy/activity?repo=${encodeURIComponent(id)}&days=7`, { cache: "no-store", signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) setCommits((m) => new Map(m).set(id, d.available ? d.commits?.length ?? 0 : 0)); })
        .catch(() => { /* stays "…" */ });
    }
    return () => controller.abort();
  }, [ids]);
  const q = quarter(), monday = weekMonday().toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (!products.length) return <div className="pf-empty"><Star size={24} aria-hidden="true" /><b>Pick what matters now</b>
    <p>Star up to {MAX_FOCUS} products on any card. Each one gets its own goals and this week&apos;s numbers here.</p>
    <button type="button" onClick={onShowAll}>Show all products</button></div>;
  return <>
    <p className="pf-when"><b>{q.label}</b> · {q.weeksLeft} {q.weeksLeft === 1 ? "week" : "weeks"} left · week of {monday}
      <span className="pf-legend"><i className="is-known" aria-hidden="true" />read by Hangar <i className="is-typed" aria-hidden="true" />you type it</span></p>
    <div className="pf-grid">{products.map((p) => <FocusCard key={p.id} product={p} logos={logos} commits={commits} focus={focus} change={act}
      onStar={() => void act({ action: "star", product: p.id, on: false })} />)}</div>
  </>;
}

function ConnectAnalytics({ state, onClose }: { state: ProductsResponse["sources"]["analytics"]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (state.ok || state.state === "off") return null;
  return <div className="pr-connect" role="status">
    <Users size={18} aria-hidden="true" />
    <span className="pr-connect-text"><b>People counts need one Google step.</b><span>{state.message}</span></span>
    {state.command && <button type="button" className="pr-connect-copy" onClick={() => { navigator.clipboard?.writeText(state.command!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {}); }} title={state.command}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied" : "Copy the command"}</button>}
    {state.link && <a className="pr-connect-copy" href={state.link} target="_blank" rel="noreferrer">Open Google Cloud<ArrowUpRight size={13} /></a>}
    <button type="button" className="pr-connect-close" aria-label="Hide" onClick={onClose}><X size={15} /></button>
  </div>;
}

export default function ProductsView() {
  const [data, setData] = useState<ProductsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("attention");
  const [open, setOpen] = useState<string | null>(null);
  const [inboxAll, setInboxAll] = useState(false);
  const [hideConnect, setHideConnect] = useState(false);
  const logos = useRepoLogos();
  const poll = useRef<number | null>(null);
  const connectRef = useRef<HTMLDivElement>(null);
  // Focus: the products you starred, their goals and typed numbers (var/focus.json through /api/focus).
  const [focus, setFocus] = useState<FocusData>(emptyFocus());
  const [focusError, setFocusError] = useState("");
  const chosenFilter = useRef(false);
  useEffect(() => {
    fetch("/api/focus", { cache: "no-store" }).then((r) => r.json()).then((d: FocusData & { error?: string }) => {
      if (d.error || !Array.isArray(d.starred)) { setFocusError(d.error || "Focus could not be read."); return; }
      setFocus(d);
      // With nothing chosen before, open on Focus once something is starred.
      if (!chosenFilter.current && d.starred.length) setFilter("focus");
    }).catch((e) => setFocusError((e as Error).message));
  }, []);
  const changeFocus = useCallback(async (action: Record<string, unknown>) => {
    setFocusError("");
    try {
      const res = await fetch("/api/focus", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify(action) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      setFocus(j);
      return true;
    } catch (e) { setFocusError((e as Error).message); return false; }
  }, []);

  const load = useCallback(async (refresh = false) => {
    try {
      const res = await fetch(`/api/products${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || res.statusText);
      setData(j);
      setError(null);
      if (poll.current) window.clearTimeout(poll.current);
      if (j.refreshing) poll.current = window.setTimeout(() => void load(), 4000);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    try { const f = localStorage.getItem(FILTER_KEY) as Filter | null; if (f && FILTERS.includes(f)) { chosenFilter.current = true; setFilter(f); } } catch { /* default */ }
    void load();
    return () => { if (poll.current) window.clearTimeout(poll.current); };
  }, [load]);

  const choose = (f: Filter) => { chosenFilter.current = true; setFilter(f); try { localStorage.setItem(FILTER_KEY, f); } catch { /* this visit only */ } };

  const byId = useMemo(() => new Map((data?.products ?? []).map((p) => [p.id, p])), [data]);
  const lists = useMemo(() => {
    const all = data?.products ?? [];
    return { focus: focus.starred.map((id) => byId.get(id)).filter(Boolean) as Product[],
      attention: all.filter((p) => p.attention > 0), all: all.filter((p) => !p.quiet), quiet: all.filter((p) => p.quiet) };
  }, [data, focus.starred, byId]);
  const shown = filter === "attention" && !lists.attention.length ? lists.all : lists[filter];
  const star = (p: Product) => void changeFocus({ action: "star", product: p.id, on: !focus.starred.includes(p.id) });

  if (!data) {
    return <div className="pr">
      <header className="pr-head"><h2>Products</h2></header>
      {error ? <p className="pr-error"><AlertTriangle size={16} />{error}</p> : <div className="pr-loading"><RefreshCw size={18} className="is-spinning" />Reading GitHub, Vercel and Google Analytics…</div>}
    </div>;
  }

  const t = data.totals;
  const a = data.sources.analytics;
  const delta = change(t.usersWeek, t.usersPrevious);
  const inbox = inboxAll ? data.inbox : data.inbox.slice(0, INBOX_SHOWN);
  const broken = (["vercel", "github"] as const).filter((k) => !data.sources[k].ok);

  return <div className="pr">
    <header className="pr-head">
      <h2>Products</h2>
      <span className="pr-head-side">
        <small title={new Date(data.generatedAt).toLocaleString()}>{data.refreshing ? "Updating…" : `Updated ${age(data.generatedAt)} ago`}</small>
        <button type="button" className="pr-icon" onClick={() => void load(true)} disabled={data.refreshing} aria-label="Read again" title="Read GitHub, Vercel and Google Analytics again"><RefreshCw size={16} className={data.refreshing ? "is-spinning" : ""} /></button>
      </span>
    </header>

    <div className="pr-tiles">
      <Tile tone="new" icon={<MessageSquare size={18} />} value={`${t.feedbackWeek}`} label="new feedback this week" sub={`${t.feedbackOpen} open in all`} />
      <Tile tone="people" icon={<Users size={18} />} value={t.usersWeek != null ? compact(t.usersWeek) : "–"} label="people this week"
        sub={t.usersWeek != null ? (delta != null ? <span className={delta >= 0 ? "is-up" : "is-down"}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}% on last week</span> : null) : "Connect Google Analytics"}
        onClick={t.usersWeek == null ? () => { setHideConnect(false); connectRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); } : undefined} />
      <Tile tone="release" icon={<Rocket size={18} />} value={`${t.releasesWeek}`} label="releases this week" />
      <Tile tone={t.failedWeek ? "fail" : "ok"} icon={t.failedWeek ? <AlertTriangle size={18} /> : <Check size={18} />} value={`${t.failedWeek}`} label={t.failedWeek === 1 ? "failed build" : "failed builds"} />
    </div>

    <div ref={connectRef}>{!hideConnect && <ConnectAnalytics state={a} onClose={() => setHideConnect(true)} />}</div>
    {broken.map((k) => <p key={k} className="pr-error"><AlertTriangle size={16} />{k === "vercel" ? "Vercel" : "GitHub"} did not answer: {data.sources[k].message}</p>)}

    {data.inbox.length > 0 && <section className="pr-inbox" aria-label="Feedback this week">
      <h3><MessageSquare size={16} />Feedback this week<small>{data.inbox.length}</small></h3>
      <ul className="pr-issues is-inbox">{inbox.map((i) => <IssueRow key={i.url} issue={i} product={byId.get(i.product)} logos={logos} />)}</ul>
      {data.inbox.length > INBOX_SHOWN && <button type="button" className="pr-more" onClick={() => setInboxAll(!inboxAll)}>{inboxAll ? "Show fewer" : `Show all ${data.inbox.length}`}</button>}
    </section>}

    <div className="pr-filters" role="group" aria-label="Which products">
      {([["focus", "Focus", lists.focus.length], ["attention", "Needs you", lists.attention.length], ["all", "All", lists.all.length], ["quiet", "Quiet", lists.quiet.length]] as const).map(([id, label, n]) =>
        <button key={id} type="button" aria-pressed={filter === id} className={id === "focus" ? "is-focus" : undefined} onClick={() => choose(id)}>{id === "focus" && <Star size={13} aria-hidden="true" />}{label}<small>{n}</small></button>)}
    </div>
    {focusError && <p className="pr-error" role="status"><AlertTriangle size={16} />{focusError}</p>}

    {filter === "focus" ? <ProductFocus products={lists.focus} logos={logos} focus={focus} change={changeFocus} onShowAll={() => choose("all")} />
      : <div className="pr-grid">
        {shown.map((p) => <ProductCard key={p.id} product={p} logos={logos} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} starred={focus.starred.includes(p.id)} onStar={() => star(p)} />)}
      </div>}
    {!data.configured && <p className="pr-note">Every Vercel project and every repository with a feedback label is shown on its own. To group a product's sites and repositories, copy config/products.example.json to config/products.local.json.</p>}
  </div>;
}
