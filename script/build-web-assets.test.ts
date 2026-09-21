import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildWebAssets } from "./build-web-assets"

const root = path.resolve(import.meta.dirname, "..")
const canonicalSchemaID = "https://ycoding.althenia.app/ycoding.schema.json"
const privateMarker = "SYNTHETIC PRIVATE INTERNAL DOCUMENT"

async function makeFixture(options: { readonly label: string } = { label: "assets" }) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), `ycoding-web-assets-${options.label}-`))
  await Promise.all(
    ["packages", "node_modules"].map((entry) => fs.symlink(path.join(root, entry), path.join(fixture, entry))),
  )
  await fs.mkdir(path.join(fixture, "script"), { recursive: true })
  await fs.mkdir(path.join(fixture, "docs", "examples"), { recursive: true })
  await fs.mkdir(path.join(fixture, "apps", "web", "dist", "assets"), { recursive: true })
  await Bun.write(path.join(fixture, "script", "install.sh"), "#!/bin/sh\necho ycoding\n")
  await Bun.write(
    path.join(fixture, "docs", "examples", "ycoding.jsonc"),
    `{\n  "$schema": "${canonicalSchemaID}",\n  "model": "openrouter/openai/gpt-5#high",\n}\n`,
  )
  // Synthetic internal material that must never reach the published build.
  await Bun.write(path.join(fixture, "docs", "architecture.md"), `# Architecture\n\n${privateMarker}\n`)
  // Existing `vite build` output the asset publisher must extend rather than replace.
  await Bun.write(path.join(fixture, "apps", "web", "dist", "index.html"), "<!doctype html><title>YCoding</title>\n")
  await Bun.write(path.join(fixture, "apps", "web", "dist", "assets", "app-abc123.js"), "console.log('web')\n")
  return { fixture, outdir: path.join(fixture, "apps", "web", "dist") }
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relative)
      return [relative]
    }),
  )
  return nested.flat().sort()
}

describe("web build asset publisher", () => {
  test("publishes the installer, configuration schema, and JSONC example into the web build", async () => {
    const { fixture, outdir } = await makeFixture({ label: "content" })
    try {
      await buildWebAssets({ root: fixture, outdir })

      expect(await Bun.file(path.join(outdir, "install.sh")).text()).toBe("#!/bin/sh\necho ycoding\n")
      expect(await Bun.file(path.join(outdir, "examples", "ycoding.jsonc")).text()).toBe(
        await Bun.file(path.join(fixture, "docs", "examples", "ycoding.jsonc")).text(),
      )

      const schema = JSON.parse(await Bun.file(path.join(outdir, "ycoding.schema.json")).text())
      expect(schema).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: canonicalSchemaID,
        title: "YCoding configuration",
        $ref: "#/$defs/Config.Info",
      })
      expect(schema.$defs["Config.Info"].properties).toHaveProperty("$schema")
      expect(schema.$defs["Config.Info"].properties).toHaveProperty("model")

      // The published build is exactly the web application plus the three required assets.
      expect(await listFiles(outdir)).toEqual([
        "assets/app-abc123.js",
        "examples/ycoding.jsonc",
        "index.html",
        "install.sh",
        "ycoding.schema.json",
      ])
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("never publishes internal documentation and preserves maintained sources", async () => {
    const { fixture, outdir } = await makeFixture({ label: "internal" })
    try {
      await buildWebAssets({ root: fixture, outdir })

      const published = await listFiles(outdir)
      expect(published.filter((entry) => entry.endsWith(".md") || entry.endsWith(".html"))).toEqual(["index.html"])
      expect(published.some((entry) => entry.startsWith("architecture/") || entry.startsWith("docs/"))).toBe(false)

      const contents = await Promise.all(published.map(async (entry) => Bun.file(path.join(outdir, entry)).text()))
      expect(contents.join("\n")).not.toContain(privateMarker)
      expect(await Bun.file(path.join(fixture, "docs", "architecture.md")).text()).toContain(privateMarker)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("rejects unsafe output paths before writing anything", async () => {
    const { fixture } = await makeFixture({ label: "output" })
    const sentinel = path.join(fixture, "sentinel")
    try {
      await fs.mkdir(sentinel)
      await Bun.write(path.join(sentinel, "keep.txt"), "preserve me\n")

      const error = await buildWebAssets({ root: fixture, outdir: sentinel }).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw error
      expect(error.message).toContain("Web asset output must be")

      expect(await Bun.file(path.join(sentinel, "keep.txt")).text()).toBe("preserve me\n")
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("fails when the maintained installer is missing", async () => {
    const { fixture, outdir } = await makeFixture({ label: "installer" })
    try {
      await fs.rm(path.join(fixture, "script", "install.sh"))

      const error = await buildWebAssets({ root: fixture, outdir }).catch((error) => error)
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw error
      expect(error.message).toContain("Missing required maintained installer")
      expect(await Bun.file(path.join(outdir, "ycoding.schema.json")).exists()).toBe(false)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })

  test("runs as the owner build step that follows the web build", async () => {
    const { fixture, outdir } = await makeFixture({ label: "cli" })
    try {
      const entry = path.join(fixture, "script", "build-web-assets.ts")
      await fs.copyFile(path.join(root, "script", "build-web-assets.ts"), entry)

      const result = Bun.spawn(["bun", entry], { stdout: "pipe", stderr: "pipe" })
      const error = await new Response(result.stderr).text()
      expect(await result.exited, error).toBe(0)

      expect(await Bun.file(path.join(outdir, "install.sh")).exists()).toBe(true)
      expect(await Bun.file(path.join(outdir, "ycoding.schema.json")).exists()).toBe(true)
      expect(await Bun.file(path.join(outdir, "examples", "ycoding.jsonc")).exists()).toBe(true)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })
})
