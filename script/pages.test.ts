import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildPages } from "./pages"

const root = path.resolve(import.meta.dirname, "..")

const publishedDocuments = [
  "product-direction",
  "architecture",
  "runtime",
  "provider-efficiency",
  "configuration",
  "repository-resources",
  "guardrails-and-provider-usage",
  "browser-extension",
  "computer-use",
  "memory",
]

const structuredDocuments = {
  "product-direction": "# Product direction\n\n## Priorities\n",
  architecture: "# Architecture\n\n## Package ownership\n",
  runtime: "# Runtime\n\n## Sessions\n\n## Autonomy\n",
  configuration: "# Configuration\n\n## Markdown format\n\n## Markdown format\n",
  "repository-resources": "# Repository resources\n\n## Agents\n",
  "guardrails-and-provider-usage": "# Guardrails\n\n## Session guardrails\n",
  "provider-efficiency": "# Provider efficiency\n\n## Defaults\n",
  "browser-extension": "# Chrome selected-tab bridge\n\n## Public operations\n",
  "computer-use": "# Native computer use\n\n## Helper discovery\n",
  memory: "# Knowledge memory\n\n## Storage\n",
}

async function makeFixture(options: { readonly label: string; readonly documents?: Record<string, string> }) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), `ycoding-pages-${options.label}-`))
  await Promise.all(
    ["packages", "node_modules"].map((entry) => fs.symlink(path.join(root, entry), path.join(fixture, entry))),
  )
  await fs.mkdir(path.join(fixture, "docs", "examples"), { recursive: true })
  await fs.mkdir(path.join(fixture, "script"), { recursive: true })
  await Bun.write(path.join(fixture, "script", "install.sh"), "#!/bin/sh\necho ycoding\n")
  await fs.symlink(path.join(root, "docs", "examples", "ycoding.jsonc"), path.join(fixture, "docs", "examples", "ycoding.jsonc"))
  await Promise.all(
    publishedDocuments.map(async (name) => {
      const target = path.join(fixture, "docs", `${name}.md`)
      const override = options.documents?.[name]
      if (override !== undefined) return Bun.write(target, override)
      const source = path.join(root, "docs", `${name}.md`)
      if (await Bun.file(source).exists()) return fs.symlink(source, target)
      return Bun.write(target, `# ${name}\n`)
    }),
  )
  return { fixture, outdir: path.join(fixture, "dist", "pages") }
}

describe("GitHub Pages documentation build", () => {
  test("publishes configuration documentation, its JSON Schema, and the JSONC example", async () => {
    const { fixture, outdir } = await makeFixture({ label: "content" })
    try {
      await buildPages({ root: fixture, outdir })

      const index = await Bun.file(path.join(outdir, "index.html")).text()
      const configuration = await Bun.file(path.join(outdir, "configuration", "index.html")).text()
      const schema = JSON.parse(await Bun.file(path.join(outdir, "ycoding.schema.json")).text())
      const example = await Bun.file(path.join(outdir, "examples", "ycoding.jsonc")).text()

      expect(index).toContain('href="configuration/"')
      expect(index).toContain('href="runtime/"')
      expect(index).not.toContain("Pending deployment")
      expect(configuration).toContain('href="/ycoding/ycoding.schema.json"')
      expect(configuration).toContain("<table>")
      expect(configuration).toContain('<h1 id="configuration-reference">')
      expect(configuration.includes('<h2 id="permissions">')).toBe(true)
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "YCoding configuration",
        $ref: "#/$defs/Config.Info",
      })
      expect(schema.$defs["Config.Info"].properties).toHaveProperty("$schema")
      expect(schema.$defs["Config.Info"].properties).toHaveProperty("model")
      expect(example).toContain('"$schema": "https://althenia.github.io/ycoding/ycoding.schema.json"')
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("renders safe linked Markdown with tables, nested lists, and anchors", async () => {
    const { fixture, outdir } = await makeFixture({
      label: "markdown",
      documents: {
        configuration: [
          "# Configuration heading",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| schema | enabled |",
          "",
          "- parent",
          "  - child",
          "",
          "[Runtime](./runtime.md#details) [Repository](../AGENTS.md) [Unsafe](javascript:alert(1))",
          "",
          "<script>alert('unsafe')</script>",
          "",
          "```html",
          "<script>escaped code</script>",
          "```",
        ].join("\n"),
        runtime: "# Runtime\n",
      },
    })
    try {
      await buildPages({ root: fixture, outdir })

      expect(await Bun.file(path.join(outdir, "install.sh")).text()).toBe("#!/bin/sh\necho ycoding\n")
      expect(await Bun.file(path.join(outdir, "index.html")).text()).toContain(
        "https://althenia.github.io/ycoding/install.sh",
      )
      const configuration = await Bun.file(path.join(outdir, "configuration", "index.html")).text()
      expect(configuration).toContain('<h1 id="configuration-heading">')
      expect(configuration).toContain("<table>")
      expect(configuration).toContain("<ul>\n<li>parent<ul>")
      expect(configuration).toContain('href="../runtime/#details"')
      expect(configuration).toContain('href="https://github.com/Althenia/ycoding/blob/main/AGENTS.md"')
      expect(configuration).not.toContain("javascript:")
      expect(configuration).not.toContain("alert('unsafe')")
      expect(configuration).toContain("&lt;script&gt;escaped code&lt;/script&gt;")
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("renders grouped navigation with per-component summaries", async () => {
    const { fixture, outdir } = await makeFixture({ label: "navigation", documents: structuredDocuments })
    try {
      await buildPages({ root: fixture, outdir })

      const index = await Bun.file(path.join(outdir, "index.html")).text()
      const configuration = await Bun.file(path.join(outdir, "configuration", "index.html")).text()

      expect(index).toContain("<h2>Concepts</h2>")
      expect(index).toContain("<h2>Components</h2>")
      expect(index).toContain("<h2>Runtime</h2>")
      expect(index).toContain("<h2>Configuration</h2>")
      expect(index).toContain("<h2>Capabilities</h2>")
      expect(index).toContain('<h2>Components</h2><ul class="catalog"><li><a href="architecture/">')
      const componentsSection = index.slice(index.indexOf("<h2>Components</h2>"), index.indexOf("<h2>Configuration</h2>"))
      expect(componentsSection).toContain('<a href="architecture/">')
      expect(componentsSection).not.toContain('<a href="product-direction/">')
      expect(index).toContain('<main id="main" class="doc" tabindex="-1">')
      expect(index).toContain("Package graph, ownership boundaries, runtime flow, and dependency direction.")
      expect(index).toContain('href="memory/"')
      expect(configuration).toContain('aria-label="Documentation"')
      expect(configuration).toContain('<a href="../configuration/" aria-current="page">Configuration reference</a>')
      expect([...configuration.matchAll(/aria-current="page"/g)]).toHaveLength(1)
      expect(configuration).toContain('<p class="label">Concepts</p>')
      expect(configuration.indexOf("<h1")).toBeLessThan(configuration.indexOf("<h2"))
      expect(
        [...configuration.matchAll(/<p class="label">([^<]+)<\/p>/g)].map((match) => match[1]).slice(0, 6),
      ).toEqual(["Start", "Concepts", "Components", "Configuration", "Runtime", "Capabilities"])
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("renders on-page contents and unique heading IDs", async () => {
    const { fixture, outdir } = await makeFixture({ label: "contents", documents: structuredDocuments })
    try {
      await buildPages({ root: fixture, outdir })

      const configuration = await Bun.file(path.join(outdir, "configuration", "index.html")).text()

      expect(configuration).toContain('class="skip"')
      expect(configuration).toContain('href="#main"')
      expect(configuration).toContain('id="main"')
      expect(configuration).toContain('<main id="main" class="doc" tabindex="-1">')
      expect(configuration).toContain('<a href="#markdown-format">Markdown format</a>')
      expect(configuration).toContain('id="markdown-format"')
      expect(configuration).toContain('id="markdown-format-2"')

      const ids = [...configuration.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
      const anchors = [...configuration.matchAll(/href="#([^"]+)"/g)].map((match) => match[1])
      expect(new Set(ids).size).toBe(ids.length)
      expect(anchors.length).toBeGreaterThan(0)
      expect(anchors).not.toContain("configuration")
      expect(anchors.every((anchor) => ids.includes(anchor))).toBe(true)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("renders accessible responsive styles and publishes every catalog document", async () => {
    const { fixture, outdir } = await makeFixture({ label: "styles", documents: structuredDocuments })
    try {
      await buildPages({ root: fixture, outdir })

      const configuration = await Bun.file(path.join(outdir, "configuration", "index.html")).text()

      expect(configuration).toContain("prefers-color-scheme:dark")
      expect(configuration).toContain("prefers-reduced-motion:reduce")
      expect(configuration).toContain(":focus-visible")
      expect(configuration).toContain("scroll-margin-top")
      expect(configuration).toContain("@media (min-width:60rem)")
      expect(configuration).toContain("@media (min-width:80rem)")

      for (const name of publishedDocuments)
        expect(await Bun.file(path.join(outdir, name, "index.html")).exists()).toBe(true)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("rejects unsafe output paths before deleting existing files", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-pages-output-"))
    const sentinel = path.join(fixture, "sentinel")
    try {
      await fs.mkdir(sentinel)
      await Bun.write(path.join(sentinel, "keep.txt"), "preserve me\n")

      const error = await buildPages({ root: fixture, outdir: sentinel }).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw error
      expect(error.message).toContain("Pages output must be")

      expect(await Bun.file(path.join(sentinel, "keep.txt")).text()).toBe("preserve me\n")
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })
})
