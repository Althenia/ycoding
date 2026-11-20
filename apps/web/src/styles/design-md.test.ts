import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SCHEMES, SCHEME_IDS, schemeTokens } from "../theme/schemes"
import { declarationsWhere, parseStylesheet } from "./css-rules"

const GROUP_TO_PROPERTY = {
  colors: (name: string) => `--yc-${name}`,
  typography: (name: string) => `--yc-${name}`,
  spacing: (name: string) => `--yc-space-${name}`,
  rounded: (name: string) => `--yc-radius-${name}`,
  elevation: (name: string) => name === "focus-ring" ? "--yc-focus-ring" : `--yc-elevation-${name}`,
  controls: (name: string) => `--yc-${name}`,
  cursors: (name: string) => `--yc-cursor-${name}`,
  layout: (name: string) => `--yc-${name}`,
  layers: (name: string) => `--yc-z-${name}`,
  "motion.duration": (name: string) => `--yc-dur-${name}`,
  "motion.easing": (name: string) => `--yc-ease-${name}`,
  "motion.semantic": (name: string) => `--yc-motion-${name}`,
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

const SCHEME_MODES = ["light", "dark"] as const

function schemeDrift(document: string): string[] {
  const frontMatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  const parsed: unknown = frontMatter === undefined ? undefined : Bun.YAML.parse(frontMatter)
  const themes = isMapping(parsed) && isMapping(parsed.themes) ? parsed.themes : {}
  const expected = Object.fromEntries(
    SCHEME_IDS.flatMap((scheme) =>
      SCHEME_MODES.flatMap((mode) => {
        const palette = SCHEMES[scheme].palettes[mode]
        return palette ? [[`${scheme}-${mode}`, schemeTokens(palette)] as const] : []
      }),
    ),
  )
  const documented = Object.keys(themes).filter((name) => name !== "dark")
  return [...new Set([...documented, ...Object.keys(expected)])].sort().flatMap((name) => {
    const theme = themes[name]
    const colors = isMapping(theme) && isMapping(theme.colors) ? theme.colors : undefined
    const actual = Object.fromEntries(Object.entries(colors ?? {}).map(([token, value]) => [`--yc-${token}`, String(value)]))
    const tokens = expected[name]
    if (!tokens || !colors) return [`${name}: ${tokens ? "undocumented" : "stale"} scheme`]
    return [...new Set([...Object.keys(actual), ...Object.keys(tokens)])].sort()
      .filter((property) => actual[property] !== tokens[property])
      .map((property) => `${name} ${property}: DESIGN=${actual[property] ?? "missing"}, scheme=${tokens[property] ?? "missing"}`)
  })
}

describe("DESIGN.md scheme drift", () => {
  test("documents every scheme palette's mapped tokens and no other scheme", async () => {
    expect(schemeDrift(await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text())).toEqual([])
  })

  test("detects changed, dropped, undocumented, and stale scheme tokens on scratch copies", async () => {
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const start = document.indexOf("\n  onedark-light:\n")
    const changed = document.slice(0, start) + document.slice(start).replace(/^ {6}green-solid: .*$/m, '      green-solid: "#000000"')
    expect(schemeDrift(changed).some((issue) => issue.startsWith("onedark-light --yc-green-solid:"))).toBe(true)
    const dropped = document.slice(0, start) + document.slice(start).replace(/^ {6}line-field: .*\n/m, "")
    expect(schemeDrift(dropped).some((issue) => issue.startsWith("onedark-light --yc-line-field: DESIGN=missing"))).toBe(true)
    const stale = document.replace("\n  onedark-light:\n", "\n  solarized-dark:\n")
    expect(schemeDrift(stale)).toContain("solarized-dark: stale scheme")
    expect(schemeDrift(stale)).toContain("onedark-light: undocumented scheme")
  })
})

describe("DESIGN.md motion reduced-motion mapping", () => {
  test("documents the reduced-motion values the stylesheet declares", async () => {
    const frontMatter = (await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()).match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
    const parsed: unknown = Bun.YAML.parse(frontMatter)
    const motion = isMapping(parsed) && isMapping(parsed.motion) ? parsed.motion : {}
    const documented = isMapping(motion.reduced)
      ? Object.fromEntries(Object.entries(motion.reduced).map(([name, value]) => [`--yc-motion-${name}`, String(value)]))
      : {}
    const sheet = parseStylesheet("tokens.css", await Bun.file(new URL("./tokens.css", import.meta.url)).text())
    const actual = declarationsWhere(sheet, (rule) => rule.header === ":root" && rule.conditions.includes("@media (prefers-reduced-motion: reduce)"))
    expect(documented).toEqual(actual)
  })
})

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
        [document, css.replace(/--yc-green-solid: #[0-9a-f]{6};/, "--yc-green-solid: #000000;"), ":root --yc-green-solid"],
        [document, css.replace("--yc-scrollbar-size: 12px;", ""), ":root --yc-scrollbar-size"],
        [document.replace(/^  plane-canvas: (.*)$/m, "  plane-canvas: $1\n  stale: \"#000000\""), css, ":root --yc-stale"],
        [document.replace(/^  green-solid: .*\n/m, ""), css, ":root --yc-green-solid"],
        [document, css.replace("  --yc-scrollbar-size: 12px;", "  --yc-scrollbar-size: 12px;\n  --yc-undocumented: 1px;"), ":root --yc-undocumented"],
        [document.replace(/^      plane-canvas: .*$/m, '      plane-canvas: "#000000"'), css, '[data-theme="dark"] --yc-plane-canvas'],
        [document, css.replace(/(\[data-theme="dark"\] \{[\s\S]*?)  --yc-plane-canvas: #[0-9a-f]{6};\n/, "$1"), '[data-theme="dark"] --yc-plane-canvas'],
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

describe("Web design authority", () => {
  test("retained visual rules name the current Web families without an override tier", async () => {
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const rules = (document.split("## Rules\n")[1] ?? "").split("\n## ")[0]!.split("\n").filter(line => /^\| W\d+ \|/.test(line))
    expect(rules.filter(line => !line.startsWith("| W73 |")).join("\n")).not.toContain("Geist Mono")
    expect(rules.find(line => line.startsWith("| W47 |"))).toContain("JetBrains Mono")
    expect(document).not.toMatch(/older Web presentation|replace conflicting Web presentation|Spatial Canvas|once W104 is approved/)
    expect(new Set(rules.map(line => line.split("|")[1]?.trim())).size).toBe(rules.length)
  })

  test("public rules own one header boundary, open releases and component-specific radii", async () => {
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const rule = document.split("\n").find(line => line.startsWith("| W93 |")) ?? ""
    expect(rule).toContain("1px solid var(--yc-line-subtle)")
    expect(rule).toContain("one public header")
    expect(rule).toContain("transparent")
    expect(rule).toContain("zero radius")
    expect(rule).toContain("--yc-radius-control")
    expect(rule).toContain("open text links")
    expect(rule).toContain("bare currentColor icons")
    expect(rule).not.toMatch(/pill-shaped|soft icon wells/)
    expect(rule).not.toMatch(/docs-bar.*draws no border|releases? entries are borderless tonal planes/)
  })

  test("token governance covers every declared group rather than a closed historical allowlist", async () => {
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const rule = document.split("\n").find(line => line.startsWith("| W80 |")) ?? ""
    expect(rule).toContain("every declared token group")
    expect(rule).toContain("front matter")
    expect(rule).toContain("approval")
    expect(rule).not.toContain("MUST NOT add, remove or change a token")
    expect(documentedTokens(document)).toMatchObject({ "--yc-header-public-h": "56px", "--yc-public-max": "1440px" })
    expect(document).toMatch(/light and alternate themes are native product variants/i)
    expect(document).toContain("They are not claimed as directly observed Stitch variants.")
  })

  test("Session and Settings document their centered tracks and distinct content constraints", async () => {
    const document = await Bun.file(new URL("../../DESIGN.md", import.meta.url)).text()
    const rule = (id: string) => document.split("\n").find(line => line.startsWith(`| ${id} | approved |`)) ?? ""
    for (const phrase of ["track capped at 64rem", "prompt rail fits outside", "without a nested 68ch cap"]) expect(rule("W47")).toContain(phrase)
    for (const phrase of ["track capped at 64rem", "Align Machine, Keep awake and preference rows", "explanatory prose"]) expect(rule("W48")).toContain(phrase)
  })

  test("the brand principles and rules state the current scoped Web contract directly", async () => {
    const document = await Bun.file(new URL("../../../../DESIGN.md", import.meta.url)).text()
    expect(document.slice(document.indexOf("## Principles"), document.indexOf("## Rules"))).not.toMatch(/Spatial Canvas|W80–W94/)
    const rules = document.slice(document.indexOf("## Rules"), document.indexOf("## Colors"))
    expect(rules).toMatch(/R9[^\n]*Web[^\n]*JetBrains Mono/)
    expect(rules).toMatch(/R12[^\n]*public header/)
    expect(document).not.toContain("scoped Web exception")
  })
  test("both Web rule owners bind the approved Stitch project without a specimen-value exclusion", async () => {
    const documents = await Promise.all([
      Bun.file(new URL("../../DESIGN.md", import.meta.url)).text(),
      Bun.file(new URL("../../../../.stitch/DESIGN.md", import.meta.url)).text(),
    ])
    for (const document of documents) {
      expect(document).toContain("10627183425669399580")
      expect(document).not.toContain("15933380309160575156")
      expect(document).not.toContain("specimen hex values, fonts and canvas labels MUST NOT enter production")
      expect(document).toContain("JetBrains Mono")
    }
  })

  test("the brand chain scopes Web type and composition without replacing other surfaces", async () => {
    const document = await Bun.file(new URL("../../../../DESIGN.md", import.meta.url)).text()
    const rules = document.slice(document.indexOf("## Rules"), document.indexOf("## Colors"))
    expect(rules.split("\n").some(line => /^\| R9\s*\|/.test(line) && line.includes("Web") && line.includes("JetBrains Mono"))).toBe(true)
    expect(rules.split("\n").some(line => /^\| R12\s*\|/.test(line) && line.includes("public header") && line.includes("selected-detail"))).toBe(true)
    expect(document).toContain("extension fonts MUST be embedded")
    expect(document).toContain("without changing the user's terminal font settings")
    expect(document).not.toContain("Web and Desktop share Stitch Direction A")
  })
})
