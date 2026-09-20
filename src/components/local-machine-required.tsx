"use client";

import { Cloud, Laptop, ShieldCheck } from "lucide-react";

export function HostedRuntimeNotice() {
  return (
    <section className="rounded-2xl border border-sky-500/25 bg-sky-500/[0.06] px-4 py-3 sm:px-5" aria-label="Hosted Hangar mode">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-300">
          <Cloud className="h-4 w-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-sky-100">Hosted Hangar</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-sky-100/70">
            Remote-backed tools can run here. Anything that needs this browser&apos;s own drives,
            files, developer history, or installed models is replaced with a local-machine notice.
          </p>
        </div>
      </div>
    </section>
  );
}

export default function LocalMachineRequired({
  title,
  description,
  available,
  compact = false,
}: {
  title: string;
  description: string;
  available: string[];
  compact?: boolean;
}) {
  return (
    <section
      data-local-machine-required="true"
      role="status"
      className={`mx-auto rounded-2xl border border-amber-500/25 bg-amber-500/[0.05] ${compact ? "p-4" : "max-w-3xl p-6 sm:p-8"}`}
    >
      <div className={compact ? "flex items-start gap-3" : "text-center"}>
        <span className={`${compact ? "" : "mx-auto mb-4"} flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300`}>
          <Laptop className="h-5 w-5" />
        </span>
        <div className={compact ? "min-w-0" : ""}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400/80">Local machine required</p>
          <h2 className="mt-1 text-lg font-semibold text-gray-100">{title}</h2>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-gray-400">{description}</p>
        </div>
      </div>

      <div className={`mt-5 grid gap-3 ${compact ? "sm:grid-cols-2" : "sm:grid-cols-[1fr_auto]"}`}>
        <div className="rounded-xl border border-gray-800 bg-gray-950/55 p-4 text-left">
          <div className="flex items-center gap-2 text-xs font-medium text-gray-200"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Available when Hangar runs locally</div>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            {available.map((item) => <li key={item}>• {item}</li>)}
          </ul>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-950/55 p-4 text-left">
          <p className="text-xs font-medium text-gray-200">Run the local console</p>
          <code className="mt-2 block whitespace-pre rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-400">npm install{"\n"}npm run build{"\n"}npm start</code>
          <p className="mt-2 text-[11px] text-gray-600">Then open http://localhost:8003.</p>
        </div>
      </div>
    </section>
  );
}
