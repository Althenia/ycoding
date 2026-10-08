import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { DEFAULT_THEMES, allThemes } from "../src/theme"
import { discoverThemes } from "../src/theme/discovery"
import { resolveThemeFile } from "../src/theme/resolve"
import { tmpdir } from "./fixture/fixture"

type Color = { toInts(): readonly number[] }

const modes = ["dark", "light"] as const
const AAA = 7
const SENTINEL_RED = [255, 0, 0, 255]

function hex(color: Color) {
  return `#${color
    .toInts()
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`
}

function luminance(color: Color) {
  const [red, green, blue] = color.toInts().map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: Color, background: Color) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

function isColor(value: unknown): value is Color {
  return typeof value === "object" && value !== null && "toInts" in value && typeof value.toInts === "function"
}

function colorPaths(value: unknown, prefix = ""): [string, Color][] {
  if (isColor(value)) return [[prefix, value]]
  if (typeof value !== "object" || value === null || Array.isArray(value)) return []
  return Object.entries(value)
    .filter(([key]) => key !== "contexts" && key !== "categorical" && key !== "hue")
    .flatMap(([key, item]) => colorPaths(item, `${prefix}.${key}`))
}

test("the built-in theme list includes One Dark Pro and High Contrast", () => {
  expect(Object.keys(allThemes())).toEqual(expect.arrayContaining(["one-dark", "one-dark-pro", "high-contrast"]))
  expect(DEFAULT_THEMES["one-dark-pro"]).toBeDefined()
  expect(DEFAULT_THEMES["high-contrast"]).toBeDefined()
})

test.each(Object.keys(DEFAULT_THEMES).flatMap((name) => modes.map((mode) => [name, mode] as const)))(
  "%s resolves its %s mode without the missing-token sentinel",
  (name, mode) => {
    const resolved = resolveThemeFile(DEFAULT_THEMES[name], mode, name)
    const sentinel = colorPaths(resolved).filter(([, color]) => [...color.toInts()].join() === SENTINEL_RED.join())
    expect(sentinel.map(([key]) => key)).toEqual([])
  },
)

test("a standalone theme without secondary inks reads them as its subdued ink", () => {
  const dark = DEFAULT_THEMES["one-dark"].dark
  if (!dark) throw new Error("one-dark must provide a dark mode")
  const resolved = resolveThemeFile(DEFAULT_THEMES["one-dark"], "dark", "probe")
  const bare = resolveThemeFile(
    { version: 2, standalone: true, dark: { ...dark, text: { ...dark.text, separator: undefined, hint: undefined, label: undefined } } },
    "dark",
    "bare",
  )
  expect(hex(bare.text.separator)).toBe(hex(resolved.text.subdued))
  expect(hex(bare.text.hint)).toBe(hex(resolved.text.subdued))
  expect(hex(bare.text.label)).toBe(hex(resolved.text.subdued))
})

test("One Dark follows the Atom One Dark and One Light palettes", () => {
  const dark = resolveThemeFile(DEFAULT_THEMES["one-dark"], "dark", "one-dark")
  expect(hex(dark.background.default)).toBe("#282c34")
  expect(hex(dark.text.default)).toBe("#abb2bf")
  expect(hex(dark.text.subdued)).toBe("#828997")
  expect(hex(dark.text.feedback.info.default)).toBe("#61afef")
  expect(hex(dark.syntax.comment)).toBe("#5c6370")
  expect(hex(dark.syntax.keyword)).toBe("#c678dd")
  expect(hex(dark.syntax.string)).toBe("#98c379")

  const light = resolveThemeFile(DEFAULT_THEMES["one-dark"], "light", "one-dark")
  expect(hex(light.background.default)).toBe("#fafafa")
  expect(hex(light.text.default)).toBe("#383a42")
  expect(hex(light.text.subdued)).toBe("#696c77")
  expect(hex(light.text.feedback.info.default)).toBe("#4078f2")
  expect(hex(light.syntax.comment)).toBe("#a0a1a7")
  expect(contrast(light.text.subdued, light.background.default)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(dark.text.subdued, dark.background.default)).toBeGreaterThanOrEqual(3.5)
})

test("One Dark Pro dark follows the binaryify palette and its light mode follows base16 One Light", () => {
  const dark = resolveThemeFile(DEFAULT_THEMES["one-dark-pro"], "dark", "one-dark-pro")
  expect(hex(dark.background.default)).toBe("#282c34")
  expect(hex(dark.background.surface.offset)).toBe("#21252b")
  expect(hex(dark.border.default)).toBe("#3e4452")
  expect(hex(dark.text.default)).toBe("#abb2bf")
  expect(hex(dark.syntax.comment)).toBe("#7f848e")
  expect(hex(dark.syntax.function)).toBe("#61afef")
  expect(hex(dark.syntax.number)).toBe("#d19a66")
  expect(hex(dark.text.feedback.warning.default)).toBe("#d19a66")
  expect(hex(dark.text.feedback.info.default)).toBe("#61afef")
  expect(contrast(dark.text.subdued, dark.background.default)).toBeGreaterThanOrEqual(4.5)

  const light = resolveThemeFile(DEFAULT_THEMES["one-dark-pro"], "light", "one-dark-pro")
  expect(hex(light.background.default)).toBe("#fafafa")
  expect(hex(light.text.default)).toBe("#383a42")
  expect(hex(light.syntax.variable)).toBe("#ca1243")
  expect(hex(light.syntax.number)).toBe("#d75f00")
  expect(hex(light.syntax.type)).toBe("#c18401")
  expect(hex(light.syntax.function)).toBe("#4078f2")
  expect(contrast(light.text.subdued, light.background.default)).toBeGreaterThanOrEqual(4.5)
})

test.each([...modes])("High Contrast %s holds every text pair to AAA on each surface", (mode) => {
  const theme = resolveThemeFile(DEFAULT_THEMES["high-contrast"], mode, "high-contrast")
  const surfaces = [theme.background.default, theme.background.surface.offset, theme.background.surface.overlay]
  const texts: [string, Color][] = [
    ["text.default", theme.text.default],
    ["text.subdued", theme.text.subdued],
    ["text.label", theme.text.label],
    ["text.hint", theme.text.hint],
    ...Object.entries(theme.text.feedback).map(([kind, tokens]) => [`feedback.${kind}`, tokens.default] as [string, Color]),
    ...Object.entries(theme.syntax).map(([kind, color]) => [`syntax.${kind}`, color] as [string, Color]),
    ...Object.entries(theme.markdown).map(([kind, color]) => [`markdown.${kind}`, color] as [string, Color]),
  ]
  const failures = texts.flatMap(([label, color]) =>
    surfaces.map((surface) => ({ label, ratio: contrast(color, surface) })).filter((pair) => pair.ratio < AAA),
  )
  expect(failures).toEqual([])
})

test.each([...modes])("High Contrast %s holds diff, selection, destructive, and boundary pairs", (mode) => {
  const theme = resolveThemeFile(DEFAULT_THEMES["high-contrast"], mode, "high-contrast")
  const pairs: [string, Color, Color, number][] = [
    ["diff added", theme.diff.text.added, theme.diff.background.added, AAA],
    ["diff removed", theme.diff.text.removed, theme.diff.background.removed, AAA],
    ["diff context", theme.diff.text.context, theme.diff.background.context, AAA],
    ["diff added line number", theme.diff.lineNumber.text, theme.diff.lineNumber.background.added, AAA],
    ["diff removed line number", theme.diff.lineNumber.text, theme.diff.lineNumber.background.removed, AAA],
    ["selected row", theme.text.action.primary.focused, theme.background.action.primary.focused, AAA],
    ["destructive", theme.text.action.destructive.default, theme.background.action.destructive.default, AAA],
    ["border", theme.border.default, theme.background.default, 4.5],
    ["scrollbar", theme.scrollbar.default, theme.background.default, 4.5],
  ]
  expect(
    pairs.filter(([, foreground, background, floor]) => contrast(foreground, background) < floor).map(([label]) => label),
  ).toEqual([])
})

test("discovery skips a malformed custom theme file instead of rejecting every custom theme", async () => {
  await using tmp = await tmpdir()
  await mkdir(path.join(tmp.path, "themes"), { recursive: true })
  await writeFile(path.join(tmp.path, "themes", "broken.json"), "{ not json")
  await writeFile(path.join(tmp.path, "themes", "good.json"), JSON.stringify({ source: "good" }))

  await expect(discoverThemes([tmp.path])).resolves.toEqual({ good: { source: "good" } })
})
