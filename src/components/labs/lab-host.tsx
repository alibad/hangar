"use client";

import { lazy, Suspense, useMemo } from "react";
import { labForTab, type LabTab } from "@/lib/labs";

/**
 * Mounts the Lab behind a `lab-<id>` tab. The only place page.tsx touches Labs:
 * one line, however many Labs are registered.
 */
export default function LabHost({ tab }: { tab: LabTab }) {
  const lab = labForTab(tab);
  // Memoised per Lab so React.lazy is not re-created on every render, which
  // would remount the Lab and drop its input.
  const Component = useMemo(() => (lab ? lazy(lab.load) : null), [lab]);
  if (!lab || !Component) return <p className="text-sm text-gray-500">No Lab is registered for “{tab}”.</p>;
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading {lab.label}…</p>}>
      <Component lab={lab} />
    </Suspense>
  );
}
