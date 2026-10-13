import { readdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const [name, directory] = Bun.argv.slice(2)
if (!["mcp-output-schema", "mcp-timeout", "mcp-spawn-marker"].includes(name) || !directory) {
  throw new Error("Expected a supported committed MCP fixture and an output directory")
}
const cache = path.join(process.env.HOME, ".bun/install/cache/@modelcontextprotocol")
const sdk =
  process.env.YCODING_MCP_SDK_ROOT ??
  path.join(
    cache,
    (await readdir(cache)).find((name) => name.startsWith("sdk@1.29.0@@@1_patch_hash=")) ?? "sdk@1.29.0@@@1",
  )
if ((await Bun.file(path.join(sdk, "package.json")).json()).version !== "1.29.0")
  throw new Error("MCP fixtures require SDK 1.29.0")
const source = Bun.spawnSync(["git", "show", `main:packages/core/test/fixture/${name}.ts`])
if (source.exitCode !== 0) throw new Error("Could not read committed MCP fixture")
const output = path.join(directory, `${name}.ts`)
await Bun.write(
  output,
  source.stdout
    .toString()
    .replace(
      /(["'])@modelcontextprotocol\/sdk\/([^"']+)\1/g,
      (_, quote, file) => `${quote}${pathToFileURL(path.join(sdk, "dist/esm", file)).href}${quote}`,
    ),
)
process.stdout.write(output)
