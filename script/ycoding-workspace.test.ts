import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import { approvedPackageNames, checkBundleGraph, checkWorkspace, discoverPackageNames } from "./ycoding-workspace"

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
        ["extensions/meeting", "@ycoding-ai/meeting"],
        ["extensions/unapproved", "unapproved-extension"],
      ] as const) {
        await mkdir(path.join(fixture, directory), { recursive: true })
        await Bun.write(path.join(fixture, directory, "package.json"), JSON.stringify({ name }))
      }
      expect(await discoverPackageNames(fixture)).toEqual([
        "@ycoding-ai/meeting",
        "@ycoding-ai/remote",
        "@ycoding-ai/web",
        "unapproved-app",
        "unapproved-extension",
      ])
      expect(await checkWorkspace(fixture)).toEqual(["unapproved-app", "unapproved-extension"])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

test("shipped bundle audit rejects runtime owners and permits public client modules", () => {
  const graph = (modules: string[], imports: string[] = []) => ({ frontend: "plugin-sdk", outputs: [{ file: "sdk.mjs", modules, imports }] })
  expect(checkBundleGraph(graph(["/fixture/packages/plugin/src/index.ts", "/fixture/packages/schema/src/model.ts"], ["node:path"]))).toEqual([])
  for (const owner of ["core", "server", "meeting", "ai", "store", "codemode", "effect-drizzle-sqlite", "effect-sqlite-node"]) {
    expect(checkBundleGraph(graph([`/fixture/packages/${owner}/src/index.ts`]))).toMatchObject([{ owner: `@ycoding-ai/${owner}`, kind: "bundle" }])
    expect(checkBundleGraph(graph(["/fixture/packages/plugin/src/index.ts"], [`@ycoding-ai/${owner}/entry`]))).toMatchObject([{ owner: `@ycoding-ai/${owner}`, kind: "bundle" }])
  }
  expect(checkBundleGraph(graph(["/fixture/packages/plugin/src/index.ts"], ["node-pty", "bun:sqlite"])).map((entry) => entry.owner)).toEqual(["node-pty", "sqlite"])
  expect(() => checkBundleGraph({ frontend: "plugin-sdk", outputs: [] })).toThrow("Empty shipped graph")
})

test("SQLite is allowed only for the declared Zed reader and its import edge", () => {
  const reader = "/fixture/packages/tui/src/editor-zed-sqlite.bun.ts"
  const owner = "/fixture/packages/tui/src/editor-zed.ts"
  const graph = (modules: string[], edges: { file: string; specifier: string }[]) => ({ frontend: "tui", outputs: [{ file: "tui.js", modules, imports: ["bun:sqlite"], edges }] })
  expect(checkBundleGraph(graph([reader, owner], [{ file: reader, specifier: "bun:sqlite" }]))).toEqual([])
  expect(checkBundleGraph(graph([reader], [{ file: reader, specifier: "bun:sqlite" }]))[0]?.owner).toBe("sqlite")
  expect(checkBundleGraph(graph([reader, owner], [{ file: "/fixture/packages/tui/src/other.ts", specifier: "bun:sqlite" }]))[0]?.owner).toBe("sqlite")
})
