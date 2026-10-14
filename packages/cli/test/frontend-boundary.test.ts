import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"

test("CLI source and manifest keep execution behind the client boundary", async () => {
  const root = path.resolve(import.meta.dirname, "..")
  const files = Array.from(new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root }))
  const violations = (
    await Promise.all(
      files.map(async (file) => {
        const source = await readFile(path.join(root, file), "utf8")
        return /(?:from\s*|import\s*\()?["']@ycoding-ai\/(?:core|server|meeting|plugin)(?:[\/"'])/.test(source)
          ? file
          : undefined
      }),
    )
  ).filter((file) => file !== undefined)
  expect(violations).toEqual([])
  expect(
    Object.keys(pkg.dependencies).filter((name) => /^@ycoding-ai\/(?:core|server|meeting|plugin)$/.test(name)),
  ).toEqual([])
})
