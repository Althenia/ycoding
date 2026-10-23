export * as RemoteOperations from "./remote-operations"

import { RemoteMcpDemo } from "./remote-mcp-demo"
import type { RemoteMcpApps } from "./remote-mcp-apps"
import type { McpEvents } from "@ycoding-ai/schema/mcp-events"

import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Project } from "@ycoding-ai/schema/project"
import type { FormAnswer, ReviewDecideInput, SessionInfo } from "@ycoding-ai/client/promise"
import { capturedChildSessionIDs, summarizeCapturedChanges } from "@ycoding-ai/client/file-change-summary"
import { SessionOrchestrationIdentity } from "@ycoding-ai/core/session/orchestration-identity"
import {
  RemoteLimits,
  localAppOperations,
  alertTitle,
  isRemoteLatencySample,
  isRemoteReviewItemID,
  isSessionID,
  remoteError,
  remoteRecoveryChoices,
  parseProviderAuthInput,
  requireSession,
  serializeResponse,
  type RemoteErrorCode,
  type RemoteOperation,
  type RemoteLatencySample,
  type RemotePriorityMode,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteWorkspaceInfo,
  type RemoteFamilyActivity,
  type RemoteUsageReportInput,
  type RemoteIncidentGuidanceInput,
  type RemoteIncidentRecentInput,
  type RemoteIncidentReportInput,
  type RemoteCapturedChangesPage,
  type RemoteAttentionDetail,
  type RemoteAttentionNeed,
} from "@ycoding-ai/remote"
import {
  LocalFailure,
  findSession,
  type LocalAutonomy,
  type LocalLocation,
  type LocalPrompt,
  type LocalServer,
} from "./remote-local"
import { executeProviderAuth, ProviderAuthError, type ProviderAuthEntry } from "./remote-provider-auth"

/** Operations the relay proxies without addressing one session. */
const unscopedOperations: ReadonlySet<RemoteOperation> = new Set([
  "machine.latency.append",
  "machine.telemetry.consent.get",
  "machine.telemetry.consent.set",
  "machine.latency.list",
  "workspace.list",
  "workspace.catalog",
  "workspace.file.find",
  "session.list",
  "session.active",
  "session.status",
  "usage.providers",
  "usage.summary",
  "usage.report",
  "incident.report",
  "incident.recent",
  "session.create",
])

// Authorization and mapping for the closed relay operation set. The local agent
// resolves every scoped Session against the backend; no remote field can select a
// URL, HTTP method, or Location header.

const maxLogReadItems = 2_000
const maxCapturedPageChars = 512_000
const maxCapturedFilesPerPage = 100
const maxPendingInputs = 200

// One shell-output request returns one page at most: the local default page, so a
// remote reader pages explicitly instead of asking the device for unbounded output.
const maxShellOutputPage = 65_536

const maxCapturedCacheEntries = 32
const maxCapturedChildReads = 4
const maxTrackedActivity = 4_096
const directoryPermissionTtlMs = 30_000

type CapturedGroup = RemoteCapturedChangesPage["data"][number]
type CapturedEntry = {
  readonly parentKey: string
  readonly members: ReadonlyMap<string, string | null>
  readonly groups: readonly CapturedGroup[]
  readonly digest: string
  readonly readAt: number
  readonly epoch: number
}
type CapturedResult = { readonly groups: readonly CapturedGroup[]; readonly digest: string }

/** Session activity the connector observed on the local event stream; a member Session is re-read only after its entry in `at` passes a cached read's clock value. */
type SessionActivity = { clock: number; epoch: number; floor: number; readonly at: Map<string, number> }

export type OperationCache = {
  listStatus?: { readonly expiresAt: number; readonly value: Promise<{ readonly running: ReadonlySet<string>; readonly waiting: ReadonlySet<string>; readonly lost: ReadonlySet<string> }> }
  readonly providerAuth: Map<string, ProviderAuthEntry>
  readonly now: () => number
  readonly capturedChanges: Map<string, CapturedEntry>
  readonly capturedReads: Map<string, Flight<CapturedResult>>
  readonly activity: SessionActivity
  readonly directories: Map<string, { readonly allowed: boolean; readonly expiresAt: number }>
}

export function createOperationCache(now: () => number = Date.now): OperationCache {
  return {
    now,
    capturedChanges: new Map(),
    capturedReads: new Map(),
    activity: { clock: 0, epoch: 0, floor: 0, at: new Map() },
    directories: new Map(),
    providerAuth: new Map(),
  }
}

/** Records that a step ended in, or the inventory changed for, the Session, so a cached captured summary re-reads it. */
export function markSessionActivity(cache: OperationCache, sessionID: string) {
  const activity = cache.activity
  activity.at.delete(sessionID)
  activity.at.set(sessionID, ++activity.clock)
  if (activity.at.size <= maxTrackedActivity) return
  const oldest = activity.at.keys().next().value!
  activity.floor = activity.at.get(oldest)!
  activity.at.delete(oldest)
}

/** Ends trust in every cached captured summary's member Sessions after the event stream may have missed events. */
export function resetSessionActivity(cache: OperationCache) {
  cache.listStatus = undefined
  cache.activity.floor = 0
  cache.activity.epoch++
}

type Flight<Value> = { readonly promise: Promise<Value>; readonly controller: AbortController; waiters: number }

/**
 * Joins the pending read for the key or starts it. The read aborts when its last
 * waiter aborts; a caller that aborts rejects at once while other waiters keep the read.
 */
function joinFlight<Value>(flights: Map<string, Flight<Value>>, key: string, signal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const existing = flights.get(key)
  const flight = existing !== undefined && !existing.controller.signal.aborted ? existing : (() => {
    const controller = new AbortController()
    const created: Flight<Value> = { promise: start(controller.signal).finally(() => { if (flights.get(key) === created) flights.delete(key) }), controller, waiters: 0 }
    flights.set(key, created)
    return created
  })()
  flight.waiters++
  let left = false
  const leave = () => {
    if (left) return
    left = true
    if (--flight.waiters === 0) flight.controller.abort()
  }
  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => { leave(); reject(signal?.reason) }
    signal?.addEventListener("abort", onAbort, { once: true })
    flight.promise.then(resolve, reject).finally(() => {
      signal?.removeEventListener("abort", onAbort)
      left = true
    })
  })
}

const catalogLimit = { agents: 100, commands: 200, skills: 200, references: 200, resources: 200 }
type ModelSelection = NonNullable<Parameters<LocalServer["createSession"]>[3]>
type CommandInput = Parameters<LocalServer["command"]>[2]

export function createAttachmentUploads(options: { readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now
  const entries = new Map<string, { readonly sessionID: string; readonly chunks: string[]; bytes: number; complete: boolean; expiresAt: number; timer?: ReturnType<typeof setTimeout> }>()
  let total = 0
  let closed = false
  const remove = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    total -= entry.bytes
    entries.delete(id)
  }
  const prune = () => { for (const [id, entry] of entries) if (entry.expiresAt <= now()) remove(id) }
  const touch = (id: string, entry: NonNullable<ReturnType<typeof entries.get>>) => {
    clearTimeout(entry.timer)
    entry.expiresAt = now() + RemoteLimits.attachmentTtlMs
    entry.timer = setTimeout(() => remove(id), RemoteLimits.attachmentTtlMs)
    entry.timer.unref?.()
  }
  return {
    append(sessionID: string, id: string, index: number, last: boolean, data: string) {
      if (closed) throw new OperationError("invalid_message", "Attachment upload connection is closed")
      prune()
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ||
        !Number.isSafeInteger(index) || index < 0 || index >= RemoteLimits.maxAttachmentChunks ||
        typeof last !== "boolean" || data.length === 0 || data.length > RemoteLimits.maxAttachmentChunkChars ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || (!last && data.endsWith("=")))
        throw new OperationError("invalid_message", "Invalid attachment upload chunk")
      const existing = entries.get(id)
      if ((existing && (existing.sessionID !== sessionID || existing.complete || existing.chunks.length !== index)) || (!existing && index !== 0))
        throw new OperationError("invalid_message", "Attachment chunks must arrive once, in order, for one Session")
      if (!existing && entries.size >= RemoteLimits.maxAttachmentUploads)
        throw new OperationError("message_too_large", "Too many attachment uploads are retained on this connection")
      const bytes = Buffer.from(data, "base64").byteLength
      if (bytes === 0 || bytes + (existing?.bytes ?? 0) > RemoteLimits.maxAttachmentBytes || bytes + total > RemoteLimits.maxConnectionAttachmentBytes) {
        remove(id)
        throw new OperationError("message_too_large", "Attachment exceeds the upload size limit")
      }
      const entry = existing ?? { sessionID, chunks: [], bytes: 0, complete: false, expiresAt: 0, timer: undefined }
      entry.chunks.push(data)
      entry.bytes += bytes
      total += bytes
      entries.set(id, entry)
      if (last) {
        const combined = entry.chunks.join("")
        if (Buffer.from(combined, "base64").toString("base64") !== combined) {
          remove(id)
          throw new OperationError("invalid_message", "Attachment data is not canonical base64")
        }
        entry.complete = true
      }
      touch(id, entry)
      return last ? { uri: `ycoding-upload://${id}` } : { received: entry.bytes }
    },
    resolve(sessionID: string, uri: string) {
      if (closed) throw new OperationError("invalid_message", "Attachment upload connection is closed")
      prune()
      const id = uri.startsWith("ycoding-upload://") ? uri.slice("ycoding-upload://".length) : ""
      const entry = entries.get(id)
      if (!entry || entry.sessionID !== sessionID || !entry.complete)
        throw new OperationError("invalid_message", "Attachment upload is unavailable or incomplete")
      touch(id, entry)
      return `data:application/octet-stream;base64,${entry.chunks.join("")}`
    },
    clear() { closed = true; for (const id of entries.keys()) remove(id) },
  }
}

/** A response too large for one agent frame is chunked, never truncated. */
export function successFrames(id: string, value: unknown): readonly RemoteResponse[] {
  const text = JSON.stringify(value ?? null)
  if (text.length <= RemoteLimits.maxAgentMessageChars) {
    const single: RemoteResponse = { type: "response", id, ok: true, value: value ?? null }
    if (serializeResponse(single).length <= RemoteLimits.maxAgentMessageChars) return [single]
  }
  const frames: RemoteResponse[] = []
  let offset = 0
  while (offset < text.length) {
    if (frames.length >= RemoteLimits.maxChunksPerResponse)
      return [failureFrame(id, "message_too_large", "Response exceeds the bounded chunk count; read again with after")]
    const index = frames.length
    let take = Math.min(text.length - offset, RemoteLimits.maxAgentMessageChars)
    for (;;) {
      const candidate: RemoteResponse = {
        type: "response",
        id,
        ok: true,
        value: text.slice(offset, offset + take),
        chunk: { index, last: offset + take >= text.length },
      }
      const length = serializeResponse(candidate).length
      if (take === 1 || length <= RemoteLimits.maxAgentMessageChars) break
      take = Math.max(1, take - (length - RemoteLimits.maxAgentMessageChars))
    }
    if (offset + take < text.length && text.charCodeAt(offset + take - 1) >= 0xd800 && text.charCodeAt(offset + take - 1) <= 0xdbff &&
      text.charCodeAt(offset + take) >= 0xdc00 && text.charCodeAt(offset + take) <= 0xdfff)
      take = take === 1 ? 2 : take - 1
    const last = offset + take >= text.length
    frames.push({ type: "response", id, ok: true, value: text.slice(offset, offset + take), chunk: { index, last } })
    offset += take
  }
  return frames
}

function failureFrame(id: string, code: RemoteErrorCode, message: string): RemoteResponse {
  return { type: "response", id, ok: false, error: remoteError(code, message) }
}

export type SubscriptionRegistry = {
  readonly apply: (clientID: string, sessionIDs: readonly string[]) => void
  readonly clear: () => void
  /** Records a client's delivery preference; it lasts until that client's snapshot empties or the registry clears. */
  readonly setPriority: (clientID: string, mode: RemotePriorityMode) => void
  /** Whether any client subscribed to the Session wants interactive delivery; clients default to interactive. */
  readonly interactive: (sessionID: string) => boolean
  readonly has: (sessionID: string) => boolean
  readonly count: (sessionID: string) => number
  readonly sessions: () => readonly string[]
}

/**
 * The relay owns per-client subscription state. The agent keeps only the latest
 * ordered snapshot for each live relay client and derives the forwarding union.
 */
export function createSubscriptions(options: { readonly onChange?: () => void } = {}): SubscriptionRegistry {
  const clients = new Map<string, ReadonlySet<string>>()
  const priorities = new Map<string, RemotePriorityMode>()
  const changed = () => options.onChange?.()
  return {
    apply(clientID, sessionIDs) {
      if (sessionIDs.length === 0) {
        clients.delete(clientID)
        priorities.delete(clientID)
      } else clients.set(clientID, new Set(sessionIDs))
      changed()
    },
    clear() {
      priorities.clear()
      if (clients.size === 0) return
      clients.clear()
      changed()
    },
    setPriority(clientID, mode) {
      priorities.set(clientID, mode)
      changed()
    },
    interactive: (sessionID) =>
      Array.from(clients).some(([clientID, sessions]) => sessions.has(sessionID) && priorities.get(clientID) !== "background"),
    has: (sessionID) => Array.from(clients.values()).some((sessions) => sessions.has(sessionID)),
    count: (sessionID) => Array.from(clients.values()).filter((sessions) => sessions.has(sessionID)).length,
    sessions: () => [...new Set(Array.from(clients.values()).flatMap((sessions) => [...sessions]))],
  }
}

export type SessionRegistry = {
  readonly ids: () => readonly string[]
  readonly snapshot: () => readonly SessionInfo[]
  readonly root: (sessionID: string) => string | undefined
  readonly get: (sessionID: string, signal?: AbortSignal) => Promise<SessionInfo | undefined>
  /** Resolve the Session from the complete backend inventory, then verify its current Location. A verification inside the registry's window or already in flight is reused until `invalidate` or `renew`. */
  readonly verify: (sessionID: string, signal?: AbortSignal) => Promise<SessionInfo | undefined>
  /** Ends the Session's verification window, so the next `verify` reads its recorded Location again. */
  readonly invalidate: (sessionID: string) => void
  /** Ends every verification window and abandons pending verifications, as after events were missed. */
  readonly invalidateAll: () => void
  /** Reads the Session at its recorded Location now, whatever the verification window holds. */
  readonly renew: (sessionID: string) => Promise<SessionInfo | undefined>
  /** Adds one newly created Session at the Location the backend reported for it, without reading the inventory. */
  readonly add: (sessionID: string, location: LocalLocation) => Promise<void>
  readonly refresh: () => Promise<void>
}

/**
 * Device ownership grants access to the backend's complete Session inventory.
 * Locations always come from that inventory; remote input never selects placement.
 */
export function createSessionRegistry(input: {
  readonly local: LocalServer
  readonly onChange?: () => void
  /** How long a successful Location verification serves later verifications of the same Session; zero verifies every time. */
  readonly verifyWindowMs?: number
  readonly now?: () => number
}): SessionRegistry {
  const verified = new Map<string, SessionInfo>()
  const verifiedAt = new Map<string, number>()
  const verifications = new Map<string, Flight<SessionInfo | undefined>>()
  const now = input.now ?? Date.now
  let invalidations = 0
  let refreshQueue = Promise.resolve<readonly SessionInfo[]>([])

  const readAll = async () => {
    const sessions: SessionInfo[] = []
    let cursor: string | undefined
    for (;;) {
      const result = await input.local.listPage({ limit: RemoteLimits.maxSessionListPage, ...(cursor === undefined ? {} : { cursor }) })
      sessions.push(...result.data)
      if (result.next === undefined || result.data.length === 0) return sessions
      cursor = result.next
    }
  }

  const refresh = () => {
    const run = refreshQueue.then(async () => {
      const beforeRead = new Map(verified)
      const sessions = await readAll()
      const before = new Map(verified)
      const refreshed = new Map(sessions.map((session) => [session.id, session]))
      for (const sessionID of new Set([...beforeRead.keys(), ...verified.keys()])) {
        if (beforeRead.get(sessionID) === verified.get(sessionID)) continue
        const current = verified.get(sessionID)
        if (current === undefined) refreshed.delete(sessionID)
        else refreshed.set(sessionID, current)
      }
      verified.clear()
      for (const [sessionID, session] of refreshed) verified.set(sessionID, session)
      if (before.size !== verified.size || [...verified.values()].some((session) => sessionInventoryChanged(before.get(session.id), session))) input.onChange?.()
      return [...verified.values()]
    })
    refreshQueue = run.catch(() => [...verified.values()])
    return run
  }

  const read = async (sessionID: string, signal: AbortSignal) => {
    const known = verified.get(sessionID)
    const info = known ?? await findSession(input.local, sessionID)
    if (info === undefined) return undefined
    const generation = invalidations
    try {
      const current = await input.local.getSession(sessionID, locationInfo(info), signal)
      if (verified.get(sessionID) !== known) {
        const latest = verified.get(sessionID)
        return latest === undefined || JSON.stringify(locationInfo(latest)) !== JSON.stringify(locationInfo(current)) ? undefined : latest
      }
      const changed = sessionInventoryChanged(verified.get(sessionID), current)
      verified.set(sessionID, current)
      if (generation === invalidations) verifiedAt.set(sessionID, now())
      if (changed) input.onChange?.()
      return current
    } catch (cause) {
      if (!(cause instanceof LocalFailure && cause.kind === "not_found")) throw cause
      if (verified.get(sessionID) === known && verified.delete(sessionID)) input.onChange?.()
      verifiedAt.delete(sessionID)
      return undefined
    }
  }

  const verify = (sessionID: string, signal?: AbortSignal) => {
    const known = verified.get(sessionID)
    const at = verifiedAt.get(sessionID)
    if (known !== undefined && at !== undefined && now() - at < (input.verifyWindowMs ?? 0)) return Promise.resolve<SessionInfo | undefined>(known)
    return joinFlight(verifications, sessionID, signal, (flightSignal) => read(sessionID, flightSignal))
  }

  const invalidate = (sessionID: string) => {
    invalidations++
    verifiedAt.delete(sessionID)
    verifications.delete(sessionID)
  }

  const invalidateAll = () => {
    invalidations++
    verifiedAt.clear()
    verifications.clear()
  }

  return {
    ids: () => [...verified.keys()],
    snapshot: () => [...verified.values()],
    root: (sessionID) => {
      const session = verified.get(sessionID)
      return session === undefined ? undefined : rootSessionID(session, verified)
    },
    get: verify,
    verify,
    invalidate,
    invalidateAll,
    renew: (sessionID) => {
      invalidate(sessionID)
      return verify(sessionID)
    },
    add: async (sessionID, location) => {
      if (verified.has(sessionID)) return
      const created = await input.local.getSession(sessionID, location)
      if (verified.has(sessionID)) return
      verified.set(sessionID, created)
      verifiedAt.set(sessionID, now())
      input.onChange?.()
    },
    refresh: async () => {
      await refresh()
    },
  }
}

function sessionInventoryChanged(previous: SessionInfo | undefined, current: SessionInfo) {
  if (previous === undefined) return true
  return JSON.stringify([
    previous.title, previous.agent, previous.model, previous.projectID, previous.location,
    previous.time.archived, previous.time.pinned,
  ]) !== JSON.stringify([
    current.title, current.agent, current.model, current.projectID, current.location,
    current.time.archived, current.time.pinned,
  ])
}

function locationInfo(info: { readonly location: { readonly directory: string; readonly workspaceID?: string } }): LocalLocation {
  return {
    directory: info.location.directory,
    ...(info.location.workspaceID === undefined ? {} : { workspaceID: info.location.workspaceID }),
  }
}

type WorkspaceCandidate = {
  readonly info: RemoteWorkspaceInfo
  readonly location: LocalLocation
}

function workspaceKey(projectID: string, directory: string, locationWorkspaceID?: string) {
  return `wsp_${createHash("sha256").update("ycoding.remote.workspace.v1\0").update(JSON.stringify([projectID, directory, locationWorkspaceID ?? null])).digest("hex")}`
}

async function workspaceInventory(input: OperationInput): Promise<WorkspaceCandidate[]> {
  const local = input.local
  const sessions = input.sessions.snapshot()
  const projects = await local.projectList()
  const projectsByID = new Map(projects.map((project) => [project.id, project]))
  const candidates = new Map<string, WorkspaceCandidate>()
  const add = (projectID: string, recorded: string, workspaceID?: string) => {
    if (projectID === Project.ID.global) return
    const directory = resolve(recorded)
    const location = { directory, ...(workspaceID === undefined ? {} : { workspaceID }) }
    const tuple = [projectID, directory, workspaceID ?? null] as const
    const project = projectsByID.get(projectID)
    candidates.set(JSON.stringify(tuple), {
      location,
      info: {
        id: workspaceKey(projectID, directory, workspaceID),
        projectID,
        directory,
        ...(workspaceID === undefined ? {} : { workspaceID }),
        name: project?.name ?? basename(directory),
      },
    })
  }

  for (const project of projects) {
    if (project.id !== Project.ID.global && project.worktree !== "/") add(project.id, project.worktree)
  }
  for (const [project, directories] of await Promise.all(
    projects.map(async (project) => [project, await local.projectDirectories(project.id)] as const),
  )) {
    for (const directory of directories) add(project.id, directory.directory)
  }
  for (const session of sessions)
    add(session.projectID, session.location.directory, session.location.workspaceID)

  const existing: WorkspaceCandidate[] = []
  const allowed = new Map<string, boolean>()
  for (const candidate of candidates.values()) {
    const directory = candidate.location.directory
    if (!allowed.has(directory)) allowed.set(directory, await allowedWorkspaceDirectory(directory))
    if (allowed.get(directory)) existing.push(candidate)
  }
  return existing.toSorted((left, right) =>
    left.info.projectID.localeCompare(right.info.projectID) ||
    left.info.directory.localeCompare(right.info.directory) ||
    (left.location.workspaceID ?? "").localeCompare(right.location.workspaceID ?? ""),
  )
}

async function workspaceList(input: OperationInput): Promise<readonly RemoteWorkspaceInfo[]> {
  return (await workspaceInventory(input)).map((candidate) => candidate.info)
}

async function sessionWorkspaces(local: LocalServer, sessions: readonly SessionInfo[], cache?: OperationCache): Promise<readonly RemoteWorkspaceInfo[]> {
  const projects = new Map((await local.projectList()).map((project) => [project.id, project]))
  const directories = [...new Set(sessions.map((session) => resolve(session.location.directory)))]
  if (cache !== undefined) for (const [directory, entry] of cache.directories) if (entry.expiresAt <= cache.now()) cache.directories.delete(directory)
  const permitted = new Set((await Promise.all(directories.map(async (directory) => await cachedWorkspaceDirectory(directory, cache) ? directory : undefined)))
    .filter((directory): directory is string => directory !== undefined))
  return [...new Map(sessions.filter((session) => permitted.has(resolve(session.location.directory))).map((session) => {
    const projectID = session.projectID
    const directory = resolve(session.location.directory)
    const id = workspaceKey(projectID, directory, session.location.workspaceID)
    const name = projects.get(projectID)?.name ?? basename(directory)
    return [id, { id, projectID, directory,
      ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }),
      name } as RemoteWorkspaceInfo] as const
  })).values()].toSorted((left, right) => left.projectID.localeCompare(right.projectID) || left.directory.localeCompare(right.directory) || left.id.localeCompare(right.id))
}

async function cachedWorkspaceDirectory(directory: string, cache?: OperationCache): Promise<boolean> {
  if (cache === undefined) return allowedWorkspaceDirectory(directory)
  const known = cache.directories.get(directory)
  if (known !== undefined && known.expiresAt > cache.now()) return known.allowed
  const allowed = await allowedWorkspaceDirectory(directory)
  cache.directories.set(directory, { allowed, expiresAt: cache.now() + directoryPermissionTtlMs })
  return allowed
}

async function allowedWorkspaceDirectory(directory: string): Promise<boolean> {
  const canonical = await realpath(directory).catch(() => undefined)
  if (canonical === undefined || !(await stat(canonical).then((value) => value.isDirectory(), () => false))) return false
  const temporary = await realpath(tmpdir()).catch(() => tmpdir())
  if ([temporary, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].some((root) => contained(root, canonical))) return false
  return !/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(canonical)
}

export function contained(root: string, target: string, paths = { relative, isAbsolute, sep }): boolean {
  const path = paths.relative(root, target)
  return path === "" || (!paths.isAbsolute(path) && path !== ".." && !path.startsWith(`..${paths.sep}`) && !path.startsWith(paths.sep) && !path.startsWith("/"))
}

async function catalog(local: LocalServer, location: LocalLocation) {
  const [agents, models, model, providers, commands, skills, references, resources] = await Promise.all([
    local.agentList(location), local.modelList(location), local.modelDefault(location), local.providerList(location),
    local.commandList(location), local.skillList(location), local.referenceList(location), local.resourceCatalog(location),
  ])
  for (const [items, limit] of [
    [agents, catalogLimit.agents], [commands, catalogLimit.commands],
    [skills, catalogLimit.skills], [references, catalogLimit.references], [resources.resources, catalogLimit.resources],
  ] as const) if (items.length > limit) throw new OperationError("message_too_large", "Catalog exceeds its bounded list size")
  const connected = new Map(providers.filter((provider) => provider.disabled !== true).map((provider) => [provider.id, provider.name]))
  const offeredModels = models.filter((item) => connected.has(item.providerID) && (item.enabled || (item.profiles?.length ?? 0) > 0))
  return {
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, ...(agent.description === undefined ? {} : { description: agent.description }),
      mode: agent.mode, hidden: agent.hidden, ...(agent.model === undefined ? {} : { model: agent.model }) })),
    models: offeredModels.map((item) => ({
      providerID: item.providerID, providerName: connected.get(item.providerID), id: item.id, name: item.name,
      variants: item.variants.map((variant) => variant.id),
      ...(item.enabled ? {} : { enabled: false }),
      ...(item.profiles === undefined ? {} : { profiles: item.profiles.map((profile) => ({ name: profile.name, active: profile.active,
        ...(profile.variants === undefined ? {} : { variants: profile.variants }) })) }),
    })),
    ...(model === null ? {} : { defaultModel: model.selection }),
    commands: commands.map((command) => ({ name: command.name, ...(command.description === undefined ? {} : { description: command.description }) })),
    skills: skills.map((skill) => ({ id: skill.id, name: skill.name,
      ...(skill.description === undefined ? {} : { description: skill.description }), slash: skill.slash === true })),
    references: references.filter((reference) => reference.hidden !== true).map((reference) => ({ name: reference.name,
      uri: pathToFileURL(reference.path).href, ...(reference.description === undefined ? {} : { description: reference.description }) })),
    resources: resources.resources.map((resource) => ({ name: resource.name, uri: resource.uri,
      ...(resource.description === undefined ? {} : { description: resource.description }) })),
  }
}

async function findFiles(local: LocalServer, location: LocalLocation, query: string, limit: number) {
  const entries = await local.fileFind(location, query, limit)
  if (entries.length > limit) throw new OperationError("message_too_large", "File search exceeded the requested limit")
  return { files: entries.map((entry) => {
    const target = resolve(location.directory, entry.path)
    if (!contained(location.directory, target) || target === location.directory)
      throw new OperationError("invalid_message", "File search returned an invalid relative path")
    return { path: entry.path.split(sep).join("/"), uri: pathToFileURL(target).href, kind: entry.type }
  }) }
}

async function requireFileAttachments(local: LocalServer, location: LocalLocation, files: LocalPrompt["files"], uploads: ReturnType<typeof createAttachmentUploads> | undefined, sessionID: string) {
  if (files === undefined || files.length === 0) return files
  const fileURIs = files.map((file) => typeof file === "object" && file !== null ? Reflect.get(file, "uri") : undefined)
  const root = fileURIs.some((uri) => typeof uri === "string" && uri.startsWith("file:"))
    ? await realpath(location.directory).catch(() => undefined) : undefined
  const catalogRequired: string[] = []
  const resolvedUploads = new Map<string, string>()
  let uploadedBytes = 0
  for (const uri of fileURIs) {
    if (typeof uri !== "string") throw new OperationError("invalid_message", "Invalid attachment URI")
    if (uri.startsWith("ycoding-upload://")) {
      if (!uploads) throw new OperationError("invalid_message", "Attachment upload is unavailable")
      const resolved = resolvedUploads.get(uri) ?? uploads.resolve(sessionID, uri)
      resolvedUploads.set(uri, resolved)
      const encoded = resolved.slice("data:application/octet-stream;base64,".length)
      uploadedBytes += encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
      if (uploadedBytes > RemoteLimits.maxConnectionAttachmentBytes)
        throw new OperationError("message_too_large", "Expanded attachments exceed the local admission byte limit")
      continue
    }
    if (!uri.startsWith("file:")) {
      catalogRequired.push(uri)
      continue
    }
    const target = await Promise.resolve().then(() => fileURLToPath(uri)).then((path) => realpath(path), () => undefined).catch(() => undefined)
    if (root === undefined || target === undefined || !contained(root, target)) catalogRequired.push(uri)
  }
  if (catalogRequired.length) {
    const available = await catalog(local, location)
    const permitted = new Set([...available.references, ...available.resources].map((resource) => resource.uri))
    if (catalogRequired.some((uri) => !permitted.has(uri))) throw new OperationError("invalid_message", "Attachment is outside the Session Location and current catalog")
  }
  return files.map((file) => {
    if (typeof file !== "object" || file === null) throw new OperationError("invalid_message", "Invalid attachment")
    const uri = Reflect.get(file, "uri")
    return typeof uri === "string" && uri.startsWith("ycoding-upload://")
      ? { ...file, uri: resolvedUploads.get(uri)! }
      : file
  })
}

async function requireAgentMentions(local: LocalServer, location: LocalLocation, agents: LocalPrompt["agents"]) {
  if (!agents?.length) return
  const allowed = new Set((await local.agentList(location))
    .filter((agent) => !agent.hidden && agent.mode !== "primary" && agent.id !== "btw")
    .map((agent) => agent.id))
  if (agents.some((agent) => typeof agent !== "object" || agent === null || !allowed.has(Reflect.get(agent, "name"))))
    throw new OperationError("invalid_message", "Agent mention is unavailable at the Session Location")
}

function modelSelection(value: unknown): ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperationError("invalid_message", "Invalid model")
  if (Object.keys(value).some((key) => !["providerID", "id", "variant", "profile"].includes(key))) throw new OperationError("invalid_message", "Invalid model")
  const providerID = Reflect.get(value, "providerID")
  const id = Reflect.get(value, "id")
  const variant = Reflect.get(value, "variant")
  const profile = Reflect.get(value, "profile")
  return { providerID: requireString(providerID, "providerID", 128), id: requireString(id, "model.id", 128),
    ...(variant === undefined ? {} : { variant: requireString(variant, "variant", 128) }),
    ...(profile === undefined ? {} : { profile: requireString(profile, "profile", 128) }) }
}

async function createRootSession(input: OperationInput, id: string, workspaceID: string, agent?: string, model?: ModelSelection): Promise<SessionInfo> {
  const candidate = (await workspaceInventory(input)).find((item) => item.info.id === workspaceID)
  if (candidate === undefined) throw new OperationError("invalid_message", "Workspace is unavailable; refresh the workspace list and reopen it")
  if (!(await stat(candidate.location.directory).then((value) => value.isDirectory(), () => false)))
    throw new OperationError("invalid_message", "Workspace is unavailable; refresh the workspace list and reopen it")
  const currentProject = await input.local.projectCurrent(candidate.location)
  if (currentProject.id !== candidate.info.projectID)
    throw new OperationError("invalid_message", "Workspace project changed; refresh the workspace list and reopen it")
  return adoptOrCreateRoot(input, id, candidate, agent, model)
}

async function adoptOrCreateRoot(input: Pick<OperationInput, "local" | "sessions" | "signal">, id: string, candidate: WorkspaceCandidate, agent?: string, model?: ModelSelection): Promise<SessionInfo> {
  const existing = input.sessions.snapshot().find((session) => session.id === id) ?? await findSession(input.local, id)
  if (existing !== undefined) {
    assertRootPlacement(existing, id, candidate)
    const current = await input.local.getSession(id, locationInfo(existing))
    assertRootPlacement(current, id, candidate)
    await input.sessions.add(id, locationInfo(current))
    return current
  }

  const created = await input.local.createSession(id, candidate.location, agent, model)
  assertRootPlacement(created, id, candidate)
  await input.sessions.add(id, locationInfo(created))
  const verified = await input.sessions.verify(id, input.signal)
  if (verified === undefined) throw new OperationError("invalid_message", "Created Session is not available at the selected workspace")
  assertRootPlacement(verified, id, candidate)
  return verified
}

function assertRootPlacement(session: SessionInfo, id: string, candidate: WorkspaceCandidate) {
  if (
    session.id !== id ||
    session.projectID !== candidate.info.projectID ||
    session.parentID !== undefined ||
    session.location.directory !== candidate.location.directory ||
    session.location.workspaceID !== candidate.location.workspaceID
  )
    throw new OperationError("invalid_message", "Session ID belongs to a different placement; choose a new Session ID")
}

class OperationError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Frames already built while the operation checked their size, so they are serialized once. */
class PreparedFrames {
  constructor(readonly frames: readonly RemoteResponse[]) {}
}

export type OperationInput = {
  readonly request: RemoteRequest
  readonly signal?: AbortSignal
  readonly uploads?: ReturnType<typeof createAttachmentUploads>
  readonly sessions: SessionRegistry
  readonly subscriptions: SubscriptionRegistry
  readonly local: LocalServer
  readonly cache?: OperationCache
  readonly demo?: ReturnType<typeof RemoteMcpDemo.create>
  readonly apps?: ReturnType<typeof RemoteMcpApps.create>
  readonly appContext?: McpEvents.RequestContext
}

export async function executeRemoteOperation(input: OperationInput): Promise<readonly RemoteResponse[]> {
  return settle(input.request, () => run(input))
}

async function settle(request: RemoteRequest, work: () => Promise<unknown>): Promise<readonly RemoteResponse[]> {
  try {
    const value = await work()
    return value instanceof PreparedFrames ? value.frames : successFrames(request.id, value)
  } catch (cause) {
    if (cause instanceof ProviderAuthError) return [failureFrame(request.id, "invalid_message", cause.message)]
    if (cause instanceof OperationError) return [failureFrame(request.id, cause.code, cause.message)]
    if (cause instanceof LocalFailure) return [failureFrame(request.id, ...localError(cause, request))]
    return [failureFrame(request.id, "internal_error", "The local agent could not complete the request")]
  }
}

export type DirectorySessionInput = Omit<OperationInput, "request" | "uploads" | "cache"> & {
  readonly id: string
  readonly home: string
  readonly input: Readonly<Record<string, unknown>>
}

export async function executeRemoteDirectorySession(input: DirectorySessionInput): Promise<readonly RemoteResponse[]> {
  return settle({ type: "request", id: input.id, operation: "session.create" }, async () => {
    for (const key of Object.keys(input.input))
      if (!["id", "directory", "agent", "model"].includes(key)) throw new OperationError("invalid_message", `Unknown input field "${key}"`)
    const id = sessionID(input.input.id, "id")
    const directory = requireString(input.input.directory, "directory", 4_096)
    const agent = input.input.agent === undefined ? undefined : requireString(input.input.agent, "agent", 128)
    const model = input.input.model === undefined ? undefined : modelSelection(input.input.model)
    const location = { directory: await homeDescendant(input.home, directory) }
    const current = await input.local.projectCurrent(location)
    const candidate: WorkspaceCandidate = {
      location,
      info: { id: workspaceKey(current.id, location.directory), projectID: current.id, directory: location.directory, name: basename(location.directory) },
    }
    return { data: await adoptOrCreateRoot(input, id, candidate, agent, model) }
  })
}

async function homeDescendant(home: string, directory: string) {
  if (!isAbsolute(directory)) throw new OperationError("invalid_message", "Directory must be an absolute path")
  const root = await realpath(home).catch(() => undefined)
  if (root === undefined) throw new OperationError("internal_error", "The home directory is unavailable")
  const canonical = await realpath(directory).catch(() => undefined)
  if (canonical === undefined || !(await stat(canonical).then((value) => value.isDirectory(), () => false)))
    throw new OperationError("invalid_message", "Directory does not exist")
  const path = relative(root, canonical)
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new OperationError("invalid_message", "Directory must be strictly below the home directory")
  return canonical
}

async function run(input: OperationInput) {
  const request = input.request
  if (request.operation.startsWith("provider.auth.")) {
    const fields = parseProviderAuthInput(request.operation, request.input)
    if (!fields || request.sessionID !== undefined) throw new OperationError("invalid_message", "Invalid provider authentication request")
    const session = "sessionID" in fields.target ? await input.sessions.verify(fields.target.sessionID) : undefined
    if ("sessionID" in fields.target && !session) throw new OperationError("session_not_allowed", "Session is unavailable at its recorded Location")
    const workspace = "workspace" in fields.target ? (await workspaceInventory(input)).find((candidate) => "workspace" in fields.target && candidate.info.id === fields.target.workspace) : undefined
    if ("workspace" in fields.target && !workspace) throw new OperationError("invalid_message", "Workspace is unavailable")
    const location = session ? locationInfo(session) : workspace?.location
    if (!location || !input.cache) throw new OperationError("invalid_message", "Provider authentication is unavailable")
    if (workspace && (await input.local.projectCurrent(location)).id !== workspace.info.projectID) throw new OperationError("invalid_message", "Workspace project changed")
    return executeProviderAuth({ fields, location, local: input.local, attempts: input.cache.providerAuth, now: input.cache.now })
  }
  // Validation is complete before any local call, so a malformed request never
  // causes local side effects.
  const validated = validate(request)
  if (validated.kind === "local.app") {
    if (input.apps === undefined || input.appContext === undefined) return unknownOperation()
    if (request.sessionID === undefined || await input.sessions.renew(request.sessionID) === undefined)
      throw new OperationError("session_not_allowed", "Session is not available at its recorded location")
    const { RemoteMcpApps } = await import("./remote-mcp-apps")
    try {
      return await input.apps.execute(validated.operation, {
        sessionID: request.sessionID,
        ...(request.input === undefined ? {} : { input: request.input }),
      }, input.appContext, input.signal ?? new AbortController().signal)
    } catch (error) {
      if (error instanceof RemoteMcpApps.Error) throw new OperationError(
        error.reason === "too_large" ? "message_too_large" : error.reason === "access_unavailable" ? "forbidden"
          : error.reason === "rate_limited" ? "rate_limited" : error.reason === "authorization_unavailable" ? "agent_unavailable" : "invalid_message",
        `Registered app request failed: ${error.reason}`,
      )
      throw error
    }
  }
  if (validated.kind === "artifact.demo.preview" || validated.kind === "artifact.demo.export") {
    if (!input.demo) return unknownOperation()
    try {
      return input.demo.data(validated.kind)
    } catch (error) {
      if (error instanceof RemoteMcpDemo.ExpiredError) throw new OperationError("invalid_message", "Demo resource expired")
      throw error
    }
  }
  if (validated.kind === "workspace.list") return { data: validated.sessionsOnly
    ? await sessionWorkspaces(input.local, input.sessions.snapshot(), input.cache)
    : await workspaceList(input) }
  if (validated.kind === "workspace.catalog" || validated.kind === "workspace.file.find") {
    const candidate = (await workspaceInventory(input)).find((item) => item.info.id === validated.workspace)
    if (candidate === undefined) throw new OperationError("invalid_message", "Workspace is unavailable")
    const current = await input.local.projectCurrent(candidate.location)
    if (current.id !== candidate.info.projectID) throw new OperationError("invalid_message", "Workspace project changed")
    return validated.kind === "workspace.catalog" ? catalog(input.local, candidate.location) : findFiles(input.local, candidate.location, validated.query, validated.limit)
  }
  if (validated.kind === "session.create")
    return { data: await createRootSession(input, validated.id, validated.workspace, validated.agent, validated.model) }
  if (validated.kind === "list") {
    const sessions = input.sessions.snapshot()
    if (validated.query.status === undefined && validated.query.order !== "active") return listPage(sessions, validated.query)
    const cache = input.cache ?? createOperationCache()
    if (cache.listStatus === undefined || cache.listStatus.expiresAt <= cache.now()) {
      const observation = { expiresAt: Infinity, value: (async () => {
        const work = await input.local.outstandingSessions(false)
        const status = await sessionStatus(input.local, sessions, undefined, new Set(), work, false)
        return { running: new Set(work.running), waiting: new Set(status.requestAttention), lost: new Set(lossOnly(status)) }
      })() }
      cache.listStatus = observation
      void observation.value.then(() => { observation.expiresAt = cache.now() + 5_000 }, () => { if (cache.listStatus === observation) cache.listStatus = undefined })
    }
    const status = await cache.listStatus.value
    return listPage(sessions, validated.query, status.running, status.waiting, status.lost)
  }
  if (validated.kind === "active") {
    const allowed = new Set(input.sessions.ids())
    const active = await input.local.activeSessions()
    return { data: filterActiveSessions(active, allowed) }
  }
  if (validated.kind === "status") {
    const status = await sessionStatus(input.local, input.sessions.snapshot())
    const lost = lossOnly(status)
    const failed = status.failed.filter((id) => !status.requestAttention.includes(id) && !lost.includes(id)).sort()
    return { running: status.running, attention: status.attention,
      ...(status.outstanding === undefined ? {} : { outstanding: status.outstanding }),
      ...(failed.length === 0 ? {} : { failed }),
      ...(lost.length === 0 ? {} : { lost }) }
  }
  if (validated.kind === "usage.providers") return { data: (await input.local.providerUsageList(validated.refresh)).data }
  if (validated.kind === "usage.summary") return { data: await input.local.usageSummary() }
  if (validated.kind === "usage.report") return { data: await input.local.usageReport(validated.input) }
  if (validated.kind === "usage.forecast" && validated.localScope === "backend") return { data: (await input.local.usageForecast("backend")).data }
  if (validated.kind === "incident.report") return { data: await input.local.incidentReport(validated.input) }
  if (validated.kind === "incident.recent") return { data: await input.local.incidentRecent(validated.input) }
  if (validated.kind === "incident.guidance" && request.sessionID === undefined) return { data: await input.local.incidentGuidance(validated.input) }
  if (validated.kind === "incident.guidance.clear" && request.sessionID === undefined) return { data: await input.local.incidentGuidanceClear(validated.input) }
  if (validated.kind === "latency.append") return input.local.latencyAppend(validated.samples)
  if (validated.kind === "latency.list") return input.local.latencyList(validated.input)
  if (validated.kind === "keepAwake.get") return { data: await input.local.keepAwakeGet() }
  if (validated.kind === "keepAwake.set") return { data: await input.local.keepAwakeSet(validated.enabled) }
  if (validated.kind === "telemetryConsent.get") return { data: await input.local.telemetryConsentGet() }
  if (validated.kind === "telemetryConsent.set") return { data: await input.local.telemetryConsentSet({ enabled: validated.enabled, noticeVersion: 1 }) }
  if (validated.kind === "coordination") {
    const data = await executeCoordination(input, validated.operation, validated.input)
    return validated.operation === "coordination.delete" ? {} : { data }
  }
  if (!scopedOperation(request.operation)) return unknownOperation()
  const sessionID = request.sessionID
  if (sessionID === undefined) throw new OperationError("session_required", "Operation requires a session")
  // Verify the Session at its bound Location on every execution, so a moved or
  // deleted Session fails closed instead of being served from stale metadata.
  const verified = await input.sessions.verify(sessionID, input.signal).catch((cause: unknown) => {
    if (!(cause instanceof LocalFailure)) throw cause
    const error = localError(cause, { ...request, operation: "session.get" })
    throw new OperationError(error[0], isMutation(request)
      ? `Session verification failed; the request was not executed. ${error[1]}` : error[1])
  })
  if (verified === undefined)
    throw new OperationError("session_not_allowed", "Session is not available at its recorded location")
  if (verified.parentID !== undefined && verified.agent !== "btw" && [
    "session.prompt", "session.command", "session.compact", "session.skill", "session.attachment.upload",
    "session.switchModel", "session.switchAgent", "session.autonomy.set", "session.goal.set", "session.goal.stop",
    "incident.guidance.clear",
  ].includes(request.operation))
    throw new OperationError("subagent_read_only", "Managed subagents accept input only from their parent Session")
  const location = locationInfo(verified)
  if (validated.kind === "upload") {
    if (!input.uploads) throw new OperationError("invalid_message", "Attachment uploads are unavailable")
    return input.uploads.append(sessionID, validated.uploadID, validated.index, validated.last, validated.data)
  }
  switch (validated.kind) {
    case "session.usageReport":
      return { data: await input.local.sessionUsageReport(sessionID, location, validated.input) }
    case "session.promptCosts":
      return { data: await input.local.promptCosts(sessionID, location, validated.ids) }
    case "session.taskCosts":
      return { data: await input.local.taskCosts(sessionID, location, validated.ids) }
    case "usage.forecast":
      return { data: (await input.local.usageForecast("location", location)).data }
    case "incident.guidance":
      return { data: await input.local.incidentGuidance(validated.input, location) }
    case "incident.guidance.clear":
      return { data: await input.local.incidentGuidanceClear(validated.input, location) }
    case "get":
      return { data: verified }
    case "delete":
      await input.local.deleteSession(sessionID, location)
      return {}
    case "pending.list": {
      const pending = await input.local.pendingList(sessionID, location)
      if (!Array.isArray(pending) || pending.length > maxPendingInputs ||
        successFrames(request.id, { data: pending })[0]?.ok === false)
        throw new OperationError("message_too_large", "Pending Session inputs exceed the remote response bound")
      return { data: pending }
    }
    case "snapshot": {
      if (validated.limit === undefined) return await input.local.snapshot(sessionID, location)
      for (let limit = validated.limit;; limit = Math.max(1, Math.floor(limit / 2))) {
        const page = await input.local.snapshot(sessionID, location, { limit, ...(validated.before === undefined ? {} : { before: validated.before }) })
        const frames = successFrames(request.id, page)
        const first = frames[0]
        if (!first || first.ok || first.error.code !== "message_too_large") return new PreparedFrames(frames)
        if (limit === 1) throw new OperationError("message_too_large", "A single projected message exceeds the response bound")
      }
    }
    case "capturedChanges.list":
      return await capturedChangesPage(input, verified, sessionID, location, request.id, validated.cursor)
    case "attachment.read":
      return await input.local.attachmentRead(sessionID, location, validated.digest)
    case "message.stream":
      return await input.local.messageRead(sessionID, location, validated.messageID, input.signal)
    case "subagent.list":
      return await input.local.subagentPage(sessionID, location, validated.cursor)
    case "session.pin":
    case "session.unpin": {
      if (verified.parentID === undefined || verified.agent === "btw") throw new OperationError("forbidden", "Only managed child Sessions can be pinned through Team")
      const parent = await input.sessions.verify(verified.parentID)
      if (parent === undefined) throw new OperationError("session_not_allowed", "Parent Session is not available at its recorded location")
      return validated.kind === "session.pin" ? await input.local.pin(sessionID, location) : await input.local.unpin(sessionID, location)
    }
    case "subagent.cancel": {
      await requireFamilyMember(input, verified, validated.childID, true)
      return { data: await input.local.subagentCancel(sessionID, validated.childID, location) }
    }
    case "subagent.answer": {
      await requireFamilyMember(input, verified, validated.childID, true)
      return { data: await input.local.subagentAnswer(sessionID, validated.childID, validated.questionID, validated.text, location) }
    }
    case "team.economics": {
      const members = await Promise.all(validated.sessionIDs.map((id) => requireFamilyMember(input, verified, id, true)))
      return { data: await Promise.all(members.map(async (member) => {
        const raw = await input.local.diagnostics(member.id, locationInfo(member))
        const data = raw && typeof raw === "object" && "data" in raw ? raw.data : raw
        const details = data && typeof data === "object" ? data as { context?: { total?: number; limit?: number }; cache?: { hitRatio?: number; readReported?: boolean; writeReported?: boolean }; tokens?: { cacheRead?: number; cacheWrite?: number } } : undefined
        return { sessionID: member.id, cost: member.cost, tokens: member.tokens,
          ...(details?.context?.total === undefined ? {} : { contextTotal: details.context.total }),
          ...(details?.context?.limit === undefined ? {} : { contextLimit: details.context.limit }),
          ...(details?.cache?.hitRatio === undefined ? {} : { cacheHitRatio: details.cache.hitRatio }),
          ...(details?.cache?.readReported !== true || details.tokens?.cacheRead === undefined ? {} : { cacheRead: details.tokens.cacheRead }),
          ...(details?.cache?.writeReported !== true || details.tokens?.cacheWrite === undefined ? {} : { cacheWrite: details.tokens.cacheWrite }) }
      })) }
    }
    case "team.shell.list": {
      if (verified.parentID !== undefined) throw new OperationError("forbidden", "Team requires a root Session")
      const locations = await familyLocations(input, verified)
      const shells = (await Promise.all(locations.map(async (memberLocation) => ({ location: memberLocation, items: await input.local.shellList(memberLocation) })))).flatMap((entry) => entry.items.map((item) => ({ item, location: entry.location })))
      const owners = new Map<string, SessionInfo>()
      const visible: { id: string; ownerID: string; ownerAgent?: string; ownerTitle?: string; command: string; status: string; startedAt: number; completedAt?: number }[] = []
      let chars = serializeResponse({ type: "response", id: request.id, ok: true, value: { data: [], truncated: false } }).length
      for (const { item, location: shellLocation } of shells) {
        if (!item || typeof item !== "object" || !("metadata" in item) || !("id" in item)) continue
        const shell = item as { id: unknown; command?: unknown; status?: unknown; metadata: unknown; time?: { started?: number; completed?: number } }
        const ownerID = shell.metadata && typeof shell.metadata === "object" && "sessionID" in shell.metadata ? shell.metadata.sessionID : undefined
        if (typeof ownerID !== "string" || typeof shell.id !== "string") continue
        const owner = owners.get(ownerID) ?? await verifiedFamilyOwner(input, verified, ownerID)
        if (!owner || JSON.stringify(locationInfo(owner)) !== JSON.stringify(shellLocation)) continue
        owners.set(ownerID, owner)
        if (visible.length === 50) return { data: visible, truncated: true }
        const command = typeof shell.command === "string" ? shell.command : ""
        const row = { id: shell.id, ownerID, ...(owner.agent === undefined ? {} : { ownerAgent: owner.agent }), ...(owner.title === undefined ? {} : { ownerTitle: owner.title }),
          command: command.length > 256 ? `${command.slice(0, 255)}…` : command, status: typeof shell.status === "string" ? shell.status : "exited",
          startedAt: shell.time?.started ?? 0,
          ...(shell.time?.completed === undefined ? {} : { completedAt: shell.time.completed }) }
        const length = JSON.stringify(row).length + (visible.length === 0 ? 0 : 1)
        if (chars + length > RemoteLimits.maxAgentMessageChars) return { data: visible, truncated: true }
        chars += length
        visible.push(row)
      }
      return { data: visible, truncated: false }
    }
    case "team.shell.kill": {
      if (verified.parentID !== undefined) throw new OperationError("forbidden", "Team requires a root Session")
      for (const memberLocation of await familyLocations(input, verified)) {
        const shell = await input.local.shellGet(validated.shellID, memberLocation).catch((cause: unknown) => {
          if (cause instanceof LocalFailure && cause.kind === "not_found") return undefined
          throw cause
        })
        if (shell === undefined) continue
        const ownerID = typeof shell === "object" && shell !== null && "metadata" in shell && shell.metadata && typeof shell.metadata === "object" && "sessionID" in shell.metadata ? shell.metadata.sessionID : undefined
        if (typeof ownerID !== "string") throw new OperationError("forbidden", "Shell has no verified family owner")
        const member = await verifiedFamilyOwner(input, verified, ownerID)
        if (!member) throw new OperationError("forbidden", "Shell has no verified family owner")
        if (JSON.stringify(locationInfo(member)) !== JSON.stringify(memberLocation)) throw new OperationError("forbidden", "Shell Location does not match its family owner")
        await input.local.shellRemove(validated.shellID, memberLocation)
        return null
      }
      throw new OperationError("not_found", "Shell is not available in this family")
    }
    case "side-chat.list": {
      if (verified.parentID !== undefined) throw new OperationError("forbidden", "Side chats require a root Session")
      const page = await input.local.listChildren(sessionID, location, validated.cursor)
      return { ...page, data: page.data.filter((child) => child.parentID === sessionID && child.agent === "btw").map((child) => ({ id: child.id, title: child.title, updatedAt: child.time.updated })) }
    }
    case "side-chat.create": {
      if (verified.parentID !== undefined) throw new OperationError("forbidden", "Side chats require a root Session")
      return { data: await input.local.createSideChat(validated.id, sessionID, location) }
    }
    case "family.activity":
      return { data: await familyActivity(input, verified, validated.sessionIDs) }
    case "catalog":
      return catalog(input.local, location)
    case "file.find":
      return findFiles(input.local, location, validated.query, validated.limit)
    case "switchModel":
      await input.local.switchModel(sessionID, location, validated.model)
      return null
    case "switchAgent":
      await input.local.switchAgent(sessionID, location, validated.agent)
      return null
    case "command":
      await requireAgentMentions(input.local, location, validated.input.agents)
      return { data: await input.local.command(sessionID, location, { ...validated.input, ...(validated.input.files === undefined ? {} : { files: await requireFileAttachments(input.local, location, validated.input.files, input.uploads, sessionID) }) }) }
    case "skill":
      await input.local.skill(sessionID, location, validated.input)
      return null
    case "messages":
      return { data: await input.local.messages(sessionID, location) }
    case "compaction.list":
      return await input.local.compactionList(sessionID, location)
    case "todo.list":
      return { data: await input.local.todoList(sessionID, location) }
    case "autonomy.get":
      return { data: await input.local.autonomyGet(sessionID, location) }
    case "permission.list":
      return { data: await input.local.permissionList(sessionID, location) }
    case "guardrail.status":
      return { data: await input.local.guardrailStatus(sessionID, location) }
    case "review.list":
      return { data: await input.local.reviewList(sessionID, location) }
    case "review.decide": {
      const item = (await input.local.reviewList(sessionID, location)).find((candidate) => candidate.itemID === validated.itemID)
      if (item === undefined && !(validated.decision.kind === "recovery" && validated.decision.choice === "continue"))
        throw new OperationError("invalid_message", "That review item is no longer open; reload before deciding")
      if (item === undefined) await requireStoppedRecovery(input, verified, validated.itemID)
      if (item !== undefined && item.kind !== validated.decision.kind) throw new OperationError("invalid_message", "The decision does not match the review item")
      if (item?.kind === "guardrail" && item.payload.hardReview && "reply" in validated.decision && validated.decision.reply === "always")
        throw new OperationError("invalid_message", "Hard guardrail reviews accept only once or reject")
      await input.local.reviewDecide(sessionID, location, validated.itemID, validated.decision)
      return null
    }
    case "guardrail.request.list": {
      const listing = await input.local.guardrailRequestList(sessionID, location)
      return { data: asReviewList(listing) }
    }
    case "form.list":
      return await input.local.formList(sessionID, location)
    case "shell.output": {
      // Ownership is proven from the shell's own recorded Session before any output
      // byte is read, so a granted Session can never page another Session's capture.
      const shell = await requireOwnedShell(input, sessionID, location, validated.shellID)
      return {
        ...shell,
        data: await input.local.shellOutput(validated.shellID, location, {
          ...(validated.cursor === undefined ? {} : { cursor: validated.cursor }),
          limit: validated.limit,
        }),
      }
    }
    case "log": {
      const items = await input.local.log(sessionID, location, validated.after)
      if (items.length > maxLogReadItems)
        throw new OperationError("message_too_large", "Session log read exceeded the bounded item count; read again with after")
      return { data: items }
    }
    case "subscribe":
      return null
    case "unsubscribe":
      return null
    case "prompt":
      await requireAgentMentions(input.local, location, validated.input.agents)
      return { data: await input.local.prompt(sessionID, location, { ...validated.input, ...(validated.input.files === undefined ? {} : { files: await requireFileAttachments(input.local, location, validated.input.files, input.uploads, sessionID) }) }) }
    case "interrupt":
      await input.local.interrupt(sessionID, location)
      return null
    case "prediction":
      return input.local.prediction(sessionID, location, {
        memory: validated.memory,
        ...(validated.hint === undefined ? {} : { hint: validated.hint }),
      })
    case "promptGenerate":
      return input.local.promptGenerate(sessionID, location, {
        mode: validated.mode,
        intent: validated.intent,
        memory: validated.memory,
      })
    case "compact":
      return { data: await input.local.compact(sessionID, location, validated.id) }
    case "permission.reply":
      await input.local.permissionReply(
        sessionID,
        location,
        validated.requestID,
        validated.reply,
        validated.message,
      )
      return null
    case "guardrail.reply":
      await requireOwnedReview(input, sessionID, location, validated.requestID)
      await input.local.guardrailReply(sessionID, location, validated.requestID, validated.reply)
      return null
    case "form.reply":
      await requireOwnedForm(input, sessionID, location, validated.formID)
      await input.local.formReply(sessionID, location, validated.formID, validated.answer)
      return null
    case "form.cancel":
      await requireOwnedForm(input, sessionID, location, validated.formID)
      await input.local.formCancel(sessionID, location, validated.formID)
      return null
    case "autonomy.set":
      return { data: await input.local.autonomySet(sessionID, location, validated.payload) }
    case "goal.set":
      return { data: await input.local.autonomySet(sessionID, location, validated.payload) }
    case "goal.stop":
      return { data: await input.local.autonomySet(sessionID, location, { goal: null }) }
    default:
      return unknownOperation()
  }
}

function unknownOperation(): never {
  throw new OperationError("unknown_operation", "Operation is not proxied by this agent")
}

type Reply = "once" | "always" | "reject"

type Validated =
  | { readonly kind: "local.app"; readonly operation: RemoteMcpApps.Operation }
  | { readonly kind: "artifact.demo.preview" | "artifact.demo.export" }
  | { readonly kind: "latency.append"; readonly samples: readonly RemoteLatencySample[] }
  | { readonly kind: "latency.list"; readonly input: { readonly limit?: number; readonly before?: string } }
  | { readonly kind: "keepAwake.get" }
  | { readonly kind: "keepAwake.set"; readonly enabled: boolean }
  | { readonly kind: "telemetryConsent.get" }
  | { readonly kind: "telemetryConsent.set"; readonly enabled: boolean }
  | { readonly kind: "compact"; readonly id: string }
  | { readonly kind: "workspace.list"; readonly sessionsOnly: boolean }
  | { readonly kind: "list"; readonly query: ListQuery }
  | { readonly kind: "active" }
  | { readonly kind: "status" }
  | { readonly kind: "usage.providers"; readonly refresh?: boolean }
  | { readonly kind: "usage.summary" }
  | { readonly kind: "usage.report"; readonly input: RemoteUsageReportInput }
  | { readonly kind: "session.usageReport"; readonly input: RemoteUsageReportInput }
  | { readonly kind: "session.promptCosts" | "session.taskCosts"; readonly ids: readonly [string, ...string[]] }
  | { readonly kind: "usage.forecast"; readonly localScope: "backend" | "location" }
  | { readonly kind: "incident.report"; readonly input: RemoteIncidentReportInput }
  | { readonly kind: "incident.recent"; readonly input: RemoteIncidentRecentInput }
  | { readonly kind: "incident.guidance" | "incident.guidance.clear"; readonly input: RemoteIncidentGuidanceInput }
  | { readonly kind: "session.create"; readonly id: string; readonly workspace: string; readonly agent?: string; readonly model?: ModelSelection }
  | { readonly kind: "workspace.catalog"; readonly workspace: string }
  | { readonly kind: "workspace.file.find"; readonly workspace: string; readonly query: string; readonly limit: number }
  | { readonly kind: "catalog" }
  | { readonly kind: "file.find"; readonly query: string; readonly limit: number }
  | { readonly kind: "switchModel"; readonly model: ModelSelection }
  | { readonly kind: "switchAgent"; readonly agent: string }
  | { readonly kind: "upload"; readonly uploadID: string; readonly index: number; readonly last: boolean; readonly data: string }
  | { readonly kind: "command"; readonly input: CommandInput }
  | { readonly kind: "skill"; readonly input: { readonly id?: string; readonly skill: string; readonly resume?: boolean } }
  | { readonly kind: "get" }
  | { readonly kind: "delete" }
  | { readonly kind: "snapshot"; readonly limit?: number; readonly before?: string }
  | { readonly kind: "capturedChanges.list"; readonly cursor?: string }
  | { readonly kind: "attachment.read"; readonly digest: string }
  | { readonly kind: "message.stream"; readonly messageID: string }
  | { readonly kind: "subagent.list"; readonly cursor?: string }
  | { readonly kind: "session.pin" | "session.unpin" }
  | { readonly kind: "subagent.cancel"; readonly childID: string }
  | { readonly kind: "subagent.answer"; readonly childID: string; readonly questionID: string; readonly text: string }
  | { readonly kind: "team.economics"; readonly sessionIDs: readonly string[] }
  | { readonly kind: "team.shell.list" }
  | { readonly kind: "team.shell.kill"; readonly shellID: string }
  | { readonly kind: "side-chat.list"; readonly cursor?: string }
  | { readonly kind: "side-chat.create"; readonly id: string }
  | { readonly kind: "family.activity"; readonly sessionIDs: readonly string[] }
  | { readonly kind: "messages" }
  | { readonly kind: "compaction.list" }
  | { readonly kind: "todo.list" }
  | { readonly kind: "autonomy.get" }
  | { readonly kind: "permission.list" }
  | { readonly kind: "guardrail.status" }
  | { readonly kind: "guardrail.request.list" }
  | { readonly kind: "form.list" }
  | { readonly kind: "shell.output"; readonly shellID: string; readonly cursor?: number; readonly limit: number }
  | { readonly kind: "log"; readonly after?: number }
  | { readonly kind: "subscribe" }
  | { readonly kind: "pending.list" }
  | { readonly kind: "unsubscribe" }
  | { readonly kind: "prompt"; readonly input: LocalPrompt }
  | { readonly kind: "interrupt" }
  | { readonly kind: "prediction"; readonly memory: readonly ("repository" | "knowledge")[]; readonly hint?: string }
  | { readonly kind: "promptGenerate"; readonly mode: "start" | "steer" | "queue" | "goal"; readonly intent: string; readonly memory: readonly ("repository" | "knowledge")[] }
  | { readonly kind: "permission.reply"; readonly requestID: string; readonly reply: Reply; readonly message?: string }
  | { readonly kind: "guardrail.reply"; readonly requestID: string; readonly reply: Reply }
  | { readonly kind: "form.reply"; readonly formID: string; readonly answer: FormAnswer }
  | { readonly kind: "form.cancel"; readonly formID: string }
  | { readonly kind: "autonomy.set"; readonly payload: LocalAutonomy }
  | { readonly kind: "goal.set"; readonly payload: LocalAutonomy }
  | { readonly kind: "goal.stop" }
  | { readonly kind: "review.list" }
  | { readonly kind: "review.decide"; readonly itemID: string; readonly decision: ReviewDecision }
  | { readonly kind: "coordination"; readonly operation: RemoteOperation; readonly input?: Readonly<Record<string, unknown>> }

const plainKinds: Readonly<Record<string, Validated["kind"]>> = {
  "session.get": "get",
  "session.delete": "delete",
  "session.pending.list": "pending.list",
  "session.catalog": "catalog",
  "session.messages": "messages",
  "session.capturedChanges.list": "capturedChanges.list",
  "session.compaction.list": "compaction.list",
  "session.todo.list": "todo.list",
  "session.autonomy.get": "autonomy.get",
  "session.permission.list": "permission.list",
  "session.guardrail.status": "guardrail.status",
  "session.guardrail.request.list": "guardrail.request.list",
  "session.review.list": "review.list",
  "session.form.list": "form.list",
  "session.subscribe": "subscribe",
  "session.unsubscribe": "unsubscribe",
  "session.interrupt": "interrupt",
  "session.team.shell.list": "team.shell.list",
}

function coordinationRecord(value: unknown, field: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperationError("invalid_message", `Invalid ${field}`)
  const fields = value as Readonly<Record<string, unknown>>
  for (const key of Object.keys(fields)) if (!keys.includes(key)) throw new OperationError("invalid_message", `Unknown ${field} field "${key}"`)
  return fields
}

function coordinationInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const parsed = optionalInteger(value, field, minimum, maximum)
  if (parsed === undefined) throw new OperationError("invalid_message", `Invalid ${field}`)
  return parsed
}

function coordinationIDOf(value: unknown, prefix: string, field: string): string {
  const id = requireString(value, field, 96)
  if (!id.startsWith(prefix) || id.length === prefix.length || !/^[A-Za-z0-9_-]+$/.test(id.slice(prefix.length)))
    throw new OperationError("invalid_message", `Invalid ${field}`)
  return id
}

function coordinationTexts(value: unknown, field: string, maxItems: number, maxChars: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new OperationError("invalid_message", `Invalid ${field}`)
  return value.map((item) => requireString(item, field, maxChars))
}

function coordinationDelegated(value: unknown) {
  const fields = coordinationRecord(value, "delegatedDecisions", ["categories", "actions", "resources", "expiresAt"])
  if (!Array.isArray(fields.categories) || fields.categories.length > 3) throw new OperationError("invalid_message", "Invalid delegatedDecisions categories")
  return {
    categories: fields.categories.map((category) => literal(category, ["question", "permission", "review"] as const, "categories")),
    ...(fields.actions === undefined ? {} : { actions: coordinationTexts(fields.actions, "actions", 32, 512) }),
    ...(fields.resources === undefined ? {} : { resources: coordinationTexts(fields.resources, "resources", 32, 512) }),
    ...(fields.expiresAt === undefined ? {} : { expiresAt: coordinationInteger(fields.expiresAt, "expiresAt", 0, Number.MAX_SAFE_INTEGER) }),
  }
}

function coordinationSettings(value: unknown) {
  const fields = coordinationRecord(value, "settings", ["concurrency", "delegatedDecisions"])
  return {
    concurrency: fields.concurrency === null ? null : coordinationInteger(fields.concurrency, "concurrency", 1, Number.MAX_SAFE_INTEGER),
    ...(fields.delegatedDecisions === undefined ? {} : { delegatedDecisions: coordinationDelegated(fields.delegatedDecisions) }),
  }
}

function coordinationMemberSessionIDs(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) throw new OperationError("invalid_message", "Invalid memberSessionIDs")
  return value.map((id) => sessionID(id, "memberSessionIDs"))
}

function coordinationPayload(operation: RemoteOperation, fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  if (operation === "coordination.settings" || operation === "coordination.list") return undefined
  if (operation === "coordination.create")
    return { name: requireString(fields.name, "name", 120), masterSessionID: sessionID(fields.masterSessionID, "masterSessionID"), memberSessionIDs: coordinationMemberSessionIDs(fields.memberSessionIDs) }
  const groupID = coordinationIDOf(fields.groupID, "cgrp_", "groupID")
  if (operation === "coordination.get" || operation === "coordination.delete") return { groupID }
  const revision = coordinationInteger(fields.revision, "revision", 0, Number.MAX_SAFE_INTEGER)
  if (operation === "coordination.update")
    return { groupID, revision,
      ...(fields.name === undefined ? {} : { name: requireString(fields.name, "name", 120) }),
      ...(fields.masterSessionID === undefined ? {} : { masterSessionID: sessionID(fields.masterSessionID, "masterSessionID") }),
      ...(fields.memberSessionIDs === undefined ? {} : { memberSessionIDs: coordinationMemberSessionIDs(fields.memberSessionIDs) }),
      ...(fields.settings === undefined ? {} : { settings: coordinationSettings(fields.settings) }) }
  return unknownOperation()
}

async function executeCoordination(input: OperationInput, operation: RemoteOperation, payload: Readonly<Record<string, unknown>> | undefined) {
  const local = input.local
  if (operation === "coordination.settings") return local.coordinationSettings()
  if (operation === "coordination.list") return local.coordinationList()
  if (payload === undefined) return unknownOperation()
  if (operation === "coordination.create" || operation === "coordination.update") {
    const ids = [...(payload.memberSessionIDs as readonly string[] | undefined ?? []), ...(typeof payload.masterSessionID === "string" ? [payload.masterSessionID] : [])]
    for (const id of ids)
      if (await input.sessions.verify(id, input.signal) === undefined)
        throw new OperationError("session_not_allowed", "A Project Session is not available at its recorded location")
    return operation === "coordination.create"
      ? local.coordinationCreate(payload as Parameters<LocalServer["coordinationCreate"]>[0])
      : local.coordinationUpdate(payload as Parameters<LocalServer["coordinationUpdate"]>[0])
  }
  if (operation === "coordination.get") return local.coordinationGet(payload as Parameters<LocalServer["coordinationGet"]>[0])
  if (operation === "coordination.delete") return local.coordinationDelete(payload as Parameters<LocalServer["coordinationDelete"]>[0])
  return unknownOperation()
}

export async function coordinationCoordinatorMap(local: LocalServer): Promise<ReadonlyMap<string, readonly string[]>> {
  const summaries = await local.coordinationList()
  const map = new Map<string, string[]>()
  if (!Array.isArray(summaries)) return map
  for (const summary of summaries) {
    const id = summary.masterSessionID
    if (typeof id === "string") map.set(id, [id])
  }
  return map
}

function validate(request: RemoteRequest): Validated {
  const fields = validateFields(request)
  if (request.operation.startsWith("coordination.")) {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Coordination operations do not accept a Session")
    return { kind: "coordination", operation: request.operation, input: coordinationPayload(request.operation, fields) }
  }
  if ((localAppOperations as readonly string[]).includes(request.operation))
    return { kind: "local.app", operation: request.operation as RemoteMcpApps.Operation }
  if (request.operation === "artifact.demo.preview" || request.operation === "artifact.demo.export") {
    if (request.sessionID !== undefined || request.input !== undefined) throw new OperationError("invalid_message", "Fixed demo does not accept a Session or input")
    return { kind: request.operation }
  }
  if (request.operation === "machine.latency.append" || request.operation === "machine.latency.list") {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Machine latency does not accept a Session")
    if (request.operation === "machine.latency.append") {
      if (!Array.isArray(fields.samples) || fields.samples.length < 1 || fields.samples.length > RemoteLimits.maxLatencyBatch ||
        !fields.samples.every(isRemoteLatencySample)) throw new OperationError("invalid_message", "Invalid latency samples")
      return { kind: "latency.append", samples: fields.samples }
    }
    if (fields.limit !== undefined && (typeof fields.limit !== "number" || !Number.isSafeInteger(fields.limit) || fields.limit < 1 || fields.limit > RemoteLimits.maxLatencyPage))
      throw new OperationError("invalid_message", "Invalid latency page limit")
    if (fields.before !== undefined && (typeof fields.before !== "string" || fields.before.length < 1 || fields.before.length > 256))
      throw new OperationError("invalid_message", "Invalid latency cursor")
    return { kind: "latency.list", input: { ...(fields.limit === undefined ? {} : { limit: fields.limit }), ...(fields.before === undefined ? {} : { before: fields.before }) } }
  }
  if (request.operation === "machine.keepAwake.get" || request.operation === "machine.keepAwake.set") {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Machine controls do not accept a Session")
    if (request.operation === "machine.keepAwake.set") return { kind: "keepAwake.set", enabled: requireBoolean(fields.enabled, "enabled") }
    if (request.input !== undefined) throw new OperationError("invalid_message", "Keep-awake status does not accept input")
    return { kind: "keepAwake.get" }
  }
  if (request.operation === "machine.telemetry.consent.get" || request.operation === "machine.telemetry.consent.set") {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Machine telemetry consent does not accept a Session")
    if (request.operation === "machine.telemetry.consent.get") {
      if (request.input !== undefined) throw new OperationError("invalid_message", "Telemetry consent status does not accept input")
      return { kind: "telemetryConsent.get" }
    }
    if (fields.noticeVersion !== 1 || Object.keys(fields).length !== 2) throw new OperationError("invalid_message", "Invalid telemetry consent input")
    return { kind: "telemetryConsent.set", enabled: requireBoolean(fields.enabled, "enabled") }
  }
  if (request.operation === "session.attachment.upload") {
    if (typeof fields.uploadID !== "string" || typeof fields.index !== "number" || typeof fields.last !== "boolean" || typeof fields.data !== "string")
      throw new OperationError("invalid_message", "Invalid attachment upload")
    return { kind: "upload", uploadID: fields.uploadID, index: fields.index, last: fields.last, data: fields.data }
  }
  if (request.operation === "session.snapshot") {
    const limit = optionalInteger(fields.limit, "limit", 1, 200)
    const before = fields.before === undefined ? undefined : requireString(fields.before, "before", 256)
    if (before !== undefined && limit === undefined) throw new OperationError("invalid_message", "Snapshot cursor requires a limit")
    return { kind: "snapshot", ...(limit === undefined ? {} : { limit }), ...(before === undefined ? {} : { before }) }
  }
  if (request.operation === "session.capturedChanges.list") return { kind: "capturedChanges.list", cursor: fields.cursor === undefined ? undefined : requireString(fields.cursor, "cursor", 256) }
  if (request.operation === "session.attachment.read") {
    if (typeof fields.digest !== "string" || !/^[0-9a-f]{64}$/.test(fields.digest))
      throw new OperationError("invalid_message", "Invalid managed attachment digest")
    return { kind: "attachment.read", digest: fields.digest }
  }
  if (request.operation === "session.message.stream") return { kind: "message.stream", messageID: messageID(fields.messageID) }
  if (request.operation === "workspace.list") return { kind: "workspace.list", sessionsOnly: fields.sessionsOnly === true }
  if (request.operation === "session.list") return { kind: "list", query: parseListQuery(fields) }
  if (request.operation === "session.active") return { kind: "active" }
  if (request.operation === "session.status") return { kind: "status" }
  if (request.operation === "usage.providers") return { kind: "usage.providers",
    ...(fields.refresh === undefined ? {} : { refresh: requireBoolean(fields.refresh, "refresh") }) }
  if (request.operation === "usage.summary") return { kind: "usage.summary" }
  if (request.operation === "usage.forecast") {
    const localScope = literal(fields.localScope, ["backend", "location"], "localScope")
    if ((localScope === "location") !== (request.sessionID !== undefined)) throw new OperationError("invalid_message", "Forecast scope requires the owning Session Location")
    return { kind: "usage.forecast", localScope }
  }
  if (request.operation === "session.promptCosts" || request.operation === "session.taskCosts") {
    const ids = request.operation === "session.promptCosts" ? fields.inputIDs : fields.sessionIDs
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) throw new OperationError("invalid_message", "Accounting lookup requires 1–100 distinct IDs")
    const parsed = ids.map((id) => request.operation === "session.promptCosts" ? messageID(id) : sessionID(id, "sessionIDs"))
    const first = parsed[0]
    if (first === undefined) throw new OperationError("invalid_message", "Accounting lookup requires an ID")
    return { kind: request.operation, ids: [first, ...parsed.slice(1)] }
  }
  if (request.operation === "usage.report" || request.operation === "session.usageReport") {
    const group = literal(fields.group, ["model", "hour", "day", "month", "session", "project", "agent", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"], "group")
    const from = optionalInteger(fields.from, "from", 0, Number.MAX_SAFE_INTEGER)
    const to = optionalInteger(fields.to, "to", 0, Number.MAX_SAFE_INTEGER)
    if (from !== undefined && to !== undefined && from >= to) throw new OperationError("invalid_message", "Usage report from must precede to")
    return { kind: request.operation, input: { group,
      ...(fields.providerID === undefined ? {} : { providerID: requireString(fields.providerID, "providerID", 128) }),
      ...(fields.profile === undefined ? {} : { profile: requireString(fields.profile, "profile", 128) }),
      ...(fields.modelID === undefined ? {} : { modelID: requireString(fields.modelID, "modelID", 128) }),
      ...(fields.selectedEffort === undefined ? {} : { selectedEffort: requireString(fields.selectedEffort, "selectedEffort", 128) }),
      ...(fields.timeZone === undefined ? {} : { timeZone: requireString(fields.timeZone, "timeZone", 128) }),
      ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
      ...(fields.offset === undefined ? {} : { offset: optionalInteger(fields.offset, "offset", 0, Number.MAX_SAFE_INTEGER)! }),
      ...(fields.limit === undefined ? {} : { limit: optionalInteger(fields.limit, "limit", 1, 200)! }),
      ...(fields.sort === undefined ? {} : { sort: literal(fields.sort, ["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"], "sort") }),
      ...(fields.order === undefined ? {} : { order: literal(fields.order, ["asc", "desc"], "order") }),
    } }
  }
  if (request.operation === "incident.report") {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Incident report does not accept a Session")
    const from = optionalInteger(fields.from, "from", 0, Number.MAX_SAFE_INTEGER)
    const to = optionalInteger(fields.to, "to", 0, Number.MAX_SAFE_INTEGER)
    if (from !== undefined && to !== undefined && from > to) throw new OperationError("invalid_message", "Incident report from must not follow to")
    return { kind: "incident.report", input: { group: literal(fields.group, ["model", "agent"], "group"),
      ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
      ...(fields.offset === undefined ? {} : { offset: optionalInteger(fields.offset, "offset", 0, Number.MAX_SAFE_INTEGER)! }),
      ...(fields.limit === undefined ? {} : { limit: optionalInteger(fields.limit, "limit", 1, 200)! }) } }
  }
  if (request.operation === "incident.recent") {
    if (request.sessionID !== undefined) throw new OperationError("invalid_message", "Incident recent does not accept a Session")
    return { kind: "incident.recent", input: { provider: requireString(fields.provider, "provider", 128), model: requireString(fields.model, "model", 128),
      ...(fields.agent === undefined ? {} : { agent: requireString(fields.agent, "agent", 128) }),
      ...(fields.limit === undefined ? {} : { limit: optionalInteger(fields.limit, "limit", 1, 50)! }) } }
  }
  if (request.operation === "incident.guidance" || request.operation === "incident.guidance.clear")
    return { kind: request.operation, input: { provider: requireString(fields.provider, "provider", 128), model: requireString(fields.model, "model", 128) } }
  if (request.operation === "workspace.catalog") return { kind: "workspace.catalog", workspace: requireString(fields.workspace, "workspace", 128) }
  if (request.operation === "workspace.file.find" || request.operation === "session.file.find") {
    const query = requireString(fields.query, "query", 200)
    const limit = optionalInteger(fields.limit, "limit", 1, 50) ?? 20
    return request.operation === "workspace.file.find" ? { kind: "workspace.file.find", workspace: requireString(fields.workspace, "workspace", 128), query, limit } : { kind: "file.find", query, limit }
  }
  if (request.operation === "session.subagent.list") return { kind: "subagent.list", cursor: fields.cursor === undefined ? undefined : requireString(fields.cursor, "cursor", 1_024) }
  if (request.operation === "session.pin" || request.operation === "session.unpin") return { kind: request.operation }
  if (request.operation === "session.subagent.cancel") return { kind: "subagent.cancel", childID: sessionID(fields.childID, "childID") }
  if (request.operation === "session.review.decide") {
    const itemID = requireString(fields.itemID, "itemID", 128)
    if (!isRemoteReviewItemID(itemID)) throw new OperationError("invalid_message", "Invalid review item ID")
    return { kind: "review.decide", itemID, decision: reviewDecision(fields.decision) }
  }
  if (request.operation === "session.subagent.answer") {
    const questionID = requireString(fields.questionID, "questionID", 128)
    if (!/^qst_[A-Za-z0-9_-]+$/.test(questionID)) throw new OperationError("invalid_message", "Invalid question ID")
    return { kind: "subagent.answer", childID: sessionID(fields.childID, "childID"), questionID, text: requireString(fields.text, "text", 8_192) }
  }
  if (request.operation === "session.team.economics") {
    if (!Array.isArray(fields.sessionIDs) || fields.sessionIDs.length === 0 || fields.sessionIDs.length >= RemoteLimits.maxFamilyMembers ||
      fields.sessionIDs.some((id) => typeof id !== "string" || !isSessionID(id)) || new Set(fields.sessionIDs).size !== fields.sessionIDs.length)
      throw new OperationError("invalid_message", "Invalid economics member list")
    return { kind: "team.economics", sessionIDs: fields.sessionIDs }
  }
  if (request.operation === "session.team.shell.kill") return { kind: "team.shell.kill", shellID: shellID(fields.shellID) }
  if (request.operation === "session.side-chat.list") return { kind: "side-chat.list", cursor: fields.cursor === undefined ? undefined : requireString(fields.cursor, "cursor", 1_024) }
  if (request.operation === "session.side-chat.create") return { kind: "side-chat.create", id: sessionID(fields.id, "id") }
  if (request.operation === "session.family.activity") {
    if (!Array.isArray(fields.sessionIDs) || fields.sessionIDs.length >= RemoteLimits.maxFamilyMembers ||
      fields.sessionIDs.some((id) => typeof id !== "string" || !isSessionID(id) || id === request.sessionID) ||
      new Set(fields.sessionIDs).size !== fields.sessionIDs.length)
      throw new OperationError("invalid_message", "Invalid family member list")
    return { kind: "family.activity", sessionIDs: fields.sessionIDs }
  }
  if (request.operation === "session.create")
    return {
      kind: "session.create",
      id: sessionID(fields.id, "id"),
      workspace: requireString(fields.workspace, "workspace", 128),
      ...(fields.agent === undefined ? {} : { agent: requireString(fields.agent, "agent", 128) }),
      ...(fields.model === undefined ? {} : { model: modelSelection(fields.model) }),
    }
  const plain = plainKinds[request.operation]
  if (plain !== undefined) return { kind: plain } as Validated
  switch (request.operation) {
    case "session.compact": {
      const id = requireString(fields.id, "id", 128)
      if (!/^cmp_[A-Za-z0-9_-]+$/.test(id)) throw new OperationError("invalid_message", "Invalid compaction ID")
      return { kind: "compact", id }
    }
    case "session.switchModel": return { kind: "switchModel", model: modelSelection(fields.model) }
    case "session.switchAgent": return { kind: "switchAgent", agent: requireString(fields.agent, "agent", 128) }
    case "session.command": return { kind: "command", input: {
      ...(fields.id === undefined ? {} : { id: messageID(fields.id) }),
      command: requireString(fields.command, "command", 256),
      ...(fields.arguments === undefined ? {} : { arguments: requireString(fields.arguments, "arguments", 8_192, { allowEmpty: true }) }),
      ...(fields.files === undefined ? {} : { files: fileAttachments(fields.files) }),
      ...(fields.agents === undefined ? {} : { agents: agentAttachments(fields.agents) }),
      ...(fields.delivery === undefined ? {} : { delivery: delivery(fields.delivery) }),
    } }
    case "session.skill": return { kind: "skill", input: {
      ...(fields.id === undefined ? {} : { id: messageID(fields.id) }),
      skill: requireString(fields.skill, "skill", 128),
      ...(fields.resume === undefined ? {} : { resume: requireBoolean(fields.resume, "resume") }),
    } }
    case "session.log":
      return { kind: "log", after: optionalInteger(fields.after, "after", 0, Number.MAX_SAFE_INTEGER) }
    case "session.shell.output": {
      const cursor = optionalInteger(fields.cursor, "cursor", 0, Number.MAX_SAFE_INTEGER)
      return {
        kind: "shell.output",
        shellID: shellID(fields.shellID),
        ...(cursor === undefined ? {} : { cursor }),
        limit: optionalInteger(fields.limit, "limit", 1, maxShellOutputPage) ?? maxShellOutputPage,
      }
    }
    case "session.prediction":
      return { kind: "prediction", ...predictionInput(fields) }
    case "session.promptGenerate":
      return { kind: "promptGenerate", ...promptGenerateInput(fields) }
    case "session.prompt":
      return {
        kind: "prompt",
        input: {
          ...(fields.id === undefined ? {} : { id: messageID(fields.id) }),
          text: requireString(fields.text, "text", 32_768, { allowEmpty: true }),
          ...(fields.files === undefined ? {} : { files: fileAttachments(fields.files) }),
          ...(fields.agents === undefined ? {} : { agents: agentAttachments(fields.agents) }),
          ...(fields.skills === undefined ? {} : { metadata: { skills: promptSkills(fields.skills) } }),
          ...(fields.delivery === undefined ? {} : { delivery: delivery(fields.delivery) }),
          ...(fields.resume === undefined ? {} : { resume: requireBoolean(fields.resume, "resume") }),
        },
      }
    case "session.permission.reply":
      return {
        kind: "permission.reply",
        requestID: requestIDOf(fields.requestID, "per_"),
        reply: reply(fields.reply),
        ...(fields.message === undefined
          ? {}
          : { message: requireString(fields.message, "message", 1_024, { allowEmpty: true }) }),
      }
    case "session.guardrail.reply":
      return { kind: "guardrail.reply", requestID: requestIDOf(fields.requestID, "grq_"), reply: reply(fields.reply) }
    case "session.form.reply":
      return { kind: "form.reply", formID: formID(fields.formID), answer: formAnswer(fields.answer) }
    case "session.form.cancel":
      return { kind: "form.cancel", formID: formID(fields.formID) }
    case "session.autonomy.set":
      return { kind: "autonomy.set", payload: autonomyPayload(fields) }
    case "session.goal.set":
      return {
        kind: "goal.set",
        payload: {
          goal: requireString(fields.goal, "goal", 8_192),
          ...(fields.yolo === undefined ? {} : { yolo: requireBoolean(fields.yolo, "yolo") }),
          ...maxNoProgress(fields),
        },
      }
    case "session.goal.stop":
      if (fields.goal !== undefined && fields.goal !== null)
        throw new OperationError("invalid_message", "goal.stop accepts only goal: null")
      return { kind: "goal.stop" }
    default:
      return unknownOperation()
  }
}

/**
 * A shell read is served only for the Session that owns the shell. The owning
 * Session is read from the shell's own metadata at the bound Location; a shell
 * with no recorded owner, or one owned by another Session, is refused before any
 * output page is requested.
 */
async function requireOwnedShell(
  input: OperationInput,
  sessionID: string,
  location: LocalLocation,
  shellID: string,
) {
  const info = await input.local.shellGet(shellID, location)
  const metadata = typeof info === "object" && info !== null ? Reflect.get(info, "metadata") : undefined
  const owner = typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "sessionID") : undefined
  if (owner !== sessionID)
    throw new OperationError("forbidden", "That shell does not belong to the authorized Session")
  const command: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "command") : undefined
  const status: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "status") : undefined
  return { ...(typeof command === "string" ? { command } : {}), ...(typeof status === "string" ? { status } : {}) }
}

async function requireStoppedRecovery(input: OperationInput, child: SessionInfo, itemID: string) {
  if (child.parentID === undefined || child.agent === "btw") throw new OperationError("invalid_message", "Only a managed child Session can continue a stopped recovery")
  const parent = await input.sessions.verify(child.parentID)
  if (parent === undefined) throw new OperationError("session_not_allowed", "Parent Session is not available at its recorded location")
  const seen = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const result: unknown = await input.local.subagentPage(parent.id, locationInfo(parent), cursor)
    const tasks: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "data") : undefined
    if (Array.isArray(tasks) && tasks.some((task) => ownsStoppedRecovery(task, parent.id, child.id, itemID))) return
    const page: unknown = typeof result === "object" && result !== null ? Reflect.get(result, "cursor") : undefined
    const next: unknown = typeof page === "object" && page !== null ? Reflect.get(page, "next") : undefined
    if (typeof next !== "string" || next.length === 0 || seen.has(next)) break
    seen.add(next)
    cursor = next
  }
  throw new OperationError("invalid_message", "That recovery was not stopped for this Session; reload before continuing")
}

function ownsStoppedRecovery(task: unknown, parentID: string, childID: string, itemID: string) {
  if (typeof task !== "object" || task === null || Reflect.get(task, "parentID") !== parentID || Reflect.get(task, "sessionID") !== childID) return false
  const stopped: unknown = Reflect.get(task, "stoppedRecovery")
  return typeof stopped === "object" && stopped !== null && Reflect.get(stopped, "itemID") === itemID
}

function asReviewList(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === "object" && value !== null) {
    const data = Reflect.get(value, "data")
    if (Array.isArray(data)) return data
  }
  return []
}

async function requireOwnedReview(
  input: OperationInput,
  sessionID: string,
  location: LocalLocation,
  requestID: string,
) {
  const reviews = asReviewList(await input.local.guardrailRequestList(sessionID, location))
  const review = reviews.find(
    (request) => typeof request === "object" && request !== null && Reflect.get(request, "id") === requestID,
  )
  if (review === undefined)
    throw new OperationError("invalid_message", "That guardrail review is no longer pending; reload before replying")
}

async function requireOwnedForm(
  input: OperationInput,
  sessionID: string,
  location: LocalLocation,
  formID: string,
) {
  const forms = await input.local.formList(sessionID, location)
  if (!forms.some((form) => form.id === formID && form.sessionID === sessionID))
    throw new OperationError("invalid_message", "That form is not pending for the authorized Session")
}

function scopedOperation(operation: RemoteOperation) {
  return operation === "usage.forecast" || operation === "incident.guidance" || operation === "incident.guidance.clear" ||
    !unscopedOperations.has(operation) && requireSession(operation)
}

async function requireFamilyMember(input: OperationInput, root: SessionInfo, memberID: string, managed = false): Promise<SessionInfo> {
  if (root.parentID !== undefined) throw new OperationError("forbidden", "Team requires a root Session")
  if (memberID === root.id && !managed) return root
  const member = await input.sessions.verify(memberID)
  if (member?.parentID !== root.id || managed && member.agent === "btw") throw new OperationError("forbidden", "Session is not a direct family member")
  return member
}

// A shell owner belongs to the family when walking its verified parent chain reaches
// the root, so shells started by nested descendants are attributed to their owner
// instead of being dropped for not being a direct child.
async function verifiedFamilyOwner(input: OperationInput, root: SessionInfo, ownerID: string): Promise<SessionInfo | undefined> {
  if (ownerID === root.id) return root
  const owner = await input.sessions.verify(ownerID)
  if (!owner) return undefined
  let current: SessionInfo | undefined = owner
  const seen = new Set<string>()
  while (current && !seen.has(current.id) && seen.size < 16) {
    seen.add(current.id)
    if (current.parentID === root.id) return owner
    if (current.parentID === undefined) return undefined
    current = await input.sessions.verify(current.parentID)
  }
  return undefined
}

async function capturedChangesPage(input: OperationInput, owner: SessionInfo, sessionID: string, location: LocalLocation, requestID: string, cursor?: string): Promise<RemoteCapturedChangesPage> {
  const { groups, digest } = await capturedGroups(input, owner, sessionID, location)
  if (groups.length === 0) {
    if (cursor !== undefined) throw new OperationError("invalid_message", "Captured change cursor is stale")
    return { data: [] }
  }
  let offset = 0
  if (cursor !== undefined) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
      if (!parsed || typeof parsed !== "object" || !("offset" in parsed) || !("digest" in parsed) || typeof parsed.offset !== "number" ||
        !Number.isSafeInteger(parsed.offset) || parsed.offset < 1 || parsed.offset >= groups.length || parsed.digest !== digest)
        throw new OperationError("invalid_message", "Captured change cursor is stale")
      offset = parsed.offset
    } catch (cause) {
      if (cause instanceof OperationError) throw cause
      throw new OperationError("invalid_message", "Captured change cursor is invalid")
    }
  }
  const files: Array<RemoteCapturedChangesPage["data"][number]> = []
  for (const group of groups.slice(offset)) {
    if (files.length >= maxCapturedFilesPerPage || files.length > 0 && JSON.stringify([...files, group]).length > maxCapturedPageChars) break
    files.push(group)
  }
  const end = offset + files.length
  const page: RemoteCapturedChangesPage = {
    data: files,
    ...(end < groups.length ? { cursor: { next: Buffer.from(JSON.stringify({ offset: end, digest })).toString("base64url") } } : {}),
  }
  if (successFrames(requestID, page)[0]?.ok === false) throw new OperationError("message_too_large", "Captured change page exceeds the response bound")
  return page
}

function capturedGroups(input: OperationInput, owner: SessionInfo, sessionID: string, location: LocalLocation) {
  const cache = input.cache ?? createOperationCache()
  return joinFlight(cache.capturedReads, `${sessionID}\0${location.directory}\0${location.workspaceID ?? ""}`, input.signal,
    (signal) => readCapturedGroups(input, cache, owner, sessionID, location, signal))
}

async function readCapturedGroups(input: OperationInput, cache: OperationCache, owner: SessionInfo, sessionID: string, location: LocalLocation, signal: AbortSignal): Promise<CapturedResult> {
  const entries = cache.capturedChanges
  const started = cache.activity.clock
  const epoch = cache.activity.epoch
  const parentKey = await eventPosition(input.local, sessionID, location, signal)
  const cached = entries.get(sessionID)
  const checked = new Map<string, Awaited<ReturnType<typeof capturedMember>>>()
  if (cached !== undefined && cached.parentKey === parentKey) {
    const unobserved = cached.epoch !== epoch
    const rechecks = [...cached.members.keys()].filter((childID) => unobserved || (cache.activity.at.get(childID) ?? cache.activity.floor) > cached.readAt)
    const members = await limited(rechecks, (childID) => capturedMember(input, owner, childID, signal))
    for (const member of members) checked.set(member.childID, member)
    if (members.every((member) => member.key === cached.members.get(member.childID))) {
      entries.delete(sessionID)
      entries.set(sessionID, { ...cached, readAt: started, epoch })
      return cached
    }
  }

  const parent = await input.local.capturedInputs(sessionID, location, signal)
  const members = await limited(owner.parentID === undefined ? capturedChildSessionIDs(parent) : [], async (childID) => {
    const member = checked.get(childID) ?? await capturedMember(input, owner, childID, signal)
    return { ...member, messages: member.child === undefined ? undefined : await input.local.capturedInputs(member.child.id, locationInfo(member.child), signal) }
  })
  const children = new Map(members.flatMap((member) => member.messages === undefined ? [] : [[member.childID, member.messages] as const]))
  const groups = summarizeCapturedChanges(parent, children, (assistantMessageID, callID) => SessionOrchestrationIdentity.send(sessionID, assistantMessageID, callID))
    .flatMap((unit) => unit.files.map((file) => ({ placementMessageID: unit.placementMessageID, ...file })))
    .map((original) => JSON.stringify(original).length > maxCapturedPageChars
      ? { ...original, additions: 0, deletions: 0, files: [{ path: original.path, diff: "", additions: 0, deletions: 0, status: original.status, unavailable: true }] }
      : original)
  const digest = createHash("sha256").update(sessionID).update(JSON.stringify(groups)).digest("hex")
  if (!await capturedStable(input, cache, owner, parentKey, members, started, epoch, signal))
    throw new OperationError("internal_error", "Captured changes changed while reading; refresh to try again")
  entries.delete(sessionID)
  entries.set(sessionID, { parentKey, members: new Map(members.map((member) => [member.childID, member.key ?? null] as const)), groups, digest, readAt: started, epoch })
  if (entries.size > maxCapturedCacheEntries) entries.delete(entries.keys().next().value!)
  return { groups, digest }
}

async function capturedStable(input: OperationInput, cache: OperationCache, owner: SessionInfo, parentKey: string, members: readonly Awaited<ReturnType<typeof capturedMember>>[], started: number, epoch: number, signal: AbortSignal) {
  const current = await input.sessions.verify(owner.id, signal)
  if (current === undefined || current.parentID !== owner.parentID || JSON.stringify(locationInfo(current)) !== JSON.stringify(locationInfo(owner)) ||
    await eventPosition(input.local, owner.id, locationInfo(current), signal) !== parentKey) return false
  return epoch === cache.activity.epoch && members.every((member) => (cache.activity.at.get(member.childID) ?? cache.activity.floor) <= started)
}

async function capturedMember(input: OperationInput, owner: SessionInfo, childID: string, signal: AbortSignal) {
  const child = await input.sessions.verify(childID, signal)
  if (child?.parentID !== owner.id || child.agent === "btw") return { childID, key: null }
  return { childID, child, key: await eventPosition(input.local, child.id, locationInfo(child), signal) }
}

async function eventPosition(local: LocalServer, sessionID: string, location: LocalLocation, signal: AbortSignal) {
  const snapshot = await local.snapshot(sessionID, location, { limit: 1 }, signal)
  const epoch = field(snapshot, "sourceEpoch")
  const watermark = field(snapshot, "watermark")
  const seq = field(watermark, "seq")
  if (typeof epoch !== "string" || epoch.length === 0 || typeof watermark !== "object" || watermark === null || Array.isArray(watermark) ||
    (seq === undefined ? field(watermark, "type") !== "log.synced" || field(watermark, "aggregateID") !== sessionID : typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0))
    throw new OperationError("internal_error", "Captured change position is unavailable; refresh to try again")
  return `${epoch}:${seq === undefined ? "empty" : seq}`
}

async function limited<Item, Result>(items: readonly Item[], read: (item: Item) => Promise<Result>) {
  const results: Result[] = []
  for (let offset = 0; offset < items.length; offset += maxCapturedChildReads)
    results.push(...await Promise.all(items.slice(offset, offset + maxCapturedChildReads).map(read)))
  return results
}

async function familyLocations(input: OperationInput, root: SessionInfo): Promise<readonly LocalLocation[]> {
  const locations = new Map<string, LocalLocation>()
  const add = (location: LocalLocation) => locations.set(JSON.stringify(location), location)
  add(locationInfo(root))
  const snapshot = input.sessions.snapshot()
  const descendantIDs = new Set<string>()
  let frontier = [root.id]
  while (frontier.length > 0) {
    frontier = snapshot
      .filter((session) => session.parentID !== undefined && frontier.includes(session.parentID) && !descendantIDs.has(session.id))
      .map((session) => {
        descendantIDs.add(session.id)
        return session.id
      })
  }
  for (const child of snapshot.filter((session) => descendantIDs.has(session.id))) {
    if (locations.has(JSON.stringify(locationInfo(child)))) continue
    if (locations.size >= RemoteLimits.maxFamilyMembers) throw new OperationError("message_too_large", "Team spans too many Locations for one shell read")
    const current = await verifiedFamilyOwner(input, root, child.id)
    if (current) add(locationInfo(current))
  }
  return [...locations.values()]
}

async function familyActivity(input: OperationInput, root: SessionInfo, sessionIDs: readonly string[]): Promise<readonly RemoteFamilyActivity[]> {
  if (root.parentID !== undefined) throw new OperationError("session_not_allowed", "Family activity requires a root Session")
  const inventory = new Map(input.sessions.snapshot().map((session) => [session.id, session]))
  const members = [root, ...sessionIDs.map((id) => {
    const child = inventory.get(id)
    if (child?.parentID !== root.id) throw new OperationError("session_not_allowed", "Session is not a direct member of this family")
    return child
  })]
  const executing = activeIDs(await input.local.activeSessions())
  const output: RemoteFamilyActivity[] = []
  for (let offset = 0; offset < members.length; offset += 8) {
    output.push(...await Promise.all(members.slice(offset, offset + 8).map(async (member): Promise<RemoteFamilyActivity> => {
      if (!executing.has(member.id)) return { sessionID: member.id, executing: false }
      const snapshot = await input.local.snapshot(member.id, locationInfo(member), { limit: 8 })
      return { sessionID: member.id, executing: true, activity: summarizeActivity(snapshot) }
    })))
  }
  return output
}

function summarizeActivity(snapshot: unknown): NonNullable<RemoteFamilyActivity["activity"]> {
  const messages = field(snapshot, "messages")
  const assistant = Array.isArray(messages) ? messages.findLast((message) => field(message, "type") === "assistant" && field(field(message, "time"), "completed") === undefined) : undefined
  const content = field(assistant, "content")
  const part = Array.isArray(content) ? content.at(-1) : undefined
  if (field(part, "type") === "reasoning" && field(field(part, "time"), "completed") === undefined)
    return { kind: "thinking", room: "hold", text: "Thinking" }
  if (field(part, "type") !== "tool" || !["running", "streaming"].includes(String(field(field(part, "state"), "status"))))
    return { kind: "replying", room: "developer", text: part === undefined ? "Preparing next step" : "Replying" }
  const name = field(part, "name")
  const tool = typeof name === "string" ? name : "tool"
  const data = field(field(part, "state"), "input")
  const value = (key: string) => { const result = field(data, key); return typeof result === "string" ? result : "" }
  const leaf = (path: string) => path.split(/[\\/]/).at(-1)?.replace(/[^\p{L}\p{N}._-]/gu, "") ?? ""
  const text = (label: string, subject = "") => boundedActivity(`${label}${subject ? ` ${subject}` : ""}`)
  if (["read", "glob"].includes(tool)) return { kind: "tool", room: "research", text: text(tool === "read" ? "Reading" : "Finding files", leaf(value("path") || value("pattern"))) }
  if (tool === "grep" || tool === "websearch") {
    const query = value("query") || value("pattern")
    const safe = /\b(?:api[_-]?key|token|secret|password|bearer)\b|sk-|[A-Za-z0-9_-]{32,}|@|:\/\//i.test(query) ? "" : boundedActivity(query, 42)
    return { kind: "tool", room: "research", text: safe ? text("Searching:", safe) : "Searching" }
  }
  if (tool === "webfetch") {
    const host = URL.canParse(value("url")) ? new URL(value("url")).hostname : ""
    return { kind: "tool", room: "research", text: text("Fetching", host) }
  }
  if (["subagent", "subagent_control", "subagent_report", "todowrite"].includes(tool)) return { kind: "tool", room: "meeting", text: tool === "todowrite" ? "Planning tasks" : "Dispatching a subagent" }
  if (["patch", "write", "edit_image"].includes(tool)) {
    const patch = value("patchText").match(/^\*\*\* (?:Update|Add) File: ([^\r\n]+)/m)?.[1] ?? ""
    return { kind: "tool", room: "developer", text: text("Editing", leaf(value("path") || patch)) }
  }
  if (tool === "shell") {
    const command = value("command")
    const check = command.match(/\b(?:bun|npm|pnpm|yarn) (?:test|run (?:typecheck|lint))\b(?: [./\w-]+)?/i)?.[0]
    if (check) return { kind: "tool", room: "qa", text: text("Running", check) }
    if (/\b(?:pytest|vitest|jest|tsc|eslint|oxlint)\b/i.test(command)) return { kind: "tool", room: "qa", text: "Running checks" }
    if (/\b(?:rg|grep|find|ls|cat)\b/.test(command)) return { kind: "tool", room: "research", text: "Searching files" }
    return { kind: "tool", room: "developer", text: "Running a command" }
  }
  return { kind: "tool", room: "developer", text: text("Using", tool.replace(/[^\p{L}\p{N}_-]/gu, "")) }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function boundedActivity(value: string, limit = 80): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  const points = Array.from(clean)
  return points.length <= limit ? clean : `${points.slice(0, limit - 1).join("")}…`
}

export async function sessionStatus(local: LocalServer, sessions: readonly SessionInfo[], knownAttention?: Readonly<Record<string, RemoteAttentionNeed>>, knownFailures?: ReadonlySet<string>, knownWork?: Awaited<ReturnType<LocalServer["outstandingSessions"]>>, bounded = true) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const rootOf = (sessionID: unknown) => {
    const session = typeof sessionID === "string" ? byID.get(sessionID) : undefined
    return session === undefined ? undefined : rootSessionID(session, byID)
  }
  const work = knownWork ?? await local.outstandingSessions(knownFailures === undefined)
  if (!Array.isArray(work.lost))
    throw new OperationError("internal_error", "Local server requires an update before remote Session status can be read")
  const executing = work.running.flatMap((id) => byID.get(id) ?? [])
  const running = new Set(executing.flatMap((session) => rootSessionID(session, byID) ?? []))
  const outstanding = new Set(work.data.flatMap((id) => rootOf(id) ?? []).filter((id) => !running.has(id)))
  const failed = knownFailures ?? new Set(work.failed.flatMap((id) => rootOf(id) ?? []))
  const lost = new Set(work.lost.flatMap((id) => rootOf(id) ?? []))
  if (bounded && (running.size > RemoteLimits.maxStatusSessions || (knownAttention !== undefined && Object.keys(knownAttention).length > RemoteLimits.maxStatusSessions)))
    throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  if (bounded && outstanding.size > RemoteLimits.maxStatusSessions) throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  const attention = new Map<string, RemoteAttentionNeed>(Object.entries(knownAttention ?? {}))
  const need = (rootID: string | undefined, kind: RemoteAttentionNeed) => {
    const current = rootID === undefined ? undefined : attention.get(rootID)
    if (rootID !== undefined && (current === undefined || attentionNeeds.indexOf(kind) < attentionNeeds.indexOf(current))) attention.set(rootID, kind)
  }
  const executingLocations = knownAttention === undefined
    ? [...new Map(executing.map((session) => [JSON.stringify([session.location.directory, session.location.workspaceID ?? null]), locationInfo(session)])).values()]
    : []
  for (let offset = 0; offset < executingLocations.length; offset += 8) {
    await Promise.all(executingLocations.slice(offset, offset + 8).map(async (location) => {
      const [permissions, forms] = await Promise.all([local.permissionRequests(location), local.formRequests(location)])
      if (!Array.isArray(permissions) || !Array.isArray(forms))
        throw new OperationError("internal_error", "The local Session request listing was unreadable")
      for (const item of permissions) need(rootOf(typeof item === "object" && item !== null ? Reflect.get(item, "sessionID") : undefined), "permission")
      for (const item of forms) need(rootOf(typeof item === "object" && item !== null ? Reflect.get(item, "sessionID") : undefined), "question")
    }))
  }
  const families = knownAttention === undefined ? [...running].flatMap((id) => byID.get(id) ?? []) : []
  for (let offset = 0; offset < families.length; offset += 8) {
    await Promise.all(families.slice(offset, offset + 8).map(async (root) => {
      const reviews = await local.guardrailRequestList(root.id, locationInfo(root))
      if (!Array.isArray(reviews)) throw new OperationError("internal_error", "The local Session request listing was unreadable")
      if (reviews.some((item) => rootOf(typeof item === "object" && item !== null ? Reflect.get(item, "sessionID") : undefined) === root.id))
        need(root.id, "review")
    }))
  }
  if (bounded && attention.size > RemoteLimits.maxStatusSessions)
    throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  const requestAttention = [...attention.keys()].sort()
  const combined = [...new Set([...requestAttention, ...failed, ...lost])].sort()
  if (bounded && combined.length > RemoteLimits.maxStatusSessions) throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  return { running: [...running].sort(), attention: combined, requestAttention, requestNeeds: Object.fromEntries(attention), failed: [...failed],
    ...(outstanding.size === 0 ? {} : { outstanding: [...outstanding].sort() }),
    ...(lost.size === 0 ? {} : { lost: [...lost].sort() }) }
}

export function lossOnly(status: { readonly requestAttention: readonly string[]; readonly lost?: readonly string[] }): string[] {
  return (status.lost ?? []).filter((id) => !status.requestAttention.includes(id)).sort()
}

const attentionNeeds: readonly RemoteAttentionNeed[] = ["permission", "question", "review"]

export function attentionDetails(sessions: readonly SessionInfo[], attention: readonly string[], needs: Readonly<Record<string, RemoteAttentionNeed>>): RemoteAttentionDetail[] {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return attention.flatMap((sessionID) => {
    const session = byID.get(sessionID)
    const title = session === undefined ? undefined : alertTitle(session.title)
    const kind = needs[sessionID]
    if (title === undefined && kind === undefined) return []
    return [{ sessionID, ...(title === undefined ? {} : { title }), ...(kind === undefined ? {} : { need: kind }) }]
  })
}

function rootSessionID(session: SessionInfo, byID: ReadonlyMap<string, SessionInfo>): string | undefined {
  const seen = new Set<string>()
  let current = session
  while (current.parentID !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byID.get(current.parentID)
    if (parent === undefined) return undefined
    current = parent
  }
  return current.parentID === undefined ? current.id : undefined
}

/** Running status is only ever reported for Sessions the user shared. */
function filterActiveSessions(value: unknown, allowed: ReadonlySet<string>) {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter(([sessionID]) => allowed.has(sessionID)))
}

type Cursor = { readonly id: string; readonly time: number; readonly direction: "next" | "previous"; readonly pinned?: number | null; readonly running?: boolean; readonly waiting?: boolean; readonly epoch?: string }

export type ListQuery = {
  readonly order: "asc" | "desc" | "pinned" | "active"
  readonly search?: string
  readonly searchFields?: "summary"
  readonly workspace?: string
  readonly status?: "waiting" | "running" | "idle"
  readonly parentID?: string | null
  readonly limit: number
  readonly anchor?: Cursor
  readonly around?: string
  readonly before?: number
}

export function parseListQuery(fields: Readonly<Record<string, unknown>>): ListQuery {
  const order = fields.order === undefined ? "desc" : literal(fields.order, ["asc", "desc", "pinned", "active"], "order")
  const anchor = fields.cursor === undefined ? undefined : cursor(fields.cursor)
  if (order === "pinned" && anchor !== undefined && anchor.pinned === undefined)
    throw new OperationError("invalid_message", "Pinned Session cursor is missing its sort key")
  if (order === "active" && anchor !== undefined && (anchor.running === undefined || anchor.waiting === undefined || anchor.epoch === undefined))
    throw new OperationError("invalid_message", "Active Session cursor is missing its sort key")
  if ((fields.around !== undefined || fields.before !== undefined) && (order !== "active" || anchor !== undefined || fields.around === undefined))
    throw new OperationError("invalid_message", "A Session window anchor requires active order without a cursor")
  return {
    order,
    search: fields.search === undefined ? undefined : requireString(fields.search, "search", 200, { allowEmpty: true }),
    searchFields: fields.searchFields === undefined ? undefined : literal(fields.searchFields, ["summary"], "searchFields"),
    workspace: fields.workspace === undefined ? undefined : requireString(fields.workspace, "workspace", 128),
    status: fields.status === undefined ? undefined : literal(fields.status, ["waiting", "running", "idle"], "status"),
    parentID: fields.parentID === undefined ? undefined : fields.parentID === null ? null : sessionID(fields.parentID, "parentID"),
    limit: fields.limit === undefined ? 50 : optionalInteger(fields.limit, "limit", 1, RemoteLimits.maxSessionListPage)!,
    anchor,
    around: fields.around === undefined ? undefined : sessionID(fields.around, "around"),
    before: fields.before === undefined ? undefined : optionalInteger(fields.before, "before", 0, (typeof fields.limit === "number" ? fields.limit : 50) - 1),
  }
}

/** Page the complete backend Session list without truncation. */
export function listPage(sessions: readonly SessionInfo[], query: ListQuery, running?: ReadonlySet<string>, waiting?: ReadonlySet<string>, lost?: ReadonlySet<string>) {
  const { order, search, parentID, limit, anchor } = query
  const direction = anchor?.direction ?? "next"
  const effectiveOrder = order === "pinned" || order === "active" ? order : direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const runningRoots = new Set(sessions.filter((session) => running?.has(session.id)).map((session) => rootSessionID(session, byID)).filter((id): id is string => id !== undefined))
  const isRunning = (session: SessionInfo) => session.parentID === undefined ? runningRoots.has(session.id) : running?.has(session.id) === true
  const isWaiting = (session: SessionInfo) => session.parentID === undefined && waiting?.has(session.id) === true
  const isLost = (session: SessionInfo) => session.parentID === undefined && lost?.has(session.id) === true && !isWaiting(session)
  const activeKey = (session: SessionInfo) => ({ id: session.id, time: session.time.active ?? session.time.updated,
    waiting: isWaiting(session), running: !isWaiting(session) && session.parentID === undefined && runningRoots.has(session.id) })
  const needle = search?.toLowerCase()
  const matching = sessions
    .filter((session) => query.workspace === undefined || workspaceKey(session.projectID, resolve(session.location.directory), session.location.workspaceID) === query.workspace)
    .filter((session) => needle === undefined || (query.searchFields === "summary"
      ? [session.title, session.agent ?? "", ...(session.model === undefined ? [] : [`${session.model.providerID}/${session.model.id}${session.model.variant === undefined ? "" : `#${session.model.variant}`}${session.model.profile === undefined ? "" : ` profile ${session.model.profile}`}`])]
        .some((value) => value.toLowerCase().includes(needle))
      : session.title.toLowerCase().includes(needle)))
    .filter((session) => query.status === undefined || (query.status === "waiting" ? isWaiting(session)
      : query.status === "running" ? isRunning(session) && !isWaiting(session) : !isWaiting(session) && !isRunning(session) && session.time.archived === undefined))
    .filter((session) => (parentID === undefined ? true : (session.parentID ?? null) === parentID))
    .sort(order === "active" ? (left, right) => compareActiveSessions(activeKey(left), activeKey(right)) : order === "pinned" ? comparePinnedSessions : compareSessions)
  const epoch = order !== "active" ? undefined : createHash("sha256").update(JSON.stringify([
    query.workspace, search, query.searchFields, query.status, parentID, matching.map(activeKey),
  ])).digest("hex")
  if (order === "active" && anchor !== undefined && anchor.epoch !== epoch) return { data: [], cursor: { previous: undefined, next: undefined }, stale: true }
  const ordered = effectiveOrder === "asc" || ((effectiveOrder === "pinned" || effectiveOrder === "active") && direction === "next") ? matching : matching.toReversed()
  const anchored = anchor === undefined ? ordered : ordered.filter((session) => effectiveOrder === "active"
    ? compareActiveSessions(activeKey(session), { id: anchor.id, time: anchor.time, running: anchor.running === true, waiting: anchor.waiting === true }) * (direction === "next" ? 1 : -1) > 0
    : effectiveOrder === "pinned"
      ? comparePinnedSessions(session, { id: anchor.id, time: { updated: anchor.time, pinned: anchor.pinned ?? undefined } }) * (direction === "next" ? 1 : -1) > 0
      : afterAnchor(session, anchor, effectiveOrder))
  const windowStart = query.around === undefined ? 0 : Math.max(0, matching.findIndex((session) => session.id === query.around) - (query.before ?? 0))
  const page = anchored.slice(windowStart, windowStart + limit)
  const remaining = anchored.length - windowStart - page.length
  const data = direction === "previous" ? page.toReversed() : page
  const first = data[0]
  const last = data.at(-1)
  return {
    data,
    ...(running === undefined ? {} : { status: { running: data.filter(isRunning).map((session) => session.id), attention: data.filter((session) => isWaiting(session) || isLost(session)).map((session) => session.id),
      ...(data.some(isLost) ? { lost: data.filter(isLost).map((session) => session.id) } : {}) } }),
    cursor: {
      previous: first && (direction === "next" ? anchor !== undefined || windowStart > 0 : remaining > 0)
        ? encodeCursor({ id: first.id, time: order === "active" ? activeKey(first).time : first.time.updated, direction: "previous", ...(order === "pinned" ? { pinned: first.time.pinned ?? null } : {}), ...(order === "active" ? { running: activeKey(first).running, waiting: activeKey(first).waiting, epoch } : {}) })
        : undefined,
      next: last && (direction === "previous" ? anchor !== undefined : remaining > 0)
        ? encodeCursor({ id: last.id, time: order === "active" ? activeKey(last).time : last.time.updated, direction: "next", ...(order === "pinned" ? { pinned: last.time.pinned ?? null } : {}), ...(order === "active" ? { running: activeKey(last).running, waiting: activeKey(last).waiting, epoch } : {}) })
        : undefined,
    },
  }
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

function cursor(value: unknown): Cursor {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024)
    throw new OperationError("invalid_message", "Invalid cursor")
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null) throw new Error("shape")
    const record = parsed as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.time !== "number") throw new Error("shape")
    if (record.pinned !== undefined && record.pinned !== null && typeof record.pinned !== "number") throw new Error("shape")
    if (record.running !== undefined && typeof record.running !== "boolean") throw new Error("shape")
    if (record.waiting !== undefined && typeof record.waiting !== "boolean") throw new Error("shape")
    if (record.epoch !== undefined && (typeof record.epoch !== "string" || !/^[a-f0-9]{64}$/.test(record.epoch))) throw new Error("shape")
    return { id: record.id, time: record.time, direction: literal(record.direction, ["next", "previous"], "cursor"),
      ...(record.pinned === undefined ? {} : { pinned: record.pinned }), ...(record.running === undefined ? {} : { running: record.running }), ...(record.waiting === undefined ? {} : { waiting: record.waiting }), ...(record.epoch === undefined ? {} : { epoch: record.epoch }) }
  } catch {
    throw new OperationError("invalid_message", "Invalid cursor")
  }
}

type SessionOrderKey = { readonly id: string; readonly time: { readonly updated: number; readonly pinned?: number | undefined } }

function compareSessions(left: SessionOrderKey, right: SessionOrderKey) {
  if (left.time.updated !== right.time.updated) return left.time.updated - right.time.updated
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function comparePinnedSessions(left: SessionOrderKey, right: SessionOrderKey) {
  const pinnedLeft = left.time.pinned
  const pinnedRight = right.time.pinned
  if (pinnedLeft !== undefined && pinnedRight === undefined) return -1
  if (pinnedLeft === undefined && pinnedRight !== undefined) return 1
  if (pinnedLeft !== undefined && pinnedRight !== undefined && pinnedLeft !== pinnedRight) return pinnedLeft - pinnedRight
  return -compareSessions(left, right)
}

function compareActiveSessions(left: { readonly id: string; readonly time: number; readonly running: boolean; readonly waiting: boolean }, right: { readonly id: string; readonly time: number; readonly running: boolean; readonly waiting: boolean }) {
  if (left.waiting !== right.waiting) return left.waiting ? -1 : 1
  if (left.running !== right.running) return left.running ? -1 : 1
  if (left.time !== right.time) return right.time - left.time
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function activeIDs(value: unknown): ReadonlySet<string> {
  if (typeof value !== "object" || value === null) return new Set()
  return new Set(Object.entries(value).filter(([, state]) => typeof state === "object" && state !== null && Reflect.get(state, "type") === "running").map(([id]) => id))
}

function afterAnchor(session: SessionInfo, anchor: Cursor, order: "asc" | "desc") {
  if (session.time.updated !== anchor.time)
    return order === "asc" ? session.time.updated > anchor.time : session.time.updated < anchor.time
  return order === "asc" ? session.id > anchor.id : session.id < anchor.id
}

const allowedFields: Readonly<Record<string, readonly string[]>> = {
  "local.app.register": ["host", "port", "entryPath", "routes", "ttlMs"],
  "local.app.list": [],
  "local.app.revoke": ["id"],
  "local.app.open": ["id", "generation"],
  "local.app.status": ["id"],
  "local.app.http": ["id", "generation", "method", "path", "headers", "body"],
  "machine.latency.append": ["samples"],
  "machine.latency.list": ["limit", "before"],
  "machine.keepAwake.get": [],
  "machine.keepAwake.set": ["enabled"],
  "machine.telemetry.consent.get": [],
  "machine.telemetry.consent.set": ["enabled", "noticeVersion"],
  "workspace.list": ["sessionsOnly"],
  "session.list": ["limit", "order", "search", "searchFields", "parentID", "cursor", "workspace", "status", "around", "before"],
  "session.active": [],
  "usage.providers": ["refresh"],
  "usage.summary": [],
  "usage.report": ["group", "timeZone", "from", "to", "offset", "limit", "sort", "order", "providerID", "profile", "modelID", "selectedEffort"],
  "session.usageReport": ["group", "timeZone", "from", "to", "offset", "limit", "sort", "order", "providerID", "profile", "modelID", "selectedEffort"],
  "session.promptCosts": ["inputIDs"],
  "session.taskCosts": ["sessionIDs"],
  "usage.forecast": ["localScope"],
  "incident.report": ["group", "from", "to", "offset", "limit"],
  "incident.recent": ["provider", "model", "agent", "limit"],
  "incident.guidance": ["provider", "model"],
  "incident.guidance.clear": ["provider", "model"],
  "coordination.settings": [],
  "coordination.list": [],
  "coordination.create": ["name", "masterSessionID", "memberSessionIDs"],
  "coordination.get": ["groupID"],
  "coordination.update": ["groupID", "revision", "name", "masterSessionID", "memberSessionIDs", "settings"],
  "coordination.delete": ["groupID"],
  "session.status": [],
  "session.catalog": [],
  "workspace.catalog": ["workspace"],
  "session.file.find": ["query", "limit"],
  "workspace.file.find": ["workspace", "query", "limit"],
  "session.switchModel": ["model"],
  "session.switchAgent": ["agent"],
  "session.command": ["id", "command", "arguments", "files", "agents", "delivery"],
  "session.attachment.upload": ["uploadID", "index", "last", "data"],
  "session.skill": ["id", "skill", "resume"],
  "session.get": [],
  "session.snapshot": ["limit", "before"],
  "session.pending.list": [],
  "session.attachment.read": ["digest"],
  "session.message.stream": ["messageID"],
  "session.subagent.list": ["cursor"],
  "session.pin": [],
  "session.unpin": [],
  "session.subagent.cancel": ["childID"],
  "session.subagent.answer": ["childID", "questionID", "text"],
  "session.team.economics": ["sessionIDs"],
  "session.team.shell.list": [],
  "session.team.shell.kill": ["shellID"],
  "session.side-chat.list": ["cursor"],
  "session.side-chat.create": ["id"],
  "session.family.activity": ["sessionIDs"],
  "session.messages": [],
  "session.capturedChanges.list": ["cursor"],
  "session.compaction.list": [],
  "session.compact": ["id"],
  "session.todo.list": [],
  "session.log": ["after"],
  "session.autonomy.get": [],
  "session.permission.list": [],
  "session.guardrail.status": [],
  "session.guardrail.request.list": [],
  "session.review.list": [],
  "session.review.decide": ["itemID", "decision"],
  "session.form.list": [],
  "session.shell.output": ["shellID", "cursor", "limit"],
  "session.subscribe": [],
  "session.unsubscribe": [],
  "session.prompt": ["id", "text", "files", "agents", "delivery", "resume", "skills"],
  "session.interrupt": [],
  "session.prediction": ["memory", "hint"],
  "session.promptGenerate": ["mode", "intent", "memory"],
  "session.permission.reply": ["requestID", "reply", "message"],
  "session.guardrail.reply": ["requestID", "reply"],
  "session.form.reply": ["formID", "answer"],
  "session.form.cancel": ["formID"],
  "session.autonomy.set": ["yolo", "autoPermission", "autoGuardrail", "autoAnswer", "sleep"],
  "session.goal.set": ["goal", "maxNoProgress", "yolo"],
  "session.goal.stop": ["goal"],
  "session.create": ["id", "workspace", "agent", "model"],
}

function validateFields(request: RemoteRequest): Readonly<Record<string, unknown>> {
  const fields = request.input ?? {}
  const allowed = allowedFields[request.operation] ?? []
  for (const key of Object.keys(fields))
    if (!allowed.includes(key)) throw new OperationError("invalid_message", `Unknown input field "${key}"`)
  return fields
}

const mutations: ReadonlySet<string> = new Set([
  "provider.auth.key",
  "provider.auth.begin",
  "provider.auth.complete",
  "provider.auth.cancel",
  "machine.latency.append",
  "machine.telemetry.consent.set",
  "machine.keepAwake.set",
  "incident.guidance.clear",
  "coordination.create",
  "coordination.update",
  "coordination.delete",
  "session.delete",
  "session.compact",
  "session.create",
  "session.subagent.cancel",
  "session.subagent.answer",
  "session.team.shell.kill",
  "session.side-chat.create",
  "session.switchModel",
  "session.switchAgent",
  "session.command",
  "session.skill",
  "session.prompt",
  "session.interrupt",
  "session.prediction",
  "session.promptGenerate",
  "session.permission.reply",
  "session.guardrail.reply",
  "session.review.decide",
  "session.form.reply",
  "session.form.cancel",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
])

function isMutation(request: RemoteRequest) {
  return mutations.has(request.operation)
}

const reviewReplies: ReadonlySet<string> = new Set([
  "session.review.decide",
  "session.permission.reply",
  "session.guardrail.reply",
  "session.form.reply",
  "session.form.cancel",
])

function localError(cause: LocalFailure, request: RemoteRequest): readonly [RemoteErrorCode, string] {
  switch (cause.kind) {
    case "location_unavailable":
      return ["invalid_message", "The recorded directory is unavailable on this device; restore it before retrying"]
    case "not_found":
      if (request.operation === "session.attachment.read" || request.operation === "session.message.stream")
        return ["not_found", "The requested Session content is unavailable"]
      if (reviewReplies.has(request.operation))
        return ["invalid_message", "That request is no longer pending; reload before replying"]
      if (request.operation === "session.command" || request.operation === "session.skill")
        return ["invalid_message", "The command or skill is not available at this Location"]
      // A shell reference is scoped to one session read; a gone shell is a stale
      // reference, not a Session that moved.
      if (request.operation === "session.shell.output")
        return ["invalid_message", "That shell is no longer available on this device"]
      return ["session_not_allowed", "Session is no longer available on this device"]
    case "invalid":
      return ["invalid_message", "The local server rejected the request"]
    case "conflict":
      return ["invalid_message", "The local server refused a conflicting request; do not replay it automatically"]
    case "too_large":
      return ["message_too_large", request.operation === "session.attachment.read" ? "Attachment exceeds the bounded read size" : "The local response exceeded the bounded response size; read again with after"]
    case "transport":
      return isMutation(request)
        ? ["outcome_unknown", "The local server did not confirm the outcome; do not replay it automatically"]
        : ["internal_error", "The local server did not answer the read request"]
    case "telemetry_disabled":
      return ["telemetry_disabled", "Machine telemetry consent is disabled"]
    default:
      return ["internal_error", "The local server failed the request"]
  }
}

type ReviewDecision = ReviewDecideInput["decision"]

function reviewDecision(value: unknown): ReviewDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OperationError("invalid_message", "Invalid review decision")
  const fields = value as Readonly<Record<string, unknown>>
  const kind = literal(fields.kind, ["question", "subagent_question", "guardrail", "permission", "recovery"] as const, "kind")
  const only = (...keys: readonly string[]) => {
    if (Object.keys(fields).some((key) => !keys.includes(key))) throw new OperationError("invalid_message", "Unexpected review decision field")
  }
  if (fields.dismissed !== undefined) {
    if (fields.dismissed !== true || kind === "guardrail" || kind === "permission" || kind === "recovery") throw new OperationError("invalid_message", "Only questions can be dismissed")
    only("kind", "dismissed")
    return { kind, dismissed: true }
  }
  if (kind === "recovery") {
    only("kind", "choice")
    return { kind, choice: literal(fields.choice, remoteRecoveryChoices, "choice") }
  }
  if (kind === "guardrail" || kind === "permission") {
    only("kind", "reply")
    return { kind, reply: reply(fields.reply) }
  }
  if (kind === "question") {
    only("kind", "answers")
    if (!Array.isArray(fields.answers)) return { kind, answers: formAnswer(fields.answers) }
    if (!fields.answers.every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string")))
      throw new OperationError("invalid_message", "Question answers must be lists of strings")
    return { kind, answers: fields.answers as readonly (readonly string[])[] }
  }
  only("kind", "text", "data")
  const text = requireString(fields.text, "text", 64 * 1024)
  if (fields.data === undefined) return { kind, text }
  const encoded = JSON.stringify(fields.data)
  if (encoded === undefined || new TextEncoder().encode(encoded).length > 8 * 1024) throw new OperationError("invalid_message", "Answer data exceeds 8 KiB")
  return { kind, text, data: fields.data as Extract<ReviewDecision, { kind: "subagent_question"; text: string }>["data"] }
}

function autonomyPayload(fields: Readonly<Record<string, unknown>>): LocalAutonomy {
  const toggles = (["yolo", "autoPermission", "autoGuardrail", "autoAnswer"] as const).filter(
    (field) => fields[field] !== undefined,
  )
  const [field] = toggles
  if (field !== undefined) {
    if (toggles.length > 1 || fields.sleep !== undefined)
      throw new OperationError("invalid_message", "Set one autonomy toggle per request")
    return { [field]: requireBoolean(fields[field], field) } as LocalAutonomy
  }
  if (fields.sleep !== undefined) return { sleep: requireBoolean(fields.sleep, "sleep") }
  throw new OperationError(
    "invalid_message",
    "Autonomy changes require one of yolo, autoPermission, autoGuardrail, autoAnswer, or sleep",
  )
}

function maxNoProgress(fields: Readonly<Record<string, unknown>>) {
  if (fields.maxNoProgress === undefined) return {}
  if (fields.maxNoProgress === null) return { maxNoProgress: null }
  return { maxNoProgress: optionalInteger(fields.maxNoProgress, "maxNoProgress", 0, 1_000) }
}

function reply(value: unknown) {
  return literal(value, ["once", "always", "reject"] as const, "reply")
}

function delivery(value: unknown) {
  return literal(value, ["steer", "queue"] as const, "delivery")
}

function formID(value: unknown) {
  const id = requireString(value, "formID", RemoteLimits.maxRequestIDChars)
  if (!/^frm_[A-Za-z0-9_-]+$/.test(id)) throw new OperationError("invalid_message", 'The "formID" field is invalid')
  return id
}

function formAnswer(value: unknown): FormAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OperationError("invalid_message", 'The "answer" field must be a Form.Answer object')
  const result: FormAnswer = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      result[key] = entry
      continue
    }
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      result[key] = entry
      continue
    }
    throw new OperationError("invalid_message", 'The "answer" field must contain only Form.Value values')
  }
  return result
}

function fileAttachments(value: unknown) {
  if (!Array.isArray(value) || value.length > 64)
    throw new OperationError("invalid_message", 'The "files" field must be a bounded array of attachments')
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null)
      throw new OperationError("invalid_message", 'Each "files" entry must be an object')
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) if (!["uri", "name", "description", "mention"].includes(key)) throw new OperationError("invalid_message", `Unknown attachment field "${key}"`)
    return {
      uri: requireString(record.uri, "files.uri", 2_048),
      ...(record.name === undefined ? {} : { name: requireString(record.name, "files.name", 256) }),
      ...(record.description === undefined
        ? {}
        : { description: requireString(record.description, "files.description", 1_024) }),
      ...(record.mention === undefined ? {} : { mention: mention(record.mention) }),
    }
  })
}

function agentAttachments(value: unknown) {
  if (!Array.isArray(value) || value.length > 64)
    throw new OperationError("invalid_message", 'The "agents" field must be a bounded array of attachments')
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null)
      throw new OperationError("invalid_message", 'Each "agents" entry must be an object')
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) if (!["name", "mention"].includes(key)) throw new OperationError("invalid_message", `Unknown agent field "${key}"`)
    return {
      name: requireString(record.name, "agents.name", 256),
      ...(record.mention === undefined ? {} : { mention: mention(record.mention) }),
    }
  })
}

function promptSkills(value: unknown) {
  if (!Array.isArray(value) || value.length > RemoteLimits.maxPromptSkills)
    throw new OperationError("invalid_message", 'The "skills" field must be a bounded array of skill IDs')
  return value.map((value: unknown) => {
    const id = requireString(value, "skills", 128)
    if (!id.trim()) throw new OperationError("invalid_message", 'The "skills" field requires nonempty skill IDs')
    return { id }
  })
}

function mention(value: unknown) {
  if (typeof value !== "object" || value === null) throw new OperationError("invalid_message", "Invalid mention")
  const record = value as Record<string, unknown>
  const start = optionalInteger(record.start, "mention.start", 0, 1_000_000)
  const end = optionalInteger(record.end, "mention.end", 0, 1_000_000)
  const text = requireString(record.text, "mention.text", 1_024, { allowEmpty: true })
  if (start === undefined || end === undefined) throw new OperationError("invalid_message", "Invalid mention")
  return { start, end, text }
}

function requestIDOf(value: unknown, prefix: string) {
  const id = requireString(value, "requestID", 128)
  if (!id.startsWith(prefix)) throw new OperationError("invalid_message", "Invalid request identifier")
  return id
}

function sessionID(value: unknown, field: string) {
  if (!isSessionID(value)) throw new OperationError("invalid_message", `Invalid ${field}`)
  return value
}

// Shell IDs are opaque references, never paths: only the `sh_` identifier form is
// accepted, so no remote input can select a filesystem location.
function shellID(value: unknown) {
  const id = requireString(value, "shellID", 128)
  if (!/^sh_[A-Za-z0-9]+$/.test(id)) throw new OperationError("invalid_message", "Invalid shellID")
  return id
}

function messageID(value: unknown) {
  const id = requireString(value, "id", 128)
  if (!id.startsWith("msg_")) throw new OperationError("invalid_message", "Invalid message id")
  return id
}

function literal<const Values extends readonly string[]>(value: unknown, values: Values, field: string): Values[number] {
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as Values[number]
  throw new OperationError("invalid_message", `Invalid ${field}`)
}

function isPredictionScope(value: unknown): value is "repository" | "knowledge" {
  return value === "repository" || value === "knowledge"
}

function promptGenerateInput(fields: Readonly<Record<string, unknown>>) {
  const memory = fields.memory
  if (!Array.isArray(memory) || memory.length > 2 || new Set(memory).size !== memory.length || !memory.every(isPredictionScope))
    throw new OperationError("invalid_message", "Invalid prompt memory")
  const intent = requireString(fields.intent, "intent", 4_000)
  if (intent.trim().length === 0) throw new OperationError("invalid_message", "Invalid intent")
  return {
    mode: literal(fields.mode, ["start", "steer", "queue", "goal"] as const, "mode"),
    intent,
    memory: memory.filter(isPredictionScope),
  }
}

function predictionInput(fields: Readonly<Record<string, unknown>>) {
  const memory = fields.memory
  if (!Array.isArray(memory) || memory.length > 2 || new Set(memory).size !== memory.length || !memory.every(isPredictionScope))
    throw new OperationError("invalid_message", "Invalid prediction memory")
  return {
    memory: memory.filter(isPredictionScope),
    ...(fields.hint === undefined ? {} : { hint: requireString(fields.hint, "hint", 2_000, { allowEmpty: true }) }),
  }
}

function requireString(
  value: unknown,
  field: string,
  maxChars: number,
  options: { readonly allowEmpty?: boolean } = {},
) {
  if (typeof value !== "string" || value.length > maxChars || (!options.allowEmpty && value.length === 0))
    throw new OperationError("invalid_message", `Invalid ${field}`)
  return value
}

function requireBoolean(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new OperationError("invalid_message", `Invalid ${field}`)
  return value
}

function optionalInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new OperationError("invalid_message", `Invalid ${field}`)
  return value
}
