import path from "node:path"
import { readdir } from "node:fs/promises"

export const approvedPackageNames = new Set([
  "@ycoding-ai/ai",
  "@ycoding-ai/cli",
  "@ycoding-ai/client",
  "@ycoding-ai/codemode",
  "@ycoding-ai/core",
  "@ycoding-ai/desktop",
  "@ycoding-ai/effect-drizzle-sqlite",
  "@ycoding-ai/effect-sqlite-node",
  "@ycoding-ai/http-recorder",
  "@ycoding-ai/httpapi-codegen",
  "@ycoding-ai/meeting",
  "@ycoding-ai/plugin",
  "@ycoding-ai/protocol",
  "@ycoding-ai/remote",
  "@ycoding-ai/schema",
  "@ycoding-ai/script",
  "@ycoding-ai/server",
  "@ycoding-ai/simulation",
  "@ycoding-ai/tui",
  "@ycoding-ai/web",
])

export async function discoverPackageNames(root: string): Promise<string[]> {
  const names: string[] = []

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 2) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(target, depth + 1)
        continue
      }
      if (entry.name !== "package.json") continue
      const manifest = (await Bun.file(target).json()) as { name?: unknown }
      if (typeof manifest.name === "string") names.push(manifest.name)
    }
  }

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name === "packages" || entry.name === "apps" || entry.name === "extensions"))
      await visit(path.join(root, entry.name), 0)
  }
  return names.sort()
}

export async function checkWorkspace(root: string): Promise<string[]> {
  const discovered = await discoverPackageNames(root)
  return discovered.filter((name) => !approvedPackageNames.has(name))
}

export type BundleGraph = {
  frontend: string
  outputs: { file: string; modules: string[]; imports: string[]; edges?: { file: string; specifier: string }[] }[]
}

const forbiddenOwners = ["core", "server", "meeting", "ai", "store", "codemode", "effect-drizzle-sqlite", "effect-sqlite-node"].map((name) => `@ycoding-ai/${name}`)
const sqliteReaders = ["packages/tui/src/editor-zed-sqlite.bun.ts", "packages/tui/src/editor-zed-sqlite.node.ts"]
const normalize = (value: string) => value.replaceAll("\\", "/")

export function checkBundleGraph(graph: BundleGraph) {
  if (!graph.outputs.length || !graph.outputs.some((output) => output.modules.length)) throw new Error("Empty shipped graph")
  const modules = graph.outputs.flatMap((output) => output.modules).map(normalize)
  const declared = (file: string) => sqliteReaders.some((reader) =>
    normalize(file).endsWith(`/${reader}`) && modules.some((module) => module.endsWith("/packages/tui/src/editor-zed.ts")),
  )
  const violations = graph.outputs.flatMap((output) => [...output.modules, ...output.imports].flatMap((raw) => {
    const specifier = normalize(raw)
    const owner = forbiddenOwners.find((name) =>
      specifier === name || specifier.startsWith(`${name}/`) ||
      `/${specifier}`.includes(`/packages/${name.slice("@ycoding-ai/".length)}/`) ||
      `/${specifier}`.includes(`/node_modules/${name}/`),
    ) ?? (/(^|[/@])(?:node-pty|node-pty-[^/]+)(?:\/|$)/.test(specifier) ? "node-pty" : undefined) ??
      (/(?:^|[/@:-])(?:sqlite(?:3)?|better-sqlite3|sql-sqlite-[^/]+|drizzle(?:-orm|-kit)?)(?:[/.:-]|$)/.test(specifier) ? "sqlite" : undefined)
    if (owner === "sqlite" && declared(specifier)) return []
    if (owner === "sqlite" && /^(?:bun|node):sqlite$/.test(specifier)) {
      const edges = output.edges?.filter((edge) => edge.specifier === raw) ?? []
      if (edges.length > 0 && edges.every(({ file }) => declared(file) || (
        graph.frontend === "cli" && specifier === "bun:sqlite" &&
        normalize(file).endsWith("/packages/desktop/src/editor-zed.ts") && modules.includes(normalize(file))
      ))) return []
    }
    return owner ? [{ frontend: graph.frontend, file: output.file, line: 1, specifier: raw, owner, kind: "bundle" }] : []
  }))
  return [...new Map(violations.map((entry) => [JSON.stringify(entry), entry])).values()]
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const unexpected = await checkWorkspace(root)
  if (unexpected.length) {
    console.error("Unexpected workspace packages:")
    for (const name of unexpected) console.error(`- ${name}`)
    process.exit(1)
  }
  console.log(`YCoding workspace boundary passed: ${approvedPackageNames.size} packages`)
}
