export * as CcaFsExtended from "./fs-extended"

import { constants, type BigIntStats } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  CcaExecutorError,
  type CcaAuthorizationGrant,
  type CcaAuthorizationInput,
  type CcaRpcHandlerContext,
} from "./errors"
import { CcaPolicy } from "./policy"

export const FILE_READ_CHUNK_SIZE = 1024 * 1024
export const FILE_WRITE_CHUNK_SIZE = 1024 * 1024
export const MAX_OPEN_FILES = 128
export const MAX_FILE_HANDLE_ID_BYTES = 32
export const MAX_WALK_DEPTH = 64
export const MAX_WALK_DIRECTORIES = 10_000
export const MAX_WALK_ENTRIES = 50_000
export const MAX_WALK_RESPONSE_BYTES = 4 * 1024 * 1024
export const WALK_RESPONSE_ITEM_OVERHEAD_BYTES = 64

export type EmptyResult = Record<string, never>

export interface CreateDirectoryParams {
  readonly path: string
  readonly recursive?: boolean
  readonly followSymlinks?: boolean
  readonly sandbox?: unknown
}

export type OpenMode = "read" | "replace"

export interface OpenParams {
  readonly handleId: string
  readonly path: string
  readonly mode: OpenMode
  readonly sandbox?: unknown
}

export interface OpenResult {
  readonly handleId: string
}

export interface ReadBlockParams {
  readonly handleId: string
  readonly offset: number
  readonly len: number
}

export interface ReadBlockResult {
  readonly chunk: Uint8Array
  readonly eof: boolean
}

export interface WriteBlockParams {
  readonly handleId: string
  readonly offset: number
  readonly chunk: Uint8Array
}

export interface CloseParams {
  readonly handleId: string
}

export interface WalkOptions {
  readonly maxDepth: number
  readonly maxDirectories: number
  readonly maxEntries: number
  readonly followDirectorySymlinks: boolean
  readonly pruneHiddenDirectories?: boolean
}

export interface WalkParams {
  readonly path: string
  readonly options: WalkOptions
  readonly sandbox?: unknown
}

export interface WalkEntry {
  readonly path: string
  readonly kind: "directory" | "file"
}

export interface WalkError {
  readonly path: string
  readonly message: string
}

export interface WalkResult {
  readonly entries: readonly WalkEntry[]
  readonly errors: readonly WalkError[]
  readonly truncated: boolean
}

export interface RemoveParams {
  readonly path: string
  readonly recursive?: boolean
  readonly force?: boolean
  readonly followSymlinks?: boolean
  readonly sandbox?: unknown
}

export interface CopyParams {
  readonly sourcePath: string
  readonly destinationPath: string
  readonly recursive: boolean
  readonly sandbox?: unknown
}

export interface Options {
  readonly roots: readonly string[]
  readonly authorize: (input: CcaAuthorizationInput) => Promise<CcaAuthorizationGrant>
  readonly temporaryDirectories: () => readonly string[]
}

type Handler<P, R> = (params: P, ctx: CcaRpcHandlerContext) => Promise<R>

export interface Handlers {
  readonly createDirectory: Handler<CreateDirectoryParams, EmptyResult>
  readonly open: Handler<OpenParams, OpenResult>
  readonly readBlock: Handler<ReadBlockParams, ReadBlockResult>
  readonly writeBlock: Handler<WriteBlockParams, EmptyResult>
  readonly close: Handler<CloseParams, EmptyResult>
  readonly walk: Handler<WalkParams, WalkResult>
  readonly remove: Handler<RemoveParams, EmptyResult>
  readonly copy: Handler<CopyParams, EmptyResult>
  readonly shutdown: () => Promise<void>
}

const I64_MAX = 2n ** 63n - 1n
const MAX_SYMLINK_HOPS = 40
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function kindCode(errno: string): number {
  if (errno === "ENOENT") return -32004
  if (errno === "EACCES" || errno === "EPERM" || errno === "EINVAL") return -32600
  return -32603
}

function osErrorFor(errno: string): CcaExecutorError {
  const number = (os.constants.errno as Record<string, number | undefined>)[errno]
  return new CcaExecutorError(kindCode(errno), CcaPolicy.osErrorMessage(errno, number ?? 0))
}

function osError(err: unknown): CcaExecutorError {
  if (err instanceof CcaExecutorError) return err
  if (err instanceof CcaPolicy.PolicyError) return new CcaExecutorError(-32602, err.message)
  const code = property(err, "code")
  const errno = property(err, "errno")
  if (typeof code !== "string" || typeof errno !== "number") {
    return new CcaExecutorError(-32603, "Filesystem error")
  }
  return new CcaExecutorError(kindCode(code), CcaPolicy.osErrorMessage(code, Math.abs(errno), property(err, "message")))
}

class OutsideRootsError extends CcaExecutorError {}

const outsideRoots = () => new OutsideRootsError(-32600, osErrorFor("EPERM").message)
const invalidInput = (message: string) => new CcaExecutorError(-32600, message)
const otherError = (message: string) => new CcaExecutorError(-32603, message)
const sandboxDenied = () => new CcaExecutorError(-32600, "Permission denied")
const walkCancelled = () => otherError("filesystem walk cancelled")
const isNotFound = (err: unknown) => err instanceof CcaExecutorError && err.code === -32004
const errnoOf = (err: unknown) => property(err, "code")

function permits(access: CcaPolicy.SandboxAccess, need: "read" | "write"): boolean {
  return access === "write" || (need === "read" && access === "read")
}

function checkHandleId(handleId: string): void {
  if (Buffer.byteLength(handleId) > MAX_FILE_HANDLE_ID_BYTES) {
    throw invalidInput(`file handle ID must not exceed ${MAX_FILE_HANDLE_ID_BYTES} bytes`)
  }
}

function checkRepresentable(offset: number, length: number): void {
  if (offset + length > Number.MAX_SAFE_INTEGER) {
    throw invalidInput(`file block range exceeds the largest exact offset ${Number.MAX_SAFE_INTEGER}`)
  }
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

function joinUnnormalized(base: string, relative: string): string {
  if (path.isAbsolute(relative)) return relative
  return base.endsWith(path.sep) ? base + relative : base + path.sep + relative
}

async function lstatIfPresent(target: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(target, { bigint: true })
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return undefined
    throw err
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let written = 0
  while (written < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, written, bytes.byteLength - written, position + written)
    if (bytesWritten === 0) throw otherError("failed to write file block")
    written += bytesWritten
  }
}

async function withGrant<T>(grant: CcaAuthorizationGrant, fn: () => Promise<T>): Promise<T> {
  let result: T
  try {
    result = await fn()
  } catch (err) {
    await grant.release().catch(() => undefined)
    throw osError(err)
  }
  try {
    await grant.release()
  } catch {
    throw otherError("Internal error")
  }
  return result
}

interface Scope {
  readonly sandbox: CcaPolicy.SandboxPolicy | undefined
  readonly confined: boolean
}

interface Pin {
  readonly path: string
  readonly real: string
  readonly dev: bigint
  readonly ino: bigint
  readonly directory: boolean
}

function pinOf(canonical: string, stats: BigIntStats): Pin {
  return { path: canonical, real: canonical, dev: stats.dev, ino: stats.ino, directory: stats.isDirectory() }
}

async function pin(target: string, stats?: BigIntStats): Promise<Pin> {
  try {
    const [current, real] = await Promise.all([stats ?? fs.lstat(target, { bigint: true }), fs.realpath(target)])
    return { path: target, real, dev: current.dev, ino: current.ino, directory: current.isDirectory() }
  } catch (err) {
    throw osError(err)
  }
}

async function recheck(expected: Pin): Promise<void> {
  const stable = await Promise.all([fs.lstat(expected.path, { bigint: true }), fs.realpath(expected.path)]).then(
    ([stats, real]) => stats.dev === expected.dev && stats.ino === expected.ino && real === expected.real,
    () => false,
  )
  if (!stable) throw outsideRoots()
}

async function openVerified(target: string, flags: number, mode?: number): Promise<FileHandle> {
  const file = await fs.open(target, flags | NOFOLLOW | NONBLOCK, mode)
  try {
    await recheck(pinOf(target, await file.stat({ bigint: true })))
    return file
  } catch (err) {
    await file.close().catch(() => undefined)
    throw err
  }
}

interface FileEntry {
  readonly file: FileHandle
  readonly grant: CcaAuthorizationGrant
  inflight: number
  detached: boolean
  finalized?: Promise<void>
  readonly done: Promise<void>
  readonly resolveDone: () => void
}

export function create(options: Options): Handlers {
  const roots = options.roots
  if (roots.length === 0) throw new CcaExecutorError(-32602, "at least one containing root is required")

  let closed = false
  let cleanupFailed = false
  let reserved = 0
  const files = new Map<string, FileEntry>()
  const live = new Set<FileEntry>()

  const checkNotClosed = () => {
    if (closed) throw otherError("Executor session closed")
  }

  const parse = (uri: string) => {
    try {
      return CcaPolicy.parsePathUri(uri)
    } catch (err) {
      throw osError(err)
    }
  }

  const scopeFor = async (sandbox: unknown): Promise<Scope> => {
    let policy: CcaPolicy.SandboxPolicy | undefined
    try {
      policy = await CcaPolicy.resolveSandbox({ sandbox }, { temporaryDirectories: options.temporaryDirectories() })
    } catch (err) {
      throw osError(err)
    }
    return { sandbox: policy, confined: policy?.fileSystem === "restricted" }
  }

  const guard = async <T>(scope: Scope, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      const boundary = err instanceof OutsideRootsError || (err instanceof CcaExecutorError && err.code === -32602)
      if (scope.confined && boundary) throw sandboxDenied()
      throw err
    }
  }

  const checkAccess = (scope: Scope, canonical: string, requested: string, need: "read" | "write") => {
    if (scope.confined && !permits(scope.sandbox!.access(canonical, requested), need)) throw sandboxDenied()
  }

  const authorizeIn = async (scope: Scope, action: string, resources: readonly string[]): Promise<CcaAuthorizationGrant> => {
    const denied = () => (scope.confined ? sandboxDenied() : new CcaExecutorError(-32001, "Permission denied"))
    let grant: CcaAuthorizationGrant
    try {
      grant = await options.authorize({ action, resources, metadata: scope.sandbox?.metadata })
    } catch {
      throw denied()
    }
    if (!grant || typeof grant.release !== "function") throw denied()
    return grant
  }

  const canonicalRoots = async (): Promise<string[]> => {
    try {
      return await Promise.all(roots.map((root) => fs.realpath(root)))
    } catch {
      throw new CcaExecutorError(-32602, "containing root cannot be canonicalized")
    }
  }

  const deepestExisting = async (target: string) => {
    const rest: string[] = []
    let failure: unknown
    for (let current = target; ; current = path.dirname(current)) {
      try {
        return { existing: await fs.realpath(current), rest, failure }
      } catch (err) {
        failure = err
        rest.unshift(path.basename(current))
      }
    }
  }

  const contained = async (native: string, allowMissing: boolean): Promise<string> => {
    const realRoots = await canonicalRoots()
    let pending = native
    for (let hops = 0; ; hops++) {
      const { existing, rest, failure } = await deepestExisting(pending)
      if (!realRoots.some((root) => within(existing, root))) throw outsideRoots()
      if (rest.length === 0) return existing
      const child = path.join(existing, rest[0])
      const link = await fs.lstat(child).then(
        (stats) => stats.isSymbolicLink(),
        () => false,
      )
      if (link) {
        if (hops === MAX_SYMLINK_HOPS) throw osErrorFor("ELOOP")
        pending = [joinUnnormalized(existing, await fs.readlink(child)), ...rest.slice(1)].join(path.sep)
        continue
      }
      if (allowMissing && errnoOf(failure) === "ENOENT" && !rest.some((part) => part === "." || part === "..")) {
        return path.join(existing, ...rest)
      }
      throw osError(failure)
    }
  }

  const entryPath = async (native: string, allowMissingParent: boolean): Promise<string> => {
    const parent = path.dirname(native)
    if (parent === native) return contained(native, false)
    return path.join(await contained(parent, allowMissingParent), path.basename(native))
  }

  const finalize = (entry: FileEntry): Promise<void> => {
    entry.finalized ??= (async () => {
      try {
        await entry.file.close()
      } catch {
        cleanupFailed = true
      }
      try {
        await entry.grant.release()
      } catch {
        cleanupFailed = true
      }
      live.delete(entry)
      entry.resolveDone()
    })()
    return entry.finalized
  }

  const detach = (handleId: string, entry: FileEntry): Promise<void> => {
    if (files.get(handleId) === entry) files.delete(handleId)
    entry.detached = true
    return entry.inflight === 0 ? finalize(entry) : entry.done
  }

  const use = async <T>(entry: FileEntry, fn: (file: FileHandle) => Promise<T>): Promise<T> => {
    entry.inflight++
    try {
      return await fn(entry.file)
    } finally {
      entry.inflight--
      if (entry.detached && entry.inflight === 0) void finalize(entry)
    }
  }

  const lookup = (handleId: string): FileEntry => {
    const entry = files.get(handleId)
    if (entry === undefined) throw new CcaExecutorError(-32004, `unknown file handle \`${handleId}\``)
    return entry
  }

  const openRegular = async (target: string, requested: string, mode: OpenMode, parent: Pin): Promise<FileHandle> => {
    const flags = mode === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT
    let file: FileHandle
    try {
      await recheck(parent)
      file = await openVerified(target, flags, 0o666)
    } catch (err) {
      throw osError(err)
    }
    let failure: CcaExecutorError | undefined
    try {
      if (!(await file.stat()).isFile()) failure = invalidInput(`path \`${requested}\` is not a file`)
      else if (mode === "replace") await file.truncate(0)
    } catch (err) {
      failure = osError(err)
    }
    if (failure === undefined) return file
    await file.close().catch(() => undefined)
    throw failure
  }

  const open: Handlers["open"] = async (params) => {
    checkNotClosed()
    checkHandleId(params.handleId)
    if (files.has(params.handleId)) throw invalidInput(`file handle \`${params.handleId}\` already exists`)
    if (files.size + reserved >= MAX_OPEN_FILES) {
      throw invalidInput(`at most ${MAX_OPEN_FILES} file handles may be open per connection`)
    }
    reserved++
    let file: FileHandle
    let grant: CcaAuthorizationGrant
    try {
      const native = parse(params.path)
      const scope = await scopeFor(params.sandbox)
      const need = params.mode === "read" ? "read" : "write"
      const target = await guard(scope, () => contained(native, params.mode === "replace"))
      const parent = await pin(path.dirname(target))
      checkAccess(scope, target, native, need)
      grant = await authorizeIn(scope, params.mode === "read" ? "read" : "edit", [target])
      try {
        file = await openRegular(target, native, params.mode, parent)
      } catch (err) {
        await grant.release().catch(() => {
          cleanupFailed = true
        })
        throw err
      }
    } finally {
      reserved--
    }
    const rejection = closed
      ? otherError("Executor session closed")
      : files.has(params.handleId)
        ? invalidInput(`file handle \`${params.handleId}\` already exists`)
        : undefined
    if (rejection !== undefined) {
      await file.close().catch(() => {
        cleanupFailed = true
      })
      await grant.release().catch(() => {
        cleanupFailed = true
      })
      throw rejection
    }
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    const entry: FileEntry = { file, grant, inflight: 0, detached: false, done, resolveDone }
    files.set(params.handleId, entry)
    live.add(entry)
    return { handleId: params.handleId }
  }

  const readBlock: Handlers["readBlock"] = async (params) => {
    checkNotClosed()
    checkHandleId(params.handleId)
    if (!(params.len >= 1 && params.len <= FILE_READ_CHUNK_SIZE)) {
      throw invalidInput(`file read block length must be between 1 and ${FILE_READ_CHUNK_SIZE}`)
    }
    const entry = lookup(params.handleId)
    return use(entry, async (file) => {
      const buffer = Buffer.alloc(params.len)
      let total = 0
      try {
        while (total < params.len) {
          const position = BigInt(params.offset) + BigInt(total)
          if (position > I64_MAX) throw osErrorFor("EINVAL")
          const length = Math.min(params.len - total, Number(I64_MAX - position))
          if (length === 0) break
          const { bytesRead } = await file.read(buffer, total, length, position)
          if (bytesRead === 0) break
          total += bytesRead
        }
      } catch (err) {
        void detach(params.handleId, entry)
        throw osError(err)
      }
      return { chunk: buffer.subarray(0, total), eof: total < params.len }
    })
  }

  const writeBlock: Handlers["writeBlock"] = async (params) => {
    checkNotClosed()
    checkHandleId(params.handleId)
    const length = params.chunk.byteLength
    if (length < 1 || length > FILE_WRITE_CHUNK_SIZE) {
      throw invalidInput(`file write block length must be between 1 and ${FILE_WRITE_CHUNK_SIZE}`)
    }
    if (BigInt(params.offset) + BigInt(length) > I64_MAX) {
      throw invalidInput("file write range exceeds the signed 64-bit file offset limit")
    }
    checkRepresentable(params.offset, length)
    const entry = lookup(params.handleId)
    return use(entry, async (file) => {
      try {
        await writeAll(file, params.chunk, params.offset)
      } catch (err) {
        throw osError(err)
      }
      return {}
    })
  }

  const close: Handlers["close"] = async (params) => {
    checkNotClosed()
    checkHandleId(params.handleId)
    const entry = files.get(params.handleId)
    if (entry !== undefined) {
      const pending = detach(params.handleId, entry)
      if (entry.inflight === 0) await pending
    }
    return {}
  }

  const makeDirectory = async (target: string, recursive: boolean, follow: boolean): Promise<void> => {
    const { root } = path.parse(target)
    const components = target.slice(root.length).split(path.sep).filter((part) => part !== "")
    if (components.length === 0) {
      if (!recursive) throw otherError("directory already exists")
      return
    }
    let current = await pin(root)
    for (const [index, component] of components.entries()) {
      const next = path.join(current.path, component)
      const leaf = index === components.length - 1
      if (!recursive && leaf) {
        await recheck(current)
        await fs.mkdir(next)
        return
      }
      let stats = await lstatIfPresent(next)
      if (stats === undefined) {
        if (!recursive) throw osErrorFor("ENOENT")
        await recheck(current)
        await fs.mkdir(next).catch((err: unknown) => {
          if (errnoOf(err) !== "EEXIST") throw err
        })
        stats = await fs.lstat(next, { bigint: true })
      }
      if (stats.isSymbolicLink()) throw follow ? outsideRoots() : osErrorFor("ELOOP")
      if (!stats.isDirectory()) throw osErrorFor(follow && leaf ? "EEXIST" : "ENOTDIR")
      current = await pin(next, stats)
    }
  }

  const createDirectory: Handlers["createDirectory"] = async (params) => {
    checkNotClosed()
    const recursive = params.recursive ?? true
    const follow = params.followSymlinks !== false
    const native = parse(params.path)
    const scope = await scopeFor(params.sandbox)
    const target = await guard(scope, () => contained(native, true))
    checkAccess(scope, target, native, "write")
    const grant = await authorizeIn(scope, "edit", [target])
    return withGrant(grant, async () => {
      await makeDirectory(follow ? target : native, recursive, follow)
      return {}
    })
  }

  const walk: Handlers["walk"] = async (params, ctx) => {
    checkNotClosed()
    const walkOptions = params.options
    if (walkOptions.maxDirectories === 0 || walkOptions.maxEntries === 0) {
      throw invalidInput("filesystem walk limits must be greater than zero")
    }
    if (
      walkOptions.maxDepth > MAX_WALK_DEPTH ||
      walkOptions.maxDirectories > MAX_WALK_DIRECTORIES ||
      walkOptions.maxEntries > MAX_WALK_ENTRIES
    ) {
      throw invalidInput(
        `filesystem walk limits exceed maximums: depth=${MAX_WALK_DEPTH}, directories=${MAX_WALK_DIRECTORIES}, entries=${MAX_WALK_ENTRIES}`,
      )
    }
    const native = parse(params.path)
    const scope = await scopeFor(params.sandbox)
    const target = await guard(scope, () => contained(native, false))
    const root = await pin(target)
    checkAccess(scope, target, native, "read")
    const grant = await authorizeIn(scope, "read", [target])
    return withGrant(grant, () => walkTree(native, root, walkOptions, scope, ctx.signal))
  }

  const walkTree = async (
    native: string,
    root: Pin,
    walkOptions: WalkOptions,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<WalkResult> => {
    const follow = walkOptions.followDirectorySymlinks
    const checkCancelled = () => {
      if (signal.aborted) throw walkCancelled()
    }
    const entries: WalkEntry[] = []
    const errors: WalkError[] = []
    let truncated = false
    let responseBytes = 0
    const result = () => ({ entries, errors, truncated })
    const reserve = (contentBytes: number) => {
      const total = responseBytes + contentBytes + WALK_RESPONSE_ITEM_OVERHEAD_BYTES
      if (total > MAX_WALK_RESPONSE_BYTES) {
        truncated = true
        return false
      }
      responseBytes = total
      return true
    }
    const pushError = (uri: string, message: string) => {
      if (!reserve(Buffer.byteLength(uri) + Buffer.byteLength(message))) return false
      errors.push({ path: uri, message })
      return true
    }

    checkCancelled()
    await recheck(root)
    const rootLink = (await fs.lstat(native)).isSymbolicLink()
    if (!root.directory || (rootLink && !follow)) return result()

    const queue: Array<{ readonly display: string; readonly pin: Pin; readonly depth: number }> = [
      { display: native, pin: root, depth: 0 },
    ]
    const visited = new Set([root.path])
    let directories = 1
    let examined = 0

    while (queue.length > 0) {
      const directory = queue.shift()!
      const directoryUri = CcaPolicy.toPathUri(directory.display)
      let names: string[]
      try {
        await recheck(directory.pin)
        names = await readNames(directory.pin.path, checkCancelled)
        await recheck(directory.pin)
      } catch (err) {
        checkCancelled()
        if (!pushError(directoryUri, osError(err).message)) return result()
        continue
      }
      checkCancelled()
      names.sort(compareBytes)

      for (const name of names) {
        checkCancelled()
        if (examined === walkOptions.maxEntries) {
          truncated = true
          return result()
        }
        examined++
        const display = path.join(directory.display, name)
        const real = path.join(directory.pin.path, name)
        let uri: string
        try {
          uri = CcaPolicy.toPathUri(display)
        } catch (err) {
          if (!pushError(directoryUri, osError(err).message)) return result()
          continue
        }
        if (scope.confined && !permits(scope.sandbox!.access(real, display), "read")) {
          if (!pushError(uri, osErrorFor("EACCES").message)) return result()
          continue
        }
        let stats: BigIntStats
        let resolved = real
        try {
          stats = await fs.lstat(real, { bigint: true })
          if (stats.isSymbolicLink()) {
            if (!follow) continue
            resolved = await contained(real, false)
            stats = await fs.stat(resolved, { bigint: true })
          }
        } catch (err) {
          if (!pushError(uri, osError(err).message)) return result()
          continue
        }
        const link = resolved !== real
        if (link && !stats.isDirectory()) continue
        const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined
        if (kind === undefined) continue
        if (!reserve(Buffer.byteLength(uri))) return result()
        entries.push({ path: uri, kind })

        if (kind !== "directory" || directory.depth >= walkOptions.maxDepth) continue
        if (walkOptions.pruneHiddenDirectories === true && name.startsWith(".")) continue
        if (link && scope.confined && !permits(scope.sandbox!.access(resolved, display), "read")) {
          if (!pushError(uri, osErrorFor("EACCES").message)) return result()
          continue
        }
        if (visited.has(resolved)) continue
        visited.add(resolved)
        if (directories === walkOptions.maxDirectories) {
          truncated = true
          continue
        }
        directories++
        queue.push({ display, pin: pinOf(resolved, stats), depth: directory.depth + 1 })
      }
    }
    return result()
  }

  const readNames = async (directory: string, checkCancelled: () => void): Promise<string[]> => {
    checkCancelled()
    const names: string[] = []
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      checkCancelled()
      if (dirent.isSymbolicLink()) {
        const listed = await contained(path.join(directory, dirent.name), false).then(
          () => true,
          (err: unknown) => err instanceof OutsideRootsError,
        )
        if (!listed) continue
      }
      names.push(dirent.name)
    }
    return names
  }

  const remove: Handlers["remove"] = async (params) => {
    checkNotClosed()
    const recursive = params.recursive ?? true
    const force = params.force ?? true
    const native = parse(params.path)
    const scope = await scopeFor(params.sandbox)
    let target: string
    let parent: Pin
    try {
      target = await guard(scope, () => entryPath(native, false))
      parent = await pin(path.dirname(target))
    } catch (err) {
      if (force && isNotFound(err)) return {}
      throw err
    }
    checkAccess(scope, target, native, "write")
    const grant = await authorizeIn(scope, "edit", [target])
    return withGrant(grant, async () => {
      if (params.followSymlinks === false) {
        await removeNoFollow(native, recursive, force)
        return {}
      }
      await recheck(parent)
      const stats = await lstatIfPresent(target)
      if (stats === undefined) {
        if (force) return {}
        throw osErrorFor("ENOENT")
      }
      if (stats.isDirectory() && recursive) {
        if (scope.confined) await assertTreeWritable(scope, target)
        await removeTree(target, parent)
        return {}
      }
      await recheck(parent)
      if (stats.isDirectory()) await fs.rmdir(target)
      else await fs.unlink(target)
      return {}
    })
  }

  const assertTreeWritable = async (scope: Scope, directory: string): Promise<void> => {
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, dirent.name)
      checkAccess(scope, child, child, "write")
      if (dirent.isDirectory()) await assertTreeWritable(scope, child)
    }
  }

  const removeTree = async (directory: string, parent: Pin): Promise<void> => {
    await recheck(parent)
    const own = await pin(directory)
    if (!own.directory) throw outsideRoots()
    for (const dirent of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, dirent.name)
      await recheck(own)
      if (dirent.isDirectory()) await removeTree(child, own)
      else await fs.unlink(child)
    }
    await recheck(parent)
    await fs.rmdir(directory)
  }

  const removeNoFollow = async (native: string, recursive: boolean, force: boolean): Promise<void> => {
    if (recursive) throw otherError("recursive no-follow removal is unsupported")
    const { root } = path.parse(native)
    const components = native.slice(root.length).split(path.sep).filter((part) => part !== "")
    if (components.length === 0) throw invalidInput("path must name an entry")
    let current = await pin(root)
    for (const component of components.slice(0, -1)) {
      const next = path.join(current.path, component)
      const stats = await lstatIfPresent(next)
      if (stats === undefined) {
        if (force) return
        throw osErrorFor("ENOENT")
      }
      if (stats.isSymbolicLink()) throw osErrorFor("ELOOP")
      if (!stats.isDirectory()) throw osErrorFor("ENOTDIR")
      current = await pin(next, stats)
    }
    const leaf = path.join(current.path, components.at(-1)!)
    await recheck(current)
    const stats = await lstatIfPresent(leaf)
    if (stats === undefined) {
      if (force) return
      throw osErrorFor("ENOENT")
    }
    if (stats.isSymbolicLink()) throw invalidInput("path contains a symbolic link")
    await recheck(current)
    if (stats.isDirectory()) await fs.rmdir(leaf)
    else await fs.unlink(leaf)
  }

  const copyFile = async (scope: Scope, source: string, destination: string): Promise<void> => {
    const target = await guard(scope, () => contained(destination, true))
    checkAccess(scope, target, destination, "write")
    const input = await openVerified(source, constants.O_RDONLY)
    try {
      const sourceStats = await input.stat({ bigint: true })
      if (!sourceStats.isFile()) throw invalidInput("fs/copy only supports regular files, directories, and symlinks")
      const mode = Number(sourceStats.mode & 0o7777n)
      const output = await openVerified(target, constants.O_WRONLY | constants.O_CREAT, mode)
      try {
        const outputStats = await output.stat({ bigint: true })
        if (outputStats.dev === sourceStats.dev && outputStats.ino === sourceStats.ino) return
        await output.truncate(0)
        const buffer = Buffer.allocUnsafe(FILE_READ_CHUNK_SIZE)
        for (let position = 0; ; ) {
          const { bytesRead } = await input.read(buffer, 0, buffer.byteLength, position)
          if (bytesRead === 0) break
          await writeAll(output, buffer.subarray(0, bytesRead), position)
          position += bytesRead
        }
        await output.chmod(mode)
      } finally {
        await output.close()
      }
    } finally {
      await input.close()
    }
  }

  const copyLink = async (scope: Scope, linkText: string, destination: string): Promise<void> => {
    const parent = await guard(scope, () => contained(path.dirname(destination), false))
    const target = path.join(parent, path.basename(destination))
    checkAccess(scope, target, destination, "write")
    await fs.symlink(linkText, target)
  }

  const copyTree = async (scope: Scope, source: string, destination: string): Promise<void> => {
    const target = await guard(scope, () => contained(destination, true))
    checkAccess(scope, target, destination, "write")
    await makeDirectory(target, true, true)
    const sourcePin = await pin(source)
    if (!sourcePin.directory) throw outsideRoots()
    const dirents = await fs.readdir(source, { withFileTypes: true })
    await recheck(sourcePin)
    for (const dirent of dirents) {
      const from = path.join(source, dirent.name)
      const to = path.join(target, dirent.name)
      checkAccess(scope, from, from, "read")
      if (dirent.isDirectory()) {
        await copyTree(scope, from, to)
      } else if (dirent.isFile()) {
        await copyFile(scope, from, to)
      } else if (dirent.isSymbolicLink()) {
        await recheck(sourcePin)
        await copyLink(scope, await fs.readlink(from), to)
      }
    }
  }

  const copy: Handlers["copy"] = async (params) => {
    checkNotClosed()
    const sourceNative = parse(params.sourcePath)
    const destinationNative = parse(params.destinationPath)
    const scope = await scopeFor(params.sandbox)
    const source = await guard(scope, () => entryPath(sourceNative, false))
    const destination = await guard(scope, () => entryPath(destinationNative, true))
    const sourceParent = await pin(path.dirname(source))
    checkAccess(scope, source, sourceNative, "read")
    checkAccess(scope, destination, destinationNative, "write")
    const readGrant = await authorizeIn(scope, "read", [source])
    return withGrant(readGrant, async () => {
      const editGrant = await authorizeIn(scope, "edit", [destination])
      return withGrant(editGrant, async () => {
        await recheck(sourceParent)
        const stats = await fs.lstat(source)
        if (stats.isDirectory()) {
          if (!params.recursive) throw invalidInput("fs/copy requires recursive: true when sourcePath is a directory")
          const resolvedDestination = await fs.realpath(destination).catch((err: unknown) => {
            if (errnoOf(err) === "ENOENT") return destination
            throw err
          })
          if (within(resolvedDestination, await fs.realpath(source))) {
            throw invalidInput("fs/copy cannot copy a directory to itself or one of its descendants")
          }
          await copyTree(scope, source, destination)
        } else if (stats.isSymbolicLink()) {
          const linkText = await fs.readlink(source)
          await recheck(sourceParent)
          await copyLink(scope, linkText, destination)
        } else if (stats.isFile()) {
          await copyFile(scope, source, destination)
        } else {
          throw invalidInput("fs/copy only supports regular files, directories, and symlinks")
        }
        return {}
      })
    })
  }

  const shutdown = async (): Promise<void> => {
    if (!closed) {
      closed = true
      for (const [handleId, entry] of files) void detach(handleId, entry)
      await Promise.all([...live].map((entry) => entry.done))
    }
    if (cleanupFailed) throw otherError("Internal error")
  }

  return { createDirectory, open, readBlock, writeBlock, close, walk, remove, copy, shutdown }
}
