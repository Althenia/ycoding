import path from "node:path"
import { pathToFileURL } from "node:url"

const [name, directory] = Bun.argv.slice(2)
const local = { "mcp-protocol-http": path.join(import.meta.dir, "../../../tests/mcp_protocol_http.ts") }
if (
  !["mcp-output-schema", "mcp-timeout", "mcp-spawn-marker", "mcp-protocol", ...Object.keys(local)].includes(name) ||
  !directory
) {
  throw new Error("Expected a supported MCP fixture and an output directory")
}
const server =
  process.env.YCODING_MCP_SERVER_ROOT ??
  path.join(process.env.HOME, ".bun/install/cache/@modelcontextprotocol/server@2.3.1@@@1")
const manifest = await Bun.file(path.join(server, "package.json")).json()
if (manifest.version !== "2.3.1") throw new Error("MCP fixtures require @modelcontextprotocol/server 2.3.1")
const source = local[name]
  ? await Bun.file(local[name]).text()
  : Bun.spawnSync(["git", "show", `main:packages/core/test/fixture/${name}.ts`])
if (typeof source !== "string" && source.exitCode !== 0) throw new Error("Could not read committed MCP fixture")
const output = path.join(directory, `${name}.ts`)
await Bun.write(
  output,
  (typeof source === "string" ? source : source.stdout.toString()).replace(
    /(["'])@modelcontextprotocol\/server(\/[^"']+)?\1/g,
    (_, quote, subpath) => {
      const target = manifest.exports[`.${subpath ?? ""}`]?.import?.default
      if (!target) throw new Error(`Unknown MCP server export: ${subpath}`)
      return `${quote}${pathToFileURL(path.join(server, target)).href}${quote}`
    },
  ),
)
process.stdout.write(output)
