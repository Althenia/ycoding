import { describe, expect, test } from "bun:test"
import { SCHEMES, SCHEME_IDS, schemeTokens } from "../theme/schemes"

/**
 * Resolves the stylesheets the browser loads and holds the palette to the WCAG AA
 * ratio for normal text.
 *
 * The primary button owns its surface and ink instead of borrowing
 * `--yc-green-strong`, which is a foreground green in the dark theme. Production
 * shipped white on `--yc-green-strong` at 1.65:1 in the dark theme (Lighthouse
 * 13.5, `/output/playwright/lighthouse-mobile.json`).
 *
 * The green accent is itself text in the light theme: links, the hero eyebrow,
 * active documentation and changelog entries, success chips, the documentation
 * step marker, and the secondary-button hover. It measured 4.35:1 on the page,
 * 4.12:1 on a surface, and 3.78:1 on the soft accent chip that composites over a
 * surface, so the light value is held to AA on every background its rules paint.
 *
 * The label is 14 to 17 pixels at weight 600, so it never qualifies as large text.
 */
const AA_NORMAL_TEXT = 4.5

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
const HIGH_CONTRAST_NAMES = THEME_CASES.filter((themeCase) => themeCase.scheme === "high-contrast").map(
  (themeCase) => themeCase.name,
)
const AAA_NORMAL_TEXT = 7

const PRIMARY_STATES = [
  { name: "default", selector: ".button--primary" },
  { name: "hover", selector: ".button--primary:hover:not(:disabled)" },
] as const

describe("primary button contrast", () => {
  for (const theme of THEME_NAMES) {
    for (const state of PRIMARY_STATES) {
      test(`${theme} theme ${state.name} state reaches AA normal-text contrast`, async () => {
        const { base, themes } = await stylesheets()
        const rule = declarations(base, state.selector)
        const background = resolveColor(value(rule, "background"), themeOf(themes, theme))
        const foreground = resolveColor(value(rule, "color"), themeOf(themes, theme))
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      })
    }
  }

  test("declares every primary button token in both theme blocks", async () => {
    const { base, overrides } = await stylesheets()
    const referenced = PRIMARY_STATES.flatMap((state) => Object.values(declarations(base, state.selector)))
      .map((declared) => declared.match(/^var\((--[a-z0-9-]+)\)$/)?.[1])
      .filter((token): token is string => token !== undefined)
    // A token the dark block omits silently inherits the light value, which puts
    // the light surface on a dark page.
    const missing = referenced.filter((token) => overrides[token] === undefined).map((token) => `dark:${token}`)
    expect(missing).toEqual([])
  })

  test("keeps the disabled button dimmed and not clickable", async () => {
    const { base } = await stylesheets()
    const disabled = declarations(base, ".button[disabled]")
    expect(Number(value(disabled, "opacity"))).toBeLessThan(1)
    expect(Number(value(disabled, "opacity"))).toBeGreaterThan(0)
    const cursor = declarations(base, ':where(:disabled, [aria-disabled="true"], label:has(:disabled), [inert])')
    expect(value(cursor, "cursor")).toBe("var(--yc-cursor-disabled)")
  })
})

describe("offline status contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} theme offline status reaches AA on its translucent surface`, async () => {
      const { base, themes } = await stylesheets()
      const rule = declarations(base, ".status-strip--offline")
      const foreground = resolveColor(value(rule, "color"), themeOf(themes, theme))
      for (const surface of ["--yc-bg", "--yc-surface", "--yc-surface-raised"]) {
        const background = composite(resolveColor(value(rule, "background"), themeOf(themes, theme)), required(themeOf(themes, theme), surface))
        expect(contrastRatio(foreground, background), `${theme} ${surface}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      }
    })
  }
})

describe("foreground accent contrast", () => {
  const SURFACES = ["--yc-bg", "--yc-surface", "--yc-surface-raised"] as const

  for (const theme of THEME_NAMES) {
    test(`${theme} theme accent text reaches AA on every background it paints on`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      const accent = required(tokens, "--yc-green-strong")
      for (const [name, background] of Object.entries(accentBackgrounds(tokens))) {
        expect(contrastRatio(accent, background), `${theme} ${name} ${background}`).toBeGreaterThanOrEqual(
          AA_NORMAL_TEXT,
        )
      }
    })
  }

  test("declares the accent foreground token in the dark theme block", async () => {
    const { overrides } = await stylesheets()
    // A token the dark block omits silently inherits the light value, which puts a
    // light-theme green on a dark page.
    expect(overrides["--yc-green-strong"]).toBeDefined()
  })

  /** The page, surface, and raised-surface backgrounds plus the soft accent fill composited over each. */
  function accentBackgrounds(tokens: Declarations): Declarations {
    const backgrounds: Declarations = {}
    for (const token of SURFACES) backgrounds[token] = required(tokens, token)
    for (const token of SURFACES) {
      backgrounds[`soft over ${token}`] = composite(required(tokens, "--yc-green-soft"), required(tokens, token))
    }
    return backgrounds
  }
})

describe("scrollbar thumb contrast", () => {
  const SURFACES = ["--yc-bg", "--yc-surface", "--yc-surface-raised", "--yc-surface-sunken", "--yc-terminal-bg"] as const
  const STATES = [
    { name: "rest", selector: "::-webkit-scrollbar-thumb" },
    { name: "hover", selector: "::-webkit-scrollbar-thumb:hover" },
    { name: "drag", selector: "::-webkit-scrollbar-thumb:active" },
  ] as const

  for (const theme of THEME_NAMES) {
    for (const state of STATES) {
      test(`${theme} theme ${state.name} thumb reaches 3:1 on every surface a scroll region paints`, async () => {
        const { base, themes } = await stylesheets()
        const thumb = resolveColor(value(declarations(base, state.selector), "background-color"), themeOf(themes, theme))
        for (const surface of SURFACES) {
          expect(contrastRatio(thumb, required(themeOf(themes, theme), surface)), `${theme} ${surface}`).toBeGreaterThanOrEqual(3)
        }
      })
    }
  }

  test("declares every thumb color token in the dark theme block", async () => {
    const { base, overrides } = await stylesheets()
    const referenced = STATES.map((state) => value(declarations(base, state.selector), "background-color").match(/^var\((--[a-z0-9-]+)\)$/)?.[1])
    expect(referenced.every((token) => token !== undefined && overrides[token] !== undefined)).toBe(true)
  })
})

describe("focus indicator token contrast", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} focus color contrasts with page surfaces`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      for (const surface of ["--yc-bg", "--yc-surface", "--yc-surface-raised", "--yc-surface-sunken"]) {
        expect(contrastRatio(required(tokens, "--yc-focus"), required(tokens, surface)), `${theme} ${surface}`).toBeGreaterThanOrEqual(3)
      }
    })
    test(`${theme} neutral icon focus contrasts with pending picker fills`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      for (const surface of ["--yc-bg", "--yc-surface", "--yc-surface-raised", "--yc-surface-sunken"]) {
        expect(contrastRatio(required(tokens, "--yc-border-strong"), composite(required(tokens, "--yc-green-soft"), required(tokens, surface))), `${theme} ${surface}`).toBeGreaterThanOrEqual(3)
      }
    })
  }
})

/**
 * The sixteen pairs `.aphrodite/redesign-audit/specs/tokens.toon` declares and
 * `tools/verify_contrast.py` measured — thirty-two checks across both themes. They
 * are pinned here so the rendered values cannot drift away from the design review
 * that approved them: the control boundary reaches 3:1 on every surface a control
 * draws on, tertiary ink reaches 4.5:1 on every surface it paints, and the three
 * terminal inks reach 4.5:1 on the plate.
 */
const DECLARED_PAIRS = [
  { label: "control boundary", token: "--yc-border-strong", surface: "--yc-bg", threshold: 3 },
  { label: "control boundary", token: "--yc-border-strong", surface: "--yc-surface", threshold: 3 },
  { label: "control boundary", token: "--yc-border-strong", surface: "--yc-surface-raised", threshold: 3 },
  { label: "control boundary", token: "--yc-border-strong", surface: "--yc-surface-sunken", threshold: 3 },
  { label: "primary ink", token: "--yc-text", surface: "--yc-surface-sunken", threshold: 4.5 },
  { label: "secondary ink", token: "--yc-text-muted", surface: "--yc-surface-sunken", threshold: 4.5 },
  { label: "tertiary ink", token: "--yc-text-subtle", surface: "--yc-surface-sunken", threshold: 4.5 },
  { label: "tertiary ink", token: "--yc-text-subtle", surface: "--yc-bg", threshold: 4.5 },
  { label: "tertiary ink", token: "--yc-text-subtle", surface: "--yc-surface", threshold: 4.5 },
  { label: "tertiary ink", token: "--yc-text-subtle", surface: "--yc-surface-raised", threshold: 4.5 },
  { label: "offline status dot", token: "--yc-text-subtle", surface: "--yc-surface-sunken", threshold: 3 },
  { label: "offline status dot", token: "--yc-text-subtle", surface: "--yc-surface", threshold: 3 },
  { label: "terminal code ink", token: "--yc-terminal-fg", surface: "--yc-terminal-bg", threshold: 4.5 },
  { label: "terminal annotation", token: "--yc-terminal-dim", surface: "--yc-terminal-bg", threshold: 4.5 },
  { label: "terminal command ink", token: "--yc-terminal-accent", surface: "--yc-terminal-bg", threshold: 4.5 },
  { label: "terminal command glyph", token: "--yc-terminal-accent", surface: "--yc-terminal-bg", threshold: 3 },
] as const

describe("declared token contrast pairs", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme} theme keeps every declared pair at its AA threshold`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      for (const pair of DECLARED_PAIRS) {
        expect(
          contrastRatio(required(tokens, pair.token), required(tokens, pair.surface)),
          `${theme} ${pair.label}: ${pair.token} on ${pair.surface}`,
        ).toBeGreaterThanOrEqual(pair.threshold)
      }
    })
  }
})

describe("scheme body text contrast", () => {
  const SURFACES = ["--yc-bg", "--yc-surface", "--yc-surface-raised", "--yc-surface-sunken"] as const
  const INKS = ["--yc-text", "--yc-text-muted", "--yc-text-subtle", "--yc-green-strong", "--yc-yellow-strong", "--yc-danger"] as const

  for (const theme of THEME_NAMES) {
    test(`${theme} theme holds every ink to AA on every page surface`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      const failures = INKS.flatMap((ink) =>
        SURFACES.map((surface) => ({ pair: `${ink} on ${surface}`, ratio: contrastRatio(required(tokens, ink), required(tokens, surface)) }))
          .filter((result) => result.ratio < AA_NORMAL_TEXT),
      )
      expect(failures).toEqual([])
    })
  }
})

describe("high-contrast scheme AAA contrast", () => {
  const SURFACES = ["--yc-bg", "--yc-surface", "--yc-surface-raised", "--yc-surface-sunken"] as const
  const BODY_INKS = ["--yc-text", "--yc-text-muted", "--yc-text-subtle", "--yc-green-strong", "--yc-yellow-strong", "--yc-danger"] as const

  test("ships a light and a dark high-contrast mode", () => {
    expect(HIGH_CONTRAST_NAMES).toEqual(["high-contrast light", "high-contrast dark"])
  })

  for (const theme of HIGH_CONTRAST_NAMES) {
    test(`${theme} holds body text to 7:1 on every surface and on the soft fills`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      const failures = BODY_INKS.flatMap((ink) =>
        SURFACES.flatMap((surface) => [
          { pair: `${ink} on ${surface}`, background: required(tokens, surface) },
          ...(["--yc-green-soft", "--yc-yellow-soft", "--yc-danger-soft"] as const).map((soft) => ({
            pair: `${ink} on ${soft} over ${surface}`,
            background: composite(required(tokens, soft), required(tokens, surface)),
          })),
        ])
          .map((result) => ({ pair: result.pair, ratio: contrastRatio(required(tokens, ink), result.background) }))
          .filter((result) => result.ratio < AAA_NORMAL_TEXT),
      )
      expect(failures).toEqual([])
    })

    test(`${theme} holds the primary button, boundaries, and focus to their floors`, async () => {
      const { themes } = await stylesheets()
      const tokens = themeOf(themes, theme)
      expect(contrastRatio(required(tokens, "--yc-primary-fg"), required(tokens, "--yc-primary-bg"))).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT)
      for (const surface of SURFACES) {
        expect(contrastRatio(required(tokens, "--yc-border-strong"), required(tokens, surface)), `border-strong ${surface}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
        expect(contrastRatio(required(tokens, "--yc-focus"), required(tokens, surface)), `focus ${surface}`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
      }
    })
  }
})

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

/** Flattens a color with an alpha channel over an opaque background. */
function composite(foreground: string, background: string): string {
  const channels = foreground.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/)
  if (channels === null) throw new Error(`unsupported color value ${foreground}`)
  const alpha = channels[4] === undefined ? 1 : Number(channels[4])
  const base = background.match(/^#([0-9a-f]{6})$/i)
  if (base === null) throw new Error(`unsupported color value ${background}`)
  const flattened = [0, 2, 4].map((offset) => {
    const over = Number.parseInt(channels[offset / 2 + 1]!, 10)
    const under = Number.parseInt(base[1]!.slice(offset, offset + 2), 16)
    return Math.round(over * alpha + under * (1 - alpha))
      .toString(16)
      .padStart(2, "0")
  })
  return `#${flattened.join("")}`
}

async function stylesheets() {
  const tokens = await stylesheet("tokens.css")
  const base = await stylesheet("base.css")
  const light = declarations(tokens, THEME_SELECTORS.light)
  const overrides = declarations(tokens, THEME_SELECTORS.dark)
  const modes = { light, dark: { ...light, ...overrides } }
  const themes: Record<string, Declarations> = Object.fromEntries(
    THEME_CASES.map(({ scheme, mode, name }) => {
      const palette = SCHEMES[scheme].palettes[mode]
      return [name, palette ? { ...modes[mode], ...schemeTokens(palette, mode) } : modes[mode]]
    }),
  )
  return { base, overrides, themes }
}

async function stylesheet(name: string): Promise<string> {
  const css = await Bun.file(new URL(name, import.meta.url)).text()
  // Comments carry prose (and colons) that the declaration split below would
  // otherwise read as part of a value.
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
  const token = tokens[reference[1]!]
  if (token === undefined) throw new Error(`undefined token ${reference[1]}`)
  return token
}

/**
 * Resolves a declaration to an opaque colour, evaluating `color-mix(in srgb, …)` the
 * way the cascade does. The primary button's hover state is a computed mix rather than
 * a second token, so the check has to read the value the browser actually paints.
 */
function resolveColor(declared: string, tokens: Declarations): string {
  const mix = declared.match(/^color-mix\(in srgb, (\S+) ([\d.]+)%, (\S+) ([\d.]+)%\)$/)
  if (mix === null) return resolve(declared, tokens)
  const first = channels(resolveColor(mix[1]!, tokens))
  const second = channels(resolveColor(mix[3]!, tokens))
  const weights = [Number(mix[2]) / 100, Number(mix[4]) / 100]
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(first[index]! * weights[0]! + second[index]! * weights[1]!)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
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
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (hex === undefined) throw new Error(`unsupported color value ${color}`)
  const [red, green, blue] = [0, 2, 4].map((offset) => channel(Number.parseInt(hex.slice(offset, offset + 2), 16)))
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function channel(value: number): number {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
