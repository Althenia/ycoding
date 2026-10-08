
export const SCHEME_STORAGE_KEY = "ycoding.theme-scheme"
export const DEFAULT_SCHEME = "default"
export const SCHEME_IDS = ["default", "onedark", "onedark-pro", "high-contrast"] as const

export type SchemeID = (typeof SCHEME_IDS)[number]
export type SchemeMode = "light" | "dark"

const BASE_SLOTS = [
  "base00",
  "base01",
  "base02",
  "base03",
  "base04",
  "base05",
  "base06",
  "base07",
  "base08",
  "base09",
  "base0A",
  "base0B",
  "base0C",
  "base0D",
  "base0E",
  "base0F",
] as const

export type Palette = Readonly<Record<(typeof BASE_SLOTS)[number], string>> & {
  readonly base10?: string
  readonly plate?: { readonly bg: string; readonly fg: string; readonly dim: string; readonly accent: string }
}

type SchemeDefinition = {
  readonly label: string
  readonly palettes: Readonly<Partial<Record<SchemeMode, Palette>>>
}

export const SCHEMES: Readonly<Record<SchemeID, SchemeDefinition>> = {
  default: { label: "Default", palettes: {} },
  onedark: {
    label: "One Dark",
    palettes: {
      dark: {
        base00: "#282c34",
        base01: "#353b45",
        base02: "#3e4451",
        base03: "#545862",
        base04: "#565c64",
        base05: "#abb2bf",
        base06: "#b6bdca",
        base07: "#c8ccd4",
        base08: "#e06c75",
        base09: "#d19a66",
        base0A: "#e5c07b",
        base0B: "#98c379",
        base0C: "#56b6c2",
        base0D: "#61afef",
        base0E: "#c678dd",
        base0F: "#be5046",
      },
      light: {
        base00: "#fafafa",
        base01: "#f0f0f1",
        base02: "#e5e5e6",
        base03: "#a0a1a7",
        base04: "#696c77",
        base05: "#383a42",
        base06: "#202227",
        base07: "#090a0b",
        base08: "#ca1243",
        base09: "#d75f00",
        base0A: "#c18401",
        base0B: "#50a14f",
        base0C: "#0184bc",
        base0D: "#4078f2",
        base0E: "#a626a4",
        base0F: "#986801",
      },
    },
  },
  "onedark-pro": {
    label: "One Dark Pro",
    palettes: {
      dark: {
        base00: "#282c34",
        base01: "#2c313a",
        base02: "#3e4452",
        base03: "#7f848e",
        base04: "#9da5b4",
        base05: "#abb2bf",
        base06: "#d7dae0",
        base07: "#ffffff",
        base08: "#e06c75",
        base09: "#d19a66",
        base0A: "#e5c07b",
        base0B: "#98c379",
        base0C: "#56b6c2",
        base0D: "#61afef",
        base0E: "#c678dd",
        base0F: "#be5046",
        base10: "#21252b",
      },
    },
  },
  "high-contrast": {
    label: "High contrast",
    palettes: {
      dark: {
        base00: "#000000",
        base01: "#1a1a1a",
        base02: "#9a9a9a",
        base03: "#b0b0b0",
        base04: "#d0d0d0",
        base05: "#f2f2f2",
        base06: "#ffffff",
        base07: "#ffffff",
        base08: "#ff8a8a",
        base09: "#ff9f4a",
        base0A: "#ffd24a",
        base0B: "#5df0a6",
        base0C: "#4fe3f2",
        base0D: "#82c4ff",
        base0E: "#e0a0ff",
        base0F: "#d2a06b",
      },
      light: {
        base00: "#ffffff",
        base01: "#f5f5f5",
        base02: "#767676",
        base03: "#595959",
        base04: "#404040",
        base05: "#000000",
        base06: "#000000",
        base07: "#000000",
        base08: "#850000",
        base09: "#8a3b00",
        base0A: "#6e5000",
        base0B: "#00632f",
        base0C: "#00577a",
        base0D: "#0040a0",
        base0E: "#6a1b9a",
        base0F: "#5c3a00",
        plate: { bg: "#f5f5f5", fg: "#000000", dim: "#404040", accent: "#00632f" },
      },
    },
  },
}

export function isSchemeID(value: unknown): value is SchemeID {
  return typeof value === "string" && (SCHEME_IDS as readonly string[]).includes(value)
}

export function schemeTokens(palette: Palette, mode: SchemeMode): Readonly<Record<string, string>> {
  const dark = mode === "dark"
  const ink = palette.base05
  const accent = dark ? mixColors(palette.base0B, "#ffffff", 0.1) : mixColors(palette.base0B, "#000000", 0.3)
  const warning = dark ? palette.base0A : mixColors(palette.base0A, "#000000", 0.25)
  return {
    "--yc-green": palette.base0B,
    "--yc-green-strong": accent,
    "--yc-green-soft": withAlpha(palette.base0B, dark ? 0.16 : 0.12),
    "--yc-primary-bg": accent,
    "--yc-primary-fg": dark ? palette.base00 : "#ffffff",
    "--yc-yellow": palette.base0A,
    "--yc-yellow-strong": warning,
    "--yc-yellow-soft": withAlpha(palette.base0A, dark ? 0.14 : 0.16),
    "--yc-danger": dark ? mixColors(palette.base08, "#ffffff", 0.26) : palette.base08,
    "--yc-danger-soft": withAlpha(palette.base08, dark ? 0.14 : 0.1),
    "--yc-focus": accent,
    "--yc-bg": palette.base00,
    "--yc-surface": mixColors(palette.base00, palette.base01, dark ? 0.3 : 0.5),
    "--yc-surface-sunken": dark ? (palette.base10 ?? mixColors(palette.base00, "#000000", 0.16)) : palette.base01,
    "--yc-surface-raised": dark ? mixColors(palette.base00, palette.base01, 0.55) : "#ffffff",
    "--yc-text": palette.base06,
    "--yc-text-muted": dark ? ink : mixColors(ink, palette.base00, 0.25),
    "--yc-text-subtle": mixColors(ink, palette.base00, dark ? 0.12 : 0.26),
    "--yc-border": palette.base02,
    "--yc-border-strong": mixColors(ink, palette.base00, dark ? 0.22 : 0.36),
    ...(palette.plate && {
      "--yc-terminal-bg": palette.plate.bg,
      "--yc-terminal-fg": palette.plate.fg,
      "--yc-terminal-dim": palette.plate.dim,
      "--yc-terminal-accent": palette.plate.accent,
    }),
  }
}

export function schemeBackground(scheme: SchemeID, mode: SchemeMode): string | undefined {
  const palette = SCHEMES[scheme].palettes[mode]
  return palette && schemeTokens(palette, mode)["--yc-bg"]
}

export function schemeStylesheet(): string {
  return SCHEME_IDS.flatMap((scheme) =>
    (["light", "dark"] as const).flatMap((mode) => {
      const palette = SCHEMES[scheme].palettes[mode]
      if (!palette) return []
      const declarations = Object.entries(schemeTokens(palette, mode))
        .map(([property, value]) => `  ${property}: ${value};`)
        .join("\n")
      return [`:root[data-scheme="${scheme}"][data-theme="${mode}"] {\n${declarations}\n}`]
    }),
  ).join("\n")
}

export function resolveScheme(scheme: SchemeID, followsSystem: boolean, prefersMoreContrast: boolean): SchemeID {
  return scheme === DEFAULT_SCHEME && followsSystem && prefersMoreContrast ? "high-contrast" : scheme
}

function channels(color: string): readonly number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
}

function mixColors(from: string, to: string, weight: number): string {
  const start = channels(from)
  const end = channels(to)
  return `#${start
    .map((channel, index) =>
      Math.round(channel + (end[index]! - channel) * weight)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}

function withAlpha(color: string, alpha: number): string {
  return `rgba(${channels(color).join(", ")}, ${alpha})`
}
