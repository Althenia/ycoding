import { expect, test } from "bun:test"
import { Schema } from "effect"
import { DEFAULT_THEMES } from "../src/theme"
import { ThemeFile, type ResolvedThemeView } from "../src/theme"
import { resolveThemeFile } from "../src/theme/resolve"
import { selectThemeMode } from "../src/theme/select"

const THEME_NAMES = [
  "aura",
  "ayu",
  "carbonfox",
  "catppuccin",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "cobalt2",
  "cursor",
  "dracula",
  "everforest",
  "flexoki",
  "github",
  "gruvbox",
  "kanagawa",
  "lucent-orng",
  "material",
  "matrix",
  "mercury",
  "monokai",
  "nightowl",
  "nord",
  "one-dark",
  "orng",
  "osaka-jade",
  "palenight",
  "rosepine",
  "solarized",
  "synthwave84",
  "tokyonight",
  "vercel",
  "vesper",
  "ycoding",
  "zenburn",
] as const

const LEGACY_ROLES = [
  "accent",
  "background",
  "backgroundElement",
  "backgroundMenu",
  "backgroundPanel",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffAddedBg",
  "diffAddedLineNumberBg",
  "diffContext",
  "diffContextBg",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffHunkHeader",
  "diffLineNumber",
  "diffRemoved",
  "diffRemovedBg",
  "diffRemovedLineNumberBg",
  "error",
  "info",
  "markdownBlockQuote",
  "markdownCode",
  "markdownCodeBlock",
  "markdownEmph",
  "markdownHeading",
  "markdownHorizontalRule",
  "markdownImage",
  "markdownImageText",
  "markdownLink",
  "markdownLinkText",
  "markdownListEnumeration",
  "markdownListItem",
  "markdownStrong",
  "markdownText",
  "primary",
  "secondary",
  "selectedListItemText",
  "success",
  "syntaxComment",
  "syntaxFunction",
  "syntaxKeyword",
  "syntaxNumber",
  "syntaxOperator",
  "syntaxPunctuation",
  "syntaxString",
  "syntaxType",
  "syntaxVariable",
  "text",
  "textMuted",
  "warning",
] as const

const SEMANTIC_SELECTORS = {
  accent: (theme, mode) => theme.hue.accent[mode === "light" ? 800 : 200],
  background: (theme) => theme.background.default,
  backgroundElement: (theme) => theme.background.surface.overlay,
  backgroundMenu: (theme) => theme.background.surface.overlay,
  backgroundPanel: (theme) => theme.background.surface.offset,
  border: (theme) => theme.border.default,
  borderActive: (theme) => theme.scrollbar.default,
  borderSubtle: (theme) => theme.hue.neutral[500],
  diffAdded: (theme) => theme.diff.text.added,
  diffAddedBg: (theme) => theme.diff.background.added,
  diffAddedLineNumberBg: (theme) => theme.diff.lineNumber.background.added,
  diffContext: (theme) => theme.diff.text.context,
  diffContextBg: (theme) => theme.diff.background.context,
  diffHighlightAdded: (theme) => theme.diff.highlight.added,
  diffHighlightRemoved: (theme) => theme.diff.highlight.removed,
  diffHunkHeader: (theme) => theme.diff.text.hunkHeader,
  diffLineNumber: (theme) => theme.diff.lineNumber.text,
  diffRemoved: (theme) => theme.diff.text.removed,
  diffRemovedBg: (theme) => theme.diff.background.removed,
  diffRemovedLineNumberBg: (theme) => theme.diff.lineNumber.background.removed,
  error: (theme) => theme.text.feedback.error.default,
  info: (theme) => theme.text.feedback.info.default,
  markdownBlockQuote: (theme) => theme.markdown.blockQuote,
  markdownCode: (theme) => theme.markdown.code,
  markdownCodeBlock: (theme) => theme.markdown.codeBlock,
  markdownEmph: (theme) => theme.markdown.emphasis,
  markdownHeading: (theme) => theme.markdown.heading,
  markdownHorizontalRule: (theme) => theme.markdown.horizontalRule,
  markdownImage: (theme) => theme.markdown.image,
  markdownImageText: (theme) => theme.markdown.imageText,
  markdownLink: (theme) => theme.markdown.link,
  markdownLinkText: (theme) => theme.markdown.linkText,
  markdownListEnumeration: (theme) => theme.markdown.listEnumeration,
  markdownListItem: (theme) => theme.markdown.listItem,
  markdownStrong: (theme) => theme.markdown.strong,
  markdownText: (theme) => theme.markdown.text,
  primary: (theme) => theme.text.action.primary.selected,
  secondary: (theme, mode) => theme.categorical[0][mode === "light" ? 800 : 200],
  selectedListItemText: (theme) => theme.text.action.primary.focused,
  success: (theme) => theme.text.feedback.success.default,
  syntaxComment: (theme) => theme.syntax.comment,
  syntaxFunction: (theme) => theme.syntax.function,
  syntaxKeyword: (theme) => theme.syntax.keyword,
  syntaxNumber: (theme) => theme.syntax.number,
  syntaxOperator: (theme) => theme.syntax.operator,
  syntaxPunctuation: (theme) => theme.syntax.punctuation,
  syntaxString: (theme) => theme.syntax.string,
  syntaxType: (theme) => theme.syntax.type,
  syntaxVariable: (theme) => theme.syntax.variable,
  text: (theme) => theme.text.default,
  textMuted: (theme) => theme.text.subdued,
  warning: (theme) => theme.text.feedback.warning.default,
} satisfies Record<
  (typeof LEGACY_ROLES)[number],
  (theme: ResolvedThemeView, mode: "dark" | "light") => { toInts(): readonly number[] }
>

const DARK_ONLY = ["aura", "ayu", "catppuccin-frappe", "catppuccin-macchiato", "nightowl"] as const

const Fixture = Schema.Struct({
  schemaVersion: Schema.Number,
  themeNames: Schema.Array(Schema.String),
  roles: Schema.Array(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      requestedMode: Schema.Literals(["dark", "light"]),
      effectiveMode: Schema.Literals(["dark", "light"]),
      colors: Schema.Record(Schema.String, Schema.Array(Schema.Number)),
      thinkingOpacity: Schema.Number,
    }),
  ),
})

const fixture = Schema.decodeUnknownSync(Fixture)(
  await Bun.file(new URL("./fixture/theme-v1-parity.json", import.meta.url)).json(),
)

test("V1 fixture freezes the complete 33-theme, 52-role, two-request inventory", () => {
  expect(fixture.schemaVersion).toBe(1)
  expect(fixture.themeNames).toEqual([...THEME_NAMES])
  expect(Object.keys(DEFAULT_THEMES).sort()).toEqual([...THEME_NAMES])
  expect(LEGACY_ROLES).toHaveLength(52)
  expect(fixture.roles).toEqual([...LEGACY_ROLES])
  expect(fixture.entries).toHaveLength(66)
  expect(new Set(fixture.entries.map((entry) => `${entry.name}/${entry.requestedMode}`)).size).toBe(66)
  expect(new Set(fixture.entries.map((entry) => `${entry.name}/${entry.effectiveMode}`)).size).toBe(61)
  expect(
    fixture.entries.filter((entry) => entry.requestedMode !== entry.effectiveMode).map((entry) => entry.name),
  ).toEqual([...DARK_ONLY])

  const allChannels = fixture.entries.flatMap((entry) => {
    expect(entry.thinkingOpacity).toBe(0.6)
    expect(Object.keys(entry.colors)).toEqual([...LEGACY_ROLES])
    return Object.values(entry.colors).flatMap((channels) => {
      expect(channels).toHaveLength(4)
      for (const channel of channels) {
        expect(Number.isInteger(channel)).toBe(true)
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
      }
      return channels
    })
  })
  expect(allChannels).toHaveLength(66 * 52 * 4)
  expect(fixture.entries.some((entry) => Object.values(entry.colors).some((channels) => channels[3] !== 255))).toBe(
    true,
  )
})

test("the YCoding dark fixture retains independently documented DESIGN colors", () => {
  const dark = fixture.entries.find((entry) => entry.name === "ycoding" && entry.requestedMode === "dark")
  expect(dark?.colors).toMatchObject({
    primary: [121, 184, 255, 255],
    background: [21, 24, 29, 255],
    backgroundPanel: [29, 33, 40, 255],
    backgroundElement: [37, 42, 51, 255],
    text: [242, 244, 247, 255],
    textMuted: [152, 162, 179, 255],
    selectedListItemText: [15, 17, 21, 255],
    error: [239, 125, 132, 255],
    warning: [240, 190, 98, 255],
    success: [103, 215, 164, 255],
    info: [121, 184, 255, 255],
  })
})

test("the explicit semantic selectors preserve every frozen legacy role", () => {
  expect(Object.keys(SEMANTIC_SELECTORS).sort()).toEqual([...LEGACY_ROLES].sort())
  const decode = Schema.decodeUnknownSync(ThemeFile)
  for (const entry of fixture.entries) {
    const file = decode(DEFAULT_THEMES[entry.name])
    const effectiveMode = selectThemeMode(file, entry.requestedMode).mode
    expect(effectiveMode).toBe(entry.effectiveMode)
    const resolved = resolveThemeFile(file, effectiveMode, entry.name)
    for (const role of LEGACY_ROLES) {
      expect(
        [...SEMANTIC_SELECTORS[role](resolved, effectiveMode).toInts()],
        `${entry.name}/${entry.requestedMode}/${role}`,
      ).toEqual([...entry.colors[role]])
    }
    expect(entry.thinkingOpacity).toBe(0.6)
    expect("thinkingOpacity" in resolved).toBe(false)
  }
})
