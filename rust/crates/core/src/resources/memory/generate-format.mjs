import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const source = execFileSync("git", ["show", "main:packages/core/src/memory/format.ts"], { encoding: "utf8" })
const graphSource = execFileSync("git", ["show", "main:packages/core/src/memory/graph.ts"], { encoding: "utf8" })
const modulePath = process.env.YCODING_MARKED_MODULE
if (!modulePath) throw new Error("Supply YCODING_MARKED_MODULE for the already installed marked 17.0.6 module")
const manifest = JSON.parse(readFileSync(path.resolve(modulePath, "../../package.json"), "utf8"))
if (manifest.version !== "17.0.6") throw new Error("Require marked 17.0.6")
const { marked } = await import(pathToFileURL(modulePath).href)
const summarySource = source.split("export function summary(concept: Concept): Summary {")[1].split("\n}\n")[0]
const wordsSource = source.split("export function words(value: string) {")[1].split(" }")[0]
const summary = new Function("concept", summarySource)
const words = new Function("value", wordsSource)
const stripped = graphSource.replace(/^export \* as MemoryGraph.*\n/m, "").replace(/^import .*\n/gm, "").replace(/export interface Node \{[\s\S]*?\n\}/, "").replaceAll("export function", "function")
const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(stripped)
const render = new Function("path", "MemoryFormat", `${javascript};return render`)(path, { summary })
const bodies = [
  "[Related](../b.md) [Root][r]\n\n[r]: /knowledge/b.md\n\n`[Code](../ghost.md)`\n\n```md\n[Fenced](../ghost.md)\n```\n\n[Dangling](missing.md)",
  "Evidence.[^spec]", "Missing.[^absent]", "[^absent]\n\n[^absent]: https://example.invalid", "Evidence.[^absent]: https://example.invalid",
  "`[^absent]`", "    [Code](ghost.md)\n", "~~~md\n[Code](ghost.md)\n~~~",
  "[Inline](b.md \"Title\") [angle](<b.md>) [space]( b.md )", "[paren](folder/(b).md) [escaped](folder/\\(b\\).md)",
  "[nested [label]](b.md)", "![Image](ghost.md) [![Image](ghost.md)](b.md)",
  "[ref][b] [b][] [b]\n\n[b]: b.md", "[A][MiXeD]\n\n[mixed]: b.md", "[label]\n\n[label]: <b.md> \"Title\"",
  "<https://example.invalid> <person@example.invalid> https://example.invalid", "<script>[Ignored](ghost.md) [^absent]</script>",
  "<div>\n[Ignored](ghost.md)\n</div>\n\n[Visible](b.md)", "\\[escaped](ghost.md) \\[^absent]", "[entity](b&amp;c.md) [escape](a\\*b.md)",
  "[inline](b.md)[^spec]", "[empty]()", "[unsafe](javascript:alert(1))", "[root](/knowledge/b.md) [encoded](%2F%2Fknowledge/b.md)",
  "[newline](\nb.md\n)", "[link *emphasis*](b.md)", "[code `x`](b.md)", "[link](b.md 'Title')", "[one](b.md) [two](b.md)",
]
const formats = bodies.map((body) => {
  const links = [], unresolved = []
  marked.walkTokens(marked.lexer(body), (token) => {
    if (token.type === "link") links.push(token.href)
    if (token.type === "text") unresolved.push(token.text)
  })
  return { body, links, valid: ![...unresolved.join("\n").matchAll(/\[\^([A-Za-z0-9_-]+)\]/g)].some((match) => match[1] !== "spec") }
})
const queries = ["CAFÉ cache", "Straße ΣΟΣ ΙΣΟΣ", "数字１２３ x² _tag", "𐐀𐐁 İ é", "x\u0085y\uFEFFz", "cash $42 a-b"]
const concept = { id: "a", type: "Guide", digest: "0".repeat(64), title: "</script><img src=x>", content: "---\ntype: Guide\n---\n[Related](b.md)\n", links: ["b.md"] }
const target = { id: "b", type: "Decision", digest: "1".repeat(64), content: "---\ntype: Decision\n---\nTarget\n", links: [] }
const graph = render([{ id: "knowledge/a", concept }, { id: "knowledge/b", concept: target }])
const snippets = ["a".repeat(319) + "😀end", "😀".repeat(40) + "cache" + "😀".repeat(200)].map((body) => {
  const terms = words(body.startsWith("a") ? "a" : "cache")
  const first = terms.map((term) => body.toLowerCase().indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const snippet = body.slice(Math.max(0, first - 60), Math.max(0, first - 60) + 320).trim()
  return { body, query: terms[0], units: Array.from({ length: snippet.length }, (_, i) => snippet.charCodeAt(i)) }
})
const result = { formats, words: queries.map((query) => ({ query, words: [...new Set(words(query))].sort() })), snippets, graph: { concepts: [concept, target], digest: createHash("sha256").update(graph.html).digest("hex"), nodes: graph.nodes, edges: graph.edges, warnings: graph.warnings } }
writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus.json"), JSON.stringify(result, null, 2) + "\n")
