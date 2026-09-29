"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-js.css";
import { KIND_STYLE, type DecisionKind } from "./api";

/**
 * One process instance on its diagram: where it is now (orange), where it has
 * been (green), where it is stuck (red), and what kind of decision each step
 * makes (a tag above the task).
 *
 * bpmn-js's licence requires its bpmn.io watermark to stay visible and
 * un-overlapped, so nothing here is positioned over the canvas's bottom-right
 * corner.
 */
export default function BpmnView({
  xml,
  current = [],
  visited = [],
  failed = [],
  height = 340,
  selected = null,
  onSelect,
}: {
  xml: string;
  current?: string[];
  visited?: string[];
  failed?: string[];
  height?: number;
  /** The step whose help is open, outlined in blue. */
  selected?: string | null;
  /** Called with a step's id when it is clicked (labels resolve to their step). */
  onSelect?: (id: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  // bpmn-js has no types we depend on; keep the instance opaque.
  const viewer = useRef<{ importXML: (x: string) => Promise<unknown>; get: (n: string) => any; destroy: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(0);
  // The click listener is bound once per import; the ref keeps it calling the
  // latest handler without re-importing the diagram.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    let alive = true;
    (async () => {
      const { default: Viewer } = await import("bpmn-js/lib/NavigatedViewer");
      if (!alive || !box.current) return;
      const v = new Viewer({ container: box.current }) as unknown as NonNullable<typeof viewer.current>;
      viewer.current = v;
      try {
        await v.importXML(xml);
        v.get("eventBus").on("element.click", (e: any) => {
          const el = e.element?.labelTarget ?? e.element;
          const type: string = el?.businessObject?.$type ?? "";
          if (!el || type === "bpmn:Process" || type === "bpmn:SequenceFlow") return onSelectRef.current?.(null);
          onSelectRef.current?.(el.id);
        });
        setReady((n) => n + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [xml]);

  // Markers and kind tags, re-applied whenever the instance moves.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready) return;
    const canvas = v.get("canvas");
    const registry = v.get("elementRegistry");
    const overlays = v.get("overlays");
    overlays.clear();
    for (const el of registry.getAll()) {
      for (const m of ["pl-current", "pl-visited", "pl-failed", "pl-selected"]) canvas.removeMarker(el.id, m);
      const kind = kindOf(el.businessObject) as DecisionKind | null;
      if (kind && KIND_STYLE[kind]) {
        overlays.add(el.id, {
          position: { top: -11, left: 4 },
          html: `<span style="font:600 9px/1 system-ui;padding:2px 5px;border-radius:9px;color:#111;background:${KIND_STYLE[kind].hex}">${KIND_STYLE[kind].label}</span>`,
        });
      }
    }
    const has = (id: string) => !!registry.get(id);
    visited.filter(has).forEach((id) => canvas.addMarker(id, "pl-visited"));
    current.filter(has).forEach((id) => canvas.addMarker(id, "pl-current"));
    failed.filter(has).forEach((id) => canvas.addMarker(id, "pl-failed"));
    if (selected && has(selected)) canvas.addMarker(selected, "pl-selected");
  }, [ready, current.join(), visited.join(), failed.join(), selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Frame the case: the whole process is 26 columns wide, unreadable when
  // fitted into a panel, so a live case opens zoomed onto where it is now and
  // a finished one fitted. Re-framed only when the step changes, so a manual
  // pan or zoom is not undone by the next poll.
  const focus = (failed[0] ?? current[0]) || "";
  const frame = useCallback(
    (fit: boolean) => {
      const v = viewer.current;
      if (!v) return;
      const canvas = v.get("canvas");
      const el = focus ? v.get("elementRegistry").get(focus) : null;
      if (fit || !el) {
        canvas.zoom("fit-viewport", "auto");
        return;
      }
      canvas.zoom(0.8);
      canvas.scrollToElement(el, { top: 120, bottom: 120, left: 260, right: 260 });
    },
    [focus],
  );
  useEffect(() => {
    if (ready) frame(false);
  }, [ready, frame]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-gray-700 bg-white">
      <style>{`
        .pl-bpmn .djs-element.pl-visited .djs-visual > :first-child { fill: #ecfdf5 !important; stroke: #059669 !important; }
        .pl-bpmn .djs-element.pl-current .djs-visual > :first-child { fill: #fff7ed !important; stroke: #ea580c !important; stroke-width: 4px !important; }
        .pl-bpmn .djs-element.pl-failed .djs-visual > :first-child { fill: #fef2f2 !important; stroke: #dc2626 !important; stroke-width: 4px !important; }
        .pl-bpmn .djs-element.pl-selected .djs-visual > :first-child { stroke: #2563eb !important; stroke-width: 5px !important; }
        .pl-bpmn .djs-element.djs-shape { cursor: pointer; }
      `}</style>
      <div ref={box} className="pl-bpmn" style={{ height }} />
      {error && <p className="absolute left-3 top-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">Could not draw the diagram: {error}</p>}
      <div className="absolute right-3 top-2 flex gap-1">
        <button onClick={() => frame(true)} className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-700 hover:bg-gray-100">Fit</button>
        {focus && (
          <button onClick={() => frame(false)} className="rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] text-gray-700 hover:bg-gray-100">
            Now
          </button>
        )}
      </div>
      <div className="pointer-events-none absolute left-3 top-2 flex gap-3 text-[10px] text-gray-600">
        <span><span className="mr-1 inline-block size-2 rounded-sm border-2 border-orange-600" />now</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm border-2 border-emerald-600 bg-emerald-50" />done</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm border-2 border-red-600" />incident</span>
      </div>
    </div>
  );
}

/** The `decisionKind` extension property the lab puts on each activity. */
function kindOf(bo: any): string | null {
  const values = bo?.extensionElements?.values ?? [];
  for (const v of values) {
    // Without the operaton moddle descriptor these arrive as generic elements.
    const props = v?.$children ?? v?.values ?? [];
    for (const p of props) if (p?.name === "decisionKind" || p?.$attrs?.name === "decisionKind") return p.value ?? p.$attrs?.value ?? null;
  }
  return null;
}
