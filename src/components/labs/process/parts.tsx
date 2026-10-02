"use client";

import { Fragment, type ReactNode } from "react";
import { ACTOR, KIND_STYLE, fmtCost, fmtMs, type Decision, type Guide, type StoryEntry } from "./api";

/**
 * Small pieces the Process Lab's screens share. Colours here are fixed hex on
 * purpose: the console theme maps Tailwind's sky, cyan, violet, purple and blue
 * families to accent-derived hues, so they can't carry a fixed meaning.
 */

/** **bold** in the lab's sentences → <b>. Nothing else is interpreted. */
export function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith("**") ? <b key={i} className="font-semibold text-gray-50">{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
}

/** Who acted, as a small coloured tag. A person is "You" when it's you. */
export function ActorBadge({ kind, by }: { kind: string; by?: "you" | "consultant" }) {
  const a = ACTOR[kind] ?? ACTOR.agency;
  const label = kind === "person" ? (by === "consultant" ? "Consultant" : "You") : a.label;
  return (
    <span
      className="inline-block w-[5.5rem] shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-center text-[10px] font-medium"
      style={{ borderColor: `${a.hex}99`, color: a.hex, background: `${a.hex}14` }}
      title={a.explain}
    >
      {label}
    </span>
  );
}

/** The key to the tags, for "Who's who?". */
export function ActorKey() {
  return (
    <ul className="grid gap-1.5 rounded-lg border border-gray-800 bg-gray-950/60 p-3 sm:grid-cols-2">
      {["client", "ai", "rules", "person", "agency", "authority", "wait", "end"].map((k) => (
        <li key={k} className="flex items-start gap-2 text-[12px] text-gray-400">
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

/** A folded section for the detail most people don't need. */
export function Fold({ title, hint, children, open = false }: { title: string; hint?: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="group rounded-lg border border-gray-800" open={open}>
      <summary className="cursor-pointer px-3 py-2 text-sm text-gray-200">
        {title} {hint && <span className="ml-1 text-[11px] text-gray-500">— {hint}</span>}
      </summary>
      <div className="border-t border-gray-800 p-3">{children}</div>
    </details>
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

/** The builder's tag for a kind of decision, on the diagram and in the decision table. */
export function KindBadge({ kind }: { kind: string }) {
  const k = KIND_STYLE[kind as keyof typeof KIND_STYLE] ?? KIND_STYLE.system;
  return (
    <span className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: k.hex, color: k.hex, background: `${k.hex}1f` }}>
      {k.label}
    </span>
  );
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
                  {handedTo && <span className="mr-1 rounded bg-amber-950 px-1.5 py-0.5 text-amber-300">{handedTo}</span>}
                  {x.overridden && <span className="mr-1 rounded bg-red-950 px-1.5 py-0.5 text-red-300">overridden</span>}
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
