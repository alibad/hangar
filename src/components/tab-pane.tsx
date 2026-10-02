"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import TabErrorBoundary from "@/components/tab-error-boundary";

/**
 * One console tab's content, kept alive between visits.
 *
 * Switching tabs used to unmount the tool you left and build the next one from
 * nothing: every visit refetched its data, showed its loading state again and
 * lost what you had open, and the page smooth-scrolled to the top — together it
 * felt like the whole page reloading. Now a tab is built on its first visit and
 * only hidden when you leave it, so coming back shows it at once, as you left
 * it. The last KEEP_TABS tabs stay built; older ones are let go, so a long
 * session doesn't keep every tool's memory (models' previews, 3D canvases) alive.
 *
 * A hidden tab is still mounted, so two things follow it:
 *  • audio and video inside it are paused when you leave;
 *  • `useTabActive()` tells a tool whether it is the one showing — a handler on
 *    `window` (a keyboard shortcut, a lightbox's arrow keys) should check it, or
 *    it would act on a tab you can't see.
 */
export const KEEP_TABS = 5;

const TabActiveContext = createContext(true);

/** Whether the console tab this component lives in is the one showing. */
export const useTabActive = () => useContext(TabActiveContext);

export function TabPane({ id, current, kept, label, children }: { id: string; current: string; kept: readonly string[]; label: string; children: ReactNode }) {
  const active = id === current;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) return;
    ref.current?.querySelectorAll<HTMLMediaElement>("audio, video").forEach((m) => m.pause());
  }, [active]);

  if (!active && !kept.includes(id)) return null;
  return (
    <div ref={ref} hidden={!active} data-console-tab={id}>
      <TabActiveContext.Provider value={active}>
        <TabErrorBoundary label={label}>{children}</TabErrorBoundary>
      </TabActiveContext.Provider>
    </div>
  );
}
