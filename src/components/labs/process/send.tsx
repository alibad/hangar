"use client";

import { useState } from "react";
import { lab, type Overview } from "./api";
import { btn } from "./parts";

/**
 * Send in pretend clients — the body of a dialog. Each client is made up,
 * with a known right ending, so the lab can check itself. Grouped by how
 * their case will go, described in one sentence each, and a "first time"
 * pick of three that shows the most in a few minutes. Speed, the pretend
 * consultant and writing your own client are on the "Options" page.
 */
export default function SendClients({ overview, onSent }: { overview: Overview; onSent: (count: number) => void }) {
  const [page, setPage] = useState<"choose" | "options">("choose");
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
      await lab<{ id: string }>("api/sim", { method: "POST", body: JSON.stringify({ scenarios: ids, secondsPerDay: spd, autoHuman, voiceUpdate: voice }) });
      setPicked(new Set());
      onSent(ids.length);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const groups = overview.scenarioGroups ?? [];
  const first = overview.firstTry ?? [];
  const speedWords: Record<number, string> = { 2: "fast", 3: "normal speed", 10: "slow speed", 60: "very slow speed" };

  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-lg border border-gray-800 bg-gray-900 p-1" role="tablist">
        {(
          [
            ["choose", "Choose clients"],
            ["options", "Options"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={page === id}
            onClick={() => setPage(id)}
            className={`rounded-md px-3 py-1.5 text-sm ${page === id ? "bg-gray-800 font-medium text-gray-100" : "text-gray-400 hover:text-gray-200"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {page === "choose" ? (
        <>
          {first.length > 0 && (
            <button
              onClick={() => setPicked(new Set(first))}
              className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-orange-500/50 bg-orange-500/[0.07] px-4 py-3 text-left transition-colors hover:bg-orange-500/[0.12]"
            >
              <span>
                <span className="block font-medium text-gray-100">First time? Try these three</span>
                <span className="mt-0.5 block text-sm text-gray-400">
                  {first.map((id) => overview.scenarios.find((s) => s.id === id)?.name).filter(Boolean).join(", ")} — one goes smoothly, one needs you to decide, one hits a snag. About five
                  minutes.
                </span>
              </span>
              <span className={btn.secondarySm}>Select them</span>
            </button>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            {groups.map((g) => (
              <div key={g.id}>
                <h3 className="font-semibold text-gray-100">{g.label}</h3>
                <p className="mb-2 text-sm text-gray-500">{g.about}</p>
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
                          className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-orange-500 bg-orange-500/[0.08]" : "border-gray-800 hover:border-gray-600 hover:bg-gray-900"}`}
                        >
                          <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border text-[10px] font-bold ${on ? "border-orange-500 bg-orange-500 text-white" : "border-gray-600"}`}>{on ? "✓" : ""}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-gray-100">
                              {s.name} <span className="font-normal text-gray-500">· {[s.from, s.to].filter(Boolean).join(" → ")}</span>
                            </span>
                            <span className="mt-0.5 block text-sm text-gray-400">{s.teaser}</span>
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="space-y-5 text-sm text-gray-300">
          <label className="block">
            <span className="font-medium text-gray-100">Speed</span>
            <select value={spd} onChange={(e) => setSpd(Number(e.target.value))} className="mt-1 block rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-gray-200">
              <option value={2}>Fast — a day passes every 2 seconds</option>
              <option value={3}>Normal — a day every 3 seconds</option>
              <option value={10}>Slow — a day every 10 seconds</option>
              <option value={60}>Very slow — a day every minute</option>
            </select>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-orange-500" checked={autoHuman} onChange={(e) => setAutoHuman(e.target.checked)} />
            <span>
              <span className="font-medium text-gray-100">Let a pretend consultant answer for me</span>
              <span className="block text-gray-500">It knows the right answers. Useful for running many clients at once to fill the Results tab.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 accent-orange-500" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            <span>
              <span className="font-medium text-gray-100">Spoken update for clients who get good news</span>
              <span className="block text-gray-500">Needs the voice service running (see How it&apos;s built).</span>
            </span>
          </label>
          <div>
            <p className="font-medium text-gray-100">Every kind of case at once</p>
            <p className="mb-2 text-gray-500">All {overview.scenarios.length} pretend clients — for the Results tab. Best with the pretend consultant on.</p>
            <button disabled={busy || !overview.engine.up} onClick={() => send(overview.scenarios.map((s) => s.id))} className={btn.secondarySm}>
              Send in all {overview.scenarios.length}
            </button>
          </div>
          <OwnClient onStarted={() => onSent(0)} />
        </div>
      )}

      {page === "choose" && (
        <div className="sticky bottom-0 -mx-5 -mb-4 flex flex-wrap items-center gap-3 border-t border-gray-800 bg-gray-950 px-5 py-3">
          <button disabled={busy || !picked.size || !overview.engine.up} onClick={() => send([...picked])} className={btn.primary}>
            {busy ? "Preparing their documents…" : picked.size ? `Send in ${picked.size} client${picked.size === 1 ? "" : "s"}` : "Pick at least one client"}
          </button>
          {picked.size > 0 && (
            <button className={btn.link} onClick={() => setPicked(new Set())}>
              clear
            </button>
          )}
          <span className="text-sm text-gray-500">
            Runs at {speedWords[spd] ?? `${spd} seconds a day`}. {autoHuman ? "A pretend consultant answers the questions." : "When a case needs a person, it waits for you."}{" "}
            <button className={btn.link} onClick={() => setPage("options")}>
              Change
            </button>
          </span>
          {err && <span className="text-sm text-red-300">{err}</span>}
        </div>
      )}
    </div>
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
    <div>
      <p className="font-medium text-gray-100">Write your own client</p>
      <p className="mb-2 text-gray-500">You play the client too: when the agency asks for documents, you upload them on the case. A day passes every minute.</p>
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
        className={`${btn.primarySm} mt-2`}
      >
        Start their case
      </button>
      {msg && <p className="mt-2 text-xs text-red-300">{msg}</p>}
    </div>
  );
}
