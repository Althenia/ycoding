import { describe, expect, test } from "bun:test"
import type { StorageLike } from "../../lib/storage"
import { defaultOfficePreferences } from "./preferences"
import { createOfficeSettings, OFFICE_PREFERENCES_KEY, WORKSPACE_PRESENTATION_KEY } from "./storage"

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  }
  return { storage, values }
}

describe("office settings storage", () => {
  test("starts in Conversation with the default office appearance", () => {
    const settings = createOfficeSettings(memoryStorage().storage)
    expect(settings.presentation()).toBe("conversation")
    expect(settings.preferences()).toEqual(defaultOfficePreferences)
  })

  test("persists the presentation and cosmetic preferences for the next workspace", () => {
    const memory = memoryStorage()
    const first = createOfficeSettings(memory.storage)
    first.present("office")
    first.update({ bubbles: "excerpt", quality: "battery", labels: false })

    const next = createOfficeSettings(memory.storage)
    expect(next.presentation()).toBe("office")
    expect(next.preferences()).toEqual({ ...defaultOfficePreferences, bubbles: "excerpt", quality: "battery", labels: false })
    expect(Object.keys(JSON.parse(memory.values.get(OFFICE_PREFERENCES_KEY) ?? "{}")).sort()).toEqual(
      ["bubbles", "followSelected", "labels", "motion", "quality", "version"],
    )
  })

  test("reset restores appearance, remounts the renderer, and keeps the chosen presentation", () => {
    const memory = memoryStorage()
    const settings = createOfficeSettings(memory.storage)
    settings.present("office")
    settings.update({ motion: "reduced", followSelected: false })
    const generation = settings.generation()

    settings.reset()

    expect(settings.preferences()).toEqual(defaultOfficePreferences)
    expect(settings.generation()).toBe(generation + 1)
    expect(settings.presentation()).toBe("office")
    expect(createOfficeSettings(memory.storage).preferences()).toEqual(defaultOfficePreferences)
  })

  test("ignores malformed or foreign stored values", () => {
    const settings = createOfficeSettings(memoryStorage({
      [OFFICE_PREFERENCES_KEY]: "{not json",
      [WORKSPACE_PRESENTATION_KEY]: "cinema",
    }).storage)
    expect(settings.preferences()).toEqual(defaultOfficePreferences)
    expect(settings.presentation()).toBe("conversation")
    expect(createOfficeSettings(memoryStorage({ [OFFICE_PREFERENCES_KEY]: JSON.stringify({ version: 2, quality: "battery" }) }).storage).preferences())
      .toEqual(defaultOfficePreferences)
  })

  test("keeps working in memory when the browser refuses storage writes", () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota")
      },
    }
    const settings = createOfficeSettings(storage)
    settings.present("office")
    settings.update({ bubbles: "off" })
    expect(settings.presentation()).toBe("office")
    expect(settings.preferences().bubbles).toBe("off")
  })
})
