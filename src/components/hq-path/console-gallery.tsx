"use client";
// The real console after dark: five captured views, one screen. Steps on its own while it is in view,
// stops for good once someone picks a view.
import { useEffect, useRef, useState } from "react";

const VIEWS = [
  { id: "engine", label: "Engine room", line: "What is running, what fits this machine, and what to try.", src: "/hq-path/tab-engine.webp", alt: "Hangar engine room: a prompt box, the Can it run? check and the workstreams" },
  { id: "services", label: "Services", line: "Every local runtime, its memory use, and what needs your attention.", src: "/hq-path/tab-services.webp", alt: "Hangar services: 7 of 24 ready, GPU memory and system RAM, the language model services" },
  { id: "models", label: "Models", line: "Every model this machine can call, local or routed, and whether it is ready.", src: "/hq-path/tab-models.webp", alt: "Hangar models: cards for local-coder, local-small, local-gemma4 and more with their status" },
  { id: "requests", label: "Requests", line: "Every meaningful call across the console, router and local services.", src: "/hq-path/tab-requests.webp", alt: "Hangar requests: a live feed of calls with latency and failure rate" },
  { id: "usage", label: "AI usage", line: "Tokens, cost and how much ran locally, day by day.", src: "/hq-path/tab-usage.webp", alt: "Hangar AI usage: daily calls split into local and cloud" },
];

const STEP_MS = 6000;

export function ConsoleGallery() {
  const [i, setI] = useState(0);
  const [auto, setAuto] = useState(true);
  const [visible, setVisible] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setAuto(false);
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || !visible) return;
    const t = window.setTimeout(() => setI((n) => (n + 1) % VIEWS.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [auto, visible, i]);

  const pick = (n: number) => { setAuto(false); setI(n); };
  const v = VIEWS[i];

  return (
    <div className="hqcp-gallery" ref={box} data-running={auto && visible ? "" : undefined}>
      <div className="hqcp-gtabs" role="tablist" aria-label="Console views">
        {VIEWS.map((x, n) => (
          <button key={x.id} type="button" role="tab" aria-selected={n === i} aria-controls="hqcp-gscreen" onClick={() => pick(n)}>
            <span className="hqcp-gnum">{String(n + 1).padStart(2, "0")}</span>
            <span className="hqcp-glabel">{x.label}</span>
            <span className="hqcp-gline">{x.line}</span>
            {n === i && auto && visible && <span className="hqcp-gbar" key={`bar-${i}`} style={{ animationDuration: `${STEP_MS}ms` }} />}
          </button>
        ))}
      </div>
      <div className="hqcp-gscreen" id="hqcp-gscreen" role="tabpanel" aria-label={v.label}>
        <div className="hqcp-gchrome"><i /><i /><i /><span>localhost:8003/#{v.id === "engine" ? "stack" : v.id}</span></div>
        <div className="hqcp-gframe">
          {VIEWS.map((x, n) => (
            <img key={x.id} src={x.src} alt={n === i ? x.alt : ""} aria-hidden={n !== i} loading="lazy" decoding="async" className={n === i ? "is-on" : undefined} />
          ))}
        </div>
      </div>
    </div>
  );
}
