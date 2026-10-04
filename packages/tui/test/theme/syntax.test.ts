import { expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../../src/theme/builtins"
import { resolveThemeFile } from "../../src/theme/resolve"
import { generateSyntax } from "../../src/theme/syntax"

test("syntax keeps prompt, markup, diff and extmark styles on resolved theme colors", () => {
  for (const mode of ["dark", "light"] as const) {
    const view = resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding")
    const style = generateSyntax(view, mode)
    try {
      expect(style.getStyle("extmark.agent")?.fg?.toInts()).toEqual(
        view.categorical[0][mode === "light" ? 800 : 200].toInts(),
      )
      expect(style.getStyle("extmark.agent")?.bold).toBe(true)
      expect(style.getStyle("keyword.return")?.fg?.toInts()).toEqual(view.syntax.keyword.toInts())
      expect(style.getStyle("keyword.return")?.italic).toBe(true)
      expect(style.getStyle("markup.heading.1")?.fg?.toInts()).toEqual(view.markdown.heading.toInts())
      expect(style.getStyle("markup.heading.1")?.underline).toBe(true)
      expect(style.getStyle("markup.heading.1")?.bold).toBe(true)
      expect(style.getStyle("diff.plus")?.fg?.toInts()).toEqual(view.diff.text.added.toInts())
      expect(style.getStyle("diff.plus")?.bg?.toInts()).toEqual(view.diff.background.added.toInts())
    } finally {
      style.destroy()
    }
  }
})

test("paste uses warning fill with readable ink in a light theme", () => {
  const view = resolveThemeFile(DEFAULT_THEMES.catppuccin, "light", "catppuccin")
  const style = generateSyntax(view, "light")
  try {
    expect(style.getStyle("extmark.paste")?.bg?.toInts()).toEqual(view.text.feedback.warning.default.toInts())
    expect(style.getStyle("extmark.paste")?.fg?.toInts()).toEqual([0, 0, 0, 255])
    expect(style.getStyle("extmark.paste")?.bold).toBe(true)
  } finally {
    style.destroy()
  }
})
