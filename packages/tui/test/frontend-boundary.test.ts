import { expect, test } from "bun:test"
import path from "node:path"
import { readdir, readFile } from "node:fs/promises"

test("TUI-BOUNDARY source and tests import no Core or Server module", async () => {
  const root = path.resolve(import.meta.dir, "..")
  const files = await sourceFiles(root)
  const violations = (
    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(file, "utf8")
        return /(?:from\s*|import\s*\(|export\s*.*from\s*)["'][^"']*(?:@ycoding-ai\/(?:core|server)|packages\/(?:core|server))[\/"']/.test(
          source,
        )
          ? path.relative(root, file)
          : undefined
      }),
    )
  ).filter((value) => value !== undefined)
  expect(violations).toEqual([])
})

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries
        .filter((entry) => entry.name !== "node_modules")
        .map(async (entry) => {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) return sourceFiles(file)
          return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : []
        }),
    )
  ).flat()
}
