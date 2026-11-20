import { describe, expect, test } from "bun:test"
import { HUES, SCHEMES, SCHEME_IDS, schemeTokens } from "../theme/schemes"

const AA_NORMAL_TEXT = 4.5
const AAA_NORMAL_TEXT = 7
const BOUNDARY = 3

type Declarations = Record<string, string>

const THEME_SELECTORS = { light: ":root", dark: '[data-theme="dark"]' } as const

const THEME_CASES = SCHEME_IDS.flatMap((scheme) =>
  (["light", "dark"] as const).flatMap((mode) =>
    scheme === "default" || SCHEMES[scheme].palettes[mode]
      ? [{ scheme, mode, name: scheme === "default" ? mode : `${scheme} ${mode}` }]
      : [],
  ),
)
const THEME_NAMES = THEME_CASES.map((themeCase) => themeCase.name)
const LIGHT_NAMES = THEME_CASES.filter((themeCase) => themeCase.mode === "light").map((themeCase) => themeCase.name)
const HIGH_CONTRAST_NAMES = THEME_CASES.filter((themeCase) => themeCase.scheme === "high-contrast").map((themeCase) => themeCase.name)
const textFloor = (theme: string) => (HIGH_CONTRAST_NAMES.includes(theme) ? AAA_NORMAL_TEXT : AA_NORMAL_TEXT)

const PLANES = ["--yc-plane-chrome", "--yc-plane-canvas", "--yc-plane-raised", "--yc-plane-hover", "--yc-plane-selected"] as const
const PANE_PLANES = ["--yc-plane-chrome", "--yc-plane-canvas", "--yc-plane-raised"] as const
const INKS = ["--yc-ink", "--yc-ink-secondary", "--yc-ink-tertiary"] as const

describe("plane steps", () => {
  for (const theme of LIGHT_NAMES) {
    test(`${theme} separates raised from canvas by 1.15:1 and from chrome by 1.10:1`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      expect(contrastRatio(required(tokens, "--yc-plane-canvas"), required(tokens, "--yc-plane-raised"))).toBeGreaterThanOrEqual(1.15)
      expect(contrastRatio(required(tokens, "--yc-plane-chrome"), required(tokens, "--yc-plane-raised"))).toBeGreaterThanOrEqual(1.1)
    })
  }

  for (const theme of THEME_NAMES) {
    test(`${theme} gives every plane its own value`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      const values = PLANES.map((plane) => required(tokens, plane))
      expect(new Set(values).size).toBe(values.length)
    })
  }
})

describe("boundary contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} pane separators reach 3:1 on chrome, canvas and raised`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      expect(failures(tokens, ["--yc-line-subtle"], PANE_PLANES, BOUNDARY)).toEqual([])
    })

    test(`${theme} field boundaries and focus reach their floor on every plane`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      const floor = HIGH_CONTRAST_NAMES.includes(theme) ? AA_NORMAL_TEXT : BOUNDARY
      expect(failures(tokens, ["--yc-line-field", "--yc-focus"], PLANES, floor)).toEqual([])
    })

    test(`${theme} state graphics reach 3:1 on chrome, canvas and raised`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      expect(failures(tokens, HUES.map((hue) => `--yc-${hue}-graphic`), PANE_PLANES, BOUNDARY)).toEqual([])
    })
  }
})

describe("text contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} keeps three distinct ink tiers at the text floor on every plane`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      expect(new Set(INKS.map((ink) => required(tokens, ink))).size).toBe(3)
      expect(failures(tokens, INKS, PLANES, textFloor(theme))).toEqual([])
    })

    test(`${theme} keeps every hue ink at the text floor on every plane and its own tonal fills`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      const result = HUES.flatMap((hue) =>
        failures(tokens, [`--yc-${hue}-ink`], [...PLANES, `--yc-${hue}-tonal`, `--yc-${hue}-tonal-hover`], textFloor(theme)),
      )
      expect(result).toEqual([])
    })

    test(`${theme} keeps every on-solid label at the text floor on its solid and solid hover`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      const result = HUES.flatMap((hue) => failures(tokens, [`--yc-on-${hue}`], [`--yc-${hue}-solid`, `--yc-${hue}-solid-hover`], textFloor(theme)))
      expect(result).toEqual([])
    })

    test(`${theme} keeps primary and secondary ink readable on the selected cobalt tonal and inverse ink on the inverse plane`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      expect(failures(tokens, ["--yc-ink", "--yc-ink-secondary"], ["--yc-cobalt-tonal"], textFloor(theme))).toEqual([])
      expect(failures(tokens, ["--yc-ink-inverse"], ["--yc-plane-inverse"], textFloor(theme))).toEqual([])
    })
  }
})

describe("primary button contrast", () => {
  const STATES = [
    { name: "default", selector: ".button--primary" },
    { name: "hover", selector: ".button--primary:hover:not(:disabled)" },
  ] as const

  for (const theme of THEME_NAMES) {
    for (const state of STATES) {
      test(`${theme} ${state.name} label reaches the text floor`, async () => {
        const { base, themes } = await stylesheets()
        const rule = declarations(base, state.selector)
        const tokens = themeOf(themes, theme)
        expect(contrastRatio(resolveColor(value(rule, "color"), tokens), resolveColor(value(rule, "background"), tokens))).toBeGreaterThanOrEqual(textFloor(theme))
      })
    }
  }

  test("paints the cobalt solid and keeps the disabled button dimmed and not clickable", async () => {
    const { base } = await stylesheets()
    expect(value(declarations(base, ".button--primary"), "background")).toBe("var(--yc-cobalt-solid)")
    const disabled = declarations(base, ".button[disabled]")
    expect(Number(value(disabled, "opacity"))).toBeLessThan(1)
    expect(Number(value(disabled, "opacity"))).toBeGreaterThan(0)
    const cursor = declarations(base, ':where(:disabled, [aria-disabled="true"], label:has(:disabled), [inert])')
    expect(value(cursor, "cursor")).toBe("var(--yc-cursor-disabled)")
  })
})

describe("offline status contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} offline status reaches the text floor on its tonal strip`, async () => {
      const { base, themes } = await stylesheets()
      const rule = declarations(base, ".status-strip--offline")
      const tokens = themeOf(themes, theme)
      expect(contrastRatio(resolveColor(value(rule, "color"), tokens), resolveColor(value(rule, "background"), tokens))).toBeGreaterThanOrEqual(textFloor(theme))
    })
  }
})

describe("scrollbar thumb contrast", () => {
  const SURFACES = [...PLANES, "--yc-terminal-bg"] as const
  const STATES = [
    { name: "rest", selector: "::-webkit-scrollbar-thumb" },
    { name: "hover", selector: "::-webkit-scrollbar-thumb:hover" },
    { name: "drag", selector: "::-webkit-scrollbar-thumb:active" },
  ] as const

  for (const theme of THEME_NAMES) {
    for (const state of STATES) {
      test(`${theme} ${state.name} thumb reaches 3:1 on every surface a scroll region paints`, async () => {
        const { base, themes } = await stylesheets()
        const tokens = themeOf(themes, theme)
        const thumb = resolveColor(value(declarations(base, state.selector), "background-color"), tokens)
        for (const surface of SURFACES) expect(contrastRatio(thumb, required(tokens, surface)), `${theme} ${surface}`).toBeGreaterThanOrEqual(BOUNDARY)
      })
    }
  }
})

const TERMINAL_PAIRS = [
  { label: "terminal code ink", token: "--yc-terminal-fg", threshold: AA_NORMAL_TEXT },
  { label: "terminal annotation", token: "--yc-terminal-dim", threshold: AA_NORMAL_TEXT },
  { label: "terminal command ink", token: "--yc-terminal-accent", threshold: AA_NORMAL_TEXT },
] as const

describe("terminal plate contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} keeps every terminal ink at AA on the plate`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      for (const pair of TERMINAL_PAIRS) {
        expect(contrastRatio(required(tokens, pair.token), required(tokens, "--yc-terminal-bg")), `${theme} ${pair.label}`).toBeGreaterThanOrEqual(pair.threshold)
      }
    })
  }
})

describe("translucent navigation contrast (W94)", () => {
  const MIX = /^color-mix\(in srgb, var\((--[a-z0-9-]+)\) (\d+)%, transparent\)$/

  test("the public header paints at least 94% of an opaque plane", async () => {
    const site = await stylesheet("site.css")
    expect(declarations(site, ".marketing .app-header").background).toBe("var(--yc-plane-canvas)")
    const supported = site.slice(site.indexOf("@supports (backdrop-filter: blur(1px))"))
    const mix = declarations(supported, ".marketing .app-header").background?.match(MIX)
    expect(mix?.[1]).toBe("--yc-plane-canvas")
    expect(Number(mix?.[2])).toBeGreaterThanOrEqual(94)
  })

  for (const theme of ["light", "dark"] as const) {
    test(`${theme} keeps every header ink at AA over the worst-case backdrop`, async () => {
      const tokens = themeOf((await stylesheets()).themes, theme)
      const base = await stylesheet("base.css")
      const active = resolveColor(value(declarations(base, ".nav__link--active"), "color"), tokens)
      for (const surface of ["--yc-plane-canvas", "--yc-plane-chrome"]) {
        const veil = composite(`rgba(${channels(required(tokens, surface)).join(", ")}, 0.94)`, required(tokens, "--yc-ink"))
        for (const [name, ink] of [["ink", required(tokens, "--yc-ink")], ["secondary", required(tokens, "--yc-ink-secondary")], ["active label", active]] as const) {
          expect(contrastRatio(ink, veil), `${theme} ${surface} ${name}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        }
      }
    })
  }
})

test("transcript accents stay readable on the surfaces that carry them", async () => {
  const { themes } = await stylesheets()
  const transcript = await stylesheet("../remote/ui/transcript.css")
  for (const [theme, tokens] of Object.entries(themes)) {
    const foreground = (selector: string) => resolveColor(value(declarations(transcript, selector), "color"), tokens)
    for (const surface of PANE_PLANES) {
      const background = required(tokens, surface)
      for (const selector of [".transcript-md a", ".transcript-md__heading"]) {
        expect(contrastRatio(foreground(selector), background), `${theme} ${selector} on ${surface}`).toBeGreaterThanOrEqual(textFloor(theme))
        expect(contrastRatio(foreground(selector), required(tokens, "--yc-cobalt-tonal")), `${theme} ${selector} on the user bubble`).toBeGreaterThanOrEqual(textFloor(theme))
      }
      for (const selector of [".transcript-tool__tag", ".transcript-reasoning__tag"]) expect(contrastRatio(foreground(selector), background), `${theme} ${selector}`).toBeGreaterThanOrEqual(BOUNDARY)
    }
    expect(contrastRatio(foreground(".transcript-md :not(pre)>code"), required(tokens, "--yc-plane-hover")), `${theme} inline code`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    for (const selector of [".transcript-md__code-head", ".transcript-md__code-head button"]) expect(contrastRatio(foreground(selector), required(tokens, "--yc-terminal-bg")), `${theme} ${selector}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
  }
})

function failures(tokens: Declarations, inks: readonly string[], surfaces: readonly string[], floor: number) {
  return inks.flatMap((ink) =>
    surfaces
      .map((surface) => ({ pair: `${ink} on ${surface}`, ratio: Math.round(contrastRatio(required(tokens, ink), required(tokens, surface)) * 100) / 100 }))
      .filter((result) => result.ratio < floor),
  )
}

function themeOf(themes: Record<string, Declarations>, name: string): Declarations {
  const tokens = themes[name]
  if (tokens === undefined) throw new Error(`undefined theme ${name}`)
  return tokens
}

function required(tokens: Declarations, token: string): string {
  const declared = tokens[token]
  if (declared === undefined) throw new Error(`undefined token ${token}`)
  return declared
}

function composite(foreground: string, background: string): string {
  const parts = foreground.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/)
  if (parts === null) throw new Error(`unsupported color value ${foreground}`)
  const alpha = parts[4] === undefined ? 1 : Number(parts[4])
  const under = channels(background)
  return `#${[1, 2, 3].map((index) => Math.round(Number(parts[index]) * alpha + under[index - 1]! * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`
}

async function stylesheets() {
  const tokens = await stylesheet("tokens.css")
  const base = `${await stylesheet("base.css")}\n${await stylesheet("../ui/button.css")}`
  const light = declarations(tokens, THEME_SELECTORS.light)
  const overrides = declarations(tokens, THEME_SELECTORS.dark)
  const modes = { light, dark: { ...light, ...overrides } }
  const themes: Record<string, Declarations> = Object.fromEntries(
    THEME_CASES.map(({ scheme, mode, name }) => {
      const palette = SCHEMES[scheme].palettes[mode]
      return [name, palette ? { ...modes[mode], ...schemeTokens(palette) } : modes[mode]]
    }),
  )
  return { base, overrides, themes }
}

async function stylesheet(name: string): Promise<string> {
  const css = await Bun.file(new URL(name, import.meta.url)).text()
  return css.replace(/\/\*[\s\S]*?\*\//g, "")
}

function declarations(css: string, selector: string): Declarations {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (block === undefined) throw new Error(`missing rule for ${selector}`)
  return Object.fromEntries(
    block
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf(":")
        return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()]
      }),
  )
}

function value(rule: Declarations, property: string): string {
  const declared = rule[property]
  if (declared === undefined) throw new Error(`missing ${property} declaration`)
  return declared
}

function resolve(declared: string, tokens: Declarations): string {
  const reference = declared.match(/^var\((--[a-z0-9-]+)\)$/)
  if (reference === null) return declared
  return resolve(required(tokens, reference[1]!), tokens)
}

function resolveColor(declared: string, tokens: Declarations): string {
  const mix = declared.match(/^color-mix\(in srgb, (\S+) ([\d.]+)%, (\S+) ([\d.]+)%\)$/)
  if (mix === null) return resolve(declared, tokens)
  const first = channels(resolveColor(mix[1]!, tokens))
  const second = channels(resolveColor(mix[3]!, tokens))
  const weights = [Number(mix[2]) / 100, Number(mix[4]) / 100]
  return `#${[0, 1, 2].map((index) => Math.round(first[index]! * weights[0]! + second[index]! * weights[1]!).toString(16).padStart(2, "0")).join("")}`
}

function channels(color: string): readonly number[] {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (hex === undefined) throw new Error(`unsupported color value ${color}`)
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (lighter! + 0.05) / (darker! + 0.05)
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map((component) => {
    const scaled = component / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}
