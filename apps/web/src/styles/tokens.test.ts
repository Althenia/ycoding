import { describe, expect, test } from "bun:test"
import { declarationsWhere, readStylesheet, widthThreshold, type Declarations, type Stylesheet } from "./css-rules"

/**
 * The approved design-system tokens in `.aphrodite/redesign-audit/specs/tokens.toon`.
 *
 * The two layers the contract separates:
 *
 * - invariant: control height, hit area, type size, line height, header rows,
 *   status-strip row, radius, border width, and motion duration never move with
 *   viewport width;
 * - compositional: the inline gutter and the display step are the only width-driven
 *   values, and both are absolute steps at a declared breakpoint, never a ratio.
 */

const LIGHT = {
  "--yc-green": "#27d17f",
  "--yc-green-strong": "#0a7b47",
  "--yc-green-soft": "rgba(39, 209, 127, 0.12)",
  "--yc-primary-bg": "#0b8550",
  "--yc-primary-fg": "#ffffff",
  "--yc-yellow": "#f4bd3d",
  "--yc-yellow-strong": "#946200",
  "--yc-yellow-soft": "rgba(244, 189, 61, 0.16)",
  "--yc-danger": "#c53a3a",
  "--yc-danger-soft": "rgba(197, 58, 58, 0.1)",
  "--yc-focus": "#0b8b50",
  "--yc-bg": "#ffffff",
  "--yc-surface": "#f7f9f8",
  "--yc-surface-sunken": "#eff3f1",
  "--yc-surface-raised": "#ffffff",
  "--yc-text": "#0b0f14",
  "--yc-text-muted": "#5c6672",
  "--yc-text-subtle": "#646d78",
  "--yc-border": "#e4e8e6",
  "--yc-border-strong": "#78847e",
  "--yc-terminal-bg": "#0c1413",
  "--yc-terminal-fg": "#d8e6de",
  "--yc-terminal-dim": "#8fa79b",
  "--yc-terminal-accent": "#5fe3a1",
} as const

const DARK = {
  "--yc-green": "#27d17f",
  "--yc-green-strong": "#4ee29b",
  "--yc-green-soft": "rgba(39, 209, 127, 0.16)",
  "--yc-primary-bg": "#4ee29b",
  "--yc-primary-fg": "#04150c",
  "--yc-yellow-strong": "#f7d37c",
  "--yc-yellow-soft": "rgba(244, 189, 61, 0.14)",
  "--yc-danger": "#ef6f6f",
  "--yc-danger-soft": "rgba(239, 111, 111, 0.14)",
  "--yc-focus": "#4ee29b",
  "--yc-bg": "#0b1115",
  "--yc-surface": "#11181d",
  "--yc-surface-sunken": "#0e151a",
  "--yc-surface-raised": "#151e24",
  "--yc-text": "#f4f7f6",
  "--yc-text-muted": "#99a2ad",
  "--yc-text-subtle": "#7d8792",
  "--yc-border": "#263039",
  "--yc-border-strong": "#718278",
  "--yc-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.4)",
  "--yc-shadow-md": "0 10px 30px rgba(0, 0, 0, 0.45)",
  "--yc-shadow-lg": "0 24px 56px rgba(0, 0, 0, 0.55)",
} as const

/** Type size and the line height that pairs with it. */
const TYPE_STEPS = {
  "2xs": [12, 16],
  xs: [13, 20],
  sm: [14, 22],
  md: [16, 26],
  lg: [18, 28],
  xl: [20, 30],
  "2xl": [24, 32],
  "3xl": [30, 38],
  "4xl": [36, 42],
} as const

/** Spacing step name to value; the names are the contract, not a 1..11 index. */
const SPACE = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
} as const

/** Inline gutter step, keyed by the breakpoint that introduces it. */
const GUTTER_STEPS = [
  [0, "16px"],
  [480, "20px"],
  [640, "24px"],
  [1024, "32px"],
  [1280, "40px"],
  [1600, "48px"],
] as const

const INVARIANT_LAYOUT = {
  "--yc-header-h": "60px",
  "--yc-header-session-h": "44px",
  "--yc-status-strip-h": "36px",
  "--yc-bottom-nav-h": "56px",
  "--yc-control-h": "44px",
  "--yc-control-h-dense": "36px",
  "--yc-hit-min": "44px",
  "--yc-control-pad-x": "16px",
  "--yc-border-width": "1px",
  "--yc-radius-sm": "6px",
  "--yc-radius-md": "10px",
  "--yc-radius-lg": "14px",
  "--yc-radius-xl": "20px",
  "--yc-radius-pill": "999px",
  "--yc-measure": "68ch",
  "--yc-measure-narrow": "54ch",
} as const

const COMPOSITIONAL_LAYOUT = {
  "--yc-content-max": "1200px",
  "--yc-rail-w": "288px",
  "--yc-activity-w": "344px",
  "--yc-docs-nav-w": "248px",
  "--yc-docs-toc-w": "200px",
  "--yc-device-max": "180px",
} as const

const MOTION = {
  "--yc-dur-instant": "80ms",
  "--yc-dur-quick": "140ms",
  "--yc-dur-base": "220ms",
  "--yc-dur-slow": "320ms",
  "--yc-ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
  "--yc-ease-entrance": "cubic-bezier(0, 0, 0.2, 1)",
  "--yc-ease-exit": "cubic-bezier(0.4, 0, 1, 1)",
} as const

const STACKING = {
  "--yc-z-header": "30",
  "--yc-z-nav": "20",
  "--yc-z-scrim": "90",
  "--yc-z-overlay": "100",
  "--yc-z-toast": "110",
} as const

describe("approved token contract", () => {
  test("declares every contract colour with its approved light value", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    expect(pick(light, Object.keys(LIGHT))).toEqual(LIGHT)
  })

  test("declares every theme-dependent colour in the dark block", async () => {
    const dark = blockDeclarations(await readStylesheet("tokens.css"), '[data-theme="dark"]')
    expect(pick(dark, Object.keys(DARK))).toEqual(DARK)
  })

  test("keeps the brand accent, attention marker, and terminal inks identical across themes", async () => {
    const sheet = await readStylesheet("tokens.css")
    const light = rootDeclarations(sheet)
    const dark = blockDeclarations(sheet, '[data-theme="dark"]')
    // Identical ink on the terminal plate in both themes is the contract, so the
    // dark block either repeats the value or omits the token entirely.
    const identical = {
      "--yc-green": "#27d17f",
      "--yc-yellow": "#f4bd3d",
      "--yc-terminal-bg": "#0c1413",
      "--yc-terminal-fg": "#d8e6de",
      "--yc-terminal-dim": "#8fa79b",
      "--yc-terminal-accent": "#5fe3a1",
    }
    for (const [token, value] of Object.entries(identical)) {
      expect({ token, dark: dark[token] ?? light[token] }).toEqual({ token, dark: value })
    }
  })

  test("declares a size and a line height for every type step", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    for (const [step, [size, leading]] of Object.entries(TYPE_STEPS)) {
      expect({ step, size: light[`--yc-size-${step}`] }).toEqual({ step, size: `${size}px` })
      expect({ step, leading: light[`--yc-leading-${step}`] }).toEqual({ step, leading: `${leading}px` })
    }
  })

  test("steps the display type at 1024, the headline wrap point", async () => {
    const sheet = await readStylesheet("tokens.css")
    expect(rootDeclarations(sheet)["--yc-size-display"]).toBe("40px")
    expect(rootDeclarations(sheet)["--yc-leading-display"]).toBe("44px")
    expect(stepDeclarations(sheet, 1024)).toMatchObject({
      "--yc-size-display": "56px",
      "--yc-leading-display": "60px",
    })
  })

  test("declares the 4px spacing scale", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    for (const [step, value] of Object.entries(SPACE)) {
      expect({ step, value: light[`--yc-space-${step}`] }).toEqual({ step, value: `${value}px` })
    }
  })

  test("declares the three elevation steps", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    expect(pick(light, ["--yc-shadow-sm", "--yc-shadow-md", "--yc-shadow-lg"])).toEqual({
      "--yc-shadow-sm": "0 1px 2px rgba(11, 15, 20, 0.06)",
      "--yc-shadow-md": "0 8px 24px rgba(11, 15, 20, 0.08)",
      "--yc-shadow-lg": "0 20px 48px rgba(11, 15, 20, 0.16)",
    })
  })

  test("declares control geometry as an invariant", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    expect(pick(light, Object.keys(INVARIANT_LAYOUT))).toEqual(INVARIANT_LAYOUT)
  })

  test("declares the header rows, status strip, and structural metrics", async () => {
    const sheet = await readStylesheet("tokens.css")
    const light = rootDeclarations(sheet)
    expect(pick(light, Object.keys(COMPOSITIONAL_LAYOUT))).toEqual(COMPOSITIONAL_LAYOUT)
    // Two surfaces must not name the same row with two different tokens.
    expect(light["--yc-header-height"]).toBeUndefined()
    expect(light["--yc-bottom-nav-height"]).toBeUndefined()
  })

  test("declares the motion durations and easings", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    expect(pick(light, Object.keys(MOTION))).toEqual(MOTION)
  })

  test("declares the stacking order", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    expect(pick(light, Object.keys(STACKING))).toEqual(STACKING)
  })

  test("raises the gutter one absolute step at each declared breakpoint", async () => {
    const sheet = await readStylesheet("tokens.css")
    for (const [min, value] of GUTTER_STEPS) {
      const declarations = min === 0 ? rootDeclarations(sheet) : stepDeclarations(sheet, min)
      expect({ min, gutter: declarations["--yc-gutter"] }).toEqual({ min, gutter: value })
    }
  })

  test("enlarges only the dense control under a coarse pointer", async () => {
    const sheet = await readStylesheet("tokens.css")
    const coarse = declarationsWhere(
      sheet,
      (rule) => rule.conditions.some((condition) => condition.includes("pointer: coarse")),
    )
    expect(coarse["--yc-control-h-dense"]).toBe("44px")
    // Density follows the pointer, never the viewport width: no width step may
    // resize a control.
    const widthDriven = sheet.rules.filter(
      (rule) => rule.conditions.some((condition) => widthThreshold(condition) !== undefined) && rule.declarations["--yc-control-h-dense"] !== undefined,
    )
    expect(widthDriven.map((rule) => rule.conditions)).toEqual([])
  })
})

function pick(declarations: Declarations, names: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, declarations[name]]))
}

function rootDeclarations(sheet: Stylesheet): Declarations {
  return declarationsWhere(sheet, (rule) => rule.header === ":root" && rule.conditions.length === 0)
}

function blockDeclarations(sheet: Stylesheet, selector: string): Declarations {
  return declarationsWhere(sheet, (rule) => rule.header === selector)
}

/** Declarations a `:root` rule applies at exactly one `min-width` step. */
function stepDeclarations(sheet: Stylesheet, min: number): Declarations {
  return declarationsWhere(
    sheet,
    (rule) =>
      rule.header === ":root" &&
      rule.conditions.some((condition) => widthThreshold(condition)?.min === min),
  )
}
