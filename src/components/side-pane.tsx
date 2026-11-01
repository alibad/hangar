"use client";

import type { ReactNode, Ref } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import ProjectPaneResize from "./project-pane-resize";

/** The side pane's width limits, as a percentage of the workspace. */
export const SIDE = { min: 20, max: 72, reset: 20 };

/** The workspace's right-hand pane: resizable, expandable to the whole window, closable. A project, the repository
 *  tools and a session all open in it, so it looks and behaves the same whatever it holds. Without `onClose` the
 *  pane draws no header and its content brings its own. */
export default function SidePane({ label, closeLabel, resizeLabel, width, onWidth, className = "", paneRef, top, actions, below, expanded, onExpand, onClose, children }: {
  label: string; closeLabel?: string; resizeLabel?: string; width: number; onWidth: (width: number) => void; className?: string; paneRef?: Ref<HTMLElement>;
  top?: ReactNode; actions?: ReactNode; below?: ReactNode; expanded?: boolean; onExpand?: () => void; onClose?: () => void; children: ReactNode;
}) {
  return <aside ref={paneRef} className={`cw-inspector ${className}`} aria-label={label}>
    <ProjectPaneResize width={width} onChange={onWidth} {...SIDE} label={resizeLabel || `Resize ${label}`} />
    {onClose && <div className="cw-pane-header">
      <div className="cw-pane-top">
        {top}
        <div className="cw-pane-actions">
          {actions}
          {onExpand && <button className="cw-pane-expand" aria-label={expanded ? "Restore side panel" : "Expand side panel"} title={expanded ? "Restore panel" : "Expand panel"} aria-pressed={expanded} onClick={onExpand}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
          <button aria-label={closeLabel || `Close ${label}`} title="Close pane" onClick={onClose}><X size={18} /></button>
        </div>
      </div>
      {below}
    </div>}
    {children}
  </aside>;
}
