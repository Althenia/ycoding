/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { errorSelectionColors } from "../src/component/error-component"
import { autocompleteSelectionColors } from "../src/component/prompt/autocomplete"
import { whichKeyThemeColors } from "../src/feature-plugins/system/which-key"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"

const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

function expectColor(color: { toInts(): readonly number[] }, hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  expect(color.toInts()).toEqual([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff])
}

test("resolves selected UI colours to the INFO focused-action pair", () => {
  expectColor(theme.background.action.primary.focused, "#79B8FF")
  expectColor(theme.text.action.primary.focused, "#0F1115")

  const selections = [
    errorSelectionColors(),
    autocompleteSelectionColors(theme),
    whichKeyThemeColors(theme).selection,
  ]

  for (const selection of selections) {
    expectColor(selection.fill, "#79B8FF")
    expectColor(selection.foreground, "#0F1115")
  }

  const colors = whichKeyThemeColors(theme)
  expect(colors.panel.toInts()).toEqual(theme.background.surface.overlay.toInts())
  expect(colors.muted.toInts()).toEqual(theme.text.subdued.toInts())
  expect(colors.key.toInts()).toEqual(theme.text.feedback.warning.default.toInts())
  expect(colors.selection.fill.toInts()).toEqual(theme.background.action.primary.focused.toInts())
  expect(colors.selection.foreground.toInts()).toEqual(theme.text.action.primary.focused.toInts())
})

test("keeps crash fallback selection colours aligned with the ycoding theme", () => {
  for (const mode of ["light", "dark"] as const) {
    const fallback = errorSelectionColors(mode)
    const resolved = resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")

    expect(fallback.fill.toInts()).toEqual(resolved.background.action.primary.focused.toInts())
    expect(fallback.foreground.toInts()).toEqual(resolved.text.action.primary.focused.toInts())
  }
})
