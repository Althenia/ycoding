import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import { approvedPackageNames, checkWorkspace, discoverPackageNames } from "./ycoding-workspace"

const root = path.resolve(import.meta.dirname, "..")

describe("YCoding workspace", () => {
  test("contains only the approved runtime and client packages", async () => {
    const discovered = await discoverPackageNames(root)
    expect(discovered).toEqual([...approvedPackageNames].sort())
  })

  test("discovers approved web and relay packages while rejecting unrelated apps", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "ycoding-workspace-"))
    try {
      for (const [directory, name] of [
        ["packages/remote", "@ycoding-ai/remote"],
        ["apps/web", "@ycoding-ai/web"],
        ["apps/unapproved", "unapproved-app"],
      ] as const) {
        await mkdir(path.join(fixture, directory), { recursive: true })
        await Bun.write(path.join(fixture, directory, "package.json"), JSON.stringify({ name }))
      }
      expect(await discoverPackageNames(fixture)).toEqual([
        "@ycoding-ai/remote",
        "@ycoding-ai/web",
        "unapproved-app",
      ])
      expect(await checkWorkspace(fixture)).toEqual(["unapproved-app"])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
