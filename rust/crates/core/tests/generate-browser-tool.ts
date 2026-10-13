import path from "node:path"
import { pathToFileURL } from "node:url"
import { mkdir, rm } from "node:fs/promises"

const root = path.resolve(import.meta.dir, "../../../..")
const reference = path.resolve(process.argv[2] ?? root)
const source = await Bun.file(path.join(reference, "packages/core/src/tool/browser.ts")).text()
const declarations = source.split("const Mode = ")[1]?.split("export const Plugin = ")[0]
const description = source.match(/description:\s*\n\s*("[^\n]*"),/)?.[1]
if (!declarations || !description) throw new Error("Browser tool declaration boundary changed")
const directory = path.join(root, "rust/.cache")
await mkdir(directory, { recursive: true })
const module = path.join(directory, "browser-tool-schema.ts")
try {
  await Bun.write(
    module,
    `import { Schema } from ${JSON.stringify(pathToFileURL(path.join(reference, "packages/schema/node_modules/effect/dist/index.js")).href)}\nimport { Browser } from ${JSON.stringify(pathToFileURL(path.join(reference, "packages/schema/src/browser.ts")).href)}\nimport { IsolatedBrowser } from ${JSON.stringify(pathToFileURL(path.join(reference, "packages/schema/src/isolated-browser.ts")).href)}\nconst Mode = ${declarations.replaceAll("Browser.Schema.", "Browser.").replaceAll("IsolatedBrowser.Schema.", "IsolatedBrowser.").replace("const Output =", "export const Output =")}\nexport { Schema }\n`,
  )
  const { Input, Output, Schema } = await import(pathToFileURL(module).href)
  const input = Schema.toJsonSchemaDocument(Input)
  const output = Schema.toJsonSchemaDocument(Output)
  await Bun.write(
    path.join(root, "rust/crates/core/src/tools/builtin/browser.tool.json"),
    JSON.stringify(
      {
        description: JSON.parse(description),
        inputSchema: {
          ...input.schema,
          ...(Object.keys(input.definitions).length ? { $defs: input.definitions } : {}),
        },
        outputSchema: {
          ...output.schema,
          ...(Object.keys(output.definitions).length ? { $defs: output.definitions } : {}),
        },
      },
      null,
      1,
    ) + "\n",
  )
} finally {
  await rm(module)
}
