import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"

export const NOTIFICATION_STORAGE_KEY = "ycoding.notifications"

export const NOTIFICATION_CATEGORIES = [
  { id: "agent-completed", label: "Agent completed", detail: "Work finished in a session you are watching." },
  { id: "approval-requested", label: "Approval requested", detail: "A tool or command waits for your decision." },
  { id: "guardrail-blocked", label: "Guardrail block", detail: "A guardrail review or denial stopped an action." },
  { id: "error", label: "Error or failure", detail: "A session step or model request failed." },
  { id: "device-disconnected", label: "Device disconnected", detail: "A paired machine stopped reporting." },
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]["id"]
export type NotificationChannel = "in-app" | "desktop"
export type NotificationPreference = Record<NotificationChannel, boolean>
export type NotificationPreferences = Record<NotificationCategory, NotificationPreference>

export const NOTIFICATION_CHANNELS: readonly { id: NotificationChannel; label: string }[] = [
  { id: "in-app", label: "In workspace" },
  { id: "desktop", label: "Desktop" },
]

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  "agent-completed": { "in-app": true, desktop: true },
  "approval-requested": { "in-app": true, desktop: true },
  "guardrail-blocked": { "in-app": true, desktop: true },
  error: { "in-app": true, desktop: true },
  "device-disconnected": { "in-app": true, desktop: true },
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

export function countEnabledChannels(preferences: NotificationPreferences): Record<NotificationCategory, number> {
  return NOTIFICATION_CATEGORIES.reduce<Record<NotificationCategory, number>>(
    (counts, category) => {
      counts[category.id] = NOTIFICATION_CHANNELS.filter((channel) => preferences[category.id][channel.id]).length
      return counts
    },
    {} as Record<NotificationCategory, number>,
  )
}

export function describeNotificationPermission(permission: string | undefined): string {
  if (permission === "granted") return "Desktop alerts are allowed in this browser."
  if (permission === "denied") return "Desktop alerts are blocked in this browser's site settings."
  if (permission === "default") return "Desktop alerts are not requested yet."
  return "Desktop alerts are not available in this browser."
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
