"use client";

import { WarningCircle } from "@phosphor-icons/react";
import { getHost, tabSupport } from "@/lib/host";

/**
 * What a surface says on a machine that cannot back it.
 *
 * The console is ONE product. Dropping tabs on a host that lacks their services
 * made it read as a different, smaller app and hid the thing you actually want
 * to know — what this box can and cannot do. So every surface exists on every
 * host; this is what the ones with nothing behind them here show instead of a
 * view that would spin, error, or quietly return empty.
 *
 * It names what is missing rather than saying "unavailable", because the fix is
 * always the same shape: register something in this host's profile that serves
 * it, and give it a start command. For a capability-backed tab that is a
 * CAPABILITY — "speech-to-text", not "a service called whisper" — because the
 * capability is the thing the reader wants and the service name is trivia.
 */
export default function HostUnavailable({ tab, title }: { tab: string; title: string }) {
  const host = getHost();
  const { kind, missing, missingLabels } = tabSupport(tab);
  const plural = missingLabels.length === 1 ? "is" : "are";

  return (
    <section
      role="status"
      className="mx-auto max-w-2xl rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-6 text-center"
    >
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300">
        <WarningCircle size={20} weight="duotone" />
      </span>
      <h2 className="text-sm font-semibold text-gray-100">
        {title} is not available on {host.name}
      </h2>
      <p className="mx-auto mt-2 max-w-prose text-[13px] leading-relaxed text-gray-400">
        It needs{" "}
        <span className="font-medium text-gray-200">{missingLabels.join(" or ")}</span>
        {kind === "capability"
          ? `, and no service on this machine declares that it serves ${missingLabels.length === 1 ? "it" : "them"}.`
          : `, which ${plural} not registered on this machine.`}{" "}
        The tab stays here so the gap is visible rather than silently missing — on a
        host that has {missing.length === 1 ? "it" : "them"}, this is the live view.
      </p>
      <p className="mt-3 text-[11px] text-gray-600">
        Services are declared per machine in{" "}
        <code className="rounded bg-gray-800/70 px-1.5 py-0.5 text-gray-400">
          config/hosts/{host.id}.json
        </code>
        , with start commands in{" "}
        <code className="rounded bg-gray-800/70 px-1.5 py-0.5 text-gray-400">
          scripts/{host.commandsFile}
        </code>
        .
      </p>
    </section>
  );
}
