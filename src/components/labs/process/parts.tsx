"use client";

import { Fragment, type ReactNode } from "react";
import { ACTOR, fmtCost, fmtMs, type Decision, type Guide, type StoryEntry } from "./api";

/**
 * Small pieces the Process Lab's screens share.
 *
 * Colour rules, because the console has a light and a dark mode and themes:
 *  • greys (gray-*) flip between modes, so gray-100 is the main text in both;
 *  • the theme remaps sky, cyan, violet, purple, blue… to accent-derived hues,
 *    so they can't carry a fixed meaning;
 *  • a coloured *-50 text shade stays near-white in light mode — never use one.
 * Tags therefore carry their own light and dark colours, and buttons use the
 * theme's primary token (its accent, with near-black text in both modes).
 */

// The console's shared dialog and button looks; re-exported for the lab's screens.
export { default as Dialog, buttonStyles as btn } from "@/components/dialog";

/** **bold** in the lab's sentences → <b>. Nothing else is interpreted. */
export function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") ? <b key={i} className="font-semibold text-gray-100">{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

/** Each actor's tag colour, readable on a light page and on a dark one. */
const ACTOR_CLS: Record<string, string> = {
  client: "text-stone-600 border-stone-400 dark:text-stone-300 dark:border-stone-500",
  rules: "text-[#0369a1] border-[#0369a1]/50 dark:text-[#38bdf8] dark:border-[#38bdf8]/60",
  ai: "text-[#b45309] border-[#b45309]/50 dark:text-[#f59e0b] dark:border-[#f59e0b]/60",
  model: "text-[#6d28d9] border-[#6d28d9]/50 dark:text-[#a78bfa] dark:border-[#a78bfa]/60",
  person: "text-[#047857] border-[#047857]/50 dark:text-[#34d399] dark:border-[#34d399]/60",
  agency: "text-stone-500 border-stone-400 dark:text-stone-400 dark:border-stone-600",
  authority: "text-[#7e22ce] border-[#7e22ce]/50 dark:text-[#c084fc] dark:border-[#c084fc]/60",
  wait: "text-stone-500 border-stone-300 dark:text-stone-500 dark:border-stone-700",
  end: "text-[#c2410c] border-[#c2410c]/50 dark:text-[#fb923c] dark:border-[#fb923c]/60",
};
const tag = "inline-block shrink-0 whitespace-nowrap rounded-full border bg-current/[0.06] px-2 py-0.5 text-center text-[10px] font-medium";

/** Who acted, as a small coloured tag. A person is "You" when it's you. */
export function ActorBadge({ kind, by }: { kind: string; by?: "you" | "consultant" }) {
  const a = ACTOR[kind] ?? ACTOR.agency;
  const label = kind === "person" ? (by === "consultant" ? "Consultant" : "You") : a.label;
  return (
    <span className={`${tag} w-[5.5rem] ${ACTOR_CLS[kind] ?? ACTOR_CLS.agency}`} title={a.explain}>
      {label}
    </span>
  );
}

/** The key to the tags, for "Who's who?". */
export function ActorKey() {
  return (
    <ul className="grid gap-2.5">
      {["client", "ai", "rules", "person", "agency", "authority", "wait", "end"].map((k) => (
        <li key={k} className="flex items-start gap-3 text-sm text-gray-300">
          <ActorBadge kind={k} by="you" />
          <span>{ACTOR[k].explain}</span>
        </li>
      ))}
    </ul>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "md" | "lg" }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const cls = size === "lg" ? "size-11 text-base" : "size-8 text-xs";
  return (
    <span className={`${cls} grid shrink-0 place-items-center rounded-full border border-gray-700 bg-gray-800 font-semibold text-gray-200`} aria-hidden="true">
      {initials}
    </span>
  );
}

/** What a step on the diagram does, from the process file's own help text; with a case, what happened there. */
export function StepHelp({ id, guide, story }: { id: string | null; guide: Guide | null; story?: StoryEntry[] }) {
  if (!id) {
    return (
      <aside className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-xs text-gray-400">
        <p className="mb-2 font-medium text-gray-300">Reading the diagram</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>Each box is a step; the arrows are the order they happen in.</li>
          {story && (
            <li>
              <span className="text-orange-300">Orange</span> is where this case is now; <span className="text-emerald-300">green</span> is where it has been.
            </li>
          )}
          <li>The tag on a box says who does that step: rules, AI or a person.</li>
          <li>Diamonds are forks: the case goes one way or the other depending on an answer.</li>
          <li>Drag to move around, scroll to zoom. Click a step to see what it does.</li>
        </ul>
      </aside>
    );
  }
  const s = guide?.steps[id];
  const here = story?.filter((e) => e.activityId === id) ?? [];
  return (
    <aside className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-xs">
      <p className="text-sm font-semibold text-gray-100">{s?.name ?? id}</p>
      {s?.stage && <p className="mt-0.5 text-[11px] text-gray-500">Stage: {guide?.stages.find((x) => x.id === s.stage)?.label}</p>}
      <p className="mt-2 text-gray-300">{s?.doc ?? "No description for this step."}</p>
      {story && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">In this case</p>
          {here.length ? (
            <ul className="mt-1 space-y-1 text-gray-400">
              {here.map((e, i) => (
                <li key={i}>
                  Day {Math.round(e.day)}: {rich(e.text)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-gray-500">Nothing happened here in this case (not reached, or a fork that only routes).</p>
          )}
        </>
      )}
    </aside>
  );
}

/** The builder's tag for a kind of decision (decision table, step list), in the story's colours. */
const KIND_TAG: Record<string, [string, string]> = {
  dmn: ["Rules", "rules"],
  "decision-model": ["Decision model", "model"],
  llm: ["AI", "ai"],
  human: ["Person", "person"],
  system: ["Agency", "agency"],
};
export function KindBadge({ kind }: { kind: string }) {
  const [label, cls] = KIND_TAG[kind] ?? KIND_TAG.system;
  return <span className={`${tag} ${ACTOR_CLS[cls]}`}>{label}</span>;
}

/** Every decision on a case, with model, confidence, time and cost: the builder's view. */
export function DecisionTable({ decisions }: { decisions: Decision[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-gray-900/80 text-[11px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">Question → decided</th>
            <th className="px-3 py-2 text-right">Confidence</th>
            <th className="px-3 py-2 text-right">Took</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {decisions.map((x, i) => {
            const failedLocal = x.detail?.attempts?.filter((a) => !a.ok) ?? [];
            // A decision model's unsure answer goes to the LLM tier, not to a
            // person; only the final answer can hand a question to a person.
            const handedTo = x.escalated ? (x.detail?.escalatedTo === "llm" ? "to LLM" : "to a person") : null;
            return (
              <tr key={(x.id ?? "") + x.at + i} className={x.rootDecisionInstanceId ? "opacity-60" : ""}>
                <td className="px-3 py-2 align-top">
                  <KindBadge kind={x.kind} />
                </td>
                <td className="px-3 py-2 align-top">
                  <span className="text-gray-500">{x.question}</span>
                  <span className="block text-gray-200">{x.decided}</span>
                  {typeof x.detail?.summary === "string" && <span className="mt-1 block text-[11px] text-gray-400">{x.detail.summary}</span>}
                </td>
                <td className="px-3 py-2 text-right align-top tabular-nums text-gray-300">{x.confidence == null ? "—" : x.confidence.toFixed(2)}</td>
                <td className="px-3 py-2 text-right align-top tabular-nums text-gray-400">{fmtMs(x.latencyMs)}</td>
                <td className="px-3 py-2 align-top text-gray-400">
                  {x.model ?? (x.kind === "dmn" ? "engine" : "—")}
                  {x.provider === "cloud" && <span className="block text-[10px] text-gray-400">cloud · {fmtCost(x.costUsd, x.provider)}</span>}
                  {failedLocal.length > 0 && (
                    <span className="block text-[10px] text-amber-300" title={failedLocal.map((a) => `${a.model}: ${a.why}`).join("\n")}>
                      after {failedLocal.map((a) => a.model).join(", ")} failed
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-[10px]">
                  {handedTo && <span className="mr-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">{handedTo}</span>}
                  {x.overridden && <span className="mr-1 rounded bg-red-500/15 px-1.5 py-0.5 text-red-300">overridden</span>}
                  {x.correct === true && <span className="mr-1 text-emerald-400">✓ truth</span>}
                  {x.correct === false && <span className="mr-1 text-red-400">✗ truth</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "Day 12" — simulated days, rounded: a tenth of a day means nothing to anyone. */
export const dayLabel = (d: number) => `Day ${Math.round(d)}`;
