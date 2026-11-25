import { describe, expect, test } from "bun:test"

function mapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function documented(document) {
  const source = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!source) throw new Error("DESIGN.md has no YAML front matter")
  const parsed = Bun.YAML.parse(source)
  if (!mapping(parsed)) throw new Error("DESIGN.md front matter must be a mapping")
  return parsed
}

function parseBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css)
  return match?.[1] ?? ""
}

function parseVars(block) {
  const vars = {}
  for (const match of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    vars[match[1]] = match[2].trim().replaceAll('"', "")
  }
  return vars
}

function normalizeColor(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value
}

function drift(document, stylesheet) {
  const doc = documented(document)
  const rules = stylesheet.split("/* generated:fonts begin")[0]
  const rootMatch = /:root\s*\{([\s\S]*?)\}/.exec(rules)
  const darkMatch = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(rules)
  const rootVars = parseVars(rootMatch?.[1] ?? "")
  const darkVars = parseVars(darkMatch?.[1] ?? "")
  const bodyBlock = parseBlock(rules, "body")
  const bodyWidth = /\bwidth:\s*([^;]+);/.exec(bodyBlock)?.[1]?.trim()
  const rootFont = /\bfont:\s*(\d+px)\/([\d.]+)\s+var\(--font-sans\)/.exec(rootMatch?.[1] ?? "")

  const issues = []
  const compare = (key, actual, expected, isColor = false) => {
    const left = isColor ? normalizeColor(actual) : actual
    const right = isColor ? normalizeColor(expected) : expected
    if (left !== right) issues.push(`${key}: css=${actual ?? "missing"}, DESIGN=${expected ?? "missing"}`)
  }

  for (const [name, value] of Object.entries(doc.colors ?? {})) {
    compare(`colors.${name}`, rootVars[name], value, true)
  }
  for (const [name, value] of Object.entries(doc.themes?.dark?.colors ?? {})) {
    compare(`themes.dark.colors.${name}`, darkVars[name], value, true)
  }
  compare("typography.body.fontFamily", rootVars["font-sans"], doc.typography?.body?.fontFamily)
  compare("typography.body.fontSize", rootFont?.[1], doc.typography?.body?.fontSize)
  compare("typography.body.lineHeight", rootFont ? Number(rootFont[2]) : undefined, doc.typography?.body?.lineHeight)
  compare("typography.mono.fontFamily", rootVars["font-mono"], doc.typography?.mono?.fontFamily)
  compare("rounded.control", rootVars["radius-control"], doc.rounded?.control)
  compare("rounded.card", rootVars["radius-card"], doc.rounded?.card)
  compare("rounded.pill", rootVars["radius-pill"], doc.rounded?.pill)
  compare("controls.target", rootVars["target-h"], doc.controls?.target)
  compare("layout.popup", bodyWidth, doc.layout?.popup)
  compare("motion.duration.instant", rootVars["dur-instant"], doc.motion?.duration?.instant)
  compare("motion.duration.quick", rootVars["dur-quick"], doc.motion?.duration?.quick)
  compare("motion.easing.standard", rootVars["ease-standard"], doc.motion?.easing?.standard)

  return issues
}

describe("interaction-chrome DESIGN.md token drift", () => {
  test("matches every documented color, typography, radius, control, layout, and motion token in popup.css", async () => {
    const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
    const stylesheet = await Bun.file(new URL("../popup.css", import.meta.url)).text()
    expect(drift(document, stylesheet)).toEqual([])
  })

  test("detects changed and missing tokens on scratch copies", async () => {
    const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
    const stylesheet = await Bun.file(new URL("../popup.css", import.meta.url)).text()
    expect(drift(document.replace('primary: "#28753E"', 'primary: "#000000"'), stylesheet)).toContain(
      "colors.primary: css=#28753e, DESIGN=#000000",
    )
    expect(drift(document.replace("popup: 320px", "popup: 360px"), stylesheet)).toContain(
      "layout.popup: css=320px, DESIGN=360px",
    )
    expect(drift(document.replace("target: 34px", "target: 40px"), stylesheet)).toContain(
      "controls.target: css=34px, DESIGN=40px",
    )
  })
})
