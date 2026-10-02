"use client";

import { useCallback, useEffect, useState } from "react";
import { fileUrl, lab, type InboxItem } from "./api";

/**
 * "Your turn": the question a case is waiting for you to answer, asked inside
 * the case, in plain words. Three kinds:
 *  • what does the client want? (the AI wasn't sure)
 *  • what does this document say? (the AI couldn't read it)
 *  • should we submit the application? (every application needs a person's OK)
 * Answering records what you decided and whether it went against the AI; the
 * Results tab counts those.
 */
export default function YourTurn({ caseKey, onDone }: { caseKey: string; onDone: () => void }) {
  const [task, setTask] = useState<InboxItem | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await lab<InboxItem[]>("api/inbox");
      setTask(all.find((t) => t.caseKey === caseKey) ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [caseKey]);
  useEffect(() => {
    load();
  }, [load]);

  const submit = async (body: unknown) => {
    if (!task) return;
    setBusy(true);
    setErr(null);
    try {
      await lab(`api/tasks/${task.id}/complete`, { method: "POST", body: JSON.stringify(body) });
      setDone(true);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) return <p className="rounded-lg border border-emerald-700/50 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-100">Thanks — the case carries on from here.</p>;
  if (task === undefined) return <p className="text-xs text-gray-500">Loading your question…</p>;
  if (!task) return null;
  const fn = task.people?.firstName ?? task.client.name;

  return (
    <section className="rounded-xl border border-amber-500/60 bg-amber-950/20 p-4">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300">Your turn</p>
      {task.key === "confirm_type" && <ChooseWant t={task} fn={fn} busy={busy} submit={submit} />}
      {task.key === "verify_documents" && <CheckDocuments t={task} fn={fn} busy={busy} submit={submit} />}
      {task.key === "approve_submission" && <Approve t={task} fn={fn} busy={busy} submit={submit} />}
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
    </section>
  );
}

const choice = "rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:opacity-50";

function ChooseWant({ t, fn, busy, submit }: { t: InboxItem; fn: string; busy: boolean; submit: (b: unknown) => void }) {
  const [service, setService] = useState<string | null>(null);
  const labels = t.labels?.services ?? {};
  const purposes = t.labels?.purposes ?? {};
  // The AI's best guesses, in order, without the numbers: "it thought maybe X or Y".
  const guesses = Object.entries(t.ai?.probabilities ?? {})
    .filter(([k]) => k !== "unclear")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => labels[k] ?? k);
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-gray-50">What does {fn} want help with?</h3>
      <blockquote dir="auto" className="border-l-2 border-amber-600/60 pl-3 text-sm text-gray-300">
        “{t.client.request}”
      </blockquote>
      <p className="text-xs text-gray-400">
        The AI couldn&apos;t tell{guesses.length ? <> — its best guesses were {guesses.map((g, i) => <b key={g} className="text-gray-200">{i ? " or " : ""}{g.toLowerCase()}</b>)}</> : null}. Pick one:
      </p>
      {!service || service !== "residency-permit" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          {(t.choices?.services ?? []).map((s) => (
            <button
              key={s}
              disabled={busy}
              onClick={() => (s === "residency-permit" ? setService(s) : submit({ service: s, purpose: null }))}
              className={`${choice} border-gray-700 bg-gray-900 text-gray-100 hover:border-amber-500`}
            >
              {labels[s] ?? s}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-200">
            A residency permit — for what?{" "}
            <button className="ml-2 text-xs text-gray-400 underline" onClick={() => setService(null)}>
              back
            </button>
          </p>
          <div className="grid gap-2 sm:grid-cols-4">
            {(t.choices?.purposes ?? []).map((p) => (
              <button key={p} disabled={busy} onClick={() => submit({ service, purpose: p })} className={`${choice} border-gray-700 bg-gray-900 text-gray-100 hover:border-amber-500`}>
                {cap(purposes[p] ?? p)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// What a person fills in for a document the AI couldn't read, in words.
const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "docType", label: "Kind of document" },
  { key: "language", label: "Language", hint: "en, ar, es, de…" },
  { key: "monthlyIncome", label: "Monthly income", hint: "a number, if it shows one" },
  { key: "currency", label: "Currency", hint: "EUR, USD, AED…" },
  { key: "issuingCountry", label: "Country that issued it", hint: "two letters, e.g. ES" },
  { key: "dateOfBirth", label: "Date of birth", hint: "YYYY-MM-DD, on an ID" },
];

function CheckDocuments({ t, fn, busy, submit }: { t: InboxItem; fn: string; busy: boolean; submit: (b: unknown) => void }) {
  const flagged = (t.documents ?? []).filter((d) => d.flagged || !d.accepted);
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>(() =>
    Object.fromEntries(flagged.map((d) => [d.id, Object.fromEntries(FIELDS.map((f) => [f.key, d.extraction?.[f.key] == null ? "" : String(d.extraction[f.key])]))])),
  );
  const set = (id: number, k: string, val: string) => setEdits({ ...edits, [id]: { ...edits[id], [k]: val } });
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-gray-50">What does {flagged.length === 1 ? "this document" : "each document"} say?</h3>
      <p className="text-xs text-gray-400">
        The AI couldn&apos;t read {flagged.length === 1 ? "it" : "them"} clearly, so it didn&apos;t guess. Look at {fn}&apos;s {flagged.length === 1 ? "document" : "documents"} and fill in what you can see; the AI&apos;s reading is filled in where it had one.
      </p>
      {flagged.map((d) => (
        <div key={d.id} className="grid gap-3 rounded-lg border border-gray-800 bg-gray-900/60 p-3 md:grid-cols-2">
          <a href={fileUrl(d.url)} target="_blank" rel="noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(d.url)} alt={`${fn}'s document`} className="max-h-80 w-full rounded border border-gray-800 object-contain" />
          </a>
          <div className="space-y-2 text-xs">
            {FIELDS.map((f) => (
              <label key={f.key} className="block text-gray-400">
                {f.label}
                {f.key === "docType" ? (
                  <select value={edits[d.id]?.[f.key] ?? ""} onChange={(e) => set(d.id, f.key, e.target.value)} className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200">
                    {Object.entries(t.docTypes ?? {}).map(([k, name]) => (
                      <option key={k} value={k}>
                        {name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={edits[d.id]?.[f.key] ?? ""} placeholder={f.hint} onChange={(e) => set(d.id, f.key, e.target.value)} className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200" />
                )}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          submit({
            documents: flagged.map((d) => {
              const e = edits[d.id] ?? {};
              return { id: d.id, ...Object.fromEntries(FIELDS.filter((f) => e[f.key] !== "").map((f) => [f.key, f.key === "monthlyIncome" ? Number(e[f.key]) : e[f.key]])) };
            }),
          })
        }
        className="rounded-lg border border-amber-500 bg-amber-500/20 px-4 py-2 text-sm font-medium text-amber-50 hover:bg-amber-500/30 disabled:opacity-50"
      >
        Save what it says
      </button>
    </div>
  );
}

function Approve({ t, fn, busy, submit }: { t: InboxItem; fn: string; busy: boolean; submit: (b: unknown) => void }) {
  const [note, setNote] = useState("");
  const [why, setWhy] = useState(false);
  const out = t.eligibility?.outcome;
  const rules =
    out === "eligible"
      ? { mark: "✓", cls: "text-emerald-300", text: `${fn} qualifies${t.eligibility?.route ? ` — ${t.eligibility.route}` : ""}.` }
      : out === "refer"
        ? { mark: "?", cls: "text-amber-300", text: "No written rule covers this case, so it's your judgement." }
        : out === "ineligible"
          ? { mark: "✗", cls: "text-red-300", text: `${fn} doesn't qualify: ${t.eligibility?.reason ?? ""}` }
          : { mark: "·", cls: "text-gray-300", text: t.eligibility?.reason ?? String(out ?? "") };
  const recommends = t.ai?.recommendation === "submit";
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-gray-50">Should we submit {fn}&apos;s application?</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">The rules say</p>
          <p className={`mt-1 ${rules.cls}`}>
            <span className="mr-1.5 font-bold">{rules.mark}</span>
            {rules.text}
          </p>
          {!!t.documents?.length && (
            <p className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
              <span className="text-gray-500">Documents:</span>
              {t.documents.map((d) => (
                <a key={d.id} href={fileUrl(d.url)} target="_blank" rel="noreferrer" className={`rounded border px-1.5 py-0.5 ${d.accepted ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>
                  {(d.type ?? "document").replace(/-/g, " ")}
                </a>
              ))}
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            The AI recommends <span className={recommends ? "text-emerald-300" : "text-amber-300"}>{recommends ? "submitting" : "not submitting"}</span>
          </p>
          <p className="mt-1 text-gray-300">{t.ai?.summary}</p>
          {!!t.ai?.reasons?.length && (
            <>
              <button className="mt-2 text-[11px] text-gray-400 underline" onClick={() => setWhy(!why)}>
                {why ? "Hide its reasons" : "Its reasons"}
              </button>
              {why && (
                <ul className="mt-1 list-disc pl-4 text-xs text-gray-400">
                  {t.ai.reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => submit({ approved: true, note })} className="rounded-lg border border-emerald-500 bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500/30 disabled:opacity-50">
          Yes, submit it
        </button>
        <button disabled={busy} onClick={() => submit({ approved: false, note })} className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:border-gray-400 disabled:opacity-50">
          No, don&apos;t submit
        </button>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (optional) — useful if you disagree with the AI"
          className="min-w-[16rem] flex-1 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-gray-200"
        />
      </div>
    </div>
  );
}
