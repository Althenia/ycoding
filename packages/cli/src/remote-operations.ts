export * as RemoteOperations from "./remote-operations"

import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Project } from "@ycoding-ai/schema/project"
import type { FormAnswer, SessionInfo } from "@ycoding-ai/client/promise"
import { capturedChildSessionIDs, summarizeCapturedChanges } from "@ycoding-ai/client/file-change-summary"
import { SessionOrchestrationIdentity } from "@ycoding-ai/core/session/orchestration-identity"
import {
  RemoteLimits,
  alertTitle,
  isRemoteLatencySample,
  isSessionID,
  remoteError,
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
  type RemoteCapturedChangesPage,
  type RemoteAttentionDetail,
  type RemoteAttentionNeed,
} from "@ycoding-ai/remote"
import {
  LocalFailure,
  findSession,
  listSessions,
  type LocalAutonomy,
  type LocalLocation,
  type LocalPrompt,
  type LocalServer,
} from "./remote-local"

/** Operations the relay proxies without addressing one session. */
const unscopedOperations: ReadonlySet<RemoteOperation> = new Set([
  "machine.latency.append",
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
  readonly get: (sessionID: string) => Promise<SessionInfo | undefined>
  /** Resolve the Session from the complete backend inventory, then verify its current Location. */
  readonly verify: (sessionID: string) => Promise<SessionInfo | undefined>
  readonly refresh: () => Promise<void>
}

/**
 * Device ownership grants access to the backend's complete Session inventory.
 * Locations always come from that inventory; remote input never selects placement.
 */
export function createSessionRegistry(input: {
  readonly local: LocalServer
  readonly onChange?: () => void
}): SessionRegistry {
  const verified = new Map<string, SessionInfo>()
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
      const sessions = await readAll()
      const before = new Map(verified)
      verified.clear()
      for (const session of sessions) verified.set(session.id, session)
      if (before.size !== sessions.length || sessions.some((session) => sessionInventoryChanged(before.get(session.id), session))) input.onChange?.()
      return sessions
    })
    refreshQueue = run.catch(() => [...verified.values()])
    return run
  }

  const verify = async (sessionID: string) => {
    const info = await findSession(input.local, sessionID)
    if (info === undefined) {
      if (verified.delete(sessionID)) input.onChange?.()
      return undefined
    }
    try {
      const current = await input.local.getSession(sessionID, locationInfo(info))
      const changed = sessionInventoryChanged(verified.get(sessionID), current)
      verified.set(sessionID, current)
      if (changed) input.onChange?.()
      return current
    } catch (cause) {
      if (!(cause instanceof LocalFailure && cause.kind === "not_found")) throw cause
      if (verified.delete(sessionID)) input.onChange?.()
      return undefined
    }
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
    refresh: async () => {
      await refresh()
    },
  }
}

function sessionInventoryChanged(previous: SessionInfo | undefined, current: SessionInfo) {
  if (previous === undefined) return true
  return JSON.stringify([
    previous.title, previous.agent, previous.model, previous.projectID, previous.location,
    previous.time.archived, previous.time.pinned, previous.time.active,
  ]) !== JSON.stringify([
    current.title, current.agent, current.model, current.projectID, current.location,
    current.time.archived, current.time.pinned, current.time.active,
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

async function workspaceInventory(local: LocalServer): Promise<WorkspaceCandidate[]> {
  const [sessions, projects] = await Promise.all([listSessions(local), local.projectList()])
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

async function workspaceList(local: LocalServer): Promise<readonly RemoteWorkspaceInfo[]> {
  return (await workspaceInventory(local)).map((candidate) => candidate.info)
}

async function sessionWorkspaces(local: LocalServer, sessions: readonly SessionInfo[]): Promise<readonly RemoteWorkspaceInfo[]> {
  const projects = new Map((await local.projectList()).map((project) => [project.id, project]))
  const directories = [...new Set(sessions.map((session) => resolve(session.location.directory)))]
  const permitted = new Set((await Promise.all(directories.map(async (directory) => await allowedWorkspaceDirectory(directory) ? directory : undefined)))
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

async function allowedWorkspaceDirectory(directory: string): Promise<boolean> {
  const canonical = await realpath(directory).catch(() => undefined)
  if (canonical === undefined || !(await stat(canonical).then((value) => value.isDirectory(), () => false))) return false
  const temporary = await realpath(tmpdir()).catch(() => tmpdir())
  if ([temporary, "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"].some((root) => contained(root, canonical))) return false
  return !/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(canonical)
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep) && !path.startsWith("/"))
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
  const offeredModels = models.filter((item) => connected.has(item.providerID) && item.enabled)
  return {
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, ...(agent.description === undefined ? {} : { description: agent.description }),
      mode: agent.mode, hidden: agent.hidden, ...(agent.model === undefined ? {} : { model: agent.model }) })),
    models: offeredModels.map((item) => ({
      providerID: item.providerID, providerName: connected.get(item.providerID), id: item.id, name: item.name,
      variants: item.variants.map((variant) => variant.id),
    })),
    ...(model === null ? {} : { defaultModel: { providerID: model.providerID, id: model.id } }),
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
  if (Object.keys(value).some((key) => !["providerID", "id", "variant"].includes(key))) throw new OperationError("invalid_message", "Invalid model")
  const providerID = Reflect.get(value, "providerID")
  const id = Reflect.get(value, "id")
  const variant = Reflect.get(value, "variant")
  return { providerID: requireString(providerID, "providerID", 128), id: requireString(id, "model.id", 128),
    ...(variant === undefined ? {} : { variant: requireString(variant, "variant", 128) }) }
}

async function createRootSession(input: OperationInput, id: string, workspaceID: string, agent?: string, model?: { readonly providerID: string; readonly id: string; readonly variant?: string }): Promise<SessionInfo> {
  const candidate = (await workspaceInventory(input.local)).find((item) => item.info.id === workspaceID)
  if (candidate === undefined) throw new OperationError("invalid_message", "Workspace is unavailable; refresh the workspace list and reopen it")
  if (!(await stat(candidate.location.directory).then((value) => value.isDirectory(), () => false)))
    throw new OperationError("invalid_message", "Workspace is unavailable; refresh the workspace list and reopen it")
  const currentProject = await input.local.projectCurrent(candidate.location)
  if (currentProject.id !== candidate.info.projectID)
    throw new OperationError("invalid_message", "Workspace project changed; refresh the workspace list and reopen it")

  const existing = await findSession(input.local, id)
  if (existing !== undefined) {
    assertRootPlacement(existing, id, candidate)
    const current = await input.local.getSession(id, locationInfo(existing))
    assertRootPlacement(current, id, candidate)
    await input.sessions.refresh()
    return current
  }

  const created = await input.local.createSession(id, candidate.location, agent, model)
  assertRootPlacement(created, id, candidate)
  await input.sessions.refresh()
  const verified = await input.sessions.verify(id)
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

export type OperationInput = {
  readonly request: RemoteRequest
  readonly signal?: AbortSignal
  readonly uploads?: ReturnType<typeof createAttachmentUploads>
  readonly sessions: SessionRegistry
  readonly subscriptions: SubscriptionRegistry
  readonly local: LocalServer
}

export async function executeRemoteOperation(input: OperationInput): Promise<readonly RemoteResponse[]> {
  const request = input.request
  try {
    const value = await run(input)
    return successFrames(request.id, value)
  } catch (cause) {
    if (cause instanceof OperationError) return [failureFrame(request.id, cause.code, cause.message)]
    if (cause instanceof LocalFailure) return [failureFrame(request.id, ...localError(cause, request))]
    return [failureFrame(request.id, "internal_error", "The local agent could not complete the request")]
  }
}

async function run(input: OperationInput) {
  const request = input.request
  // Validation is complete before any local call, so a malformed request never
  // causes local side effects.
  const validated = validate(request)
  if (validated.kind === "workspace.list") return { data: validated.sessionsOnly
    ? await sessionWorkspaces(input.local, input.sessions.snapshot())
    : await workspaceList(input.local) }
  if (validated.kind === "workspace.catalog" || validated.kind === "workspace.file.find") {
    const candidate = (await workspaceInventory(input.local)).find((item) => item.info.id === validated.workspace)
    if (candidate === undefined) throw new OperationError("invalid_message", "Workspace is unavailable")
    const current = await input.local.projectCurrent(candidate.location)
    if (current.id !== candidate.info.projectID) throw new OperationError("invalid_message", "Workspace project changed")
    return validated.kind === "workspace.catalog" ? catalog(input.local, candidate.location) : findFiles(input.local, candidate.location, validated.query, validated.limit)
  }
  if (validated.kind === "session.create")
    return { data: await createRootSession(input, validated.id, validated.workspace, validated.agent, validated.model) }
  if (validated.kind === "list") return listPage(input.sessions.snapshot(), validated.query,
    validated.query.status === undefined && validated.query.order !== "active" ? undefined : new Set((await input.local.outstandingSessions()).running))
  if (validated.kind === "active") {
    const allowed = new Set(input.sessions.ids())
    const active = await input.local.activeSessions()
    return { data: filterActiveSessions(active, allowed) }
  }
  if (validated.kind === "status") {
    const status = await sessionStatus(input.local, input.sessions.snapshot())
    const failed = status.failed.filter((id) => !status.requestAttention.includes(id) && !status.lost?.includes(id)).sort()
    return { running: status.running, attention: status.attention,
      ...(status.outstanding === undefined ? {} : { outstanding: status.outstanding }),
      ...(failed.length === 0 ? {} : { failed }) }
  }
  if (validated.kind === "usage.providers") return { data: (await input.local.providerUsageList(validated.refresh)).data }
  if (validated.kind === "usage.summary") return { data: await input.local.usageSummary() }
  if (validated.kind === "usage.report") return { data: await input.local.usageReport(validated.input) }
  if (validated.kind === "latency.append") return input.local.latencyAppend(validated.samples)
  if (validated.kind === "latency.list") return input.local.latencyList(validated.input)
  if (validated.kind === "keepAwake.get") return { data: await input.local.keepAwakeGet() }
  if (validated.kind === "keepAwake.set") return { data: await input.local.keepAwakeSet(validated.enabled) }
  if (!scopedOperation(request.operation)) return unknownOperation()
  const sessionID = request.sessionID
  if (sessionID === undefined) throw new OperationError("session_required", "Operation requires a session")
  // Verify the Session at its bound Location on every execution, so a moved or
  // deleted Session fails closed instead of being served from stale metadata.
  const verified = await input.sessions.verify(sessionID)
  if (verified === undefined)
    throw new OperationError("session_not_allowed", "Session is not available at its recorded location")
  if (verified.parentID !== undefined && verified.agent !== "btw" && [
    "session.prompt", "session.command", "session.compact", "session.skill", "session.attachment.upload",
    "session.switchModel", "session.switchAgent", "session.autonomy.set", "session.goal.set", "session.goal.stop",
  ].includes(request.operation))
    throw new OperationError("subagent_read_only", "Managed subagents accept input only from their parent Session")
  const location = locationInfo(verified)
  if (validated.kind === "upload") {
    if (!input.uploads) throw new OperationError("invalid_message", "Attachment uploads are unavailable")
    return input.uploads.append(sessionID, validated.uploadID, validated.index, validated.last, validated.data)
  }
  switch (validated.kind) {
    case "get":
      return { data: verified }
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
        if (!first || first.ok || first.error.code !== "message_too_large") return page
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
      const visible: { id: string; ownerID: string; command: string; status: string; startedAt: number; completedAt?: number }[] = []
      for (const { item, location: shellLocation } of shells) {
        if (!item || typeof item !== "object" || !("metadata" in item) || !("id" in item)) continue
        const shell = item as { id: unknown; command?: unknown; status?: unknown; metadata: unknown; time?: { started?: number; completed?: number } }
        const ownerID = shell.metadata && typeof shell.metadata === "object" && "sessionID" in shell.metadata ? shell.metadata.sessionID : undefined
        if (typeof ownerID !== "string" || typeof shell.id !== "string") continue
        const owner = owners.get(ownerID) ?? await input.sessions.verify(ownerID)
        if (!owner || owner.id !== verified.id && owner.parentID !== verified.id || JSON.stringify(locationInfo(owner)) !== JSON.stringify(shellLocation)) continue
        owners.set(ownerID, owner)
        if (visible.length === 50) return { data: visible, truncated: true }
        visible.push({ id: shell.id, ownerID, command: typeof shell.command === "string" ? shell.command.slice(0, 256) : "", status: typeof shell.status === "string" ? shell.status : "exited", startedAt: shell.time?.started ?? 0,
          ...(shell.time?.completed === undefined ? {} : { completedAt: shell.time.completed }) })
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
        const member = await requireFamilyMember(input, verified, ownerID)
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
    case "compaction.list": {
      const history = (await input.local.messages(sessionID, location)).filter((message) =>
        message.type === "compaction" && "jobID" in message,
      ).toSorted((a, b) => a.time.created - b.time.created || a.jobID.localeCompare(b.jobID))
      const completed = history.filter((message) => message.status === "completed" && "metrics" in message)
      return {
        data: history.slice(-RemoteLimits.maxCompactionHistory).map((message) => ({
          jobID: message.jobID,
          trigger: message.trigger,
          status: message.status,
          created: message.time.created,
          ...(message.status === "completed" ? { metrics: message.metrics } : {}),
          ...(message.status === "failed" ? { code: message.code } : {}),
        })),
        truncated: history.length > RemoteLimits.maxCompactionHistory,
        completedBefore: history.slice(0, -RemoteLimits.maxCompactionHistory).filter((message) => message.status === "completed").length,
        completedCount: completed.length,
        totalSavedTokens: completed.reduce((total, message) => total + message.metrics.inputTokens - message.metrics.retainedTokens, 0),
      }
    }
    case "todo.list":
      return { data: await input.local.todoList(sessionID, location) }
    case "autonomy.get":
      return { data: await input.local.autonomyGet(sessionID, location) }
    case "permission.list":
      return { data: await input.local.permissionList(sessionID, location) }
    case "guardrail.status":
      return { data: await input.local.guardrailStatus(sessionID, location) }
    case "guardrail.request.list": {
      const listing = await input.local.guardrailRequestList(sessionID, location)
      return { data: asReviewList(listing) }
    }
    case "form.list":
      return await input.local.formList(sessionID, location)
    case "shell.output": {
      // Ownership is proven from the shell's own recorded Session before any output
      // byte is read, so a granted Session can never page another Session's capture.
      await requireOwnedShell(input, sessionID, location, validated.shellID)
      return {
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
  | { readonly kind: "latency.append"; readonly samples: readonly RemoteLatencySample[] }
  | { readonly kind: "latency.list"; readonly input: { readonly limit?: number; readonly before?: string } }
  | { readonly kind: "keepAwake.get" }
  | { readonly kind: "keepAwake.set"; readonly enabled: boolean }
  | { readonly kind: "compact"; readonly id: string }
  | { readonly kind: "workspace.list"; readonly sessionsOnly: boolean }
  | { readonly kind: "list"; readonly query: ListQuery }
  | { readonly kind: "active" }
  | { readonly kind: "status" }
  | { readonly kind: "usage.providers"; readonly refresh?: boolean }
  | { readonly kind: "usage.summary" }
  | { readonly kind: "usage.report"; readonly input: RemoteUsageReportInput }
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
  | { readonly kind: "snapshot"; readonly limit?: number; readonly before?: string }
  | { readonly kind: "capturedChanges.list"; readonly cursor?: string }
  | { readonly kind: "attachment.read"; readonly digest: string }
  | { readonly kind: "message.stream"; readonly messageID: string }
  | { readonly kind: "subagent.list"; readonly cursor?: string }
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
  | { readonly kind: "permission.reply"; readonly requestID: string; readonly reply: Reply; readonly message?: string }
  | { readonly kind: "guardrail.reply"; readonly requestID: string; readonly reply: Reply }
  | { readonly kind: "form.reply"; readonly formID: string; readonly answer: FormAnswer }
  | { readonly kind: "form.cancel"; readonly formID: string }
  | { readonly kind: "autonomy.set"; readonly payload: LocalAutonomy }
  | { readonly kind: "goal.set"; readonly payload: LocalAutonomy }
  | { readonly kind: "goal.stop" }

const plainKinds: Readonly<Record<string, Validated["kind"]>> = {
  "session.get": "get",
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
  "session.form.list": "form.list",
  "session.subscribe": "subscribe",
  "session.unsubscribe": "unsubscribe",
  "session.interrupt": "interrupt",
  "session.team.shell.list": "team.shell.list",
}

function validate(request: RemoteRequest): Validated {
  const fields = validateFields(request)
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
  if (request.operation === "usage.report") {
    const group = literal(fields.group, ["model", "hour", "day", "month", "session", "project", "agent"], "group")
    const from = optionalInteger(fields.from, "from", 0, Number.MAX_SAFE_INTEGER)
    const to = optionalInteger(fields.to, "to", 0, Number.MAX_SAFE_INTEGER)
    if (from !== undefined && to !== undefined && from >= to) throw new OperationError("invalid_message", "Usage report from must precede to")
    return { kind: "usage.report", input: { group,
      ...(fields.timeZone === undefined ? {} : { timeZone: requireString(fields.timeZone, "timeZone", 128) }),
      ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
      ...(fields.offset === undefined ? {} : { offset: optionalInteger(fields.offset, "offset", 0, Number.MAX_SAFE_INTEGER)! }),
      ...(fields.limit === undefined ? {} : { limit: optionalInteger(fields.limit, "limit", 1, 200)! }),
      ...(fields.sort === undefined ? {} : { sort: literal(fields.sort, ["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"], "sort") }),
      ...(fields.order === undefined ? {} : { order: literal(fields.order, ["asc", "desc"], "order") }),
    } }
  }
  if (request.operation === "workspace.catalog") return { kind: "workspace.catalog", workspace: requireString(fields.workspace, "workspace", 128) }
  if (request.operation === "workspace.file.find" || request.operation === "session.file.find") {
    const query = requireString(fields.query, "query", 200)
    const limit = optionalInteger(fields.limit, "limit", 1, 50) ?? 20
    return request.operation === "workspace.file.find" ? { kind: "workspace.file.find", workspace: requireString(fields.workspace, "workspace", 128), query, limit } : { kind: "file.find", query, limit }
  }
  if (request.operation === "session.subagent.list") return { kind: "subagent.list", cursor: fields.cursor === undefined ? undefined : requireString(fields.cursor, "cursor", 1_024) }
  if (request.operation === "session.subagent.cancel") return { kind: "subagent.cancel", childID: sessionID(fields.childID, "childID") }
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
      return { kind: "autonomy.set", payload: yoloPayload(fields) }
    case "session.goal.set":
      return {
        kind: "goal.set",
        payload: { goal: requireString(fields.goal, "goal", 8_192), ...maxNoProgress(fields) },
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
  return !unscopedOperations.has(operation) && requireSession(operation)
}

async function requireFamilyMember(input: OperationInput, root: SessionInfo, memberID: string, managed = false): Promise<SessionInfo> {
  if (root.parentID !== undefined) throw new OperationError("forbidden", "Team requires a root Session")
  if (memberID === root.id && !managed) return root
  const member = await input.sessions.verify(memberID)
  if (member?.parentID !== root.id || managed && member.agent === "btw") throw new OperationError("forbidden", "Session is not a direct family member")
  return member
}

async function capturedChangesPage(input: OperationInput, owner: SessionInfo, sessionID: string, location: LocalLocation, requestID: string, cursor?: string): Promise<RemoteCapturedChangesPage> {
  const parent = await input.local.messages(sessionID, location)
  const children = new Map<string, typeof parent>()
  if (owner.parentID === undefined) {
    for (const childID of capturedChildSessionIDs(parent)) {
      const child = await input.sessions.verify(childID)
      if (child?.parentID !== owner.id || child.agent === "btw") continue
      children.set(childID, await input.local.messages(child.id, locationInfo(child)))
    }
  }
  const groups = summarizeCapturedChanges(parent, children, (assistantMessageID, callID) => SessionOrchestrationIdentity.send(sessionID, assistantMessageID, callID))
    .flatMap((unit) => unit.files.map((file) => ({ placementMessageID: unit.placementMessageID, ...file })))
  if (groups.length === 0) {
    if (cursor !== undefined) throw new OperationError("invalid_message", "Captured change cursor is stale")
    return { data: [] }
  }
  const digest = createHash("sha256").update(sessionID).update(JSON.stringify(groups)).digest("hex")
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
  for (const original of groups.slice(offset)) {
    const group = JSON.stringify(original).length > maxCapturedPageChars
      ? { ...original, additions: 0, deletions: 0, files: [{ path: original.path, diff: "", additions: 0, deletions: 0, status: original.status, unavailable: true }] }
      : original
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

async function familyLocations(input: OperationInput, root: SessionInfo): Promise<readonly LocalLocation[]> {
  const locations = new Map<string, LocalLocation>()
  const add = (location: LocalLocation) => locations.set(JSON.stringify(location), location)
  add(locationInfo(root))
  for (const child of input.sessions.snapshot().filter((session) => session.parentID === root.id)) {
    if (locations.has(JSON.stringify(locationInfo(child)))) continue
    if (locations.size >= RemoteLimits.maxFamilyMembers) throw new OperationError("message_too_large", "Team spans too many Locations for one shell read")
    const current = await input.sessions.verify(child.id)
    if (current?.parentID === root.id) add(locationInfo(current))
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

export async function sessionStatus(local: LocalServer, sessions: readonly SessionInfo[], knownAttention?: Readonly<Record<string, RemoteAttentionNeed>>, knownFailures?: ReadonlySet<string>) {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const rootOf = (sessionID: unknown) => {
    const session = typeof sessionID === "string" ? byID.get(sessionID) : undefined
    return session === undefined ? undefined : rootSessionID(session, byID)
  }
  const work = await local.outstandingSessions(knownFailures === undefined)
  if (!Array.isArray(work.lost))
    throw new OperationError("internal_error", "Local server requires an update before remote Session status can be read")
  const executing = work.running.flatMap((id) => byID.get(id) ?? [])
  const running = new Set(executing.flatMap((session) => rootSessionID(session, byID) ?? []))
  const outstanding = new Set(work.data.flatMap((id) => rootOf(id) ?? []).filter((id) => !running.has(id)))
  const failed = knownFailures ?? new Set(work.failed.flatMap((id) => rootOf(id) ?? []))
  const lost = new Set(work.lost.flatMap((id) => rootOf(id) ?? []))
  if (running.size > RemoteLimits.maxStatusSessions || (knownAttention !== undefined && Object.keys(knownAttention).length > RemoteLimits.maxStatusSessions))
    throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  if (outstanding.size > RemoteLimits.maxStatusSessions) throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
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
  if (attention.size > RemoteLimits.maxStatusSessions)
    throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  const requestAttention = [...attention.keys()].sort()
  const combined = [...new Set([...requestAttention, ...failed, ...lost])].sort()
  if (combined.length > RemoteLimits.maxStatusSessions) throw new OperationError("message_too_large", "Session status exceeds the bounded root count")
  return { running: [...running].sort(), attention: combined, requestAttention, requestNeeds: Object.fromEntries(attention), failed: [...failed],
    ...(outstanding.size === 0 ? {} : { outstanding: [...outstanding].sort() }),
    ...(lost.size === 0 ? {} : { lost: [...lost].sort() }) }
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

type Cursor = { readonly id: string; readonly time: number; readonly direction: "next" | "previous"; readonly pinned?: number | null; readonly running?: boolean }

export type ListQuery = {
  readonly order: "asc" | "desc" | "pinned" | "active"
  readonly search?: string
  readonly searchFields?: "summary"
  readonly workspace?: string
  readonly status?: "running" | "idle"
  readonly parentID?: string | null
  readonly limit: number
  readonly anchor?: Cursor
}

export function parseListQuery(fields: Readonly<Record<string, unknown>>): ListQuery {
  const order = fields.order === undefined ? "desc" : literal(fields.order, ["asc", "desc", "pinned", "active"], "order")
  const anchor = fields.cursor === undefined ? undefined : cursor(fields.cursor)
  if (order === "pinned" && anchor !== undefined && anchor.pinned === undefined)
    throw new OperationError("invalid_message", "Pinned Session cursor is missing its sort key")
  if (order === "active" && anchor !== undefined && anchor.running === undefined)
    throw new OperationError("invalid_message", "Active Session cursor is missing its sort key")
  return {
    order,
    search: fields.search === undefined ? undefined : requireString(fields.search, "search", 200, { allowEmpty: true }),
    searchFields: fields.searchFields === undefined ? undefined : literal(fields.searchFields, ["summary"], "searchFields"),
    workspace: fields.workspace === undefined ? undefined : requireString(fields.workspace, "workspace", 128),
    status: fields.status === undefined ? undefined : literal(fields.status, ["running", "idle"], "status"),
    parentID: fields.parentID === undefined ? undefined : fields.parentID === null ? null : sessionID(fields.parentID, "parentID"),
    limit: fields.limit === undefined ? 50 : optionalInteger(fields.limit, "limit", 1, RemoteLimits.maxSessionListPage)!,
    anchor,
  }
}

/** Page the complete backend Session list without truncation. */
export function listPage(sessions: readonly SessionInfo[], query: ListQuery, running?: ReadonlySet<string>) {
  const { order, search, parentID, limit, anchor } = query
  const direction = anchor?.direction ?? "next"
  const effectiveOrder = order === "pinned" || order === "active" ? order : direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const runningRoots = new Set(sessions.filter((session) => running?.has(session.id)).map((session) => rootSessionID(session, byID)).filter((id): id is string => id !== undefined))
  const isRunning = (session: SessionInfo) => session.parentID === undefined ? runningRoots.has(session.id) : running?.has(session.id) === true
  const activeKey = (session: SessionInfo) => ({ id: session.id, time: session.time.active ?? session.time.updated,
    running: session.parentID === undefined && runningRoots.has(session.id) })
  const needle = search?.toLowerCase()
  const matching = sessions
    .filter((session) => query.workspace === undefined || workspaceKey(session.projectID, resolve(session.location.directory), session.location.workspaceID) === query.workspace)
    .filter((session) => needle === undefined || (query.searchFields === "summary"
      ? [session.title, session.agent ?? "", ...(session.model === undefined ? [] : [`${session.model.providerID}/${session.model.id}${session.model.variant === undefined ? "" : `#${session.model.variant}`}`])]
        .some((value) => value.toLowerCase().includes(needle))
      : session.title.toLowerCase().includes(needle)))
    .filter((session) => query.status === undefined || (query.status === "running" ? isRunning(session) : !isRunning(session) && session.time.archived === undefined))
    .filter((session) => (parentID === undefined ? true : (session.parentID ?? null) === parentID))
    .sort(order === "active" ? (left, right) => compareActiveSessions(activeKey(left), activeKey(right)) : order === "pinned" ? comparePinnedSessions : compareSessions)
  const ordered = effectiveOrder === "asc" || ((effectiveOrder === "pinned" || effectiveOrder === "active") && direction === "next") ? matching : matching.toReversed()
  const anchored = anchor === undefined ? ordered : ordered.filter((session) => effectiveOrder === "active"
    ? compareActiveSessions(activeKey(session), { id: anchor.id, time: anchor.time, running: anchor.running === true }) * (direction === "next" ? 1 : -1) > 0
    : effectiveOrder === "pinned"
      ? comparePinnedSessions(session, { id: anchor.id, time: { updated: anchor.time, pinned: anchor.pinned ?? undefined } }) * (direction === "next" ? 1 : -1) > 0
      : afterAnchor(session, anchor, effectiveOrder))
  const page = anchored.slice(0, limit)
  const remaining = anchored.length - page.length
  const data = direction === "previous" ? page.toReversed() : page
  const first = data[0]
  const last = data.at(-1)
  return {
    data,
    cursor: {
      previous: first && (direction === "next" ? anchor !== undefined : remaining > 0)
        ? encodeCursor({ id: first.id, time: order === "active" ? activeKey(first).time : first.time.updated, direction: "previous", ...(order === "pinned" ? { pinned: first.time.pinned ?? null } : {}), ...(order === "active" ? { running: activeKey(first).running } : {}) })
        : undefined,
      next: last && (direction === "previous" ? anchor !== undefined : remaining > 0)
        ? encodeCursor({ id: last.id, time: order === "active" ? activeKey(last).time : last.time.updated, direction: "next", ...(order === "pinned" ? { pinned: last.time.pinned ?? null } : {}), ...(order === "active" ? { running: activeKey(last).running } : {}) })
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
    return { id: record.id, time: record.time, direction: literal(record.direction, ["next", "previous"], "cursor"),
      ...(record.pinned === undefined ? {} : { pinned: record.pinned }), ...(record.running === undefined ? {} : { running: record.running }) }
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

function compareActiveSessions(left: { readonly id: string; readonly time: number; readonly running: boolean }, right: { readonly id: string; readonly time: number; readonly running: boolean }) {
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
  "machine.latency.append": ["samples"],
  "machine.latency.list": ["limit", "before"],
  "machine.keepAwake.get": [],
  "machine.keepAwake.set": ["enabled"],
  "workspace.list": ["sessionsOnly"],
  "session.list": ["limit", "order", "search", "searchFields", "parentID", "cursor", "workspace", "status"],
  "session.active": [],
  "usage.providers": ["refresh"],
  "usage.summary": [],
  "usage.report": ["group", "timeZone", "from", "to", "offset", "limit", "sort", "order"],
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
  "session.form.list": [],
  "session.shell.output": ["shellID", "cursor", "limit"],
  "session.subscribe": [],
  "session.unsubscribe": [],
  "session.prompt": ["id", "text", "files", "agents", "delivery", "resume", "skills"],
  "session.interrupt": [],
  "session.permission.reply": ["requestID", "reply", "message"],
  "session.guardrail.reply": ["requestID", "reply"],
  "session.form.reply": ["formID", "answer"],
  "session.form.cancel": ["formID"],
  "session.autonomy.set": ["yolo", "maxNoProgress"],
  "session.goal.set": ["goal", "maxNoProgress"],
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
  "machine.latency.append",
  "machine.keepAwake.set",
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
  "session.permission.reply",
  "session.guardrail.reply",
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
  "session.permission.reply",
  "session.guardrail.reply",
  "session.form.reply",
  "session.form.cancel",
])

function localError(cause: LocalFailure, request: RemoteRequest): readonly [RemoteErrorCode, string] {
  switch (cause.kind) {
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
    default:
      return ["internal_error", "The local server failed the request"]
  }
}

function yoloPayload(fields: Readonly<Record<string, unknown>>) {
  const yolo = fields.yolo
  if (typeof yolo === "boolean") return { yolo, ...maxNoProgress(fields) }
  if (typeof yolo === "number" && Number.isInteger(yolo) && yolo >= 0 && yolo <= 3)
    return { yolo, ...maxNoProgress(fields) }
  throw new OperationError("invalid_message", 'The "yolo" field must be 0-3 or a boolean')
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
