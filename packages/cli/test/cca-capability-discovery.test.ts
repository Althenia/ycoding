import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CcaPolicy } from "@ycoding-ai/core/cca/policy"
import {
  ccaMaxCapabilityRootsPerRequest,
  discoverCcaCapabilityRoots,
  type CcaCapabilityFileSystem,
  type CcaCapabilityRootDiscovery,
  type CcaCapabilityTree,
} from "../src/remote-control/cca-capability-discovery"
import type { CcaFsReadDirectoryResult, CcaRpcHandlerContext } from "../src/remote-control/cca-executor-rpc"

const MIB = 1024 * 1024
const cleanups: string[] = []
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratch() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-discovery-")))
  cleanups.push(dir)
  return dir
}

async function put(file: string, contents: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents)
}

const uri = (native: string) => CcaPolicy.toPathUri(native)
const native = (fileUri: string) => CcaPolicy.parsePathUri(fileUri)

type Overrides = {
  readonly readDirectory?: (dir: string) => Promise<CcaFsReadDirectoryResult> | undefined
  readonly file?: (file: string) => { readonly size: number; readonly bytes: Uint8Array } | undefined
}

function harness(overrides: Overrides = {}) {
  const calls = { opened: 0, released: 0, readDirectory: 0 }
  const tree = (): CcaCapabilityTree => ({
    getMetadata: async ({ path: target }) => {
      const file = native(target)
      const fake = overrides.file?.(file)
      if (fake !== undefined) return { isDirectory: false, isFile: true, isSymlink: false, size: fake.size, createdAtMs: 0, modifiedAtMs: 0 }
      const info = await stat(file).catch((error: unknown) => {
        const missing = error instanceof Error && "code" in error && error.code === "ENOENT"
        throw Object.assign(new Error("No such file or directory (os error 2)"), { code: missing ? -32004 : -32603 })
      })
      const link = await lstat(file)
      return { isDirectory: info.isDirectory(), isFile: info.isFile(), isSymlink: link.isSymbolicLink(), size: info.size, createdAtMs: 0, modifiedAtMs: 0 }
    },
    readDirectory: async ({ path: target }) => {
      calls.readDirectory++
      const dir = native(target)
      const fake = overrides.readDirectory?.(dir)
      if (fake !== undefined) return fake
      const entries = await readdir(dir, { withFileTypes: true })
      return { entries: entries.map((entry) => ({ fileName: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() })) }
    },
    readFile: async ({ path: target }) => {
      const file = native(target)
      const fake = overrides.file?.(file)
      return { dataBase64: Buffer.from(fake?.bytes ?? (await readFile(file))).toString("base64") }
    },
    release: async () => {
      calls.released++
    },
  })
  const fs: CcaCapabilityFileSystem = {
    openReadTree: async () => {
      calls.opened++
      return tree()
    },
  }
  return { fs, calls }
}

const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error)

const context = (signal: AbortSignal = new AbortController().signal): CcaRpcHandlerContext => ({ signal, sessionId: "synthetic-session" })

async function discoverOne(fs: CcaCapabilityFileSystem, root: string): Promise<CcaCapabilityRootDiscovery> {
  const result = await discoverCcaCapabilityRoots(fs, { roots: [{ id: "r", path: uri(root) }] }, context())
  return result.roots[0]
}

const skillPaths = (root: string, discovery: CcaCapabilityRootDiscovery) =>
  discovery.skills.map((skill) => path.relative(root, native(skill.instructions.path)))

describe("capabilityRoots/discoverV1 walk parity (exec-server capability_discovery.rs, local_file_system.rs sync_walk)", () => {
  test("scans directories at depths 0 through 6, skips symlinked files, and reports looped or aliased directories once", async () => {
    const base = await scratch()
    const root = path.join(base, "root")
    let deep = root
    for (let depth = 1; depth <= 8; depth++) {
      deep = path.join(deep, `d${depth}`)
      await put(path.join(deep, "SKILL.md"), `depth ${depth}`)
    }
    await put(path.join(root, "SKILL.md"), "depth 0")
    await put(path.join(base, "outside", "SKILL.md"), "outside file")
    await mkdir(path.join(root, "linkfile"))
    await symlink(path.join(base, "outside", "SKILL.md"), path.join(root, "linkfile", "SKILL.md"))
    await put(path.join(base, "shared", "SKILL.md"), "shared")
    await symlink(path.join(base, "shared"), path.join(root, "alias-a"))
    await symlink(path.join(base, "shared"), path.join(root, "alias-b"))
    await symlink(root, path.join(root, "loop"))

    const discovery = await discoverOne(harness().fs, root)
    expect(discovery.skills.map((skill) => [path.relative(root, native(skill.instructions.path)), skill.instructions.contents])).toEqual([
      ["SKILL.md", "depth 0"],
      ["alias-a/SKILL.md", "shared"],
      ["d1/SKILL.md", "depth 1"],
      ["d1/d2/SKILL.md", "depth 2"],
      ["d1/d2/d3/SKILL.md", "depth 3"],
      ["d1/d2/d3/d4/SKILL.md", "depth 4"],
      ["d1/d2/d3/d4/d5/SKILL.md", "depth 5"],
      ["d1/d2/d3/d4/d5/d6/SKILL.md", "depth 6"],
    ])
    expect(discovery.warnings).toEqual([])
    expect(discovery.error).toBeNull()
  })

  test("oversized and non-UTF-8 files warn with the official messages", async () => {
    const base = await scratch()
    const root = path.join(base, "root")
    await put(path.join(root, "bad", "SKILL.md"), new Uint8Array([0xff, 0xfe, 0x41]))
    await put(path.join(root, "cut", "SKILL.md"), new Uint8Array([0x41, 0xe2, 0x82]))
    await put(path.join(root, "big", "SKILL.md"), "x".repeat(MIB + 1))
    await put(path.join(root, "grown", "SKILL.md"), "small")
    const grown = path.join(root, "grown", "SKILL.md")
    const { fs } = harness({ file: (file) => (file === grown ? { size: 5, bytes: new Uint8Array(MIB + 1) } : undefined) })
    const discovery = await discoverOne(fs, root)
    expect(discovery.skills).toEqual([])
    expect(discovery.warnings).toEqual([
      `capability file ${uri(path.join(root, "bad", "SKILL.md"))} is not UTF-8: invalid utf-8 sequence of 1 bytes from index 0`,
      `capability file ${uri(path.join(root, "big", "SKILL.md"))} exceeds the 1048576-byte limit`,
      `capability file ${uri(path.join(root, "cut", "SKILL.md"))} is not UTF-8: incomplete utf-8 byte sequence from index 1`,
      `capability file ${uri(grown)} exceeded its read limit`,
    ])
  })

  test("all files of one root share a 16 MiB byte budget", async () => {
    const root = path.join(await scratch(), "root")
    for (let index = 0; index < 17; index++) await put(path.join(root, `s${String(index).padStart(2, "0")}`, "SKILL.md"), "stub")
    const { fs } = harness({ file: (file) => (path.basename(file) === "SKILL.md" ? { size: MIB, bytes: new Uint8Array(MIB).fill(0x61) } : undefined) })
    const discovery = await discoverOne(fs, root)
    expect(skillPaths(root, discovery)).toEqual(Array.from({ length: 16 }, (_, index) => `s${String(index).padStart(2, "0")}/SKILL.md`))
    expect(discovery.warnings).toEqual(["capability root bundle exceeds the 16777216-byte limit"])
  })

  test("the entry limit stops the walk immediately, after counting entries in sorted-name order", async () => {
    const root = path.join(await scratch(), "root")
    await put(path.join(root, "SKILL.md"), "root")
    await put(path.join(root, "a", "SKILL.md"), "queued before the limit")
    await put(path.join(root, "zz", "SKILL.md"), "sorted past the limit")
    const synthetic = Array.from({ length: 20_000 }, (_, index) => ({ fileName: `f${String(index).padStart(5, "0")}`, isDirectory: false, isFile: true }))
    const listing: CcaFsReadDirectoryResult = {
      entries: [{ fileName: "zz", isDirectory: true, isFile: false }, ...synthetic.reverse(), { fileName: "SKILL.md", isDirectory: false, isFile: true }, { fileName: "a", isDirectory: true, isFile: false }],
    }
    const { fs, calls } = harness({ readDirectory: (dir) => (dir === root ? Promise.resolve(listing) : undefined) })
    const discovery = await discoverOne(fs, root)
    expect(skillPaths(root, discovery)).toEqual(["SKILL.md"])
    expect(discovery.warnings).toEqual([`capability scan reached its traversal limit (root: ${uri(root)})`])
    expect(calls.readDirectory).toBe(1)
  })

  test("the directory limit counts the root and keeps the sorted first 1,999 subdirectories", async () => {
    const root = path.join(await scratch(), "root")
    const names = ["aa", ...Array.from({ length: 2_000 }, (_, index) => `d${String(index).padStart(4, "0")}`), "zz"]
    await Promise.all(names.map((name) => mkdir(path.join(root, name), { recursive: true })))
    for (const name of ["aa", "d1997", "d1998", "zz"]) await put(path.join(root, name, "SKILL.md"), name)
    const listing: CcaFsReadDirectoryResult = { entries: [...names].reverse().map((fileName) => ({ fileName, isDirectory: true, isFile: false })) }
    const { fs } = harness({ readDirectory: (dir) => (dir === root ? Promise.resolve(listing) : undefined) })
    const discovery = await discoverOne(fs, root)
    expect(skillPaths(root, discovery)).toEqual(["aa/SKILL.md", "d1997/SKILL.md"])
    expect(discovery.warnings).toEqual([`capability scan reached its traversal limit (root: ${uri(root)})`])
  })

  test("an openReadTree failure answers a per-root error", async () => {
    const root = path.join(await scratch(), "root")
    await mkdir(root)
    const fs: CcaCapabilityFileSystem = { openReadTree: async () => Promise.reject(new Error("synthetic denial")) }
    expect(await discoverOne(fs, root)).toEqual({
      id: "r",
      path: uri(root),
      plugin: null,
      skills: [],
      namespaceManifests: [],
      warnings: [],
      error: `failed to inspect capability root ${uri(root)}: synthetic denial`,
    })
  })

  test("more than 128 roots are rejected before any tree opens", async () => {
    const root = path.join(await scratch(), "root")
    await mkdir(root)
    const { fs, calls } = harness()
    const roots = Array.from({ length: ccaMaxCapabilityRootsPerRequest + 1 }, (_, index) => ({ id: `r${index}`, path: uri(root) }))
    expect(await rejection(discoverCcaCapabilityRoots(fs, { roots }, context()))).toMatchObject({ code: -32600, message: "capability root discovery accepts at most 128 roots" })
    expect(calls.opened).toBe(0)
    expect((await discoverCcaCapabilityRoots(fs, { roots: roots.slice(1) }, context())).roots).toHaveLength(128)
  })

  test("cancellation stops every walk, releases every opened tree, and rejects the request", async () => {
    const base = await scratch()
    const roots = Array.from({ length: 12 }, (_, index) => path.join(base, `root${index}`))
    for (const root of roots) await put(path.join(root, "nested", "SKILL.md"), "skill")
    const controller = new AbortController()
    const { fs, calls } = harness({
      readDirectory: () => {
        controller.abort()
        return undefined
      },
    })
    const request = discoverCcaCapabilityRoots(fs, { roots: roots.map((root, index) => ({ id: `r${index}`, path: uri(root) })) }, context(controller.signal))
    expect(await rejection(request)).toMatchObject({ code: -32603, message: "capability root discovery cancelled" })
    expect(calls.opened).toBeGreaterThan(0)
    expect(calls.opened).toBeLessThanOrEqual(8)
    expect(calls.released).toBe(calls.opened)
    expect(calls.readDirectory).toBeLessThanOrEqual(calls.opened)

    const aborted = new AbortController()
    aborted.abort()
    const idle = harness()
    expect(await rejection(discoverCcaCapabilityRoots(idle.fs, { roots: [{ id: "r", path: uri(roots[0]) }] }, context(aborted.signal)))).toMatchObject({ code: -32603 })
    expect(idle.calls.opened).toBe(0)
  })
})
