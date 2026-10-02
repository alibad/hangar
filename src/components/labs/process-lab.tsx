"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Workflow } from "lucide-react";
import { ToolPageHeader } from "@/components/tool-page";
import type { LabComponentProps } from "@/lib/labs";
import { lab, type CaseRow, type Guide, type LabStatus, type Overview } from "./process/api";
import { CasePage, ClientList } from "./process/clients";
import SendClients from "./process/send";
import Results from "./process/results";
import HowItsBuilt from "./process/built";

/**
 * The Process Lab — the console's window onto the process lab
 * (C:\Users\Admin\Code\AI\process-lab): a pretend relocation agency. Clients
 * ask for help moving abroad; written rules, AI and a person handle each case.
 *
 * Built for someone who has never heard of BPMN, DMN or an LLM. One path:
 * send in a pretend client → watch the case → answer when it asks you → see
 * how it ended. Three tabs: Clients (that path), Results (how well it went),
 * How it's built (the engine, the diagram, the rules, the services — the
 * machinery, for whoever wants it).
 *
 * Not on LabShell: the shell is built around picking a model and running one
 * input through it, and here the unit is a case moving through a process.
 */

type Tab = "clients" | "results" | "built";
const INTRO_KEY = "process-lab-intro";

export default function ProcessLab({ lab: def }: LabComponentProps) {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [tab, setTab] = useState<Tab>("clients");
  const [open, setOpen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [intro, setIntro] = useState(true);
  const navRef = useRef<HTMLElement>(null);
  const firstView = useRef(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(INTRO_KEY) === "hidden") setIntro(false);
    } catch {}
  }, []);
  const showIntro = (on: boolean) => {
    setIntro(on);
    try {
      localStorage.setItem(INTRO_KEY, on ? "shown" : "hidden");
    } catch {}
  };

  const loadStatus = useCallback(async () => {
    const s = await fetch("/api/labs/process/status", { cache: "no-store" }).then((r) => r.json() as Promise<LabStatus>);
    setStatus(s);
    return s;
  }, []);
  const loadOverview = useCallback(async () => {
    try {
      setOv(await lab<Overview>("api/overview"));
      setOvErr(null);
    } catch (e) {
      setOvErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const loadCases = useCallback(async () => {
    try {
      setRows(await lab<CaseRow[]>("api/cases?limit=60"));
    } catch {
      // The overview reports the lab being down; the list just keeps its last state.
    }
  }, []);

  const labUp = status?.services.find((s) => s.id === "process-lab")?.up;
  // Without any of these three a case can't move: the engine runs it, the
  // router carries its AI calls, the lab does the work.
  const up = (id: string) => status?.services.find((s) => s.id === id);
  const essentialsUp = ESSENTIAL.every((id) => !up(id)?.onHost || up(id)?.up);
  const servicesUp = !!(status && essentialsUp);
  const ready = servicesUp && !!ov?.engine.up;

  useEffect(() => {
    lab<Guide>("api/guide").then(setGuide, () => {});
  }, [labUp]);
  useEffect(() => {
    loadStatus();
    loadOverview();
    const iv = setInterval(() => {
      if (document.hidden) return;
      loadStatus();
      loadOverview();
    }, 5000);
    return () => clearInterval(iv);
  }, [loadStatus, loadOverview]);
  useEffect(() => {
    if (!ready) return;
    loadCases();
    const iv = setInterval(() => !document.hidden && loadCases(), 5000);
    return () => clearInterval(iv);
  }, [ready, loadCases]);

  // Opening the picker, a case or another tab replaces what's under the tabs:
  // bring the tabs to the top (below the console's pinned bars), or the new
  // view can open below the fold and look like nothing happened.
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    // Like a page change: jump, once the new view has laid out (and again a
    // moment later — the list and the intro settle after the first frame).
    const place = () => {
      const nav = navRef.current;
      if (!nav) return;
      const pinned = Math.max(0, ...[...document.querySelectorAll<HTMLElement>(".console-header, .resource-pulse")].map((e) => e.getBoundingClientRect().bottom));
      const top = nav.getBoundingClientRect().top + window.scrollY - pinned - 8;
      if (Math.abs(window.scrollY - top) > 4) window.scrollTo({ top });
    };
    const raf = requestAnimationFrame(place);
    const t = setTimeout(place, 400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [tab, open, sending]);

  const probe = (id: string) => async () => !!(await loadStatus()).services.find((s) => s.id === id)?.up;

  if (status && !status.lab) {
    return (
      <div className="space-y-5">
        <Header def={def} />
        <p className="rounded-xl border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          Nothing on this machine serves business processes. The process lab runs on BeTenshi; to run it here, declare a service with{" "}
          <code>&quot;serves&quot;: {"{"} &quot;process&quot;: &quot;relocation-case&quot; {"}"}</code> in this host&apos;s <code>config/hosts/&lt;host&gt;.json</code>.
        </p>
      </div>
    );
  }

  const live = (rows ?? []).filter((r) => r.state !== "EXTERNALLY_TERMINATED");
  const waiting = live.filter((r) => r.state === "ACTIVE" && r.plain.status.tone === "you");
  const goTo = (t: Tab) => {
    setTab(t);
    setOpen(null);
    setSending(false);
  };
  const startSending = () => {
    setTab("clients");
    setOpen(null);
    setSending(true);
  };

  return (
    <div className="space-y-5">
      <Header def={def} meta={<ReadyPill status={status} ready={ready} />} />

      {status && !servicesUp && <StartLab status={status} loadStatus={loadStatus} onReady={loadOverview} />}
      {servicesUp && !ov && !ovErr && <p className="text-xs text-gray-500">Connecting…</p>}
      {ovErr && labUp && <p className="text-xs text-red-300">{ovErr}</p>}

      {ready && ov && (
        <>
          {/* The intro belongs to the list; a case or the picker gets the screen to itself. */}
          {tab === "clients" && !open && !sending &&
            (intro ? (
              <Intro onHide={() => showIntro(false)} onSend={startSending} />
            ) : (
              <button onClick={() => showIntro(true)} className="text-xs text-gray-500 underline">
                How does this work?
              </button>
            ))}

          <nav ref={navRef} className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-800">
            <div className="flex gap-1">
              {(
                [
                  ["clients", "Clients"],
                  ["results", "Results"],
                  ["built", "How it's built"],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => goTo(id)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-orange-500 text-gray-100" : "border-transparent text-gray-400 hover:text-gray-200"}`}
                >
                  {label}
                  {id === "clients" && waiting.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-amber-500/25 px-1.5 text-[10px] font-semibold text-amber-200" title="Waiting for you">
                      {waiting.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {!(tab === "clients" && sending) && (
              <button
                onClick={startSending}
                className="mb-1.5 rounded-lg border border-orange-500 bg-orange-500/20 px-3 py-1.5 text-sm font-medium text-orange-50 hover:bg-orange-500/30"
              >
                + Send in pretend clients
              </button>
            )}
          </nav>

          {tab === "clients" &&
            (sending ? (
              <SendClients
                overview={ov}
                onCancel={() => setSending(false)}
                onSent={() => {
                  setSending(false);
                  loadOverview();
                  loadCases();
                }}
              />
            ) : open ? (
              <CasePage
                caseKey={open}
                guide={guide}
                onBack={() => setOpen(null)}
                onOpen={setOpen}
                nextWaiting={waiting.find((r) => r.caseKey !== open) ?? null}
              />
            ) : rows && live.length === 0 ? (
              <Empty onSend={() => setSending(true)} />
            ) : rows ? (
              <ClientList rows={rows} onOpen={setOpen} />
            ) : (
              <p className="text-xs text-gray-500">Loading clients…</p>
            ))}
          {tab === "results" && <Results runs={ov.runs} />}
          {tab === "built" && <HowItsBuilt status={status} ov={ov} guide={guide} probe={probe} doc={def.doc} />}
        </>
      )}
    </div>
  );
}

function Header({ def, meta }: { def: LabComponentProps["lab"]; meta?: React.ReactNode }) {
  return <ToolPageHeader eyebrow="Lab" title={def.label} description={def.hint} icon={<Workflow className="h-5 w-5" />} meta={meta} />;
}

function ReadyPill({ status, ready }: { status: LabStatus | null; ready: boolean }) {
  if (!status) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300">
      <span className={`size-1.5 rounded-full ${ready ? "bg-emerald-400" : "bg-gray-500"}`} aria-hidden="true" />
      {ready ? "Ready" : "Off"}
    </span>
  );
}

/** Three steps, one button. Folds away once read (remembered per browser). */
function Intro({ onHide, onSend }: { onHide: () => void; onSend: () => void }) {
  const steps = [
    ["Send in a pretend client", "Pick someone who wants help moving abroad — a visa, a residency permit, a home, a bank account. Each is made up, and the lab knows how their case should end."],
    ["Watch their case", "Written rules set the price and check who qualifies. AI works out what the client wants, reads their documents (Arabic too) and writes their emails."],
    ["Step in when it asks", "When the AI isn't sure, or an application is ready to submit, the case waits for you. You answer right on the case."],
  ];
  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-100">How it works</h3>
        <button onClick={onHide} className="text-xs text-gray-500 hover:text-gray-300">
          Hide
        </button>
      </div>
      <ol className="grid gap-4 md:grid-cols-3">
        {steps.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-orange-500/60 text-sm font-semibold text-orange-200">{i + 1}</span>
            <span>
              <span className="block text-sm font-medium text-gray-100">{title}</span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-gray-400">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <button onClick={onSend} className="mt-4 rounded-lg border border-orange-500 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-50 hover:bg-orange-500/30">
        Send in a pretend client
      </button>
    </section>
  );
}

function Empty({ onSend }: { onSend: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-700 px-6 py-10 text-center">
      <p className="text-base text-gray-200">No clients yet.</p>
      <p className="mt-1 text-sm text-gray-500">Send in a pretend client and watch their case unfold.</p>
      <button onClick={onSend} className="mt-4 rounded-lg border border-orange-500 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-50 hover:bg-orange-500/30">
        Send in a pretend client
      </button>
    </div>
  );
}

/**
 * The lab is off: one button that starts what it needs, in order — the
 * process engine, the AI router, the lab itself, then the small decision
 * model. The
 * local LLM is not started here: it needs the GPU, and the lab falls back to
 * the cloud without it. Each service is still under How it's built.
 */
const ESSENTIAL = ["process-engine", "ai-router", "process-lab"];
const NEEDED = [...ESSENTIAL, "laya"];

function StartLab({ status, loadStatus, onReady }: { status: LabStatus; loadStatus: () => Promise<LabStatus>; onReady: () => void }) {
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const missing = status.services.filter((s) => NEEDED.includes(s.id) && s.onHost && !s.up);
  const start = async () => {
    setErr(null);
    try {
      for (const id of NEEDED) {
        const svc = (await loadStatus()).services.find((s) => s.id === id);
        if (!svc?.onHost || svc.up) continue;
        setStep(svc.name);
        const r = await fetch(`/api/services/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(`${svc.name}: ${j.error ?? `HTTP ${r.status}`}`);
        const deadline = Date.now() + 150_000;
        while (!(await loadStatus()).services.find((s) => s.id === id)?.up) {
          if (Date.now() > deadline) throw new Error(`${svc.name} didn't come up within two and a half minutes. Its log is under How it's built once the lab is up, or on the Services tab.`);
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      setStep(null);
      onReady();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStep(null);
    }
  };
  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/60 p-5">
      <h3 className="text-base font-semibold text-gray-100">The lab is switched off</h3>
      <p className="mt-1 text-sm text-gray-400">It runs on a few programs on this machine. Press start and it switches them on — about half a minute.</p>
      {missing.length > 0 && <p className="mt-1 text-[11px] text-gray-500">Not running: {missing.map((s) => s.name).join(", ")}.</p>}
      <button onClick={start} disabled={!!step} className="mt-3 rounded-lg border border-orange-500 bg-orange-500/20 px-4 py-2 text-sm font-medium text-orange-50 hover:bg-orange-500/30 disabled:opacity-60">
        {step ? `Starting ${step}…` : "Start the lab"}
      </button>
      {err && <p className="mt-2 text-xs text-red-300">{err}</p>}
    </section>
  );
}
