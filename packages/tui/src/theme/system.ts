import { RGBA, type TerminalColors } from "@opentui/core"
import { ansiToRgba, tint } from "./color"
import type { HueStep, ThemeFile } from "./v2"

const steps = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const satisfies readonly HueStep[]

export function terminalMode(colors: TerminalColors): "dark" | "light" | undefined {
  const bg = colors.defaultBackground
  if (!bg) return
  const { r, g, b } = RGBA.fromHex(bg)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
}

export function generateSystem(colors: TerminalColors, mode: "dark" | "light"): ThemeFile {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const isDark = mode === "dark"

  const col = (index: number) => {
    const value = colors.palette[index]
    if (value) return RGBA.fromHex(value)
    return ansiToRgba(index)
  }

  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)
  const ansi = {
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    redBright: col(9),
    greenBright: col(10),
  }

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffContextBg = grays[2]!
  const definition = {
    hue: {
      gray: grayScale(grays, mode),
      red: constantScale(ansi.red),
      orange: constantScale(ansi.yellow),
      yellow: constantScale(ansi.yellow),
      green: constantScale(ansi.green),
      cyan: constantScale(ansi.cyan),
      blue: constantScale(ansi.blue),
      purple: constantScale(ansi.magenta),
      accent: constantScale(ansi.cyan),
      interactive: constantScale(ansi.cyan),
      neutral: "$hue.gray" as const,
    },
    categorical: ["purple", "cyan", "green", "yellow", "red"] as const,
    text: {
      default: hex(fg),
      subdued: hex(textMuted),
      action: {
        primary: {
          default: hex(fg),
          $disabled: hex(textMuted),
          $focused: hex(bg),
          $selected: hex(ansi.cyan),
        },
        destructive: { default: hex(bg), $disabled: hex(textMuted) },
      },
      formfield: {
        default: hex(fg),
        $hovered: hex(ansi.cyan),
        $focused: hex(ansi.cyan),
        $pressed: hex(ansi.cyan),
        $disabled: hex(textMuted),
        $selected: hex(ansi.cyan),
      },
      feedback: {
        error: { default: hex(ansi.red) },
        warning: { default: hex(ansi.yellow) },
        success: { default: hex(ansi.green) },
        info: { default: hex(ansi.cyan) },
      },
    },
    background: {
      default: "transparent" as const,
      surface: { offset: hex(grays[2]!), overlay: hex(grays[3]!) },
      action: {
        primary: {
          default: "transparent" as const,
          $hovered: hex(grays[2]!),
          $focused: hex(ansi.cyan),
          $selected: "transparent" as const,
        },
        destructive: { default: hex(ansi.red) },
      },
      formfield: { default: "transparent" as const },
      feedback: {
        error: { default: "transparent" as const },
        warning: { default: "transparent" as const },
        success: { default: "transparent" as const },
        info: { default: "transparent" as const },
      },
    },
    border: { default: hex(grays[7]!) },
    scrollbar: { default: hex(grays[8]!) },
    diff: {
      text: {
        added: hex(ansi.green),
        removed: hex(ansi.red),
        context: hex(grays[7]!),
        hunkHeader: hex(grays[7]!),
      },
      background: {
        added: hex(tint(bg, ansi.green, diffAlpha)),
        removed: hex(tint(bg, ansi.red, diffAlpha)),
        context: hex(diffContextBg),
      },
      highlight: { added: hex(ansi.greenBright), removed: hex(ansi.redBright) },
      lineNumber: {
        text: hex(textMuted),
        background: {
          added: hex(tint(diffContextBg, ansi.green, diffAlpha)),
          removed: hex(tint(diffContextBg, ansi.red, diffAlpha)),
        },
      },
    },
    markdown: {
      text: hex(fg),
      heading: hex(fg),
      link: hex(ansi.blue),
      linkText: hex(ansi.cyan),
      code: hex(ansi.green),
      blockQuote: hex(ansi.yellow),
      emphasis: hex(ansi.yellow),
      strong: hex(fg),
      horizontalRule: hex(grays[7]!),
      listItem: hex(ansi.blue),
      listEnumeration: hex(ansi.cyan),
      image: hex(ansi.blue),
      imageText: hex(ansi.cyan),
      codeBlock: hex(fg),
    },
    syntax: {
      comment: hex(textMuted),
      keyword: hex(ansi.magenta),
      function: hex(ansi.blue),
      variable: hex(fg),
      string: hex(ansi.green),
      number: hex(ansi.yellow),
      type: hex(ansi.cyan),
      operator: hex(ansi.cyan),
      punctuation: hex(fg),
    },
    "@context:elevated": {
      background: {
        default: "$background.surface.offset" as const,
        action: { primary: { $hovered: "$background.surface.overlay" as const } },
      },
    },
    "@context:overlay": { background: { default: "$background.surface.overlay" as const } },
  }

  return mode === "dark"
    ? { version: 2, standalone: true, dark: definition }
    : { version: 2, standalone: true, light: definition }
}

function constantScale(color: RGBA): Record<HueStep, `#${string}`> {
  return Object.fromEntries(steps.map((step) => [step, hex(color)])) as Record<HueStep, `#${string}`>
}

function grayScale(grays: Record<number, RGBA>, mode: "dark" | "light"): Record<HueStep, `#${string}`> {
  const values = steps.map((_, index) => grays[index + 1]!)
  if (mode === "dark") values.reverse()
  return Object.fromEntries(steps.map((step, index) => [step, hex(values[index]!)])) as Record<HueStep, `#${string}`>
}

function hex(color: RGBA): `#${string}` {
  const [r, g, b, a] = color.toInts()
  const byte = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
  return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12

    if (isDark && luminance < 10) {
      const gray = Math.floor(factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    if (!isDark && luminance > 245) {
      const gray = Math.floor(255 - factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    const next = isDark ? luminance + (255 - luminance) * factor * 0.4 : luminance * (1 - factor * 0.4)
    const ratio = luminance === 0 ? 0 : next / luminance
    grays[i] = RGBA.fromInts(
      Math.floor(Math.min(Math.max(bgR * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgG * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgB * ratio, 0), 255)),
    )
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const luminance = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255
  if (isDark) {
    const gray = luminance < 10 ? 180 : Math.min(Math.floor(160 + luminance * 0.3), 200)
    return RGBA.fromInts(gray, gray, gray)
  }

  const gray = luminance > 245 ? 75 : Math.max(Math.floor(100 - (255 - luminance) * 0.2), 60)
  return RGBA.fromInts(gray, gray, gray)
}
