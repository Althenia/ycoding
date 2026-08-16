import { describe, expect, test } from "bun:test"
import path from "node:path"
import { approvedPackageNames, discoverPackageNames } from "./ycoding-workspace"

const root = path.resolve(import.meta.dirname, "..")

describe("YCoding TUI-only workspace", () => {
  test("contains only the verified TUI dependency closure", async () => {
    const discovered = await discoverPackageNames(root)
    expect(discovered).toEqual([...approvedPackageNames].sort())
  })
})
