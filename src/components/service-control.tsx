"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LogViewer from "./log-viewer";
import { SERVICE_REGISTRY } from "@/lib/services";

/**
 * Service lifecycle, usable from anywhere a service's status is shown.
 *
 * Every tab that talks to a local model reports when that model is down, and each
 * one used to end the sentence with "start it from the Services tab" — a tab that
 * has since been renamed, and that you had to leave the failing surface to reach.
 * The rule now: wherever the console says a service isn't running, it also offers
 * the button. This module is the one implementation of that button.
 *
 * The same applies to logs: "why is it stuck starting?" is answerable from the
 * manager's log tail, and that answer used to live only on the Stack tab. Every
 * cluster here carries a Logs button that opens the same viewer.
 *
 * Two entry points:
 *  • useServiceLifecycle() — when the view needs the state too (status dot colour,
 *    a "starting…" pill, a log tail), like the Qwen studio header.
 *  • <ServiceControl>      — self-contained cluster for a list row or a banner.
 * Plus <ServiceLogsButton> on its own, for rows whose buttons are bespoke.
 *
 * The Stack tab keeps its own full-width action strip: it owns the canonical
 * card layout, and its buttons are laid out as flex-1 thirds rather than a
 * compact inline cluster. Everything else goes through here.
 */

export type LifecycleAction = "start" | "stop" | "restart";

type ManagedRow = { id: string; status: string; pid: number | null; log_tail?: string[] };

const JSON_HEADERS = { "Content-Type": "application/json" };

/** How long to wait for a service to actually reach the state we asked for. */
const DEADLINE_MS: Record<LifecycleAction, number> = { start: 180_000, restart: 180_000, stop: 30_000 };

const VERB_ING: Record<LifecycleAction, string> = { start: "Starting…", stop: "Stopping…", restart: "Restarting…" };

/**
 * One shared, 4s-TTL /api/services fetch for every mounted control.
 *
 * That endpoint health-checks the whole registry, so a screen showing several
 * services (the Models tab lists a dozen) would otherwise multiply that cost by
 * the number of controls on it.
 */
let inflight: { at: number; p: Promise<ManagedRow[]> } | null = null;
function managedServices(): Promise<ManagedRow[]> {
  if (inflight && Date.now() - inflight.at < 4000) return inflight.p;
  const p = fetch("/api/services", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => (Array.isArray(d) ? (d as ManagedRow[]) : []))
    .catch(() => [] as ManagedRow[]);
  inflight = { at: Date.now(), p };
  return p;
}

export type ServiceLifecycle = {
  id: string;
  /** Whether the service answers its own health check, per the calling view. */
  up: boolean | undefined;
  /** The manager's view of the process — the only source that can see a start in progress. */
  managed: ManagedRow | null;
  /** Our own in-flight action. */
  acting: LifecycleAction | null;
  /**
   * What the service is doing, from EITHER source: this session's click, or the
   * manager reporting the process alive while its port is still closed. A big
   * model load takes minutes — longer than any click-scoped state survives — so
   * without the second source, reloading mid-start shows "offline" and a Start
   * button over a load that is visibly running.
   */
  busyVerb: LifecycleAction | null;
  error: string | null;
  run: (action: LifecycleAction) => Promise<void>;
};

/**
 * @param up     the view's own health verdict — undefined until it has one.
 * @param probe  re-check health and resolve to the fresh verdict. Called
 *               repeatedly after an action so the button can hold its state
 *               until the service really got there.
 */
export function useServiceLifecycle(
  id: string,
  up: boolean | undefined,
  probe: () => Promise<boolean>,
): ServiceLifecycle {
  const [managed, setManaged] = useState<ManagedRow | null>(null);
  const [acting, setActing] = useState<LifecycleAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Held in a ref so a caller passing an inline closure doesn't restart the poll.
  const probeRef = useRef(probe);
  probeRef.current = probe;

  // Poll the manager only while the service isn't answering: once it's up, the
  // view's own health check is the better source and this is pure noise.
  useEffect(() => {
    if (up) {
      setManaged(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      const rows = await managedServices();
      if (alive) setManaged(rows.find((r) => r.id === id) ?? null);
    };
    tick();
    const iv = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id, up]);

  const run = useCallback(
    async (action: LifecycleAction) => {
      setActing(action);
      setError(null);
      const startedAt = Date.now();
      try {
        const res = await fetch(`/api/services/${id}`, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          setError(data.error || `HTTP ${res.status}`);
        } else {
          const target = action !== "stop"; // start/restart → up; stop → down
          const deadline = Date.now() + DEADLINE_MS[action];
          let now = await probeRef.current();
          while (now !== target && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            now = await probeRef.current();
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      // ≥1s floor, so a near-instant Windows kill still reads as a deliberate
      // "Stopping…" rather than an instant, did-anything-happen flip.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 1000) await new Promise((r) => setTimeout(r, 1000 - elapsed));
      setActing(null);
      probeRef.current();
    },
    [id],
  );

  const busyVerb: LifecycleAction | null =
    acting ?? (!up && managed?.status === "starting" ? "start" : null);

  return { id, up, managed, acting, busyVerb, error, run };
}

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 rounded-full border-[1.5px] border-current border-t-transparent animate-spin align-[-2px]" />
  );
}

/** Display name for a service id — the registry is the single source for these. */
export function serviceName(id: string): string {
  return SERVICE_REGISTRY.find((s) => s.id === id)?.name ?? id;
}

/**
 * Open the live log viewer for a service.
 *
 * Standalone because some rows have their own button vocabulary (the LLM picker's
 * "Use" already means start-this-and-stop-the-others) but still need the same way
 * in to "what is it actually doing?".
 */
export function ServiceLogsButton({
  id,
  name,
  className,
}: {
  id: string;
  name?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = name ?? serviceName(id);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Live logs for ${label}`}
        className={
          className ??
          "text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition"
        }
      >
        Logs
      </button>
      {open && <LogViewer serviceId={id} serviceName={label} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Strip the log prefix the manager adds, plus any ANSI, for a one-line tail. */
function lastLogLine(rows?: string[]): string | null {
  if (!rows?.length) return null;
  return rows[rows.length - 1]
    .replace(/^\[[\d\-T:.Z]+\]\s*/, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim();
}

/** The button cluster. Start when down, Stop/Restart when up, spinner while acting. */
export function ServiceControls({
  lifecycle,
  actions = ["stop", "restart"],
  onRefresh,
  stopTitle,
  confirmStop,
  name,
  showLogs = true,
  className = "",
}: {
  lifecycle: ServiceLifecycle;
  /** Which controls to offer while it's up. Start is always offered while it's down. */
  actions?: ("stop" | "restart")[];
  onRefresh?: () => void;
  /** Service-specific warning for Stop, e.g. how much VRAM it frees. */
  stopTitle?: string;
  /** When set, Stop requires a second explicit confirmation with this impact copy. */
  confirmStop?: string;
  /** Title for the log viewer; defaults to the registry name for this id. */
  name?: string;
  /** On by default — a service you can start is one you'll want to read the logs of. */
  showLogs?: boolean;
  className?: string;
}) {
  const { up, busyVerb, run } = lifecycle;
  const [confirmingStop, setConfirmingStop] = useState(false);
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {busyVerb ? (
        <span className="text-[11px] text-amber-400 flex items-center gap-1.5 px-2 py-1 select-none">
          <Spinner />
          {VERB_ING[busyVerb]}
        </span>
      ) : up ? (
        <>
          {actions.includes("stop") && confirmingStop && confirmStop ? (
            <span className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-100">
              <span className="max-w-64 leading-4">{confirmStop}</span>
              <button type="button" onClick={() => { setConfirmingStop(false); run("stop"); }} className="rounded bg-red-500 px-2 py-1 font-medium text-white">Confirm stop</button>
              <button type="button" onClick={() => setConfirmingStop(false)} className="rounded border border-gray-600 px-2 py-1 text-gray-200">Cancel</button>
            </span>
          ) : actions.includes("stop") && (
            <button
              onClick={() => confirmStop ? setConfirmingStop(true) : run("stop")}
              title={stopTitle ?? "Stop this service"}
              className="text-[11px] text-red-400 hover:text-red-300 border border-red-700/40 hover:border-red-600 rounded-md px-2 py-1 transition cursor-pointer"
            >
              Stop
            </button>
          )}
          {actions.includes("restart") && (
            <button
              onClick={() => run("restart")}
              title="Restart this service — reloads the model fresh"
              className="text-[11px] text-amber-400 hover:text-amber-300 border border-amber-700/40 hover:border-amber-600 rounded-md px-2 py-1 transition cursor-pointer"
            >
              Restart
            </button>
          )}
        </>
      ) : (
        <button
          onClick={() => run("start")}
          title="Start this service"
          className="text-[11px] font-medium bg-green-600 hover:bg-green-500 text-white rounded-md px-2.5 py-1 transition cursor-pointer flex items-center gap-1"
        >
          ▶ Start
        </button>
      )}
      {showLogs && <ServiceLogsButton id={lifecycle.id} name={name} />}
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={!!lifecycle.acting}
          className="text-[11px] text-gray-400 hover:text-gray-100 border border-gray-700 hover:border-gray-500 rounded-md px-2 py-1 transition disabled:opacity-40"
        >
          Refresh
        </button>
      )}
    </div>
  );
}

/**
 * The line under the controls: what a start is currently doing (with the manager's
 * own log tail, because a multi-minute weight load needs evidence of progress),
 * a failed action, or why the service is unusable.
 */
export function ServiceStartupNote({
  lifecycle,
  downMessage,
  className = "",
}: {
  lifecycle: ServiceLifecycle;
  /** Shown when the service is simply down. Should not tell the user to go elsewhere. */
  downMessage?: string;
  className?: string;
}) {
  const { busyVerb, managed, error, up } = lifecycle;

  if (busyVerb === "start") {
    const tail = lastLogLine(managed?.log_tail);
    return (
      <div className={`space-y-1 ${className}`}>
        <p className="text-xs text-amber-400/80 flex items-center gap-1.5">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          {managed?.status === "starting" ? "Model loading…" : "Starting…"}{" "}
          {managed?.pid ? `(pid ${managed.pid})` : ""}
        </p>
        {tail && <p className="text-[11px] text-gray-500 font-mono truncate">{tail}</p>}
      </div>
    );
  }
  if (error) return <p className={`text-xs text-red-400/80 ${className}`}>Action failed — {error}</p>;
  if (up === false) {
    return (
      <p className={`text-xs text-red-400/80 ${className}`}>
        {downMessage ?? "Server unreachable."} Use Start above to launch it.
      </p>
    );
  }
  return null;
}

/**
 * Self-contained control for a row or banner: owns its lifecycle state, renders the
 * cluster. Use the hook instead when the surrounding view also needs the state.
 */
export function ServiceControl({
  id,
  up,
  probe,
  actions,
  stopTitle,
  name,
  showLogs,
  className,
}: {
  id: string;
  up: boolean | undefined;
  probe: () => Promise<boolean>;
  actions?: ("stop" | "restart")[];
  stopTitle?: string;
  name?: string;
  showLogs?: boolean;
  className?: string;
}) {
  const lifecycle = useServiceLifecycle(id, up, probe);
  return (
    <ServiceControls
      lifecycle={lifecycle}
      actions={actions}
      stopTitle={stopTitle}
      name={name}
      showLogs={showLogs}
      className={className}
    />
  );
}
