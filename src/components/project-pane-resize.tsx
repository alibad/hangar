"use client";

import { useRef, type PointerEvent } from "react";

/** Percentage widths keep the splitter usable as the surrounding window changes. */
export default function ProjectPaneResize({ width, onChange, min = 28, max = 72, reset = 42, label = "Resize project pane" }: { width: number; onChange: (width: number) => void; min?: number; max?: number; reset?: number; label?: string }) {
  const pointer = useRef<number | null>(null);
  const clamp = (value: number) => Math.max(min, Math.min(max, value));
  function move(e: PointerEvent<HTMLDivElement>) {
    if (pointer.current !== e.pointerId) return;
    const layout = e.currentTarget.parentElement?.parentElement;
    if (!layout) return;
    const bounds = layout.getBoundingClientRect();
    const rtl = getComputedStyle(layout).direction === "rtl";
    onChange(clamp(Math.round((rtl ? e.clientX - bounds.left : bounds.right - e.clientX) / bounds.width * 100)));
  }
  return <div className="cw-pane-resize" role="separator" tabIndex={0} aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width}% of workspace`} title="Drag to resize. Arrow keys adjust width; Home and End set limits. Double-click to reset."
    onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); pointer.current = e.pointerId; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={move} onPointerUp={e => { if (pointer.current === e.pointerId) { pointer.current = null; e.currentTarget.releasePointerCapture(e.pointerId); } }} onLostPointerCapture={() => { pointer.current = null; }} onPointerCancel={() => { pointer.current = null; }}
    onDoubleClick={() => onChange(reset)} onKeyDown={e => {
      const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
      const increase = rtl ? "ArrowRight" : "ArrowLeft";
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); onChange(e.key === "Home" ? min : e.key === "End" ? max : clamp(width + (e.key === increase ? 2 : -2)));
    }}><span /></div>;
}
