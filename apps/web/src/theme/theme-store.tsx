import { createContext, createEffect, createSignal, onCleanup, useContext, type JSX } from "solid-js"
import { browserStorage } from "../lib/storage"
import {
  nextThemePreference,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme"

export type ThemeValue = {
  readonly preference: () => ThemePreference
  readonly resolved: () => ResolvedTheme
  readonly setPreference: (preference: ThemePreference) => void
  readonly cycle: () => void
}

const ThemeContext = createContext<ThemeValue>()

export function ThemeProvider(props: { readonly children: JSX.Element }) {
  const query = window.matchMedia("(prefers-color-scheme: dark)")
  const [systemDark, setSystemDark] = createSignal(query.matches)
  const [preference, setPreference] = createSignal(readThemePreference(browserStorage()))

  const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
  query.addEventListener("change", listener)
  onCleanup(() => query.removeEventListener("change", listener))

  createEffect(() => {
    const resolved = resolveTheme(preference(), systemDark())
    const root = document.documentElement
    // A theme change is one frame: transitions are suppressed while `data-theme`
    // flips, so no element interpolates from the old palette.
    root.classList.add("theme-switching")
    root.dataset.theme = resolved
    root.dataset.themePreference = preference()
    const themeColor = document.querySelector('meta[name="theme-color"]')
    if (themeColor) themeColor.setAttribute("content", resolved === "dark" ? "#0b1115" : "#ffffff")
    requestAnimationFrame(() => root.classList.remove("theme-switching"))
  })

  const value: ThemeValue = {
    preference,
    resolved: () => resolveTheme(preference(), systemDark()),
    setPreference: (next) => {
      const normalized = normalizeThemePreference(next)
      setPreference(normalized)
      writeThemePreference(browserStorage(), normalized)
    },
    cycle: () => {
      const next = nextThemePreference(preference())
      setPreference(next)
      writeThemePreference(browserStorage(), next)
    },
  }

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("ThemeProvider is missing")
  return value
}
