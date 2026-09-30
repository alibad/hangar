import { lookup } from "dns/promises";
import net from "net";

/**
 * What the Video Forge listens to. Every source here is free and keyless — no
 * metered search API — so a listen costs nothing but a few HTTP requests:
 *
 *   Google Trends daily RSS     what people are searching for, with traffic
 *   Wikipedia most-read         what people are reading about, with views
 *   Hacker News front page      what the tech crowd is discussing
 *   SearXNG (self-hosted)       web search for the model's own follow-ups,
 *                               loopback-only on :8888; Wikipedia search when
 *                               it is down
 *
 * Reddit was the obvious fourth and is not here: its JSON endpoints now answer
 * 403 without OAuth (checked 2026-09-29). GDELT is free but rate-limits to one
 * request per 5 s and answered 429 on the first try.
 *
 * Each source fails soft — one dead feed returns [] with its reason in
 * `problems`, never an exception — so a listen always has something to say.
 */

export type SignalSource = "google-trends" | "wikipedia" | "hacker-news";

export type Signal = {
  source: SignalSource;
  title: string;
  /** One line of context: the news headline behind a trend, a Wikipedia extract. */
  detail?: string;
  url?: string;
  /** Searches, page views or points, as reported; comparable only within a source. */
  weight?: number;
};

export type SearchHit = { title: string; url: string; snippet: string };

const UA = "BeTenshi-VideoForge/1.0 (local; contact: console)";

async function get(url: string, timeoutMs = 15_000): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : undefined;
};

/** Google Trends' daily trending searches for one country. */
export async function googleTrends(geo = "US"): Promise<Signal[]> {
  const res = await get(`https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`);
  if (!res.ok) throw new Error(`Google Trends HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map(([, item]) => {
    const traffic = tag(item, "ht:approx_traffic") ?? "";
    const news = tag(item, "ht:news_item_title");
    return {
      source: "google-trends" as const,
      title: tag(item, "title") ?? "",
      detail: news ? `news: ${news}` : undefined,
      url: tag(item, "ht:news_item_url"),
      weight: Number(traffic.replace(/[^\d]/g, "")) || undefined,
    };
  }).filter((s) => s.title);
}

/** Wikipedia's most-read articles for a UTC day (yesterday's list is the freshest complete one). */
export async function wikipediaMostRead(day = new Date(Date.now() - 86_400_000)): Promise<Signal[]> {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, "0");
  const d = String(day.getUTCDate()).padStart(2, "0");
  const res = await get(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${y}/${m}/${d}`);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const body = (await res.json()) as {
    mostread?: { articles?: { titles?: { normalized?: string }; views?: number; extract?: string; content_urls?: { desktop?: { page?: string } } }[] };
  };
  return (body.mostread?.articles ?? []).slice(0, 20).map((a) => ({
    source: "wikipedia" as const,
    title: a.titles?.normalized ?? "",
    detail: a.extract ? a.extract.slice(0, 220) : undefined,
    url: a.content_urls?.desktop?.page,
    weight: a.views,
  })).filter((s) => s.title);
}

/** The Hacker News front page. */
export async function hackerNews(): Promise<Signal[]> {
  const res = await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15");
  if (!res.ok) throw new Error(`Hacker News HTTP ${res.status}`);
  const body = (await res.json()) as { hits?: { title?: string; url?: string; points?: number; objectID?: string }[] };
  return (body.hits ?? []).map((h) => ({
    source: "hacker-news" as const,
    title: h.title ?? "",
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    weight: h.points,
  })).filter((s) => s.title);
}

export type ListenResult = { signals: Signal[]; problems: string[] };

/** Every source, in parallel; a failing one is reported, not thrown. */
export async function listenAll(opts: { geo?: string; sources?: SignalSource[] } = {}): Promise<ListenResult> {
  const want = new Set(opts.sources ?? ["google-trends", "wikipedia", "hacker-news"]);
  const jobs: [SignalSource, () => Promise<Signal[]>][] = [
    ["google-trends", () => googleTrends(opts.geo)],
    // Three days of most-read: more topics for an unlimited window; the shortlist dedupes.
    ["wikipedia", async () => (await Promise.all([1, 2, 3].map((d) => wikipediaMostRead(new Date(Date.now() - d * 86_400_000))))).flat()],
    ["hacker-news", () => hackerNews()],
  ];
  const settled = await Promise.allSettled(jobs.filter(([id]) => want.has(id)).map(([, fn]) => fn()));
  const signals: Signal[] = [];
  const problems: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") signals.push(...r.value);
    else problems.push(`${jobs.filter(([id]) => want.has(id))[i][0]}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  });
  return { signals, problems };
}

// ── search and read, for the model's tool calls ──────────────────────────────

export const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";

/** SearXNG first; Wikipedia's own search when it is not running. */
export async function webSearch(query: string, limit = 6): Promise<{ engine: string; hits: SearchHit[] }> {
  try {
    const res = await get(`${SEARXNG_URL}/search?format=json&safesearch=1&q=${encodeURIComponent(query)}`, 20_000);
    if (res.ok) {
      const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
      const hits = (body.results ?? []).slice(0, limit).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: (r.content ?? "").slice(0, 240) }));
      if (hits.length) return { engine: "searxng", hits };
    }
  } catch {
    // fall through to Wikipedia
  }
  const res = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`search failed: SearXNG down and Wikipedia HTTP ${res.status}`);
  const body = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return {
    engine: "wikipedia",
    hits: (body.query?.search ?? []).map((s) => ({
      title: s.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
      snippet: decode(s.snippet.replace(/<[^>]+>/g, "")),
    })),
  };
}

/**
 * Is this address somewhere a web page could legitimately be? The model picks
 * the URLs it reads, and it picks them after reading other pages — so a page
 * that says "now read http://127.0.0.1:8099/…" must not reach the manager, the
 * router or anything else on this box or the LAN.
 */
function publicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return false;
  if (v6.startsWith("::ffff:")) return publicAddress(v6.slice(7));
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) pages can be read");
  if (url.username || url.password) throw new Error("URLs with credentials are refused");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local addresses are refused");
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => !publicAddress(a.address))) throw new Error("that address is not on the public internet");
  return url;
}

/** A page's readable text, capped. Redirects are followed by hand so each hop is checked. */
export async function readPage(raw: string, maxChars = 3000): Promise<{ url: string; title: string; text: string }> {
  let url = await assertPublicUrl(raw);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? "?"}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/xhtml/.test(type)) throw new Error(`not a text page (${type || "unknown type"})`);
  const reader = res.body?.getReader();
  let html = "";
  if (reader) {
    const dec = new TextDecoder();
    for (let total = 0; total < 1_500_000; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => undefined);
  }
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 200);
  const main = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  const text = decode(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { url: url.toString(), title, text: text.slice(0, maxChars) };
}
