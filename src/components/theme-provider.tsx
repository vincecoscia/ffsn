"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "ffsn-theme";

interface ThemeContextValue {
  theme: Theme;
  /** Alias of `theme`, kept so callers can read either name. */
  resolvedTheme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readDomTheme(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(theme);
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the class still applies.
  }
}

/**
 * Theme switching for the Broadcast design system.
 * Dark is the house look and the default; light is the daylight counterpart.
 *
 * The `<html>` class is set before first paint by the inline script in
 * `src/app/layout.tsx`, so this provider only mirrors the DOM into React state
 * and applies changes. `?theme=light|dark` on any URL forces a theme (handy for
 * links and screenshots); the choice persists like a toggle would.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // Server render and first client paint both assume the default; the mount
  // effect reconciles with what the pre-paint script actually applied.
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("theme");
    if (wanted === "light" || wanted === "dark") {
      applyTheme(wanted);
      setThemeState(wanted);
    } else {
      setThemeState(readDomTheme());
    }

    // Keep tabs in sync when the theme changes elsewhere.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next: Theme = event.newValue === "light" ? "light" : "dark";
      applyTheme(next);
      setThemeState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme: theme, setTheme }),
    [theme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK: ThemeContextValue = { theme: "dark", resolvedTheme: "dark", setTheme: () => {} };

/** Current theme and a setter. Safe to call outside the provider (returns the dark default). */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? FALLBACK;
}

/**
 * Inline pre-paint script source: applies the stored (or `?theme=`) theme to
 * `<html>` before React runs so light-mode users never see a dark flash.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get('theme');var s=localStorage.getItem('${THEME_STORAGE_KEY}');var t=(q==='light'||q==='dark')?q:(s==='light'?'light':'dark');var c=document.documentElement.classList;c.remove('dark','light');c.add(t);document.documentElement.style.colorScheme=t;}catch(e){}})();`;
