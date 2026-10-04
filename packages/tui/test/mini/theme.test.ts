import { expect, test } from "bun:test"
import { RGBA, type CliRenderer, type TerminalColors } from "@opentui/core"
import { RUN_THEME_FALLBACK, generateSystem, resolveRunTheme } from "../../src/mini/theme"

const palette = ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] as const

function terminalColors(input: Partial<TerminalColors> = {}): TerminalColors {
  return {
    palette: Array.from({ length: 256 }, (_, index) => input.palette?.[index] ?? palette[index % palette.length]!),
    defaultBackground: input.defaultBackground ?? "#1a1b26",
    defaultForeground: input.defaultForeground ?? "#c0caf5",
    cursorColor: input.cursorColor ?? "#ff9e64",
    mouseForeground: input.mouseForeground ?? null,
    mouseBackground: input.mouseBackground ?? null,
    tekForeground: input.tekForeground ?? null,
    tekBackground: input.tekBackground ?? null,
    highlightBackground: input.highlightBackground ?? "#33467c",
    highlightForeground: input.highlightForeground ?? "#c0caf5",
  }
}

function renderer(
  input: {
    themeMode?: "dark" | "light"
    colors?: TerminalColors
    fail?: boolean
  } = {},
) {
  return {
    themeMode: input.themeMode,
    getPalette: async () => {
      if (input.fail) {
        throw new Error("boom")
      }

      return input.colors ?? terminalColors()
    },
  } as CliRenderer
}

function expectRgba(color: unknown) {
  expect(color).toBeInstanceOf(RGBA)
  if (!(color instanceof RGBA)) {
    throw new Error("expected RGBA")
  }

  return color
}

function expectIndexed(color: unknown) {
  const rgba = expectRgba(color)
  expect(rgba.intent).toBe("indexed")
  expect(rgba.slot).toBeLessThan(256)
}

function spread(color: RGBA) {
  const [r, g, b] = color.toInts()
  return Math.max(r, g, b) - Math.min(r, g, b)
}

test("falls back when palette lookup fails", async () => {
  expect(await resolveRunTheme(renderer({ fail: true }))).toBe(RUN_THEME_FALLBACK)
})

test("terminal palette retains semantic roles and native default-color intent", () => {
  const theme = generateSystem(terminalColors(), "dark")
  expect(theme.text.action.primary.selected).toBeInstanceOf(RGBA)
  expect(theme.text.default.intent).toBe("default")
  expect(theme.background.default.a).toBe(0)
  expect(theme.categorical[0][200].toInts()).toEqual(theme.syntax.keyword.toInts())
})

test("returns syntax styles and indexed splash colors", async () => {
  const theme = await resolveRunTheme(renderer({ themeMode: "dark" }))

  try {
    expect(theme.block.syntax).toBeDefined()
    expect([...theme.block.syntax!.getAllStyles()].length).toBeGreaterThan(0)
    expectIndexed(theme.splash.left)
    expectIndexed(theme.splash.right)
    expectIndexed(theme.splash.leftShadow)
    expectIndexed(theme.entry.user.body)
    expectIndexed(theme.block.syntax?.getStyle("prompt")?.fg)
    expect(theme.block.syntax?.getStyle("extmark.agent")?.bold).toBe(true)
    expectRgba(theme.footer.highlight)
    expect(expectRgba(theme.footer.highlight).toInts()).toEqual([125, 207, 255, 255])
    expect(expectRgba(theme.footer.selectedText).intent).toBe("default")
    expectRgba(theme.footer.statusAccent)
    expectRgba(theme.footer.surface)
    expect(expectRgba(theme.footer.statusAccent).toInts()).not.toEqual(expectRgba(theme.footer.status).toInts())
  } finally {
    theme.block.syntax?.destroy()
  }
})

test("keeps footer surfaces exact while scrollback stays palette matched", async () => {
  const colors = terminalColors({
    defaultBackground: "#0f172a",
    defaultForeground: "#e2e8f0",
  })
  const theme = await resolveRunTheme(renderer({ themeMode: "dark", colors }))
  const exact = generateSystem(colors, "dark")

  try {
    expect(expectRgba(theme.footer.selected).toInts()).toEqual(exact.background.surface.overlay.toInts())
    expect(expectRgba(theme.footer.border).toInts()).toEqual(exact.border.default.toInts())
    expect(expectRgba(theme.footer.pane).toInts()).toEqual(exact.background.surface.overlay.toInts())
    expect(expectRgba(theme.footer.selected).intent).toBe("rgb")
  } finally {
    theme.block.syntax?.destroy()
  }
})

test("uses refreshed background brightness when cached renderer mode is stale", async () => {
  const colors = terminalColors({
    defaultBackground: "#fbf1c7",
    defaultForeground: "#3c3836",
  })
  const stale = await resolveRunTheme(renderer({ themeMode: "dark", colors }))
  const light = await resolveRunTheme(renderer({ themeMode: "light", colors }))

  try {
    expect(expectRgba(stale.footer.surface).toInts()).toEqual(expectRgba(light.footer.surface).toInts())
  } finally {
    stale.block.syntax?.destroy()
    light.block.syntax?.destroy()
  }
})

test("keeps renderer mode when refreshed default background is unavailable", async () => {
  const colors = {
    ...terminalColors(),
    defaultBackground: null,
    palette: ["#000000", ...terminalColors().palette.slice(1)],
  }
  const light = await resolveRunTheme(renderer({ themeMode: "light", colors }))
  const dark = await resolveRunTheme(renderer({ themeMode: "dark", colors }))

  try {
    expect(expectRgba(light.footer.surface).toInts()).not.toEqual(expectRgba(dark.footer.surface).toInts())
  } finally {
    light.block.syntax?.destroy()
    dark.block.syntax?.destroy()
  }
})

test("keeps dark surfaces neutral on saturated backgrounds", () => {
  const theme = generateSystem(
    terminalColors({
      defaultBackground: "#0000ff",
      defaultForeground: "#ffffff",
    }),
    "dark",
  )

  expect(spread(theme.background.surface.offset)).toBeLessThan(10)
  expect(spread(theme.background.surface.overlay)).toBeLessThan(10)
})

test("keeps light surfaces close to neutral on warm backgrounds", () => {
  const theme = generateSystem(
    terminalColors({
      defaultBackground: "#fbf1c7",
      defaultForeground: "#3c3836",
    }),
    "light",
  )

  expect(spread(theme.background.surface.offset)).toBeLessThan(60)
  expect(spread(theme.background.surface.overlay)).toBeLessThan(60)
})
