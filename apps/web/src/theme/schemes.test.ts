import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { declarationsWhere, readStylesheet } from "../styles/css-rules"
import {
  DEFAULT_SCHEME,
  SCHEMES,
  SCHEME_IDS,
  isSchemeID,
  resolveScheme,
  schemeBackground,
  schemeStylesheet,
  schemeTokens,
} from "./schemes"
import { themeColor } from "./theme"

const HEX = /^#[0-9a-f]{6}$/i
const palettes = SCHEME_IDS.flatMap((scheme) =>
  (["light", "dark"] as const).flatMap((mode) => {
    const palette = SCHEMES[scheme].palettes[mode]
    return palette ? [{ scheme, mode, palette }] : []
  }),
)

describe("scheme palettes", () => {
  test("ship One Dark in both modes, One Dark Pro in dark, and High contrast in both", () => {
    expect(palettes.map((entry) => `${entry.scheme}/${entry.mode}`)).toEqual([
      "onedark/light",
      "onedark/dark",
      "onedark-pro/dark",
      "high-contrast/light",
      "high-contrast/dark",
    ])
    expect(SCHEMES[DEFAULT_SCHEME].palettes).toEqual({})
  })

  test("follow the official palettes' anchors", () => {
    expect(SCHEMES.onedark.palettes.dark).toMatchObject({ base00: "#282c34", base05: "#abb2bf", base0B: "#98c379", base0D: "#61afef" })
    expect(SCHEMES.onedark.palettes.light).toMatchObject({ base00: "#fafafa", base05: "#383a42", base0B: "#50a14f", base0D: "#4078f2" })
    expect(SCHEMES["onedark-pro"].palettes.dark).toMatchObject({ base00: "#282c34", base10: "#21252b", base03: "#7f848e", base06: "#d7dae0" })
  })

  test.each(palettes)("$scheme $mode declares sixteen valid base slots", ({ palette }) => {
    const slots = Object.entries(palette).filter(([name]) => /^base[0-9A-F]{2}$/.test(name) && name !== "base10")
    expect(slots).toHaveLength(16)
    for (const [name, color] of slots) expect(color, name).toMatch(HEX)
  })

  test.each(palettes)("$scheme $mode maps to color tokens that tokens.css declares", async ({ palette, mode }) => {
    const declared = declarationsWhere(await readStylesheet("../styles/tokens.css"), (rule) => rule.header === ":root" && rule.conditions.length === 0)
    const tokens = schemeTokens(palette, mode)
    expect(Object.keys(tokens).filter((property) => declared[property] === undefined)).toEqual([])
    for (const value of Object.values(tokens)) expect(value).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [0-9.]+\))$/)
  })

  test("every palette sets the same tokens except the optional terminal plate", () => {
    const sets = palettes.map(({ palette, mode }) => Object.keys(schemeTokens(palette, mode)).filter((name) => !name.startsWith("--yc-terminal-")))
    for (const set of sets) expect(set).toEqual(sets[0]!)
  })
})

describe("scheme stylesheet", () => {
  const sheet = schemeStylesheet()

  test("declares one rule per palette, selected by scheme and mode, and none for the default scheme", () => {
    const selectors = [...sheet.matchAll(/^(:root\[[^{]+)\{/gm)].map((match) => match[1]!.trim())
    expect(selectors).toEqual(palettes.map(({ scheme, mode }) => `:root[data-scheme="${scheme}"][data-theme="${mode}"]`))
    expect(sheet).not.toContain('data-scheme="default"')
    expect(sheet).not.toContain('data-scheme="onedark-pro"][data-theme="light"')
  })

  test("writes exactly the mapped tokens into each rule", () => {
    for (const { scheme, mode, palette } of palettes) {
      const rule = sheet.match(new RegExp(`:root\\[data-scheme="${scheme}"\\]\\[data-theme="${mode}"\\] \\{\\n([^}]*)\\}`))?.[1]
      expect(rule, `${scheme}/${mode}`).toBeDefined()
      expect(rule!.trim().split("\n").map((line) => line.trim())).toEqual(
        Object.entries(schemeTokens(palette, mode)).map(([property, value]) => `${property}: ${value};`),
      )
    }
  })
})

describe("scheme selection", () => {
  test("recognises only shipped scheme ids", () => {
    for (const id of SCHEME_IDS) expect(isSchemeID(id)).toBe(true)
    for (const value of ["", "One Dark", "onedark ", undefined, 1, null]) expect(isSchemeID(value)).toBe(false)
  })

  test("a system request for more contrast applies High contrast only to the default scheme under the system preference", () => {
    expect(resolveScheme("default", true, true)).toBe("high-contrast")
    expect(resolveScheme("default", true, false)).toBe("default")
    expect(resolveScheme("default", false, true)).toBe("default")
    expect(resolveScheme("onedark", true, true)).toBe("onedark")
    expect(resolveScheme("onedark-pro", true, true)).toBe("onedark-pro")
  })

  test("browser chrome follows the painted scheme and falls back to the default theme when a mode has no palette", () => {
    expect(schemeBackground("onedark", "dark")).toBe("#282c34")
    expect(schemeBackground("onedark-pro", "light")).toBeUndefined()
    expect(themeColor("onedark", "dark")).toBe("#282c34")
    expect(themeColor("high-contrast", "light")).toBe("#ffffff")
    expect(themeColor("onedark-pro", "light")).toBe("#ffffff")
    expect(themeColor("default", "dark")).toBe("#0b1115")
  })
})

describe("first-paint theme script", () => {
  async function paint(stored: Record<string, string>, system: { dark: boolean; contrast: boolean } | "blocked") {
    const html = await Bun.file(new URL("../../index.html", import.meta.url)).text()
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    const root: { dataset: Record<string, string> } = { dataset: {} }
    const storage = {
      getItem: (key: string) => {
        if (system === "blocked") throw new Error("storage disabled")
        return stored[key] ?? null
      },
    }
    const matchMedia = (query: string) => ({
      matches: system !== "blocked" && (query.includes("prefers-color-scheme: dark") ? system.dark : query.includes("prefers-contrast: more") ? system.contrast : false),
    })
    runInNewContext(script, { document: { documentElement: root }, localStorage: storage, window: { matchMedia } })
    return root.dataset
  }

  test("the scheme list in the page matches the shipped schemes", async () => {
    const html = await Bun.file(new URL("../../index.html", import.meta.url)).text()
    const listed = html.match(/\[("default"[^\]]*)\]\.includes/)![1]!.split(",").map((entry) => entry.trim().replaceAll('"', ""))
    expect(listed).toEqual([...SCHEME_IDS])
  })

  test("applies a stored scheme with the stored mode", async () => {
    expect(await paint({ "ycoding.theme": "dark", "ycoding.theme-scheme": "onedark" }, { dark: false, contrast: false })).toMatchObject({
      theme: "dark",
      themePreference: "dark",
      scheme: "onedark",
    })
  })

  test("falls back to the default scheme for absent or unknown values", async () => {
    expect((await paint({}, { dark: true, contrast: false })).scheme).toBe("default")
    expect((await paint({ "ycoding.theme-scheme": "solarized" }, { dark: true, contrast: false })).scheme).toBe("default")
  })

  test("honors a system request for more contrast only under System with the default scheme", async () => {
    expect((await paint({}, { dark: false, contrast: true })).scheme).toBe("high-contrast")
    expect((await paint({ "ycoding.theme": "light" }, { dark: false, contrast: true })).scheme).toBe("default")
    expect((await paint({ "ycoding.theme-scheme": "onedark" }, { dark: false, contrast: true })).scheme).toBe("onedark")
  })

  test("blocked storage paints the default scheme", async () => {
    expect(await paint({}, "blocked")).toMatchObject({ theme: "light", themePreference: "system", scheme: "default" })
  })
})
