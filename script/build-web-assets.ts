#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"

const siteURL = "https://ycoding.althenia.app/"
const schemaPath = "ycoding.schema.json"

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

  const schema = await configSchema(options.root)
  await fs.mkdir(path.join(outdir, "examples"), { recursive: true })
  await Promise.all([
    Bun.write(path.join(outdir, "install.sh"), installer),
    Bun.write(path.join(outdir, schemaPath), JSON.stringify(schema, null, 2) + "\n"),
    Bun.write(path.join(outdir, "examples", "ycoding.jsonc"), example),
  ])
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
  await buildWebAssets({ root, outdir: path.join(root, "apps", "web", "dist") })
}
