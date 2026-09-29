import { routerUrl } from "../providers";
import { readPage, webSearch, type Signal } from "./sources";

/**
 * The Video Forge's researcher: a local model with tools that turns "what is
 * trending right now" into a brief for one short clip.
 *
 * It runs on local-small — Qwen2.5-7B-Instruct on the vllm-small container,
 * which quote-forge keeps resident all day and which is started with
 * --enable-auto-tool-choice --tool-call-parser hermes — so a listen costs no
 * extra memory and no money. A 7B is a modest researcher, so the loop is kept
 * narrow on purpose: the candidates are gathered BEFORE the model is asked
 * (sources.ts), unsafe ones are filtered out in code rather than trusted to the
 * prompt, it gets two research tools and two ways to finish, and a hard turn
 * budget. What it writes is checked afterwards: a source it cites must be one
 * it actually saw.
 */

export type Brief = {
  topic: string;
  whyNow: string;
  /** The candidate it chose, as heard. */
  heard: string;
  sources: { title?: string; url: string }[];
  stillPrompt: string;
  motionPrompt: string;
};

export type ToolCallTrace = { name: string; args: Record<string, unknown>; ok: boolean; ms: number; summary: string };

export type AgentTrace = {
  model: string;
  turns: number;
  calls: ToolCallTrace[];
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
};

export type AgentOutcome =
  | { kind: "brief"; brief: Brief; trace: AgentTrace }
  | { kind: "skip"; reason: string; trace: AgentTrace }
  | { kind: "error"; error: string; trace: AgentTrace };

export type ChannelSpec = { id: string; label: string; description: string };

export type ReviewMemory = { topic: string; verdict: "approved" | "rejected"; reason?: string };

/**
 * Topics a clip should not be made about, checked in code before the model sees
 * the list. Deliberately broad: a trending list is mostly news, and a
 * generated, realistic clip of a tragedy, a crime or a politician is exactly
 * what this box should never produce. A false positive costs one candidate.
 */
const UNSAFE =
  /\b(die[sd]?|dead|deaths?|dying|kill(s|ed|ing)?|murder\w*|shoot\w*|shot|gun\w*|war|wars|attack\w*|bomb\w*|explosion|crash\w*|collision|earthquake|hurricane|typhoon|tornado|flood\w*|wildfire|blaze|arrest\w*|charged|trial|lawsuit|sued|sentenc\w*|prison|jail|police|election\w*|vote[sd]?|voting|ballot|president|senator|congress|parliament|minister|governor|campaign|protest\w*|riot\w*|israel\w*|gaza|palestin\w*|ukrain\w*|russia\w*|iran|hamas|abortion|porn\w*|sex\w*|nude|naked|onlyfans|suicide|overdose|cancer|disease|outbreak|virus|obituar\w*|funeral|terror\w*|hostage|victim\w*|injur\w*|missing|abuse\w*|scandal|layoffs?|recall)\b/i;

export function unsafeReason(text: string): string | null {
  const m = UNSAFE.exec(text);
  return m ? `mentions "${m[0]}"` : null;
}

/**
 * People in a prompt. The channel never shows people — a generated likeness of
 * whoever is trending is the one thing it must not make, and video models
 * render anonymous people badly anyway — and the first live brief put "TSA
 * officers" in frame despite the prompt saying so. So it is checked here.
 */
const PEOPLE =
  /\b(people|person|persons|man|men|woman|women|vendors?|shoppers?|locals|residents|spectators|dancers?|musicians?|runners?|swimmers?|climbers?|hikers?|boy|boys|girl|girls|child|children|kids?|officers?|players?|athletes?|crowds?|tourists?|workers?|actors?|actress|singers?|faces?|portrait|fans|audience|pedestrians?|travell?ers?|passengers?|family|couple|chef|drivers?|pilots?|soldiers?|police|guests?|visitors?|students?|he|she|his|her|him|they're)\b/i;

export function peopleIn(text: string): string | null {
  const m = PEOPLE.exec(text);
  return m ? m[0] : null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type Candidate = Signal & { n: number };

/** Unsafe and recently-made topics removed, numbered for the model. */
export function shortlist(signals: Signal[], recentTopics: string[], max = 24): { candidates: Candidate[]; dropped: { title: string; why: string }[] } {
  const recent = recentTopics.map(norm).filter(Boolean);
  const seen = new Set<string>();
  const dropped: { title: string; why: string }[] = [];
  const kept: Signal[] = [];
  for (const s of signals) {
    const key = norm(s.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const unsafe = unsafeReason(`${s.title} ${s.detail ?? ""}`);
    if (unsafe) {
      dropped.push({ title: s.title, why: unsafe });
      continue;
    }
    if (recent.some((r) => r === key || (r.length > 4 && (key.includes(r) || r.includes(key))))) {
      dropped.push({ title: s.title, why: "made recently" });
      continue;
    }
    kept.push(s);
  }
  // Interleave sources so one long feed cannot crowd the others out of the list.
  const bySource = new Map<string, Signal[]>();
  for (const s of kept) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);
  const lists = [...bySource.values()];
  const out: Signal[] = [];
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < max) out.push(l[i]);
  return { candidates: out.map((s, i) => ({ ...s, n: i + 1 })), dropped };
}

export type Ranked = Candidate & { score: number; subject: string };

/**
 * Score every candidate for how good a people-free clip it can become, in one
 * plain JSON call. Without this the 7B took candidate #1 whatever it was (the
 * first live run: a TSA staffing rule). The research loop then only sees the
 * best few, in order, each with the subject the ranker had in mind.
 */
export async function rankCandidates(candidates: Candidate[], model: string, trace: AgentTrace, signal?: AbortSignal): Promise<Ranked[]> {
  // Titles with a short hint only: with the full news line attached, the 7B
  // anchored on the person in the headline and scored a whole night's list 0.
  const list = candidates.map((c) => `${c.n}. ${c.title}${c.detail ? ` (${c.detail.replace(/^news: /, "").slice(0, 90)})` : ""}`).join("\n");
  const prompt = [
    "Rate each topic for a 5-second silent video clip. The clip may NOT show any person, so think of the PLACE, OBJECT, NATURE or MOOD that evokes the topic.",
    "3 = the topic itself is visual without people: a sky or space event, a season, weather, a landscape or city, nature, animals, food, a festival's lights, a launch, a machine",
    "2 = shown well through a place or object: a sports event → the empty stadium or rink under floodlights; a new phone → the device on a table; a film → its setting",
    "1 = abstract, it would need words to explain",
    "0 = it only makes sense by showing a specific person, or it is news about politics, crime, lawsuits, business deals or conflict",
    'Examples: "NHL schedule" → 2, an ice rink under arena lights. "Harvest moon" → 3, the moon rising over fields. "Kate Upton" → 0, a person. "Senate vote" → 0, politics.',
    "",
    list,
    "",
    'Reply with JSON only: [{"n": 1, "score": 0, "subject": "what the clip would show, in a few words, with no people"}, ...] — one entry per topic.',
  ].join("\n");
  try {
    const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Source": "video-forge" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 1800 }),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    trace.promptTokens += body.usage?.prompt_tokens ?? 0;
    trace.completionTokens += body.usage?.completion_tokens ?? 0;
    const text = body.choices?.[0]?.message?.content ?? "";
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const rows = JSON.parse(json) as { n?: number; score?: number; subject?: string }[];
    const byN = new Map(rows.map((r) => [Number(r.n), r]));
    const ranked = candidates
      .map((c) => ({ ...c, score: Number(byN.get(c.n)?.score ?? 0), subject: String(byN.get(c.n)?.subject ?? "") }))
      .filter((c) => c.score >= 2 && !peopleIn(c.subject));
    ranked.sort((a, b) => b.score - a.score || a.n - b.n);
    const scored = rows.length;
    trace.calls.push({
      name: "rank",
      args: { candidates: candidates.length },
      ok: scored > 0,
      ms: 0,
      summary: ranked.length
        ? `${ranked.length} of ${scored} scored 2+: ${ranked.slice(0, 5).map((r) => `${r.title} (${r.score})`).join(", ")}`
        : `none of ${scored} scored 2+ — ${text.slice(0, 600)}`,
    });
    return ranked;
  } catch (err) {
    // Ranking is an improvement, not a requirement: fall back to the list as heard.
    trace.calls.push({ name: "rank", args: {}, ok: false, ms: 0, summary: `ranking failed (${err instanceof Error ? err.message : err}); using the list as heard` });
    return candidates.map((c) => ({ ...c, score: 0, subject: "" }));
  }
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Search the web. Returns titles, URLs and snippets. Use it to learn why a topic is in the news right now.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read the text of one web page (the first ~2500 characters). Only for a URL you got from the list or from search.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_brief",
      description: "Finish: submit the brief for the clip.",
      parameters: {
        type: "object",
        properties: {
          candidate: { type: "integer", description: "The number of the candidate you chose." },
          topic: { type: "string", description: "The topic in a few words." },
          why_now: { type: "string", description: "One or two sentences: why people care about it right now, from what you found." },
          sources: { type: "array", items: { type: "string" }, description: "URLs you actually saw that support why_now." },
          still_prompt: {
            type: "string",
            description:
              "The clip's first frame, for an image model: subject, setting, time of day, light, lens, colour, mood. 40-80 words. No people, no text, no logos.",
          },
          motion_prompt: {
            type: "string",
            description: "What moves during the 5 seconds and how the camera moves (e.g. slow push-in, drifting clouds, rippling water). 20-50 words.",
          },
        },
        required: ["candidate", "topic", "why_now", "still_prompt", "motion_prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skip",
      description: "Finish without a brief: no candidate can become a good, safe clip.",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
  },
];

function systemPrompt(channel: ChannelSpec): string {
  return [
    `You research topics for a short-video channel called "${channel.label}": ${channel.description}`,
    "Each time, you pick ONE topic from a list of what people are searching for and reading right now, find out why it matters now, and write a brief for a 5-second silent video clip made by an AI video model from a still image.",
    "",
    "Hard rules for the clip:",
    "- No real people. Never show or name a real, identifiable person, face or likeness. Show the place, the object, the season, the phenomenon or the mood instead.",
    "- No logos, brands, trademarked characters, team kits, and no text or lettering in the frame.",
    "- Never about death, violence, war, crime, disasters, accidents, illness, politics or anything sexual. If unsure, pick another candidate.",
    "- One continuous shot, 16:9, cinematic and beautiful. Prefer candidates that are VISUAL: nature, sky and space, seasons, places, festivals, food, animals, sport venues, technology objects.",
    "",
    "Steps: choose the best candidate; call search (and read if a snippet is not enough) at most 3 times to learn why it is current; then call submit_brief. If nothing works, call skip. Always finish with submit_brief or skip.",
  ].join("\n");
}

function userPrompt(candidates: (Candidate & { subject?: string })[], recent: string[], reviews: ReviewMemory[], now: Date): string {
  const lines = candidates.map((c) => {
    const w = c.weight ? ` (${c.source === "google-trends" ? `${c.weight.toLocaleString("en-US")}+ searches` : c.source === "wikipedia" ? `${c.weight.toLocaleString("en-US")} views` : `${c.weight} points`})` : "";
    return `${c.n}. [${c.source}]${w} ${c.title}${c.detail ? ` — ${c.detail}` : ""}${c.url ? ` <${c.url}>` : ""}${c.subject ? `
   clip idea: ${c.subject}` : ""}`;
  });
  const parts = [`It is ${now.toUTCString()}.`, "", "Candidates, best first — take the first one that works:", ...lines];
  if (recent.length) parts.push("", `Already made recently (do not repeat): ${recent.slice(0, 20).join("; ")}`);
  const liked = reviews.filter((r) => r.verdict === "approved").slice(0, 8);
  const disliked = reviews.filter((r) => r.verdict === "rejected").slice(0, 8);
  if (liked.length || disliked.length) {
    parts.push("", "The channel owner's reviews of earlier clips — do more of what was approved, avoid what was rejected:");
    for (const r of liked) parts.push(`+ approved: ${r.topic}${r.reason ? ` (${r.reason})` : ""}`);
    for (const r of disliked) parts.push(`- rejected: ${r.topic}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  return parts.join("\n");
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type RawToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** vLLM's hermes parser occasionally leaves a call in the content; recover it. */
function callsFromContent(content: string | null): RawToolCall[] {
  if (!content) return [];
  const out: RawToolCall[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try {
      const j = JSON.parse(m[1]) as { name?: string; arguments?: unknown };
      if (j.name) out.push({ id: `c${out.length}`, type: "function", function: { name: j.name, arguments: JSON.stringify(j.arguments ?? {}) } });
    } catch {
      // not a call
    }
  }
  return out;
}

export async function writeBrief(input: {
  channel: ChannelSpec;
  candidates: Candidate[];
  recent: string[];
  reviews: ReviewMemory[];
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  now?: Date;
}): Promise<AgentOutcome> {
  const model = input.model ?? "local-small";
  const t0 = Date.now();
  const trace: AgentTrace = { model, turns: 0, calls: [], latencyMs: 0, promptTokens: 0, completionTokens: 0 };
  const done = <T extends AgentOutcome>(o: T): T => ((trace.latencyMs = Date.now() - t0), o);
  if (!input.candidates.length) return done({ kind: "skip", reason: "Nothing on the list survived the safety and repeat filters.", trace });

  const ranked = await rankCandidates(input.candidates, model, trace, input.signal);
  const pool = ranked.slice(0, 6);
  if (!pool.length) return done({ kind: "skip", reason: "No candidate today can be shown without people or without being news about conflict, crime or politics.", trace });

  const seenUrls = new Set(input.candidates.map((c) => c.url).filter(Boolean) as string[]);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(input.channel) },
    { role: "user", content: userPrompt(pool, input.recent, input.reviews, input.now ?? new Date()) },
  ];
  const maxTurns = input.maxTurns ?? 7;

  for (let turn = 1; turn <= maxTurns; turn++) {
    trace.turns = turn;
    if (turn === maxTurns - 1) messages.push({ role: "user", content: "Time is up: call submit_brief now with what you have, or skip." });
    let body: {
      choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string } | string;
    };
    try {
      const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": "video-forge" },
        body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.4, max_tokens: 900 }),
        signal: input.signal ?? AbortSignal.timeout(120_000),
      });
      body = await res.json();
      if (!res.ok) {
        const msg = typeof body.error === "string" ? body.error : body.error?.message;
        return done({ kind: "error", error: `${model} answered HTTP ${res.status}: ${(msg ?? "").slice(0, 300)}`, trace });
      }
    } catch (err) {
      return done({ kind: "error", error: `${model} unreachable: ${err instanceof Error ? err.message : err}`, trace });
    }
    trace.promptTokens += body.usage?.prompt_tokens ?? 0;
    trace.completionTokens += body.usage?.completion_tokens ?? 0;
    const msg = body.choices?.[0]?.message ?? {};
    const calls = msg.tool_calls?.length ? msg.tool_calls : callsFromContent(msg.content ?? null);
    if (!calls.length) {
      messages.push({ role: "assistant", content: msg.content ?? "" });
      messages.push({ role: "user", content: "Use the tools: search/read to research, then submit_brief or skip." });
      continue;
    }
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const started = Date.now();
      const name = call.function.name;

      if (name === "submit_brief") {
        const n = Number(args.candidate);
        const chosen = input.candidates.find((c) => c.n === n);
        const topic = String(args.topic ?? "").trim();
        const still = String(args.still_prompt ?? "").trim();
        const motion = String(args.motion_prompt ?? "").trim();
        const why = String(args.why_now ?? "").trim();
        const problems: string[] = [];
        if (!topic || still.length < 30 || motion.length < 10 || !why) problems.push("topic, why_now, still_prompt (40-80 words) and motion_prompt are all required");
        const unsafe = unsafeReason(`${topic} ${still} ${motion}`);
        if (unsafe) problems.push(`the brief ${unsafe}, which this channel does not make clips about — pick another candidate`);
        const person = peopleIn(`${still} ${motion}`);
        if (person) problems.push(`the prompts show people ("${person}") — rewrite still_prompt and motion_prompt to show only the place, objects, light and nature, with no human figures at all`);
        if (problems.length && turn < maxTurns) {
          trace.calls.push({ name, args, ok: false, ms: Date.now() - started, summary: problems.join("; ") });
          messages.push({ role: "tool", tool_call_id: call.id, content: `Not accepted: ${problems.join("; ")}.` });
          continue;
        }
        if (problems.length) return done({ kind: "error", error: `Last brief was not usable: ${problems.join("; ")}`, trace });
        // A source must be something it actually saw — a 7B will otherwise
        // invent a plausible URL to satisfy the schema.
        const cited = (Array.isArray(args.sources) ? args.sources : []).map(String).filter((u) => seenUrls.has(u));
        const sources = [...new Set([...(chosen?.url ? [chosen.url] : []), ...cited])].slice(0, 5).map((url) => ({ url }));
        trace.calls.push({ name, args, ok: true, ms: 0, summary: topic });
        return done({
          kind: "brief",
          brief: { topic, whyNow: why, heard: chosen ? `${chosen.title} (${chosen.source})` : topic, sources, stillPrompt: still, motionPrompt: motion },
          trace,
        });
      }

      if (name === "skip") {
        trace.calls.push({ name, args, ok: true, ms: 0, summary: String(args.reason ?? "") });
        return done({ kind: "skip", reason: String(args.reason ?? "no reason given"), trace });
      }

      let result: string;
      let ok = true;
      try {
        if (name === "search") {
          const q = String(args.query ?? "").slice(0, 200);
          const { engine, hits } = await webSearch(q, 6);
          hits.forEach((h) => seenUrls.add(h.url));
          result = hits.length ? hits.map((h, i) => `${i + 1}. ${h.title} <${h.url}>\n   ${h.snippet}`).join("\n") : "No results.";
          trace.calls.push({ name, args, ok, ms: Date.now() - started, summary: `${hits.length} results via ${engine}` });
        } else if (name === "read") {
          const page = await readPage(String(args.url ?? ""), 2500);
          seenUrls.add(page.url);
          result = `${page.title}\n${page.text}`;
          trace.calls.push({ name, args, ok, ms: Date.now() - started, summary: page.title || page.url });
        } else {
          ok = false;
          result = `Unknown tool ${name}. Use search, read, submit_brief or skip.`;
          trace.calls.push({ name, args, ok, ms: 0, summary: "unknown tool" });
        }
      } catch (err) {
        ok = false;
        result = `Failed: ${err instanceof Error ? err.message : err}`;
        trace.calls.push({ name, args, ok, ms: Date.now() - started, summary: result });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 3000) });
    }
  }
  return done({ kind: "error", error: `No brief after ${maxTurns} turns`, trace });
}
