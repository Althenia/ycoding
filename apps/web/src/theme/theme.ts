import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"
import { DEFAULT_SCHEME, SCHEME_STORAGE_KEY, isSchemeID, schemeBackground, type SchemeID } from "./schemes"

export const THEME_STORAGE_KEY = "ycoding.theme"
const THEME_PREFERENCES = ["light", "dark", "system"] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = "light" | "dark"

function isThemePreference(value: unknown): value is ThemePreference {
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

export function normalizeSchemePreference(value: unknown): SchemeID {
  return isSchemeID(value) ? value : DEFAULT_SCHEME
}

export function readSchemePreference(storage: StorageLike | null | undefined = browserStorage()): SchemeID {
  return normalizeSchemePreference(readStored(storage, SCHEME_STORAGE_KEY, normalizeSchemePreference))
}

export function writeSchemePreference(storage: StorageLike | null | undefined, scheme: SchemeID): boolean {
  return writeStored(storage, SCHEME_STORAGE_KEY, scheme)
}

export function themeColor(scheme: SchemeID, resolved: ResolvedTheme): string {
  return schemeBackground(scheme, resolved) ?? (resolved === "dark" ? "#0b1115" : "#ffffff")
}
