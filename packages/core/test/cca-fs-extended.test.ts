import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, open as fsOpen, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CcaAuthorizationInput } from "../src/cca/errors"
import { CcaFsExtended } from "../src/cca/fs-extended"
import { CcaPolicy } from "../src/cca/policy"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "cca-fs-ext-")))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const uri = (native: string) => CcaPolicy.toPathUri(native)
const bytes = (text: string) => new Uint8Array(Buffer.from(text))
const text = (chunk: Uint8Array) => Buffer.from(chunk).toString("utf8")
const ctx = { signal: new AbortController().signal, sessionId: "session" }
const notFound = { code: -32004, message: "No such file or directory (os error 2)" }
const sandboxDenied = { code: -32600, message: "Permission denied" }
const outsideRoots = { code: -32600, message: "Operation not permitted (os error 1)" }
const symlinkLoop = { code: -32603, message: expect.stringMatching(/^Too many levels of symbolic links \(os error \d+\)$/) }
const pathEntry = (native: string, access: string) => ({ path: { type: "path", path: uri(native) }, access })
const managed = (entries: unknown[]) => ({ type: "managed", file_system: { type: "restricted", entries }, network: "restricted" })
const sandboxFor = (cwd: string, entries: unknown[]) => ({
  permissions: managed(entries),
  cwd: uri(cwd),
  workspaceRoots: [uri(cwd)],
  useLegacyLandlock: false,
})
const walkOptions = (options: Partial<CcaFsExtended.WalkOptions> = {}): CcaFsExtended.WalkOptions => ({
  maxDepth: 4,
  maxDirectories: 10,
  maxEntries: 10,
  followDirectorySymlinks: false,
  ...options,
})

async function setup(
  options: {
    root?: string
    deny?: (input: CcaAuthorizationInput) => boolean
    onAuthorize?: (input: CcaAuthorizationInput) => Promise<void>
    failRelease?: boolean
  } = {},
) {
  const root = options.root ?? (await tempRoot())
  const calls: CcaAuthorizationInput[] = []
  let released = 0
  const fsx = CcaFsExtended.create({
    roots: [root],
    temporaryDirectories: () => [],
    authorize: async (input) => {
      calls.push(input)
      if (options.deny?.(input)) throw new Error("synthetic denial")
      await options.onAuthorize?.(input)
      return {
        release: async () => {
          released++
          if (options.failRelease) throw new Error("synthetic release failure")
        },
      }
    },
  })
  let shut = false
  cleanups.push(async () => {
    if (!shut) await fsx.shutdown()
  })
  return {
    root,
    fsx,
    calls,
    released: () => released,
    shutdown: async () => {
      shut = true
      await fsx.shutdown()
    },
  }
}

describe("fs/createDirectory", () => {
  test("creates nested directories recursively by default and authorizes an edit of the target", async () => {
    const { root, fsx, calls } = await setup()
    const target = path.join(root, "a", "b", "c")
    expect(await fsx.createDirectory({ path: uri(target) }, ctx)).toEqual({})
    expect((await stat(target)).isDirectory()).toBe(true)
    expect(calls).toEqual([expect.objectContaining({ action: "edit", resources: [target] })])
    expect(await fsx.createDirectory({ path: uri(target), recursive: true }, ctx)).toEqual({})
  })

  test("non-recursive creation reports an existing entry and a missing parent with upstream errors", async () => {
    const { root, fsx } = await setup()
    await mkdir(path.join(root, "exists"))
    await expect(fsx.createDirectory({ path: uri(path.join(root, "exists")), recursive: false }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "File exists (os error 17)",
    })
    await expect(fsx.createDirectory({ path: uri(path.join(root, "missing", "leaf")), recursive: false }, ctx)).rejects.toMatchObject(notFound)
    await writeFile(path.join(root, "file"), "x")
    await expect(fsx.createDirectory({ path: uri(path.join(root, "file")) }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "File exists (os error 17)",
    })
  })

  test("rejects targets outside the roots and authorization denials without creating anything", async () => {
    const outside = await tempRoot()
    const { root, fsx } = await setup({ deny: (input) => input.resources.some((item) => item.endsWith("denied")) })
    await expect(fsx.createDirectory({ path: uri(path.join(outside, "x")) }, ctx)).rejects.toMatchObject(outsideRoots)
    await expect(fsx.createDirectory({ path: uri(path.join(root, "denied")) }, ctx)).rejects.toMatchObject({ code: -32001 })
    await expect(stat(path.join(outside, "x"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(path.join(root, "denied"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("no-follow creation rejects a symlink in any ancestor and the filesystem root", async () => {
    const { root, fsx } = await setup()
    await mkdir(path.join(root, "real"))
    await symlink(path.join(root, "real"), path.join(root, "link"))
    await expect(
      fsx.createDirectory({ path: uri(path.join(root, "link", "created")), followSymlinks: false }, ctx),
    ).rejects.toMatchObject({ code: -32603 })
    await expect(stat(path.join(root, "real", "created"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await fsx.createDirectory({ path: uri(path.join(root, "real", "x", "y")), followSymlinks: false }, ctx)).toEqual({})
    expect((await stat(path.join(root, "real", "x", "y"))).isDirectory()).toBe(true)
    await expect(fsx.createDirectory({ path: "file:///", recursive: false, followSymlinks: false }, ctx)).rejects.toMatchObject(outsideRoots)
  })

  test("a restricted sandbox without write access answers Permission denied", async () => {
    const { root, fsx, calls } = await setup()
    await mkdir(path.join(root, "ro"))
    const sandbox = sandboxFor(root, [pathEntry(path.join(root, "ro"), "read")])
    await expect(fsx.createDirectory({ path: uri(path.join(root, "ro", "new")), sandbox }, ctx)).rejects.toMatchObject(sandboxDenied)
    expect(calls).toEqual([])
  })
})

describe("fs/open, fs/readBlock, fs/writeBlock, fs/close", () => {
  test("read handles support non-sequential offsets and reject writes", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "non-sequential.bin")
    await writeFile(file, "0123456789")
    const open = await fsx.open({ handleId: "reader", path: uri(file), mode: "read" }, ctx)
    expect(open).toEqual({ handleId: "reader" })
    await expect(fsx.writeBlock({ handleId: "reader", offset: 0, chunk: bytes("x") }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "Bad file descriptor (os error 9)",
    })
    const blocks = []
    for (const [offset, len] of [
      [6, 3],
      [1, 2],
      [8, 4],
      [0, 2],
    ] as const) {
      const block = await fsx.readBlock({ handleId: "reader", offset, len }, ctx)
      blocks.push([text(block.chunk), block.eof])
    }
    expect(blocks).toEqual([
      ["678", false],
      ["12", false],
      ["89", true],
      ["01", false],
    ])
    expect((await fsx.readBlock({ handleId: "reader", offset: 100, len: 1 }, ctx)).eof).toBe(true)
    expect(await fsx.close({ handleId: "reader" }, ctx)).toEqual({})
    await expect(fsx.readBlock({ handleId: "reader", offset: 0, len: 1 }, ctx)).rejects.toMatchObject({
      code: -32004,
      message: "unknown file handle `reader`",
    })
    await expect(fsx.writeBlock({ handleId: "reader", offset: 0, chunk: bytes("x") }, ctx)).rejects.toMatchObject({
      code: -32004,
      message: "unknown file handle `reader`",
    })
    expect(await fsx.close({ handleId: "reader" }, ctx)).toEqual({})
  })

  test("handle IDs, read lengths, and open targets are validated with upstream errors", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "f.bin")
    await writeFile(file, "data")
    const idError = { code: -32600, message: "file handle ID must not exceed 32 bytes" }
    const longId = "x".repeat(33)
    await expect(fsx.open({ handleId: longId, path: uri(file), mode: "read" }, ctx)).rejects.toMatchObject(idError)
    await expect(fsx.readBlock({ handleId: longId, offset: 0, len: 1 }, ctx)).rejects.toMatchObject(idError)
    await expect(fsx.writeBlock({ handleId: longId, offset: 0, chunk: bytes("x") }, ctx)).rejects.toMatchObject(idError)
    await expect(fsx.close({ handleId: longId }, ctx)).rejects.toMatchObject(idError)
    await fsx.open({ handleId: "x".repeat(32), path: uri(file), mode: "read" }, ctx)

    const lengthError = { code: -32600, message: `file read block length must be between 1 and ${CcaFsExtended.FILE_READ_CHUNK_SIZE}` }
    await expect(fsx.readBlock({ handleId: "missing", offset: 0, len: 0 }, ctx)).rejects.toMatchObject(lengthError)
    await expect(
      fsx.readBlock({ handleId: "x".repeat(32), offset: 0, len: CcaFsExtended.FILE_READ_CHUNK_SIZE + 1 }, ctx),
    ).rejects.toMatchObject(lengthError)
    await expect(fsx.readBlock({ handleId: "x".repeat(32), offset: 2 ** 63, len: 1 }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "Invalid argument (os error 22)",
    })
    await expect(fsx.readBlock({ handleId: "x".repeat(32), offset: 0, len: 1 }, ctx)).rejects.toMatchObject({ code: -32004 })

    await expect(fsx.open({ handleId: "m", path: uri(path.join(root, "missing.bin")), mode: "read" }, ctx)).rejects.toMatchObject(notFound)
    await expect(fsx.open({ handleId: "d", path: uri(root), mode: "read" }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: `path \`${root}\` is not a file`,
    })
    await expect(fsx.open({ handleId: "d", path: uri(root), mode: "replace" }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "Is a directory (os error 21)",
    })
    await expect(
      fsx.open({ handleId: "p", path: uri(path.join(root, "missing", "x.bin")), mode: "replace" }, ctx),
    ).rejects.toMatchObject(notFound)
  })

  test("the per-connection handle limit is enforced and close releases capacity", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "limited.bin")
    await writeFile(file, "limited")
    for (let index = 0; index < CcaFsExtended.MAX_OPEN_FILES; index++) {
      await fsx.open({ handleId: String(index), path: uri(file), mode: "read" }, ctx)
    }
    await expect(fsx.open({ handleId: "overflow", path: uri(file), mode: "read" }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "at most 128 file handles may be open per connection",
    })
    await fsx.close({ handleId: "0" }, ctx)
    expect(await fsx.open({ handleId: "next", path: uri(file), mode: "read" }, ctx)).toEqual({ handleId: "next" })
  })

  test("rejected replacement opens neither truncate existing files nor create missing files", async () => {
    for (const [count, handleId, message] of [
      [1, "0", "file handle `0` already exists"],
      [CcaFsExtended.MAX_OPEN_FILES, "overflow", "at most 128 file handles may be open per connection"],
    ] as const) {
      const { root, fsx } = await setup()
      const existing = path.join(root, "existing.bin")
      const missing = path.join(root, "missing.bin")
      await writeFile(existing, "original")
      for (let index = 0; index < count; index++) {
        await fsx.open({ handleId: String(index), path: uri(existing), mode: "read" }, ctx)
      }
      for (const target of [existing, missing]) {
        await expect(fsx.open({ handleId, path: uri(target), mode: "replace" }, ctx)).rejects.toMatchObject({ code: -32600, message })
      }
      expect(await readFile(existing, "utf8")).toBe("original")
      await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" })
    }
  })

  test("concurrent opens of one ID keep the first file and reject the other", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "first"), "first")
    await writeFile(path.join(root, "second"), "second")
    const results = await Promise.allSettled([
      fsx.open({ handleId: "shared", path: uri(path.join(root, "first")), mode: "read" }, ctx),
      fsx.open({ handleId: "shared", path: uri(path.join(root, "second")), mode: "read" }, ctx),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    expect(rejected?.reason).toMatchObject({ code: -32600, message: "file handle `shared` already exists" })
    const winner = results[0]?.status === "fulfilled" ? "first" : "second"
    expect(text((await fsx.readBlock({ handleId: "shared", offset: 0, len: 16 }, ctx)).chunk)).toBe(winner)
  })

  test("replacement handles truncate, write explicit offsets, enforce bounds, and close after a failed read", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "blocks.bin")
    await writeFile(file, "original")
    const block = CcaFsExtended.FILE_WRITE_CHUNK_SIZE
    await fsx.open({ handleId: "writer", path: uri(file), mode: "replace" }, ctx)
    expect((await stat(file)).size).toBe(0)
    for (const [offset, chunk] of [
      [block, new Uint8Array(3).fill(0x7a)],
      [0, new Uint8Array(block).fill(0x61)],
      [1, bytes("bc")],
    ] as const) {
      expect(await fsx.writeBlock({ handleId: "writer", offset, chunk }, ctx)).toEqual({})
    }
    const lengthError = { code: -32600, message: `file write block length must be between 1 and ${block}` }
    await expect(fsx.writeBlock({ handleId: "writer", offset: 0, chunk: new Uint8Array(0) }, ctx)).rejects.toMatchObject(lengthError)
    await expect(fsx.writeBlock({ handleId: "writer", offset: 0, chunk: new Uint8Array(block + 1) }, ctx)).rejects.toMatchObject(lengthError)
    const rangeError = { code: -32600, message: "file write range exceeds the signed 64-bit file offset limit" }
    for (const offset of [2 ** 64, 2 ** 63]) {
      await expect(fsx.writeBlock({ handleId: "writer", offset, chunk: bytes("x") }, ctx)).rejects.toMatchObject(rangeError)
    }
    await expect(fsx.writeBlock({ handleId: "missing", offset: 0, chunk: new Uint8Array(0) }, ctx)).rejects.toMatchObject(lengthError)
    const inexact = { code: -32600, message: `file block range exceeds the largest exact offset ${Number.MAX_SAFE_INTEGER}` }
    await expect(fsx.writeBlock({ handleId: "writer", offset: 2 ** 60, chunk: bytes("x") }, ctx)).rejects.toMatchObject(inexact)

    const expected = Buffer.alloc(block + 3, 0x61)
    expected.write("bc", 1)
    expected.write("zzz", block)
    expect(Buffer.compare(await readFile(file), expected)).toBe(0)

    await expect(fsx.readBlock({ handleId: "writer", offset: 0, len: 4 }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "Bad file descriptor (os error 9)",
    })
    await expect(fsx.writeBlock({ handleId: "writer", offset: 0, chunk: bytes("x") }, ctx)).rejects.toMatchObject({
      code: -32004,
      message: "unknown file handle `writer`",
    })
  })

  test("open holds its authorization grant until the handle closes, and shutdown releases the rest", async () => {
    const { root, fsx, calls, released, shutdown } = await setup()
    const file = path.join(root, "grant.bin")
    await writeFile(file, "x")
    await fsx.open({ handleId: "r", path: uri(file), mode: "read" }, ctx)
    await fsx.open({ handleId: "w", path: uri(path.join(root, "new.bin")), mode: "replace" }, ctx)
    expect(calls.map((call) => [call.action, call.resources])).toEqual([
      ["read", [file]],
      ["edit", [path.join(root, "new.bin")]],
    ])
    expect(released()).toBe(0)
    await fsx.close({ handleId: "r" }, ctx)
    expect(released()).toBe(1)
    await shutdown()
    expect(released()).toBe(2)
    await expect(fsx.open({ handleId: "late", path: uri(file), mode: "read" }, ctx)).rejects.toMatchObject({ code: -32603 })
  })

  test("authorization denial, root escapes, and restricted sandboxes block opens before touching files", async () => {
    const outside = await tempRoot()
    const { root, fsx, released } = await setup({ deny: (input) => input.resources.some((item) => item.endsWith("guarded.bin")) })
    await writeFile(path.join(root, "guarded.bin"), "original")
    await writeFile(path.join(outside, "outside.bin"), "original")
    await expect(fsx.open({ handleId: "g", path: uri(path.join(root, "guarded.bin")), mode: "replace" }, ctx)).rejects.toMatchObject({
      code: -32001,
    })
    await expect(fsx.open({ handleId: "o", path: uri(path.join(outside, "outside.bin")), mode: "replace" }, ctx)).rejects.toMatchObject(outsideRoots)
    await mkdir(path.join(root, "workspace"))
    const sandbox = sandboxFor(path.join(root, "workspace"), [pathEntry(path.join(root, "workspace"), "write")])
    await expect(
      fsx.open({ handleId: "s", path: uri(path.join(root, "guarded.bin")), mode: "replace", sandbox }, ctx),
    ).rejects.toMatchObject(sandboxDenied)
    await fsx.open({ handleId: "allowed", path: uri(path.join(root, "workspace", "allowed.bin")), mode: "replace", sandbox }, ctx)
    await fsx.writeBlock({ handleId: "allowed", offset: 0, chunk: bytes("allowed") }, ctx)
    await fsx.close({ handleId: "allowed" }, ctx)
    expect(await readFile(path.join(root, "workspace", "allowed.bin"), "utf8")).toBe("allowed")
    expect(await readFile(path.join(root, "guarded.bin"), "utf8")).toBe("original")
    expect(await readFile(path.join(outside, "outside.bin"), "utf8")).toBe("original")
    expect(released()).toBe(1)
    for (let index = 0; index < CcaFsExtended.MAX_OPEN_FILES; index++) {
      await fsx.open({ handleId: String(index), path: uri(path.join(root, "workspace", "allowed.bin")), mode: "read" }, ctx)
    }
  })
})

describe("fs/walk", () => {
  test("returns a bounded breadth-first tree", async () => {
    const { root, fsx, calls } = await setup()
    const source = path.join(root, "source")
    const nested = path.join(source, "nested")
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(source, "root.txt"), "root")
    await writeFile(path.join(nested, "note.txt"), "nested")
    const rootEntries: CcaFsExtended.WalkEntry[] = [
      { path: uri(nested), kind: "directory" },
      { path: uri(path.join(source, "root.txt")), kind: "file" },
    ]
    expect(await fsx.walk({ path: uri(source), options: walkOptions() }, ctx)).toEqual({
      entries: [...rootEntries, { path: uri(path.join(nested, "note.txt")), kind: "file" }],
      errors: [],
      truncated: false,
    })
    expect(calls[0]).toMatchObject({ action: "read", resources: [source] })
    expect(await fsx.walk({ path: uri(source), options: walkOptions({ maxDepth: 0 }) }, ctx)).toEqual({
      entries: rootEntries,
      errors: [],
      truncated: false,
    })
    expect(await fsx.walk({ path: uri(source), options: walkOptions({ maxDirectories: 1 }) }, ctx)).toEqual({
      entries: rootEntries,
      errors: [],
      truncated: true,
    })
    expect(await fsx.walk({ path: uri(source), options: walkOptions({ maxEntries: 1 }) }, ctx)).toEqual({
      entries: rootEntries.slice(0, 1),
      errors: [],
      truncated: true,
    })
  })

  test("handles file and missing roots and validates limits before the root", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "file.txt"), "contents")
    const missing = uri(path.join(root, "missing"))
    const options = walkOptions({ maxDepth: 8, maxDirectories: 100, maxEntries: 100 })
    expect(await fsx.walk({ path: uri(path.join(root, "file.txt")), options }, ctx)).toEqual({ entries: [], errors: [], truncated: false })
    await expect(fsx.walk({ path: missing, options }, ctx)).rejects.toMatchObject(notFound)
    const zero = "filesystem walk limits must be greater than zero"
    const excessive = `filesystem walk limits exceed maximums: depth=${CcaFsExtended.MAX_WALK_DEPTH}, directories=${CcaFsExtended.MAX_WALK_DIRECTORIES}, entries=${CcaFsExtended.MAX_WALK_ENTRIES}`
    for (const [limits, message] of [
      [{ maxDirectories: 0 }, zero],
      [{ maxEntries: 0 }, zero],
      [{ maxDepth: CcaFsExtended.MAX_WALK_DEPTH + 1 }, excessive],
      [{ maxDirectories: CcaFsExtended.MAX_WALK_DIRECTORIES + 1 }, excessive],
      [{ maxEntries: CcaFsExtended.MAX_WALK_ENTRIES + 1 }, excessive],
    ] as const) {
      await expect(fsx.walk({ path: missing, options: { ...options, ...limits } }, ctx)).rejects.toMatchObject({ code: -32600, message })
    }
  })

  test("skips symlinks unless directory symlinks are followed, without revisiting directories", async () => {
    const { root: base, fsx } = await setup()
    const root = path.join(base, "root")
    const target = path.join(base, "target")
    await mkdir(root)
    await mkdir(target)
    await writeFile(path.join(target, "note.txt"), "target")
    await symlink(target, path.join(root, "target-link"))
    await symlink(root, path.join(target, "root-link"))
    await symlink(path.join(target, "note.txt"), path.join(root, "file-link"))
    await symlink(path.join(root, "missing"), path.join(root, "broken-link"))
    for (const walkRoot of [root, path.join(target, "root-link")]) {
      const link = path.join(walkRoot, "target-link")
      expect(await fsx.walk({ path: uri(walkRoot), options: walkOptions({ maxDepth: 2, maxDirectories: 4, maxEntries: 8 }) }, ctx)).toEqual({
        entries: [],
        errors: [],
        truncated: false,
      })
      expect(
        await fsx.walk(
          { path: uri(walkRoot), options: walkOptions({ maxDepth: 2, maxDirectories: 4, maxEntries: 8, followDirectorySymlinks: true }) },
          ctx,
        ),
      ).toEqual({
        entries: [
          { path: uri(link), kind: "directory" },
          { path: uri(path.join(link, "note.txt")), kind: "file" },
          { path: uri(path.join(link, "root-link")), kind: "directory" },
        ],
        errors: [],
        truncated: false,
      })
    }
  })

  test("prunes hidden directories without claiming their visible aliases", async () => {
    const { root: base, fsx } = await setup()
    const root = path.join(base, "root")
    const hidden = path.join(root, ".hidden")
    const visible = path.join(root, "visible")
    await mkdir(path.join(hidden, "nested"), { recursive: true })
    await writeFile(path.join(hidden, "nested", "note.txt"), "visible through alias")
    await symlink(hidden, visible)
    expect(
      await fsx.walk(
        {
          path: uri(root),
          options: { maxDepth: 3, maxDirectories: 3, maxEntries: 6, followDirectorySymlinks: true, pruneHiddenDirectories: true },
        },
        ctx,
      ),
    ).toEqual({
      entries: [
        { path: uri(hidden), kind: "directory" },
        { path: uri(visible), kind: "directory" },
        { path: uri(path.join(visible, "nested")), kind: "directory" },
        { path: uri(path.join(visible, "nested", "note.txt")), kind: "file" },
      ],
      errors: [],
      truncated: false,
    })
  })

  test("does not traverse followed symlinks outside the roots and honors a read sandbox", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "secret.txt"), "secret")
    const { root, fsx, calls } = await setup()
    await symlink(outside, path.join(root, "escape"))
    await symlink(path.join(outside, "missing"), path.join(root, "escape-missing"))
    await symlink(path.join(outside, "secret.txt"), path.join(root, "escape-file"))
    expect(await fsx.walk({ path: uri(root), options: walkOptions({ followDirectorySymlinks: true }) }, ctx)).toEqual({
      entries: [],
      errors: ["escape", "escape-file", "escape-missing"].map((name) => ({
        path: uri(path.join(root, name)),
        message: outsideRoots.message,
      })),
      truncated: false,
    })
    expect(await fsx.walk({ path: uri(root), options: walkOptions({ maxEntries: 2 }) }, ctx)).toEqual({
      entries: [],
      errors: [],
      truncated: true,
    })
    for (const name of ["escape-file", "escape-missing"]) await rm(path.join(root, name))

    const source = path.join(root, "source")
    await mkdir(path.join(source, "private"), { recursive: true })
    await writeFile(path.join(source, "note.txt"), "sandboxed")
    const sandbox = sandboxFor(source, [pathEntry(source, "read"), pathEntry(path.join(source, "private"), "deny")])
    const before = calls.length
    expect(await fsx.walk({ path: uri(source), options: walkOptions({ maxDepth: 1, maxDirectories: 2, maxEntries: 4 }), sandbox }, ctx)).toEqual({
      entries: [{ path: uri(path.join(source, "note.txt")), kind: "file" }],
      errors: [{ path: uri(path.join(source, "private")), message: "Permission denied (os error 13)" }],
      truncated: false,
    })
    expect(calls[before]?.metadata).toMatchObject({ sandboxFileSystem: "restricted" })
    await expect(fsx.walk({ path: uri(outside), options: walkOptions(), sandbox }, ctx)).rejects.toMatchObject(sandboxDenied)
  })

  test("aborting the request stops the walk", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "a"), "a")
    const controller = new AbortController()
    controller.abort()
    await expect(
      fsx.walk({ path: uri(root), options: walkOptions() }, { signal: controller.signal, sessionId: "session" }),
    ).rejects.toMatchObject({ code: -32603, message: "filesystem walk cancelled" })
  })
})

describe("fs/remove", () => {
  test("removes directories recursively and forgives missing paths by default", async () => {
    const { root, fsx, calls } = await setup()
    const target = path.join(root, "remove-me")
    await mkdir(path.join(target, "nested"), { recursive: true })
    await writeFile(path.join(target, "nested", "note.txt"), "x")
    expect(await fsx.remove({ path: uri(target) }, ctx)).toEqual({})
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    expect(calls).toEqual([expect.objectContaining({ action: "edit", resources: [target] })])
    expect(await fsx.remove({ path: uri(target) }, ctx)).toEqual({})
    expect(await fsx.remove({ path: uri(path.join(root, "a", "b")) }, ctx)).toEqual({})
    await expect(fsx.remove({ path: uri(target), force: false }, ctx)).rejects.toMatchObject(notFound)
  })

  test("non-recursive removal of a populated directory fails and keeps it", async () => {
    const { root, fsx } = await setup()
    await mkdir(path.join(root, "full"))
    await writeFile(path.join(root, "full", "x"), "x")
    await expect(fsx.remove({ path: uri(path.join(root, "full")), recursive: false }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: expect.stringMatching(/^Directory not empty \(os error \d+\)$/),
    })
    expect((await stat(path.join(root, "full", "x"))).isFile()).toBe(true)
  })

  test("removes a symlink rather than its target", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "target.txt"), "keep")
    await symlink(path.join(root, "target.txt"), path.join(root, "link"))
    expect(await fsx.remove({ path: uri(path.join(root, "link")) }, ctx)).toEqual({})
    await expect(lstat(path.join(root, "link"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("keep")
  })

  test("no-follow removal handles files and empty directories and rejects symlinks", async () => {
    const { root, fsx } = await setup()
    const options = { recursive: false, force: false, followSymlinks: false }
    await writeFile(path.join(root, "remove-me.txt"), "remove")
    await mkdir(path.join(root, "remove-me"))
    expect(await fsx.remove({ path: uri(path.join(root, "remove-me.txt")), ...options }, ctx)).toEqual({})
    expect(await fsx.remove({ path: uri(path.join(root, "remove-me")), ...options }, ctx)).toEqual({})
    await mkdir(path.join(root, "real"))
    await writeFile(path.join(root, "real", "removable.txt"), "keep")
    await symlink(path.join(root, "real"), path.join(root, "directory-link"))
    await symlink(path.join(root, "real", "removable.txt"), path.join(root, "file-link"))
    await expect(fsx.remove({ path: uri(path.join(root, "directory-link", "removable.txt")), ...options }, ctx)).rejects.toMatchObject({
      code: -32603,
    })
    await expect(fsx.remove({ path: uri(path.join(root, "file-link")), ...options }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "path contains a symbolic link",
    })
    await expect(fsx.remove({ path: uri(path.join(root, "real")), followSymlinks: false }, ctx)).rejects.toMatchObject({
      code: -32603,
      message: "recursive no-follow removal is unsupported",
    })
    expect(await readFile(path.join(root, "real", "removable.txt"), "utf8")).toBe("keep")
    expect((await lstat(path.join(root, "file-link"))).isSymbolicLink()).toBe(true)
  })

  test("refuses a containing root, escapes, denials, and denied sandbox descendants", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "x"), "x")
    const { root, fsx } = await setup({ deny: (input) => input.resources.some((item) => item.endsWith("guarded")) })
    await symlink(outside, path.join(root, "link"))
    await mkdir(path.join(root, "guarded"))
    await expect(fsx.remove({ path: uri(root) }, ctx)).rejects.toMatchObject(outsideRoots)
    await expect(fsx.remove({ path: uri(path.join(root, "link", "x")) }, ctx)).rejects.toMatchObject(outsideRoots)
    await expect(fsx.remove({ path: uri(path.join(root, "guarded")) }, ctx)).rejects.toMatchObject({ code: -32001 })
    const tree = path.join(root, "tree")
    await mkdir(path.join(tree, "keep"), { recursive: true })
    await writeFile(path.join(tree, "keep", "prod.env"), "secret")
    const sandbox = sandboxFor(root, [pathEntry(root, "write"), { path: { type: "glob_pattern", pattern: "**/*.env" }, access: "deny" }])
    await expect(fsx.remove({ path: uri(tree), sandbox }, ctx)).rejects.toMatchObject(sandboxDenied)
    expect(await readFile(path.join(outside, "x"), "utf8")).toBe("x")
    expect(await readFile(path.join(tree, "keep", "prod.env"), "utf8")).toBe("secret")
    expect((await stat(path.join(root, "guarded"))).isDirectory()).toBe(true)
  })
})

describe("fs/copy", () => {
  test("copies files and directories, preserving symlinks and skipping special files", async () => {
    const { root, fsx, calls } = await setup()
    await writeFile(path.join(root, "a.txt"), "hello")
    expect(await fsx.copy({ sourcePath: uri(path.join(root, "a.txt")), destinationPath: uri(path.join(root, "b.txt")), recursive: false }, ctx)).toEqual({})
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("hello")
    expect(calls.map((call) => [call.action, call.resources])).toEqual([
      ["read", [path.join(root, "a.txt")]],
      ["edit", [path.join(root, "b.txt")]],
    ])

    const source = path.join(root, "source")
    await mkdir(path.join(source, "nested"), { recursive: true })
    await writeFile(path.join(source, "nested", "note.txt"), "nested")
    await symlink("nested", path.join(source, "nested-link"))
    execFileSync("mkfifo", [path.join(source, "named-pipe")])
    const copied = path.join(root, "copied")
    expect(await fsx.copy({ sourcePath: uri(source), destinationPath: uri(copied), recursive: true }, ctx)).toEqual({})
    expect(await readFile(path.join(copied, "nested", "note.txt"), "utf8")).toBe("nested")
    expect(await readlink(path.join(copied, "nested-link"))).toBe("nested")
    await expect(lstat(path.join(copied, "named-pipe"))).rejects.toMatchObject({ code: "ENOENT" })

    await symlink("a.txt", path.join(root, "a-link"))
    await fsx.copy({ sourcePath: uri(path.join(root, "a-link")), destinationPath: uri(path.join(root, "a-link-copy")), recursive: false }, ctx)
    expect(await readlink(path.join(root, "a-link-copy"))).toBe("a.txt")
  })

  test("reports upstream errors for directories, descendants, special and missing sources", async () => {
    const { root, fsx } = await setup()
    const source = path.join(root, "source")
    await mkdir(path.join(source, "nested"), { recursive: true })
    await expect(fsx.copy({ sourcePath: uri(source), destinationPath: uri(path.join(root, "dest")), recursive: false }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "fs/copy requires recursive: true when sourcePath is a directory",
    })
    await expect(
      fsx.copy({ sourcePath: uri(source), destinationPath: uri(path.join(source, "nested", "copy")), recursive: true }, ctx),
    ).rejects.toMatchObject({ code: -32600, message: "fs/copy cannot copy a directory to itself or one of its descendants" })
    execFileSync("mkfifo", [path.join(root, "named-pipe")])
    await expect(
      fsx.copy({ sourcePath: uri(path.join(root, "named-pipe")), destinationPath: uri(path.join(root, "copied")), recursive: false }, ctx),
    ).rejects.toMatchObject({ code: -32600, message: "fs/copy only supports regular files, directories, and symlinks" })
    await expect(
      fsx.copy({ sourcePath: uri(path.join(root, "missing")), destinationPath: uri(path.join(root, "copied")), recursive: false }, ctx),
    ).rejects.toMatchObject(notFound)
  })

  test("rejects symlink escapes for sources, destinations, and nested destination links", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "secret.txt"), "outside")
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "source.txt"), "hello")
    await symlink(outside, path.join(root, "link"))
    const sandbox = sandboxFor(root, [pathEntry(root, "write")])
    await expect(
      fsx.copy({ sourcePath: uri(path.join(root, "source.txt")), destinationPath: uri(path.join(root, "link", "copied.txt")), recursive: false, sandbox }, ctx),
    ).rejects.toMatchObject(sandboxDenied)
    await expect(
      fsx.copy({ sourcePath: uri(path.join(root, "link", "secret.txt")), destinationPath: uri(path.join(root, "copied.txt")), recursive: false, sandbox }, ctx),
    ).rejects.toMatchObject(sandboxDenied)
    await expect(
      fsx.copy({ sourcePath: uri(path.join(root, "link", "secret.txt")), destinationPath: uri(path.join(root, "copied.txt")), recursive: false }, ctx),
    ).rejects.toMatchObject(outsideRoots)

    const source = path.join(root, "tree")
    await mkdir(path.join(source, "sub"), { recursive: true })
    await writeFile(path.join(source, "sub", "file.txt"), "inner")
    const destination = path.join(root, "dest")
    await mkdir(destination)
    await symlink(outside, path.join(destination, "sub"))
    await expect(fsx.copy({ sourcePath: uri(source), destinationPath: uri(destination), recursive: true }, ctx)).rejects.toMatchObject(outsideRoots)
    await expect(stat(path.join(outside, "copied.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(path.join(outside, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(path.join(root, "copied.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("containment", () => {
  test("paths outside the roots fail identically whether or not they exist", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "present.txt"), "outside")
    await mkdir(path.join(outside, "present-dir"))
    const { root, fsx, calls } = await setup()
    await symlink(outside, path.join(root, "link"))
    await symlink(path.join(outside, "missing.txt"), path.join(root, "dangling"))
    const targets = [
      path.join(outside, "present.txt"),
      path.join(outside, "missing.txt"),
      path.join(outside, "missing-dir", "x.txt"),
      path.join(root, "link", "present.txt"),
      path.join(root, "link", "missing.txt"),
    ]
    for (const target of targets) {
      const operations = [
        fsx.open({ handleId: "h", path: uri(target), mode: "read" }, ctx),
        fsx.open({ handleId: "h", path: uri(target), mode: "replace" }, ctx),
        fsx.createDirectory({ path: uri(target) }, ctx),
        fsx.createDirectory({ path: uri(target), recursive: false }, ctx),
        fsx.remove({ path: uri(target) }, ctx),
        fsx.remove({ path: uri(target), force: false }, ctx),
        fsx.walk({ path: uri(target), options: walkOptions() }, ctx),
        fsx.copy({ sourcePath: uri(target), destinationPath: uri(path.join(root, "copy.txt")), recursive: false }, ctx),
        fsx.copy({ sourcePath: uri(path.join(root, "link")), destinationPath: uri(target), recursive: true }, ctx),
      ]
      for (const result of await Promise.allSettled(operations)) {
        expect({ target, result }).toEqual({ target, result: { status: "rejected", reason: expect.objectContaining(outsideRoots) } })
      }
    }
    expect(calls).toEqual([])
    await expect(fsx.open({ handleId: "d", path: uri(path.join(root, "dangling")), mode: "replace" }, ctx)).rejects.toMatchObject(outsideRoots)
    await expect(stat(path.join(outside, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(path.join(outside, "present.txt"), "utf8")).toBe("outside")
  })

  test("a dangling symlink inside the roots is followed to its target inside the roots", async () => {
    const { root, fsx } = await setup()
    await mkdir(path.join(root, "dir"))
    await symlink(path.join(root, "dir", "created.txt"), path.join(root, "pointer"))
    await fsx.open({ handleId: "w", path: uri(path.join(root, "pointer")), mode: "replace" }, ctx)
    await fsx.writeBlock({ handleId: "w", offset: 0, chunk: bytes("through") }, ctx)
    await fsx.close({ handleId: "w" }, ctx)
    expect(await readFile(path.join(root, "dir", "created.txt"), "utf8")).toBe("through")
    expect((await lstat(path.join(root, "pointer"))).isSymbolicLink()).toBe(true)
  })
})

describe("swapping a path for a symlink during an operation", () => {
  async function swapped(build: (root: string, outside: string) => Promise<string>) {
    const outside = await tempRoot()
    let armed = true
    let directory = ""
    const harness = await setup({
      onAuthorize: async () => {
        if (!armed) return
        armed = false
        await rm(directory, { recursive: true, force: true })
        await symlink(outside, directory)
      },
    })
    directory = await build(harness.root, outside)
    return {
      ...harness,
      outside,
      directory,
      rearm: () => {
        armed = true
      },
    }
  }

  test("open for replacement does not truncate or write the swapped-in file", async () => {
    const { fsx, outside, directory } = await swapped(async (root, outside) => {
      await writeFile(path.join(outside, "data.bin"), "outside")
      await mkdir(path.join(root, "sub"))
      await writeFile(path.join(root, "sub", "data.bin"), "inside")
      return path.join(root, "sub")
    })
    await expect(fsx.open({ handleId: "w", path: uri(path.join(directory, "data.bin")), mode: "replace" }, ctx)).rejects.toMatchObject(outsideRoots)
    expect(await readFile(path.join(outside, "data.bin"), "utf8")).toBe("outside")
  })

  test("open for reading refuses a final component swapped for a symlink", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "secret.txt"), "secret")
    let target = ""
    const { root, fsx } = await setup({
      onAuthorize: async () => {
        await rm(target)
        await symlink(path.join(outside, "secret.txt"), target)
      },
    })
    target = path.join(root, "public.txt")
    await writeFile(target, "public")
    await expect(fsx.open({ handleId: "r", path: uri(target), mode: "read" }, ctx)).rejects.toMatchObject(symlinkLoop)
  })

  test("remove, createDirectory, copy, and walk fail closed without touching the swapped-in directory", async () => {
    const remove = await swapped(async (root, outside) => {
      await writeFile(path.join(outside, "victim.txt"), "keep")
      await mkdir(path.join(root, "dir"))
      await writeFile(path.join(root, "dir", "victim.txt"), "inside")
      return path.join(root, "dir")
    })
    for (const options of [{}, { recursive: false, force: false, followSymlinks: false }]) {
      const result = remove.fsx.remove({ path: uri(path.join(remove.directory, "victim.txt")), ...options }, ctx)
      await expect(result).rejects.toMatchObject("followSymlinks" in options ? symlinkLoop : outsideRoots)
      expect(await readFile(path.join(remove.outside, "victim.txt"), "utf8")).toBe("keep")
      await rm(remove.directory)
      await mkdir(remove.directory)
      await writeFile(path.join(remove.directory, "victim.txt"), "inside")
      remove.rearm()
    }

    for (const recursive of [true, false]) {
      const create = await swapped(async (root) => {
        await mkdir(path.join(root, "parent"))
        return path.join(root, "parent")
      })
      await expect(create.fsx.createDirectory({ path: uri(path.join(create.directory, "new")), recursive }, ctx)).rejects.toMatchObject(outsideRoots)
      await expect(stat(path.join(create.outside, "new"))).rejects.toMatchObject({ code: "ENOENT" })
    }

    const copy = await swapped(async (root) => {
      await writeFile(path.join(root, "source.txt"), "payload")
      await mkdir(path.join(root, "dest"))
      return path.join(root, "dest")
    })
    await expect(
      copy.fsx.copy({ sourcePath: uri(path.join(copy.root, "source.txt")), destinationPath: uri(path.join(copy.directory, "out.txt")), recursive: false }, ctx),
    ).rejects.toMatchObject(outsideRoots)
    await expect(stat(path.join(copy.outside, "out.txt"))).rejects.toMatchObject({ code: "ENOENT" })

    const walk = await swapped(async (root, outside) => {
      await writeFile(path.join(outside, "outside-name.txt"), "x")
      await mkdir(path.join(root, "tree"))
      return path.join(root, "tree")
    })
    await expect(walk.fsx.walk({ path: uri(walk.directory), options: walkOptions({ followDirectorySymlinks: true }) }, ctx)).rejects.toMatchObject(
      outsideRoots,
    )
  })
})

describe("fs block edges and cleanup failures", () => {
  test("reads at the i64 and 2^53 offset edges reach EOF without closing the handle", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "edges.bin")
    await writeFile(file, "data")
    await fsx.open({ handleId: "r", path: uri(file), mode: "read" }, ctx)
    for (const [offset, len] of [
      [2 ** 63 - 1024, 2048],
      [2 ** 63 - 1024, 1],
      [Number.MAX_SAFE_INTEGER, 1],
      [2 ** 53 + 2, CcaFsExtended.FILE_READ_CHUNK_SIZE],
    ]) {
      const block = await fsx.readBlock({ handleId: "r", offset, len }, ctx)
      expect({ offset, chunk: block.chunk.byteLength, eof: block.eof }).toEqual({ offset, chunk: 0, eof: true })
    }
    expect(text((await fsx.readBlock({ handleId: "r", offset: 0, len: 4 }, ctx)).chunk)).toBe("data")
    await expect(fsx.readBlock({ handleId: "r", offset: 2 ** 64, len: 1 }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "Invalid argument (os error 22)",
    })
    await expect(fsx.readBlock({ handleId: "r", offset: 0, len: 1 }, ctx)).rejects.toMatchObject({ code: -32004 })
  })

  test("writes past the largest exact offset are rejected without closing the handle", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "write-edges.bin")
    await fsx.open({ handleId: "w", path: uri(file), mode: "replace" }, ctx)
    const inexact = { code: -32600, message: `file block range exceeds the largest exact offset ${Number.MAX_SAFE_INTEGER}` }
    await expect(fsx.writeBlock({ handleId: "w", offset: Number.MAX_SAFE_INTEGER, chunk: bytes("x") }, ctx)).rejects.toMatchObject(inexact)
    await expect(fsx.writeBlock({ handleId: "w", offset: Number.MAX_SAFE_INTEGER - 1, chunk: bytes("xy") }, ctx)).rejects.toMatchObject(inexact)
    await expect(fsx.writeBlock({ handleId: "w", offset: 2 ** 63 - 1024, chunk: new Uint8Array(1024) }, ctx)).rejects.toMatchObject({
      code: -32600,
      message: "file write range exceeds the signed 64-bit file offset limit",
    })
    expect(await fsx.writeBlock({ handleId: "w", offset: 0, chunk: bytes("ok") }, ctx)).toEqual({})
    expect(await readFile(file, "utf8")).toBe("ok")
  })

  test("a handle ID can be reused after close and then names the new file", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "first.txt"), "first")
    await writeFile(path.join(root, "second.txt"), "second")
    await fsx.open({ handleId: "h", path: uri(path.join(root, "first.txt")), mode: "read" }, ctx)
    await fsx.close({ handleId: "h" }, ctx)
    await fsx.open({ handleId: "h", path: uri(path.join(root, "second.txt")), mode: "read" }, ctx)
    expect(text((await fsx.readBlock({ handleId: "h", offset: 0, len: 16 }, ctx)).chunk)).toBe("second")
  })

  test("a write that fails part-way reports the OS error and keeps the handle open", async () => {
    const { root, fsx } = await setup()
    const file = path.join(root, "partial.bin")
    const probe = await fsOpen(file, "w")
    const prototype: object = Reflect.getPrototypeOf(probe) ?? probe
    await probe.close()
    await fsx.open({ handleId: "w", path: uri(file), mode: "replace" }, ctx)
    const original: unknown = Reflect.get(prototype, "write")
    if (typeof original !== "function") throw new Error("FileHandle.write is unavailable")
    let calls = 0
    Reflect.set(prototype, "write", function (this: unknown, buffer: unknown, offset: number, _length: number, position: number) {
      calls++
      if (calls === 1) return Reflect.apply(original, this, [buffer, offset, 3, position])
      return Promise.reject(Object.assign(new Error("EIO: i/o error, write"), { code: "EIO", errno: -5 }))
    })
    try {
      await expect(fsx.writeBlock({ handleId: "w", offset: 0, chunk: bytes("abcdef") }, ctx)).rejects.toMatchObject({
        code: -32603,
        message: "Input/output error (os error 5)",
      })
    } finally {
      Reflect.set(prototype, "write", original)
    }
    expect(await readFile(file, "utf8")).toBe("abc")
    expect(await fsx.writeBlock({ handleId: "w", offset: 3, chunk: bytes("def") }, ctx)).toEqual({})
    expect(await readFile(file, "utf8")).toBe("abcdef")
  })

  test("a failed grant release fails the operation after its effect and fails shutdown after close", async () => {
    const { root, fsx, released, shutdown } = await setup({ failRelease: true })
    await expect(fsx.createDirectory({ path: uri(path.join(root, "made")) }, ctx)).rejects.toMatchObject({ code: -32603, message: "Internal error" })
    expect((await stat(path.join(root, "made"))).isDirectory()).toBe(true)
    await writeFile(path.join(root, "f.txt"), "x")
    await fsx.open({ handleId: "h", path: uri(path.join(root, "f.txt")), mode: "read" }, ctx)
    expect(await fsx.close({ handleId: "h" }, ctx)).toEqual({})
    expect(released()).toBe(2)
    await expect(shutdown()).rejects.toMatchObject({ code: -32603, message: "Internal error" })
  })
})

describe("fs/copy destinations", () => {
  test("copying onto an existing file replaces its contents", async () => {
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "short.txt"), "hello")
    await writeFile(path.join(root, "long.txt"), "a much longer original")
    await fsx.copy({ sourcePath: uri(path.join(root, "short.txt")), destinationPath: uri(path.join(root, "long.txt")), recursive: false }, ctx)
    expect(await readFile(path.join(root, "long.txt"), "utf8")).toBe("hello")
    await fsx.copy({ sourcePath: uri(path.join(root, "short.txt")), destinationPath: uri(path.join(root, "short.txt")), recursive: false }, ctx)
    expect(await readFile(path.join(root, "short.txt"), "utf8")).toBe("hello")
  })

  test("a symlinked destination is written through inside the roots and refused outside them", async () => {
    const outside = await tempRoot()
    await writeFile(path.join(outside, "target.txt"), "outside")
    const { root, fsx } = await setup()
    await writeFile(path.join(root, "source.txt"), "payload")
    await writeFile(path.join(root, "inside-target.txt"), "old")
    await symlink(path.join(root, "inside-target.txt"), path.join(root, "inside-link"))
    await symlink(path.join(outside, "target.txt"), path.join(root, "outside-link"))
    await symlink(path.join(outside, "created.txt"), path.join(root, "dangling-link"))
    const source = uri(path.join(root, "source.txt"))
    await fsx.copy({ sourcePath: source, destinationPath: uri(path.join(root, "inside-link")), recursive: false }, ctx)
    expect(await readFile(path.join(root, "inside-target.txt"), "utf8")).toBe("payload")
    expect((await lstat(path.join(root, "inside-link"))).isSymbolicLink()).toBe(true)
    for (const name of ["outside-link", "dangling-link"]) {
      await expect(fsx.copy({ sourcePath: source, destinationPath: uri(path.join(root, name)), recursive: false }, ctx)).rejects.toMatchObject(outsideRoots)
    }
    expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside")
    await expect(stat(path.join(outside, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("CcaPolicy.resolveContained canonicalization failures", () => {
  async function rejection(promise: Promise<unknown>) {
    try {
      await promise
    } catch (error) {
      if (error instanceof CcaPolicy.PolicyError) return { code: error.code, message: error.message }
      throw error
    }
    throw new Error("expected rejection")
  }

  async function locked(parent: string) {
    const directory = path.join(parent, "locked")
    await mkdir(path.join(directory, "sub"), { recursive: true })
    await writeFile(path.join(directory, "file.txt"), "x")
    await chmod(directory, 0o000)
    cleanups.push(() => chmod(directory, 0o700))
    return directory
  }

  const outside: { code: CcaPolicy.ErrorCode; message: string } = { code: "outside_roots", message: "path is outside the allowed roots" }

  test("a failure inside the roots carries the OS error text", async () => {
    const root = await tempRoot()
    const directory = await locked(root)
    const denied: { code: CcaPolicy.ErrorCode; message: string } = { code: "invalid_path", message: "Permission denied (os error 13)" }
    for (const allowMissingFinal of [false, true]) {
      for (const name of ["file.txt", "missing.txt", "sub/x"]) {
        expect(await rejection(CcaPolicy.resolveContained(path.join(directory, name), [root], { allowMissingFinal }))).toEqual(denied)
      }
    }
  })

  test("a failure outside the roots answers like any outside path, whether or not it exists", async () => {
    const root = await tempRoot()
    const elsewhere = await tempRoot()
    const directory = await locked(elsewhere)
    await writeFile(path.join(elsewhere, "plain.txt"), "x")
    await symlink(directory, path.join(root, "to-locked"))
    await symlink(path.join(directory, "sub"), path.join(root, "into-locked"))
    const targets = [
      path.join(elsewhere, "plain.txt"),
      path.join(directory, "file.txt"),
      path.join(directory, "missing.txt"),
      path.join(root, "to-locked", "file.txt"),
      path.join(root, "to-locked", "missing.txt"),
      path.join(root, "into-locked", "x"),
    ]
    for (const target of targets) {
      for (const allowMissingFinal of [false, true]) {
        expect({ target, error: await rejection(CcaPolicy.resolveContained(target, [root], { allowMissingFinal })) }).toEqual({ target, error: outside })
      }
    }
  })
})
