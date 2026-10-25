"use client";

import { useEffect, useState } from "react";
import "./hangar-loading.css";

/** A loading state that shows it is alive: a moving mark, what it is doing right now, how long it has taken so far,
 *  and, for a pane, the shape of what is about to appear. */
export default function HangarLoading({ label, steps = [], shape = "none", compact = false, announce = true }: { label: string; steps?: string[]; shape?: "none" | "rows" | "card"; compact?: boolean; announce?: boolean }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = steps.length ? steps[Math.floor(seconds / 2) % steps.length] : "";
  // Inside a host that already announces its status, the loader stays a picture.
  return <div className={`hangar-loading ${compact ? "is-compact" : ""}`} {...(announce ? { role: "status", "aria-live": "polite" as const } : {})} aria-busy="true">
    <div className="hl-head">
      <span className="hl-orbit" aria-hidden="true"><i /></span>
      <span className="hl-text"><b>{label}</b>{step && <small key={step} aria-hidden="true">{step}</small>}</span>
      {seconds >= 3 && <span className="hl-time" aria-hidden="true">{seconds}s</span>}
    </div>
    {shape === "card" && <div className="hl-skeleton" aria-hidden="true">
      <span className="hl-line is-title" /><span className="hl-line" /><span className="hl-line is-short" />
      <span className="hl-chips"><span /><span /><span /></span>
      <span className="hl-tiles"><span /><span /><span /><span /></span>
      <span className="hl-line" /><span className="hl-line is-short" />
    </div>}
    {shape === "rows" && <div className="hl-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map(i => <span key={i} className="hl-row" style={{ animationDelay: `${i * 0.12}s` }}><span className="hl-dot" /><span className="hl-lines"><span className="hl-line" /><span className="hl-line is-short" /></span></span>)}
    </div>}
  </div>;
}
