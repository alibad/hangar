"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, Copy, ExternalLink, Laptop, Mail } from "lucide-react";
import "./machines-connect.css";

/**
 * Machines → bring another computer in. Hangar looks at Tailscale on this computer, says what the next step is, and
 * lists the owner's other computers it finds there. One Connect makes two of them see each other. The page checks
 * again every few seconds, so each step ticks itself off as it is done.
 */
type Device = { name: string; os: string; ip: string; online: boolean; hangar: boolean | null; connected: boolean };
type View = {
  state: "missing" | "off" | "signin" | "approval" | "running"; platform: string; machine: string;
  install: { url: string; command: string }; self: { name: string; ip: string; login: string } | null; authUrl: string;
  visible: { on: boolean; listening: boolean; error: string }; devices: Device[];
};

const GUIDE = "https://hangar.humanquest.net";
const OS: Record<string, string> = { macos: "Mac", windows: "Windows", linux: "Linux" };
/** What to do on the other computer, as plain sentences: shown here, copied, or put in an email. */
const otherSteps = (machine: string) => [
  `Install Tailscale from https://tailscale.com/download and sign in with the same account you use on ${machine}.`,
  `Install Hangar from ${GUIDE} and start it.`,
  "In Hangar, open Machines and turn on “Let my other computers see this one”.",
  `Back on ${machine}, open Machines. The other computer is listed there: press Connect once and each sees the other.`,
];

async function call<T>(body?: unknown): Promise<T> {
  const response = await fetch("/api/fleet/tailnet", { method: body ? "POST" : "GET", cache: "no-store",
    headers: body ? { "Content-Type": "application/json", "X-Hangar": "1" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status})`);
  return data;
}

/** A sentence with its web addresses turned into links. */
function linked(text: string): ReactNode[] {
  return text.split(/(https:\/\/[^\s]*[^\s.])/).map((part, i) => i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part.replace("https://", "")}</a> : part);
}

function Step({ n, done, title, children, action }: { n: number; done: boolean; title: string; children: ReactNode; action?: ReactNode }) {
  return <li className={done ? "is-done" : ""}>
    <span className="mc-mark" aria-hidden="true">{done ? <Check size={15} /> : n}</span>
    <div className="mc-body"><h3>{title}{done && <span className="sr-only"> (done)</span>}</h3>{children}</div>
    {action && <div className="mc-action">{action}</div>}
  </li>;
}

export default function MachinesConnect({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    try { setView(await call<View>()); setError(""); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); window.setTimeout(() => setCopied(""), 1800); }).catch(() => { /* The text stays on screen to select. */ });
  };
  const setVisible = async (on: boolean) => {
    setBusy("visible"); setNotice(""); setError("");
    try { setView(await call<View>({ action: "visible", on })); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };
  const connect = async (device: Device) => {
    setBusy(device.ip); setNotice(""); setError("");
    try {
      const result = await call<{ name: string; both: boolean }>({ action: "connect", ip: device.ip });
      setNotice(result.both ? `${result.name} and this computer now see each other.`
        : `This computer now sees ${result.name}. The way back was not confirmed: open Machines on ${result.name} and press Connect there too.`);
      await load();
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  };

  const running = view?.state === "running";
  const open = !!view?.visible.on && view.visible.listening;
  const machine = view?.machine || "this computer";
  const steps = otherSteps(machine);
  const mail = `mailto:?subject=${encodeURIComponent("Set up Hangar on my other computer")}&body=${encodeURIComponent(steps.map((s, i) => `${i + 1}. ${s}`).join("\n\n"))}`;

  return <section className="mc" aria-label="Bring another computer into your world">
    <div className="mc-intro">
      <span className="cw-eyebrow">Bring another computer into your world</span>
      <h2>Your computers find each other.</h2>
      <p>Hangar uses Tailscale, a private network between your own devices. Sign in to it with the same account on each computer and Hangar finds the others by itself. No ports or host names to type.</p>
    </div>

    <ol className="mc-steps">
      <Step n={1} done={running} title="Tailscale on this computer" action={view && (
        view.state === "missing" ? <>
          <a className="mc-go" href={view.install.url} target="_blank" rel="noreferrer">Get Tailscale<ExternalLink size={15} aria-hidden="true" /></a>
          {view.install.command && <button type="button" className="mc-ghost" title={view.install.command} onClick={() => copy("install", view.install.command)}>{copied === "install" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === "install" ? "Copied" : "Or copy the install command"}</button>}
        </> : view.state === "signin" && view.authUrl ? <a className="mc-go" href={view.authUrl} target="_blank" rel="noreferrer">Finish signing in<ExternalLink size={15} aria-hidden="true" /></a> : null)}>
        <p>{!view ? "Checking…"
          : view.state === "missing" ? "Not installed yet. Install it and sign in. This page notices by itself, so you can leave it open."
          : view.state === "off" ? "Installed, but not connected. Open Tailscale and switch it on."
          : view.state === "signin" ? "Installed. Open Tailscale and sign in."
          : view.state === "approval" ? "Signed in. This computer is waiting to be approved in your Tailscale admin page."
          : <>Connected as <b>{view.self?.login}</b>. This computer is <b>{view.self?.name}</b>.</>}</p>
      </Step>

      <Step n={2} done={open} title="Let my other computers see this one" action={running && (
        <button type="button" className={view?.visible.on ? "mc-ghost" : "mc-go"} disabled={busy === "visible"} onClick={() => setVisible(!view?.visible.on)}>{view?.visible.on ? "Turn off" : "Turn on"}</button>)}>
        <p>{!running ? "Needs Tailscale first."
          : !view?.visible.on ? "Off. Nothing outside this computer can reach Hangar."
          : view.visible.listening ? "On. Only computers signed in to your Tailscale account get in, and only to projects, sessions and models."
          : view.visible.error || "Starting…"}</p>
      </Step>

      <Step n={3} done={!!view?.devices.some(d => d.connected)} title="Your other computers">
        {!running ? <p>They appear here once Tailscale is connected.</p>
          : !view?.devices.length ? <p>No other computer of yours is on Tailscale yet. Follow the steps below on the other one.</p>
          : <ul className="mc-devices">{view.devices.map(device => <li key={device.ip}>
            <Laptop size={20} aria-hidden="true" />
            <span><b>{device.name}</b><small>{[OS[device.os.toLowerCase()] || device.os,
              device.connected ? (device.online ? "Connected" : "Connected, asleep or off right now")
              : !device.online ? "Asleep or switched off"
              : device.hangar ? "Hangar is running there"
              : "Hangar did not answer. Start it there and turn on step 2"].filter(Boolean).join(" · ")}</small></span>
            {device.connected ? <i className="mc-ok"><Check size={14} aria-hidden="true" />Connected</i>
              : device.online && device.hangar ? <button type="button" className="mc-go" disabled={!!busy} onClick={() => connect(device)}>{busy === device.ip ? "Connecting…" : "Connect"}<ArrowRight size={15} aria-hidden="true" /></button> : null}
          </li>)}</ul>}
      </Step>
    </ol>

    {notice && <p className="mc-notice" role="status"><Check size={15} aria-hidden="true" />{notice}</p>}
    {error && <p className="cw-error" role="alert">{error}</p>}

    <div className="mc-other">
      <div>
        <h3>On your other computer</h3>
        <ol>{steps.map(step => <li key={step}>{linked(step)}</li>)}</ol>
      </div>
      <div className="mc-other-actions">
        <a className="mc-ghost" href={mail}><Mail size={14} aria-hidden="true" />Email me these steps</a>
        <button type="button" className="mc-ghost" onClick={() => copy("steps", steps.map((s, i) => `${i + 1}. ${s}`).join("\n"))}>{copied === "steps" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === "steps" ? "Copied" : "Copy the steps"}</button>
      </div>
    </div>
  </section>;
}
