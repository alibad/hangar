"use client";

import { useEffect, useMemo, useState } from "react";
import BpmnView from "./bpmn-view";
import YourTurn from "./your-turn";
import { ActorBadge, ActorKey, Avatar, DecisionTable, Fold, StepHelp, dayLabel, rich } from "./parts";
import { fileUrl, lab, type CaseDetail, type CaseRow, type Guide, type Stage, type StoryEntry, type Tone } from "./api";

/**
 * The clients: who is waiting for you, who is in progress, who is finished —
 * and one client's case, told as a story.
 *
 * A case opens on what a person needs first: who the client is and what they
 * want, what is happening right now (and, if it's waiting for you, the
 * question itself), the six stages, and what has happened so far in plain
 * words. How each step was decided, the process diagram and the raw decision
 * table are one click away, not in the way.
 */

const TONE_DOT: Record<Tone, string> = {
  you: "bg-amber-400",
  person: "bg-amber-400/60",
  working: "bg-gray-400",
  done: "bg-emerald-400",
  closed: "bg-gray-600",
  bad: "bg-red-400",
};

export function ClientList({ rows, onOpen }: { rows: CaseRow[]; onOpen: (key: string) => void }) {
  const [allFinished, setAllFinished] = useState(false);
  const visible = rows.filter((r) => r.state !== "EXTERNALLY_TERMINATED");
  const waiting = visible.filter((r) => r.state === "ACTIVE" && r.plain.status.tone === "you");
  const going = visible.filter((r) => r.state === "ACTIVE" && r.plain.status.tone !== "you");
  const finished = visible.filter((r) => r.state !== "ACTIVE");
  const hidden = rows.length - visible.length;

  return (
    <div className="space-y-5">
      {waiting.length > 0 && (
        <Group title="Waiting for you" count={waiting.length} tone="you">
          {waiting.map((r) => (
            <Row key={r.caseKey} r={r} onOpen={onOpen} action="Answer" />
          ))}
        </Group>
      )}
      {going.length > 0 && (
        <Group title="In progress" count={going.length}>
          {going.map((r) => (
            <Row key={r.caseKey} r={r} onOpen={onOpen} />
          ))}
        </Group>
      )}
      {finished.length > 0 && (
        <Group title="Finished" count={finished.length}>
          {(allFinished ? finished : finished.slice(0, 6)).map((r) => (
            <Row key={r.caseKey} r={r} onOpen={onOpen} />
          ))}
          {finished.length > 6 && (
            <li className="px-4 py-2">
              <button className="text-xs text-gray-400 underline" onClick={() => setAllFinished(!allFinished)}>
                {allFinished ? "Show fewer" : `Show all ${finished.length} finished`}
              </button>
            </li>
          )}
        </Group>
      )}
      {hidden > 0 && <p className="text-[11px] text-gray-600">{hidden} cancelled test case{hidden === 1 ? "" : "s"} not shown.</p>}
    </div>
  );
}

function Group({ title, count, tone, children }: { title: string; count: number; tone?: "you"; children: React.ReactNode }) {
  return (
    <section>
      <h3 className={`mb-2 text-xs font-semibold uppercase tracking-wide ${tone === "you" ? "text-amber-300" : "text-gray-500"}`}>
        {title} <span className="ml-1 font-normal">{count}</span>
      </h3>
      <ul className={`divide-y divide-gray-800 overflow-hidden rounded-xl border ${tone === "you" ? "border-amber-600/50 bg-amber-950/10" : "border-gray-800 bg-gray-900/40"}`}>{children}</ul>
    </section>
  );
}

function Row({ r, onOpen, action }: { r: CaseRow; onOpen: (key: string) => void; action?: string }) {
  const p = r.plain;
  return (
    <li>
      <button onClick={() => onOpen(r.caseKey)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/40">
        <Avatar name={p.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-gray-100">
            <span className="font-medium">{p.name}</span>
            <span className="text-gray-400"> · {p.want ?? "not clear yet"}</span>
          </span>
          <span className="block truncate text-[12px] text-gray-500">
            {[p.from, p.to].filter(Boolean).join(" → ")}
          </span>
        </span>
        <span className="hidden min-w-0 max-w-[45%] items-center gap-2 sm:flex">
          <span className={`size-2 shrink-0 rounded-full ${TONE_DOT[p.status.tone]}`} aria-hidden="true" />
          <span className={`truncate text-[13px] ${p.status.tone === "you" ? "text-amber-200" : p.status.tone === "done" ? "text-emerald-300" : "text-gray-300"}`}>{p.status.short}</span>
        </span>
        {action ? (
          <span className="shrink-0 rounded-md border border-amber-500 bg-amber-500/20 px-3 py-1 text-xs font-medium text-amber-50">{action}</span>
        ) : (
          <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-gray-500">{dayLabel(r.ageDays)}</span>
        )}
      </button>
    </li>
  );
}

// ── one case ────────────────────────────────────────────────────────────────

/** How a pretend client's case is meant to end, in words. */
const EXPECTED: Record<string, string> = {
  completed: "done",
  "closed:ineligible": "turned down by the rules",
  "closed:no-reply": "closed, no reply",
  "closed:declined": "not submitted",
  "closed:refused": "refused by the authority",
  "closed:not-required": "no visa needed",
  "closed:documents-incomplete": "closed, documents missing",
};

const BANNER: Record<Tone, string> = {
  working: "border-gray-600 bg-gray-800/50 text-gray-100",
  you: "border-amber-500/70 bg-amber-950/40 text-amber-50",
  person: "border-amber-700/50 bg-amber-950/20 text-amber-100",
  done: "border-emerald-700/60 bg-emerald-950/30 text-emerald-50",
  closed: "border-gray-700 bg-gray-950/60 text-gray-200",
  bad: "border-red-700/70 bg-red-950/40 text-red-100",
};

export function CasePage({
  caseKey,
  guide,
  onBack,
  nextWaiting,
  onOpen,
}: {
  caseKey: string;
  guide: Guide | null;
  onBack: () => void;
  /** Another case waiting for you, to offer once this one is answered. */
  nextWaiting: CaseRow | null;
  onOpen: (key: string) => void;
}) {
  const [d, setD] = useState<CaseDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    let alive = true;
    setD(null);
    setAnswered(false);
    const load = async () => {
      try {
        const c = await lab<CaseDetail>(`api/cases/${encodeURIComponent(caseKey)}`);
        if (alive) {
          setD(c);
          setErr(null);
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const iv = setInterval(() => !document.hidden && load(), 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [caseKey]);

  const back = (
    <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-200">
      ← All clients
    </button>
  );
  // A failed refresh keeps the last good story on screen; only a case that
  // never loaded shows the error in its place.
  if (!d)
    return (
      <div className="space-y-3">
        {back}
        <p className={`text-xs ${err ? "text-red-300" : "text-gray-500"}`}>{err ?? "Loading…"}</p>
      </div>
    );

  const p = d.people;
  const v = d.variables;
  const yourTurn = d.now.needsPerson && d.by === "you" && !answered;
  // A case started by hand has no pretend client: you send its documents.
  const handMade = !d.simRunId && d.state === "ACTIVE" && d.current.includes("gw_wait");

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        {d.truth && (
          <span className="rounded-full border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400" title="A made-up client: the lab knows how this case should end, and checks itself against it.">
            pretend client · should end: {EXPECTED[String(d.truth.expected)] ?? String(d.truth.expected)}
          </span>
        )}
      </div>

      <header className="flex items-start gap-3">
        <Avatar name={p.name} size="lg" />
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-gray-50">{p.name}</h3>
          <p className="text-sm text-gray-400">
            {[p.from && `from ${p.from}`, p.to && `moving to ${p.to}`, p.language && p.language !== "English" && `writes in ${p.language}`].filter(Boolean).join(" · ")}
          </p>
          <p className="mt-1 text-sm text-gray-300">
            Wants: <b className="font-medium text-gray-100">{p.want ?? "not clear yet"}</b>
            {v.agencyFee != null && (
              <span className="text-gray-500">
                {" "}
                · price €{String(v.agencyFee)}, done within {String(v.slaDays)} days
              </span>
            )}
          </p>
        </div>
      </header>

      <div className={`rounded-lg border px-4 py-3 text-sm ${BANNER[d.now.tone] ?? BANNER.working}`}>
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide opacity-70">{d.state === "ACTIVE" ? "Right now" : "How it ended"}</span>
        {d.now.text}
      </div>
      {err && <p className="-mt-3 text-[11px] text-amber-300">Couldn&apos;t refresh just now ({err}); showing the last update.</p>}

      {yourTurn && <YourTurn key={d.now.needsPerson} caseKey={caseKey} onDone={() => setAnswered(true)} />}
      {answered && nextWaiting && nextWaiting.caseKey !== caseKey && (
        <button onClick={() => onOpen(nextWaiting.caseKey)} className="w-full rounded-lg border border-amber-600/60 px-4 py-2 text-left text-sm text-amber-100 hover:bg-amber-950/30">
          Next waiting for you: <b>{nextWaiting.plain.name}</b> — {nextWaiting.plain.status.short.replace(/^Waiting for you: /, "")} →
        </button>
      )}
      {handMade && <Upload caseKey={caseKey} name={p.firstName} />}

      <Stepper stages={d.stages} />

      <Story entries={d.story} stages={d.stages} />

      <Fold title="Behind the scenes" hint="the process diagram, every decision with its model and timing, the raw documents and emails">
        <BehindTheScenes d={d} guide={guide} />
      </Fold>
    </section>
  );
}

/** The six stages as one line: done ✓, now ●, still to come ○, never reached —. */
function Stepper({ stages }: { stages: Stage[] }) {
  const current = stages.find((s) => s.state === "current");
  return (
    <div>
      <ol className="flex flex-wrap items-center gap-y-2">
        {stages.map((s, i) => {
          const dot =
            s.state === "done"
              ? "border-emerald-500 bg-emerald-500 text-gray-950"
              : s.state === "current"
                ? "border-orange-400 bg-orange-400/20 text-orange-200 ring-2 ring-orange-400/30"
                : "border-gray-700 bg-gray-900 text-gray-600";
          return (
            <li key={s.id} className="flex items-center" title={s.about}>
              <span className={`grid size-6 place-items-center rounded-full border text-[11px] font-bold ${dot}`}>{s.state === "done" ? "✓" : s.state === "skipped" ? "–" : i + 1}</span>
              <span className={`ml-1.5 text-sm ${s.state === "current" ? "font-semibold text-orange-200" : s.state === "done" ? "text-gray-200" : "text-gray-500"} ${s.state === "skipped" ? "line-through" : ""}`}>{s.label}</span>
              {i < stages.length - 1 && <span className={`mx-2 h-px w-6 sm:w-10 ${s.state === "done" ? "bg-emerald-600" : "bg-gray-700"}`} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {current && <p className="mt-2 text-xs text-gray-500">{current.label}: {current.about}</p>}
    </div>
  );
}

const HOW_KEY = "process-lab-show-how";

function Story({ entries, stages }: { entries: StoryEntry[]; stages: Stage[] }) {
  const [how, setHow] = useState(false);
  const [key, setKey] = useState(false);
  useEffect(() => {
    try {
      setHow(localStorage.getItem(HOW_KEY) === "1");
    } catch {}
  }, []);
  const label = (id: string | null) => stages.find((s) => s.id === id)?.label ?? "";
  let lastStage: string | null = null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-100">What has happened</h4>
        <div className="flex items-center gap-4 text-[12px] text-gray-400">
          <button onClick={() => setKey(!key)} className="underline-offset-2 hover:underline">
            {key ? "Hide the key" : "Who's who?"}
          </button>
          <label className="flex cursor-pointer items-center gap-1.5" title="Which AI model answered, how sure it was, which rule table applied">
            <input
              type="checkbox"
              className="accent-orange-500"
              checked={how}
              onChange={(e) => {
                setHow(e.target.checked);
                try {
                  localStorage.setItem(HOW_KEY, e.target.checked ? "1" : "0");
                } catch {}
              }}
            />
            Show how
          </label>
        </div>
      </div>
      {key && (
        <div className="mb-3">
          <ActorKey />
        </div>
      )}
      <ol>
        {entries.map((e, i) => {
          const header = e.stage && e.stage !== lastStage;
          lastStage = e.stage ?? lastStage;
          return (
            <StoryLine key={i} e={e} how={how} header={header ? label(e.stage) : null} />
          );
        })}
      </ol>
    </div>
  );
}

function StoryLine({ e, how, header }: { e: StoryEntry; how: boolean; header: string | null }) {
  const [open, setOpen] = useState(false);
  // An email or a brief to read opens in place, under its line.
  const more = !!(e.email || e.quote);
  return (
    <>
      {header && <li className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{header}</li>}
      <li className={`flex items-start gap-3 rounded-md px-2 py-1.5 ${e.active ? (e.needsPerson && e.by === "you" ? "bg-amber-500/[0.08]" : "bg-gray-800/40") : ""}`}>
        <span className={`w-14 shrink-0 pt-0.5 text-right text-[11px] tabular-nums ${e.active ? "font-semibold text-orange-300" : "text-gray-500"}`} title={e.active ? `Since ${dayLabel(e.day).toLowerCase()}` : undefined}>
          {e.active ? "now" : dayLabel(e.day)}
        </span>
        <ActorBadge kind={e.kind} by={e.by} />
        <div className="min-w-0 flex-1 text-[13px] leading-snug text-gray-300">
          <span dir="auto">{rich(e.text)}</span>
          {e.flag && <span className="ml-2 rounded bg-red-950 px-1.5 py-0.5 text-[10px] text-red-300">{e.flag}</span>}
          {e.docUrl && (
            <a href={fileUrl(e.docUrl)} target="_blank" rel="noreferrer" className="ml-2 text-[11px] text-gray-500 underline">
              see it
            </a>
          )}
          {more && (
            <button onClick={() => setOpen(!open)} className="ml-2 text-[11px] text-gray-500 underline">
              {open ? "hide" : e.email ? "read the email" : "read it"}
            </button>
          )}
          {open && e.email && (
            <div className="mt-2 rounded-md border border-gray-800 bg-gray-950/60 p-3 text-xs">
              <p className="font-medium text-gray-200" dir="auto">
                {e.email.subject}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-gray-400" dir="auto">
                {e.email.body}
              </p>
            </div>
          )}
          {open && !e.email && e.quote && <p className="mt-1 border-l-2 border-gray-700 pl-2 text-[12px] text-gray-400">{e.quote}</p>}
          {how && e.how && <p className="mt-0.5 text-[11px] text-gray-500">{e.how}</p>}
        </div>
      </li>
    </>
  );
}

function BehindTheScenes({ d, guide }: { d: CaseDetail; guide: Guide | null }) {
  const [xml, setXml] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  useEffect(() => {
    lab<{ bpmn20Xml: string }>(`api/definitions/${encodeURIComponent(d.definitionId)}/xml`).then((r) => setXml(r.bpmn20Xml), () => {});
  }, [d.definitionId]);
  const visited = useMemo(() => [...new Set(d.activities.filter((a) => a.end).map((a) => a.id))], [d.activities]);
  return (
    <div className="space-y-4">
      <div>
        <h5 className="mb-2 text-xs font-semibold text-gray-300">The process diagram — click any step</h5>
        {xml ? (
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
            <BpmnView xml={xml} current={d.current} visited={visited} failed={d.incidents.map((i) => i.activityId)} selected={step} onSelect={setStep} />
            <StepHelp id={step} guide={guide} story={d.story} />
          </div>
        ) : (
          <p className="text-xs text-gray-500">Loading the diagram…</p>
        )}
      </div>
      {d.incidents.length > 0 && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-200">
          {d.incidents.map((i) => (
            <p key={i.activityId + i.time}>
              <b>{guide?.steps[i.activityId]?.name ?? i.activityId}</b>: {i.message}
            </p>
          ))}
          <p className="mt-1 text-red-300/70">Retry it from Cockpit (Incidents → Increment retries), or fix the cause and wait for the next retry.</p>
        </div>
      )}
      <div>
        <h5 className="mb-2 text-xs font-semibold text-gray-300">Every decision, with its model, confidence, time and cost</h5>
        <DecisionTable decisions={d.decisions} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h5 className="mb-2 text-xs font-semibold text-gray-300">Documents</h5>
          {d.documents.length === 0 && <p className="text-xs text-gray-600">None received.</p>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {d.documents.map((doc) => (
              <a key={doc.id} href={fileUrl(doc.url)} target="_blank" rel="noreferrer" className="block rounded-lg border border-gray-800 p-1.5 hover:border-gray-600">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(doc.url)} alt={`document ${doc.id}`} className="h-20 w-full rounded object-cover object-top" />
                <p className="mt-1 truncate text-[11px] text-gray-300">
                  {String(doc.extraction?.docType ?? "unread")} {doc.extraction?.language ? `(${String(doc.extraction.language)})` : ""}
                </p>
                <p className={`truncate text-[10px] ${doc.accepted ? "text-emerald-400" : doc.problem ? "text-amber-300" : "text-gray-500"}`}>
                  round {doc.round} · {doc.accepted ? "accepted" : doc.problem ?? "not read yet"}
                </p>
              </a>
            ))}
          </div>
          {d.artifacts
            .filter((a) => a.kind === "audio")
            .map((a) => (
              <div key={a.id} className="mt-3">
                <p className="mb-1 text-[11px] text-gray-500">Spoken status update</p>
                <audio controls src={fileUrl(a.url)} className="w-full" />
              </div>
            ))}
        </div>
        <div className="space-y-2">
          <h5 className="mb-2 text-xs font-semibold text-gray-300">Emails</h5>
          {d.emails.length === 0 && <p className="text-xs text-gray-600">None yet.</p>}
          {d.emails.map((e) => (
            <details key={e.id} className="rounded-lg border border-gray-800 px-3 py-2">
              <summary className="cursor-pointer text-xs text-gray-200">
                <span className="mr-2 rounded bg-gray-800 px-1.5 text-[10px] text-gray-400">{e.purpose}</span>
                {e.subject}
              </summary>
              <p dir={e.language === "ar" ? "rtl" : "ltr"} className="mt-2 whitespace-pre-wrap text-xs text-gray-400">
                {e.body}
              </p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A case started by hand has no pretend client: you play the client and send the documents it asked for. */
function Upload({ caseKey, name }: { caseKey: string; name: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toData = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = rej;
      r.readAsDataURL(f);
    });
  return (
    <section className="rounded-xl border border-amber-500/60 bg-amber-950/20 p-4 text-sm">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300">Your turn — as {name}</p>
      <p className="mb-3 text-gray-300">You started this client by hand, so you play {name} too. Send the documents the agency asked for (photos or scans, PNG or JPEG).</p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <input type="file" multiple accept="image/png,image/jpeg" onChange={(e) => setFiles([...(e.target.files ?? [])])} className="text-gray-300" />
        <button
          disabled={busy || !files.length}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const payload = await Promise.all(files.map(async (f) => ({ name: f.name, dataBase64: await toData(f) })));
              const r = await lab<{ round: number; files: number }>(`api/cases/${encodeURIComponent(caseKey)}/documents`, { method: "POST", body: JSON.stringify({ files: payload }) });
              setMsg(`Sent ${r.files} document${r.files === 1 ? "" : "s"}.`);
              setFiles([]);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg border border-amber-500 bg-amber-500/20 px-3 py-1.5 font-medium text-amber-50 disabled:opacity-50"
        >
          Send them
        </button>
        {msg && <span className="text-amber-200">{msg}</span>}
      </div>
    </section>
  );
}
