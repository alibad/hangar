"use client";

import { WarningCircle } from "@phosphor-icons/react";

/**
 * Shown when the console is rendering a host profile that is not this machine.
 *
 * Host resolution ends in a guess — a Mac with no matching profile becomes
 * `b5`, everything else becomes the default — which is correct for the machines
 * this was built on and wrong for every new one. Without this, a stranger's
 * first run looks like a working console: it has a machine name, a service
 * list, workstreams, a memory bar. All of it belongs to somebody else's
 * computer, and nothing on the page says so. The services are simply "down",
 * which reads as a broken install rather than a profile that was never written.
 *
 * So this is the one piece of onboarding the product needs: not a tour, just
 * the sentence that stops someone debugging the wrong problem. It disappears
 * the moment a profile matching this hostname exists, which is also exactly
 * when the console starts telling the truth.
 */
export default function ForeignProfileNotice({
  profile,
  profileId,
  machine,
}: {
  profile: string;
  profileId: string;
  machine: string;
}) {
  const suggested = machine.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]/g, "-");
  return (
    <section
      className="mb-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3.5 sm:px-5"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <WarningCircle size={18} weight="fill" className="mt-0.5 flex-shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-amber-200">
            This is not your machine&apos;s profile yet
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-amber-100/80">
            You are looking at <strong className="font-semibold">{profile}</strong>, a profile that
            ships with Hangar as an example. This computer is{" "}
            <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">{machine}</code>.
            Every service and workstream below belongs to {profile}, so they will read as down or
            unavailable until you describe this machine instead.
          </p>

          <p className="mt-2.5 text-xs font-medium text-amber-200">Two ways to fix it</p>
          <ol className="mt-1 space-y-1.5 text-xs leading-relaxed text-amber-100/80">
            <li>
              <strong className="font-semibold text-amber-100">Ask an agent.</strong> Open this
              repository in Claude Code or Codex and run{" "}
              <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">/hangar-setup</code>
              . It probes what is actually listening here, writes the profile, and registers it.
            </li>
            <li>
              <strong className="font-semibold text-amber-100">Or by hand.</strong> Copy{" "}
              <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">
                config/hosts/example.json
              </code>{" "}
              to{" "}
              <code className="rounded bg-black/30 px-1 py-0.5 font-mono text-[11px]">
                config/hosts/{suggested}.json
              </code>
              , set <code className="font-mono text-[11px]">id</code> to{" "}
              <code className="font-mono text-[11px]">{suggested}</code>, and follow the two
              one-line edits noted at the end of that file.
            </li>
          </ol>

          <p className="mt-2.5 text-[11px] leading-relaxed text-amber-100/60">
            Nothing here is broken — the console simply has not been told what this box runs.
            Showing {profileId}&apos;s services is a fallback, not a detection.
          </p>
        </div>
      </div>
    </section>
  );
}
