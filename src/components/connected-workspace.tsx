"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import ProjectPaneResize from "./project-pane-resize";
import ProjectInsights from "./project-insights";
import ProjectArchitecture from "./project-architecture";
import { mapPalette } from "@/lib/map-palette";
import ProjectReview from "./project-review";
import ProjectCategory from "./project-category";
import HangarLoading from "./hangar-loading";
import { Activity, AppWindow, ArrowRight, Check, ChevronRight, Cpu, Globe2, Laptop, Layers as LayersIcon, Play, Plus, RefreshCw, Search, Server, Square, TriangleAlert, Terminal, X, Maximize2, Minimize2, Home, MoreHorizontal, SlidersHorizontal, FolderDown, History } from "lucide-react";
import { useTheme } from "./theme-provider";
import type { ConsoleTab } from "@/lib/labs";
import type { Peer } from "@/lib/fleet-policy";
import "./connected-workspace.css";
import PlanQuestLink from "./planquest-link";
import TaskComposer from "./task-composer";
import { WorkspaceOperations, type OperationPanel, type Island } from "./workspace-operations";
import { ProjectContextMenu, RepositoryPane, RemoveProjectDialog, type ProjectChoice, type ProjectMenuTarget } from "./project-controls";
import SessionLibrary, { type LibrarySession, type SessionLibraryData } from "./session-library";
import "./workspace-focus.css";

type Site = { role: string; branch?: string; dirty?: number; ahead?: number; behind?: number; rel: string; logo?: { hash: string } };
type Repo = { homepage?: string | null; onMachine?: boolean; recency?: string; lastActivity?: string; url?: string; openPRs?: number; organizationReviewed?: boolean; fullName?: string; hiddenByIsland?: string; hidden?: boolean; attention?: string | null; id: string; name: string; family: string; description?: string; purpose?: string; sites: Site[]; meaning?: { purpose?: string; next?: string }; risks?: { id: string; text: string }[] };
type AtlasDoc = { islands?: Island[]; generatedAt: string; repos: Repo[]; families: { id: string; name: string; repos: number }[]; apps: { id: string; name: string }[] };
type Session = LibrarySession;
type Job = { id: string; repo: string; project: string; provider: string; prompt: string; state: string; startedAt: string; endedAt: string | null; exitCode: number | null; session?: string; output: { at: string; text: string }[] };
type Apps = { repo: string; running: { port: number; by: string }[]; apps: { label: string; dir: string; targets: { id: string; label: string; ok: boolean; why: string; port?: number; type?: string }[] }[]; jobs?: Record<string, { state?: string; port?: number; message?: string }> };
type Model = { id: string; target: string; provider: string; mode: string; status: string; local: boolean; detail?: string; resident?: boolean };
type Machine = { id: string; name: string; port?: number; sshAlias?: string };
type MachineStatus = { machine: string; name: string; atlas: boolean; platform: string; observedAt: string; error?: string; memory?: { kind: string; vramTotalGb?: number; ramTotalGb?: number } };
type View = "world" | "projects" | "sessions" | "machines" | "models";
export const WORLD_TABS = new Set<string>(["world", "projects", "sessions", "machines", "models"]);
const running = (j: Job) => j.state === "running" || j.state === "stopping";
/** A project's own working copy here: its main clone, a local-only repo, or a clone of someone else's repo (same rule as the engine). */
const MAIN_ROLES = ["canonical", "orphan", "vendor"];
/** Waiting on you: uncommitted work, commits not on GitHub, a pull to make or pull requests to review (the map's Needs attention lens). */
const needsYou = (r: Repo) => r.sites.some(s => s.dirty) || !!r.risks?.some(k => ["unpushed", "offmap", "pull"].includes(k.id)) || !!r.openPRs;
/** One short line of what is waiting on a project, for list rows. */
const waitingText = (r: Repo) => {
  const dirty = r.sites.reduce((n, s) => n + (s.dirty || 0), 0);
  return [dirty ? `${dirty} uncommitted` : "", r.risks?.some(k => k.id === "unpushed" || k.id === "offmap") ? "to push" : "", r.risks?.some(k => k.id === "pull") ? "to pull" : "", r.openPRs ? `${r.openPRs} ${r.openPRs === 1 ? "PR" : "PRs"}` : ""].filter(Boolean).join(" · ");
};
/** The map is one view; these are the things it can show on top, each with its own switch. */
type LayerId = "attention" | "apps" | "work" | "where" | "activity" | "websites";
type MapLayers = Record<LayerId, boolean>;
const DEFAULT_LAYERS: MapLayers = { attention: true, apps: true, work: true, where: true, activity: false, websites: false };
const LAYER_OPTIONS: { id: LayerId; label: string; hint: string; colors?: string[] }[] = [
  { id: "attention", label: "What needs you", hint: "Uncommitted, to push, to pull, pull requests", colors: ["#ffb03b", "#ff5f52", "#4aa3ff", "#c084fc"] },
  { id: "apps", label: "Running apps", hint: "Port tags; click a port to open the app", colors: ["#2fbf71"] },
  { id: "work", label: "Agents working", hint: "Claude or Codex jobs Hangar is running", colors: ["#ffb85c"] },
  { id: "where", label: "Not on this machine", hint: "See-through when only on GitHub" },
  { id: "activity", label: "Last activity", hint: "Colour by month, quarter, year, dormant", colors: ["#ffad4d", "#f4d35e", "#78c6a3", "#8399b3"] },
  { id: "websites", label: "Websites", hint: "A beam over projects with a website", colors: ["#e8962c"] },
];
function since(value?: string) {
  if (!value) return "Not observed";
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return min < 1 ? "just now" : min < 60 ? `${min}m ago` : min < 1440 ? `${Math.floor(min / 60)}h ago` : `${Math.floor(min / 1440)}d ago`;
}
async function json<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", signal, cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json", "X-Hangar": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}

export default function ConnectedWorkspace({ view, active, onSelect }: { view: View; active: boolean; onSelect: (tab: ConsoleTab) => void }) {
  const { theme, palette, worldStyle } = useTheme();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machine, setMachine] = useState("local");
  const [statuses, setStatuses] = useState<Record<string, MachineStatus>>({});
  const [doc, setDoc] = useState<AtlasDoc | null>(null);
  const [docMachine, setDocMachine] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsError, setSessionsError] = useState("");
  const [library, setLibrary] = useState<SessionLibraryData | null>(null);
  const receiveLibrary = useCallback((data: SessionLibraryData) => { setLibrary(data); setSessions(data.sessions); }, []);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apps, setApps] = useState<Apps[]>([]);
  const [appsChecked, setAppsChecked] = useState(false);
  const [liveError, setLiveError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [projectTab, setProjectTab] = useState<"work" | "repository" | "architecture" | "timeline">("work");
  const [reviewing, setReviewing] = useState(false);
  const [projectFilter, setProjectFilter] = useState("visible");
  const [menu, setMenu] = useState<ProjectMenuTarget | null>(null);
  const [removing, setRemoving] = useState<ProjectChoice | null>(null);
  const [removeError, setRemoveError] = useState("");
  const [toolsView, setToolsView] = useState<string | null>(null);
  const [mapControls, setMapControls] = useState(false);
  const [worldRevision, setWorldRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [layers, setLayersState] = useState<MapLayers>(DEFAULT_LAYERS);
  const [ready, setReady] = useState(false);
  const [worldError, setWorldError] = useState("");
  const [worldSlow, setWorldSlow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [paneWidth, setPaneWidth] = useState(42);
  const [exploreWidth, setExploreWidth] = useState(26);
  const [showAll, setShowAll] = useState(false);
  const [paneExpanded, setPaneExpanded] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [revision, setRevision] = useState(0);
  const [composer, setComposer] = useState(false);
  const [operation, setOperation] = useState<OperationPanel | null>(null);
  const [provider, setProvider] = useState("codex");
  const [resume, setResume] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspectJob, setInspectJob] = useState<string | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const exitWorld = useRef<HTMLButtonElement>(null);
  const prefix = `/api/world/${machine}/proxy`;
  const machineName = machines.find(m => m.id === machine)?.name || "This machine";
  const project = doc?.repos.find(r => r.id === selected);
  const projectSessions = sessions.filter(s => !s.archived && s.projects.some(p => p.id === selected));
  const liveJobs = jobs.filter(running);
  const send = useCallback((type: string, data: Record<string, unknown> = {}) => iframe.current?.contentWindow?.postMessage({ source: "hangar", type, ...data }, window.location.origin), []);
  const reload = () => setRevision(v => v + 1);

  useEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [selected, machine, view]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 850px)");
    const update = () => setNarrow(query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const fullPage = active && ((view === "world" && expanded) || (!!project && ["world", "projects"].includes(view) && (paneExpanded || narrow)));
  useEffect(() => {
    if (!fullPage) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [fullPage]);
  useEffect(() => {
    if (active && view === "world" && expanded) exitWorld.current?.focus({ preventScroll: true });
  }, [active, expanded, view]);
  useEffect(() => {
    if (!fullPage) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || reviewing || composer || operation || menu || toolsView || removing || inspectJob) return;
      if (paneExpanded) setPaneExpanded(false);
      else if (narrow && project) { setSelected(null); send("select", { repo: null }); }
      else setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [fullPage, paneExpanded, narrow, project, reviewing, composer, operation, menu, toolsView, removing, inspectJob, send]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let loading = false;
    const refreshMachines = async () => {
      if (loading || document.hidden || controller.signal.aborted) return;
      loading = true;
      try {
        const data = await json<{ local: Machine; peers: Peer[] }>("/api/fleet", undefined, controller.signal);
        if (controller.signal.aborted) return;
        const nodes = [data.local, ...data.peers];
        setMachines(previous => JSON.stringify(previous) === JSON.stringify(nodes) ? previous : nodes);
        // Removed connections must disappear from already-open tabs too. An offline
        // machine that is still configured remains selected and shows its status.
        setMachine(current => nodes.some(n => n.id === current) ? current : "local");
      } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
      finally { loading = false; }
    };
    void refreshMachines();
    const timer = setInterval(refreshMachines, 30000);
    window.addEventListener("focus", refreshMachines);
    document.addEventListener("visibilitychange", refreshMachines);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", refreshMachines);
      document.removeEventListener("visibilitychange", refreshMachines);
    };
  }, [active, revision]);
  useEffect(() => {
    if (!active || !machines.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(poll, 15000); return; }
      await Promise.all(machines.map(async node => {
        try {
          const data = await json<MachineStatus>(`/api/fleet/${node.id}/status`, undefined, controller.signal);
          if (!controller.signal.aborted) setStatuses(s => ({ ...s, [node.id]: data }));
        } catch (e) { if (!controller.signal.aborted) setStatuses(s => ({ ...s, [node.id]: { ...s[node.id], error: (e as Error).message } })); }
      }));
      if (!controller.signal.aborted) timer = setTimeout(poll, 15000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, machines, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setDoc(null); setError(""); setReady(false); setWorldError(""); setJobs([]); setApps([]); setAppsChecked(false); setSessions([]); setLibrary(null); setSessionsError("");
    json<AtlasDoc>(`${prefix}/atlas`, undefined, controller.signal).then(data => { if (!controller.signal.aborted) { setDoc(data); setDocMachine(machine); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    json<SessionLibraryData>(`${prefix}/sessions/library`, undefined, controller.signal).then(receiveLibrary).catch(e => { if (!controller.signal.aborted) setSessionsError(e.message); });
    return () => controller.abort();
  }, [prefix, machine, revision, receiveLibrary]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.hidden) { timer = setTimeout(poll, 5000); return; }
      try {
        const [work, appData] = await Promise.all([json<{ jobs: Job[] }>(`${prefix}/work`, undefined, controller.signal), json<{ apps: Apps[] }>(`${prefix}/apps`, undefined, controller.signal)]);
        if (!controller.signal.aborted) { setJobs(work.jobs); setApps(appData.apps); setAppsChecked(true); setLiveError(""); }
      } catch (e) { if (!controller.signal.aborted) setLiveError((e as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [prefix, active, revision]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframe.current?.contentWindow || event.data?.source !== "atlas") return;
      if (event.data.type === "ready") { setReady(true); setWorldError(""); setWorldSlow(false); }
      if (event.data.type === "context") {
        const repo = doc?.repos.find(r => r.id === event.data.repo);
        const rect = iframe.current?.getBoundingClientRect();
        if (repo && rect && Number.isFinite(event.data.x) && Number.isFinite(event.data.y)) setMenu({ project: repo, x: rect.left + event.data.x, y: rect.top + event.data.y });
      }
      if (event.data.type === "island-context" && doc?.families.some(f => f.id === event.data.family)) setOperation({ kind: "islands", island: event.data.family });
      if (event.data.type === "error") { setReady(false); setWorldError(String(event.data.message || "The world could not be drawn.")); }
      if (event.data.type === "district") { setFamily(event.data.family || ""); if (!event.data.family) setQuery(""); }
      if (event.data.type === "search") workspace.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
      if (event.data.type === "job") setInspectJob(event.data.id);
      if (event.data.type === "select") { setSelected(event.data.repo); setComposer(false); setResume(null); }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [doc]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("hangar-map-layers") || "null");
      if (saved && typeof saved === "object") setLayersState(current => ({ ...current, ...Object.fromEntries(Object.entries(saved).filter(([id, on]) => id in DEFAULT_LAYERS && typeof on === "boolean")) }));
    } catch { /* the default view */ }
  }, []);
  const setLayers = (next: MapLayers) => { setLayersState(next); try { localStorage.setItem("hangar-map-layers", JSON.stringify(next)); } catch { /* kept for this visit */ } };
  useEffect(() => { if (ready) { send("layers", { layers }); send("lens", { lens: "default" }); } }, [ready, layers, send]);
  useEffect(() => { if (ready) send("style", { style: worldStyle }); }, [ready, worldStyle, send]);
  useEffect(() => {
    if (!ready) return;
    // Read the colours after the theme provider has applied the new palette and mode to the document.
    const frame = requestAnimationFrame(() => send("theme", { night: theme === "dark", palette: mapPalette() }));
    return () => cancelAnimationFrame(frame);
  }, [ready, theme, palette, send]);
  useEffect(() => { if (ready && doc && docMachine === machine) send("catalog", { doc }); }, [ready, doc, docMachine, machine, send]);
  useEffect(() => {
    if (!doc || ready || !active || view !== "world") return;
    // The iframe's first ready event can arrive during a host remount/update.
    // Ask it to confirm instead of declaring a healthy map broken after a timer.
    setWorldSlow(false);
    send("status");
    const probe = setInterval(() => send("status"), 2000);
    const timer = setTimeout(() => setWorldSlow(true), 15000);
    return () => { clearInterval(probe); clearTimeout(timer); };
  }, [!!doc, ready, active, view, machine, worldRevision, send]);
  useEffect(() => { if (ready) send("visibility", { visible: active && view === "world" }); }, [active, view, ready, send]);
  useEffect(() => { if (ready) send("work", { jobs: liveError ? [] : jobs.filter(running).map(j => ({ id: j.id, repo: j.repo, provider: j.provider, state: j.state })) }); }, [ready, jobs, liveError, send]);
  useEffect(() => { setComposer(false); setResume(null); setMessage(""); setInspectJob(null); setSelected(null); setFamily(""); setQuery(""); }, [machine]);

  const repos = useMemo(() => (doc?.repos ?? []).filter(r => (projectFilter === "hidden" ? !!r.hidden : !r.hidden && (projectFilter === "visible" || r.attention === projectFilter)) && (!family || r.family === family) && `${r.name} ${r.description ?? ""}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => {
    const score = (r: Repo) => jobs.some(j => j.repo === r.id && running(j)) ? 3 : apps.some(a => a.repo === r.id && a.running.length) ? 2 : needsYou(r) ? 1 : 0;
    return score(b) - score(a) || a.name.localeCompare(b.name);
  }), [doc, query, family, projectFilter, jobs, apps]);
  const pool = useMemo(() => (doc?.repos ?? []).filter(r => (projectFilter === "hidden" ? !!r.hidden : !r.hidden && (projectFilter === "visible" || r.attention === projectFilter)) && `${r.name} ${r.description ?? ""}`.toLowerCase().includes(query.toLowerCase())), [doc, projectFilter, query]);
  const islandCounts = useMemo(() => { const counts = new Map<string, number>(); for (const r of pool) counts.set(r.family, (counts.get(r.family) || 0) + 1); return counts; }, [pool]);
  const listed = repos, waiting = listed.filter(needsYou).length;
  useEffect(() => setShowAll(false), [family, query, projectFilter]);
  const searchResults = useMemo(() => query.trim() ? (doc?.repos ?? []).filter(r => !r.hidden && `${r.name} ${r.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .map(r => { const name = r.name.toLowerCase(), q = query.trim().toLowerCase(); return { r, rank: name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3 }; })
    .sort((a, b) => a.rank - b.rank || a.r.name.length - b.r.name.length).map(x => x.r).slice(0, 8).map(repo => ({ repo, island: (doc?.islands || doc?.families)?.find(f => f.id === repo.family)?.name || repo.family })) : [], [doc, query]);
  const listFamilies = useMemo(() => {
    if (projectFilter !== "hidden") return doc?.families || [];
    const counts = new Map<string, number>();
    for (const repo of doc?.repos || []) if (repo.hidden) counts.set(repo.family, (counts.get(repo.family) || 0) + 1);
    return (doc?.islands || doc?.families || []).filter(f => counts.has(f.id)).map(f => ({ ...f, repos: counts.get(f.id)! }));
  }, [doc, projectFilter]);
  useEffect(() => {
    if (ready) send("filter", { repos: query || family || projectFilter !== "visible" ? repos.map(r => r.id) : null });
  }, [ready, query, family, projectFilter, repos, send]);
  useEffect(() => {
    if (!machines.length || !doc || docMachine !== machine) return;
    try {
      const saved = sessionStorage.getItem("hangar-planquest-return");
      if (!saved) return;
      const target = JSON.parse(saved);
      if (!machines.some(m => m.id === target.machine)) { sessionStorage.removeItem("hangar-planquest-return"); return; }
      if (machine !== target.machine) { setMachine(target.machine); return; }
      if (doc.repos.some(r => r.id === target.repo)) setSelected(target.repo);
      sessionStorage.removeItem("hangar-planquest-return");
    } catch { sessionStorage.removeItem("hangar-planquest-return"); }
  }, [doc, docMachine, machine, machines]);

  const home = () => { setSelected(null); setFamily(""); setQuery(""); send("district", { family: null }); };
  const choose = (repo: Repo, tab: "work" | "repository" = "work") => { setSelected(repo.id); setProjectTab(tab); setComposer(false); setResume(null); if (!repo.hidden) send("select", { repo: repo.id }); };
  const refreshProjects = useCallback(async () => {
    try {
      const fresh = await json<AtlasDoc>(`${prefix}/atlas`);
      setDoc(fresh); setDocMachine(machine); setFamily(current => fresh.families.some(f => f.id === current) ? current : "");
      // The empty first-run viewer has never booted. Ordinary edits stay in place.
      if (!doc?.repos.length && fresh.repos.length) { setReady(false); setWorldError(""); setWorldRevision(v => v + 1); }
    }
    catch (e) { setMessage((e as Error).message); }
  }, [prefix, machine, doc?.repos.length]);
  // First-run discovery is asynchronous. Replace the empty initial catalog as
  // soon as the bundled engine finishes; later scans update the host pane too.
  useEffect(() => {
    if (!active || !doc) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await json<{ scanning: boolean; generatedAt?: string }>(`${prefix}/status`, undefined, controller.signal);
        if (!controller.signal.aborted && !status.scanning && status.generatedAt && status.generatedAt !== doc.generatedAt) await refreshProjects();
      } catch { /* Existing catalog stays usable while the engine reconnects. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, doc, prefix, refreshProjects]);
  async function attention(repo: ProjectChoice, value: "focus" | "parked" | "hidden" | null) {
    if (repo.hiddenByIsland) { setOperation({ kind: "islands", island: repo.hiddenByIsland }); return; }
    if (value === "hidden" && !removing) { setRemoveError(""); setRemoving(repo); return; }
    setBusy(true); setRemoveError("");
    try {
      const fields = value === "hidden" ? { hidden: true } : value === null && repo.hidden ? { hidden: false } : { focus: value === "focus", parked: value === "parked" };
      await json(`${prefix}/notes`, { repo: repo.id, fields });
      if (value === "hidden") setSelected(null);
      await refreshProjects(); setRemoving(null);
      setMessage(value === "hidden" ? `${repo.name} moved off the map. Restore it from Off the map.` : `${repo.name}: ${value === "focus" ? "marked important in Focus" : value === "parked" ? "parked for later; category unchanged" : "updated; category preserved"}.`);
    } catch (e) { setRemoveError((e as Error).message); setMessage((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (ready) send("map-controls", { visible: mapControls }); }, [ready, mapControls, send]);
  useEffect(() => {
    if (!active || view !== "world") return;
    // "/" finds a project from anywhere on the World page, as it does inside the map.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]")) return;
      e.preventDefault(); workspace.current?.querySelector<HTMLInputElement>('.cw-map-left input[type="search"]')?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, view]);
  useEffect(() => {
    if (!toolsView) return;
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !operation && !menu) setToolsView(null); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [toolsView, operation, menu]);
  useEffect(() => { if (ready && selected) send("select", { repo: selected }); }, [ready, selected, send]);

  async function act(path: string, body: unknown) {
    setBusy(true); setMessage("");
    try { await json(`${prefix}/${path}`, body); setMessage("Request accepted."); return true; }
    catch (e) { setMessage((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  const continueSession = (session: Session) => {
    const repo = session.projects.find(p => p.id === selected) || session.projects.find(p => doc?.repos.some(r => r.id === p.id));
    if (!repo) return;
    setSelected(repo.id); setProvider(session.provider); setResume(session.id); setComposer(true);
  };

  const projectPane = project && <aside ref={inspector} className={`cw-inspector ${projectTab === "repository" ? "has-repository-pane" : ""}`} aria-label={`${project.name} details`}>
    <ProjectPaneResize width={paneWidth} onChange={setPaneWidth} />
    <div className="cw-pane-header">
      <div className="cw-pane-top">
        <ProjectCategory key={`category-${machine}-${project.id}`} machine={machine} project={project} islands={doc?.islands || doc?.families || []} onChanged={refreshProjects} />
      <div className="cw-pane-actions">
        <button aria-label={`More actions for ${project.name}`} title="Project actions" onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ project, x: r.left, y: r.bottom + 4, inPane: true }); }}><MoreHorizontal size={17} /></button>
        <button className="cw-pane-expand" aria-label={paneExpanded ? "Restore project pane" : "Expand project pane"} title={paneExpanded ? "Restore pane" : "Expand pane"} aria-pressed={paneExpanded} onClick={() => setPaneExpanded(v => !v)}>{paneExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        <button aria-label="Close project pane" title="Close pane" onClick={() => { setPaneExpanded(false); setSelected(null); send("select", { repo: null }); }}><X size={18} /></button>
      </div>
      </div>
      <nav className="cw-pane-tabs" aria-label="Project views"><button aria-pressed={projectTab === "work"} onClick={() => setProjectTab("work")}>Work</button><button aria-pressed={projectTab === "repository"} onClick={() => setProjectTab("repository")} title="Changes, folders, apps and notes">Repo</button><button aria-pressed={projectTab === "architecture"} onClick={() => setProjectTab("architecture")}>Architecture</button><button aria-pressed={projectTab === "timeline"} onClick={() => setProjectTab("timeline")}>Timeline</button></nav>
    </div>
    {project.hidden && <p className="cw-project-state">{project.hiddenByIsland ? "This island is hidden. Restore it in Manage islands." : "Hidden from the world · restore from the actions menu."}</p>}
    {projectTab === "repository" ? <RepositoryPane key={`repository-${machine}-${project.id}`} machine={machine} repo={project.id} onClose={() => setSelected(null)} onSelect={setSelected} onChanged={refreshProjects} /> : projectTab === "architecture" ? <ProjectArchitecture key={`architecture-${machine}-${project.id}`} machine={machine} repo={project.id} onJob={setInspectJob} /> : projectTab === "timeline" ? <ProjectInsights machine={machine} repo={project.id} repoUrl={project.url} /> : <ProjectDetail project={project} machine={machine} machineName={machineName} sessions={projectSessions} jobs={jobs.filter(j => j.repo === project.id)} app={apps.find(a => a.repo === project.id)} appsChecked={appsChecked} busy={busy} onStart={() => { setComposer(true); setResume(null); }} onClone={() => setOperation({ kind: "clone", repo: project })} onContinue={continueSession} onAction={act} onJob={setInspectJob} onSelect={onSelect} />}
  </aside>;
  const filters = <div className="cw-project-controls" aria-label="Project visibility">{[["visible", "On the map"], ["focus", "Focus"], ["parked", "Parked"], ["hidden", "Off the map"]].map(([id, label]) => <button key={id} aria-pressed={projectFilter === id} className={projectFilter === id ? "is-active" : ""} onClick={() => { setProjectFilter(id); setFamily(""); setSelected(null); setToolsView(null); send("select", { repo: null }); }}>{label}{id === "hidden" ? ` (${doc?.repos.filter(r => r.hidden).length || 0})` : ""}</button>)}</div>;
  const closeMenu = (e: ReactMouseEvent) => { const menu = e.currentTarget.closest("details"); if (menu) menu.open = false; };
  const toolsMenu = <details className="cw-tools-menu"><summary><SlidersHorizontal size={14} />Tools</summary><div role="menu">
    <button role="menuitem" onClick={e => { closeMenu(e); setReviewing(true); }}>Review categories</button>
    <button role="menuitem" onClick={e => { closeMenu(e); setOperation({ kind: "islands" }); }}>Manage islands</button>
    <button role="menuitem" onClick={e => { closeMenu(e); setOperation({ kind: "pull" }); }}>Pull repositories…</button>
    <button role="menuitem" onClick={e => { closeMenu(e); openTools("changes"); }}>All repository tools</button>
  </div></details>;

  const visibleProjects = doc?.repos.filter(r => !r.hidden) || [];
  // Repository tools open in the side pane beside the map, like a project, not in a dialog over everything.
  const openTools = (view: string) => { setSelected(null); send("select", { repo: null }); setToolsView(view); };
  const toolsPane = toolsView && <aside className="cw-inspector has-repository-pane cw-tools-pane" aria-label="Repository tools">
    <div className="cw-tools-pane-head"><h2>Repository tools</h2><button aria-label="Close repository tools" onClick={() => setToolsView(null)}><X size={18} /></button></div>
    <RepositoryPane key={`tools-${machine}-${toolsView}`} machine={machine} view={toolsView} onClose={() => setToolsView(null)} onSelect={id => { setToolsView(null); setSelected(id); }} onChanged={refreshProjects} />
  </aside>;
  const jobRow = (job: (typeof jobs)[number]) => <button className="cw-job-row" key={job.id} onClick={() => setInspectJob(job.id)}><span className={`cw-led ${running(job) && !liveError ? "is-live" : ""}`} /><div><b>{job.project}</b><p>{job.prompt}</p></div><span>{job.provider}</span><span className="cw-status">{job.state}</span><ChevronRight size={16} /></button>;
  const actionCounts = <nav className="cw-action-counts" aria-label="Repository actions">{[
    { id: "push", label: "to push", count: visibleProjects.filter(r => r.risks?.some(k => ["unpushed", "offmap"].includes(k.id))).length, color: "var(--hangar-secondary)" },
    { id: "pull", label: "to pull", count: visibleProjects.filter(r => r.risks?.some(k => k.id === "pull")).length, color: "var(--hangar-primary)" },
    { id: "commit", label: "to commit", count: visibleProjects.filter(r => r.sites.some(s => s.dirty)).length, color: "var(--warn-400)" },
    { id: "prs", label: "PRs", count: visibleProjects.reduce((n,r) => n + (r.openPRs || 0), 0), color: "var(--catA-400)" },
    { id: "apps", label: "running", count: apps.filter(a => a.running.length && visibleProjects.some(r => r.id === a.repo)).length, color: "var(--ok-400)" },
  ].map(item => <button key={item.id} style={{ "--chip-color": item.color } as CSSProperties} disabled={!doc} onClick={() => openTools(item.id)}><i aria-hidden="true" /><b>{item.count}</b>{item.label}</button>)}</nav>;

  return <section ref={workspace} style={{ "--cw-pane-width": `${paneWidth}%`, "--cw-explore-width": `${exploreWidth}%` } as CSSProperties} className={`connected-workspace ${expanded ? "is-expanded" : ""} ${project || toolsView ? "has-project" : ""} ${project && paneExpanded ? "is-pane-expanded" : ""}`} aria-label="Connected workspace" hidden={!active}>
    <div className="cw-topbar"><h1>{{ world: "World", projects: "Projects", sessions: "Sessions", machines: "Machines", models: "Models" }[view]}</h1>
    {view === "world" && doc && <span className="cw-topbar-count">{doc.families.length} islands · {doc.repos.filter(r => !r.hidden).length} projects</span>}
    <div className="cw-machine-rail" aria-label="Machine scope">
      {machines.map(node => { const status = statuses[node.id]; const online = status && !status.error; return <button key={node.id} className={`cw-machine ${machine === node.id ? "is-selected" : ""}`} aria-pressed={machine === node.id} onClick={() => setMachine(node.id)}><span className={`cw-led ${online ? "is-live" : status?.error ? "is-offline" : ""}`} />{node.id === "local" ? <Server size={18} /> : <Laptop size={18} />}<span><b>{node.name}</b><small>{status?.error ? "Connection lost" : online ? node.id === "local" ? "Hangar host" : "SSH connected" : "Checking connection"}</small></span><ChevronRight size={14} /></button>; })}
      <button className="cw-connect" onClick={() => onSelect("machines")}><Plus size={14} /><span>Connect a machine</span></button>
    </div>
    {view === "world" && <button className="cw-live-chip" onClick={() => onSelect("sessions")} title="Coding jobs Hangar is running"><span className={`cw-led ${!liveError ? (liveJobs.length ? "is-live" : "") : "is-offline"}`} />{liveError ? "Live connection lost" : liveJobs.length ? `${liveJobs.length} coding ${liveJobs.length === 1 ? "job" : "jobs"}` : "No coding jobs"}</button>}
    {view === "world" && !!library?.reviewCount && <button className="cw-live-chip" onClick={() => onSelect("sessions")} title={`Sessions idle for ${library.idleDays}+ days`}>{library.reviewCount} idle sessions</button>}
    {["world", "projects"].includes(view) && toolsMenu}
    <button className="cw-icon" onClick={reload} aria-label="Refresh connected workspace"><RefreshCw size={16} /></button></div>
    {view === "projects" && <div className="cw-toolbar">{filters}{actionCounts}</div>}
    {view === "world" && <div className="cw-toolbar cw-world-bar">{actionCounts}</div>}
    {liveError && doc && !["models", "machines"].includes(view) && <p className="cw-error" role="status">Live updates unavailable. App and job state below is the last observation.</p>}
    {message && <div className="cw-message" role="status">{message}<button aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
    <>
      {view === "machines" && <Machines machines={machines} statuses={statuses} onSaved={reload} onSelect={onSelect} />}
      {view === "models" && <FleetModels machine={machine} name={machineName} onSelect={onSelect} />}
      {error && !["models", "machines"].includes(view) && <div className="cw-empty" role="alert"><Globe2 size={34} /><img src="/brand/foundry.png" alt="" width="160" height="130" /><h2>Bring your projects into Hangar.</h2><p>{error}</p><p>The bundled engine scans your configured project folders. Refresh when the scan finishes.</p><button onClick={() => onSelect("services")}>Open service controls</button><button className="cw-primary" onClick={() => onSelect("machines")}>Open Machines <ArrowRight size={16} /></button></div>}
      <div className="cw-world-layout" hidden={view !== "world" || !!error}>
        <div className="cw-focus-bar"><span><img src="/brand/foundry.png" alt="" width="28" height="24" />World <span className="cw-muted">/ {machineName}</span></span>{actionCounts}<button ref={exitWorld} onClick={() => setExpanded(false)} aria-label="Exit expanded world"><Minimize2 size={16} />Exit expanded view</button></div>
        <div className="cw-world">
          <div className="cw-map-left"><button className="cw-map-home" aria-label="Show all islands" title="Show all islands" onClick={home}><Home size={16} /></button><ProjectSearch query={query} setQuery={setQuery} results={searchResults} onChoose={repo => { setQuery(""); choose(repo); }} onPick={() => repos[0] && choose(repos[0])} shortcut /></div>
          <div className="cw-world-tools"><MapMenu layers={layers} setLayers={setLayers} history={mapControls} setHistory={setMapControls} island={family ? doc?.families.find(f => f.id === family)?.name || "" : ""} onIslands={() => setOperation(family ? { kind: "islands", island: family } : { kind: "islands" })} /><button aria-label={expanded ? "Restore world layout" : "Expand world"} onClick={() => setExpanded(v => !v)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
          {doc && <iframe key={`${machine}-${worldRevision}`} ref={iframe} title={`Hangar project world on ${machineName}`} src={`/api/world/${machine}/view/index.html?embed=hangar&lens=default`} onLoad={() => send("status")} allow="clipboard-write" />}
          {!ready && <div className="cw-world-status" role="status" aria-label="Map loading status">
            {worldError ? <><TriangleAlert size={15} /><span>Map unavailable</span></> : <HangarLoading compact announce={false} label={worldSlow ? "Still loading the map…" : doc ? "Loading map…" : "Reading projects…"} steps={doc ? ["Laying out the islands", "Raising the buildings", "Planting the trees", "Lighting the sky"] : ["Scanning project folders", "Asking GitHub what is yours"]} />}
            {(worldSlow || worldError) && <><button onClick={() => { setWorldError(""); setWorldSlow(false); setReady(false); setWorldRevision(v => v + 1); }}>Retry map</button><button onClick={() => onSelect("projects")}>Projects <ArrowRight size={14} /></button></>}
            {worldError && <details><summary>Details</summary><p>{worldError}</p></details>}
          </div>}
          <div className="cw-map-hint" hidden={!ready || mapControls}>Drag to explore · Right-click for actions · / to find</div>
        </div>
        {view === "world" && (project ? projectPane : toolsPane || <aside className="cw-inspector cw-explore" aria-label="Explore projects"><ProjectPaneResize width={exploreWidth} onChange={setExploreWidth} min={20} max={50} reset={26} label="Resize project list" /><span className="cw-eyebrow">EXPLORE THE ISLANDS</span><h2>{family ? doc?.families.find(f => f.id === family)?.name : "Find your next focus."}</h2><p className="cw-muted">Every building is a real project. Select one to see its work, sessions and running apps.</p>
          <div className="cw-explore-filter" role="group" aria-label="Which projects">{[["visible", "All", "Every project on the map"], ["focus", "Focus", "Marked important"], ["parked", "Parked", "Set aside for later"], ["hidden", "Off the map", "Moved off the map"]].map(([id, label, hint]) => <button key={id} title={hint} aria-pressed={projectFilter === id} onClick={() => setProjectFilter(id)}>{label}</button>)}</div>
          <div className="cw-island-picker" aria-label="Explore islands"><button aria-pressed={!family} onClick={home}>All islands<small>{pool.length}</small></button>{doc?.families.filter(f => islandCounts.get(f.id) || family === f.id).map(f => <button key={f.id} aria-pressed={family === f.id} onContextMenu={e => { e.preventDefault(); setOperation({ kind: "islands", island: f.id }); }} onClick={() => { setFamily(f.id); setQuery(""); send("district", { family: f.id }); }}>{f.name}<small>{islandCounts.get(f.id) || 0}</small></button>)}</div>
          <div className="cw-result-count" aria-live="polite">{listed.length} {listed.length === 1 ? "project" : "projects"}{waiting ? ` · ${waiting} ${waiting === 1 ? "needs" : "need"} you` : ""}</div>
          {(showAll ? listed : listed.slice(0, 12)).map(r => <ProjectRow key={r.id} repo={r} machine={machine} jobs={jobs} apps={apps} onClick={() => choose(r)} onMenu={(x, y) => setMenu({ project: r, x, y })} />)}
          {!showAll && listed.length > 12 && <button className="cw-text-button" onClick={() => setShowAll(true)}>Show all {listed.length} <ChevronRight size={15} /></button>}
          {doc && !listed.length && <div className="cw-explore-empty"><p>Nothing here{projectFilter !== "visible" ? ` in ${{ focus: "Focus", parked: "Parked", hidden: "Off the map" }[projectFilter]}` : ""}{query ? ` matching “${query}”` : ""}.</p><button onClick={() => { setProjectFilter("visible"); setQuery(""); }}>Show every project</button></div>}
          <button className="cw-text-button" onClick={() => onSelect("projects")}>Open the project grid <ArrowRight size={15} /></button></aside>)}
      </div>
      {view === "projects" && <div className={project || toolsView ? "cw-project-list-layout" : ""}><div className="cw-project-browser"><div className="cw-browser-toolbar"><ProjectSearch query={query} setQuery={setQuery} onPick={() => repos[0] && choose(repos[0])} /><span className="cw-muted">{repos.length} {projectFilter === "hidden" ? "projects off the map" : "projects on this map"}</span></div><div className="cw-family-tabs"><button aria-pressed={!family} onClick={() => setFamily("")}>All islands</button>{listFamilies.map(f => <button key={f.id} aria-pressed={family === f.id} onContextMenu={e => { e.preventDefault(); setOperation({ kind: "islands", island: f.id }); }} onClick={() => setFamily(f.id)}>{f.name}<small>{f.repos}</small></button>)}</div><div className="cw-project-grid">{repos.map(repo => <div className="cw-project-tile-wrap" key={repo.id}><button className={`cw-project-tile ${repo.id === selected ? "is-selected" : ""}`} key={repo.id} onClick={() => choose(repo)} onContextMenu={e => { e.preventDefault(); setMenu({ project: repo, x: e.clientX, y: e.clientY }); }}><span className="cw-eyebrow">{(doc?.islands || doc?.families)?.find(f => f.id === repo.family)?.name || repo.family}</span><ProjectEmblem repo={repo} machine={machine} /><h2>{repo.name}</h2><p>{repo.meaning?.purpose || repo.description || "Open the project to explore its work."}</p><footer><span>{repo.sites.length ? `${repo.sites.length} local ${repo.sites.length === 1 ? "checkout" : "checkouts"}` : "Not on this machine"}</span><ArrowRight size={16} /></footer></button><button className="cw-tile-more" aria-label={`More actions for ${repo.name}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ project: repo, x: r.left, y: r.bottom + 4 }); }}><MoreHorizontal size={17} /></button></div>)}</div>{doc && !repos.length && <p className="cw-empty">No projects match that search.</p>}</div>{project ? projectPane : toolsPane}</div>}
      {view === "sessions" && <div className="cw-sessions"><div className="cw-section-title"><h2><Activity size={20} /> Live coding jobs</h2><span>{machineName}</span></div>{liveError && <p role="alert" className="cw-error">{liveError}. Last observed work may be stale.</p>}{jobs.length ? <>{jobs.filter(job => running(job) || job.state === "unobserved").map(jobRow)}{jobs.some(job => !running(job) && job.state !== "unobserved") && <details className="cw-finished-jobs"><summary>{jobs.filter(job => !running(job) && job.state !== "unobserved").length} finished jobs</summary>{jobs.filter(job => !running(job) && job.state !== "unobserved").map(jobRow)}</details>}</> : <div className="cw-empty-inline"><Terminal size={24} /><div><b>No Hangar coding jobs observed.</b><p>Start a task from a project to see its output and control it here. Other apps’ sessions appear in history below.</p></div><button onClick={() => onSelect("projects")}>Choose project</button></div>}<SessionLibrary key={machine} machine={machine} data={library} error={sessionsError} onUpdate={receiveLibrary} onContinue={continueSession} /></div>}
    </>
    {menu && <ProjectContextMenu target={menu} local={machine === "local"} app={apps.find(a => a.repo === menu.project.id)} onApp={body => void act("apps", { repo: menu.project.id, ...body })} onClose={() => setMenu(null)} onOpen={(id, tab) => { const repo = doc?.repos.find(r => r.id === id); if (repo) choose(repo, tab); }} onAttention={(repo, value) => void attention(repo, value)} onFolder={repo => void act("open", { repo, with: "folder" })} />}
    {removing && <RemoveProjectDialog project={removing} busy={busy} error={removeError} onClose={() => setRemoving(null)} onConfirm={() => void attention(removing, "hidden")} />}
    {reviewing && <ProjectReview projects={doc?.repos || []} islands={doc?.islands || []} machine={machine} onClose={() => setReviewing(false)} onChanged={refreshProjects} onInspect={id => { const repo = doc?.repos.find(r => r.id === id); if (repo) choose(repo); }} />}
    {operation && <WorkspaceOperations key={`${machine}-${operation.kind}-${operation.repo?.id || operation.island || ""}`} panel={operation} machine={machine} machineName={machineName} projects={doc?.repos || []} onClose={() => setOperation(null)} onChanged={refreshProjects} />}
    {composer && project && <TaskComposer project={project} machineName={machineName} sessions={projectSessions} initialSession={resume} initialProvider={provider} blocked={jobs.some(j => j.repo === project.id && (running(j) || j.state === "unobserved"))} onClose={() => setComposer(false)} onSubmit={async body => { const ok = await act("work", { action: "start", repo: project.id, ...body }); if (ok) { setComposer(false); onSelect("sessions"); } return ok; }} />}
    {inspectJob && (() => { const job = jobs.find(j => j.id === inspectJob); if (!job) return null; return <div className="cw-dialog-backdrop"><section className="cw-dialog cw-output-dialog" role="dialog" aria-modal="true" aria-labelledby="cw-job-title"><DialogFocus onClose={() => setInspectJob(null)} /><button className="cw-dialog-close" aria-label="Close job output" onClick={() => setInspectJob(null)}><X size={20} /></button><span className="cw-eyebrow">{machineName} / {job.provider} / {job.state}</span><h2 id="cw-job-title">{job.project}</h2><p>{job.prompt}</p><div className="cw-output" role="log" aria-label="Coding job output">{job.output.length ? job.output.map((line, i) => <p key={`${i}-${line.at}`}><time>{new Date(line.at).toLocaleTimeString()}</time>{line.text}</p>) : <HangarLoading compact label="Waiting for the agent’s first output" steps={["Starting the agent", "Reading the project", "Planning the first step"]} />}</div>{job.state === "unobserved" ? <button disabled={busy} onClick={() => act("work", { action: "acknowledge", id: job.id })}>I verified this job is no longer running</button> : running(job) ? <button disabled={busy || job.state === "stopping"} onClick={() => act("work", { action: "stop", id: job.id })}><Square size={14} />{job.state === "stopping" ? "Stopping…" : "Stop this job"}</button> : <p className="cw-muted">Ended {since(job.endedAt || undefined)} · exit {job.exitCode}</p>}{message && <p role="status">{message}</p>}</section></div>; })()}
  </section>;
}

function DialogFocus({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current?.parentElement;
    const elements = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input,a[href],[tabindex="0"]') ?? [])];
    (dialog?.querySelector<HTMLElement>("textarea,input") || elements()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); }
      if (e.key === "Tab") { const list = elements(); const first = list[0], last = list.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    dialog?.addEventListener("keydown", key);
    return () => { dialog?.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <span ref={ref} hidden />;
}
/** What can run in a project and what runs now: open or stop what is running, run what is not. */
function AppSection({ app, checked, repo, local, busy, onAction }: { app?: Apps; checked: boolean; repo: string; local: boolean; busy: boolean; onAction: (p: string, b: unknown) => Promise<boolean> }) {
  const [sure, setSure] = useState<number | null>(null);
  const live = app?.running || [];
  const targets = (app?.apps || []).flatMap(a => a.targets.filter(t => t.ok).map(t => {
    const job = app?.jobs?.[`${a.dir}:${t.id}`] || {};
    // A target with no known port counts as running while the project has any app listening: never start a second copy.
    const on = (job.state === "running" && !!job.port && live.some(p => p.port === job.port)) || (t.port ? live.some(p => p.port === t.port) : live.length > 0);
    return { a, t, job, on };
  })).filter(x => !x.on);
  const blocked = (app?.apps || []).flatMap(a => a.targets.filter(t => !t.ok).map(t => `${t.label}: ${t.why}`));
  return <><h3>App</h3>
    {live.map(x => <div className="cw-app-line" key={x.port}><span className="cw-led is-live" /><b>:{x.port}</b><small>{x.by === "atlas" ? "Started here" : "Started elsewhere"}</small>{local && <span className="cw-app-acts">
      <button className="cw-pill" disabled={busy} onClick={() => onAction("apps", { action: "open", repo, port: x.port, how: "window" })}><AppWindow size={14} />Open</button>
      <button className="cw-pill is-quiet" disabled={busy} title={x.by === "atlas" ? "Stop it" : "Started outside Hangar, maybe by an agent: press again to stop it"} onClick={() => { if (x.by !== "atlas" && sure !== x.port) { setSure(x.port); return; } setSure(null); void onAction("apps", { action: "stop", repo, port: x.port }); }}><Square size={12} />{sure === x.port ? "Stop it?" : "Stop"}</button></span>}</div>)}
    {targets.map(({ a, t, job }) => <div className="cw-app-line" key={`${a.dir}:${t.id}`}><span className="cw-led" /><b>{t.label}</b><small>{job.state === "starting" ? "Starting…" : job.state === "failed" ? job.message || "Did not start" : a.label}</small>{local && job.state !== "starting" && <span className="cw-app-acts"><button className="cw-pill" disabled={busy} title={t.type === "server" ? "Start it and open it in its own window" : "Start it in a terminal window"} onClick={() => onAction("apps", { action: "start", repo, target: t.id })}><Play size={13} />Run</button></span>}</div>)}
    {!live.length && !targets.length && (app || checked ? <p className="cw-muted">{blocked[0] || "No app found in this project."}</p> : <HangarLoading compact label="Checking what runs here" steps={["Looking for a web or mobile app", "Checking listening ports"]} />)}
    {!local && (live.length > 0 || targets.length > 0) && <p className="cw-tiny">Run and open apps on the machine that has them.</p>}</>;
}
/** One entry point for the map: what it shows on top, history and replay, and island actions. */
function MapMenu({ layers, setLayers, history, setHistory, island, onIslands }: { layers: MapLayers; setLayers: (layers: MapLayers) => void; history: boolean; setHistory: (on: boolean) => void; island: string; onIslands: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); } };
    document.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  const changed = LAYER_OPTIONS.some(o => layers[o.id] !== DEFAULT_LAYERS[o.id]);
  return <div className="cw-map-menu" ref={ref}>
    <button aria-label="Map options" aria-expanded={open} aria-haspopup="menu" title="What the map shows, history and islands" aria-pressed={open || history} onClick={() => setOpen(v => !v)}><LayersIcon size={16} />{changed && <i className="cw-map-menu-dot" aria-hidden="true" />}</button>
    {open && <div className="cw-map-menu-panel" role="menu" aria-label="Map options">
      <p>Show on the map</p>
      {LAYER_OPTIONS.map(o => <button key={o.id} role="menuitemcheckbox" aria-checked={layers[o.id]} onClick={() => setLayers({ ...layers, [o.id]: !layers[o.id] })}><span className="cw-check" aria-hidden="true">{layers[o.id] && <Check size={12} />}</span><span><b>{o.label}</b><small>{o.colors && <span className="cw-swatches">{o.colors.map(c => <i key={c} style={{ background: c }} />)}</span>}{o.hint}</small></span></button>)}
      <hr />
      <button role="menuitemcheckbox" aria-checked={history} onClick={() => { setHistory(!history); setOpen(false); }}><span className="cw-check" aria-hidden="true">{history ? <Check size={12} /> : <History size={12} />}</span><span><b>History and replay</b><small>Watch projects arrive over time</small></span></button>
      <button role="menuitem" onClick={() => { setOpen(false); onIslands(); }}><span className="cw-check" aria-hidden="true"><SlidersHorizontal size={12} /></span><span><b>{island ? `${island} island…` : "Manage islands…"}</b><small>{island ? "Rename, hide or tidy this island" : "Rename, hide, merge or add islands"}</small></span></button>
      {changed && <button className="cw-map-menu-reset" onClick={() => setLayers(DEFAULT_LAYERS)}>Back to the default view</button>}
    </div>}
  </div>;
}
function ProjectSearch({ query, setQuery, onPick, results, onChoose, shortcut }: { query: string; setQuery: (value: string) => void; onPick?: () => void; results?: { repo: Repo; island: string }[]; onChoose?: (repo: Repo) => void; shortcut?: boolean }) {
  // Enter opens the best match, the way a search box is expected to finish; with results, a short list opens under the box.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = results && query.trim() ? results : [];
  const pick = (repo: Repo) => { onChoose?.(repo); setOpen(false); };
  return <div className="cw-search-wrap"><label className="cw-search"><Search size={16} /><input type="search" value={query} onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
    onKeyDown={e => {
      if (list.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); setActive(i => Math.max(0, Math.min(list.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))); }
      else if (e.key === "Enter" && query.trim()) { e.preventDefault(); if (list[active] && onChoose) pick(list[active].repo); else onPick?.(); }
      else if (e.key === "Escape" && results) { e.preventDefault(); setQuery(""); e.currentTarget.blur(); }
    }} placeholder="Find a project…" aria-label="Find a project" role={results ? "combobox" : undefined} aria-expanded={results ? open && list.length > 0 : undefined} aria-controls={results ? "cw-search-results" : undefined} aria-autocomplete={results ? "list" : undefined} />{shortcut && !query && <kbd aria-hidden="true">/</kbd>}</label>
    {open && list.length > 0 && <ul id="cw-search-results" className="cw-search-results" role="listbox" aria-label="Matching projects">{list.map(({ repo, island }, i) => <li key={repo.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); pick(repo); }}><b>{repo.name}</b><small>{island}</small></li>)}</ul>}</div>;
}
function ProjectEmblem({ repo, machine }: { repo: Repo; machine: string }) {
  const logo = repo.sites.find(s => s.logo)?.logo;
  const source = logo ? `/api/world/${machine}/proxy/logo?repo=${encodeURIComponent(repo.id)}&v=${encodeURIComponent(logo.hash)}` : "";
  const [failed, setFailed] = useState("");
  return <span className="cw-project-emblem" aria-hidden="true">{source && failed !== source ? <img src={source} alt="" loading="lazy" width="32" height="32" onError={() => setFailed(source)} /> : repo.name.slice(0, 2).toUpperCase()}</span>;
}
function ProjectRow({ repo, machine, jobs, apps, onClick, onMenu }: { repo: Repo; machine: string; jobs: Job[]; apps: Apps[]; onClick: () => void; onMenu: (x: number, y: number) => void }) {
  const job = jobs.find(j => j.repo === repo.id && running(j));
  const app = apps.find(a => a.repo === repo.id && a.running.length);
  return <div className="cw-row-wrap" onContextMenu={e => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}><button className="cw-project-row" onClick={onClick}><ProjectEmblem repo={repo} machine={machine} /><span><b>{repo.name}</b><small>{job ? `${job.provider} working` : app ? `App on :${app.running[0].port}` : needsYou(repo) ? waitingText(repo) : repo.sites.length ? "On this machine" : "GitHub only"}</small></span><span className={`cw-project-dot ${job || app ? "is-live" : ""}`} /><ChevronRight size={14} /></button><button className="cw-row-more" aria-label={`More actions for ${repo.name}`} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom + 4); }}><MoreHorizontal size={16} /></button></div>;
}
function ProjectDetail({ project, machine, machineName, sessions, jobs, app, appsChecked, busy, onStart, onClone, onContinue, onAction, onJob, onSelect }: { project: Repo; machine: string; machineName: string; sessions: Session[]; jobs: Job[]; app?: Apps; appsChecked: boolean; busy: boolean; onStart: () => void; onClone: () => void; onContinue: (s: Session) => void; onAction: (p: string, b: unknown) => Promise<boolean>; onJob: (id: string) => void; onSelect: (tab: ConsoleTab) => void }) {
  const local = project.sites.some(s => MAIN_ROLES.includes(s.role));
  return <><div className="cw-inspector-top"><span className="cw-eyebrow">PROJECT / {machineName}</span></div><h2>{project.name}</h2><p className="cw-muted">{project.meaning?.purpose || project.description || "Your project, its code and its recent work."}</p>{local ? <button className="cw-primary" disabled={busy || jobs.some(j => running(j) || j.state === "unobserved")} onClick={onStart}>{sessions.some(s => s.canResume && !s.archived) ? "Start or continue coding" : "Start a coding task"} <ArrowRight size={16} /></button>
    : <div className="cw-clone-prompt"><FolderDown size={18} aria-hidden="true" /><div><b>Not on {machineName} yet</b><small>{project.sites.length ? "Only secondary checkouts are here. Open the machine with the main checkout." : "Clone it to start coding here."}</small></div>{!project.sites.length && project.fullName && <button className="cw-primary" disabled={busy} onClick={onClone}>Clone</button>}</div>}<Checkouts sites={project.sites} />{jobs.filter(running).map(j => <button key={j.id} className="cw-project-row" onClick={() => onJob(j.id)}><Activity size={16} /><span><b>{j.provider} working</b><small>Inspect output</small></span><ArrowRight size={14} /></button>)}<AppSection key={project.id} app={app} checked={appsChecked} repo={project.id} local={machine === "local"} busy={busy} onAction={onAction} /><PlanQuestLink key={`${machine}-${project.id}`} machine={machine} repo={project.id} projectName={project.name} /><h3>Recent sessions</h3>{sessions.slice(0, 3).map(s => <button className="cw-project-row" key={`${s.provider}-${s.id}`} disabled={!s.canResume || !local || busy} onClick={() => onContinue(s)}><Terminal size={15} /><span><b>{s.provider} · {since(s.updatedAt)}</b><small>{s.summary}</small></span><ArrowRight size={14} /></button>)}{!sessions.length && <p className="cw-muted">No indexed session evidence for this project yet.</p>}<button className="cw-text-button" onClick={() => onSelect("sessions")}>All session history <ArrowRight size={14} /></button>{machine === "local" && local && <button className="cw-text-button" disabled={busy} onClick={() => onAction("open", { repo: project.id, with: "folder" })}>Open project folder <ArrowRight size={14} /></button>}</>;
}

/** Where the project's code sits on this machine, in plain words: the main folder first, spare worktrees folded together. */
function Checkouts({ sites }: { sites: Site[] }) {
  if (!sites.length) return null;
  const state = (s: Site) => [s.dirty ? `${s.dirty} ${s.dirty === 1 ? "file" : "files"} changed` : "", s.ahead ? `${s.ahead} ${s.ahead === 1 ? "commit" : "commits"} not on GitHub` : "", s.behind ? `${s.behind} new on GitHub` : ""].filter(Boolean).join(" · ") || "Up to date";
  const folder = (s: Site) => s.rel.split(/[\\/]/).filter(Boolean).pop() || s.rel;
  const kind: Record<string, string> = { canonical: "Main folder", orphan: "Local-only folder", vendor: "Your clone of their repo", worktree: "Worktree", copy: "Copy", release: "Release folder", derived: "Derived folder", submodule: "Submodule" };
  const isMain = (s: Site) => MAIN_ROLES.includes(s.role);
  const row = (s: Site, i: number) => <div key={i}><b>{isMain(s) ? s.branch || "No branch" : folder(s)}<small>{kind[s.role] || s.role}{isMain(s) ? "" : ` · ${s.branch || "no branch"}`}</small></b><span className={s.dirty || s.ahead ? "has-work" : ""}>{state(s)}</span></div>;
  const main = sites.filter(isMain), busy = sites.filter(s => !isMain(s) && (s.dirty || s.ahead)), spare = sites.filter(s => !isMain(s) && !s.dirty && !s.ahead);
  const spareLabel = spare.every(s => s.role === "worktree") ? `${spare.length} spare ${spare.length === 1 ? "worktree" : "worktrees"} · nothing in ${spare.length === 1 ? "it" : "them"}` : `${spare.length} other ${spare.length === 1 ? "folder" : "folders"} · nothing new in ${spare.length === 1 ? "it" : "them"}`;
  return <><div className="cw-facts">{main.map(row)}{busy.map(row)}</div>
    {spare.length > 0 && <details className="cw-spare-worktrees"><summary>{spareLabel}</summary><div className="cw-facts">{spare.map(row)}</div></details>}
    {sites.some(s => s.ahead || s.behind) && <p className="cw-tiny">Compared with GitHub at the last fetch.</p>}</>;
}

function Machines({ machines, statuses, onSaved, onSelect }: { machines: Machine[]; statuses: Record<string, MachineStatus>; onSaved: () => void; onSelect: (t: ConsoleTab) => void }) {
  const [name, setName] = useState(""); const [alias, setAlias] = useState(""); const [port, setPort] = useState("18003");
  const [feedback, setFeedback] = useState(""); const [saving, setSaving] = useState(false);
  return <div className="cw-machines"><div className="cw-topology"><div className="cw-topology-center"><Globe2 size={35} /><strong>Your world</strong><small>Projects stay where they live</small></div>{machines.map(node => { const status = statuses[node.id]; return <article className={`cw-machine-node ${status?.error ? "is-offline" : ""}`} key={node.id}><div className="cw-node-line" /><Server size={32} /><h2>{node.name}</h2><span className="cw-status">{status?.error ? "Disconnected" : status ? "Connected" : "Checking"}</span><p>{status?.platform || "Platform not observed"} · {node.id === "local" ? "Local" : "SSH tunnel"}</p><div className="cw-node-facts"><span>Project engine<b>{status?.error ? "Unknown" : status?.atlas ? "Online" : "Not responding"}</b></span><span>Last observed<b>{since(status?.observedAt)}</b></span></div>{node.id === "local" ? <button onClick={() => onSelect("services")}>Manage services <ArrowRight size={15} /></button> : <button onClick={async () => { try { await json("/api/fleet", { action: "remove", id: node.id }); onSaved(); } catch (e) { setFeedback((e as Error).message); } }}>Disconnect this entry</button>}</article>; })}</div><div className="cw-connect-form"><div><span className="cw-eyebrow">BRING ANOTHER MACHINE INTO YOUR WORLD</span><h2>Connect through SSH.</h2><p>Run Hangar on the other machine. Its project engine is included. Open an SSH tunnel using an existing, trusted SSH host alias, then add the forwarded port here.</p><code>ssh -o ExitOnForwardFailure=yes -N -L 127.0.0.1:{Number(port) || 18003}:127.0.0.1:8003 {alias.replace(/[^a-zA-Z0-9._-]/g, "") || "your-host"}</code><p className="cw-tiny">The SSH client verifies the remote host key. This form does not install software, open firewall ports, or change SSH settings.</p></div><form onSubmit={async e => { e.preventDefault(); setSaving(true); setFeedback(""); try { await json("/api/fleet", { id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name, port: Number(port), ...(alias ? { sshAlias: alias } : {}) }); setFeedback("Machine connected."); onSaved(); } catch (error) { setFeedback((error as Error).message); } finally { setSaving(false); } }}><label>Machine name<input required value={name} onChange={e => setName(e.target.value)} placeholder="My laptop" maxLength={60} /></label><label>SSH host alias<input value={alias} onChange={e => setAlias(e.target.value)} placeholder="laptop" maxLength={64} /></label><label>Forwarded local port<input type="number" min={1024} max={65535} required value={port} onChange={e => setPort(e.target.value)} /></label><button className="cw-primary" disabled={saving}>{saving ? "Checking connection…" : "Verify & connect"}<ArrowRight size={16} /></button>{feedback && <p role="status">{feedback}</p>}</form></div></div>;
}


function FleetModels({ machine, name, onSelect }: { machine: string; name: string; onSelect: (t: ConsoleTab) => void }) {
  const [models, setModels] = useState<Model[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [routerUp, setRouterUp] = useState(false);
  const [filter, setFilter] = useState("all"); const [model, setModel] = useState<Model | null>(null); const [prompt, setPrompt] = useState(""); const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { const c = new AbortController(); setLoading(true); setModels([]); setModel(null); setAnswer(""); setError(""); json<{ models: Model[]; routerUp: boolean }>(`/api/fleet/${machine}/models`, undefined, c.signal).then(d => { setModels(d.models); setRouterUp(d.routerUp); }).catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); }); return () => c.abort(); }, [machine]);
  return <div className="cw-models"><div className="cw-model-route"><Laptop size={26} /><span>This workspace</span><i /><ArrowRight size={18} /><i /><Server size={26} /><span>{name}<small>Execution machine</small></span><button onClick={() => onSelect("model-settings")}>Local model settings</button></div><div className="cw-family-tabs">{["all", "chat", "image_generation", "audio_speech", "audio_transcription"].map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: "All models", chat: "Text & code", image_generation: "Images", audio_speech: "Speech", audio_transcription: "Transcription" }[f]}</button>)}</div>{error && <p className="cw-error" role="alert">{error}</p>}{loading && <p className="cw-muted">Reading {name}’s model catalogue…</p>}<div className="cw-model-grid">{models.filter(m => filter === "all" || m.mode === filter).map(m => <article className="cw-model-tile" key={m.id}><Cpu size={23} /><span className={`cw-status ${m.status === "ready" && (m.local || routerUp) ? "is-live" : ""}`}>{!m.local && !routerUp ? "router offline" : m.status.replaceAll("-", " ")}</span><h2>{m.id}</h2><p>{m.target}</p><small>{m.local ? `Local on ${name}` : `Cloud via ${name}`} · {m.mode}</small>{m.detail && <p className="cw-muted">{m.detail}</p>}{!m.local && !routerUp && <p className="cw-muted">AI Router is offline on this machine.</p>}{m.mode === "chat" && <button disabled={m.status !== "ready" || (!m.local && !routerUp)} onClick={() => { setModel(m); setAnswer(""); }}>Use this model <ArrowRight size={15} /></button>}</article>)}</div>{model && <div className="cw-dialog-backdrop"><section className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby="cw-model-title"><DialogFocus onClose={() => !busy && setModel(null)} /><button className="cw-dialog-close" aria-label="Close model prompt" disabled={busy} onClick={() => setModel(null)}><X size={20} /></button><span className="cw-eyebrow">RUN ON {name}</span><h2 id="cw-model-title">{model.id}</h2><label className="cw-input-label">Prompt<textarea autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={12000} rows={4} /></label><button className="cw-primary" disabled={busy || !prompt.trim()} onClick={async () => { setBusy(true); setAnswer(""); try { const result = await json<{ content: string }>(`/api/fleet/${machine}/inference`, { model: model.id, prompt }); setAnswer(result.content); } catch (e) { setAnswer((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Model working…" : "Send to model"}<ArrowRight size={15} /></button>{answer && <div className="cw-model-answer" role="status">{answer}</div>}</section></div>}</div>;
}
