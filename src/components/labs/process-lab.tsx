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
import { Dialog, btn } from "./process/parts";
import { useTabActive } from "@/components/tab-pane";

/**
 * The Process Lab — the console's window onto the process lab
 * (C:\Users\Admin\Code\AI\process-lab): a pretend relocation agency. Clients
 * ask for help moving abroad; written rules, AI and a person handle each case.
 *
 * Built for someone who has never heard of BPMN, DMN or an LLM. One path:
 * send in a pretend client → watch the case → answer when it asks you → see
 * how it ended. Three tabs: Clients (that path), Results (how well it went),
 * How it's built (the machinery, for whoever wants it).
 *
 * Navigation is meant to feel calm:
 *  • switching tabs changes only what is under the tabs — nothing above them
 *    moves, the page doesn't scroll, and a tab once opened stays built, so
 *    coming back to it shows it at once instead of loading again;
 *  • a client's case opens like a page ("Clients › Hana Saleh"), and the
 *    browser's Back button returns to the list where you were;
 *  • everything that is not the main path — how it works, choosing clients,
 *    an email, the machinery — opens in a dialog over the page.
 *
 * Not on LabShell: the shell is built around picking a model and running one
 * input through it, and here the unit is a case moving through a process.
 */

type Tab = "clients" | "results" | "built";
type View = { tab: Tab; caseKey: string | null };
const HOME: View = { tab: "clients", caseKey: null };
const SEEN_KEY = "process-lab-howto-seen";

export default function ProcessLab({ lab: def }: LabComponentProps) {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [rows, setRows] = useState<CaseRow[] | null>(null);
  const [guide, setGuide] = useState<Guide | null>(null);
  const [view, setView] = useState<View>(HOME);
  // Tabs are built the first time they're opened and then kept.
  const [built, setBuilt] = useState<Set<Tab>>(new Set(["clients"]));
  const [howto, setHowto] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const listScroll = useRef(0);
  // The console keeps this tab alive while another shows; don't poll for nobody.
  const visible = useTabActive();

  // ── navigation, with the browser's history ────────────────────────────────
  // The console keys its own tabs on the URL hash (#lab-process), so the lab
  // keeps that hash and puts where it is inside the lab in history.state.
  const show = useCallback((next: View) => {
    setView(next);
    setBuilt((b) => (b.has(next.tab) ? b : new Set(b).add(next.tab)));
  }, []);
  const go = useCallback(
    (next: View) => {
      const leavingList = !view.caseKey && next.caseKey;
      if (leavingList) listScroll.current = window.scrollY;
      show(next);
      window.history.pushState({ ...window.history.state, tab: "lab-process", lab: next }, "", "#lab-process");
      if (leavingList) requestAnimationFrame(() => toTabs(tabsRef.current));
      if (view.caseKey && !next.caseKey && next.tab === "clients") requestAnimationFrame(() => window.scrollTo({ top: listScroll.current }));
    },
    [view.caseKey, show],
  );
  useEffect(() => {
    const here = window.history.state?.lab as View | undefined;
    if (here) show(here);
    const onPop = (e: PopStateEvent) => {
      const v = (e.state?.lab as View | undefined) ?? HOME;
      show(v);
      if (!v.caseKey) requestAnimationFrame(() => window.scrollTo({ top: listScroll.current }));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [show]);

  // ── data ─────────────────────────────────────────────────────────────────
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
      // The overview reports the lab being down; the list keeps its last state.
    }
  }, []);

  // Without any of these three a case can't move: the engine runs it, the
  // router carries its AI calls, the lab does the work.
  const svc = (id: string) => status?.services.find((s) => s.id === id);
  const essentialsUp = ESSENTIAL.every((id) => !svc(id)?.onHost || svc(id)?.up);
  const labUp = svc("process-lab")?.up;
  const servicesUp = !!(status && essentialsUp);
  const ready = servicesUp && !!ov?.engine.up;

  useEffect(() => {
    lab<Guide>("api/guide").then(setGuide, () => {});
  }, [labUp]);
  useEffect(() => {
    loadStatus();
    loadOverview();
    const iv = setInterval(() => {
      if (document.hidden || !visible) return;
      loadStatus();
      loadOverview();
    }, 5000);
    return () => clearInterval(iv);
  }, [loadStatus, loadOverview, visible]);
  useEffect(() => {
    if (!ready) return;
    loadCases();
    const iv = setInterval(() => !document.hidden && visible && loadCases(), 5000);
    return () => clearInterval(iv);
  }, [ready, loadCases, visible]);

  // First visit: open "How it works" once.
  useEffect(() => {
    if (!ready) return;
    try {
      if (!localStorage.getItem(SEEN_KEY)) {
        setHowto(true);
        localStorage.setItem(SEEN_KEY, "1");
      }
    } catch {}
  }, [ready]);

  const probe = (id: string) => async () => !!(await loadStatus()).services.find((s) => s.id === id)?.up;

  if (status && !status.lab) {
    return (
      <div className="space-y-5">
        <Header def={def} />
        <p className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-gray-200">
          Nothing on this machine serves business processes. The process lab runs on BeTenshi; to run it here, declare a service with{" "}
          <code>&quot;serves&quot;: {"{"} &quot;process&quot;: &quot;relocation-case&quot; {"}"}</code> in this host&apos;s <code>config/hosts/&lt;host&gt;.json</code>.
        </p>
      </div>
    );
  }

  const live = (rows ?? []).filter((r) => r.state !== "EXTERNALLY_TERMINATED");
  const waiting = live.filter((r) => r.state === "ACTIVE" && r.plain.status.tone === "you");

  return (
    <div className="space-y-5">
      <Header
        def={def}
        meta={<ReadyPill status={status} ready={ready} />}
        actions={
          ready ? (
            <button onClick={() => setHowto(true)} className={btn.secondarySm}>
              How it works
            </button>
          ) : null
        }
      />

      {status && !servicesUp && <StartLab status={status} loadStatus={loadStatus} onReady={loadOverview} />}
      {servicesUp && !ov && !ovErr && <p className="text-sm text-gray-500">Connecting…</p>}
      {ovErr && labUp && <p className="text-xs text-red-300">{ovErr}</p>}

      {ready && ov && (
        <>
          <nav ref={tabsRef} className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-800">
            <div className="flex gap-1" role="tablist">
              {(
                [
                  ["clients", "Clients"],
                  ["results", "Results"],
                  ["built", "How it's built"],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={view.tab === id}
                  onClick={() => (view.tab === id && !view.caseKey ? null : go({ tab: id, caseKey: null }))}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${view.tab === id ? "border-orange-500 font-medium text-gray-100" : "border-transparent text-gray-400 hover:text-gray-200"}`}
                >
                  {label}
                  {id === "clients" && waiting.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-amber-500/20 px-1.5 text-[11px] font-semibold text-amber-300" title="Waiting for you">
                      {waiting.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button onClick={() => setSending(true)} className={`${btn.primarySm} mb-1.5`}>
              + Send in pretend clients
            </button>
          </nav>

          <div hidden={view.tab !== "clients"} className="min-h-[70vh]">
            {view.caseKey ? (
              <CasePage
                caseKey={view.caseKey}
                guide={guide}
                onBack={() => go({ tab: "clients", caseKey: null })}
                onOpen={(k) => go({ tab: "clients", caseKey: k })}
                nextWaiting={waiting.find((r) => r.caseKey !== view.caseKey) ?? null}
              />
            ) : rows && live.length === 0 ? (
              <Empty onSend={() => setSending(true)} onHowto={() => setHowto(true)} />
            ) : rows ? (
              <div className="space-y-4">
                {notice && (
                  <p className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-gray-200">
                    {notice}
                    <button onClick={() => setNotice(null)} className={btn.ghost}>
                      Dismiss
                    </button>
                  </p>
                )}
                <ClientList rows={rows} onOpen={(k) => go({ tab: "clients", caseKey: k })} />
              </div>
            ) : (
              <p className="text-sm text-gray-500">Loading clients…</p>
            )}
          </div>
          {built.has("results") && (
            <div hidden={view.tab !== "results"} className="min-h-[70vh]">
              <Results runs={ov.runs} active={view.tab === "results"} />
            </div>
          )}
          {built.has("built") && (
            <div hidden={view.tab !== "built"} className="min-h-[70vh]">
              <HowItsBuilt status={status} ov={ov} guide={guide} probe={probe} doc={def.doc} />
            </div>
          )}

          <Dialog open={howto} onClose={() => setHowto(false)} title="How it works" subtitle="A pretend relocation agency, in three steps." size="md">
            <HowItWorks
              onSend={() => {
                setHowto(false);
                setSending(true);
              }}
            />
          </Dialog>
          <Dialog
            open={sending}
            onClose={() => setSending(false)}
            title="Send in pretend clients"
            subtitle="Each one is made up — name, documents and all — and the lab knows how their case should end, so it can check itself."
            size="xl"
          >
            <SendClients
              overview={ov}
              onSent={(n) => {
                setSending(false);
                setNotice(
                  n === 1
                    ? "Sent in. Your client is under “In progress” — when the case needs you, it moves to “Waiting for you”."
                    : n
                      ? `${n} clients sent in. They're under “In progress” — when one needs you, it moves to “Waiting for you”.`
                      : "Your client is in. Open their case to send their documents.",
                );
                loadOverview();
                loadCases();
                if (view.tab !== "clients" || view.caseKey) go(HOME);
              }}
            />
          </Dialog>
        </>
      )}
    </div>
  );
}

/** Scroll so the lab's tabs sit just under the console's pinned bars — where a new page starts. */
function toTabs(el: HTMLElement | null) {
  if (!el) return;
  const pinned = Math.max(0, ...[...document.querySelectorAll<HTMLElement>(".console-header, .resource-pulse")].map((e) => e.getBoundingClientRect().bottom));
  const top = el.getBoundingClientRect().top + window.scrollY - pinned - 8;
  if (window.scrollY > top) window.scrollTo({ top });
}

function Header({ def, meta, actions }: { def: LabComponentProps["lab"]; meta?: React.ReactNode; actions?: React.ReactNode }) {
  return <ToolPageHeader eyebrow="Lab" title={def.label} description={def.hint} icon={<Workflow className="h-5 w-5" />} meta={meta} actions={actions} />;
}

function ReadyPill({ status, ready }: { status: LabStatus | null; ready: boolean }) {
  if (!status) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-300">
      <span className={`size-1.5 rounded-full ${ready ? "bg-emerald-500" : "bg-gray-500"}`} aria-hidden="true" />
      {ready ? "Ready" : "Off"}
    </span>
  );
}

const STEPS: [string, string][] = [
  ["Send in a pretend client", "Pick someone who wants help moving abroad — a visa, a residency permit, a home, a bank account. Each is made up, and the lab knows how their case should end."],
  ["Watch their case", "Written rules set the price and check who qualifies. AI works out what the client wants, reads their documents (Arabic too) and writes their emails."],
  ["Step in when it asks", "When the AI isn't sure, or an application is ready to submit, the case waits for you. You answer right on the case."],
];

function HowItWorks({ onSend }: { onSend: () => void }) {
  return (
    <div className="space-y-5">
      <ol className="space-y-4">
        {STEPS.map(([title, text], i) => (
          <li key={title} className="flex gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-orange-500/60 text-sm font-semibold text-orange-300">{i + 1}</span>
            <span>
              <span className="block font-medium text-gray-100">{title}</span>
              <span className="mt-0.5 block text-sm leading-relaxed text-gray-400">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-gray-400">
        Then <b className="text-gray-200">Results</b> shows how well it went, and <b className="text-gray-200">How it&apos;s built</b> shows the machinery underneath, for the curious.
      </p>
      <button onClick={onSend} className={btn.primary}>
        Send in a pretend client
      </button>
    </div>
  );
}

function Empty({ onSend, onHowto }: { onSend: () => void; onHowto: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-700 px-6 py-10 text-center">
      <p className="text-base text-gray-100">No clients yet.</p>
      <p className="mt-1 text-sm text-gray-400">Send in a pretend client and watch their case unfold. It takes a few minutes.</p>
      <div className="mt-4 flex justify-center gap-2">
        <button onClick={onSend} className={btn.primary}>
          Send in a pretend client
        </button>
        <button onClick={onHowto} className={btn.secondary}>
          How it works
        </button>
      </div>
    </div>
  );
}

/**
 * The lab is off: one button that starts what it needs, in order — the
 * process engine, the AI router, the lab itself, then the small decision
 * model. The local LLM is not started here: it needs the GPU, and the lab
 * falls back to the cloud without it. Each service is still under How it's
 * built.
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
        const s = (await loadStatus()).services.find((x) => x.id === id);
        if (!s?.onHost || s.up) continue;
        setStep(s.name);
        const r = await fetch(`/api/services/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start" }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) throw new Error(`${s.name}: ${j.error ?? `HTTP ${r.status}`}`);
        const deadline = Date.now() + 150_000;
        while (!(await loadStatus()).services.find((x) => x.id === id)?.up) {
          if (Date.now() > deadline) throw new Error(`${s.name} didn't come up within two and a half minutes. Its log is on the Services tab.`);
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
    <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h3 className="text-base font-semibold text-gray-100">The lab is switched off</h3>
      <p className="mt-1 text-sm text-gray-400">It runs on a few programs on this machine. Press start and it switches them on — about half a minute.</p>
      {missing.length > 0 && <p className="mt-1 text-xs text-gray-500">Not running: {missing.map((s) => s.name).join(", ")}.</p>}
      <button onClick={start} disabled={!!step} className={`${btn.primary} mt-4`}>
        {step ? `Starting ${step}…` : "Start the lab"}
      </button>
      {err && <p className="mt-2 text-sm text-red-300">{err}</p>}
    </section>
  );
}
