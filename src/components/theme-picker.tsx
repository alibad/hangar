"use client";
import { useEffect, useRef, useState } from "react";
import { useTheme, WORLD_STYLES } from "@/components/theme-provider";
import { THEMES } from "@/lib/themes";
import { Check } from "lucide-react";

export function ThemePicker() {
  const { palette, setPalette, worldStyle, setWorldStyle } = useTheme();
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
        className="flex h-11 w-11 items-center justify-center rounded-md border border-gray-700 transition hover:border-gray-500 md:h-8 md:w-8"
      >
        {/* The swatch is drawn from the live CSS ramp, not the stored hex, so it
            always matches what the rest of the UI actually renders. */}
        <span className="w-3.5 h-3.5 rounded-full bg-indigo-500" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl border border-gray-700 bg-gray-900 p-1.5 z-50 shadow-xl">
          <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">World style</p>
          <div className="mb-1.5 grid grid-cols-2 gap-1 px-1" role="group" aria-label="World style">
            {WORLD_STYLES.map(s => (
              <button key={s.id} type="button" title={s.hint} aria-pressed={worldStyle === s.id} onClick={() => setWorldStyle(s.id)}
                className={`rounded-lg border px-2 py-1.5 text-left text-xs transition ${worldStyle === s.id ? "border-indigo-500 bg-indigo-500/10 text-indigo-300" : "border-gray-700 text-gray-300 hover:bg-gray-800/60"}`}>
                <span className="block font-medium">{s.name}</span>
                <span className="block truncate text-[10px] text-gray-500">{s.hint}</span>
              </button>
            ))}
          </div>
          <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500">Colour theme</p>
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
