/** Read-only token accounting from Codex rollouts, including archived tasks.
 * Cumulative counters are checkpoints, not individual charges. Cached input is
 * included in input; reasoning is included in output. Neither is added twice.
 * Only new complete lines are read after the initial scan. The derived cache
 * contains usage and task metadata, never conversation contents or credentials.
 */
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Counters = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};
export type CodexEvent = Counters & {
  key: string;
  timestamp: number;
  model: string;
  project: string;
  session: string;
};
export type ParserState = {
  model: string;
  project: string;
  session: string;
  previous: Counters | null;
  events: CodexEvent[];
  duplicates: number;
  resets: number;
};
export const newParserState = (): ParserState => ({
  model: "unknown",
  project: "(unknown)",
  session: "",
  previous: null,
  events: [],
  duplicates: 0,
  resets: 0,
});
const count = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const counters = (u: Record<string, unknown>): Counters => ({
  input: count(u.input_tokens),
  cached: count(u.cached_input_tokens),
  cacheWrite: count(u.cache_write_input_tokens),
  output: count(u.output_tokens),
  reasoning: count(u.reasoning_output_tokens),
});

// Loose input is intentional: rollouts evolve independently of this application.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ingestCodexRecord(state: ParserState, record: any) {
  const p = record?.payload;
  if (!p) return;
  if (record.type === "session_meta") {
    state.session = p.id || p.session_id || state.session;
    if (typeof p.cwd === "string") state.project = p.cwd;
    if (typeof p.model === "string") state.model = p.model;
    return;
  }
  if (record.type === "turn_context") {
    if (typeof p.model === "string") state.model = p.model;
    if (typeof p.cwd === "string") state.project = p.cwd;
    return;
  }
  if (
    record.type !== "event_msg" ||
    p.type !== "token_count" ||
    !p.info?.total_token_usage
  )
    return;
  const timestamp = Date.parse(record.timestamp);
  if (!Number.isFinite(timestamp)) return;
  const next = counters(p.info.total_token_usage);
  const prev = state.previous;
  let delta = { ...next };
  if (prev) {
    if (next.input < prev.input || next.output < prev.output) {
      // A restarted counter begins a new segment; its first total is a baseline
      // for subsequent differences. last_token_usage is the observed new call.
      delta = p.info.last_token_usage
        ? counters(p.info.last_token_usage)
        : next;
      state.resets++;
    } else {
      for (const key of Object.keys(delta) as (keyof Counters)[])
        delta[key] = Math.max(0, next[key] - prev[key]);
    }
  }
  state.previous = next;
  if (!(delta.input || delta.output)) {
    state.duplicates++;
    return;
  }
  delta.cached = Math.min(delta.cached, delta.input);
  delta.cacheWrite = Math.min(delta.cacheWrite, delta.input - delta.cached);
  delta.reasoning = Math.min(delta.reasoning, delta.output);
  state.events.push({
    ...delta,
    timestamp,
    model: state.model,
    project: state.project,
    session: state.session,
    // Copied ancestry in forked rollouts retains timestamp and counters. Omit
    // destination session id so reading parent + child counts ancestry once.
    key: `${record.timestamp}:${state.model}:${next.input}:${next.cached}:${next.output}:${next.reasoning}`,
  });
}

export function dedupeCodexEvents(events: CodexEvent[]) {
  return [...new Map(events.map((e) => [e.key, e])).values()];
}

type FileEntry = {
  offset: number;
  size: number;
  mtime: number;
  birthtime: number;
  state: ParserState;
};
type Index = {
  version: number;
  root: string;
  files: Record<string, FileEntry>;
};
const VERSION = 1;

export function createCodexReader(root: string, cachePath?: string) {
  let index: Index = { version: VERSION, root, files: {} };
  let loaded = false;
  let inflight: Promise<{
    events: CodexEvent[];
    files: number;
    bytesRead: number;
    warnings: string[];
  }> | null = null;
  async function scan() {
    if (!loaded) {
      if (cachePath) {
        try {
          const saved = JSON.parse(await readFile(cachePath, "utf8"));
          if (saved.version === VERSION && saved.root === root && saved.files)
            index = saved;
        } catch {
          /* A missing or invalid derived cache can be rebuilt. */
        }
      }
      loaded = true;
    }
    const paths: string[] = [];
    const warnings: string[] = [];
    const walk = async (dir: string) => {
      try {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(join(dir, entry.name));
          else if (entry.isFile() && entry.name.endsWith(".jsonl"))
            paths.push(join(dir, entry.name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push(`Could not read ${dir}`);
      }
    };
    await walk(join(root, "sessions"));
    await walk(join(root, "archived_sessions"));
    let bytesRead = 0;
    let changed = false;
    for (const path of paths.sort()) {
      try {
        const st = await stat(path);
        let entry = index.files[path];
        if (entry && entry.size === st.size && entry.mtime === st.mtimeMs)
          continue;
        if (
          !entry ||
          st.size < entry.size ||
          st.birthtimeMs !== entry.birthtime ||
          (st.size === entry.size && st.mtimeMs !== entry.mtime)
        ) {
          entry = {
            offset: 0,
            size: 0,
            mtime: 0,
            birthtime: st.birthtimeMs,
            state: newParserState(),
          };
        } else entry = structuredClone(entry);
        if (st.size > entry.offset) {
          let pending = Buffer.alloc(0);
          for await (const chunk of createReadStream(path, {
            start: entry.offset,
            end: st.size - 1,
            highWaterMark: 256 * 1024,
          })) {
            bytesRead += chunk.length;
            const buffer = pending.length
              ? Buffer.concat([pending, chunk])
              : (chunk as Buffer);
            let start = 0;
            let end: number;
            while ((end = buffer.indexOf(10, start)) !== -1) {
              const line = buffer.subarray(start, end).toString("utf8");
              entry.offset += end - start + 1;
              start = end + 1;
              if (
                !line.includes('"token_count"') &&
                !line.includes('"turn_context"') &&
                !line.includes('"session_meta"')
              )
                continue;
              try {
                ingestCodexRecord(entry.state, JSON.parse(line));
              } catch {
                /* Malformed complete record. */
              }
            }
            pending = Buffer.from(buffer.subarray(start));
          }
          // Leave a partial final line unread until the writer finishes it.
        }
        entry.size = st.size;
        entry.mtime = st.mtimeMs;
        index.files[path] = entry;
        changed = true;
      } catch {
        warnings.push(`Could not update ${path.split(/[\\/]/).pop()}`);
      }
    }
    const live = new Set(paths);
    // Only prune on a successful directory scan; a transient access failure
    // must not erase previously indexed usage.
    if (!warnings.length)
      for (const path of Object.keys(index.files)) {
        if (!live.has(path)) {
          delete index.files[path];
          changed = true;
        }
      }
    if (changed && cachePath) {
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        const tmp = `${cachePath}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(index));
        await rename(tmp, cachePath);
      } catch {
        warnings.push("Usage loaded, but its local index could not be saved.");
      }
    }
    return {
      events: dedupeCodexEvents(
        Object.values(index.files).flatMap((e) => e.state.events),
      ),
      files: Object.keys(index.files).length,
      bytesRead,
      warnings,
    };
  }
  return () =>
    inflight ??
    (inflight = scan().finally(() => {
      inflight = null;
    }));
}

export const readCodexUsage = createCodexReader(
  process.env.CODEX_HOME || join(homedir(), ".codex"),
  join(process.cwd(), "var", "usage", "codex-index.json"),
);
