"use client";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { THEMES } from "@/lib/themes";
import { Check } from "lucide-react";

export function ThemePicker() {
  const { palette, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = THEMES.find(t => t.id === palette) ?? THEMES[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        title={`Theme: ${current.name}`}
        aria-label="Change theme"
        aria-expanded={open}
        className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-700 hover:border-gray-500 transition"
      >
        {/* The swatch is drawn from the live CSS ramp, not the stored hex, so it
            always matches what the rest of the UI actually renders. */}
        <span className="w-3.5 h-3.5 rounded-full bg-indigo-500" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-900 p-1.5 z-50 shadow-xl">
          {THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => { setPalette(t.id); setOpen(false); }}
              aria-label={`${t.name} — ${t.source}`}
              aria-current={t.id === palette}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition ${
                t.id === palette ? "bg-gray-800" : "hover:bg-gray-800/60"
              }`}
            >
              <span
                className="w-5 h-5 rounded-md flex-shrink-0 border border-black/20"
                style={{ background: t.accent }}
              />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-gray-100 truncate">{t.name}</span>
                <span className="block text-[10px] text-gray-500 truncate">{t.source}</span>
              </span>
              <span className="flex gap-0.5 flex-shrink-0">
                {[t.ok, t.warn, t.err].map(c => (
                  <span key={c} className="w-1.5 h-4 rounded-sm" style={{ background: c }} />
                ))}
              </span>
              {t.id === palette && <Check className="h-3.5 w-3.5 flex-shrink-0 text-gray-400" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
