import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import ycoding from "../src/theme/assets/ycoding.json" with { type: "json" }
import { ThemeFile } from "../src/theme"
import { resolveThemeFile } from "../src/theme/resolve"

const ROLE_TO_THEME_KEY: Record<string, string> = {
  primary: "text.feedback.info.default",
  background: "background.default",
  chrome: "background.chrome",
  "surface-offset": "background.surface.offset",
  "surface-overlay": "background.surface.overlay",
  text: "text.default",
  "text-subdued": "text.subdued",
  "text-label": "text.label",
  "text-hint": "text.hint",
  separator: "text.separator",
  border: "border.default",
  "on-primary": "text.action.primary.focused",
  destructive: "background.action.destructive.default",
  "on-destructive": "text.action.destructive.default",
  success: "text.feedback.success.default",
  warning: "text.feedback.warning.default",
  error: "text.feedback.error.default",
  info: "text.feedback.info.default",
} as const

const DOCUMENTED_COLOR_EXCEPTIONS: Record<string, string> = {
  backdrop: "No corresponding role exists in the resolved theme; the overlay role is opaque.",
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function frontMatter(document: string) {
  const source = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!source) throw new Error("DESIGN.md has no YAML front matter")
  const parsed: unknown = Bun.YAML.parse(source)
  if (!isRecord(parsed) || !isRecord(parsed.colors)) throw new Error("DESIGN.md must declare colors in YAML front matter")
  return parsed.colors
}

function isThemeColor(value: unknown): value is { toInts(): number[] } {
  return isRecord(value) && typeof value.toInts === "function"
}

function themeColor(theme: unknown, key: string) {
  const resolved = resolveThemeFile(Schema.decodeUnknownSync(ThemeFile)(theme), "dark", "ycoding")
  let value: unknown = resolved
  for (const part of key.split(".")) value = isRecord(value) ? value[part] : undefined
  if (!isThemeColor(value)) throw new Error(`Resolved theme key ${key} is missing or is not a color`)
  const channels = value.toInts()
  return `#${channels.slice(0, channels[3] === 255 ? 3 : 4).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}

function setProperty(source: unknown, path: string[], replacement: unknown) {
  const parent = path.slice(0, -1).reduce((value, key) => isRecord(value) ? value[key] : undefined, source)
  const key = path.at(-1)
  if (!isRecord(parent) || !key) throw new Error(`Theme path ${path.join(".")} is missing`)
  parent[key] = replacement
}

function drift(document: string, theme: unknown) {
  const colors = frontMatter(document)
  const errors: string[] = []
  const findings: string[] = []
  for (const [role, value] of Object.entries(colors)) {
    const key = ROLE_TO_THEME_KEY[role]
    if (!key) {
      findings.push(`${role}: ${DOCUMENTED_COLOR_EXCEPTIONS[role] ?? "no theme mapping"}`)
      continue
    }
    if (typeof value !== "string") {
      errors.push(`${role}: documented color must be a string`)
      continue
    }
    const resolved = themeColor(theme, key)
    if (resolved.toLowerCase() !== value.toLowerCase()) errors.push(`${role} (${key}): DESIGN=${value}, theme=${resolved}`)
  }
  for (const role of Object.keys(ROLE_TO_THEME_KEY)) {
    if (!(role in colors)) errors.push(`${role}: mapped theme key ${ROLE_TO_THEME_KEY[role]} has no documented color`)
  }
  return { errors, findings }
}

describe("TUI DESIGN.md theme drift", () => {
  test("matches every mapped documented color to the resolved default ycoding dark theme", async () => {
    const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
    const result = drift(document, ycoding)
    expect(result.errors).toEqual([])
    expect(result.findings).toEqual([`backdrop: ${DOCUMENTED_COLOR_EXCEPTIONS.backdrop}`])
  })

  test("detects changed theme values, dropped documented colors, and stale documented colors on scratch copies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-tui-design-drift-"))
    const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
    const theme = structuredClone(ycoding)
    const changedTheme = structuredClone(theme)
    setProperty(changedTheme, ["dark", "text", "feedback", "info", "default"], "#000000")
    const probes = [
      [document, changedTheme, "primary (text.feedback.info.default)"],
      [document.replace('  primary: "#79B8FF"\n', ""), theme, "primary: mapped theme key"],
      [document.replace('  primary: "#79B8FF"', '  primary: "#79B8FF"\n  stale: "#000000"'), theme, "stale: no theme mapping"],
    ] as const
    try {
      for (const [specimen, candidateTheme, expected] of probes) {
        await Bun.write(path.join(directory, "DESIGN.md"), specimen)
        await Bun.write(path.join(directory, "ycoding.json"), JSON.stringify(candidateTheme))
        const scratchDocument = await Bun.file(path.join(directory, "DESIGN.md")).text()
        const scratchTheme = Schema.decodeUnknownSync(ThemeFile)(await Bun.file(path.join(directory, "ycoding.json")).json())
        const result = drift(scratchDocument, scratchTheme)
        expect([...result.errors, ...result.findings].some((issue) => issue.includes(expected)), expected).toBe(true)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
