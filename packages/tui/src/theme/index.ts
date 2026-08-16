import { Schema } from "effect"
import { DEFAULT_THEMES } from "./builtins"
import { generateSyntax, selectedForeground, type Theme } from "./current"
import { toCurrentTheme } from "./resolve"
import { ThemeFile, type ThemeFile as ThemeFileType } from "./v2"
import { resolveThemeFile } from "./v2/resolve"

export { DEFAULT_THEMES } from "./builtins"
export { generateSyntax, selectedForeground, type Theme } from "./current"
export { ThemeFile, type ThemeFile as ThemeSource } from "./v2"

const pluginThemes: Record<string, ThemeFileType> = {}
let customThemes: Record<string, ThemeFileType> = {}
let systemTheme: ThemeFileType | undefined
const listeners = new Set<(themes: Record<string, ThemeFileType>) => void>()
const isThemeFile = Schema.is(ThemeFile)

function listThemes() {
  // Priority: defaults < plugin installs < custom files < generated system.
  const themes = {
    ...DEFAULT_THEMES,
    ...pluginThemes,
    ...customThemes,
  }
  if (!systemTheme) return themes
  return {
    ...themes,
    system: systemTheme,
  }
}

function syncThemes() {
  const themes = listThemes()
  for (const listener of listeners) listener(themes)
}

export function allThemes() {
  return listThemes()
}

export function isTheme(theme: unknown): theme is ThemeFileType {
  return isThemeFile(theme)
}

export function subscribeThemes(listener: (themes: Record<string, ThemeFileType>) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setCustomThemes(themes: Record<string, ThemeFileType>) {
  customThemes = themes
  syncThemes()
}

export function setSystemTheme(theme: ThemeFileType | undefined) {
  systemTheme = theme
  syncThemes()
}

export function hasTheme(name: string) {
  if (!name) return false
  return allThemes()[name] !== undefined
}

export function addTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isTheme(theme)) return false
  if (hasTheme(name)) return false
  pluginThemes[name] = theme
  syncThemes()
  return true
}

export function upsertTheme(name: string, theme: unknown) {
  if (!name) return false
  if (!isTheme(theme)) return false
  if (customThemes[name] !== undefined) {
    customThemes[name] = theme
  } else {
    pluginThemes[name] = theme
  }
  syncThemes()
  return true
}

export function resolveTheme(theme: ThemeFileType, mode: "dark" | "light", name = "theme"): Theme {
  return toCurrentTheme(resolveThemeFile(theme, mode, name), mode)
}
