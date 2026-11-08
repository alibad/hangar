// What the Products board shows, shared by the server (src/lib/products.ts) and the page. No Node imports here.

export type FeedbackIssue = {
  repo: string; // owner/name
  number: number;
  title: string;
  url: string;
  at: string; // created, ISO
  open: boolean;
  labels: string[];
};

export type FeedbackPlace = { repo: string; label: string | null; open: number; total: number; public: boolean };

/** The GitHub page listing a place's open reports. */
export function placeUrl(p: FeedbackPlace) {
  return `https://github.com/${p.repo}/issues?q=${encodeURIComponent(`is:open label:${p.label ? `"${p.label}"` : "feedback"}`)}`;
}

export type ReleaseState = "ready" | "error" | "building" | "canceled" | "unknown";

export type ProductSite = { project: string; domain: string | null; repo: string | null };

export type Product = {
  id: string;
  name: string;
  /** The first custom domain, else the first site's Vercel address. */
  domain: string | null;
  /** The icon the live site declares (apple-touch-icon, else icon), absolute; null when none was found. */
  icon: string | null;
  sites: ProductSite[];
  repos: string[];
  /** Repositories in this product that anyone can read: feedback filed there is public. */
  publicRepos: string[];
  feedback: {
    /** Filed in the last 7 days (counted from each repository's newest 20). */
    week: number;
    open: number;
    total: number;
    latest: FeedbackIssue[];
    /** Every place this product's reports land, most open first: a repository, or the shared inbox with a label. */
    where: FeedbackPlace[];
  };
  releases: {
    last: { at: string; state: ReleaseState; project: string; message: string | null } | null;
    /** Production releases in the last 7 days. */
    week: number;
    /** Deployments that failed in the last 7 days, preview or production. */
    failed: number;
    lastFailure: { at: string; project: string; target: string | null } | null;
  };
  usage: {
    /** Active users in the last 7 days, summed over the product's GA4 properties; null when not read. */
    week: number | null;
    previous: number | null;
    properties: { id: string; name: string }[];
  };
  /** Higher sorts first: failures, then new feedback, then recent activity. */
  attention: number;
  quiet: boolean;
};

export type SourceState = {
  ok: boolean;
  /** analytics only: what the owner must do before numbers show. */
  state?: "ok" | "signin" | "enable" | "error" | "off";
  message?: string;
  command?: string;
  link?: string;
  at?: string;
};

/** Bumped whenever the report's shape changes, so an older cached report is read again rather than misread. */
export const PRODUCTS_SCHEMA = 2;

export type ProductsReport = {
  schema: number;
  generatedAt: string;
  products: Product[];
  /** Every feedback issue filed in the last 7 days across all products, newest first. */
  inbox: (FeedbackIssue & { product: string })[];
  totals: { feedbackWeek: number; feedbackOpen: number; usersWeek: number | null; usersPrevious: number | null; releasesWeek: number; failedWeek: number };
  sources: { vercel: SourceState; github: SourceState; analytics: SourceState };
  configured: boolean;
};

export type ProductsResponse = ProductsReport & { refreshing: boolean; stale: boolean };

export const WEEK_MS = 7 * 86_400_000;

/** "5m", "3h", "2d" — the age of an ISO time, for tight places. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 60) return `${Math.max(1, min)}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  if (min < 60 * 24 * 60) return `${Math.floor(min / 1440)}d`;
  return `${Math.floor(min / (1440 * 30))}mo`;
}
