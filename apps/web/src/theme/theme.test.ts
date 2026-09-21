import { describe, expect, test } from "bun:test"
import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
  themePreferenceLabel,
  writeThemePreference,
} from "./theme"

function storage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

describe("resolveTheme", () => {
  test("honors an explicit preference regardless of the system setting", () => {
    expect(resolveTheme("light", true)).toBe("light")
    expect(resolveTheme("dark", false)).toBe("dark")
  })

  test("follows the system setting for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark")
    expect(resolveTheme("system", false)).toBe("light")
  })
})

describe("normalizeThemePreference", () => {
  test("accepts the three supported preferences", () => {
    expect(normalizeThemePreference("light")).toBe("light")
    expect(normalizeThemePreference("dark")).toBe("dark")
    expect(normalizeThemePreference("system")).toBe("system")
  })

  test("falls back to system for unknown, empty, and non-string values", () => {
    expect(normalizeThemePreference("sepia")).toBe("system")
    expect(normalizeThemePreference("")).toBe("system")
    expect(normalizeThemePreference(undefined)).toBe("system")
    expect(normalizeThemePreference(2)).toBe("system")
  })
})

describe("nextThemePreference", () => {
  test("cycles light, dark, system", () => {
    expect(nextThemePreference("light")).toBe("dark")
    expect(nextThemePreference("dark")).toBe("system")
    expect(nextThemePreference("system")).toBe("light")
  })

  test("labels every preference", () => {
    expect(themePreferenceLabel("light")).toBe("Light")
    expect(themePreferenceLabel("dark")).toBe("Dark")
    expect(themePreferenceLabel("system")).toBe("System")
  })
})

describe("theme preference persistence", () => {
  test("reads a stored preference", () => {
    expect(readThemePreference(storage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark")
  })

  test("falls back to system for absent storage, blocked storage, and invalid values", () => {
    expect(readThemePreference(undefined)).toBe("system")
    expect(readThemePreference(storage())).toBe("system")
    expect(readThemePreference(storage({ [THEME_STORAGE_KEY]: "midnight" }))).toBe("system")
    expect(
      readThemePreference({
        getItem: () => {
          throw new Error("storage disabled")
        },
        setItem: () => {},
      }),
    ).toBe("system")
  })

  test("writes and reports failure without throwing", () => {
    const target = storage()
    expect(writeThemePreference(target, "dark")).toBe(true)
    expect(target.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(writeThemePreference(undefined, "dark")).toBe(false)
    expect(
      writeThemePreference(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded")
          },
        },
        "dark",
      ),
    ).toBe(false)
  })
})

describe("first-paint theme script", () => {
  test("index.html reads the same storage key the app writes", async () => {
    const html = await Bun.file(new URL("../../index.html", import.meta.url)).text()
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`)
    expect(html).toContain("dataset.theme")
  })
})
