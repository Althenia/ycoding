/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { errorSelectionColors } from "../src/component/error-component"
import { autocompleteSelectionColors } from "../src/component/prompt/autocomplete"
import { whichKeySelectionColors } from "../src/feature-plugins/system/which-key"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { toCurrentTheme } from "../src/theme/resolve"
import { resolveThemeFile } from "../src/theme/v2/resolve"

const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

function expectColor(color: { toInts(): readonly number[] }, hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  expect(color.toInts()).toEqual([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff])
}

test("resolves selected UI colours to the INFO focused-action pair", () => {
  expectColor(theme.background.action.primary.focused, "#79B8FF")
  expectColor(theme.text.action.primary.focused, "#0F1115")

  const currentTheme = toCurrentTheme(theme, "dark")
  const selections = [
    errorSelectionColors(),
    autocompleteSelectionColors(theme),
    whichKeySelectionColors(currentTheme),
  ]

  for (const selection of selections) {
    expectColor(selection.fill, "#79B8FF")
    expectColor(selection.foreground, "#0F1115")
  }
})

test("keeps crash fallback selection colours aligned with the ycoding theme", () => {
  for (const mode of ["light", "dark"] as const) {
    const fallback = errorSelectionColors(mode)
    const resolved = resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")

    expect(fallback.fill.toInts()).toEqual(resolved.background.action.primary.focused.toInts())
    expect(fallback.foreground.toInts()).toEqual(resolved.text.action.primary.focused.toInts())
  }
})
