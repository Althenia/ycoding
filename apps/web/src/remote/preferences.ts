import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"
import type { CatalogView } from "./catalog"
import type { ModelRefView } from "./projection"

const PREFERRED_MODEL_KEY = "ycoding.remote.preferred-model"

export function readPreferredModel(storage: StorageLike | null | undefined = browserStorage()): ModelRefView | undefined {
  const value = readStored(storage, PREFERRED_MODEL_KEY, (raw) => {
    try { return JSON.parse(raw) as unknown } catch { return undefined }
  })
  if (typeof value !== "object" || value === null || !("providerID" in value) || !("id" in value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
  return { providerID: value.providerID, id: value.id, ...( "variant" in value && typeof value.variant === "string" ? { variant: value.variant } : {}) }
}

export function writePreferredModel(storage: StorageLike | null | undefined = browserStorage(), model: ModelRefView): boolean {
  return writeStored(storage, PREFERRED_MODEL_KEY, JSON.stringify(model))
}

export function defaultComposerModel(catalog: CatalogView | undefined, preferred: ModelRefView | undefined): ModelRefView | undefined {
  const option = catalog?.models.find((item) => item.providerID === preferred?.providerID && item.id === preferred.id)
  if (option && (preferred?.variant === undefined || option.variants.includes(preferred.variant))) return preferred
  return catalog?.defaultModel
}

export const NOTIFICATION_STORAGE_KEY = "ycoding.notifications"

export const NOTIFICATION_CATEGORIES = [
  { id: "agent-completed", label: "Work finished", detail: "Get notified when a Session and everything it started, including subagents, shells and goals, has finished. Useful for long-running work." },
  { id: "approval-requested", label: "Needs your attention", detail: "Get notified when a Session needs your decision, a guardrail blocks an action, or a run fails." },
  { id: "machine-offline", label: "Machine offline", detail: "Get notified when the selected paired machine stops reporting while YCoding is open." },
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["id"]
export type NotificationChannel = "in-app" | "desktop"
export type NotificationPreference = Record<NotificationChannel, boolean>
export type NotificationPreferences = Record<NotificationCategory, NotificationPreference>

export const NOTIFICATION_CHANNELS: readonly { id: NotificationChannel; label: string }[] = [
  { id: "in-app", label: "In app" },
  { id: "desktop", label: "System" },
]

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  "agent-completed": { "in-app": true, desktop: true },
  "approval-requested": { "in-app": true, desktop: true },
  "machine-offline": { "in-app": true, desktop: true },
}

/** Merges stored values over the defaults, ignoring anything that is not a boolean channel. */
export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const source = isRecord(value) ? value : {}
  return NOTIFICATION_CATEGORIES.reduce<NotificationPreferences>((preferences, category) => {
    const stored = source[category.id]
    const entry = isRecord(stored) ? stored : {}
    preferences[category.id] = {
      "in-app": booleanOr(entry["in-app"], DEFAULT_NOTIFICATION_PREFERENCES[category.id]["in-app"]),
      desktop: booleanOr(entry.desktop, DEFAULT_NOTIFICATION_PREFERENCES[category.id].desktop),
    }
    return preferences
  }, {} as NotificationPreferences)
}

export function readNotificationPreferences(
  storage: StorageLike | null | undefined = browserStorage(),
): NotificationPreferences {
  return normalizeNotificationPreferences(readStored(storage, NOTIFICATION_STORAGE_KEY, parseStored))
}

export function writeNotificationPreferences(
  storage: StorageLike | null | undefined,
  preferences: NotificationPreferences,
): boolean {
  return writeStored(storage, NOTIFICATION_STORAGE_KEY, JSON.stringify(preferences))
}

export function toggleNotificationChannel(
  preferences: NotificationPreferences,
  category: NotificationCategory,
  channel: NotificationChannel,
): NotificationPreferences {
  return {
    ...preferences,
    [category]: { ...preferences[category], [channel]: !preferences[category][channel] },
  }
}

export function describeNotificationPermission(permission: string | undefined): string {
  if (permission === "granted") return "System alerts are allowed in this browser."
  if (permission === "denied") return "System alerts are blocked in this browser's site settings."
  if (permission === "default") return "System alerts are not requested yet."
  return "System alerts are not available in this browser."
}

function parseStored(raw: string): NotificationPreferences | undefined {
  try {
    return normalizeNotificationPreferences(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}
