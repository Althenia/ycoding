import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { declarationsWhere, parseStylesheet } from "./css-rules"

const GROUP_TO_PROPERTY = {
  colors: (name: string) => `--yc-${name}`,
  typography: (name: string) => `--yc-${name}`,
  spacing: (name: string) => `--yc-space-${name}`,
  rounded: (name: string) => `--yc-radius-${name}`,
  elevation: (name: string) => name === "focus-ring" ? "--yc-focus-ring" : `--yc-shadow-${name}`,
  controls: (name: string) => `--yc-${name}`,
  cursors: (name: string) => `--yc-cursor-${name}`,
  layout: (name: string) => `--yc-${name}`,
  layers: (name: string) => `--yc-z-${name}`,
  "motion.duration": (name: string) => `--yc-dur-${name}`,
  "motion.easing": (name: string) => `--yc-ease-${name}`,
} as const

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function documentedTokens(document: string, theme = false): Record<string, string> {
  const frontMatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontMatter) throw new Error("DESIGN.md has no YAML front matter")
  const parsed: unknown = Bun.YAML.parse(frontMatter)
  if (!isMapping(parsed)) throw new Error("DESIGN.md front matter must be a mapping")
  const source = theme && isMapping(parsed.themes) ? parsed.themes.dark : theme ? undefined : parsed
  if (!isMapping(source)) throw new Error("DESIGN.md lacks themes.dark")
  const tokens: Record<string, string> = {}
  for (const [group, property] of Object.entries(GROUP_TO_PROPERTY)) {
    const entries = group.split(".").reduce<unknown>((value, key) =>
      isMapping(value) ? value[key] : undefined, source)
    if (entries === undefined) continue
    if (!isMapping(entries)) throw new Error(`${group} must be a mapping`)
    for (const [name, value] of Object.entries(entries)) {
      if (typeof value !== "string" && typeof value !== "number") throw new Error(`${group}.${name} must be a scalar`)
      tokens[property(name)] = String(value).trim().replace(/\s+/g, " ")
    }
  }
  return tokens
}

function drift(document: string, css: string): string[] {
  const sheet = parseStylesheet("tokens.css", css)
  return ([
    [":root", false],
    ['[data-theme="dark"]', true],
  ] as const).flatMap(([selector, theme]) => {
    const actual = Object.fromEntries(Object.entries(declarationsWhere(sheet, (rule) =>
      rule.header === selector && rule.conditions.length === 0)).filter(([name]) => name.startsWith("--yc-"))
      .map(([name, value]) => [name, value.trim().replace(/\s+/g, " ")]))
    const expected = documentedTokens(document, theme)
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()
      .filter((name) => actual[name] !== expected[name])
      .map((name) => `${selector} ${name}: CSS=${actual[name] ?? "missing"}, DESIGN=${expected[name] ?? "missing"}`)
  })
}

describe("DESIGN.md token drift", () => {
  test("matches every base and dark --yc-* declaration in both directions", async () => {
    expect(drift(await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text(),
      await Bun.file(new URL("./tokens.css", import.meta.url)).text())).toEqual([])
  })

  test("detects changed, dropped, and stale declarations on scratch copies", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ycoding-design-drift-"))
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const css = await Bun.file(new URL("./tokens.css", import.meta.url)).text()
    try {
      const probes = [
        [document, css.replace("--yc-primary-bg: #0b8550;", "--yc-primary-bg: #000000;"), ":root --yc-primary-bg"],
        [document, css.replace("--yc-scrollbar-size: 12px;", ""), ":root --yc-scrollbar-size"],
        [document.replace("  green: \"#27d17f\"", "  green: \"#27d17f\"\n  stale: \"#000000\""), css, ":root --yc-stale"],
      ] as const
      for (const [specimen, stylesheet, expected] of probes) {
        await Bun.write(path.join(directory, "DESIGN.md"), specimen)
        await Bun.write(path.join(directory, "tokens.css"), stylesheet)
        expect(drift(await Bun.file(path.join(directory, "DESIGN.md")).text(),
          await Bun.file(path.join(directory, "tokens.css")).text()).some((issue) => issue.startsWith(expected)), expected).toBe(true)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
