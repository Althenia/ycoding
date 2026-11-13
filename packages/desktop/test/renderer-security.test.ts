import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const html = await fs.readFile(path.join(import.meta.dir, "../index.html"), "utf8")
const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? ""
const children = [...head.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)].map((match) => ({
  tag: match[1],
  attributes: Object.fromEntries([...(match[2] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [attribute[1], attribute[2]])),
}))

test("the window document declares frame-src none in a CSP meta before every other head element and keeps the rest of the document", () => {
  expect(children[0]).toEqual({ tag: "meta", attributes: { "http-equiv": "Content-Security-Policy", content: "frame-src 'none'" } })
  expect(html.match(/Content-Security-Policy/gi)).toHaveLength(1)
  expect(children.slice(1)).toEqual([
    { tag: "meta", attributes: { charset: "UTF-8" } },
    { tag: "meta", attributes: { name: "viewport", content: "width=device-width, initial-scale=1" } },
    { tag: "title", attributes: {} },
  ])
  expect(html).toContain('<body><div id="app"></div><script type="module" src="/src/renderer.tsx"></script></body>')
})
