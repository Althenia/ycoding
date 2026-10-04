import { Schema } from "effect"
import { DEFAULT_THEMES } from "./builtins"
import { ThemeFile } from "./schema"

export { DEFAULT_THEMES } from "./builtins"
export {
  type ActionStateKey,
  HueStep,
  ModeDefinition,
  ThemeDefinition,
  ThemeFile,
  type BackgroundDefinition,
  type FileThemeDefinition,
  type HueDefinition,
  type MergeModeDefinition,
  type Mode,
  type StatefulColorDefinition,
  type ContextKey,
  type TextDefinition,
  type ThemeTokensDefinition,
} from "./schema"
export type { HueScale, ResolvedActionState, ResolvedTheme, ResolvedThemeView } from "./types"

const pluginThemes: Record<string, ThemeFile> = {}
let customThemes: Record<string, ThemeFile> = {}
let systemTheme: ThemeFile | undefined
const listeners = new Set<(themes: Record<string, ThemeFile>) => void>()
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

export function isTheme(theme: unknown): theme is ThemeFile {
  return isThemeFile(theme)
}

export function subscribeThemes(listener: (themes: Record<string, ThemeFile>) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setCustomThemes(themes: Record<string, ThemeFile>) {
  customThemes = themes
  syncThemes()
}

export function setSystemTheme(theme: ThemeFile | undefined) {
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
