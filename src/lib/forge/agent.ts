import { routerUrl } from "../providers";
import { readPage, webSearch } from "./sources";
import { brandIn, peopleIn, unsafeReason, writingIn, type Candidate } from "./rules";

export { shortlist, type Candidate } from "./rules";

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

export type Ranked = Candidate & { score: number; subject: string };

/**
 * Ask, per candidate, whether it can become a good clip without people — one
 * tiny JSON question each, in parallel (vLLM batches them; ~1-2 s for 24).
 *
 * Why not one call for the whole list: the 7B did that inconsistently — an
 * "ice hockey rink" idea scored 0, whole lists scored 0, and twice the reply
 * had no JSON at all, which let a list with people's names through unranked
 * (an NFL player became a brief). A small question per topic is the shape a
 * 7B answers reliably, and a named person is asked about explicitly.
 */
async function judgeOne(c: Candidate, model: string, signal?: AbortSignal): Promise<{ person: boolean; risky: boolean; visual: number; subject: string; tokens: [number, number] } | null> {
  const prompt = [
    `Topic trending today: "${c.title}"${c.detail ? ` (${c.detail.replace(/^news: /, "").slice(0, 100)})` : ""}`,
    "",
    "We make a 5-second silent video clip that evokes a topic WITHOUT showing any person and without any text on screen.",
    "Answer three things:",
    '- "person": true if the topic is a specific real person (an athlete, a celebrity, a politician, a named individual), else false.',
    '- "visual": 3 if the topic itself is visual without people (sky, space, season, weather, landscape, city, nature, animals, food, festival lights, a launch, a machine); 2 if a place or object evokes it well (a sports event: the empty stadium or rink under floodlights; a new phone: the device on a table); 1 if it is abstract; 0 if it is news about politics, crime, lawsuits, business or conflict.',
    '- "risky": true if the topic is news about crime, drugs, a court case, an accident or emergency, a disaster, conflict, politics, a company in trouble, a hack, a medicine, or money, prices and markets (which only show as symbols and numbers); else false.',
    '- "subject": what the clip would show, in a few words, with no people.',
    'Reply with JSON only, e.g. {"person": false, "visual": 2, "risky": false, "subject": "an ice rink under arena lights"}',
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": "video-forge" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 120 }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const text = body.choices?.[0]?.message?.content ?? "";
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) continue;
      const j = JSON.parse(m[0]) as { person?: unknown; risky?: unknown; visual?: unknown; subject?: unknown };
      return {
        person: j.person === true || j.person === "true",
        risky: j.risky === true || j.risky === "true",
        visual: Math.max(0, Math.min(3, Number(j.visual) || 0)),
        subject: String(j.subject ?? ""),
        tokens: [body.usage?.prompt_tokens ?? 0, body.usage?.completion_tokens ?? 0],
      };
    } catch {
      // retry once
    }
  }
  return null;
}

export async function rankCandidates(candidates: Candidate[], model: string, trace: AgentTrace, signal?: AbortSignal): Promise<Ranked[]> {
  const started = Date.now();
  const judged: (Awaited<ReturnType<typeof judgeOne>>)[] = new Array(candidates.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, candidates.length) }, async () => {
      for (let i = next++; i < candidates.length; i = next++) judged[i] = await judgeOne(candidates[i], model, signal);
    }),
  );
  let answered = 0;
  const ranked: Ranked[] = [];
  const people: string[] = [];
  const risky: string[] = [];
  judged.forEach((j, i) => {
    if (!j) return;
    answered++;
    trace.promptTokens += j.tokens[0];
    trace.completionTokens += j.tokens[1];
    if (j.person || peopleIn(j.subject) || writingIn(j.subject)) {
      if (j.person) people.push(candidates[i].title);
      return;
    }
    // A 7B let a cocaine court case and a hijack alert through on "visual" alone.
    if (j.risky) {
      risky.push(candidates[i].title);
      return;
    }
    if (j.visual >= 2) ranked.push({ ...candidates[i], score: j.visual, subject: j.subject });
  });
  ranked.sort((a, b) => b.score - a.score || a.n - b.n);
  trace.calls.push({
    name: "rank",
    args: { candidates: candidates.length },
    ok: answered > 0,
    ms: Date.now() - started,
    summary:
      `${answered}/${candidates.length} judged; ${ranked.length} can be shown without people` +
      (ranked.length ? `: ${ranked.slice(0, 5).map((r) => `${r.title} (${r.score}: ${r.subject})`).join("; ")}` : "") +
      (people.length ? `. People, skipped: ${people.slice(0, 6).join(", ")}` : "") +
      (risky.length ? `. Risky news, skipped: ${risky.slice(0, 6).join(", ")}` : ""),
  });
  // No fallback to the unjudged list: an unranked list is exactly how a
  // person's name reached a brief. Nothing judged means nothing made this time.
  return ranked;
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

/**
 * A second shot of the same topic: the same place and moment from another
 * distance (wide → close detail, or close → wide), same light and palette, so
 * the two cut together like an establishing shot and its detail. Two shots per
 * topic doubles what a day's trends can feed and gives a reel short sequences
 * instead of ten unrelated cuts. Held to the same rules as the first shot.
 */
/** Share of shot 2's words that already appear in shot 1 (0 … 1). */
function overlap(a: string, b: string): number {
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const A = words(a);
  const B = words(b);
  if (!A.size) return 1;
  let same = 0;
  for (const w of A) if (B.has(w)) same++;
  return same / A.size;
}

export async function writeSecondShot(input: { brief: Brief; model?: string }): Promise<{ stillPrompt: string; motionPrompt: string } | { error: string }> {
  const model = input.model ?? "local-small";
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = [
      `A short video reel shows the topic "${input.brief.topic}" in two consecutive shots. Shot 1:`,
      `First frame: ${input.brief.stillPrompt}`,
      `Motion: ${input.brief.motionPrompt}`,
      "",
      "Write shot 2: a CLOSE-UP of one telling detail in that same scene — an object, a surface, a texture, a light — with the same light, time of day and colour palette, so the two cut together. Example: for an empty tennis court at dusk, a single ball resting on the white baseline, the net's shadow across it. Describe a NEW frame; do not repeat shot 1's wording.",
      "Rules: no people or human figures at all, no text, letters, signs, logos or brand names, nothing violent or sad. One continuous shot.",
      feedback,
      'Reply with JSON only: {"still_prompt": "40-80 words describing the first frame", "motion_prompt": "20-50 words: what moves and how the camera moves"}',
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const res = await fetch(`${routerUrl()}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source": "video-forge" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.6, max_tokens: 400 }),
        signal: AbortSignal.timeout(90_000),
      });
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content ?? "";
      const m = /\{[\s\S]*\}/.exec(text);
      const j = m ? (JSON.parse(m[0]) as { still_prompt?: string; motion_prompt?: string }) : {};
      const still = String(j.still_prompt ?? "").trim();
      const motion = String(j.motion_prompt ?? "").trim();
      const both = `${still} ${motion}`;
      const problem =
        still.length < 30 || motion.length < 10
          ? "both prompts are required"
          : overlap(still, input.brief.stillPrompt) > 0.55
          ? "shot 2's first frame repeats shot 1 — describe a close-up of one detail instead"
          : unsafeReason(both) ?? (peopleIn(both) ? `it shows people ("${peopleIn(both)}")` : null) ?? (writingIn(both) ? `it asks for writing ("${writingIn(both)}")` : null) ?? (brandIn(both) ? `it names "${brandIn(both)}"` : null);
      if (!problem) return { stillPrompt: still, motionPrompt: motion };
      feedback = `Your last answer was not usable: ${problem}. Fix that.`;
    } catch (err) {
      feedback = "";
      if (attempt === 3) return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { error: "no usable second shot in three tries" };
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
        const writing = writingIn(`${still} ${motion}`);
        if (writing) problems.push(`the prompts ask for writing on screen ("${writing}") — video models cannot render text or numbers; show the scene without any`);
        const brand = brandIn(`${still} ${motion}`);
        if (brand) problems.push(`the prompts name "${brand}" — a brand or acronym becomes a logo or lettering in the image; describe the object or place generically instead`);
        if (problems.length && turn < maxTurns) {
          trace.calls.push({ name, args, ok: false, ms: Date.now() - started, summary: problems.join("; ") });
          // A 7B that fails twice on one candidate tends to keep failing on it
          // (five refusals in a row on an airport checkpoint): move it on.
          const refusals = trace.calls.filter((c) => c.name === "submit_brief" && !c.ok && Number(c.args.candidate) === n).length;
          const moveOn = refusals >= 2 ? " This candidate is not working — take the NEXT candidate on the list and submit a brief for it." : "";
          messages.push({ role: "tool", tool_call_id: call.id, content: `Not accepted: ${problems.join("; ")}.${moveOn}` });
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
