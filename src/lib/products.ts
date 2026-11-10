// The Products board: for every app that people use, the feedback they sent, how many came, and whether the last
// release worked. One read of three places Hangar can already reach on this machine, cached for an hour:
//
//   GitHub  feedback issues (label `feedback`) in each repository, through the signed-in `gh`;
//   Vercel  projects, their domains and repositories, production releases and failed builds, through the signed-in
//           `vercel` CLI (`vercel api`);
//   Google  Analytics active users per GA4 property, through gcloud's Application Default Credentials, once they
//           carry the analytics.readonly scope (the board shows the one command when they don't).
//
// It only reads. The product list itself (which projects and repositories make one product) is in
// config/products.local.json, ignored by git because it names every app on the account; see
// config/products.example.json. Assembly is in products-build.ts so it can be tested without any of this.

import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "@/lib/db";
import {
  buildProducts, type AnalyticsProperty, type ConfigProduct, type ProductsConfig, type RepoFeedback, type VercelDeployment, type VercelProject,
} from "@/lib/products-build";
import { PRODUCTS_SCHEMA, WEEK_MS, type FeedbackIssue, type ProductsReport, type ProductsResponse, type ReleaseState, type SourceState } from "@/lib/products-shared";

const CONFIG_FILE = process.env.HANGAR_PRODUCTS_CONFIG || path.join(process.cwd(), "config", "products.local.json");
const CACHE_FILE = path.join(DATA_DIR, "products.json");
const FRESH_MS = 60 * 60_000;
const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
// The scope list is quoted: unquoted, PowerShell reads the commas as a list and hands gcloud the scopes joined by
// spaces, which gcloud rejects ("cloud-platform scope is required but not requested"). Quoted works in cmd and sh too.
const SIGN_IN = `gcloud auth application-default login --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,${ANALYTICS_SCOPE}"`;

type Json = Record<string, unknown>;
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const firstLine = (v: unknown) => (isString(v) ? v.split(/\r?\n/)[0].trim().slice(0, 140) || null : null);

// ── configuration ──────────────────────────────────────────────────────────

export function productsConfig(): ProductsConfig & { configured: boolean } {
  let raw: Json = {};
  let configured = false;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    configured = true;
  } catch {
    /* no config: every Vercel project and feedback repository is its own product */
  }
  const products: Record<string, ConfigProduct> = {};
  const list = raw.products && typeof raw.products === "object" ? (raw.products as Record<string, Json>) : {};
  for (const [id, p] of Object.entries(list)) {
    if (!p || typeof p !== "object" || id.startsWith("$")) continue;
    products[id] = {
      name: isString(p.name) ? p.name : undefined,
      vercel: asArray(p.vercel).filter(isString),
      repos: asArray(p.repos).filter(isString),
      feedbackLabel: isString(p.feedbackLabel) ? p.feedbackLabel : undefined,
      ga4: asArray(p.ga4).map(String).filter((x) => /^\d+$/.test(x)),
      hidden: p.hidden === true,
    };
  }
  return {
    vercelScope: isString(raw.vercelScope) ? raw.vercelScope : process.env.HANGAR_VERCEL_SCOPE || null,
    githubOwner: isString(raw.githubOwner) ? raw.githubOwner : null,
    sharedInbox: isString(raw.sharedInbox) ? raw.sharedInbox : null,
    hide: asArray(raw.hide).filter(isString),
    products,
    configured,
  };
}

// ── running the signed-in command-line tools ───────────────────────────────

function run(file: string, args: string[], timeout = 90_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }, (error, stdout, stderr) => {
      if (error) {
        const said = `${stderr || ""}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/is in beta/i.test(l));
        reject(Object.assign(new Error(said.slice(-2).join(" ") || error.message), { stdout: `${stdout}` }));
      } else resolve(`${stdout}`);
    });
  });
}

/** The Vercel CLI without a shell: on Windows `vercel` is a .cmd shim, which Node will not start directly. */
function vercelCommand(): [string, string[]] {
  if (process.env.HANGAR_VERCEL_BIN) return [process.env.HANGAR_VERCEL_BIN, []];
  if (process.platform === "win32") {
    const js = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "vercel", "dist", "vc.js");
    if (fs.existsSync(js)) return [process.execPath, [js]];
  }
  return ["vercel", []];
}

async function vercelApi<T>(endpoint: string, scope: string | null): Promise<T> {
  const [file, pre] = vercelCommand();
  const out = await run(file, [...pre, "api", endpoint, "--raw", ...(scope ? ["--scope", scope] : [])]);
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`Vercel answered without data for ${endpoint.split("?")[0]}`);
  return JSON.parse(out.slice(start)) as T;
}

const gh = (args: string[]) => run(process.platform === "win32" ? "gh.exe" : "gh", args);

// ── Vercel ─────────────────────────────────────────────────────────────────

function releaseState(v: unknown): ReleaseState {
  const s = `${v ?? ""}`.toUpperCase();
  if (s === "READY") return "ready";
  if (s === "ERROR") return "error";
  if (s === "CANCELED") return "canceled";
  if (s === "BUILDING" || s === "QUEUED" || s === "INITIALIZING") return "building";
  return "unknown";
}

const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString());

async function vercelProjects(scope: string | null): Promise<VercelProject[]> {
  const projects: VercelProject[] = [];
  let until: number | null = null;
  for (let page = 0; page < 5; page++) {
    const j: { projects?: Json[]; pagination?: { next?: number | null } } = await vercelApi(`/v9/projects?limit=100${until ? `&until=${until}` : ""}`, scope);
    for (const p of j.projects ?? []) {
      const target = (p.targets as Json | undefined)?.production as Json | undefined;
      const link = p.link as Json | undefined;
      projects.push({
        id: `${p.id}`,
        name: `${p.name}`,
        repo: link && isString(link.org) && isString(link.repo) ? `${link.org}/${link.repo}` : null,
        domains: asArray(target?.alias).filter(isString),
        production: target ? { at: iso(target.createdAt), state: releaseState(target.readyState), message: firstLine((target.meta as Json | undefined)?.githubCommitMessage) } : null,
      });
    }
    until = j.pagination?.next ?? null;
    if (!until) break;
  }
  return projects;
}

async function vercelDeployments(scope: string | null, filter: string): Promise<VercelDeployment[]> {
  const since = Date.now() - WEEK_MS;
  const found: VercelDeployment[] = [];
  let until: number | null = null;
  for (let page = 0; page < 3; page++) {
    const j: { deployments?: Json[]; pagination?: { next?: number | null } } = await vercelApi(`/v6/deployments?limit=100&since=${since}&${filter}${until ? `&until=${until}` : ""}`, scope);
    for (const d of j.deployments ?? []) {
      found.push({ projectId: `${d.projectId}`, at: iso(d.created ?? d.createdAt), state: releaseState(d.state ?? d.readyState), target: isString(d.target) ? d.target : null });
    }
    until = j.pagination?.next ?? null;
    if (!until) break;
  }
  return found;
}

// ── GitHub ─────────────────────────────────────────────────────────────────

const ISSUE_FIELDS = "number title url createdAt state labels(first:8){nodes{name}}";

function toIssue(repo: string, n: Json): FeedbackIssue {
  return {
    repo,
    number: Number(n.number) || 0,
    title: `${n.title ?? ""}`.slice(0, 200),
    url: `${n.url ?? ""}`,
    at: `${n.createdAt ?? ""}`,
    open: n.state === "OPEN",
    labels: asArray((n.labels as Json | undefined)?.nodes).map((l) => `${(l as Json).name ?? ""}`).filter(Boolean),
  };
}

async function graphql(query: string): Promise<Json> {
  let out: string;
  try {
    out = await gh(["api", "graphql", "-f", `query=${query}`]);
  } catch (e) {
    // gh exits non-zero when one alias fails (a renamed or deleted repository) but still prints the others' data.
    out = (e as { stdout?: string }).stdout ?? "";
    if (!out.trim().startsWith("{")) throw e;
  }
  return (JSON.parse(out) as { data?: Json }).data ?? {};
}

/** Every non-fork, non-archived repository of the owner, plus the ones the config names elsewhere. */
async function candidateRepos(owner: string, config: ProductsConfig): Promise<string[]> {
  const out = await gh(["repo", "list", owner, "--limit", "1000", "--no-archived", "--source", "--json", "nameWithOwner"]);
  const repos = new Set((JSON.parse(out) as { nameWithOwner: string }[]).map((r) => r.nameWithOwner));
  for (const p of Object.values(config.products)) for (const r of p.repos ?? []) if (r.includes("/")) repos.add(r);
  if (config.sharedInbox) repos.add(config.sharedInbox);
  return [...repos];
}

async function repoFeedback(repos: string[]): Promise<RepoFeedback[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < repos.length; i += 30) chunks.push(repos.slice(i, i + 30));
  const results: RepoFeedback[] = [];
  const work = async (chunk: string[]) => {
    const parts = chunk.map((full, i) => {
      const [owner, name] = full.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner isPrivate label(name: "feedback") { open: issues(states: OPEN) { totalCount } all: issues { totalCount } recent: issues(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${ISSUE_FIELDS} } } } }`;
    });
    const data = await graphql(`query { ${parts.join("\n")} }`);
    chunk.forEach((_, i) => {
      const r = data[`r${i}`] as Json | null | undefined;
      if (!r) return;
      const repo = `${r.nameWithOwner}`;
      const label = r.label as Json | null;
      results.push({
        repo,
        public: r.isPrivate === false,
        hasFeedback: !!label,
        open: Number(((label?.open as Json | undefined)?.totalCount)) || 0,
        total: Number(((label?.all as Json | undefined)?.totalCount)) || 0,
        recent: asArray((label?.recent as Json | undefined)?.nodes).map((n) => toIssue(repo, n as Json)),
      });
    });
  };
  // Three queries at a time: GitHub answers each in a few seconds and counts them against one hourly budget.
  for (let i = 0; i < chunks.length; i += 3) await Promise.all(chunks.slice(i, i + 3).map(work));
  return results;
}

/** The shared inbox, split by app: label. */
async function inboxLabels(full: string): Promise<RepoFeedback["byLabel"]> {
  const [owner, name] = full.split("/");
  const data = await graphql(`query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { labels(first: 100, query: "app:") { nodes { name open: issues(states: OPEN) { totalCount } all: issues { totalCount } recent: issues(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${ISSUE_FIELDS} } } } } } }`);
  const out: NonNullable<RepoFeedback["byLabel"]> = {};
  for (const l of asArray(((data.repository as Json | undefined)?.labels as Json | undefined)?.nodes) as Json[]) {
    const label = `${l.name}`;
    if (!label.startsWith("app:")) continue;
    out[label] = {
      open: Number((l.open as Json | undefined)?.totalCount) || 0,
      total: Number((l.all as Json | undefined)?.totalCount) || 0,
      recent: asArray((l.recent as Json | undefined)?.nodes).map((n) => toIssue(full, n as Json)),
    };
  }
  return out;
}

// ── Google Analytics ───────────────────────────────────────────────────────

class NeedsOwner extends Error {
  constructor(public state: SourceState) { super(state.message); }
}

function adcFile() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const base = process.platform === "win32" ? path.join(process.env.APPDATA ?? "", "gcloud") : path.join(os.homedir(), ".config", "gcloud");
  return path.join(base, "application_default_credentials.json");
}

/** An access token from gcloud's Application Default Credentials, the way Google's own client libraries get one. */
async function googleToken(): Promise<{ token: string; project: string | null }> {
  let adc: Json;
  try {
    adc = JSON.parse(await fsp.readFile(adcFile(), "utf8"));
  } catch {
    throw new NeedsOwner({ ok: false, state: "signin", message: "Sign in to Google once so Hangar can read Google Analytics.", command: SIGN_IN });
  }
  if (adc.type !== "authorized_user") {
    throw new NeedsOwner({ ok: false, state: "error", message: `Hangar reads Google Analytics with a gcloud user sign-in; the credentials file holds a ${adc.type}.`, command: SIGN_IN });
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: `${adc.client_id}`, client_secret: `${adc.client_secret}`, refresh_token: `${adc.refresh_token}`, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || !isString(j.access_token)) {
    throw new NeedsOwner({ ok: false, state: "signin", message: "The Google sign-in has expired. Sign in again.", command: SIGN_IN });
  }
  if (!`${j.scope ?? ""}`.split(" ").includes(ANALYTICS_SCOPE)) {
    throw new NeedsOwner({ ok: false, state: "signin", message: "The Google sign-in on this machine cannot read Analytics yet. Sign in once more with Analytics allowed.", command: SIGN_IN });
  }
  return { token: j.access_token, project: isString(adc.quota_project_id) ? adc.quota_project_id : null };
}

async function google(url: string, auth: { token: string; project: string | null }, body?: unknown): Promise<Json> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json", ...(auth.project ? { "x-goog-user-project": auth.project } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as Json;
  if (res.ok) return j;
  const error = (j.error ?? {}) as Json;
  const details = asArray(error.details) as Json[];
  const reason = details.map((d) => `${d.reason ?? ""}`).find(Boolean) ?? "";
  if (reason === "SERVICE_DISABLED" || /has not been used|is disabled/i.test(`${error.message}`)) {
    const meta = (details.find((d) => d.metadata)?.metadata ?? {}) as Json;
    const service = isString(meta.service) ? meta.service : new URL(url).host;
    throw new NeedsOwner({
      ok: false, state: "enable",
      message: `Turn on the ${service === "analyticsadmin.googleapis.com" ? "Google Analytics Admin API" : "Google Analytics Data API"} in Google Cloud project ${auth.project ?? "(none)"}, the one gcloud bills reads to.`,
      link: isString(meta.activationUrl) ? meta.activationUrl : `https://console.cloud.google.com/apis/library/${service}${auth.project ? `?project=${auth.project}` : ""}`,
    });
  }
  if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
    throw new NeedsOwner({ ok: false, state: "signin", message: "The Google sign-in on this machine cannot read Analytics yet.", command: SIGN_IN });
  }
  throw new Error(`${error.message ?? res.statusText}`.slice(0, 200));
}

async function analyticsProperties(): Promise<AnalyticsProperty[]> {
  const auth = await googleToken();
  const summaries: Json[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const j = await google(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, auth);
    summaries.push(...(asArray(j.accountSummaries) as Json[]));
    pageToken = isString(j.nextPageToken) ? j.nextPageToken : "";
    if (!pageToken) break;
  }
  const props = summaries.flatMap((a) => asArray(a.propertySummaries) as Json[]).map((p) => ({ id: `${p.property}`.replace(/^properties\//, ""), name: `${p.displayName ?? p.property}` }));
  const out: AnalyticsProperty[] = [];
  const one = async (p: { id: string; name: string }) => {
    const streams = await google(`https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams?pageSize=50`, auth).catch((e) => { if (e instanceof NeedsOwner) throw e; return {} as Json; });
    const hosts = (asArray(streams.dataStreams) as Json[])
      .map((s) => `${((s.webStreamData as Json | undefined)?.defaultUri) ?? ""}`)
      .filter(Boolean)
      .map((u) => { try { return new URL(u.includes("://") ? u : `https://${u}`).host; } catch { return ""; } })
      .filter(Boolean);
    let week: number | null = null, previous: number | null = null;
    const report = await google(`https://analyticsdata.googleapis.com/v1beta/properties/${p.id}:runReport`, auth, {
      dateRanges: [{ startDate: "6daysAgo", endDate: "today", name: "week" }, { startDate: "13daysAgo", endDate: "7daysAgo", name: "previous" }],
      metrics: [{ name: "activeUsers" }],
    }).catch((e) => { if (e instanceof NeedsOwner) throw e; return null; });
    if (report) {
      week = 0; previous = 0;
      for (const row of asArray(report.rows) as Json[]) {
        const range = `${((asArray(row.dimensionValues)[0] as Json | undefined)?.value) ?? "week"}`;
        const value = Number(((asArray(row.metricValues)[0] as Json | undefined)?.value)) || 0;
        if (range === "previous") previous = value; else week = value;
      }
    }
    out.push({ id: p.id, name: p.name, hosts, week, previous });
  };
  for (let i = 0; i < props.length; i += 4) await Promise.all(props.slice(i, i + 4).map(one));
  return out;
}

// ── site icons ─────────────────────────────────────────────────────────────

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** The icon a live site declares in its page head: the apple-touch-icon (largest, made for this), else its icon. */
async function siteIcon(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}/`, { redirect: "follow", headers: { "User-Agent": "Hangar products board" }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok || !`${res.headers.get("content-type")}`.includes("html")) return null;
    const html = (await res.text()).slice(0, 300_000);
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const rel = (re: RegExp) => links.find((l) => re.test(attr(l, "rel") ?? ""));
    const tag = rel(/apple-touch-icon/i) ?? rel(/(^|\s)icon(\s|$)/i);
    const href = tag ? attr(tag, "href") : null;
    return href ? new URL(href.replace(/&amp;/g, "&"), res.url).toString() : null;
  } catch {
    return null;
  }
}

// ── the report ─────────────────────────────────────────────────────────────

const failed = (e: unknown): SourceState => ({ ok: false, state: "error", message: (e as Error)?.message?.slice(0, 300) || "failed" });

async function build(): Promise<ProductsReport> {
  const config = productsConfig();
  const now = Date.now();
  const stamp = () => new Date().toISOString();

  const vercel = (async () => {
    const [projects, failures, releases] = await Promise.all([
      vercelProjects(config.vercelScope),
      vercelDeployments(config.vercelScope, "state=ERROR"),
      vercelDeployments(config.vercelScope, "target=production&state=READY"),
    ]);
    return { projects, failures, releases };
  })();

  const github = (async () => {
    const owner = config.githubOwner || (await gh(["api", "user", "--jq", ".login"])).trim();
    const repos = await repoFeedback(await candidateRepos(owner, config));
    if (config.sharedInbox) {
      const inbox = repos.find((r) => r.repo.toLowerCase() === config.sharedInbox!.toLowerCase());
      if (inbox) inbox.byLabel = await inboxLabels(inbox.repo);
    }
    return { owner, repos };
  })();

  const analytics = analyticsProperties();
  const [v, g, a] = await Promise.allSettled([vercel, github, analytics]);

  const sources: ProductsReport["sources"] = {
    vercel: v.status === "fulfilled" ? { ok: true, at: stamp(), message: `${v.value.projects.length} projects` } : failed(v.reason),
    github: g.status === "fulfilled" ? { ok: true, at: stamp(), message: `${g.value.repos.filter((r) => r.hasFeedback).length} repositories take feedback` } : failed(g.reason),
    analytics: a.status === "fulfilled"
      ? { ok: true, state: "ok", at: stamp(), message: `${a.value.length} Analytics properties` }
      : a.reason instanceof NeedsOwner ? a.reason.state : failed(a.reason),
  };

  const built = buildProducts({
    config: { ...config, githubOwner: g.status === "fulfilled" ? g.value.owner : config.githubOwner },
    projects: v.status === "fulfilled" ? v.value.projects : [],
    failures: v.status === "fulfilled" ? v.value.failures : [],
    releases: v.status === "fulfilled" ? v.value.releases : [],
    repos: g.status === "fulfilled" ? g.value.repos : [],
    properties: a.status === "fulfilled" ? a.value : [],
    now,
  });
  const live = built.products.filter((p) => p.domain && !p.domain.endsWith(".vercel.app"));
  for (let i = 0; i < live.length; i += 8) {
    await Promise.all(live.slice(i, i + 8).map(async (p) => { p.icon = await siteIcon(p.domain!); }));
  }
  return { schema: PRODUCTS_SCHEMA, generatedAt: new Date(now).toISOString(), ...built, sources, configured: config.configured };
}

let inflight: Promise<ProductsReport> | null = null;

function refresh(): Promise<ProductsReport> {
  inflight ??= build()
    .then(async (report) => {
      await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fsp.writeFile(CACHE_FILE, JSON.stringify(report));
      return report;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

function cached(): ProductsReport | null {
  try {
    const report = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as ProductsReport;
    return report.schema === PRODUCTS_SCHEMA ? report : null;
  } catch {
    return null;
  }
}

/**
 * The last report when it is under an hour old. An older one (or force) comes back at once marked refreshing while
 * a new one is built; the page asks again until it is done. `wait` waits for the new one instead (the MCP tool).
 */
export async function productsReport({ force = false, wait = false } = {}): Promise<ProductsResponse> {
  const last = cached();
  const fresh = !!last && Date.now() - Date.parse(last.generatedAt) < FRESH_MS;
  if (last && fresh && !force) return { ...last, refreshing: !!inflight, stale: false };
  if (last && !wait) {
    void refresh().catch(() => { /* the next request tries again */ });
    return { ...last, refreshing: true, stale: !fresh };
  }
  const report = await refresh();
  return { ...report, refreshing: false, stale: false };
}
