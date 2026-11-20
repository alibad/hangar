"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, FileCode, RefreshCw, Search } from "lucide-react";
import { workspaceResponse } from "@/lib/workspace-response";
import HangarLoading from "./hangar-loading";

type Edge = {
  type: "CALLS" | "IMPORTS";
  direction: "in" | "out";
  source: string;
  target: string;
  caller: string;
  callee: string;
  line: number | null;
  confidence: string | null;
  strategy: string | null;
};
type Baseline = { revision: string; indexedAt: string; nodes: number; edges: number; partial: number; skipped: number };
type Evidence = { file: string; line: number };
type Excerpt = Evidence & { first: number; lines: string[] };
type Impact = {
  changed: string[];
  changedTotal: number;
  seeds: { qn: string; file: string; start: number }[];
  callers: { qn: string; file: string; hop: number; via_qn?: string }[];
  omitted: boolean;
};
type Result = {
  state: "unconfigured" | "no-checkout" | "indexing" | "empty" | "ready" | "stale" | "failed";
  baseline?: Baseline;
  dirty?: boolean;
  error?: string;
  files?: string[];
  total?: number;
  edges?: Edge[];
  omitted?: boolean;
  impact?: Impact;
  source?: Excerpt;
};

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const symbol = (qn: string) => qn.slice(qn.lastIndexOf(".") + 1);

function Neighbors({ edges, direction, onFile }: { edges: Edge[]; direction: Edge["direction"]; onFile: (path: string) => void }) {
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (edge.direction !== direction) continue;
    const path = direction === "in" ? edge.source : edge.target;
    const group = groups.get(path);
    if (group) group.push(edge);
    else groups.set(path, [edge]);
  }
  const entries = [...groups].sort(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b));
  const node = ([path, links]: [string, Edge[]]) => (
    <li key={path}>
      <button onClick={() => onFile(path)} title={path}>
        <span><strong>{basename(path)}</strong><small>{path}</small></span>
        <span className="pcg-count" aria-label={links.length + " links"}>{links.length}</span>
      </button>
    </li>
  );
  return <div className="pcg-lane">
    <h4>{direction === "in" ? "Incoming" : "Outgoing"}</h4>
    {entries.length ? <ul>{entries.slice(0, 6).map(node)}</ul> : <p className="pa-quiet">No indexed files</p>}
    {entries.length > 6 && <details><summary>{entries.length - 6} more files</summary><ul>{entries.slice(6).map(node)}</ul></details>}
  </div>;
}

function ImpactList({ impact, onEvidence }: { impact: Impact; onEvidence: (position: Evidence) => void }) {
  if (!impact.changedTotal) return <p className="pa-quiet">No tracked changes against this baseline.</p>;
  return <div className="pcg-impact">
    <section>
      <h4>Changed files <span>{impact.changedTotal}</span></h4>
      {impact.changed.length > 0 && <ul>{impact.changed.map(path => <li key={path}><code>{path}</code></li>)}</ul>}
      {impact.changed.length < impact.changedTotal && !impact.omitted && <p className="pa-quiet">Some edits are outside indexed source files.</p>}
    </section>
    <section>
      <h4>Changed symbols</h4>
      {impact.seeds.length ? <ul>{impact.seeds.map(seed => <li key={seed.qn}>
        <button onClick={() => onEvidence({ file: seed.file, line: seed.start })}><strong>{symbol(seed.qn)}</strong><code>{seed.file}:{seed.start}</code></button>
      </li>)}</ul> : <p className="pa-quiet">No indexed symbols matched these edits.</p>}
    </section>
    <section>
      <h4>Callers that may be affected</h4>
      {impact.callers.length ? <ul>{impact.callers.map(row => <li key={row.qn}>
        <strong>{symbol(row.qn)}</strong><code>{row.file}</code>
        <small>{row.hop === 1 ? "Direct caller" : "2 calls away"}{row.via_qn ? ` · via ${symbol(row.via_qn)}` : ""}</small>
      </li>)}</ul> : <p className="pa-quiet">No indexed callers found within two hops.</p>}
    </section>
    {impact.omitted && <p className="pa-quiet">This analysis reached its result limit.</p>}
  </div>;
}

export default function ProjectCodeGraph({ base, repo, mode }: { base: string; repo: string; mode: "dependencies" | "impact" }) {
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [position, setPosition] = useState<Evidence | null>(null);
  const [source, setSource] = useState<Excerpt | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const evidenceRegion = useRef<HTMLElement>(null);
  const file = history.at(-1);
  const fetchGraph = useCallback(async (graph: string, file: string, signal: AbortSignal, line?: number) => {
    const query = new URLSearchParams({ repo, graph, file });
    if (line !== undefined) query.set("line", String(line));
    return workspaceResponse<Result>(await fetch(`${base}?${query}`, { cache: "no-store", signal }));
  }, [base, repo]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await fetchGraph(mode === "impact" ? "impact" : file ? "dependencies" : "files", file ?? term, controller.signal);
        if (controller.signal.aborted) return;
        setResult(next);
        if (next.state === "indexing") timer = setTimeout(load, 1200);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => { clearTimeout(timer); controller.abort(); };
  }, [fetchGraph, mode, file, term, refresh]);

  const sourceFile = position?.file;
  const sourceLine = position?.line;
  useEffect(() => {
    if (!sourceFile || !sourceLine) return;
    const controller = new AbortController();
    void fetchGraph("source", sourceFile, controller.signal, sourceLine).then(next => {
      if (controller.signal.aborted) return;
      if (next.source) setSource(next.source);
      else setSourceError("Refresh the index to read the source.");
    }, e => {
      if (!controller.signal.aborted) setSourceError(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [fetchGraph, sourceFile, sourceLine]);

  useEffect(() => {
    if (sourceFile && sourceLine) evidenceRegion.current?.focus({ preventScroll: true });
  }, [sourceFile, sourceLine]);
  useEffect(() => {
    if (source || sourceError) evidenceRegion.current?.scrollIntoView({ block: "nearest" });
  }, [source, sourceError]);

  const closeEvidence = () => { setPosition(null); setSource(null); setSourceError(""); };
  const showEvidence = (next: Evidence) => {
    if (position?.file === next.file && position.line === next.line) { closeEvidence(); return; }
    setSource(null); setSourceError(""); setPosition(next);
  };
  const reset = () => { setResult(null); setError(""); closeEvidence(); };
  const reload = () => { reset(); setRefresh(value => value + 1); };
  const chooseFile = (path: string) => { reset(); setHistory(previous => [...previous, path]); };
  const back = () => { reset(); setHistory(previous => previous.slice(0, -1)); };
  const filter = (event: FormEvent) => {
    event.preventDefault();
    reload(); setHistory([]); setTerm(search.trim());
  };

  const build = async () => {
    setError(""); setStarting(true);
    try {
      await workspaceResponse(await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Hangar": "1" }, body: JSON.stringify({ repo }),
      }));
      reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };

  const baseline = result?.baseline;
  return <div className="pcg">
    {!result && !error && <HangarLoading label={mode === "impact" ? "Reading change impact" : "Reading the code index"} shape="card" />}
    {error && <div className="pa-alert" role="alert"><p>{error}</p><button onClick={reload}>Retry</button></div>}
    {result?.state === "unconfigured" && <div className="pa-empty">
      <h3>Code indexing is off on this machine</h3>
      <p>Set <code>HANGAR_CBM_BIN</code> to a trusted Codebase Memory binary on the machine with this checkout, then restart its project engine.</p>
    </div>}
    {result?.state === "no-checkout" && <p className="pa-quiet">This machine has no main checkout of this project.</p>}
    {result?.state === "indexing" && <div className="pa-progress" role="status">
      <span className="pa-pulse" aria-hidden="true" /><div><b>Building the code index</b><small>Reading the checkout on this machine.</small></div>
    </div>}
    {result && ["empty", "stale", "failed"].includes(result.state) && <div className="pa-empty">
      <h3>{result.state === "stale" ? "The checkout has moved to a new commit" : result.state === "failed" ? "The index build did not finish" : "No code index for this checkout"}</h3>
      {result.error && <p role="alert">{result.error}</p>}
      <p>{result.dirty ? "The checkout has local changes. Commit or set aside the changes to build its baseline." : "Build an index for this commit to browse dependencies and trace changes to callers."}</p>
      <span className="pa-actions">
        <button className="pa-draw" onClick={build} disabled={starting || result.dirty}>{starting ? "Starting…" : "Build code index"}</button>
        {result.dirty && <button className="pcg-refresh" onClick={reload}>Check checkout again</button>}
      </span>
    </div>}
    {result?.state === "ready" && baseline && <>
      <div className="pcg-snapshot">
        <span>Indexed commit <code title={baseline.revision}>{baseline.revision.slice(0, 8)}</code> · {new Date(baseline.indexedAt).toLocaleString()}
          <small>{baseline.nodes.toLocaleString()} nodes · {baseline.edges.toLocaleString()} links{baseline.partial || baseline.skipped ? ` · ${baseline.partial} partial, ${baseline.skipped} skipped` : ""}</small>
        </span>
        <button className="pcg-refresh" onClick={reload}><RefreshCw aria-hidden="true" size={13} /> Refresh</button>
      </div>
      {mode === "dependencies" ? <>
        <form className="pcg-search" onSubmit={filter}>
          <Search size={15} aria-hidden="true" />
          <input aria-label="Find a source file" placeholder="Find a source file" value={search} onChange={event => setSearch(event.target.value)} maxLength={160} />
          <button type="submit">Find</button>
        </form>
        {!file && <div className="pcg-files">
          {(result.files ?? []).slice(0, 12).map(path => <button key={path} onClick={() => chooseFile(path)}><FileCode size={14} aria-hidden="true" /><code>{path}</code></button>)}
          {result.total === 0 && <p className="pa-quiet">No matching source files.</p>}
          {(result.total ?? 0) > 12 && <p className="pa-quiet">First 12 of {result.total} matches. Enter a more specific path to narrow the list.</p>}
        </div>}
        {file && result.edges && <>
          <p className="pa-quiet">Imports and calls from the indexed commit. Choose a connected file to follow its links.</p>
          <button className="pcg-back" onClick={back}><ArrowLeft size={14} aria-hidden="true" /> {history.length > 1 ? "Previous file" : "File results"}</button>
          <div className="pcg-map">
            <Neighbors edges={result.edges} direction="in" onFile={chooseFile} />
            <div className="pcg-arrow" aria-hidden="true"><ArrowRight size={16} /><ArrowDown size={16} /></div>
            <div className="pcg-focus"><FileCode size={18} aria-hidden="true" /><strong>{basename(file)}</strong><small>{file}</small></div>
            <div className="pcg-arrow" aria-hidden="true"><ArrowRight size={16} /><ArrowDown size={16} /></div>
            <Neighbors edges={result.edges} direction="out" onFile={chooseFile} />
          </div>
          {result.omitted && <p className="pa-quiet">This graph shows a bounded sample of the matching links.</p>}
          {result.edges.length > 0 && <details className="pcg-evidence" open={position ? true : undefined}>
            <summary>Link evidence <span>{result.edges.length}</span></summary>
            <ul>{result.edges.map((edge, index) => <li key={index}>
              <strong>{edge.type === "CALLS" ? `${edge.caller} → ${edge.callee}` : `Imports ${basename(edge.target)}`}</strong>
              {edge.line ? <button onClick={() => showEvidence({ file: edge.source, line: edge.line! })}>{edge.source}:{edge.line}</button> : <code>{edge.source}</code>}
              <small>{edge.strategy?.replaceAll("_", " ")}{edge.confidence && Number.isFinite(Number(edge.confidence)) ? ` · ${Math.round(Number(edge.confidence) * 100)}% resolver confidence` : ""}</small>
            </li>)}</ul>
          </details>}
        </>}
      </> : result.impact && <>
        <p className="pa-quiet">Compared with the indexed commit on this machine. Call paths are inferred from static source and traced up to two hops.</p>
        <ImpactList impact={result.impact} onEvidence={showEvidence} />
      </>}
      {position && <section ref={evidenceRegion} tabIndex={-1} className="pcg-source" aria-label="Source evidence" aria-live="polite">
        <header><code>{position.file}:{position.line}</code><button onClick={closeEvidence}>Close source</button></header>
        {sourceError ? <p role="alert" className="pa-alert">{sourceError}</p> : source ? <pre>{source.lines.map((text, i) => {
          const line = source.first + i;
          return <code key={line} data-current={line === source.line}><span aria-hidden="true">{line}</span>{text || " "}</code>;
        })}</pre> : <p className="pa-quiet">Reading the indexed source…</p>}
      </section>}
    </>}
  </div>;
}
