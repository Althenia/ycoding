import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = import.meta.dir
const shared = [path.join(root, "mcp-app", "bridge.js"), path.join(root, "mcp-app", "base.css")]

export const mcpApps = [
  {
    id: "mcp-artifact-demo",
    directory: path.join(root, "mcp-artifact-demo"),
    inputs: [
      ...shared,
      path.join(root, "mcp-artifact-demo", "template.html"),
      path.join(root, "mcp-artifact-demo", "client.js"),
    ],
  },
  {
    id: "local-http-app",
    directory: path.join(root, "local-http-app"),
    inputs: [
      ...shared,
      path.join(root, "local-http-app", "template.html"),
      path.join(root, "local-http-app", "client.js"),
      path.join(root, "local-http-app", "model.js"),
    ],
  },
]

function appByID(id: string) {
  const app = mcpApps.find((entry) => entry.id === id)
  if (!app) throw new Error(`Unknown MCP app: ${id}`)
  return app
}

export async function inputDigest(id: string) {
  const app = appByID(id)
  const hash = createHash("sha256")
  for (const input of [...app.inputs].sort()) {
    hash.update(path.relative(root, input))
    hash.update("\0")
    hash.update(await readFile(input))
    hash.update("\0")
  }
  return hash.digest("hex")
}

const fill = (template: string, placeholder: string, value: string) => template.split(placeholder).join(value)

export async function buildMcpApp(id: string) {
  const app = appByID(id)
  const bundle = await Bun.build({
    entrypoints: [path.join(app.directory, "client.js")],
    target: "browser",
    format: "iife",
  })
  if (!bundle.success) throw new AggregateError(bundle.logs, `Failed to bundle the ${id} MCP app client`)
  const script = (await bundle.outputs[0]!.text()).replace(/\s+$/, "\n").replaceAll("</script", "<\\/script")
  if (script.includes("</script")) throw new Error(`Bundled ${id} client contains a script end tag`)
  const base = await readFile(path.join(root, "mcp-app", "base.css"), "utf8")
  const template = await readFile(path.join(app.directory, "template.html"), "utf8")
  const html = fill(fill(fill(template, "{{BASE_CSS}}", base.replace(/\s+$/, "")), "{{CLIENT_SCRIPT}}", script.replace(/\n$/, "")), "{{INPUT_DIGEST}}", await inputDigest(id))
  if (html.includes("{{")) throw new Error(`Generated ${id} document still contains a placeholder`)
  return html
}

export async function checkMcpApps() {
  const drift: string[] = []
  for (const app of mcpApps) {
    const generated = await buildMcpApp(app.id)
    const current = await readFile(path.join(app.directory, "index.html"), "utf8").catch(() => undefined)
    if (current !== generated) drift.push(app.id)
  }
  return { ok: drift.length === 0, drift }
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const result = await checkMcpApps()
    if (!result.ok) {
      console.error(`Generated MCP app documents are out of date: ${result.drift.join(", ")}. Run: bun run build:mcp-apps`)
      process.exit(1)
    }
    console.log("MCP app documents match their inputs.")
  } else {
    for (const app of mcpApps) await Bun.write(path.join(app.directory, "index.html"), await buildMcpApp(app.id))
    console.log(`Generated ${mcpApps.map((app) => `${app.id}/index.html`).join(", ")}.`)
  }
}
