import { describe, expect, test } from "bun:test"
import { tokens } from "../indicator.js"

const GROUPS = ["colors", "typography", "rounded", "motion.duration", "layers"]
const COMPONENT_LITERALS = ["height", "size", "padding"]

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

function lookup(source, path) {
  return path.split(".").reduce((value, key) => (mapping(value) ? value[key] : undefined), source)
}

function flatten(prefix, value) {
  if (!mapping(value)) return [[prefix, String(value)]]
  return Object.entries(value).flatMap(([key, child]) => flatten(`${prefix}.${key}`, child))
}

function literals(source) {
  const groups = GROUPS.flatMap((group) => flatten(group, lookup(source, group) ?? {}))
  const components = Object.entries(source.components ?? {}).flatMap(([name, component]) =>
    Object.entries(component)
      .filter(([key, value]) => COMPONENT_LITERALS.includes(key) && !String(value).startsWith("{"))
      .map(([key, value]) => [`components.${name}.${key}`, String(value)]),
  )
  return Object.fromEntries([...groups, ...components])
}

function drift(document, code) {
  const expected = literals(documented(document))
  const actual = literals(code)
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .sort()
    .filter((name) => actual[name] !== expected[name])
    .map((name) => `${name}: code=${actual[name] ?? "missing"}, DESIGN=${expected[name] ?? "missing"}`)
}

describe("extension DESIGN.md token drift", () => {
  test("matches every documented token and indicator constant in both directions", async () => {
    expect(drift(await Bun.file(new URL("../DESIGN.md", import.meta.url)).text(), tokens)).toEqual([])
  })

  test("detects changed, missing, and stale tokens on scratch copies", async () => {
    const document = await Bun.file(new URL("../DESIGN.md", import.meta.url)).text()
    const probes = [
      [document, { ...tokens, colors: { ...tokens.colors, "agent-cursor": "#000000" } }, "colors.agent-cursor"],
      [
        document,
        { ...tokens, colors: Object.fromEntries(Object.entries(tokens.colors).filter(([name]) => name !== "badge-on")) },
        "colors.badge-on",
      ],
      [document.replace('  badge-on: "#28753e"', '  badge-on: "#28753e"\n  stale: "#000000"'), tokens, "colors.stale"],
      [document, { ...tokens, layers: { ...tokens.layers, extra: 1 } }, "layers.extra"],
      [document.replace("cursor-move: 320ms", "cursor-move: 1ms"), tokens, "motion.duration.cursor-move"],
      [document.replace("padding: 3px 6px", "padding: 0"), tokens, "components.agent-label.padding"],
    ]
    for (const [specimen, code, name] of probes)
      expect(
        drift(specimen, code).some((issue) => issue.startsWith(name)),
        name,
      ).toBe(true)
  })
})
