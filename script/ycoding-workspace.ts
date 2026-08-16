import path from "node:path"
import { readdir } from "node:fs/promises"

export const approvedPackageNames = new Set([
  "@ycoding-ai/ai",
  "@ycoding-ai/cli",
  "@ycoding-ai/client",
  "@ycoding-ai/codemode",
  "@ycoding-ai/core",
  "@ycoding-ai/effect-drizzle-sqlite",
  "@ycoding-ai/effect-sqlite-node",
  "@ycoding-ai/http-recorder",
  "@ycoding-ai/httpapi-codegen",
  "@ycoding-ai/plugin",
  "@ycoding-ai/protocol",
  "@ycoding-ai/schema",
  "@ycoding-ai/script",
  "@ycoding-ai/server",
  "@ycoding-ai/simulation",
  "@ycoding-ai/tui",
  "@ycoding-ai/ui",
])

export async function discoverPackageNames(root: string): Promise<string[]> {
  const names: string[] = []
  const packages = path.join(root, "packages")

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

  await visit(packages, 0)
  return names.sort()
}

export async function checkWorkspace(root: string): Promise<string[]> {
  const discovered = await discoverPackageNames(root)
  return discovered.filter((name) => !approvedPackageNames.has(name))
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const unexpected = await checkWorkspace(root)
  if (unexpected.length) {
    console.error("Unexpected non-TUI workspace packages:")
    for (const name of unexpected) console.error(`- ${name}`)
    process.exit(1)
  }
  console.log(`YCoding workspace boundary passed: ${approvedPackageNames.size} packages`)
}
