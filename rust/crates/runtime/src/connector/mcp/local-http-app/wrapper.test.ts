import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { build, inputDigest } from "./build.mjs"

const read = (name: string) => readFile(new URL(name, import.meta.url), "utf8")

test("refresh hover feedback requires a hover-capable pointer", async () => {
  const css = await read("./base.css")
  expect(css).toMatch(/@media\s*\(hover:\s*hover\)\s*\{\s*\.action:hover\s*\{/)
  expect(css.match(/\.action:hover/g)).toHaveLength(1)
})

test("canonical wrapper is reproducible and carries its complete input integrity marker", async () => {
  const html = await build()
  expect(html).toBe(await read("./index.html"))
  expect(html).toContain(`name="ycoding-mcp-app-inputs" content="sha256:${await inputDigest()}"`)
  expect(await inputDigest()).toMatch(/^[a-f0-9]{64}$/)
  expect(html).not.toContain("{{")
  expect(html).not.toMatch(/[\t ]+$/m)
  expect(html.split('<script id="preview-policy" type="application/json">[]</script>')).toHaveLength(2)
})

test("wrapper owns native status and refresh controls without external resources", async () => {
  const html = await build()
  expect(html).toContain('role="status"')
  expect(html).toContain('aria-live="polite"')
  expect(html).toContain('id="refresh"')
  expect(html).toContain('class="action"')
  expect(html).toContain("HTTP-only preview")
  expect(html).toContain("WebSocket and SSE connections are unsupported")
  expect(html).toContain("app response not verified")
  expect(html).toContain("allow-scripts allow-same-origin allow-forms")
  expect(html).toContain("no-referrer")
  expect(html).not.toMatch(/allow-top-navigation|allow-popups|<script\s+src=|<link\s+[^>]*href=|@font-face/)
  expect(html).not.toMatch(/\bnew\s+(?:WebSocket|EventSource)\s*\(|\bfetch\s*\(/)
})

test("wrapper reuses current light and dark tokens without maintaining duplicate palette values", async () => {
  const html = await build()
  const tokens = await read("../../../../../../../apps/web/src/styles/tokens.css")
  for (const name of [
    "bg",
    "surface",
    "surface-sunken",
    "surface-raised",
    "text",
    "text-muted",
    "text-subtle",
    "border",
    "border-strong",
    "primary-bg",
    "primary-fg",
    "danger",
    "focus",
  ])
    for (const declaration of tokens.matchAll(new RegExp(`--yc-${name}:\\s*([^;]+);`, "g")))
      expect(html).toContain(`--yc-${name}: ${declaration[1]!.trim()};`)
  expect(await read("./base.css")).not.toMatch(/--yc-(?:bg|surface|text|primary-bg|danger|focus):/)
  expect(html).toContain("prefers-color-scheme: dark")
  expect(html).toContain("prefers-reduced-motion: reduce")
  expect(html).toContain("var(--yc-focus-ring)")
  expect(html).toContain("var(--yc-control-h)")
  expect(html).toContain("var(--yc-size-2xl)")
  expect(html).toContain("var(--yc-leading-2xl)")
})

test("status refresh is the wrapper's only host tool capability", async () => {
  const html = await build()
  const client = await read("./client.js")
  expect(client).toContain('allowedTools: ["local_app_status"]')
  expect(client).toMatch(/bridge\.callTool\(\s*"local_app_status"/)
  expect(client).toMatch(/window\.addEventListener\(\s*"pagehide"/)
  expect(client).not.toMatch(/local_app_open|setInterval|\.innerHTML\s*=/)
  expect(html).toContain("preview-policy")
})
