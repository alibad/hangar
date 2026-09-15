"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Brain,
  Box,
  Gauge,
  HardDrive,
  Image,
  Mic,
  Scan,
  Search,
  Server,
  Settings2,
  X,
  type LucideIcon,
  Swords,
} from "lucide-react";

export type ConsoleTab = "stack" | "services" | "storage" | "llm" | "arena" | "speech" | "qwen" | "requests" | "usage" | "sam3d" | "sam3" | "models";

type Destination = {
  id: ConsoleTab;
  label: string;
  hint: string;
  keywords: string;
  icon: LucideIcon;
};

const DESTINATIONS: Destination[] = [
  { id: "stack", label: "Home", hint: "Workstreams, GPU, RAM and queue", keywords: "status health gpu resources stack", icon: Server },
  { id: "services", label: "Services", hint: "Inspect and control every local process", keywords: "start stop restart logs ports health infrastructure", icon: Settings2 },
  { id: "storage", label: "Storage", hint: "Map drives, find large files and manage moves", keywords: "disk drive files folders space duplicates cache watch move explorer", icon: HardDrive },
  { id: "llm", label: "LLM", hint: "Chat with the active text model", keywords: "chat text vllm qwen", icon: Brain },
  { id: "arena", label: "Arena", hint: "Compare several models on one prompt", keywords: "compare benchmark arabic ocr vision judge side by side", icon: Swords },
  { id: "speech", label: "Speech", hint: "Transcribe and synthesize audio", keywords: "whisper stt tts voice audio", icon: Mic },
  { id: "qwen", label: "Image", hint: "Generate, edit, queue and browse", keywords: "qwen flux creative gallery", icon: Image },
  { id: "requests", label: "Requests", hint: "Inspect traffic, failures and spend", keywords: "logs activity api traffic errors", icon: Activity },
  { id: "usage", label: "AI Usage", hint: "Router, Codex GPT and Claude token usage", keywords: "claude codex chatgpt gpt openai tokens cost spend billing daily monthly", icon: Gauge },
  { id: "sam3d", label: "3D Body", hint: "Recover human mesh and pose", keywords: "sam 3d pose body mesh", icon: Box },
  { id: "sam3", label: "Segment", hint: "Segment images and track video", keywords: "sam mask boxes tracking", icon: Scan },
  { id: "models", label: "Models", hint: "Choose routing by capability", keywords: "router providers configuration aliases", icon: Settings2 },
];

export function CommandPalette({
  active,
  onSelect,
}: {
  active: ConsoleTab;
  onSelect: (tab: ConsoleTab) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DESTINATIONS;
    return DESTINATIONS.filter((item) =>
      `${item.label} ${item.hint} ${item.keywords}`.toLowerCase().includes(needle),
    );
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setCursor(0);
    const focusFrame = requestAnimationFrame(() => inputRef.current?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trapFocus);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", trapFocus);
      previousFocus?.focus();
    };
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  const choose = (tab: ConsoleTab) => {
    onSelect(tab);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="console-jump flex h-11 w-11 items-center justify-center gap-2 rounded-md border border-gray-700 px-2.5 text-xs text-gray-400 transition hover:border-gray-500 hover:text-gray-100 md:h-8 md:w-auto"
        aria-label="Jump to a console tool"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden md:inline">Jump to</span>
        <kbd className="hidden rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 font-sans text-[10px] text-gray-500 lg:inline">Ctrl K</kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Jump to a console tool"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div ref={dialogRef} className="w-full max-w-xl overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-gray-800 px-4">
              <Search className="h-4 w-4 text-gray-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setCursor((value) => Math.min(shown.length - 1, value + 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setCursor((value) => Math.max(0, value - 1));
                  } else if (event.key === "Enter" && shown[cursor]) {
                    event.preventDefault();
                    choose(shown[cursor].id);
                  }
                }}
                placeholder="Search tools, models or workflows…"
                className="h-12 min-w-0 flex-1 bg-transparent text-sm text-gray-100 outline-none placeholder:text-gray-600"
                aria-label="Search console destinations"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-200"
                aria-label="Close jump menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto p-2" role="listbox">
              {shown.length ? shown.map((item, index) => {
                const Icon = item.icon;
                const selected = index === cursor;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => choose(item.id)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      selected ? "bg-gray-800 text-gray-100" : "text-gray-300 hover:bg-gray-900"
                    }`}
                    role="option"
                    aria-selected={selected}
                  >
                    <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${selected ? "bg-indigo-500/15 text-indigo-300" : "bg-gray-900 text-gray-500"}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{item.label}</span>
                      <span className="block truncate text-[11px] text-gray-500">{item.hint}</span>
                    </span>
                    {item.id === active && <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-300">current</span>}
                  </button>
                );
              }) : (
                <p className="px-3 py-10 text-center text-sm text-gray-500">No matching console tool.</p>
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-gray-800 px-4 py-2 text-[10px] text-gray-600">
              <span>↑↓ navigate</span>
              <span>Enter open</span>
              <span>Esc close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
