import { expect, test } from "bun:test"
import path from "node:path"
import { readdir, readFile } from "node:fs/promises"

test("TUI-BOUNDARY source and tests import no Core or Server module", async () => {
  const root = path.resolve(import.meta.dir, "..")
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const violations = (
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.parentPath.includes("node_modules"),
        )
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name)
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
