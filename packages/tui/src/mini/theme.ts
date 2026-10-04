// Theme resolution for direct interactive mode.
//
// Derives scrollback and footer colors from the terminal's actual palette.
// resolveRunTheme() queries the renderer for the terminal's palette,
// detects dark/light mode, builds a small system theme locally, and maps it to
// the run footer + scrollback color model. Falls back to a hardcoded dark-mode
// palette if detection fails.
import { RGBA, SyntaxStyle, type CliRenderer, type ColorInput, type TerminalColors } from "@opentui/core"
import { ansiToRgba } from "../theme/color"
import { terminalMode } from "../theme/system"
import { generateSyntax } from "../theme/syntax"
import type { EntryKind, RunTuiConfig } from "./types"

type Tone = {
  body: ColorInput
  start?: ColorInput
}

export type RunEntryTheme = Record<EntryKind, Tone>

export type RunSplashTheme = {
  left: ColorInput
  right: ColorInput
  leftShadow: ColorInput
}

export type RunFooterTheme = {
  highlight: ColorInput
  selected: ColorInput
  selectedText: ColorInput
  warning: ColorInput
  error: ColorInput
  muted: ColorInput
  text: ColorInput
  status: ColorInput
  statusAccent: ColorInput
  shade: ColorInput
  surface: ColorInput
  pane: ColorInput
  border: ColorInput
  line: ColorInput
}

export type RunBlockTheme = {
  text: ColorInput
  muted: ColorInput
  syntax?: SyntaxStyle
  diffRemoved: ColorInput
  diffAddedBg: ColorInput
  diffRemovedBg: ColorInput
  diffContextBg: ColorInput
  diffHighlightAdded: ColorInput
  diffHighlightRemoved: ColorInput
  diffLineNumber: ColorInput
  diffAddedLineNumberBg: ColorInput
  diffRemovedLineNumberBg: ColorInput
}

export type RunTheme = {
  background: ColorInput
  footer: RunFooterTheme
  entry: RunEntryTheme
  splash: RunSplashTheme
  block: RunBlockTheme
}

export const transparent = RGBA.fromValues(0, 0, 0, 0)

function alpha(color: RGBA, value: number): RGBA {
  return RGBA.fromValues(color.r, color.g, color.b, Math.max(0, Math.min(1, value)))
}

function rgba(hex: string, value?: number): RGBA {
  const color = RGBA.fromHex(hex)
  return value === undefined ? color : alpha(color, value)
}

function colorMode(bg: RGBA): "dark" | "light" {
  return luminance(bg) > 0.5 ? "light" : "dark"
}

function luminance(color: RGBA): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function fade(color: RGBA, base: RGBA, fallback: number, scale: number, limit: number): RGBA {
  if (color.a === 0) {
    return RGBA.fromValues(color.r, color.g, color.b, Math.max(0, Math.min(1, fallback)))
  }

  const target = Math.min(limit, color.a * scale)
  const mix = Math.min(1, target / color.a)

  return RGBA.fromValues(
    base.r + (color.r - base.r) * mix,
    base.g + (color.g - base.g) * mix,
    base.b + (color.b - base.b) * mix,
    color.a,
  )
}

function tint(base: RGBA, overlay: RGBA, value: number): RGBA {
  return RGBA.fromInts(
    Math.round((base.r + (overlay.r - base.r) * value) * 255),
    Math.round((base.g + (overlay.g - base.g) * value) * 255),
    Math.round((base.b + (overlay.b - base.b) * value) * 255),
  )
}

function chroma(color: RGBA) {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b)
}

function indexedPalette(colors: TerminalColors, size: number = Math.max(colors.palette.length, 16)): RGBA[] {
  return Array.from({ length: size }, (_, index) => {
    const value = colors.palette[index]
    return RGBA.fromIndex(index, value ? RGBA.fromHex(value) : ansiToRgba(index))
  })
}

function srgbToLinear(value: number): number {
  if (value <= 0.04045) {
    return value / 12.92
  }

  return ((value + 0.055) / 1.055) ** 2.4
}

function oklab(color: RGBA) {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

function nearestIndexed(indexed: RGBA[], rgba: RGBA): RGBA {
  const target = oklab(rgba)
  const hit = indexed.reduce(
    (best, item) => {
      const sample = oklab(item)
      const dl = sample.l - target.l
      const da = sample.a - target.a
      const db = sample.b - target.b
      const dist = dl * dl * 2 + da * da + db * db
      if (dist >= best.dist) return best
      return {
        dist,
        item,
      }
    },
    {
      dist: Number.POSITIVE_INFINITY,
      item: indexed[0]!,
    },
  )

  return RGBA.clone(hit.item)
}

function paletteColor(colors: TerminalColors, index: number): RGBA {
  const value = colors.palette[index]
  return value ? RGBA.fromHex(value) : ansiToRgba(index)
}

function splashShadow(indexed: RGBA[], base: RGBA, overlay: RGBA, value: number): RGBA {
  const mixed = tint(base, overlay, value)
  return nearestIndexed(indexed, mixed)
}

function generateGrayScale(bg: RGBA, isDark: boolean, map: (rgba: RGBA) => RGBA): Record<number, RGBA> {
  const r = bg.r * 255
  const g = bg.g * 255
  const b = bg.b * 255
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  const cast = 0.25 * (1 - chroma(bg)) ** 2

  const gray = (level: number) => {
    const factor = level / 12

    if (isDark && lum < 10) {
      const value = Math.floor(factor * 0.4 * 255)
      return map(RGBA.fromInts(value, value, value))
    }

    if (!isDark && lum > 245) {
      const value = Math.floor(255 - factor * 0.4 * 255)
      return map(RGBA.fromInts(value, value, value))
    }

    const value = isDark ? lum + (255 - lum) * factor * 0.4 : lum * (1 - factor * 0.4)
    const tone = RGBA.fromInts(Math.floor(value), Math.floor(value), Math.floor(value))
    if (cast === 0) return map(tone)

    const ratio = lum === 0 ? 0 : value / lum
    return map(
      tint(
        tone,
        RGBA.fromInts(
          Math.floor(Math.max(0, Math.min(r * ratio, 255))),
          Math.floor(Math.max(0, Math.min(g * ratio, 255))),
          Math.floor(Math.max(0, Math.min(b * ratio, 255))),
        ),
        cast,
      ),
    )
  }

  return Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, gray(index + 1)]))
}

function generateMutedTextColor(bg: RGBA, isDark: boolean, map: (rgba: RGBA) => RGBA): RGBA {
  const lum = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255
  const gray = isDark
    ? lum < 10
      ? 180
      : Math.min(Math.floor(160 + lum * 0.3), 200)
    : lum > 245
      ? 75
      : Math.max(Math.floor(100 - (255 - lum) * 0.2), 60)

  return map(RGBA.fromInts(gray, gray, gray))
}

export function generateSystem(colors: TerminalColors, pick: "dark" | "light") {
  const bg_snapshot = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg_snapshot = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const bg = RGBA.defaultBackground(bg_snapshot)
  const fg = RGBA.defaultForeground(fg_snapshot)
  const isDark = pick === "dark"

  const color = (index: number) => paletteColor(colors, index)

  const grays = generateGrayScale(bg_snapshot, isDark, (rgba) => rgba)
  const textMuted = generateMutedTextColor(bg_snapshot, isDark, (rgba) => rgba)

  const ansi = {
    red: color(1),
    green: color(2),
    yellow: color(3),
    blue: color(4),
    magenta: color(5),
    cyan: color(6),
    red_bright: color(9),
    green_bright: color(10),
  }

  const diff_alpha = isDark ? 0.22 : 0.14
  const diff_context_bg = grays[2]
  return {
    hue: { accent: { 200: ansi.cyan, 800: ansi.cyan } },
    categorical: [{ 200: ansi.magenta, 800: ansi.magenta }],
    text: {
      default: fg,
      subdued: textMuted,
      action: {
        primary: { selected: ansi.cyan, focused: bg },
        destructive: { default: bg },
      },
      feedback: {
        error: { default: ansi.red },
        warning: { default: ansi.yellow },
        success: { default: ansi.green },
        info: { default: ansi.cyan },
      },
    },
    background: {
      default: alpha(bg, 0),
      surface: { offset: grays[2], overlay: grays[3] },
      action: { primary: { focused: ansi.cyan } },
    },
    border: { default: grays[7], active: grays[8], subtle: grays[6] },
    diff: {
      text: { added: ansi.green, removed: ansi.red, context: grays[7], hunkHeader: grays[7] },
      background: {
        added: tint(bg_snapshot, ansi.green, diff_alpha),
        removed: tint(bg_snapshot, ansi.red, diff_alpha),
        context: diff_context_bg,
      },
      highlight: { added: ansi.green_bright, removed: ansi.red_bright },
      lineNumber: {
        text: textMuted,
        background: {
          added: tint(diff_context_bg, ansi.green, diff_alpha),
          removed: tint(diff_context_bg, ansi.red, diff_alpha),
        },
      },
    },
    markdown: {
      text: fg,
      heading: fg,
      link: ansi.blue,
      linkText: ansi.cyan,
      code: ansi.green,
      blockQuote: ansi.yellow,
      emphasis: ansi.yellow,
      strong: fg,
      horizontalRule: grays[7],
      listItem: ansi.blue,
      listEnumeration: ansi.cyan,
      image: ansi.blue,
      imageText: ansi.cyan,
      codeBlock: fg,
    },
    syntax: {
      comment: textMuted,
      keyword: ansi.magenta,
      function: ansi.blue,
      variable: fg,
      string: ansi.green,
      number: ansi.yellow,
      type: ansi.cyan,
      operator: ansi.cyan,
      punctuation: fg,
    },
  }
}

function quantizeColor(indexed: RGBA[], rgba: RGBA): RGBA {
  if (rgba.a === 0 || rgba.intent === "default" || rgba.intent === "indexed") {
    return RGBA.clone(rgba)
  }

  return nearestIndexed(indexed, rgba)
}

type MiniPalette = ReturnType<typeof generateSystem>

function quantizeTheme(theme: MiniPalette, indexed: RGBA[]): MiniPalette {
  const q = (color: RGBA) => quantizeColor(indexed, color)
  return {
    hue: { accent: { 200: q(theme.hue.accent[200]), 800: q(theme.hue.accent[800]) } },
    categorical: theme.categorical.map((scale) => ({ 200: q(scale[200]), 800: q(scale[800]) })),
    text: {
      default: q(theme.text.default),
      subdued: q(theme.text.subdued),
      action: {
        primary: { selected: q(theme.text.action.primary.selected), focused: q(theme.text.action.primary.focused) },
        destructive: { default: q(theme.text.action.destructive.default) },
      },
      feedback: {
        error: { default: q(theme.text.feedback.error.default) },
        warning: { default: q(theme.text.feedback.warning.default) },
        success: { default: q(theme.text.feedback.success.default) },
        info: { default: q(theme.text.feedback.info.default) },
      },
    },
    background: {
      default: q(theme.background.default),
      surface: { offset: q(theme.background.surface.offset), overlay: q(theme.background.surface.overlay) },
      action: { primary: { focused: q(theme.background.action.primary.focused) } },
    },
    border: {
      default: q(theme.border.default),
      active: q(theme.border.active),
      subtle: q(theme.border.subtle),
    },
    diff: {
      text: {
        added: q(theme.diff.text.added),
        removed: q(theme.diff.text.removed),
        context: q(theme.diff.text.context),
        hunkHeader: q(theme.diff.text.hunkHeader),
      },
      background: {
        added: q(theme.diff.background.added),
        removed: q(theme.diff.background.removed),
        context: q(theme.diff.background.context),
      },
      highlight: { added: q(theme.diff.highlight.added), removed: q(theme.diff.highlight.removed) },
      lineNumber: {
        text: q(theme.diff.lineNumber.text),
        background: {
          added: q(theme.diff.lineNumber.background.added),
          removed: q(theme.diff.lineNumber.background.removed),
        },
      },
    },
    markdown: {
      text: q(theme.markdown.text),
      heading: q(theme.markdown.heading),
      link: q(theme.markdown.link),
      linkText: q(theme.markdown.linkText),
      code: q(theme.markdown.code),
      blockQuote: q(theme.markdown.blockQuote),
      emphasis: q(theme.markdown.emphasis),
      strong: q(theme.markdown.strong),
      horizontalRule: q(theme.markdown.horizontalRule),
      listItem: q(theme.markdown.listItem),
      listEnumeration: q(theme.markdown.listEnumeration),
      image: q(theme.markdown.image),
      imageText: q(theme.markdown.imageText),
      codeBlock: q(theme.markdown.codeBlock),
    },
    syntax: {
      comment: q(theme.syntax.comment),
      keyword: q(theme.syntax.keyword),
      function: q(theme.syntax.function),
      variable: q(theme.syntax.variable),
      string: q(theme.syntax.string),
      number: q(theme.syntax.number),
      type: q(theme.syntax.type),
      operator: q(theme.syntax.operator),
      punctuation: q(theme.syntax.punctuation),
    },
  }
}

function splashTheme(theme: MiniPalette, indexed: RGBA[]): RunSplashTheme {
  const left = nearestIndexed(indexed, theme.text.subdued)
  const right = nearestIndexed(indexed, theme.text.default)
  return {
    left,
    right,
    leftShadow: splashShadow(indexed, theme.background.default, left, 0.14),
  }
}

function map(
  footerTheme: MiniPalette,
  scrollbackTheme: MiniPalette,
  splash: RunSplashTheme,
  syntax?: SyntaxStyle,
): RunTheme {
  const footerBackground = alpha(footerTheme.background.default, 1)
  const footerMode = colorMode(footerBackground)
  const shade = fade(footerTheme.background.surface.overlay, footerTheme.background.default, 0.12, 0.56, 0.72)
  const surface = fade(footerTheme.background.surface.overlay, footerTheme.background.default, 0.18, 0.76, 0.9)
  const line = fade(footerTheme.background.surface.overlay, footerTheme.background.default, 0.24, 0.9, 0.98)
  const statusBase = tint(footerBackground, rgba("#000000"), footerMode === "dark" ? 0.12 : 0.06)
  const statusAccentBase =
    footerMode === "dark" ? tint(footerBackground, rgba("#ffffff"), 0.06) : tint(statusBase, rgba("#000000"), 0.04)
  const collapsedStatus = footerMode === "dark" && luminance(statusBase) <= 0.04
  // Pure-black backgrounds need a slight lift or the row disappears into the terminal background.
  const status = collapsedStatus ? tint(statusBase, statusAccentBase, 0.7) : statusBase
  const statusAccent = collapsedStatus ? tint(status, rgba("#ffffff"), 0.06) : statusAccentBase

  return {
    background: footerTheme.background.default,
    footer: {
      highlight: footerTheme.text.action.primary.selected,
      selected: footerTheme.background.surface.overlay,
      selectedText: footerTheme.text.action.primary.focused,
      warning: footerTheme.text.feedback.warning.default,
      error: footerTheme.text.feedback.error.default,
      muted: footerTheme.text.subdued,
      text: footerTheme.text.default,
      status,
      statusAccent,
      shade,
      surface,
      pane: footerTheme.background.surface.overlay,
      border: footerTheme.border.default,
      line,
    },
    entry: {
      system: {
        body: scrollbackTheme.text.subdued,
      },
      user: {
        body: scrollbackTheme.text.action.primary.selected,
      },
      assistant: {
        body: scrollbackTheme.text.default,
      },
      reasoning: {
        body: scrollbackTheme.text.subdued,
      },
      tool: {
        body: scrollbackTheme.text.default,
        start: scrollbackTheme.text.subdued,
      },
      error: {
        body: scrollbackTheme.text.feedback.error.default,
      },
    },
    splash,
    block: {
      text: scrollbackTheme.text.default,
      muted: scrollbackTheme.text.subdued,
      syntax,
      diffRemoved: scrollbackTheme.diff.text.removed,
      diffAddedBg: transparent,
      diffRemovedBg: transparent,
      diffContextBg: transparent,
      diffHighlightAdded: scrollbackTheme.diff.highlight.added,
      diffHighlightRemoved: scrollbackTheme.diff.highlight.removed,
      diffLineNumber: scrollbackTheme.diff.lineNumber.text,
      diffAddedLineNumberBg: scrollbackTheme.diff.lineNumber.background.added,
      diffRemovedLineNumberBg: scrollbackTheme.diff.lineNumber.background.removed,
    },
  }
}

const seed = {
  highlight: RGBA.fromIndex(6, rgba("#38bdf8")),
  muted: RGBA.fromIndex(8, rgba("#64748b")),
  text: RGBA.defaultForeground(rgba("#f8fafc")),
  panel: rgba("#0f172a"),
  success: RGBA.fromIndex(2, rgba("#22c55e")),
  warning: RGBA.fromIndex(3, rgba("#f59e0b")),
  error: RGBA.fromIndex(1, rgba("#ef4444")),
}

function tone(body: ColorInput, start?: ColorInput): Tone {
  return {
    body,
    start,
  }
}

const fallbackSplashIndexed = Array.from({ length: 256 }, (_, index) => RGBA.fromIndex(index))
const fallbackSplashLeft = RGBA.fromIndex(67)
const fallbackSplashRight = RGBA.fromIndex(110)

export const RUN_THEME_FALLBACK: RunTheme = {
  background: RGBA.fromValues(0, 0, 0, 0),
  footer: {
    highlight: seed.highlight,
    selected: seed.text,
    selectedText: seed.panel,
    warning: seed.warning,
    error: seed.error,
    muted: seed.muted,
    text: seed.text,
    status: tint(seed.panel, rgba("#000000"), 0.12),
    statusAccent: tint(seed.panel, rgba("#ffffff"), 0.06),
    shade: alpha(seed.panel, 0.68),
    surface: alpha(seed.panel, 0.86),
    pane: seed.panel,
    border: seed.muted,
    line: alpha(seed.panel, 0.96),
  },
  entry: {
    system: tone(seed.muted),
    user: tone(seed.highlight),
    assistant: tone(seed.text),
    reasoning: tone(seed.muted),
    tool: tone(seed.text, seed.muted),
    error: tone(seed.error),
  },
  splash: {
    left: fallbackSplashLeft,
    right: fallbackSplashRight,
    leftShadow: splashShadow(fallbackSplashIndexed, RGBA.fromValues(0, 0, 0, 0), fallbackSplashLeft, 0.14),
  },
  block: {
    text: seed.text,
    muted: seed.muted,
    diffRemoved: seed.error,
    diffAddedBg: alpha(seed.success, 0.18),
    diffRemovedBg: alpha(seed.error, 0.18),
    diffContextBg: alpha(seed.panel, 0.72),
    diffHighlightAdded: seed.success,
    diffHighlightRemoved: seed.error,
    diffLineNumber: seed.muted,
    diffAddedLineNumberBg: alpha(seed.success, 0.12),
    diffRemovedLineNumberBg: alpha(seed.error, 0.12),
  },
}

export async function resolveRunTheme(renderer: CliRenderer, config?: RunTuiConfig["theme"]): Promise<RunTheme> {
  try {
    const colors = await renderer.getPalette({
      size: 256,
    })
    const bg = colors.defaultBackground ?? colors.palette[0]
    if (!bg) {
      return RUN_THEME_FALLBACK
    }

    // Palette-only terminal reloads can leave renderer.themeMode stale, but
    // ANSI slot zero is not the terminal background when OSC 11 is absent.
    const pick =
      config?.mode === "dark" || config?.mode === "light"
        ? config.mode
        : (terminalMode(colors) ?? renderer.themeMode ?? colorMode(RGBA.fromHex(bg)))
    const indexed = indexedPalette(colors, 256)
    const footerTheme = generateSystem(colors, pick)
    const scrollbackTheme = quantizeTheme(footerTheme, indexed)
    return map(
      footerTheme,
      scrollbackTheme,
      splashTheme(scrollbackTheme, indexed),
      generateSyntax(scrollbackTheme, pick),
    )
  } catch {
    return RUN_THEME_FALLBACK
  }
}
