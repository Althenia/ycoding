import type { PushCategories } from "@ycoding-ai/remote"
import { Store } from "@tanstack/solid-store"
import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"
import type { CatalogView } from "./catalog"
import type { ModelRefView } from "./projection"

const PREFERRED_MODEL_KEY = "ycoding.remote.preferred-model"
const RECENT_MODELS_KEY = "ycoding.remote.recent-models"
const REMEMBERED_MACHINE_KEY = "ycoding.remote.machine"

export function readRememberedMachine(storage: StorageLike | null | undefined = browserStorage()): string | undefined {
  return readStored(storage, REMEMBERED_MACHINE_KEY, (raw) => raw || undefined)
}

export function writeRememberedMachine(storage: StorageLike | null | undefined = browserStorage(), deviceID: string): boolean {
  return writeStored(storage, REMEMBERED_MACHINE_KEY, deviceID)
}

export function readPreferredModel(storage: StorageLike | null | undefined = browserStorage()): ModelRefView | undefined {
  const value = readStored(storage, PREFERRED_MODEL_KEY, (raw) => {
    try { return JSON.parse(raw) as unknown } catch { return undefined }
  })
  if (typeof value !== "object" || value === null || !("providerID" in value) || !("id" in value)) return undefined
  if (typeof value.providerID !== "string" || typeof value.id !== "string") return undefined
  return { providerID: value.providerID, id: value.id, ...( "variant" in value && typeof value.variant === "string" ? { variant: value.variant } : {}),
    ...( "profile" in value && typeof value.profile === "string" && value.profile.length > 0 ? { profile: value.profile } : {}) }
}

export function writePreferredModel(storage: StorageLike | null | undefined = browserStorage(), model: ModelRefView): boolean {
  return writeStored(storage, PREFERRED_MODEL_KEY, JSON.stringify(model))
}

export function readRecentModels(storage: StorageLike | null | undefined = browserStorage()): ModelRefView[] {
  return readStored(storage, RECENT_MODELS_KEY, (raw) => {
    try {
      const value: unknown = JSON.parse(raw)
      if (!Array.isArray(value)) return []
      const seen = new Set<string>()
      return value.flatMap((item) => {
        if (typeof item !== "object" || item === null || !("providerID" in item) || !("id" in item)) return []
        if (typeof item.providerID !== "string" || !item.providerID || typeof item.id !== "string" || !item.id) return []
        const profile = "profile" in item && typeof item.profile === "string" && item.profile.length > 0 ? item.profile : undefined
        const key = JSON.stringify([item.providerID, item.id, profile])
        if (seen.has(key)) return []
        seen.add(key)
        return [{ providerID: item.providerID, id: item.id, ...(profile === undefined ? {} : { profile }) }]
      }).slice(0, 10)
    } catch {
      return []
    }
  }) ?? []
}

export function rememberRecentModel(storage: StorageLike | null | undefined = browserStorage(), model: ModelRefView): ModelRefView[] {
  const recent = [{ providerID: model.providerID, id: model.id, ...(model.profile === undefined ? {} : { profile: model.profile }) }, ...readRecentModels(storage).filter((item) => item.providerID !== model.providerID || item.id !== model.id || item.profile !== model.profile)].slice(0, 10)
  writeStored(storage, RECENT_MODELS_KEY, JSON.stringify(recent))
  return recent
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
  { id: "machine-offline", label: "Machine offline", detail: "Get notified when a paired machine stops reporting." },
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["id"]
export type NotificationChannel = "in-app" | "desktop"
type NotificationPreference = Record<NotificationChannel, boolean>
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

/** Browser-persisted notification switches: every change is written through to storage, and `reload` adopts what another tab stored. */
export function createNotificationPreferences(storage: StorageLike | null | undefined = browserStorage()) {
  const store = new Store(readNotificationPreferences(storage))
  store.subscribe((preferences) => writeNotificationPreferences(storage, preferences))
  return {
    store,
    toggle: (category: NotificationCategory, channel: NotificationChannel) =>
      store.setState(() => toggleNotificationChannel(readNotificationPreferences(storage), category, channel)),
    reload: () => store.setState(() => readNotificationPreferences(storage)),
  }
}

export function pushCategoriesFor(preferences: NotificationPreferences): PushCategories {
  return {
    "agent-completed": preferences["agent-completed"].desktop,
    "approval-requested": preferences["approval-requested"].desktop,
    "machine-offline": preferences["machine-offline"].desktop,
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
