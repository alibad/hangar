"use client";

import { useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Code2,
  ExternalLink,
  Laptop,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

const REPOSITORY_URL = "https://github.com/alibad/hangar";
const OLLAMA_URL = "https://ollama.com/download";
const NODE_URL = "https://nodejs.org/en/download";

const AGENTS = {
  codex: {
    label: "Codex",
    skillUrl: `${REPOSITORY_URL}/blob/main/.agents/skills/hangar-setup/SKILL.md`,
  },
  claude: {
    label: "Claude Code",
    skillUrl: `${REPOSITORY_URL}/blob/main/.claude/skills/hangar-setup/SKILL.md`,
  },
} as const;

type AgentId = keyof typeof AGENTS;

function setupPrompt(agent: (typeof AGENTS)[AgentId]) {
  return `Use the Hangar setup skill at:
${agent.skillUrl}

Set up Hangar on this machine. Measure the machine first, choose a local model that fits, configure only services you verify, and prove the console works locally before you finish.`;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button type="button" onClick={copy} className="inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-orange-400">
      {copied ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
      {copied ? "Copied" : label}
    </button>
  );
}

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
      <pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-6 text-gray-300"><code>{command}</code></pre>
    </div>
  );
}

export default function HostedOnboarding() {
  const [agentId, setAgentId] = useState<AgentId>("codex");
  const agent = AGENTS[agentId];
  const agentPrompt = setupPrompt(agent);

  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden rounded-3xl border border-orange-500/25 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.16),transparent_42%),linear-gradient(135deg,rgba(17,24,39,0.96),rgba(3,7,18,0.98))] px-5 py-8 sm:px-8 sm:py-12">
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/25 bg-orange-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-orange-300">
            <Sparkles className="h-3.5 w-3.5" /> Local AI, fitted to your machine
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-[-0.04em] text-white sm:text-5xl">
            Set up your local AI stack with one skill.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-gray-400 sm:text-base">
            Choose Codex or Claude Code. Your agent measures your Mac, Windows PC, or Linux box,
            finds what is installed, chooses a local LLM that fits, and launches your private Hangar
            console at <span className="font-mono text-gray-200">localhost:8003</span>.
          </p>

          <div className="mx-auto mt-7 max-w-3xl rounded-2xl border border-violet-500/25 bg-violet-500/[0.07] p-3 text-left sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 px-1 text-xs font-semibold text-violet-200">
                <Bot className="h-4 w-4" /> Pick your coding agent, then paste the prompt
              </div>
              <div className="grid grid-cols-2 rounded-xl border border-gray-800 bg-gray-950/70 p-1" aria-label="Choose your coding agent">
                {(Object.entries(AGENTS) as [AgentId, (typeof AGENTS)[AgentId]][]).map(([id, option]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAgentId(id)}
                    aria-pressed={agentId === id}
                    className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${agentId === id ? "bg-violet-500/20 text-violet-100" : "text-gray-500 hover:text-gray-200"}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-gray-800 bg-gray-950/80 p-4 font-mono text-xs leading-6 text-gray-300">{agentPrompt}</pre>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <CopyButton value={agentPrompt} label={`Copy for ${agent.label}`} />
              <a href={agent.skillUrl} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-950/45 px-4 py-3 text-sm font-semibold text-gray-200 transition hover:border-gray-500">
                Open {agent.label} skill <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          <p className="mt-4 text-xs text-gray-600">
            Open source · local by default · no account required. This website is the launch point, not the console running on your computer.
          </p>
        </div>
      </section>

      <section className="grid gap-px overflow-hidden rounded-2xl border border-gray-800 bg-gray-800 sm:grid-cols-2 lg:grid-cols-4" aria-label="Setup outcomes">
        {["Measures RAM + GPU", "Uses what is installed", "Chooses a fitting local LLM", "Verifies before it finishes"].map((outcome) => (
          <div key={outcome} className="flex items-center gap-2 bg-gray-950 px-4 py-3 text-xs font-medium text-gray-300">
            <Check className="h-4 w-4 shrink-0 text-emerald-400" /> {outcome}
          </div>
        ))}
      </section>

      <section className="grid gap-3 md:grid-cols-3" aria-label="What the Hangar skill does">
        <article className="rounded-2xl border border-gray-800 bg-gray-900/60 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-500/20 bg-sky-500/[0.08] text-sky-300"><Laptop className="h-5 w-5" /></span>
          <h2 className="mt-4 text-sm font-semibold text-gray-100">1. Inspects your machine</h2>
          <p className="mt-2 text-xs leading-5 text-gray-500">Detects macOS, Windows, or Linux, available memory, accelerators, Ollama, and reachable local services.</p>
        </article>
        <article className="rounded-2xl border border-gray-800 bg-gray-900/60 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-orange-500/20 bg-orange-500/[0.08] text-orange-300"><Code2 className="h-5 w-5" /></span>
          <h2 className="mt-4 text-sm font-semibold text-gray-100">2. Configures Hangar</h2>
          <p className="mt-2 text-xs leading-5 text-gray-500">Creates a profile for this computer and wires only the models and capabilities it can prove are available.</p>
        </article>
        <article className="rounded-2xl border border-gray-800 bg-gray-900/60 p-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-300"><CheckCircle2 className="h-5 w-5" /></span>
          <h2 className="mt-4 text-sm font-semibold text-gray-100">3. Proves it works</h2>
          <p className="mt-2 text-xs leading-5 text-gray-500">Runs the tests, starts the console, checks the host profile, and verifies the local model service responds.</p>
        </article>
      </section>

      <details className="group overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/55">
        <summary className="flex cursor-pointer list-none items-center gap-3 p-5 text-sm font-semibold text-gray-200 transition hover:bg-gray-900">
          <TerminalSquare className="h-5 w-5 text-orange-300" />
          Prefer to install it yourself?
          <span className="ml-1 font-normal text-gray-600">Show the manual steps</span>
          <ChevronDown className="ml-auto h-4 w-4 text-gray-500 transition group-open:rotate-180" />
        </summary>
        <div className="grid gap-4 border-t border-gray-800 p-5 lg:grid-cols-2">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-100">Install the basics</h2>
            <p className="text-xs leading-5 text-gray-500">Install Git, <a href={NODE_URL} target="_blank" rel="noreferrer" className="text-orange-300 hover:text-orange-200">Node.js 22+</a>, and <a href={OLLAMA_URL} target="_blank" rel="noreferrer" className="text-orange-300 hover:text-orange-200">Ollama</a>, then clone Hangar.</p>
            <CommandBlock label="Clone and install" command={`git clone https://github.com/alibad/hangar.git\ncd hangar\nnpm install`} />
          </div>
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-100">Add a local model and start</h2>
            <p className="text-xs leading-5 text-gray-500">Qwen3 8B is a sensible first local text model. The setup skill can choose a better fit after checking your hardware.</p>
            <CommandBlock label="Model and console" command={`ollama pull qwen3:8b\nnode scripts/detect-host.mjs\nnpm run dev`} />
          </div>
        </div>
      </details>

      <section className="flex flex-col gap-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] p-5 sm:flex-row sm:items-center">
        <ShieldCheck className="h-8 w-8 shrink-0 text-emerald-300" />
        <div>
          <h2 className="text-sm font-semibold text-emerald-100">Your models stay on your machine</h2>
          <p className="mt-1 text-xs leading-5 text-gray-500">This public site is only the setup guide. The working console and its machine APIs run locally; the public Human Quest domains cannot reach them.</p>
        </div>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-emerald-200 hover:text-emerald-100 sm:ml-auto">
          View source <ArrowRight className="h-4 w-4" />
        </a>
      </section>
    </div>
  );
}
