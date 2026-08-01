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
  // Read localStorage synchronously on the client so the first render already
  // knows the saved theme — eliminates the flash caused by a useEffect read.
  const [theme, setTheme] = useState<Mode>(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("bt-theme") as Mode) ?? "dark";
  });

  const [palette, setPaletteState] = useState<ThemeId>(() => {
    if (typeof window === "undefined") return DEFAULT_THEME;
    const saved = localStorage.getItem("bt-palette");
    return isThemeId(saved) ? saved : DEFAULT_THEME;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = palette;
  }, [palette]);

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
