export * as RemoteOperations from "./remote-operations"

import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { Project } from "@ycoding-ai/schema/project"
import type { FormAnswer, SessionInfo } from "@ycoding-ai/client/promise"
import {
  RemoteLimits,
  isSessionID,
  remoteError,
  requireSession,
  serializeResponse,
  type RemoteErrorCode,
  type RemoteOperation,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteWorkspaceInfo,
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
export const unscopedOperations: ReadonlySet<RemoteOperation> = new Set([
  "workspace.list",
  "session.list",
  "session.active",
  "session.create",
])

// Authorization and mapping for the closed relay operation set. The local agent
// resolves every scoped Session against the backend; no remote field can select a
// URL, HTTP method, or Location header.

const maxLogReadItems = 2_000

// One shell-output request returns one page at most: the local default page, so a
// remote reader pages explicitly instead of asking the device for unbounded output.
const maxShellOutputPage = 65_536

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
      if (take === 1 || serializeResponse(candidate).length <= RemoteLimits.maxAgentMessageChars) break
      take = Math.max(1, Math.floor(take / 2))
    }
    const last = offset + take >= text.length
    frames.push({ type: "response", id, ok: true, value: text.slice(offset, offset + take), chunk: { index, last } })
    offset += take
  }
  return frames
}

export function failureFrame(id: string, code: RemoteErrorCode, message: string): RemoteResponse {
  return { type: "response", id, ok: false, error: remoteError(code, message) }
}

export type SubscriptionRegistry = {
  readonly apply: (clientID: string, sessionIDs: readonly string[]) => void
  readonly clear: () => void
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
  const changed = () => options.onChange?.()
  return {
    apply(clientID, sessionIDs) {
      if (sessionIDs.length === 0) clients.delete(clientID)
      else clients.set(clientID, new Set(sessionIDs))
      changed()
    },
    clear() {
      if (clients.size === 0) return
      clients.clear()
      changed()
    },
    has: (sessionID) => Array.from(clients.values()).some((sessions) => sessions.has(sessionID)),
    count: (sessionID) => Array.from(clients.values()).filter((sessions) => sessions.has(sessionID)).length,
    sessions: () => [...new Set(Array.from(clients.values()).flatMap((sessions) => [...sessions]))],
  }
}

export type SessionRegistry = {
  readonly ids: () => readonly string[]
  readonly snapshot: () => readonly SessionInfo[]
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
    previous.time.updated, previous.time.archived, previous.time.pinned,
  ]) !== JSON.stringify([
    current.title, current.agent, current.model, current.projectID, current.location,
    current.time.updated, current.time.archived, current.time.pinned,
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
  const add = (projectID: string, directory: string, workspaceID?: string) => {
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
        ...(project?.name === undefined ? {} : { name: project.name }),
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
  for (const candidate of candidates.values()) {
    if (await stat(candidate.location.directory).then((value) => value.isDirectory(), () => false)) existing.push(candidate)
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
  return [...new Map(sessions.map((session) => {
    const projectID = session.projectID
    const directory = session.location.directory
    const id = workspaceKey(projectID, directory, session.location.workspaceID)
    const name = projects.get(projectID)?.name
    return [id, { id, projectID, directory,
      ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }),
      ...(name === undefined ? {} : { name }) } as RemoteWorkspaceInfo] as const
  })).values()].toSorted((left, right) => left.projectID.localeCompare(right.projectID) || left.directory.localeCompare(right.directory) || left.id.localeCompare(right.id))
}

async function createRootSession(input: OperationInput, id: string, workspaceID: string): Promise<SessionInfo> {
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

  const created = await input.local.createSession(id, candidate.location)
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
  if (validated.kind === "session.create")
    return { data: await createRootSession(input, validated.id, validated.workspace) }
  if (validated.kind === "list") return listPage(input.sessions.snapshot(), validated.query,
    validated.query.status === undefined ? undefined : activeIDs(await input.local.activeSessions()))
  if (validated.kind === "active") {
    const allowed = new Set(input.sessions.ids())
    const active = await input.local.activeSessions()
    return { data: filterActiveSessions(active, allowed) }
  }
  if (!scopedOperation(request.operation)) return unknownOperation()
  const sessionID = request.sessionID
  if (sessionID === undefined) throw new OperationError("session_required", "Operation requires a session")
  // Verify the Session at its bound Location on every execution, so a moved or
  // deleted Session fails closed instead of being served from stale metadata.
  const verified = await input.sessions.verify(sessionID)
  if (verified === undefined)
    throw new OperationError("session_not_allowed", "Session is not available at its recorded location")
  const location = locationInfo(verified)
  switch (validated.kind) {
    case "get":
      return { data: verified }
    case "snapshot":
      return await input.local.snapshot(sessionID, location)
    case "messages":
      return { data: await input.local.messages(sessionID, location) }
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
    case "fileChange.list":
      return { data: await input.local.fileChangeList(sessionID, location) }
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
      return { data: await input.local.prompt(sessionID, location, validated.input) }
    case "interrupt":
      await input.local.interrupt(sessionID, location)
      return null
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
  | { readonly kind: "workspace.list"; readonly sessionsOnly: boolean }
  | { readonly kind: "list"; readonly query: ListQuery }
  | { readonly kind: "active" }
  | { readonly kind: "session.create"; readonly id: string; readonly workspace: string }
  | { readonly kind: "get" }
  | { readonly kind: "snapshot" }
  | { readonly kind: "messages" }
  | { readonly kind: "autonomy.get" }
  | { readonly kind: "permission.list" }
  | { readonly kind: "guardrail.status" }
  | { readonly kind: "guardrail.request.list" }
  | { readonly kind: "form.list" }
  | { readonly kind: "fileChange.list" }
  | { readonly kind: "shell.output"; readonly shellID: string; readonly cursor?: number; readonly limit: number }
  | { readonly kind: "log"; readonly after?: number }
  | { readonly kind: "subscribe" }
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
  "session.snapshot": "snapshot",
  "session.messages": "messages",
  "session.autonomy.get": "autonomy.get",
  "session.permission.list": "permission.list",
  "session.guardrail.status": "guardrail.status",
  "session.guardrail.request.list": "guardrail.request.list",
  "session.form.list": "form.list",
  "session.fileChange.list": "fileChange.list",
  "session.subscribe": "subscribe",
  "session.unsubscribe": "unsubscribe",
  "session.interrupt": "interrupt",
}

function validate(request: RemoteRequest): Validated {
  const fields = validateFields(request)
  if (request.operation === "workspace.list") return { kind: "workspace.list", sessionsOnly: fields.sessionsOnly === true }
  if (request.operation === "session.list") return { kind: "list", query: parseListQuery(fields) }
  if (request.operation === "session.active") return { kind: "active" }
  if (request.operation === "session.create")
    return {
      kind: "session.create",
      id: sessionID(fields.id, "id"),
      workspace: requireString(fields.workspace, "workspace", 128),
    }
  const plain = plainKinds[request.operation]
  if (plain !== undefined) return { kind: plain } as Validated
  switch (request.operation) {
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

/** Running status is only ever reported for Sessions the user shared. */
export function filterActiveSessions(value: unknown, allowed: ReadonlySet<string>) {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(Object.entries(value).filter(([sessionID]) => allowed.has(sessionID)))
}

type Cursor = { readonly id: string; readonly time: number; readonly direction: "next" | "previous"; readonly pinned?: number | null }

export type ListQuery = {
  readonly order: "asc" | "desc" | "pinned"
  readonly search?: string
  readonly searchFields?: "summary"
  readonly workspace?: string
  readonly status?: "running" | "idle"
  readonly parentID?: string | null
  readonly limit: number
  readonly anchor?: Cursor
}

export function parseListQuery(fields: Readonly<Record<string, unknown>>): ListQuery {
  const order = fields.order === undefined ? "desc" : literal(fields.order, ["asc", "desc", "pinned"], "order")
  const anchor = fields.cursor === undefined ? undefined : cursor(fields.cursor)
  if (order === "pinned" && anchor !== undefined && anchor.pinned === undefined)
    throw new OperationError("invalid_message", "Pinned Session cursor is missing its sort key")
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
  const effectiveOrder = order === "pinned" ? "pinned" : direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const needle = search?.toLowerCase()
  const matching = sessions
    .filter((session) => query.workspace === undefined || workspaceKey(session.projectID, session.location.directory, session.location.workspaceID) === query.workspace)
    .filter((session) => needle === undefined || (query.searchFields === "summary"
      ? [session.title, session.agent ?? "", ...(session.model === undefined ? [] : [`${session.model.providerID}/${session.model.id}${session.model.variant === undefined ? "" : `#${session.model.variant}`}`])]
        .some((value) => value.toLowerCase().includes(needle))
      : session.title.toLowerCase().includes(needle)))
    .filter((session) => query.status === undefined || (query.status === "running" ? running?.has(session.id) === true : running?.has(session.id) !== true && session.time.archived === undefined))
    .filter((session) => (parentID === undefined ? true : (session.parentID ?? null) === parentID))
    .sort(order === "pinned" ? comparePinnedSessions : compareSessions)
  const ordered = effectiveOrder === "asc" || (effectiveOrder === "pinned" && direction === "next") ? matching : matching.toReversed()
  const anchored = anchor === undefined ? ordered : ordered.filter((session) => effectiveOrder === "pinned"
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
        ? encodeCursor({ id: first.id, time: first.time.updated, direction: "previous", ...(order === "pinned" ? { pinned: first.time.pinned ?? null } : {}) })
        : undefined,
      next: last && (direction === "previous" ? anchor !== undefined : remaining > 0)
        ? encodeCursor({ id: last.id, time: last.time.updated, direction: "next", ...(order === "pinned" ? { pinned: last.time.pinned ?? null } : {}) })
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
    return { id: record.id, time: record.time, direction: literal(record.direction, ["next", "previous"], "cursor"),
      ...(record.pinned === undefined ? {} : { pinned: record.pinned }) }
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
  "workspace.list": ["sessionsOnly"],
  "session.list": ["limit", "order", "search", "searchFields", "parentID", "cursor", "workspace", "status"],
  "session.active": [],
  "session.get": [],
  "session.snapshot": [],
  "session.messages": [],
  "session.log": ["after"],
  "session.autonomy.get": [],
  "session.permission.list": [],
  "session.guardrail.status": [],
  "session.guardrail.request.list": [],
  "session.form.list": [],
  "session.fileChange.list": [],
  "session.shell.output": ["shellID", "cursor", "limit"],
  "session.subscribe": [],
  "session.unsubscribe": [],
  "session.prompt": ["id", "text", "files", "agents", "delivery", "resume"],
  "session.interrupt": [],
  "session.permission.reply": ["requestID", "reply", "message"],
  "session.guardrail.reply": ["requestID", "reply"],
  "session.form.reply": ["formID", "answer"],
  "session.form.cancel": ["formID"],
  "session.autonomy.set": ["yolo", "maxNoProgress"],
  "session.goal.set": ["goal", "maxNoProgress"],
  "session.goal.stop": ["goal"],
  "session.create": ["id", "workspace"],
}

function validateFields(request: RemoteRequest): Readonly<Record<string, unknown>> {
  const fields = request.input ?? {}
  const allowed = allowedFields[request.operation] ?? []
  for (const key of Object.keys(fields))
    if (!allowed.includes(key)) throw new OperationError("invalid_message", `Unknown input field "${key}"`)
  return fields
}

const mutations: ReadonlySet<string> = new Set([
  "session.create",
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
      if (reviewReplies.has(request.operation))
        return ["invalid_message", "That request is no longer pending; reload before replying"]
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
      return ["message_too_large", "The local response exceeded the bounded response size; read again with after"]
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
