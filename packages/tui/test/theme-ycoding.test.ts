import { expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"

const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")

function expectColor(color: { toInts(): readonly number[] }, hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  expect(color.toInts()).toEqual([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff])
}

test("resolves the YCoding dark semantic palette", () => {
  expectColor(theme.background.default, "#15181D")
  expectColor(theme.background.surface.offset, "#1D2128")
  expectColor(theme.background.surface.overlay, "#252A33")
  expectColor(theme.border.default, "#3B424D")
  expectColor(theme.scrollbar.default, "#3B424D")
  expectColor(theme.text.default, "#F2F4F7")
  expectColor(theme.text.subdued, "#98A2B3")
  expectColor(theme.text.feedback.success.default, "#67D7AA")
  expectColor(theme.text.feedback.info.default, "#79B8FF")
  expectColor(theme.text.feedback.warning.default, "#F0BE62")
  expectColor(theme.text.feedback.error.default, "#EF7D84")
  expectColor(theme.hue.gray[900], "#0F1115")
})

test("keeps a focused row readable on the INFO selection fill", () => {
  // Selection is always INFO. The fill and the text on it must not resolve to the same colour, or the
  // focused row renders as an unreadable block.
  expectColor(theme.background.action.primary.focused, "#79B8FF")
  expectColor(theme.text.action.primary.focused, "#0F1115")
  expect(theme.text.action.primary.focused.toInts()).not.toEqual(theme.background.action.primary.focused.toInts())
})

test("tints a focused form field instead of filling it with the text colour", () => {
  expectColor(theme.text.formfield.focused, "#79B8FF")
  expect(theme.background.formfield.focused.toInts()).not.toEqual(theme.text.formfield.focused.toInts())
  expect(theme.background.formfield.selected.toInts()).not.toEqual(theme.text.formfield.selected.toInts())
})
