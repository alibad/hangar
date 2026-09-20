"use client";

import { useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  Laptop,
  LockKeyhole,
  MessageSquareText,
  Network,
  ServerCog,
  TerminalSquare,
} from "lucide-react";

const REPOSITORY_URL = "https://github.com/alibad/hangar";
const OLLAMA_URL = "https://ollama.com/download";
const NODE_URL = "https://nodejs.org/en/download";

function CommandBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-gray-800 bg-black/35">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-gray-600">{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 transition hover:text-gray-200">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Clipboard className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-6 text-gray-300"><code>{command}</code></pre>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <article className="grid gap-3 rounded-2xl border border-gray-800 bg-gray-900/70 p-4 sm:grid-cols-[44px_minmax(0,1fr)] sm:p-5">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-orange-500/30 bg-orange-500/10 text-sm font-bold text-orange-300">{number}</span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-gray-100">{title}</h2>
        <div className="mt-2 space-y-3 text-sm leading-relaxed text-gray-400">{children}</div>
      </div>
    </article>
  );
}

export default function HostedOnboarding() {
  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-3xl border border-orange-500/25 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.15),transparent_42%),linear-gradient(135deg,rgba(17,24,39,0.96),rgba(3,7,18,0.98))] px-5 py-7 sm:px-8 sm:py-10">
        <div className="relative max-w-4xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/25 bg-orange-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-orange-300">
            <Laptop className="h-3.5 w-3.5" /> Local setup guide
          </div>
          <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">
            Hangar becomes useful when it runs beside your models.
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-gray-400 sm:text-base">
            This website cannot see your computer, start your LLM, or manage its memory. Run Hangar on the machine that owns the model, then use the local console at <span className="font-mono text-gray-200">localhost:8003</span>.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-400">
              <Code2 className="h-4 w-4" /> Open Hangar repository <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <a href={OLLAMA_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-gray-700 bg-gray-950/45 px-4 py-2.5 text-sm font-medium text-gray-200 transition hover:border-gray-500">
              <Download className="h-4 w-4" /> Download Ollama
            </a>
          </div>
          <p className="mt-3 flex items-start gap-2 text-xs text-amber-200/75">
            <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The Hangar repository is currently private. GitHub access is required before the clone command below will work.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-gray-800 bg-gray-900/55 p-4 sm:p-5" aria-label="How local Hangar works">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">What you are setting up</p>
        <div className="mt-4 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-200"><MessageSquareText className="h-4 w-4 text-sky-300" /> Your browser</span>
            <p className="mt-1 text-xs text-gray-600">The interface you use</p>
          </div>
          <ArrowRight className="hidden h-4 w-4 text-gray-700 md:block" />
          <div className="rounded-xl border border-orange-500/25 bg-orange-500/[0.06] p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-100"><ServerCog className="h-4 w-4 text-orange-300" /> Hangar on localhost</span>
            <p className="mt-1 text-xs text-gray-500">Routes work and manages services</p>
          </div>
          <ArrowRight className="hidden h-4 w-4 text-gray-700 md:block" />
          <div className="rounded-xl border border-gray-800 bg-gray-950/50 p-3">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-200"><Cpu className="h-4 w-4 text-emerald-300" /> Ollama + local LLM</span>
            <p className="mt-1 text-xs text-gray-600">Inference stays on your machine</p>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3" aria-label="Local installation steps">
          <Step number={1} title="Install the three prerequisites">
            <p>You need Git, Node.js 22 or newer, and Ollama. Installers are available from <a href={NODE_URL} target="_blank" rel="noreferrer" className="text-orange-300 hover:text-orange-200">Node.js</a> and <a href={OLLAMA_URL} target="_blank" rel="noreferrer" className="text-orange-300 hover:text-orange-200">Ollama</a>.</p>
            <CommandBlock label="Verify prerequisites" command={`node --version\ngit --version\nollama --version`} />
          </Step>

          <Step number={2} title="Install and test one local LLM">
            <p>Qwen3 8B is a practical first model for a machine with roughly 8 GB of free memory. Ollama downloads about 5.2 GB for this checkpoint.</p>
            <CommandBlock label="Download and verify the model" command={`ollama pull qwen3:8b\nollama run qwen3:8b "Reply with exactly: LOCAL MODEL OK"`} />
          </Step>

          <Step number={3} title="Clone and install Hangar">
            <p>Sign into GitHub with an account that can access the private repository, then install the application dependencies.</p>
            <CommandBlock label="Install Hangar" command={`git clone https://github.com/alibad/hangar.git\ncd hangar\nnpm install`} />
          </Step>

          <Step number={4} title="Teach Hangar about this machine">
            <p>Run the detector first. It measures your operating system, memory layout, accelerator, Ollama endpoint, and installed models without changing anything.</p>
            <CommandBlock label="Inspect this machine" command="node scripts/detect-host.mjs" />
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-3">
              <p className="flex items-center gap-2 text-xs font-medium text-violet-200"><TerminalSquare className="h-4 w-4" /> Recommended configuration</p>
              <p className="mt-1 text-xs text-gray-500">Open the cloned folder in Codex or Claude Code and send this instruction:</p>
              <div className="mt-2"><CommandBlock label="Agent instruction" command="Configure Hangar for this machine using .claude/skills/hangar-setup/SKILL.md. Use qwen3:8b from Ollama as the text model, verify the profile, and do not expose any service publicly." /></div>
            </div>
          </Step>

          <Step number={5} title="Start the local console">
            <CommandBlock label="Run Hangar" command="npm run dev" />
            <p>Keep that terminal open, then visit <a href="http://localhost:8003" target="_blank" rel="noreferrer" className="font-mono text-orange-300 hover:text-orange-200">http://localhost:8003</a>.</p>
          </Step>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-300/80">You are finished when</p>
            <ul className="mt-3 space-y-3 text-xs leading-relaxed text-gray-400">
              <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Home shows your machine&apos;s name—not BeTenshi or B5.</li>
              <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Services shows Ollama as Ready.</li>
              <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Models lists <span className="font-mono text-gray-300">qwen3:8b</span> as local.</li>
              <li className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> Chat answers a prompt and identifies Ollama as the target.</li>
            </ul>
            <a href="http://localhost:8003/#llm" target="_blank" rel="noreferrer" className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/15">
              Open local Chat <ArrowRight className="h-4 w-4" />
            </a>
          </section>

          <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.05] p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-sky-100"><Network className="h-4 w-4 text-sky-300" /> Keep it private</p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">Hangar and Ollama are intended to run on the same machine. Do not bind an unauthenticated model endpoint to the public internet. Add remote access only after authentication is deliberately configured.</p>
          </section>

          <section className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-100"><CircleAlert className="h-4 w-4 text-amber-300" /> Already have Ollama?</p>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">Start at step 3. The detector will list the models already installed at <span className="font-mono text-gray-400">localhost:11434</span>; use one of those when configuring the profile.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
