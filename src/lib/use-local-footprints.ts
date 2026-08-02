"use client";

import { useEffect, useState } from "react";
import type { Footprint } from "@/components/model-footprint";

/**
 * What each local model costs on the card, keyed by BeTenshi service id.
 *
 * The image pickers listed local models with no memory information at all while
 * happily showing it for cloud ones — exactly backwards, since a cloud model
 * costs money and a local one costs the single resource everything on this box
 * is contending for. Both numbers come from endpoints the console already
 * serves; this just puts them in one place so the studio picker and the compare
 * picker can't quote different figures for the same model.
 *
 * `footprint` is the sourced estimate from config/model-meta.json. `liveMb` is
 * what the service reports it is holding right now — when both exist the live
 * figure is the honest one, and the gap between them is itself informative.
 */
export type LocalFootprints = {
  footprints: Map<string, Footprint>;
  liveMb: Map<string, number>;
  /**
   * Free system RAM. Carried here because on this box it — not VRAM — is what
   * actually runs out: two ~28 GB host-resident models don't fit in 63 GB, and
   * that collision has already killed a service. null until first read.
   */
  hostFreeGb: number | null;
  hostTotalGb: number | null;
};

type FootprintPayload = { footprints?: Record<string, { footprint?: Footprint }> };
type GpuPayload = {
  service_vram?: Record<string, { used_mb?: number }>;
  host_ram?: { free_gb?: number; total_gb?: number };
};

/** How often to re-read live VRAM. Slow: this is context, not a monitor. */
const LIVE_POLL_MS = 15_000;

export function useLocalFootprints(): LocalFootprints {
  const [footprints, setFootprints] = useState<Map<string, Footprint>>(new Map());
  const [liveMb, setLiveMb] = useState<Map<string, number>>(new Map());
  const [hostFreeGb, setHostFreeGb] = useState<number | null>(null);
  const [hostTotalGb, setHostTotalGb] = useState<number | null>(null);

  // Static, and only changes when model-meta.json does — fetched once. Read from
  // /api/footprints, not the router catalogue: FLUX isn't a router alias at all,
  // and a stopped router shouldn't blank out the numbers.
  useEffect(() => {
    let alive = true;
    fetch("/api/footprints", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: FootprintPayload) => {
        if (!alive) return;
        const next = new Map<string, Footprint>();
        for (const [serviceId, entry] of Object.entries(d?.footprints ?? {})) {
          if (entry?.footprint) next.set(serviceId, entry.footprint);
        }
        setFootprints(next);
      })
      .catch(() => { /* the picker still works without footprints */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const d: GpuPayload = await fetch("/api/gpu", { cache: "no-store" }).then((r) => r.json());
        if (!alive) return;
        const next = new Map<string, number>();
        for (const [id, v] of Object.entries(d?.service_vram ?? {})) {
          if (typeof v?.used_mb === "number") next.set(id, v.used_mb);
        }
        setLiveMb(next);
        // Present even when nvidia-smi fails (that response is a 502 carrying
        // host_ram anyway) — a missing GPU reading must not blind the RAM budget.
        if (typeof d?.host_ram?.free_gb === "number") setHostFreeGb(d.host_ram.free_gb);
        if (typeof d?.host_ram?.total_gb === "number") setHostTotalGb(d.host_ram.total_gb);
      } catch { /* leave the previous reading in place */ }
    };
    read();
    const t = setInterval(read, LIVE_POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return { footprints, liveMb, hostFreeGb, hostTotalGb };
}
