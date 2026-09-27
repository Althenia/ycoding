import type { OfficePreferences } from "./types"

export const defaultOfficePreferences: OfficePreferences = {
  version: 1, motion: "system", bubbles: "status", labels: true,
  followSelected: true, quality: "standard",
}

export function readOfficePreferences(value: unknown): OfficePreferences {
  if (typeof value !== "object" || value === null || Reflect.get(value, "version") !== 1) return defaultOfficePreferences
  const bubbles = Reflect.get(value, "bubbles")
  const labels = Reflect.get(value, "labels")
  const followSelected = Reflect.get(value, "followSelected")
  return {
    version: 1,
    motion: Reflect.get(value, "motion") === "reduced" ? "reduced" : "system",
    bubbles: bubbles === "off" || bubbles === "excerpt" ? bubbles : "status",
    labels: typeof labels === "boolean" ? labels : true,
    followSelected: typeof followSelected === "boolean" ? followSelected : true,
    quality: Reflect.get(value, "quality") === "battery" ? "battery" : "standard",
  }
}

export function hasReducedMotion(preferences: OfficePreferences, systemReduced: boolean): boolean {
  return preferences.motion === "reduced" || systemReduced
}
