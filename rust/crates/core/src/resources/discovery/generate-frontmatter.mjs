import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"

const require = createRequire(path.join(process.env.YCODING_ORACLE_REPO, "packages/core/package.json"))
const matter = require("gray-matter")
const sources = [
  "packages/core/test/config/agent.test.ts",
  "packages/core/test/config/command.test.ts",
  "packages/core/test/skill.test.ts",
  "packages/core/test/plugin/skill.test.ts",
  "packages/core/test/tool-skill.test.ts",
  "packages/core/test/session-skill.test.ts",
]
const input = sources.flatMap((source) => {
  const read = Bun.spawnSync(["git", "show", `main:${source}`])
  if (read.exitCode !== 0) throw new Error(read.stderr.toString())
  const text = read.stdout.toString()
  return [
    ...Array.from(text.matchAll(/`(---[\s\S]*?)`/g), (m) => ({
      source,
      input: m[1].replace(/\$\{[^}]+\}/g, "fixture"),
    })),
    ...Array.from(text.matchAll(/("---(?:[^"\\]|\\.)*"|'---(?:[^'\\]|\\.)*')/g), (m) => ({
      source,
      input: Function(`return ${m[1]}`)(),
    })),
  ]
})
const edges = [
  "",
  "Plain body\n",
  "---\n---\nBody",
  "---\n# comment\n---\nBody",
  "---\nname: x\n",
  "---yaml\nname: x\n---\nBody",
  '---json\n{"name":"x"}\n---\nBody',
  "---\r\nname: x\r\n---\r\nBody\r\n",
  "----\nname: x\n---\nBody",
  "\uFEFF---\nname: x\n---\nBody",
  "---\nname: x\n---suffix\nBody",
  "---\nname: x\n...\nname: y\n---\nBody",
  "---\nname: x\n---\nname: y\n---\nBody",
  "---\nname: x\nname: y\n---\nBody",
  "---\nname: [broken\n---\nBody",
  "---\nname: a: b\n---\nBody",
  "---\ndescription: https://example.test: details\n---\nBody",
  "---\nflags: [yes, Yes, YES, no, No, NO, on, On, ON, off, Off, OFF, true, True, TRUE, false, False, FALSE]\n---\nBody",
  "---\nnumbers: [077, 078, 0o77, 0b101, 0xFF, +077, -077, 1_000, 1:20:30, 1:20.5, 1e3, 1.e3, .5, +.inf, -.Inf, .nan, -0]\n---\nBody",
  '---\nnulls: [null, Null, NULL, ~, "null", "", ]\nempty:\n---\nBody',
  "---\ndefaults: &base {name: first, description: base}\nagent: {<<: *base, name: override}\n---\nBody",
  "---\na: &a {x: one, y: first}\nb: &b {x: two, z: second}\nc: {<<: [*a, *b], y: override}\n---\nBody",
  "---\na: {<<: 1}\n---\nBody",
  '---\ntimestamps: [2020-01-02, 2020-1-2T3:04:05.12345+02:30, 2020-01-02 03:04:05, "2020-01-02"]\n---\nBody',
  "---\nname: !!str 077\nother: !!int '077'\nflag: !!bool 'TRUE'\n---\nBody",
  "---\nname: !!unknown value\n---\nBody",
  "---\nbytes: !!binary aGVsbG8=\n---\nBody",
  "---\nordered: !!omap [{a: 1}, {b: 2}]\npairs: !!pairs [{a: 1}, {a: 2}]\nset: !!set {one: null, two: null}\n---\nBody",
  "---\nname: >-\n  folded\n  words\ndescription: |+\n  literal\n\n---\nBody",
  "---\nname: *missing\n---\nBody",
  "---\n? [one, two]\n: value\n---\nBody",
  "---\n__proto__: {inherited: true}\nname: prototype\n---\nBody",
  "---\n%YAML 1.1\n---\nname: x\n---\nBody",
  '---\nname: "\\uD800"\ndescription: "\\uD83D\\uDE00"\n---\nBody',
  "---\nnumbers: [1_:20, 1:2_0, 1_:20.5, -0.0, 012_, 0x_FF, 0b_10]\n---\nBody",
  "---\ntimestamps: [2020-00-00, 0099-01-01, 9999-99-99]\n---\nBody",
  "---\nbytes: !!binary ''\n---\nBody",
  "---\nbytes: !!binary a\n---\nBody",
  "---\nbytes: !!binary a===\n---\nBody",
  "---\n? [.nan, .inf, -.inf, -0.0]\n: value\n---\nBody",
  "---\n- array\n- frontmatter\n---\nBody",
  '---\nmetadata:\n  ycoding/slash: " TRUE "\n  ycoding/autoinvoke: "false"\n---\nBody',
  ...["skills", "instructions"].flatMap((field) =>
    ['""', '"  "'].map(
      (value) => `---\nname: manual\nmetadata:\n  ycoding/conflicts:\n    ${field}: [${value}]\n---\n# manual`,
    ),
  ),
]
input.push(...edges.map((input) => ({ source: "edge", input })))
const sanitize = (content) => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
const encode = (value, seen = new Set()) => {
  if (value instanceof Date) return { $type: "date", value: value.toISOString() }
  if (value instanceof Uint8Array) return { $type: "binary", value: Array.from(value) }
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) }
  if (Object.is(value, -0)) return { $type: "number", value: "-0" }
  if (value === undefined) return { $type: "undefined" }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return { $type: "cycle" }
  const next = new Set(seen).add(value)
  if (Array.isArray(value)) return value.map((v) => encode(v, next))
  return Object.fromEntries(Object.keys(value).map((key) => [key, encode(value[key], next)]))
}
const corpus = Array.from(new Map(input.map((item) => [item.input, item])).values()).map((item) => {
  matter.clearCache()
  const parse = () => {
    try {
      const parsed = matter(item.input)
      return { data: encode(parsed.data), content: parsed.content }
    } catch {
      try {
        const parsed = matter(sanitize(item.input))
        return { data: encode(parsed.data), content: parsed.content }
      } catch {
        return { error: true }
      }
    }
  }
  const result = parse()
  return { ...item, result, repeat: parse() }
})
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "frontmatter-corpus.json")
await Bun.write(output, `${JSON.stringify(corpus, null, 2)}\n`)
console.log(
  JSON.stringify({
    shapes: corpus.length,
    sourceShapes: corpus.filter((x) => x.source !== "edge").length,
    errors: corpus.filter((x) => x.result.error).length,
    repeatChanges: corpus.filter((x) => JSON.stringify(x.result) !== JSON.stringify(x.repeat)).length,
  }),
)
