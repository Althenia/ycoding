import { createContext, createEffect, createSignal, onCleanup, useContext, type JSX } from "solid-js"
import { browserStorage } from "../lib/storage"
import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  normalizeSchemePreference,
  normalizeThemePreference,
  readSchemePreference,
  readThemePreference,
  resolveTheme,
  themeColor,
  writeSchemePreference,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme"
import { SCHEME_STORAGE_KEY, resolveScheme, type SchemeID } from "./schemes"

export type ThemeValue = {
  readonly preference: () => ThemePreference
  readonly resolved: () => ResolvedTheme
  readonly scheme: () => SchemeID
  readonly resolvedScheme: () => SchemeID
  readonly setPreference: (preference: ThemePreference) => void
  readonly setScheme: (scheme: SchemeID) => void
  readonly cycle: () => void
}

const ThemeContext = createContext<ThemeValue>()

export function ThemeProvider(props: { readonly children: JSX.Element }) {
  const colorQuery = window.matchMedia("(prefers-color-scheme: dark)")
  const contrastQuery = window.matchMedia("(prefers-contrast: more)")
  const [systemDark, setSystemDark] = createSignal(colorQuery.matches)
  const [moreContrast, setMoreContrast] = createSignal(contrastQuery.matches)
  const [preference, setPreference] = createSignal(readThemePreference(browserStorage()))
  const [scheme, setScheme] = createSignal(readSchemePreference(browserStorage()))

  const colorListener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
  const contrastListener = (event: MediaQueryListEvent) => setMoreContrast(event.matches)
  const storageListener = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) setPreference(readThemePreference(browserStorage()))
    if (event.key === null || event.key === SCHEME_STORAGE_KEY) setScheme(readSchemePreference(browserStorage()))
  }
  colorQuery.addEventListener("change", colorListener)
  contrastQuery.addEventListener("change", contrastListener)
  window.addEventListener("storage", storageListener)
  onCleanup(() => {
    colorQuery.removeEventListener("change", colorListener)
    contrastQuery.removeEventListener("change", contrastListener)
    window.removeEventListener("storage", storageListener)
  })

  const resolved = () => resolveTheme(preference(), systemDark())
  const resolvedScheme = () => resolveScheme(scheme(), preference() === "system", moreContrast())

  createEffect(() => {
    const root = document.documentElement
    // A theme change is one frame: transitions are suppressed while `data-theme`
    // flips, so no element interpolates from the old palette.
    root.classList.add("theme-switching")
    root.dataset.theme = resolved()
    root.dataset.themePreference = preference()
    root.dataset.scheme = resolvedScheme()
    document.querySelectorAll('meta[name="theme-color"]').forEach((tag) => {
      tag.removeAttribute("media")
      tag.setAttribute("content", themeColor(resolvedScheme(), resolved()))
    })
    requestAnimationFrame(() => root.classList.remove("theme-switching"))
  })

  const value: ThemeValue = {
    preference,
    resolved,
    scheme,
    resolvedScheme,
    setPreference: (next) => {
      const normalized = normalizeThemePreference(next)
      setPreference(normalized)
      writeThemePreference(browserStorage(), normalized)
    },
    setScheme: (next) => {
      const normalized = normalizeSchemePreference(next)
      setScheme(normalized)
      writeSchemePreference(browserStorage(), normalized)
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
