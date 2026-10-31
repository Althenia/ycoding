import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export type FollowRequest = { kind: string; sessionID: string; id: string }
const followFailureMessages = {
  "state-lock-held": "Selected follow state is locked; inspect its existing writer before retrying",
  "state-invalid": "Selected follow state is invalid or unsafe; inspect its shape, ownership and symlinks",
  "state-conflict": "Selected follow state or writer lock was replaced or changed; inspect it before resuming",
  "state-io-failed": "Follow state storage failed; verify private state ownership and available storage",
  "epoch-mismatch": "Native source epoch differs from selected follow state; select a new state file",
  "cursor-ahead": "Follow cursor is ahead of retained native history; select a new state file",
  "budget-exhausted": "Follow size, family, reconnect or material dedup safety budget exhausted; inspect retained state",
  "invalid-native-data": "Native follow response is invalid; verify the selected native endpoint",
  "root-required": "Follow requires a root Session",
  "output-failed": "Follow output failed; verify the output consumer before resuming selected state",
  "observer-failed": "Native decision follow failed; verify server availability and private state ownership",
} as const

export class FollowError extends Error {
  constructor(readonly code: keyof typeof followFailureMessages) { super(`[${code}] ${followFailureMessages[code]}`) }
}
export type FollowState = {
  version: 1
  rootSessionID: string
  server: string
  sourceEpoch?: string
  cursors: { sessionID: string; after?: number }[]
  pending: FollowRequest[]
  seen: string[]
  requestSeen: string[]
  terminalSeen: string[]
}

export const followStateBytes = 1024 * 1024
export const followLedgerLimit = 8192
export const followID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)
export const requestKinds = ["permission", "guardrail", "question", "form", "review"]
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key))
const sequence = (value: unknown) => value === undefined || typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export function validateFollowState(value: unknown, root: string, server: string): FollowState {
  if (!record(value) || !keys(value, ["version", "rootSessionID", "server", "sourceEpoch", "cursors", "pending", "seen", "requestSeen", "terminalSeen"]) ||
    value.version !== 1 || value.rootSessionID !== root || !followID(root) || value.server !== server || !/^[a-f0-9]{64}$/.test(server) ||
    value.sourceEpoch !== undefined && !followID(value.sourceEpoch)) throw new Error("Invalid follow state identity")
  if (!Array.isArray(value.cursors) || value.cursors.length > 64) throw new Error("Invalid follow cursors")
  const ids = new Set<string>()
  for (const cursor of value.cursors) {
    if (!record(cursor) || !keys(cursor, ["sessionID", "after"]) || !followID(cursor.sessionID) || !cursor.sessionID.startsWith("ses") ||
      !sequence(cursor.after) || ids.has(cursor.sessionID)) throw new Error("Invalid follow cursor")
    ids.add(cursor.sessionID)
  }
  if (value.sourceEpoch !== undefined && !ids.has(root)) throw new Error("Missing follow root cursor")
  if (!Array.isArray(value.pending) || value.pending.length > followLedgerLimit) throw new Error("Invalid follow pending ledger")
  const pending = new Set<string>()
  for (const request of value.pending) {
    if (!record(request) || !keys(request, ["kind", "sessionID", "id"]) || typeof request.kind !== "string" || !requestKinds.includes(request.kind) ||
      !followID(request.sessionID) || !request.sessionID.startsWith("ses") || !followID(request.id)) throw new Error("Invalid follow pending request")
    const key = `${request.kind}\0${request.sessionID}\0${request.id}`
    if (pending.has(key)) throw new Error("Duplicate follow pending request")
    pending.add(key)
  }
  for (const name of ["seen", "requestSeen", "terminalSeen"] as const) {
    const ledger = value[name]
    if (!Array.isArray(ledger) || ledger.length > followLedgerLimit || new Set(ledger).size !== ledger.length) throw new Error("Invalid follow dedup ledger")
    for (const key of ledger) {
      if (typeof key !== "string") throw new Error("Invalid follow dedup key")
      const parts = key.split("\0")
      if (parts.length !== 3 || (name === "seen"
        ? !followID(parts[0]) || !parts[0]!.startsWith("ses") || !followID(parts[1]) || !/^(0|[1-9][0-9]*)$/.test(parts[2]!) || !Number.isSafeInteger(Number(parts[2]))
        : !requestKinds.includes(parts[0]!) || !followID(parts[1]) || !parts[1]!.startsWith("ses") || !followID(parts[2]))) throw new Error("Invalid follow dedup key")
    }
  }
  if (value.sourceEpoch === undefined && [value.cursors, value.pending, value.seen, value.requestSeen, value.terminalSeen].some((ledger) => Array.isArray(ledger) && ledger.length > 0)) throw new Error("Follow state history requires a source epoch")
  return value as FollowState
}

export async function openFollowState(filename: string, root: string, server: string) {
  const target = path.resolve(filename)
  const parent = path.dirname(target)
  let ancestor = parent
  for (;;) {
    try {
      if ((await lstat(ancestor)).isSymbolicLink() || await realpath(ancestor) !== ancestor) throw new FollowError("state-invalid")
      break
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      const next = path.dirname(ancestor)
      if (next === ancestor) throw error
      ancestor = next
    }
  }
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await realpath(parent) !== parent) throw new FollowError("state-conflict")
  const parentStat = await lstat(parent)
  if (process.getuid !== undefined && (parentStat.uid !== process.getuid() || (parentStat.mode & 0o022) !== 0)) throw new FollowError("state-invalid")
  const lockPath = `${target}.lock`
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600).catch((error: unknown) => {
    throw new FollowError(error instanceof Error && "code" in error && error.code === "EEXIST" ? "state-lock-held" : "state-io-failed")
  })
  let closed = false
  let identity: { ino: number; dev: number } | undefined
  const close = async () => {
    if (closed) return
    closed = true
    const owned = await lock.stat()
    await lock.close()
    const current = await lstat(lockPath)
    if (current.ino !== owned.ino || current.dev !== owned.dev) throw new FollowError("state-conflict")
    await unlink(lockPath)
  }
  try {
    await lock.writeFile(`${process.pid}\n`)
    let state: FollowState = { version: 1, rootSessionID: root, server, cursors: [], pending: [], seen: [], requestSeen: [], terminalSeen: [] }
    try {
      const before = await lstat(target)
      if (!before.isFile() || before.nlink !== 1 || before.size > followStateBytes) throw new FollowError("state-invalid")
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > followStateBytes || process.getuid !== undefined && stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new FollowError("state-invalid")
        identity = { ino: stat.ino, dev: stat.dev }
        const buffer = Buffer.alloc(followStateBytes + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > followStateBytes || (await file.stat()).size !== bytesRead) throw new FollowError("state-invalid")
        state = validateFollowState(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), root, server)
      } finally { await file.close() }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new FollowError("state-invalid")
    }
    return { state, close, async save(value: FollowState) {
      const data = JSON.stringify(validateFollowState(value, root, server)) + "\n"
      if (Buffer.byteLength(data) > followStateBytes) throw new FollowError("budget-exhausted")
      if (await realpath(parent) !== parent) throw new FollowError("state-conflict")
      const ownedLock = await lock.stat()
      const currentLock = await lstat(lockPath)
      if (!currentLock.isFile() || currentLock.nlink !== 1 || currentLock.ino !== ownedLock.ino || currentLock.dev !== ownedLock.dev) throw new FollowError("state-conflict")
      let current
      try { current = await lstat(target) } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      if (identity ? current?.ino !== identity.ino || current?.dev !== identity.dev : current !== undefined) throw new FollowError("state-conflict")
      const temporary = `${target}.${randomUUID()}.tmp`
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      try {
        await file.writeFile(data)
        await file.sync()
        await file.close()
        await rename(temporary, target)
        const stat = await lstat(target)
        identity = { ino: stat.ino, dev: stat.dev }
      } catch (error) {
        await file.close()
        await unlink(temporary)
        throw error
      }
    } }
  } catch (error) { await close(); throw error }
}
