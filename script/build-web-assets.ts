#!/usr/bin/env bun

import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

const siteURL = "https://ycoding.althenia.app/"
const schemaPath = "ycoding.schema.json"
const brandFonts = ["Geist.woff2", "GeistMono.woff2"]

/**
 * Adds the public download assets to the web application build output. The web
 * application is served from https://ycoding.althenia.app, so the installer and
 * configuration schema live alongside it rather than on a separate Pages site.
 */
export async function buildWebAssets(options: { readonly root: string; readonly outdir: string }) {
  const outdir = outputDirectory(options.root, options.outdir)
  const installer = Bun.file(path.join(options.root, "script", "install.sh"))
  if (!(await installer.exists())) throw new Error("Missing required maintained installer: script/install.sh")

  const example = Bun.file(path.join(options.root, "docs", "examples", "ycoding.jsonc"))
  if (!(await example.exists())) throw new Error("Missing required configuration example: docs/examples/ycoding.jsonc")

  const fontLicense = Bun.file(path.join(options.root, "assets", "brand", "fonts", "OFL.txt"))
  if (!(await fontLicense.exists())) throw new Error("Missing required font license: assets/brand/fonts/OFL.txt")

  const fonts = await Promise.all(
    brandFonts.map(async (name) => {
      const font = Bun.file(path.join(options.root, "assets", "brand", "fonts", name))
      if (!(await font.exists())) throw new Error(`Missing required font: assets/brand/fonts/${name}`)
      return { name, font }
    }),
  )

  const providerLicense = Bun.file(path.join(options.root, "apps", "web", "src", "assets", "providers", "LICENSE.lobehub"))
  if (!(await providerLicense.exists())) throw new Error("Missing required provider-logo license: apps/web/src/assets/providers/LICENSE.lobehub")

  const schema = await configSchema(options.root)
  await Promise.all(["examples", "fonts", "licenses"].map((directory) => fs.mkdir(path.join(outdir, directory), { recursive: true })))
  await Promise.all([
    Bun.write(path.join(outdir, "install.sh"), installer),
    Bun.write(path.join(outdir, schemaPath), JSON.stringify(schema, null, 2) + "\n"),
    Bun.write(path.join(outdir, "examples", "ycoding.jsonc"), example),
    Bun.write(path.join(outdir, "fonts", "OFL.txt"), fontLicense),
    ...fonts.map((entry) => Bun.write(path.join(outdir, "fonts", entry.name), entry.font)),
    Bun.write(path.join(outdir, "licenses", "provider-logos.txt"), providerLicense),
  ])
}

export async function publishBunWeb(bunDist: string, outdir: string) {
  const shell = path.join(bunDist, "index.html")
  const sourceAssets = path.join(bunDist, "assets")
  const targetAssets = path.join(outdir, "assets")
  const bunPath = path.join(outdir, "_bun")
  if (!(await fs.lstat(shell)).isFile() || !(await fs.lstat(sourceAssets)).isDirectory()) {
    throw new Error("Expected a Bun Web asset build")
  }
  if (!(await fs.lstat(path.join(outdir, "index.html"))).isFile() || !(await fs.lstat(targetAssets)).isDirectory()) {
    throw new Error("Expected the current Web asset build")
  }

  const html = await fs.readFile(shell, "utf8")
  const assets = await fs.readdir(sourceAssets, { withFileTypes: true })
  const names = new Set(assets.map(({ name }) => name))
  const referenced = [...html.matchAll(/(?:href|src)="\/assets\/([^"/]+)"/g)].map((match) => match[1])
  if (!referenced.some((name) => name.endsWith(".js")) || referenced.some((name) => !names.has(name))) {
    throw new Error("Bun Web asset referenced by the shell is missing")
  }

  const additions: string[] = []
  for (const entry of assets) {
    const name = entry.name
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$/.test(name)) {
      throw new Error(`Unexpected Bun Web asset: ${name}`)
    }
    const target = path.join(targetAssets, name)
    const current = await fs.lstat(target, { throwIfNoEntry: false })
    if (current === undefined) additions.push(name)
    else if (!current.isFile() || !(await fs.readFile(target)).equals(await fs.readFile(path.join(sourceAssets, name)))) {
      throw new Error(`Bun Web asset conflicts with the current build: ${name}`)
    }
  }

  await fs.mkdir(bunPath)
  await Promise.all(additions.map((name) => fs.copyFile(path.join(sourceAssets, name), path.join(targetAssets, name), constants.COPYFILE_EXCL)))
  await fs.copyFile(shell, path.join(bunPath, "index.html"), constants.COPYFILE_EXCL)
}

async function configSchema(root: string) {
  const process = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      `import { JsonSchema, Schema } from "effect"; import { Config } from "@ycoding-ai/core/config"; const document = Schema.toJsonSchemaDocument(Config.Info); console.log(JSON.stringify({ $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, $id: ${JSON.stringify(siteURL + schemaPath)}, title: "YCoding configuration", ...document.schema, $defs: document.definitions }));`,
    ],
    cwd: path.join(root, "packages", "core"),
    stderr: "pipe",
    stdout: "pipe",
  })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) === 0) return JSON.parse(output)
  throw new Error(`Unable to generate the configuration JSON Schema: ${await new Response(process.stderr).text()}`)
}

function outputDirectory(root: string, outdir: string) {
  const expected = path.join(path.resolve(root), "apps", "web", "dist")
  if (path.resolve(outdir) !== expected) throw new Error(`Web asset output must be ${expected}`)
  return expected
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const outdir = path.join(root, "apps", "web", "dist")
  const args = process.argv.slice(2)
  if (args.length === 0) await buildWebAssets({ root, outdir })
  else if (args.length === 2 && args[0] === "--bun-dist") await publishBunWeb(args[1], outdir)
  else throw new Error("Use build-web-assets.ts [--bun-dist <directory>]")
}
