"use client";

import { AudioLines, Box, Clapperboard, Image as ImageIcon, Layers, type LucideIcon } from "lucide-react";
import type { LibraryNav } from "@/lib/library-nav";

// ── shapes the API returns ─────────────────────────────────────────────────

export type LibraryItem = {
  id: string; kind: "image" | "video" | "sound" | "model" | "collection"; name: string; shelf: string;
  project: string | null; group: string | null; studio: string | null; faction: string | null;
  status: "draft" | "approved" | "rejected" | null; mtime: number; size: number | null;
  prompt: string | null; model: string | null; poster: boolean; count: number | null;
};
export type Facet = { value: string; count: number };
export type ShelfSummary = { id: string; label: string; count: number; kinds: Record<string, number>; samples: LibraryItem[]; projects: Facet[]; studios: Facet[]; factions: Facet[]; statuses: Facet[] };
export type ScanState = { state: "idle" | "scanning" | "error"; seen: number; error?: string; finishedAt?: number };
export type Summary = { shelves: ShelfSummary[]; scan: ScanState; lastScan: number | null; roots: { path: string; shelf: string; present: boolean }[]; factionColors: Record<string, string> };
export type LibraryFilter = LibraryNav & { days?: number };

// ── how things are shown ───────────────────────────────────────────────────

export const KIND_ICON: Record<string, LucideIcon> = { image: ImageIcon, video: Clapperboard, sound: AudioLines, model: Box, collection: Layers };
export const KIND_LABEL: Record<string, string> = { image: "Pictures", video: "Clips", sound: "Sounds", model: "3D", collection: "Sets" };
export const STUDIO_LABEL: Record<string, string> = { image: "Image Studio", video: "Video", "3d": "3D Lab", music: "Music", effects: "Effects", forge: "Forge" };
export const STATUS_LABEL: Record<string, string> = { approved: "Approved", draft: "Draft", rejected: "Rejected" };
export const DATES: [string, number][] = [["Today", 1], ["This week", 7], ["This month", 30], ["This year", 365]];

export const num = (n: number) => new Intl.NumberFormat().format(n);
export const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const previewUrl = (it: Pick<LibraryItem, "id" | "mtime">, v: "poster" | "scrub" | "wave" = "poster", w = 480) =>
  `/api/library/preview?id=${it.id}&v=${v}&w=${w}&t=${it.mtime}`;
export const fileUrl = (it: Pick<LibraryItem, "id" | "mtime">) => `/api/library/file?id=${it.id}&t=${it.mtime}`;

/** A stable colour per project, so a sound's tile reads as its project's. */
export function hueOf(s: string | null): number {
  let h = 0;
  for (const c of s ?? "") h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// One sound plays at a time across every wall.
type Playing = { id: string; audio: HTMLAudioElement; stop: () => void };
let playing: Playing | null = null;
export const nowPlaying = () => playing;
export function stopSound() {
  playing?.audio.pause();
  playing?.stop();
  playing = null;
}
export function playSound(next: Playing) {
  stopSound();
  playing = next;
  void next.audio.play().catch(() => stopSound());
}

