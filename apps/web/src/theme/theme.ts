import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"

export const THEME_STORAGE_KEY = "ycoding.theme"
export const THEME_PREFERENCES = ["light", "dark", "system"] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = "light" | "dark"

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : "system"
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light"
  return preference
}

export function nextThemePreference(current: ThemePreference): ThemePreference {
  if (current === "light") return "dark"
  if (current === "dark") return "system"
  return "light"
}

export function themePreferenceLabel(preference: ThemePreference): string {
  if (preference === "light") return "Light"
  if (preference === "dark") return "Dark"
  return "System"
}

export function readThemePreference(storage: StorageLike | null | undefined = browserStorage()): ThemePreference {
  return normalizeThemePreference(readStored(storage, THEME_STORAGE_KEY, normalizeThemePreference))
}

export function writeThemePreference(
  storage: StorageLike | null | undefined,
  preference: ThemePreference,
): boolean {
  return writeStored(storage, THEME_STORAGE_KEY, preference)
}
