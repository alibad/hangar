"use client";

import { useState } from "react";
import { lab, type Overview } from "./api";

/**
 * Send in pretend clients. Each is made up, with a known right ending, so the
 * lab can check itself. Grouped by how their case will go, described in one
 * sentence each, and a "first time" pick of three that shows the most in a
 * few minutes. Speed, the pretend consultant and writing your own client are
 * under "More options".
 */
export default function SendClients({ overview, onSent, onCancel }: { overview: Overview; onSent: (runId: string) => void; onCancel: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [spd, setSpd] = useState(3);
  const [autoHuman, setAutoHuman] = useState(false);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setPicked(n);
  };
  const send = async (ids: string[]) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await lab<{ id: string }>("api/sim", { method: "POST", body: JSON.stringify({ scenarios: ids, secondsPerDay: spd, autoHuman, voiceUpdate: voice }) });
      onSent(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const groups = overview.scenarioGroups ?? [];
  const first = overview.firstTry ?? [];

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-gray-50">Send in pretend clients</h3>
          <p className="mt-1 max-w-2xl text-sm text-gray-400">
            Each one is made up — name, documents and all — and the lab knows how their case <i>should</i> end, so it can check itself. Pick one or a few.
          </p>
        </div>
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-gray-200">
          Cancel
        </button>
      </div>

      {first.length > 0 && (
        <button
          onClick={() => setPicked(new Set(first))}
          className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-500/50 bg-orange-950/20 px-4 py-3 text-left hover:bg-orange-950/30"
        >
          <span>
            <span className="block text-sm font-medium text-orange-100">First time? Try these three</span>
            <span className="block text-xs text-gray-400">
              {first.map((id) => overview.scenarios.find((s) => s.id === id)?.name).filter(Boolean).join(", ")} — one goes smoothly, one needs you to decide, one hits a snag. About five minutes.
            </span>
          </span>
          <span className="text-xs text-orange-200">Select them</span>
        </button>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g.id}>
            <h4 className="text-sm font-semibold text-gray-200">{g.label}</h4>
            <p className="mb-2 text-xs text-gray-500">{g.about}</p>
            <div className="space-y-2">
              {overview.scenarios
                .filter((s) => s.group === g.id)
                .map((s) => {
                  const on = picked.has(s.id);
                  return (
                    <button
                      key={s.id}
                      onClick={() => toggle(s.id)}
                      aria-pressed={on}
                      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-orange-500 bg-orange-500/10" : "border-gray-800 bg-gray-900/60 hover:border-gray-600"}`}
                    >
                      <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] ${on ? "border-orange-400 bg-orange-500 text-gray-950" : "border-gray-600"}`}>{on ? "✓" : ""}</span>
                      <span className="min-w-0">
                        <span className="block text-sm text-gray-100">
                          {s.name} <span className="text-xs text-gray-500">· {[s.from, s.to].filter(Boolean).join(" → ")}</span>
                        </span>
                        <span className="block text-xs text-gray-400">{s.teaser}</span>
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-gray-700 bg-gray-900/95 px-4 py-3 shadow-lg backdrop-blur">
        <button
          disabled={busy || !picked.size || !overview.engine.up}
          onClick={() => send([...picked])}
          className="rounded-lg border border-orange-500 bg-orange-500/25 px-4 py-2 text-sm font-medium text-orange-50 hover:bg-orange-500/35 disabled:opacity-40"
        >
          {busy ? "Preparing their documents…" : picked.size ? `Send in ${picked.size} client${picked.size === 1 ? "" : "s"}` : "Pick at least one client"}
        </button>
        {picked.size > 0 && (
          <button className="text-xs text-gray-400 underline" onClick={() => setPicked(new Set())}>
            clear
          </button>
        )}
        <span className="text-xs text-gray-500">
          {autoHuman ? "A pretend consultant will answer the questions." : "When a case needs a person, it will wait for you."}
        </span>
        {err && <span className="text-xs text-red-300">{err}</span>}
      </div>

      <details className="rounded-xl border border-gray-800 bg-gray-900/40">
        <summary className="cursor-pointer px-4 py-2.5 text-sm text-gray-300">More options</summary>
        <div className="space-y-4 border-t border-gray-800 px-4 py-4 text-sm text-gray-300">
          <label className="flex flex-wrap items-center gap-2">
            Speed
            <select value={spd} onChange={(e) => setSpd(Number(e.target.value))} className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
              <option value={2}>Fast — a day passes every 2 seconds</option>
              <option value={3}>Normal — a day every 3 seconds</option>
              <option value={10}>Slow — a day every 10 seconds</option>
              <option value={60}>Very slow — a day every minute</option>
            </select>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-orange-500" checked={autoHuman} onChange={(e) => setAutoHuman(e.target.checked)} />
            <span>
              Let a pretend consultant answer for me
              <span className="block text-xs text-gray-500">It knows the right answers. Useful for running many clients at once to fill the Results tab.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-orange-500" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            <span>
              Spoken update for clients who get good news
              <span className="block text-xs text-gray-500">Needs the voice service running (see How it&apos;s built).</span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={busy || !overview.engine.up}
              onClick={() => send(overview.scenarios.map((s) => s.id))}
              className="rounded-md border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:border-gray-400 disabled:opacity-40"
            >
              Send in all {overview.scenarios.length}
            </button>
            <span className="text-xs text-gray-500">Every kind of case at once — for the Results tab.</span>
          </div>
          <OwnClient onStarted={() => onSent("")} />
        </div>
      </details>
    </section>
  );
}

const COUNTRIES: [string, string][] = [
  ["PT", "Portugal"],
  ["ES", "Spain"],
  ["DE", "Germany"],
  ["AE", "United Arab Emirates"],
  ["GB", "United Kingdom"],
  ["CA", "Canada"],
];
const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["ar", "Arabic"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["de", "German"],
  ["fr", "French"],
];

/** A client you write yourself: you play them (send their documents) and the consultant. */
function OwnClient({ onStarted }: { onStarted: () => void }) {
  const [f, setF] = useState({ clientName: "", clientLanguage: "en", passportCountry: "", destination: "PT", requestText: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const input = "w-full rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200";
  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <p className="text-sm font-medium text-gray-200">Write your own client</p>
      <p className="mb-2 text-xs text-gray-500">You play the client too: when the agency asks for documents, you upload them on the case. A day passes every minute.</p>
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <input value={f.clientName} onChange={set("clientName")} placeholder="Their name" className={input} />
        <input value={f.passportCountry} onChange={set("passportCountry")} placeholder="Passport country, two letters (e.g. LB)" maxLength={2} className={input} />
        <label className="flex items-center gap-2 text-gray-400">
          Moving to
          <select value={f.destination} onChange={set("destination")} className={input}>
            {COUNTRIES.map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-gray-400">
          Writes in
          <select value={f.clientLanguage} onChange={set("clientLanguage")} className={input}>
            {LANGUAGES.map(([k, n]) => (
              <option key={k} value={k}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea value={f.requestText} onChange={set("requestText")} rows={3} placeholder="What they ask for, in their own words" className={`${input} mt-2 text-xs`} />
      <button
        disabled={busy || !f.requestText.trim() || f.passportCountry.length !== 2}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            await lab<{ caseKey: string }>("api/cases", { method: "POST", body: JSON.stringify({ ...f, clientName: f.clientName || "Walk-in client", passportCountry: f.passportCountry.toUpperCase(), secondsPerDay: 60 }) });
            onStarted();
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
        className="mt-2 rounded-md border border-orange-600 bg-orange-600/20 px-3 py-1.5 text-xs font-medium text-orange-100 disabled:opacity-40"
      >
        Start their case
      </button>
      {msg && <p className="mt-2 text-xs text-red-300">{msg}</p>}
    </div>
  );
}
