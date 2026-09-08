import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildPages } from "./pages"

const root = path.resolve(import.meta.dirname, "..")

describe("GitHub Pages documentation build", () => {
  test("publishes configuration documentation, its JSON Schema, and the JSONC example", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-pages-test-"))
    const outdir = path.join(fixture, "dist", "pages")
    try {
      await Promise.all(
        ["packages", "node_modules", "docs", "script"].map((entry) =>
          fs.symlink(path.join(root, entry), path.join(fixture, entry)),
        ),
      )
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
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ycoding-pages-installer-"))
    const outdir = path.join(fixture, "dist", "pages")
    try {
      await fs.symlink(path.join(root, "packages"), path.join(fixture, "packages"))
      await fs.symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"))
      await fs.mkdir(path.join(fixture, "docs", "examples"), { recursive: true })
      await fs.mkdir(path.join(fixture, "script"), { recursive: true })
      await Bun.write(
        path.join(fixture, "docs", "configuration.md"),
        [
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
      )
      await Promise.all(
        ["runtime", "repository-resources", "guardrails-and-provider-usage", "provider-efficiency"].map((name) =>
          Bun.write(path.join(fixture, "docs", `${name}.md`), `# ${name}`),
        ),
      )
      await Bun.write(path.join(fixture, "docs", "examples", "ycoding.jsonc"), "{}\n")
      await Bun.write(path.join(fixture, "script", "install.sh"), "#!/bin/sh\necho ycoding\n")

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
