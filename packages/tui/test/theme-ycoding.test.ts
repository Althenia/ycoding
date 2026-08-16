import { expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../src/theme/builtins"
import { resolveThemeFile } from "../src/theme/v2/resolve"

const theme = resolveThemeFile(DEFAULT_THEMES.ycoding, "dark", "ycoding")
const lightTheme = resolveThemeFile(DEFAULT_THEMES.ycoding, "light", "ycoding")
const auraTheme = resolveThemeFile(DEFAULT_THEMES.aura, "dark", "aura")

function expectColor(color: { toInts(): readonly number[] }, hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  expect(color.toInts()).toEqual([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 0xff])
}

function contrastAgainst(background: { toInts(): readonly number[] }, color: { toInts(): readonly number[] }) {
  const luminance = (source: { toInts(): readonly number[] }) => {
    const [red, green, blue] = source.toInts().map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }

  const [lighter, darker] = [luminance(background), luminance(color)].sort((left, right) => right - left)
  return (lighter + 0.05) / (darker + 0.05)
}

test("resolves the YCoding dark semantic palette", () => {
  expectColor(theme.background.default, "#15181D")
  expectColor(theme.background.surface.offset, "#1D2128")
  expectColor(theme.background.surface.overlay, "#252A33")
  expectColor(theme.border.default, "#3B424D")
  expectColor(theme.scrollbar.default, "#3B424D")
  expectColor(theme.text.default, "#F2F4F7")
  expectColor(theme.text.subdued, "#98A2B3")
  expectColor(theme.text.feedback.success.default, "#67D7A4")
  expectColor(theme.text.feedback.info.default, "#79B8FF")
  expectColor(theme.text.feedback.warning.default, "#F0BE62")
  expectColor(theme.text.feedback.error.default, "#EF7D84")
  expectColor(theme.hue.gray[900], "#0F1115")
})

test("resolves chrome bands independently for each mode", () => {
  // Light chrome is one ramp step darker than its white page; dark chrome is the dedicated dark band.
  expectColor(lightTheme.background.chrome, "#FAFAFA")
  expectColor(theme.background.chrome, "#0F1115")
})

test("falls back to the page background for Aura without a chrome token", () => {
  expect(auraTheme.background.chrome.toInts()).toEqual(auraTheme.background.default.toInts())
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

test("keeps light semantic text tokens visible and ordered against the page", () => {
  expectColor(lightTheme.text.subdued, "#8A8A8A")
  expectColor(lightTheme.text.label, "#8A8A8A")
  expectColor(lightTheme.text.hint, "#BEBEBE")
  expectColor(lightTheme.text.separator, "#BEBEBE")

  const page = lightTheme.background.default
  const subdued = contrastAgainst(page, lightTheme.text.subdued)
  const label = contrastAgainst(page, lightTheme.text.label)
  const hint = contrastAgainst(page, lightTheme.text.hint)
  const separator = contrastAgainst(page, lightTheme.text.separator)

  ;[lightTheme.text.separator, lightTheme.text.hint, lightTheme.text.label].forEach((color) => {
    expect(color.toInts()).not.toEqual(page.toInts())
    expect(contrastAgainst(page, color)).toBeGreaterThan(1)
  })

  expect(subdued).toBe(label)
  expect(label).toBeGreaterThan(hint)
  expect(hint).toBe(separator)
})

test("preserves the YCoding dark semantic text hierarchy", () => {
  expectColor(theme.text.separator, "#4B535F")
  expectColor(theme.text.hint, "#5D6673")
  expectColor(theme.text.label, "#6F7885")
  expectColor(theme.text.subdued, "#98A2B3")
})

test("resolves diff context colors from each mode's semantic tokens", () => {
  expectColor(theme.diff.text.context, "#98A2B3")
  expectColor(theme.diff.background.context, "#0F1115")
  expectColor(theme.diff.text.added, "#67D7A4")
  expectColor(theme.diff.text.removed, "#EF7D84")
  expectColor(theme.diff.lineNumber.text, "#5D6673")

  expectColor(lightTheme.diff.text.context, "#8A8A8A")
  expectColor(lightTheme.diff.background.context, "#FFFFFF")
})
