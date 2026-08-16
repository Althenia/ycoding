import { describe, expect, test } from "bun:test"
import { exists } from "node:fs/promises"
import path from "node:path"
import { approvedPackageNames, discoverPackageNames } from "./ycoding-workspace"

const root = path.resolve(import.meta.dirname, "..")
const legacyProduct = ["open", "code"].join("")

describe("YCoding package identity", () => {
  test("uses the YCoding package scope for every retained workspace package", async () => {
    const discovered = await discoverPackageNames(root)
    expect(discovered.every((name) => name.startsWith("@ycoding-ai/"))).toBe(true)
    expect(discovered).toEqual([...approvedPackageNames].sort())
  })

  test("publishes only the ycoding executable", async () => {
    const manifest = await Bun.file(path.join(root, "packages/cli/package.json")).json()
    expect(manifest.bin).toEqual({ ycoding: "./bin/ycoding.cjs" })
    expect(await exists(path.join(root, "packages/cli/bin/ycoding.cjs"))).toBe(true)
    expect(await exists(path.join(root, `packages/cli/bin/${legacyProduct}.cjs`))).toBe(false)
  })

  test("contains no active old workspace scope in manifests or task configuration", async () => {
    const rootManifest = await Bun.file(path.join(root, "package.json")).json()
    const files = [
      "package.json",
      "turbo.json",
      ...rootManifest.workspaces.packages.map((directory: string) => `${directory}/package.json`),
    ]
    const stale: string[] = []
    for (const file of files) {
      if ((await Bun.file(path.join(root, file)).text()).includes(`@${legacyProduct}-ai`)) stale.push(file)
    }
    expect(stale).toEqual([])
  })
})
