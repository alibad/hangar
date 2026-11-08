// The Products board's pure half: from what Vercel, GitHub and Google Analytics said, build one row per product.
// No imports at run time, so scripts/products.test.mjs can transpile and test it on its own.
//
// A product is what a person uses: RTS AI is the rtsai.net site, the /play game and their repositories. The local
// config (config/products.local.json) names the products that span several Vercel projects or repositories; every
// other Vercel project becomes a product of its own, and so does every repository with a `feedback` label that no
// product claims. Nothing has to be listed for it to show up.

import type { FeedbackIssue, FeedbackPlace, Product, ProductSite, ProductsReport, ReleaseState } from "./products-shared";

export type ConfigProduct = {
  name?: string;
  vercel?: string[];
  repos?: string[];
  /** Reports for this product land in the shared inbox with this label (for example app:qatar-atlas). */
  feedbackLabel?: string;
  /** GA4 property ids (numbers). Properties whose web stream points at one of the product's domains join on their own. */
  ga4?: string[];
  hidden?: boolean;
};

export type ProductsConfig = {
  vercelScope: string | null;
  githubOwner: string | null;
  /** The private repository every app may send to, split by app: labels. */
  sharedInbox: string | null;
  /** Vercel projects or repositories (owner/name or name) to leave off the board. */
  hide: string[];
  products: Record<string, ConfigProduct>;
};

export type VercelProject = {
  id: string;
  name: string;
  repo: string | null; // owner/name
  domains: string[];
  production: { at: string; state: ReleaseState; message: string | null } | null;
};

export type VercelDeployment = { projectId: string; at: string; state: ReleaseState; target: string | null };

export type RepoFeedback = {
  repo: string; // owner/name
  public: boolean;
  /** The repository has a feedback label at all, i.e. some app files reports here. */
  hasFeedback: boolean;
  open: number;
  total: number;
  recent: FeedbackIssue[];
  /** Shared inbox only: the same counts per app: label. */
  byLabel?: Record<string, { open: number; total: number; recent: FeedbackIssue[] }>;
};

export type AnalyticsProperty = { id: string; name: string; hosts: string[]; week: number | null; previous: number | null };

export type BuildInput = {
  config: ProductsConfig;
  projects: VercelProject[];
  failures: VercelDeployment[];
  releases: VercelDeployment[];
  repos: RepoFeedback[];
  properties: AnalyticsProperty[];
  now: number;
};

const WEEK = 7 * 86_400_000;
const MONTH = 30 * 86_400_000;
const LATEST = 5;

const lower = (s: string) => s.toLowerCase();
const bare = (host: string) => lower(host).replace(/^www\./, "");
const squash = (s: string) => lower(s).replace(/[^a-z0-9]/g, "");
const repoName = (full: string) => full.split("/").pop() || full;
const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

/** "cold-club-web" → "Cold Club Web"; names already cased ("RTSAI-Web") keep their case. */
export function prettyName(raw: string): string {
  const words = raw.replace(/^app:/, "").split(/[-_\s]+/).filter(Boolean);
  return words.map((w) => (w === lower(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

/** The address people know a site by: a custom domain over *.vercel.app, without www when both exist. */
export function primaryDomain(domains: string[]): string | null {
  const custom = domains.filter((d) => !d.endsWith(".vercel.app"));
  const pool = custom.length ? custom : domains;
  if (!pool.length) return null;
  const plain = pool.find((d) => !d.startsWith("www.") && pool.includes(`www.${d}`));
  return plain ?? pool.find((d) => !d.startsWith("www.")) ?? pool[0];
}

function matchesRepo(entry: string, full: string) {
  return entry.includes("/") ? lower(entry) === lower(full) : lower(entry) === lower(repoName(full));
}

type Draft = {
  id: string;
  name: string;
  projects: VercelProject[];
  repos: Set<string>;
  label: string | null;
  ga4: Set<string>;
};

export function buildProducts(input: BuildInput): Pick<ProductsReport, "products" | "inbox" | "totals"> {
  const { config, now } = input;
  const hideList = [...config.hide, ...Object.values(config.products).filter((p) => p.hidden).flatMap((p) => p.repos ?? [])];
  const hidden = (s: string) => hideList.some((h) => matchesRepo(h, s) || lower(h) === lower(s));
  const repoByName = new Map(input.repos.map((r) => [lower(r.repo), r]));
  const fullRepo = (entry: string) => {
    if (entry.includes("/")) return entry;
    const known = input.repos.find((r) => matchesRepo(entry, r.repo));
    return known ? known.repo : config.githubOwner ? `${config.githubOwner}/${entry}` : entry;
  };

  // 1. The products the config names.
  const drafts: Draft[] = [];
  const claimedProjects = new Set<string>();
  for (const [id, p] of Object.entries(config.products)) {
    if (p.hidden) {
      for (const name of p.vercel ?? []) claimedProjects.add(lower(name));
      continue;
    }
    // In the config's order: the first site names the product's address.
    const projects = (p.vercel ?? []).map((n) => input.projects.find((v) => lower(v.name) === lower(n))).filter((v): v is VercelProject => !!v);
    projects.forEach((v) => claimedProjects.add(lower(v.name)));
    const repos = new Set((p.repos ?? []).map(fullRepo));
    projects.forEach((v) => v.repo && repos.add(v.repo));
    drafts.push({ id, name: p.name || prettyName(id), projects, repos, label: p.feedbackLabel ?? null, ga4: new Set(p.ga4 ?? []) });
  }

  // 2. Every other Vercel project is a product of its own, with the repository it builds from.
  for (const v of input.projects) {
    if (claimedProjects.has(lower(v.name)) || hidden(v.name) || (v.repo && hidden(v.repo))) continue;
    const owner = v.repo ? drafts.find((d) => !d.projects.length && [...d.repos].some((r) => lower(r) === lower(v.repo!))) : undefined;
    if (owner) { owner.projects.push(v); continue; }
    drafts.push({ id: lower(v.name), name: prettyName(v.name), projects: [v], repos: new Set(v.repo ? [v.repo] : []), label: null, ga4: new Set() });
  }

  // 3. Every repository that takes feedback and belongs to no product yet. The shared inbox is split by label instead.
  const claimedRepos = () => new Set(drafts.flatMap((d) => [...d.repos].map(lower)));
  const inbox = config.sharedInbox ? lower(config.sharedInbox) : null;
  const taken = claimedRepos();
  for (const r of input.repos) {
    if (!r.hasFeedback || lower(r.repo) === inbox || taken.has(lower(r.repo)) || hidden(r.repo)) continue;
    drafts.push({ id: lower(repoName(r.repo)), name: prettyName(repoName(r.repo)), projects: [], repos: new Set([r.repo]), label: null, ga4: new Set() });
  }
  const shared = inbox ? repoByName.get(inbox) : undefined;
  for (const label of Object.keys(shared?.byLabel ?? {})) {
    if (drafts.some((d) => d.label && lower(d.label) === lower(label))) continue;
    drafts.push({ id: lower(label.replace(/^app:/, "")), name: prettyName(label), projects: [], repos: new Set(), label, ga4: new Set() });
  }

  // Two drafts with one id (a repo named like a Vercel project): keep the first, fold the second in.
  const byId = new Map<string, Draft>();
  for (const d of drafts) {
    const seen = byId.get(d.id);
    if (!seen) { byId.set(d.id, d); continue; }
    seen.projects.push(...d.projects);
    d.repos.forEach((r) => seen.repos.add(r));
    seen.label ??= d.label;
    d.ga4.forEach((g) => seen.ga4.add(g));
  }

  const products: Product[] = [];
  for (const d of byId.values()) {
    const sites: ProductSite[] = d.projects.map((v) => ({ project: v.name, domain: primaryDomain(v.domains), repo: v.repo }));
    const hosts = new Set(d.projects.flatMap((v) => v.domains.map(bare)));
    const domain = sites.map((s) => s.domain).find((x) => x && !x.endsWith(".vercel.app")) ?? sites.find((s) => s.domain)?.domain ?? null;

    // Feedback: the product's own repositories, plus its label in the shared inbox.
    const sources = [...d.repos].map((r) => repoByName.get(lower(r))).filter((r): r is RepoFeedback => !!r && lower(r.repo) !== inbox);
    const labelled = d.label && shared?.byLabel ? Object.entries(shared.byLabel).find(([l]) => lower(l) === lower(d.label!))?.[1] : undefined;
    const pools = [...sources.filter((s) => s.hasFeedback), ...(labelled ? [labelled] : [])];
    const recent = pools.flatMap((s) => s.recent).sort((a, b) => time(b.at) - time(a.at));
    // Every place reports land: the product's repositories with a feedback label, and its label in the shared inbox.
    const where: FeedbackPlace[] = sources.filter((s) => s.hasFeedback).map((s) => ({ repo: s.repo, label: null, open: s.open, total: s.total, public: s.public }));
    if (labelled && shared) where.push({ repo: shared.repo, label: d.label, open: labelled.open, total: labelled.total, public: shared.public });
    where.sort((a, b) => b.open - a.open || b.total - a.total);

    // Releases.
    const ids = new Set(d.projects.map((v) => v.id));
    const prod = d.projects.filter((v) => v.production).sort((a, b) => time(b.production!.at) - time(a.production!.at))[0];
    const failures = input.failures.filter((f) => ids.has(f.projectId)).sort((a, b) => time(b.at) - time(a.at));
    const nameOf = (projectId: string) => d.projects.find((v) => v.id === projectId)?.name ?? projectId;

    // Usage: the GA4 properties named in the config, or whose web stream points at one of this product's domains.
    const props = input.properties.filter((p) => d.ga4.has(p.id) || p.hosts.some((h) => hosts.has(bare(h))));
    const read = props.filter((p) => p.week != null);
    const sum = (k: "week" | "previous") => (read.length ? read.reduce((n, p) => n + (p[k] ?? 0), 0) : null);

    const product: Product = {
      id: d.id,
      name: d.name,
      domain,
      icon: null,
      sites,
      repos: [...d.repos].filter((r) => lower(r) !== inbox),
      publicRepos: sources.filter((s) => s.public && s.hasFeedback).map((s) => s.repo),
      feedback: {
        week: recent.filter((i) => now - time(i.at) < WEEK).length,
        open: pools.reduce((n, s) => n + s.open, 0),
        total: pools.reduce((n, s) => n + s.total, 0),
        latest: recent.slice(0, LATEST),
        where,
      },
      releases: {
        last: prod ? { at: prod.production!.at, state: prod.production!.state, project: prod.name, message: prod.production!.message } : null,
        week: input.releases.filter((r) => ids.has(r.projectId) && now - time(r.at) < WEEK).length,
        failed: failures.filter((f) => now - time(f.at) < WEEK).length,
        lastFailure: failures[0] ? { at: failures[0].at, project: nameOf(failures[0].projectId), target: failures[0].target } : null,
      },
      usage: { week: sum("week"), previous: sum("previous"), properties: props.map((p) => ({ id: p.id, name: p.name })) },
      attention: 0,
      quiet: false,
    };
    const lastTouch = Math.max(time(product.releases.last?.at), time(recent[0]?.at));
    const newWeek = product.feedback.week;
    product.attention = product.releases.failed * 1000 + newWeek * 100 + (product.publicRepos.length ? 50 : 0) + (now - lastTouch < WEEK ? 10 : 0);
    product.quiet = !product.attention && !product.feedback.open && !(product.usage.week ?? 0) && now - lastTouch > MONTH;
    products.push(product);
  }

  const last = (p: Product) => Math.max(time(p.releases.last?.at), time(p.feedback.latest[0]?.at));
  products.sort((a, b) => b.attention - a.attention || last(b) - last(a) || a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const week = products
    .flatMap((p) => p.feedback.latest.map((i) => ({ ...i, product: p.id })))
    .filter((i) => now - time(i.at) < WEEK && !seen.has(i.url) && seen.add(i.url));
  // The latest five per product can miss some of a busy week; the repositories' own recent lists fill them in.
  for (const p of products) {
    if (p.feedback.week <= LATEST) continue;
    const pools = input.repos.filter((r) => p.repos.some((x) => lower(x) === lower(r.repo)));
    for (const i of pools.flatMap((r) => r.recent)) if (now - time(i.at) < WEEK && !seen.has(i.url) && seen.add(i.url)) week.push({ ...i, product: p.id });
  }
  week.sort((a, b) => time(b.at) - time(a.at));

  const usersRead = products.filter((p) => p.usage.week != null);
  const total = (k: "week" | "previous") => (usersRead.length ? usersRead.reduce((n, p) => n + (p.usage[k] ?? 0), 0) : null);
  return {
    products,
    inbox: week,
    totals: {
      feedbackWeek: products.reduce((n, p) => n + p.feedback.week, 0),
      feedbackOpen: products.reduce((n, p) => n + p.feedback.open, 0),
      usersWeek: total("week"),
      usersPrevious: total("previous"),
      releasesWeek: products.reduce((n, p) => n + p.releases.week, 0),
      failedWeek: products.reduce((n, p) => n + p.releases.failed, 0),
    },
  };
}
