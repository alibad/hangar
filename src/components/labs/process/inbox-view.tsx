"use client";

import { useCallback, useEffect, useState } from "react";
import { fileUrl, lab, type InboxItem } from "./api";

/**
 * The consultant's inbox: every open human task, with the AI's suggestion
 * beside the form. Completing a task records what the person decided and
 * whether it overrode the AI — the numbers on the Numbers tab come from here.
 */
export default function InboxView({ onDone }: { onDone?: () => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await lab<InboxItem[]>("api/inbox"));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(() => !document.hidden && load(), 4000);
    return () => clearInterval(iv);
  }, [load]);

  if (err) return <p className="text-xs text-red-300">{err}</p>;
  if (!items) return <p className="text-xs text-gray-500">Loading the inbox…</p>;
  if (!items.length)
    return (
      <p className="rounded-xl border border-gray-800 px-4 py-6 text-center text-sm text-gray-500">
        Nothing waiting for a person. Simulated runs with <b>simulated consultant</b> on clear their own tasks; turn it off to work them here.
      </p>
    );
  return (
    <div className="space-y-3">
      {items.map((t) => (
        <TaskCard key={t.id} t={t} onDone={() => { load(); onDone?.(); }} />
      ))}
    </div>
  );
}

function TaskCard({ t, onDone }: { t: InboxItem; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (body: unknown) => {
    setBusy(true);
    setErr(null);
    try {
      await lab(`api/tasks/${t.id}/complete`, { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-100">
          {t.name} <span className="font-mono text-xs font-normal text-gray-500">{t.caseKey}</span>
          {t.simulated && <span className="ml-2 rounded bg-gray-800 px-1.5 text-[10px] font-normal text-gray-400">simulated case</span>}
        </h3>
        <span className="text-[11px] text-gray-500">waiting since {new Date(t.created).toLocaleTimeString()}</span>
      </header>
      <p className="mb-3 text-xs text-gray-400">
        {t.client.name} · {t.client.passport} passport → {t.client.destination} · writes in {t.client.language}
        <span dir="auto" className="mt-1 block text-gray-300">&ldquo;{t.client.request}&rdquo;</span>
      </p>
      {t.key === "confirm_type" && <ConfirmType t={t} busy={busy} submit={submit} />}
      {t.key === "verify_documents" && <VerifyDocuments t={t} busy={busy} submit={submit} />}
      {t.key === "approve_submission" && <Approve t={t} busy={busy} submit={submit} />}
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
    </article>
  );
}

const btn = "rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50";

function ConfirmType({ t, busy, submit }: { t: InboxItem; busy: boolean; submit: (b: unknown) => void }) {
  const [service, setService] = useState(t.ai?.service && t.ai.service !== "unclear" ? t.ai.service : "");
  const [purpose, setPurpose] = useState(t.ai?.purpose ?? "");
  const probs = Object.entries(t.ai?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="text-xs">
        <p className="mb-1 text-gray-500">
          {t.ai?.model ?? "The decision model"} was not sure (confidence {t.ai?.confidence?.toFixed(2) ?? "?"}):
        </p>
        {probs.map(([k, p]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="w-44 truncate text-gray-300">{k}</span>
            <span className="h-1.5 flex-1 rounded bg-gray-800">
              <span className="block h-1.5 rounded bg-violet-500" style={{ width: `${Math.round(p * 100)}%` }} />
            </span>
            <span className="w-10 text-right tabular-nums text-gray-400">{(p * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
      <div className="space-y-2 text-xs">
        <label className="block text-gray-400">
          Service
          <select value={service} onChange={(e) => setService(e.target.value)} className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200">
            <option value="">choose…</option>
            {t.choices?.services.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        {service === "residency-permit" && (
          <label className="block text-gray-400">
            Purpose
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)} className="mt-1 block w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200">
              <option value="">choose…</option>
              {t.choices?.purposes.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
        )}
        <button
          disabled={busy || !service || (service === "residency-permit" && !purpose)}
          onClick={() => submit({ service, purpose: service === "residency-permit" ? purpose : null })}
          className={`${btn} border-orange-600 bg-orange-600/20 text-orange-200`}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

const FIELDS = ["docType", "language", "issuingCountry", "dateOfBirth", "monthlyIncome", "currency"] as const;

function VerifyDocuments({ t, busy, submit }: { t: InboxItem; busy: boolean; submit: (b: unknown) => void }) {
  const flagged = (t.documents ?? []).filter((d) => d.flagged || !d.accepted);
  const [edits, setEdits] = useState<Record<number, Record<string, string>>>(() =>
    Object.fromEntries(flagged.map((d) => [d.id, Object.fromEntries(FIELDS.map((f) => [f, d.extraction?.[f] == null ? "" : String(d.extraction[f])]))])),
  );
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">The reader was not confident about these. Check each against the image and correct what is wrong.</p>
      {flagged.map((d) => (
        <div key={d.id} className="grid gap-3 rounded-lg border border-gray-800 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <a href={fileUrl(d.url)} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(d.url)} alt={`document ${d.id}`} className="w-full rounded border border-gray-800" />
          </a>
          <div className="space-y-1.5 text-xs">
            <p className="text-gray-500">
              #{d.id} · {d.problem ?? "flagged"} · reader confidence {String(d.extraction?.confidence ?? "?")}
            </p>
            {FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-gray-400">
                <span className="w-28">{f}</span>
                {f === "docType" ? (
                  <select
                    value={edits[d.id]?.[f] ?? ""}
                    onChange={(e) => setEdits({ ...edits, [d.id]: { ...edits[d.id], [f]: e.target.value } })}
                    className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200"
                  >
                    {Object.keys(t.docTypes ?? {}).map((k) => <option key={k}>{k}</option>)}
                  </select>
                ) : (
                  <input
                    value={edits[d.id]?.[f] ?? ""}
                    onChange={(e) => setEdits({ ...edits, [d.id]: { ...edits[d.id], [f]: e.target.value } })}
                    className="flex-1 rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200"
                  />
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
              return {
                id: d.id,
                ...Object.fromEntries(FIELDS.filter((f) => e[f] !== "").map((f) => [f, f === "monthlyIncome" ? Number(e[f]) : e[f]])),
              };
            }),
          })
        }
        className={`${btn} border-orange-600 bg-orange-600/20 text-orange-200`}
      >
        Save verified readings
      </button>
    </div>
  );
}

function Approve({ t, busy, submit }: { t: InboxItem; busy: boolean; submit: (b: unknown) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2 text-xs">
        <p>
          <span className="text-gray-500">Eligibility (DMN): </span>
          <span className="text-sky-300">{t.eligibility?.outcome}</span>
          <span className="text-gray-400"> — {t.eligibility?.reason}</span>
          {t.eligibility?.route && <span className="block text-gray-500">route: {t.eligibility.route}</span>}
        </p>
        <p className="text-gray-300">
          <span className="text-gray-500">AI brief: </span>
          {t.ai?.summary}
        </p>
        <p>
          <span className="text-gray-500">AI recommends: </span>
          <b className={t.ai?.recommendation === "submit" ? "text-emerald-300" : "text-amber-300"}>{t.ai?.recommendation}</b>
        </p>
        {!!t.ai?.reasons?.length && (
          <ul className="list-disc pl-4 text-gray-400">
            {t.ai.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {t.documents?.map((d) => (
            <a key={d.id} href={fileUrl(d.url)} target="_blank" rel="noreferrer" className={`rounded border px-1.5 py-0.5 text-[10px] ${d.accepted ? "border-emerald-800 text-emerald-300" : "border-amber-800 text-amber-300"}`}>
              {d.type ?? `#${d.id}`}
            </a>
          ))}
        </div>
      </div>
      <div className="space-y-2 text-xs">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Note (optional) — why, especially if you disagree with the AI"
          className="w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200"
        />
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => submit({ approved: true, note })} className={`${btn} border-emerald-600 bg-emerald-600/20 text-emerald-200`}>
            Approve and submit
          </button>
          <button disabled={busy} onClick={() => submit({ approved: false, note })} className={`${btn} border-gray-600 text-gray-300`}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
