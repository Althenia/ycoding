import { describe, expect, test } from "bun:test"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STORAGE_KEY,
  describeNotificationPermission,
  normalizeNotificationPreferences,
  pushCategoriesFor,
  readNotificationPreferences,
  toggleNotificationChannel,
  writeNotificationPreferences,
  readPreferredModel,
  writePreferredModel,
  defaultComposerModel,
} from "./preferences"
import type { CatalogView } from "./catalog"

function storage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

describe("notification categories", () => {
  test("Settings offers exactly three device-neutral categories and channels", () => {
    expect(NOTIFICATION_CATEGORIES).toEqual([
      { id: "agent-completed", label: "Work finished", detail: "Get notified when a Session and everything it started, including subagents, shells and goals, has finished. Useful for long-running work." },
      { id: "approval-requested", label: "Needs your attention", detail: "Get notified when a Session needs your decision, a guardrail blocks an action, or a run fails." },
      { id: "machine-offline", label: "Machine offline", detail: "Get notified when a paired machine stops reporting." },
    ])
    expect(NOTIFICATION_CHANNELS).toEqual([{ id: "in-app", label: "In app" }, { id: "desktop", label: "System" }])
  })
  test("cover the configured user-facing categories", () => {
    expect(NOTIFICATION_CATEGORIES.map((category) => category.id)).toEqual([
      "agent-completed",
      "approval-requested",
      "machine-offline",
    ])
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0)
    }
  })
})

test("new sessions use a valid remembered model and variant, otherwise the catalog default", () => {
  const catalog: CatalogView = { status: "ready", agents: [], commands: [], skills: [], references: [], resources: [], models: [{ providerID: "openai", id: "gpt", name: "GPT", variants: ["high", "medium"] }], defaultModel: { providerID: "openai", id: "gpt", variant: "high" } }
  const target = storage()
  expect(defaultComposerModel(catalog, readPreferredModel(target))).toEqual(catalog.defaultModel)
  expect(writePreferredModel(target, { providerID: "openai", id: "gpt", variant: "medium" })).toBe(true)
  expect(defaultComposerModel(catalog, readPreferredModel(target))).toEqual({ providerID: "openai", id: "gpt", variant: "medium" })
  expect(defaultComposerModel(catalog, { providerID: "other", id: "unknown" })).toEqual(catalog.defaultModel)
})

describe("normalizeNotificationPreferences", () => {
  test("fills every missing category and channel with the default", () => {
    const normalized = normalizeNotificationPreferences(undefined)
    expect(normalized).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    for (const category of NOTIFICATION_CATEGORIES) {
      const entry = normalizeNotificationPreferences({ [category.id]: { "in-app": false } })[category.id]
      expect(entry["in-app"]).toBe(false)
      expect(entry.desktop).toBe(true)
    }
  })

  test("ignores malformed values instead of trusting them", () => {
    const normalized = normalizeNotificationPreferences({
      "agent-completed": { "in-app": "yes", desktop: null },
      "machine-offline": false,
      "guardrail-blocked": { "in-app": false, desktop: false },
      error: { "in-app": false, desktop: false },
      "device-disconnected": { "in-app": false, desktop: false },
      unexpected: { "in-app": true },
    })
    expect(normalized["agent-completed"]).toEqual({ "in-app": true, desktop: true })
    expect(normalized["machine-offline"]).toEqual({ "in-app": true, desktop: true })
    expect(Object.keys(normalized)).toHaveLength(NOTIFICATION_CATEGORIES.length)
  })
})

describe("notification preference persistence", () => {
  test("reads stored preferences and falls back to defaults", () => {
    const stored = storage({
      [NOTIFICATION_STORAGE_KEY]: JSON.stringify({
        "approval-requested": { "in-app": false, desktop: false },
        "guardrail-blocked": { "in-app": false, desktop: false },
        error: { "in-app": false, desktop: false },
        "device-disconnected": { "in-app": false, desktop: false },
      }),
    })
    expect(readNotificationPreferences(stored)).toEqual({
      "agent-completed": { "in-app": true, desktop: true },
      "approval-requested": { "in-app": false, desktop: false },
      "machine-offline": { "in-app": true, desktop: true },
    })
    expect(readNotificationPreferences(storage({ [NOTIFICATION_STORAGE_KEY]: "{not json" }))).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    )
    expect(
      readNotificationPreferences({
        getItem: () => {
          throw new Error("storage disabled")
        },
        setItem: () => {},
      }),
    ).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(readNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  })

  test("writes preferences and reports failure without throwing", () => {
    const target = storage()
    expect(writeNotificationPreferences(target, DEFAULT_NOTIFICATION_PREFERENCES)).toBe(true)
    expect(JSON.parse(target.getItem(NOTIFICATION_STORAGE_KEY) ?? "null")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
    expect(
      writeNotificationPreferences(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded")
          },
        },
        DEFAULT_NOTIFICATION_PREFERENCES,
      ),
    ).toBe(false)
  })
})

describe("toggleNotificationChannel", () => {
  test("flips one channel without mutating the input", () => {
    const before = normalizeNotificationPreferences(undefined)
    const after = toggleNotificationChannel(before, "approval-requested", "desktop")
    expect(after["approval-requested"].desktop).toBe(false)
    expect(after["approval-requested"]["in-app"]).toBe(true)
    expect(before["approval-requested"].desktop).toBe(true)
    expect(after).not.toBe(before)
  })
})

describe("describeNotificationPermission", () => {
  test("describes every browser permission state in words", () => {
    expect(describeNotificationPermission("granted")).toBe("System alerts are allowed in this browser.")
    expect(describeNotificationPermission("denied")).toBe("System alerts are blocked in this browser's site settings.")
    expect(describeNotificationPermission("default")).toBe("System alerts are not requested yet.")
    expect(describeNotificationPermission(undefined)).toBe("System alerts are not available in this browser.")
    expect(describeNotificationPermission("unknown-state")).toBe("System alerts are not available in this browser.")
  })
})

test("push to this device follows only each category's System switch", () => {
  const preferences = toggleNotificationChannel(toggleNotificationChannel(DEFAULT_NOTIFICATION_PREFERENCES, "agent-completed", "desktop"), "machine-offline", "in-app")
  expect(pushCategoriesFor(preferences)).toEqual({ "agent-completed": false, "approval-requested": true, "machine-offline": true })
})
