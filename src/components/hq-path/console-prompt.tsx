"use client";
// The main call to action: pick a coding agent, then copy the setup prompt.
// Same agents, links and prompt text as the live guide (src/components/hosted-onboarding.tsx).
import { useState } from "react";

export const REPOSITORY_URL = "https://github.com/alibad/hangar";
const NODE_URL = "https://nodejs.org/en/download";
const OLLAMA_URL = "https://ollama.com/download";

const AGENTS = {
  codex: { label: "Codex", skillUrl: `${REPOSITORY_URL}/blob/main/.agents/skills/hangar-setup/SKILL.md` },
  claude: { label: "Claude Code", skillUrl: `${REPOSITORY_URL}/blob/main/.claude/skills/hangar-setup/SKILL.md` },
} as const;
type AgentId = keyof typeof AGENTS;

function setupPrompt(agent: (typeof AGENTS)[AgentId]) {
  return `Use the Hangar setup skill at:
${agent.skillUrl}

Set up Hangar on this machine. Measure the machine first, choose a local model that fits, configure only services you verify, and prove the console works locally before you finish.`;
}

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok;
  } catch { return false; }
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => { if (await copyText(text)) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } };
  return { copied, copy };
}

const Icon = {
  copy: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></svg>,
  check: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  out: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16L16 8M9.5 8H16v6.5" /></svg>,
};

export function ConsolePrompt() {
  const [agentId, setAgentId] = useState<AgentId>("codex");
  const agent = AGENTS[agentId];
  const prompt = setupPrompt(agent);
  const { copied, copy } = useCopy();
  const [first, ...rest] = prompt.split("\n");

  return (
    <div className="hqcp-prompt">
      <div className="hqcp-prompt-head">
        <p className="hqcp-prompt-title">Pick your coding agent, then paste the prompt</p>
        <div className="hqcp-seg" role="group" aria-label="Choose your coding agent">
          {(Object.entries(AGENTS) as [AgentId, (typeof AGENTS)[AgentId]][]).map(([id, a]) => (
            <button key={id} type="button" aria-pressed={agentId === id} onClick={() => setAgentId(id)}>{a.label}</button>
          ))}
        </div>
      </div>
      <div className="hqcp-code" aria-label={`Setup prompt for ${agent.label}`}>
        <span className="hqcp-code-tag">prompt · {agent.label}</span>
        <pre><code>{first}{"\n"}<span className="hqcp-code-url">{rest[0]}</span>{"\n"}{rest.slice(1).join("\n")}</code></pre>
      </div>
      <div className="hqcp-prompt-actions">
        <button type="button" className="hqp-btn hqp-btn-ember hqcp-copy" onClick={() => copy(prompt)} aria-live="polite">
          {copied ? Icon.check : Icon.copy}{copied ? "Copied" : `Copy for ${agent.label}`}
        </button>
        <a className="hqp-btn hqp-btn-ghost" href={agent.skillUrl} target="_blank" rel="noreferrer">Open {agent.label} skill {Icon.out}</a>
      </div>
    </div>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className="hqcp-cmd">
      <div className="hqcp-cmd-head"><span>{label}</span>
        <button type="button" onClick={() => copy(command)}>{copied ? Icon.check : Icon.copy}{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code>{command}</code></pre>
    </div>
  );
}

/** The live guide's manual steps, unchanged. */
export function ConsoleManual() {
  return (
    <details className="hqcp-manual">
      <summary>
        <span><b>Prefer to install it yourself?</b><i>Show the manual steps</i></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <div className="hqcp-manual-body">
        <div>
          <h3>Install the basics</h3>
          <p>Install Git, <a href={NODE_URL} target="_blank" rel="noreferrer">Node.js 22+</a> and <a href={OLLAMA_URL} target="_blank" rel="noreferrer">Ollama</a>, then clone Hangar.</p>
          <CommandBlock label="Clone and install" command={`git clone https://github.com/alibad/hangar.git\ncd hangar\nnpm install`} />
        </div>
        <div>
          <h3>Add a local model and start</h3>
          <p>Qwen3 8B is a sensible first local text model. The setup skill can choose a better fit after checking your hardware.</p>
          <CommandBlock label="Model and console" command={`ollama pull qwen3:8b\nnode scripts/detect-host.mjs\nnpm run dev`} />
        </div>
      </div>
    </details>
  );
}
