import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export type FollowRequest = { kind: string; sessionID: string; id: string; fingerprint?: string; revision?: number; parentID?: string }
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
  "delivery-failed": "Dot delivery failed; undelivered events stay in the follow state and resume on restart; verify Dots access and the --deliver threads",
  "delivery-target-unavailable": "A --deliver thread is not listed by your Dot, or for dot your Dot reports no root conversation; run ycoding dots threads and select dot or a listed thread",
  "delivery-targets-changed": "Selected follow state delivers to other --deliver targets; repeat its exact targets or select a new state file",
} as const

export class FollowError extends Error {
  constructor(readonly code: keyof typeof followFailureMessages, detail?: string) {
    super(`[${code}] ${followFailureMessages[code]}${detail === undefined ? "" : `; ${detail}`}`)
  }
}
const privateParentRequirement = "its directory must be owned by the current user and not writable by group or others; omit --state to use the default private state location, or select a file in a directory created with mkdir -m 700"
export const followRequestKey = (request: FollowRequest) => `${request.kind}\0${request.sessionID}\0${request.id}${request.fingerprint === undefined && request.revision === undefined ? "" : `\0${request.fingerprint ?? ""}\0${request.revision ?? ""}`}`
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
  ownership?: { groupID: string; sessionID: string; ownerSessionID?: string; revision: number }[]
  delivery?: FollowDelivery
}
export type DeliveryMember = { sessionID: string; ownerSessionID?: string }
export type DeliveryEvent = { sessionID: string; id: string; type?: string; seq?: number; requestKind?: string; parentID?: string; fingerprint?: string; revision?: number; escalated?: true
  ownerSessionID?: string; removed?: true; snapshot?: true; members?: DeliveryMember[] }
export type DeliveryTarget = { target: string; outbox: DeliveryEvent[]; inflight?: { threadID: string; clientMessageID: string; events: DeliveryEvent[] } }
export type FollowDelivery = { announced: string[]; targets: DeliveryTarget[] }
export const deliveryLifecycleTypes = ["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.work.completed"]
export const deliveryOwnershipTypes = ["owner-changed", "owner-released"]
export const dotDeliveryTarget = "dot"
export const deliveryTargetLimit = 8
export const deliveryBatchLimit = 20
export const deliveryThreadID = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /\S/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
export const deliveryKey = (event: DeliveryEvent) => [event.type ?? "", event.requestKind ?? "", event.sessionID, event.id, event.seq ?? "", event.parentID ?? "",
  event.fingerprint ?? "", event.revision ?? "", event.escalated ? "escalated" : "", event.ownerSessionID ?? "", event.removed ? "removed" : "",
  event.snapshot ? JSON.stringify(event.members) : ""].join("\0")
export const announcedKey = (event: DeliveryEvent) => `${event.escalated ? "project-escalation:" : ""}${event.requestKind}\0${event.sessionID}\0${event.id}`

export const followStateBytes = 1024 * 1024
export const followLedgerLimit = 8192
export const followID = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)
export const requestKinds = ["permission", "guardrail", "question", "form", "review", "child-question"]
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key))
const sequence = (value: unknown) => value === undefined || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const sessionID = (value: unknown) => followID(value) && value.startsWith("ses")

function validDeliveryMembers(members: unknown) {
  return Array.isArray(members) && members.length >= 1 && members.length <= followLedgerLimit && new Set(members.map((member) => record(member) ? member.sessionID : undefined)).size === members.length &&
    members.every((member) => record(member) && keys(member, ["sessionID", "ownerSessionID"]) && followID(member.sessionID) && (member.ownerSessionID === undefined || followID(member.ownerSessionID)))
}

function validDeliveryEvent(event: unknown) {
  if (!record(event) || !keys(event, ["sessionID", "id", "type", "seq", "requestKind", "parentID", "fingerprint", "revision", "escalated", "ownerSessionID", "removed", "snapshot", "members"]) || !followID(event.id)) return false
  if (event.snapshot !== undefined) return event.snapshot === true && sessionID(event.sessionID) && typeof event.revision === "number" && sequence(event.revision) && validDeliveryMembers(event.members) &&
    [event.type, event.seq, event.requestKind, event.parentID, event.fingerprint, event.escalated, event.ownerSessionID, event.removed].every((field) => field === undefined)
  if (event.members !== undefined) return false
  if (typeof event.type === "string" && deliveryOwnershipTypes.includes(event.type)) return followID(event.sessionID) && typeof event.revision === "number" && sequence(event.revision) &&
    (event.ownerSessionID === undefined || followID(event.ownerSessionID)) && (event.removed === undefined || event.removed === true) &&
    [event.seq, event.requestKind, event.parentID, event.fingerprint, event.escalated].every((field) => field === undefined)
  if (!sessionID(event.sessionID) || event.ownerSessionID !== undefined || event.removed !== undefined) return false
  if (event.type !== undefined) return typeof event.type === "string" && deliveryLifecycleTypes.includes(event.type) && event.seq !== undefined && sequence(event.seq) &&
    [event.requestKind, event.parentID, event.fingerprint, event.revision, event.escalated].every((field) => field === undefined)
  return typeof event.requestKind === "string" && requestKinds.includes(event.requestKind) && event.seq === undefined && sequence(event.revision) &&
    (event.parentID === undefined || sessionID(event.parentID)) && (event.escalated === undefined || event.escalated === true) &&
    (event.fingerprint === undefined || typeof event.fingerprint === "string" && /^[a-f0-9]{64}$/.test(event.fingerprint))
}

function validateDelivery(value: unknown) {
  if (!record(value) || !keys(value, ["announced", "targets"]) || !Array.isArray(value.announced) || value.announced.length > followLedgerLimit ||
    new Set(value.announced).size !== value.announced.length || !Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > deliveryTargetLimit) throw new Error("Invalid follow delivery")
  for (const key of value.announced) {
    const parts = typeof key === "string" ? key.split("\0") : []
    const kind = parts[0]?.startsWith("project-escalation:") ? parts[0].slice("project-escalation:".length) : parts[0]
    if (parts.length !== 3 || !requestKinds.includes(kind!) || !sessionID(parts[1]) || !followID(parts[2])) throw new Error("Invalid follow delivery announcement")
  }
  const targets = new Set<string>()
  for (const target of value.targets) {
    if (!record(target) || !keys(target, ["target", "outbox", "inflight"]) || !deliveryThreadID(target.target) || targets.has(target.target) ||
      !Array.isArray(target.outbox) || target.outbox.length > followLedgerLimit || !target.outbox.every(validDeliveryEvent)) throw new Error("Invalid follow delivery target")
    targets.add(target.target)
    if (target.inflight === undefined) continue
    const inflight = target.inflight
    if (!record(inflight) || !keys(inflight, ["threadID", "clientMessageID", "events"]) || !deliveryThreadID(inflight.threadID) ||
      (target.target === dotDeliveryTarget ? inflight.threadID === dotDeliveryTarget : inflight.threadID !== target.target) || typeof inflight.clientMessageID !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(inflight.clientMessageID) || !Array.isArray(inflight.events) ||
      inflight.events.length < 1 || inflight.events.length > deliveryBatchLimit || !inflight.events.every(validDeliveryEvent)) throw new Error("Invalid follow delivery batch")
  }
}

export function validateFollowState(value: unknown, root: string, server: string): FollowState {
  if (!record(value) || !keys(value, ["version", "rootSessionID", "server", "sourceEpoch", "cursors", "pending", "seen", "requestSeen", "terminalSeen", "ownership", "delivery"]) ||
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
    if (!record(request) || !keys(request, ["kind", "sessionID", "id", "fingerprint", "revision", "parentID"]) || typeof request.kind !== "string" || !requestKinds.includes(request.kind) ||
      request.parentID !== undefined && !followID(request.parentID) ||
      request.fingerprint !== undefined && (typeof request.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.fingerprint)) ||
      !sequence(request.revision) ||
      !followID(request.sessionID) || !request.sessionID.startsWith("ses") || !followID(request.id)) throw new Error("Invalid follow pending request")
    const key = followRequestKey(request as FollowRequest)
    if (pending.has(key)) throw new Error("Duplicate follow pending request")
    pending.add(key)
  }
  for (const name of ["seen", "requestSeen", "terminalSeen"] as const) {
    const ledger = value[name]
    if (!Array.isArray(ledger) || ledger.length > followLedgerLimit || new Set(ledger).size !== ledger.length) throw new Error("Invalid follow dedup ledger")
    for (const key of ledger) {
      if (typeof key !== "string") throw new Error("Invalid follow dedup key")
      const parts = key.split("\0")
      const kind = name === "requestSeen" && parts[0]?.startsWith("project-escalation:") ? parts[0].slice("project-escalation:".length) : parts[0]
      if ((parts.length !== 3 && (name === "seen" || parts.length !== 5 || !/^(|[a-f0-9]{64})$/.test(parts[3]!) || !/^(|0|[1-9][0-9]*)$/.test(parts[4]!) || !sequence(parts[4] === "" ? undefined : Number(parts[4])))) || (name === "seen"
        ? !followID(parts[0]) || !parts[0]!.startsWith("ses") || !followID(parts[1]) || !/^(0|[1-9][0-9]*)$/.test(parts[2]!) || !Number.isSafeInteger(Number(parts[2]))
        : !requestKinds.includes(kind!) || !followID(parts[1]) || !parts[1]!.startsWith("ses") || !followID(parts[2]))) throw new Error("Invalid follow dedup key")
    }
  }
  if (value.sourceEpoch === undefined && [value.cursors, value.pending, value.seen, value.requestSeen, value.terminalSeen].some((ledger) => Array.isArray(ledger) && ledger.length > 0)) throw new Error("Follow state history requires a source epoch")
  if (value.ownership !== undefined) {
    if (!Array.isArray(value.ownership) || value.ownership.length > followLedgerLimit) throw new Error("Invalid follow ownership")
    const members = new Set<string>()
    for (const item of value.ownership) {
      if (!record(item) || !keys(item, ["groupID", "sessionID", "ownerSessionID", "revision"]) || !followID(item.groupID) ||
        !followID(item.sessionID) || item.ownerSessionID !== undefined && !followID(item.ownerSessionID) ||
        typeof item.revision !== "number" || !sequence(item.revision)) throw new Error("Invalid follow ownership")
      const key = `${item.groupID}\0${item.sessionID}`
      if (members.has(key)) throw new Error("Duplicate follow ownership")
      members.add(key)
    }
  }
  if (value.delivery !== undefined) validateDelivery(value.delivery)
  return value as FollowState
}

const privateDirectory = (stat: { uid: number; mode: number }) => process.getuid === undefined || stat.uid === process.getuid() && (stat.mode & 0o022) === 0

async function acceptableParent(directory: string) {
  try {
    const stat = await lstat(directory)
    return stat.isDirectory() && privateDirectory(stat)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true
    throw error
  }
}

export async function openFollowState(filename: string, root: string, server: string) {
  const target = path.resolve(filename)
  const parent = path.dirname(target)
  let ancestor = parent
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      if ((await lstat(ancestor)).isSymbolicLink() || canonical !== ancestor) {
        const replacement = path.join(canonical, path.relative(ancestor, target))
        throw new FollowError("state-invalid", await acceptableParent(path.dirname(replacement))
          ? `use canonical --state ${JSON.stringify(replacement)}` : privateParentRequirement)
      }
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
  if (!privateDirectory(parentStat)) throw new FollowError("state-invalid", privateParentRequirement)
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
