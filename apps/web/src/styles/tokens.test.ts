import { describe, expect, test } from "bun:test"
import { COLOR_ROLES } from "../theme/schemes"
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

const REMOVED = [
  "--yc-bg", "--yc-surface", "--yc-surface-sunken", "--yc-surface-raised", "--yc-text", "--yc-text-muted", "--yc-text-subtle",
  "--yc-border", "--yc-border-strong", "--yc-green", "--yc-green-strong", "--yc-green-soft", "--yc-primary-bg", "--yc-primary-fg",
  "--yc-yellow", "--yc-yellow-strong", "--yc-yellow-soft", "--yc-danger", "--yc-danger-soft", "--yc-signal",
  "--yc-effort", "--yc-effort-none", "--yc-effort-minimal", "--yc-effort-low", "--yc-effort-medium", "--yc-effort-high", "--yc-effort-xhigh", "--yc-effort-max",
  "--yc-context-system", "--yc-context-tools", "--yc-context-assistant", "--yc-context-reasoning", "--yc-context-tool-calls",
  "--yc-shadow-sm", "--yc-shadow-md", "--yc-shadow-lg", "--yc-radius-sm", "--yc-radius-md", "--yc-radius-lg", "--yc-radius-xl", "--yc-dur-slow",
] as const

const TERMINAL = {
  "--yc-terminal-bg": "#0c1413",
  "--yc-terminal-fg": "#d8e6de",
  "--yc-terminal-dim": "#8fa79b",
  "--yc-terminal-accent": "#5fe3a1",
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
  "--yc-header-public-h": "56px",
  "--yc-header-session-h": "44px",
  "--yc-status-strip-h": "36px",
  "--yc-bottom-nav-h": "56px",
  "--yc-control-h": "44px",
  "--yc-control-h-dense": "36px",
  "--yc-hit-min": "44px",
  "--yc-control-pad-x": "16px",
  "--yc-border-width": "1px",
  "--yc-radius-detail": "4px",
  "--yc-radius-control": "6px",
  "--yc-radius-card": "8px",
  "--yc-radius-composer": "12px",
  "--yc-radius-pill": "999px",
  "--yc-icon-xs": "14px",
  "--yc-icon-sm": "16px",
  "--yc-icon-md": "20px",
  "--yc-measure": "68ch",
  "--yc-measure-narrow": "54ch",
  "--yc-measure-wide": "120ch",
} as const

const COMPOSITIONAL_LAYOUT = {
  "--yc-content-max": "1200px",
  "--yc-public-max": "1440px",
  "--yc-content-max-wide": "1600px",
  "--yc-rail-w": "256px",
  "--yc-rail-min-w": "232px",
  "--yc-rail-max-w": "360px",
  "--yc-activity-w": "80px",
  "--yc-status-h": "28px",
  "--yc-companion-w": "448px",
  "--yc-docs-nav-w": "248px",
  "--yc-docs-toc-w": "200px",
  "--yc-device-max": "180px",
} as const

const MOTION = {
  "--yc-dur-instant": "80ms",
  "--yc-dur-quick": "140ms",
  "--yc-dur-base": "220ms",
  "--yc-dur-trace": "1760ms",
  "--yc-dur-spin": "660ms",
  "--yc-ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
  "--yc-ease-entrance": "cubic-bezier(0, 0, 0.2, 1)",
  "--yc-ease-exit": "cubic-bezier(0.4, 0, 1, 1)",
  "--yc-ease-linear": "linear",
  "--yc-ease-caret": "steps(2, jump-none)",
  "--yc-motion-spatial-dur": "var(--yc-dur-base)",
  "--yc-motion-effect-dur": "var(--yc-dur-quick)",
  "--yc-motion-exit-dur": "var(--yc-dur-quick)",
  "--yc-motion-feedback-dur": "var(--yc-dur-instant)",
  "--yc-motion-travel": "1",
  "--yc-motion-ease": "var(--yc-ease-standard)",
} as const

const MOTION_REDUCED = {
  "--yc-motion-spatial-dur": "0s",
  "--yc-motion-effect-dur": "var(--yc-dur-instant)",
  "--yc-motion-exit-dur": "0s",
  "--yc-motion-travel": "0",
} as const

const MOTION_OFF = {
  "--yc-motion-spatial-dur": "0s",
  "--yc-motion-effect-dur": "0s",
  "--yc-motion-exit-dur": "0s",
  "--yc-motion-feedback-dur": "0s",
  "--yc-motion-travel": "0",
} as const

const STACKING = {
  "--yc-z-header": "30",
  "--yc-z-nav": "20",
  "--yc-z-scrim": "90",
  "--yc-z-overlay": "100",
  "--yc-z-toast": "110",
} as const

describe("approved token contract", () => {
  test("declares every color role in the light and dark blocks and none of the retired names", async () => {
    const sheet = await readStylesheet("tokens.css")
    const light = rootDeclarations(sheet)
    const dark = blockDeclarations(sheet, '[data-theme="dark"]')
    const roles = COLOR_ROLES.map((role) => `--yc-${role}`)
    expect(roles.filter((role) => light[role] === undefined)).toEqual([])
    expect(roles.filter((role) => dark[role] === undefined)).toEqual([])
    const declared = sheet.rules.flatMap((rule) => Object.keys(rule.declarations))
    expect(REMOVED.filter((name) => declared.includes(name))).toEqual([])
  })

  test("keeps the terminal plate identical across themes", async () => {
    const sheet = await readStylesheet("tokens.css")
    const light = rootDeclarations(sheet)
    const dark = blockDeclarations(sheet, '[data-theme="dark"]')
    for (const [token, value] of Object.entries(TERMINAL)) expect({ token, light: light[token], dark: dark[token] ?? light[token] }).toEqual({ token, light: value, dark: value })
  })

  test("no web stylesheet or component references a retired token", async () => {
    const glob = new Bun.Glob("**/*.{css,ts,tsx,html}")
    const root = new URL("../..", import.meta.url).pathname
    const retired = new RegExp(`(${REMOVED.join("|")})(?![-a-z0-9])`)
    const offenders: string[] = []
    for await (const file of glob.scan({ cwd: root })) {
      if (file.includes("node_modules") || file.startsWith("src/content/") || file.endsWith("tokens.test.ts")) continue
      const text = await Bun.file(`${root}${file}`).text()
      const match = text.match(retired)
      if (match) offenders.push(`${file}: ${match[1]}`)
    }
    expect(offenders).toEqual([])
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
      "--yc-size-display": "48px",
      "--yc-leading-display": "52px",
    })
  })

  test("declares the 4px spacing scale", async () => {
    const light = rootDeclarations(await readStylesheet("tokens.css"))
    for (const [step, value] of Object.entries(SPACE)) {
      expect({ step, value: light[`--yc-space-${step}`] }).toEqual({ step, value: `${value}px` })
    }
  })

  test("declares one floating elevation per theme", async () => {
    const sheet = await readStylesheet("tokens.css")
    expect(rootDeclarations(sheet)["--yc-elevation-float"]).toBe("0 1px 2px rgba(0, 0, 0, 0.08), 0 12px 32px -8px rgba(0, 0, 0, 0.12)")
    expect(blockDeclarations(sheet, '[data-theme="dark"]')["--yc-elevation-float"]).toBe("0 1px 2px rgba(0, 0, 0, 0.35), 0 12px 32px -8px rgba(0, 0, 0, 0.5)")
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

  test("maps the semantic motion tokens to instant spatial motion and a short crossfade under reduced motion", async () => {
    const sheet = await readStylesheet("tokens.css")
    const reduced = declarationsWhere(
      sheet,
      (rule) => rule.header === ":root" && rule.conditions.includes("@media (prefers-reduced-motion: reduce)"),
    )
    expect(pick(reduced, Object.keys(MOTION_REDUCED))).toEqual(MOTION_REDUCED)
    expect(Object.keys(reduced).sort()).toEqual(Object.keys(MOTION_REDUCED).sort())
    const off = declarationsWhere(sheet, (rule) => rule.header === ':root[data-animations="off"]')
    expect(off).toEqual(MOTION_OFF)
  })

  test("defines the semantic motion tokens in tokens.css only", async () => {
    for (const name of ["base.css", "site.css", "docs.css", "remote.css"]) {
      const sheet = await readStylesheet(name)
      const declared = sheet.rules.flatMap((rule) => Object.keys(rule.declarations)).filter((property) => property.startsWith("--yc-motion-"))
      expect({ name, declared }).toEqual({ name, declared: [] })
    }
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
