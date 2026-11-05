import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const source = await fs.readFile(path.join(import.meta.dir, "../script/prepare-backend.ts"), "utf8")

test("backend preparation reads the version from build metadata without executing the built binary", () => {
  expect(source.match(/Bun\.spawn\(/g)).toHaveLength(1)
  expect(source).not.toContain("--version")
  expect(source).toContain('"script/build.ts"')
  expect(source).toMatch(/cli-\$\{process\.platform\}-\$\{process\.arch\}["`]?,\s*"package\.json"/)
  expect(source).toMatch(/typeof metadata\.version === "string" && metadata\.version/)
})
