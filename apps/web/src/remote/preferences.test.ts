import { describe, expect, test } from "bun:test"
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  createNotificationPreferences,
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
  readRecentModels,
  rememberRecentModel,
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
  const catalog: CatalogView = { status: "ready", agents: [], commands: [], skills: [], references: [], resources: [], models: [{ providerID: "openai", id: "gpt", name: "GPT", variants: ["high", "medium"], profiles: [{ name: "work", active: true }] }], defaultModel: { providerID: "openai", id: "gpt", variant: "high", profile: "work" } }
  const target = storage()
  expect(defaultComposerModel(catalog, readPreferredModel(target))).toEqual(catalog.defaultModel)
  expect(writePreferredModel(target, { providerID: "openai", id: "gpt", variant: "medium" })).toBe(true)
  expect(defaultComposerModel(catalog, readPreferredModel(target))).toEqual({ providerID: "openai", id: "gpt", variant: "medium" })
  expect(defaultComposerModel(catalog, { providerID: "other", id: "unknown" })).toEqual(catalog.defaultModel)
  expect(defaultComposerModel(catalog, { providerID: "openai", id: "gpt", profile: "deleted" })).toEqual({ providerID: "openai", id: "gpt", profile: "deleted" })
  expect(writePreferredModel(target, { providerID: "openai", id: "gpt", profile: "work" })).toBe(true)
  expect(readPreferredModel(target)).toEqual({ providerID: "openai", id: "gpt", profile: "work" })
})

test("recent model identities are bounded, deduplicated, and persisted across reads", () => {
  const target = storage()
  for (let index = 0; index < 12; index++) rememberRecentModel(target, { providerID: "provider", id: `model-${index}` })
  expect(rememberRecentModel(target, { providerID: "provider", id: "model-5", variant: "high" })).toEqual([
    { providerID: "provider", id: "model-5" },
    { providerID: "provider", id: "model-11" },
    { providerID: "provider", id: "model-10" },
    { providerID: "provider", id: "model-9" },
    { providerID: "provider", id: "model-8" },
    { providerID: "provider", id: "model-7" },
    { providerID: "provider", id: "model-6" },
    { providerID: "provider", id: "model-4" },
    { providerID: "provider", id: "model-3" },
    { providerID: "provider", id: "model-2" },
  ])
  expect(readRecentModels(target)).toEqual(rememberRecentModel(target, { providerID: "provider", id: "model-5" }))
  const malformed = storage({ "ycoding.remote.recent-models": JSON.stringify([
    { providerID: "openai", id: "gpt" }, null, { providerID: "", id: "bad" }, { providerID: "openai", id: "gpt" },
  ]) })
  expect(readRecentModels(malformed)).toEqual([
    { providerID: "openai", id: "gpt" },
  ])
  expect(readRecentModels(storage({ "ycoding.remote.recent-models": "{broken" }))).toEqual([])
})

test("recent model identity distinguishes profiles", () => {
  const target = storage()
  rememberRecentModel(target, { providerID: "openai", id: "gpt", profile: "work" })
  expect(rememberRecentModel(target, { providerID: "openai", id: "gpt", profile: "personal" })).toEqual([
    { providerID: "openai", id: "gpt", profile: "personal" },
    { providerID: "openai", id: "gpt", profile: "work" },
  ])
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

describe("notification preferences store", () => {
  test("a toggle updates the store, notifies once, and persists through storage", () => {
    const backing = storage()
    const preferences = createNotificationPreferences(backing)
    const seen: boolean[] = []
    preferences.store.subscribe((value) => seen.push(value["agent-completed"].desktop))
    preferences.toggle("agent-completed", "desktop")
    expect(seen).toEqual([false])
    expect(preferences.store.get()["agent-completed"].desktop).toBe(false)
    expect(readNotificationPreferences(backing)["agent-completed"].desktop).toBe(false)
  })

  test("reload adopts what another tab stored", () => {
    const backing = storage()
    const preferences = createNotificationPreferences(backing)
    writeNotificationPreferences(backing, toggleNotificationChannel(DEFAULT_NOTIFICATION_PREFERENCES, "machine-offline", "in-app"))
    preferences.reload()
    expect(preferences.store.get()["machine-offline"]["in-app"]).toBe(false)
  })

  test("starts from stored values and falls back to defaults without storage", () => {
    const backing = storage({ [NOTIFICATION_STORAGE_KEY]: JSON.stringify({ "approval-requested": { "in-app": false } }) })
    expect(createNotificationPreferences(backing).store.get()["approval-requested"]).toEqual({ "in-app": false, desktop: true })
    expect(createNotificationPreferences(null).store.get()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  })
})
