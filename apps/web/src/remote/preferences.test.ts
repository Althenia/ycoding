import { describe, expect, test } from "bun:test"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_STORAGE_KEY,
  countEnabledChannels,
  describeNotificationPermission,
  normalizeNotificationPreferences,
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
  test("Settings labels describe finished work and attention across the root family", () => {
    expect(NOTIFICATION_CATEGORIES.slice(0, 2)).toEqual([
      { id: "agent-completed", label: "Work finished", detail: "All work in a Session family has finished." },
      { id: "approval-requested", label: "Needs your attention", detail: "A Session family is waiting for you or ended with an error." },
    ])
  })
  test("cover the configured user-facing categories", () => {
    expect(NOTIFICATION_CATEGORIES.map((category) => category.id)).toEqual([
      "agent-completed",
      "approval-requested",
      "guardrail-blocked",
      "error",
      "device-disconnected",
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
      "guardrail-blocked": false,
      unexpected: { "in-app": true },
    })
    expect(normalized["agent-completed"]).toEqual({ "in-app": true, desktop: true })
    expect(normalized["guardrail-blocked"]).toEqual({ "in-app": true, desktop: true })
    expect(Object.keys(normalized)).toHaveLength(NOTIFICATION_CATEGORIES.length)
  })
})

describe("notification preference persistence", () => {
  test("reads stored preferences and falls back to defaults", () => {
    const stored = storage({
      [NOTIFICATION_STORAGE_KEY]: JSON.stringify({
        error: { "in-app": false, desktop: false },
      }),
    })
    expect(readNotificationPreferences(stored).error).toEqual({ "in-app": false, desktop: false })
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

  test("counts enabled channels per category", () => {
    expect(countEnabledChannels(normalizeNotificationPreferences(undefined))).toEqual({
      "agent-completed": 2,
      "approval-requested": 2,
      "guardrail-blocked": 2,
      error: 2,
      "device-disconnected": 2,
    })
  })
})

describe("describeNotificationPermission", () => {
  test("describes every browser permission state in words", () => {
    expect(describeNotificationPermission("granted")).toContain("allowed")
    expect(describeNotificationPermission("denied")).toContain("blocked")
    expect(describeNotificationPermission("default")).toContain("not requested")
    expect(describeNotificationPermission(undefined)).toContain("not available")
    expect(describeNotificationPermission("unknown-state")).toContain("not available")
  })
})
