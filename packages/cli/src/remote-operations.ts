export * as RemoteOperations from "./remote-operations"

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
} from "@ycoding-ai/remote"
import {
  LocalFailure,
  findSession,
  type LocalAutonomy,
  type LocalLocation,
  type LocalPrompt,
  type LocalServer,
} from "./remote-local"

/** Operations the relay proxies without addressing one session. */
export const unscopedOperations: ReadonlySet<RemoteOperation> = new Set(["session.list", "session.active"])

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
  readonly list: () => Promise<readonly SessionInfo[]>
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
  readonly staleMs?: number
  readonly now?: () => number
  readonly onChange?: () => void
}): SessionRegistry {
  const now = input.now ?? Date.now
  const staleMs = input.staleMs ?? 5_000
  const verified = new Map<string, SessionInfo>()
  let refreshedAt = Number.NEGATIVE_INFINITY
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
      const before = [...verified.keys()].sort().join(",")
      verified.clear()
      for (const session of sessions) verified.set(session.id, session)
      refreshedAt = now()
      if ([...verified.keys()].sort().join(",") !== before) input.onChange?.()
      return sessions
    })
    refreshQueue = run.catch(() => [...verified.values()])
    return run
  }

  const ensureFresh = async () => {
    if (now() - refreshedAt < staleMs) return [...verified.values()]
    return refresh()
  }

  const verify = async (sessionID: string) => {
    const info = await findSession(input.local, sessionID)
    if (info === undefined) {
      if (verified.delete(sessionID)) input.onChange?.()
      return undefined
    }
    try {
      const current = await input.local.getSession(sessionID, locationInfo(info))
      verified.set(sessionID, current)
      return current
    } catch (cause) {
      if (!(cause instanceof LocalFailure && cause.kind === "not_found")) throw cause
      if (verified.delete(sessionID)) input.onChange?.()
      return undefined
    }
  }

  return {
    ids: () => [...verified.keys()],
    list: ensureFresh,
    get: verify,
    verify,
    refresh: async () => {
      await refresh()
    },
  }
}

function locationInfo(info: { readonly location: { readonly directory: string; readonly workspaceID?: string } }): LocalLocation {
  return {
    directory: info.location.directory,
    ...(info.location.workspaceID === undefined ? {} : { workspaceID: info.location.workspaceID }),
  }
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
  if (validated.kind === "list") return listPage(await input.sessions.list(), validated.query)
  if (validated.kind === "active") {
    // The local route is process-wide; retain only IDs present in the current
    // complete backend inventory.
    await input.sessions.list()
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
  | { readonly kind: "list"; readonly query: ListQuery }
  | { readonly kind: "active" }
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
  if (request.operation === "session.list") return { kind: "list", query: parseListQuery(fields) }
  if (request.operation === "session.active") return { kind: "active" }
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

type Cursor = { readonly id: string; readonly time: number; readonly direction: "next" | "previous" }

export type ListQuery = {
  readonly order: "asc" | "desc"
  readonly search?: string
  readonly parentID?: string | null
  readonly limit: number
  readonly anchor?: Cursor
}

export function parseListQuery(fields: Readonly<Record<string, unknown>>): ListQuery {
  return {
    order: fields.order === undefined ? "desc" : literal(fields.order, ["asc", "desc"], "order"),
    search: fields.search === undefined ? undefined : requireString(fields.search, "search", 200, { allowEmpty: true }),
    parentID: fields.parentID === undefined ? undefined : fields.parentID === null ? null : sessionID(fields.parentID, "parentID"),
    limit: fields.limit === undefined ? 50 : optionalInteger(fields.limit, "limit", 1, RemoteLimits.maxSessionListPage)!,
    anchor: fields.cursor === undefined ? undefined : cursor(fields.cursor),
  }
}

/** Page the complete backend Session list without truncation. */
export function listPage(sessions: readonly SessionInfo[], query: ListQuery) {
  const { order, search, parentID, limit, anchor } = query
  const direction = anchor?.direction ?? "next"
  const effectiveOrder = direction === "previous" ? (order === "asc" ? "desc" : "asc") : order
  const matching = sessions
    .filter((session) => (search === undefined ? true : session.title.toLowerCase().includes(search.toLowerCase())))
    .filter((session) => (parentID === undefined ? true : (session.parentID ?? null) === parentID))
    .sort(compareSessions)
  const ordered = effectiveOrder === "asc" ? matching : matching.toReversed()
  const anchored = anchor === undefined ? ordered : ordered.filter((session) => afterAnchor(session, anchor, effectiveOrder))
  const page = anchored.slice(0, limit)
  const remaining = anchored.length - page.length
  const data = direction === "previous" ? page.toReversed() : page
  const first = data[0]
  const last = data.at(-1)
  return {
    data,
    cursor: {
      previous:
        direction === "next" && anchor !== undefined && first
          ? encodeCursor({ id: first.id, time: first.time.updated, direction: "previous" })
          : undefined,
      next: remaining > 0 && last ? encodeCursor({ id: last.id, time: last.time.updated, direction: "next" }) : undefined,
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
    return { id: record.id, time: record.time, direction: literal(record.direction, ["next", "previous"], "cursor") }
  } catch {
    throw new OperationError("invalid_message", "Invalid cursor")
  }
}

function compareSessions(left: SessionInfo, right: SessionInfo) {
  if (left.time.updated !== right.time.updated) return left.time.updated - right.time.updated
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function afterAnchor(session: SessionInfo, anchor: Cursor, order: "asc" | "desc") {
  if (session.time.updated !== anchor.time)
    return order === "asc" ? session.time.updated > anchor.time : session.time.updated < anchor.time
  return order === "asc" ? session.id > anchor.id : session.id < anchor.id
}

const allowedFields: Readonly<Record<string, readonly string[]>> = {
  "session.list": ["limit", "order", "search", "parentID", "cursor"],
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
}

function validateFields(request: RemoteRequest): Readonly<Record<string, unknown>> {
  const fields = request.input ?? {}
  const allowed = allowedFields[request.operation] ?? []
  for (const key of Object.keys(fields))
    if (!allowed.includes(key)) throw new OperationError("invalid_message", `Unknown input field "${key}"`)
  return fields
}

const mutations: ReadonlySet<string> = new Set([
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
