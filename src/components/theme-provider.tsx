"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME, isThemeId, type ThemeId } from "@/lib/themes";

type Mode = "dark" | "light";

const Ctx = createContext<{
  theme: Mode;
  toggle: () => void;
  palette: ThemeId;
  setPalette: (p: ThemeId) => void;
}>({ theme: "dark", toggle: () => {}, palette: DEFAULT_THEME, setPalette: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Keep SSR and the browser's first React render deterministic. The inline
  // script in layout.tsx handles the pre-paint DOM class and palette.
  const [theme, setTheme] = useState<Mode>("dark");
  const [palette, setPaletteState] = useState<ThemeId>(DEFAULT_THEME);
  const [hydrated, setHydrated] = useState(false);

  // SSR and the browser's first render must use the same values. layout.tsx
  // already applies the saved classes before paint; after hydration this only
  // brings React state into agreement with that pre-painted DOM state.
  useEffect(() => {
    const savedTheme = localStorage.getItem("bt-theme");
    const savedPalette = localStorage.getItem("bt-palette");
    setTheme(savedTheme === "light" ? "light" : "dark");
    setPaletteState(isThemeId(savedPalette) ? savedPalette : DEFAULT_THEME);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [hydrated, theme]);

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.dataset.theme = palette;
  }, [hydrated, palette]);

  function toggle() {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("bt-theme", next);
      return next;
    });
  }

  function setPalette(p: ThemeId) {
    localStorage.setItem("bt-palette", p);
    setPaletteState(p);
  }

  return <Ctx.Provider value={{ theme, toggle, palette, setPalette }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
