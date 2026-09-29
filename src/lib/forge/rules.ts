import type { Signal } from "./sources";

/**
 * The Video Forge's rules, kept import-free (only `import type`) so
 * scripts/video-forge.test.mjs loads the exact module the console runs.
 */

/**
 * Topics a clip should not be made about, checked in code before the model sees
 * the list. Deliberately broad: a trending list is mostly news, and a
 * generated, realistic clip of a tragedy, a crime or a politician is exactly
 * what this box should never produce. A false positive costs one candidate.
 */
const UNSAFE =
  /\b(die[sd]?|dead|deaths?|dying|kill(s|ed|ing)?|murder\w*|shoot\w*|shot|gun\w*|war|wars|attack\w*|bomb\w*|explosion|crash\w*|collision|earthquake\w*|hurricane\w*|typhoon\w*|tornado\w*|flood\w*|wildfire\w*|blaze\w*|storm surge|arrest\w*|charged|trial|lawsuit|sued|sentenc\w*|prison|jail|police|election\w*|vote[sd]?|voting|ballot|president|senator|congress|parliament|minister|governor|campaign|protest\w*|riot\w*|israel\w*|gaza|palestin\w*|ukrain\w*|russia\w*|iran|hamas|abortion|porn\w*|sex\w*|nude|naked|onlyfans|suicide|overdose|cancer|disease|outbreak|virus|obituar\w*|funeral|terror\w*|hostage|victim\w*|injur\w*|missing|abuse\w*|scandal|layoffs?|recall)\b/i;

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

/** Writing on screen. Image and video models render it as gibberish, and a scoreboard of numbers was the second live brief. */
const WRITING = /\b(text|texts|words?|letters?|lettering|numbers|digits|headlines?|captions?|logos?|signs? (?:reading|saying|that says)|written|typography|scoreboard displaying|displaying the)\b/i;

export function writingIn(text: string): string | null {
  const m = WRITING.exec(text);
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


// ── the render window (local time) ─────────────────────────────────────────────

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Minutes left in the window, or null outside it. Handles windows that cross midnight. */
export function windowMinutesLeft(win: { start: string; end: string }, at = new Date()): number | null {
  const now = at.getHours() * 60 + at.getMinutes();
  const s = minutesOf(win.start);
  const e = minutesOf(win.end);
  const inside = s <= e ? now >= s && now < e : now >= s || now < e;
  if (!inside) return null;
  return (e - now + 1440) % 1440 || 1440;
}

export function nextWindowStart(win: { start: string }, at = new Date()): Date {
  const d = new Date(at);
  const s = minutesOf(win.start);
  d.setHours(Math.floor(s / 60), s % 60, 0, 0);
  if (d <= at) d.setDate(d.getDate() + 1);
  return d;
}

