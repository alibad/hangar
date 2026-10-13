/**
 * The labelled sets in experiments/decide/sets/*.json, and how an item becomes
 * the `context` of a decision. Shared by scripts/decide-bench.mjs and the
 * Decision Lab's presets so both ask exactly the same question. Pure.
 */

export type SetItem = {
  id: string;
  label: string;
  context?: string;
  note?: string;
  // reddit-relevance items carry the fields reddit-scout's heuristic scores.
  product?: string;
  subreddit?: string;
  title?: string;
  body?: string;
  comments?: number;
  upvotes?: number;
};

export type LabelledSet = {
  id: string;
  title: string;
  question: string;
  type: "choice" | "yesno" | "score";
  choices: Record<string, string>;
  products?: Record<string, string>;
  items: SetItem[];
};

export function itemContext(set: Pick<LabelledSet, "products">, item: SetItem): string {
  if (item.context) return item.context;
  const product = item.product ? set.products?.[item.product] ?? item.product : "";
  return [
    product && `Product: ${product}`,
    item.subreddit && `Subreddit: r/${item.subreddit}`,
    item.title && `Post title: ${item.title}`,
    item.body && `Post body: ${item.body}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Choices as the editable text the Lab shows: one "label: description" per line. */
export function choicesToText(choices: Record<string, string>): string {
  return Object.entries(choices)
    .map(([k, v]) => (v && v !== k ? `${k}: ${v}` : k))
    .join("\n");
}

export function textToChoices(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    const label = (i > 0 ? t.slice(0, i) : t).trim();
    const desc = i > 0 ? t.slice(i + 1).trim() : "";
    if (label) out[label] = desc || label;
  }
  return out;
}
