/**
 * YCoding remote transport contract.
 *
 * This module is the single source of truth shared by the Cloudflare relay
 * (`infra/cloudflare`), the local agent transport, and the remote web client.
 * It depends on nothing outside the standard library so it can run unchanged in
 * workerd and in the browser.
 *
 * Two WebSocket surfaces use one envelope vocabulary:
 *
 * - Browser: `GET /ws/v4/client?device=<deviceID>` authenticated by the browser
 *   session cookie, then device selection. Client frames are `request` and `ping`
 *   (plus the `pong` heartbeat reply).
 * - Local agent: `GET /ws/v4/agent` authenticated by `Authorization: Bearer <access
 *   token>` from the device challenge flow. Agent frames are `response`, `event`,
 *   `sessions`, and `ping`/`pong`.
 *
 * The relay never invents session semantics: it authenticates both sides,
 * enforces authenticated device ownership, bounds work, and forwards
 * frames. Authorization decisions for individual operations remain with the
 * local YCoding server that serves `packages/protocol`.
 *
 * Parsing here is deliberately hand-written and strict, mirroring the existing
 * `packages/cli/src/remote-transport.ts` precedent for this same wire.
 */

/** Envelope revision. Bump only with a coordinated relay/agent/client release. */
export const RemoteProtocolVersion = 4

/** Versioned WebSocket routes derived from the envelope revision. */
export const RemoteWebSocketPath = {
  client: `/ws/v${RemoteProtocolVersion}/client`,
  agent: `/ws/v${RemoteProtocolVersion}/agent`,
} as const

/** Operations the relay proxies. Every other operation is rejected. */
export const remoteOperations = [
  "workspace.list",
  "session.list",
  "session.active",
  "session.get",
  "session.messages",
  "session.capturedChanges.list",
  "session.compaction.list",
  "session.compact",
  "session.snapshot",
  "session.pending.list",
  "session.attachment.read",
  "session.message.stream",
  "session.todo.list",
  "session.subagent.list",
  "session.subagent.cancel",
  "session.subagent.answer",
  "session.team.economics",
  "session.team.shell.list",
  "session.team.shell.kill",
  "session.side-chat.list",
  "session.side-chat.create",
  "session.family.activity",
  "session.log",
  "session.subscribe",
  "session.unsubscribe",
  "session.prompt",
  "session.attachment.upload",
  "session.interrupt",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.shell.output",
  "session.autonomy.get",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
  "session.create",
  "session.status",
  "session.catalog",
  "workspace.catalog",
  "session.file.find",
  "workspace.file.find",
  "session.switchModel",
  "session.switchAgent",
  "session.command",
  "session.skill",
  "usage.providers",
  "usage.summary",
  "usage.report",
  "machine.keepAwake.get",
  "machine.keepAwake.set",
  "machine.latency.append",
  "machine.latency.list",
] as const

/** Operations that address one session and therefore require `sessionID`. */
export const remoteSessionOperations = [
  "session.get",
  "session.messages",
  "session.capturedChanges.list",
  "session.compaction.list",
  "session.compact",
  "session.snapshot",
  "session.pending.list",
  "session.attachment.read",
  "session.message.stream",
  "session.todo.list",
  "session.subagent.list",
  "session.subagent.cancel",
  "session.subagent.answer",
  "session.team.economics",
  "session.team.shell.list",
  "session.team.shell.kill",
  "session.side-chat.list",
  "session.side-chat.create",
  "session.family.activity",
  "session.log",
  "session.subscribe",
  "session.unsubscribe",
  "session.prompt",
  "session.attachment.upload",
  "session.interrupt",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.form.list",
  "session.form.reply",
  "session.form.cancel",
  "session.shell.output",
  "session.autonomy.get",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
  "session.catalog",
  "session.file.find",
  "session.switchModel",
  "session.switchAgent",
  "session.command",
  "session.skill",
] as const

export type RemoteOperation = (typeof remoteOperations)[number]

export type RemoteLatencySample =
  | { readonly kind: "request"; readonly at: string; readonly operation: Exclude<RemoteOperation, "machine.latency.append" | "machine.latency.list">; readonly outcome: "ok" | "failed" | "unknown" | "unavailable";
    readonly reason?: "not-connected" | "in-flight-limit" | "request-limit" | "cancelled"; readonly queueMs: number; readonly settlementMs?: number; readonly totalMs: number }
  | { readonly kind: "long-task"; readonly at: string; readonly durationMs: number }

export type RemoteCapturedChangesPage = {
  readonly data: readonly {
    readonly placementMessageID: string
    readonly path: string
    readonly additions: number
    readonly deletions: number
    readonly status: "created" | "deleted" | "modified"
    readonly files: readonly { readonly diff: string; readonly path: string; readonly additions: number; readonly deletions: number; readonly status: "created" | "deleted" | "modified"; readonly unavailable?: boolean }[]
  }[]
  readonly cursor?: { readonly next?: string }
}

export type RemoteCompactionHistory = {
  readonly data: readonly {
    readonly jobID: string
    readonly trigger: string
    readonly status: "pending" | "running" | "completed" | "failed"
    readonly metrics?: { readonly excludedMessages: number; readonly excludedParts: number; readonly inputTokens: number; readonly retainedTokens: number }
    readonly created: number
    readonly code?: string
  }[]
  readonly truncated: boolean
  readonly completedBefore: number
  readonly completedCount: number
  readonly totalSavedTokens: number
}

export type RemoteFamilyActivity = {
  readonly sessionID: string
  readonly executing: boolean
  readonly activity?: {
    readonly kind: "tool" | "thinking" | "replying"
    readonly room: "research" | "qa" | "meeting" | "developer" | "hold"
    readonly text: string
  }
}

export type RemoteWorkspaceInfo = {
  readonly id: string
  readonly projectID: string
  readonly directory: string
  readonly workspaceID?: string
  readonly name?: string
}

/** Shared bounds. Both sides enforce the same numbers so neither can drift. */
export const RemoteLimits = {
  goalSetTimeoutMs: 5 * 60_000,
  compactionTimeoutMs: 5 * 60_000,
  maxClientMessageChars: 32_768,
  maxAttachmentChunkChars: 28_000,
  maxAttachmentChunks: 1_024,
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxConnectionAttachmentBytes: 40 * 1024 * 1024,
  maxAttachmentUploads: 64,
  maxPromptSkills: 200,
  attachmentTtlMs: 10 * 60_000,
  maxAgentMessageChars: 262_144,
  maxPendingRequestsPerClient: 32,
  maxSessionListPage: 200,
  maxCompletionBatch: 200,
  maxStatusSessions: 500,
  maxAlertTitleChars: 120,
  maxFamilyMembers: 16,
  maxCompactionHistory: 100,
  maxSubscriptionsPerClient: 64,
  maxNoticeBatch: 100,
  noticePageSize: 50,
  maxRequestIDChars: 64,
  maxSessionIDChars: 128,
  maxErrorCodeChars: 64,
  maxErrorMessageChars: 512,
  maxClientRequestsPerWindow: 120,
  maxLatencyBatch: 20,
  maxLatencyDurationMs: 600_000,
  maxLatencyPage: 200,
  clientRateWindowMs: 10_000,
  maxAgentMessagesPerWindow: 500,
  agentRateWindowMs: 10_000,
  /** Bounded chunk count per response; larger values are a policy violation. */
  maxChunksPerResponse: 64,
  /** Events one `events` frame may carry for a session. */
  maxEventBatch: 64,
  /** Consecutive out-of-policy agent frames tolerated before the agent is closed. */
  maxAgentViolations: 8,
  agentHeartbeatIntervalMs: 20_000,
  agentOfflineConfirmMs: 2 * 20_000,
  pushTestIntervalMs: 60_000,
} as const

export function isWellFormedBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  for (let index = 0; index < value.length - padding; index++) {
    const code = value.charCodeAt(index)
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) || code === 43 || code === 47)) return false
  }
  return true
}

/** WebSocket close codes the relay uses. */
export const RemoteCloseCode = {
  normal: 1000,
  unsupported: 1003,
  policyViolation: 1008,
  tooLarge: 1009,
  serviceRestart: 1012,
  unauthorized: 4401,
  forbidden: 4403,
  agentConflict: 4409,
} as const

export type RemoteErrorCode =
  | "invalid_message"
  | "message_too_large"
  | "unknown_operation"
  | "session_required"
  | "session_not_allowed"
  | "subagent_read_only"
  | "not_found"
  | "not_subscribed"
  | "rate_limited"
  | "agent_unavailable"
  | "outcome_unknown"
  | "forbidden"
  | "unauthorized"
  | "internal_error"

const remoteErrorCodes: readonly RemoteErrorCode[] = [
  "invalid_message",
  "message_too_large",
  "unknown_operation",
  "session_required",
  "session_not_allowed",
  "subagent_read_only",
  "not_found",
  "not_subscribed",
  "rate_limited",
  "agent_unavailable",
  "outcome_unknown",
  "forbidden",
  "unauthorized",
  "internal_error",
]

export type RemoteError = { readonly code: RemoteErrorCode; readonly message: string }

export type RemoteRequest = {
  readonly type: "request"
  readonly id: string
  readonly operation: RemoteOperation
  readonly sessionID?: string
  readonly input?: Readonly<Record<string, unknown>>
}

/**
 * A response too large for one frame is sent as ordered chunks of the JSON text
 * of its value. `value` is then a string slice; the client concatenates slices in
 * index order and parses once `last` arrives. Nothing is truncated or dropped.
 */
export type RemoteResponseChunk = { readonly index: number; readonly last: boolean }

export type RemoteSucceededResponse = {
  readonly type: "response"
  readonly id: string
  readonly ok: true
  readonly value: unknown
  readonly chunk?: RemoteResponseChunk
}
export type RemoteFailedResponse = { readonly type: "response"; readonly id: string; readonly ok: false; readonly error: RemoteError }
export type RemoteResponse = RemoteSucceededResponse | RemoteFailedResponse

export type RemoteEvent = { readonly type: "event"; readonly sessionID: string; readonly event: unknown }
/**
 * Ordered events for one session coalesced into one frame. The agent batches
 * per session so control frames and other sessions' streams interleave instead
 * of queueing behind a burst; the client applies a batch atomically.
 */
export type RemoteEventBatch = { readonly type: "events"; readonly sessionID: string; readonly events: readonly unknown[] }
/** Delivery preference for this client's event stream; `background` allows longer coalescing. */
export type RemotePriorityMode = "interactive" | "background"
export type RemotePriorityHint = { readonly type: "priority"; readonly mode: RemotePriorityMode }
export type RemotePriority = { readonly type: "priority"; readonly clientID: string; readonly mode: RemotePriorityMode }
/** Bounded invalidation: clients page the authoritative backend list after receipt. */
export type RemoteSessions = { readonly type: "sessions" }
export type RemoteAttentionNeed = "permission" | "question" | "review"
export type RemoteAttentionDetail = { readonly sessionID: string; readonly title?: string; readonly need?: RemoteAttentionNeed }
export type RemoteStatus = { readonly type: "status"; readonly running: readonly string[]; readonly attention: readonly string[]; readonly outstanding?: readonly string[]; readonly failed?: readonly string[];
  readonly details?: readonly RemoteAttentionDetail[] }
export type RemoteWorkCompletion = { readonly id: string; readonly seq: number; readonly created: number; readonly sessionID: string; readonly title?: string }
export type RemoteAlertDetail = { readonly title?: string; readonly need?: RemoteAttentionNeed | "failed" | "blocked"; readonly repeat?: true }
export type RemoteBlocked = { readonly type: "blocked"; readonly sessionID: string; readonly title?: string }
export type RemoteCompletions = { readonly type: "completions"; readonly data: readonly RemoteWorkCompletion[]; readonly more: boolean }
export type RemoteSubscriptions = {
  readonly type: "subscriptions"
  readonly clientID: string
  readonly sessionIDs: readonly string[]
}
export type RemoteHeartbeat = { readonly type: "ping" } | { readonly type: "pong" }
export type RemoteCancel = { readonly type: "cancel"; readonly id: string }

export const remoteNoticeOperations = ["notice.subscribe", "notice.list", "notice.read", "notice.readAll"] as const
export type RemoteNoticeOperation = (typeof remoteNoticeOperations)[number]
export type RemoteNoticeCategory = "approval-requested" | "agent-completed"
export type RemoteNotice = {
  readonly id: string
  readonly category: RemoteNoticeCategory
  readonly sessionID: string
  readonly createdAt: number
}
export type RemoteNoticeRequest = {
  readonly type: "request"
  readonly id: string
  readonly operation: RemoteNoticeOperation
  readonly input?: { readonly ids: readonly string[] } | { readonly before: string }
}
export type RemoteNoticePage = {
  readonly notices: readonly RemoteNotice[]
  readonly next?: string
  readonly total: number
  readonly unavailable: boolean
}
export type RemoteNoticeFrame =
  | { readonly type: "notice.added"; readonly notices: readonly RemoteNotice[]; readonly total: number }
  | { readonly type: "notice.removed"; readonly ids: readonly string[]; readonly total: number }
  | { readonly type: "notice.cleared" }
  | { readonly type: "notice.unavailable" }
  | { readonly type: "notice.offline"; readonly at: number }
  | { readonly type: "notice.present"; readonly items: readonly RemoteNoticePresentation[] }

export type RemoteNoticePresentation = { readonly kind: "notice"; readonly notice: RemoteNotice; readonly detail?: RemoteAlertDetail } | { readonly kind: "offline"; readonly at: number }

/** Frames accepted from a browser connection. */
export type RemoteClientMessage = RemoteRequest | RemoteNoticeRequest | RemoteHeartbeat | RemoteCancel | RemotePriorityHint
/** Frames accepted from a local agent connection. */
export type RemoteAgentMessage = RemoteResponse | RemoteEvent | RemoteEventBatch | RemoteSessions | RemoteStatus | RemoteCompletions | RemoteBlocked | RemoteHeartbeat
/** Frames the relay sends to a browser connection. */
export type RemoteRelayToClient = RemoteResponse | RemoteEvent | RemoteEventBatch | RemoteSessions | RemoteStatus | RemoteHeartbeat | RemoteNoticeFrame
/** Frames the relay sends to a local agent connection. */
export type RemoteRelayToAgent = RemoteRequest | RemoteSubscriptions | RemoteHeartbeat | RemoteCancel | RemotePriority

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError; readonly id?: string }

export function remoteError(code: RemoteErrorCode, message: string): RemoteError {
  return { code, message }
}

export function requireSession(operation: RemoteOperation): boolean {
  return (remoteSessionOperations as readonly string[]).includes(operation)
}

/** Canonical string a device signs to redeem a one-use challenge. */
export function deviceSignaturePayload(challengeID: string, nonce: string): string {
  return `ycoding-device-v1\n${challengeID}\n${nonce}`
}

export function serializeRequest(request: RemoteRequest): string {
  return JSON.stringify(request)
}

export function serializeCancel(id: string): string {
  return JSON.stringify({ type: "cancel", id })
}

export function serializeResponse(response: RemoteResponse): string {
  return JSON.stringify(response)
}

export function serializeEvent(event: RemoteEvent): string {
  return JSON.stringify(event)
}

export function serializeSessions(sessions: RemoteSessions): string {
  return JSON.stringify(sessions)
}

export function serializeEvents(batch: RemoteEventBatch): string {
  return JSON.stringify({ type: "events", sessionID: batch.sessionID, events: [...batch.events] })
}

export function serializePriority(frame: RemotePriorityHint | RemotePriority): string {
  return "clientID" in frame
    ? JSON.stringify({ type: "priority", clientID: frame.clientID, mode: frame.mode })
    : JSON.stringify({ type: "priority", mode: frame.mode })
}

export function serializeStatus(status: RemoteStatus): string {
  return JSON.stringify(status)
}

export function serializeBlocked(frame: RemoteBlocked): string {
  return JSON.stringify({ type: frame.type, sessionID: frame.sessionID, ...(frame.title === undefined ? {} : { title: frame.title }) })
}

export function serializeCompletions(frame: RemoteCompletions): string {
  return JSON.stringify({
    type: frame.type,
    data: frame.data.map((item) => ({ id: item.id, seq: item.seq, created: item.created, sessionID: item.sessionID, ...(item.title === undefined ? {} : { title: item.title }) })),
    more: frame.more,
  })
}

export function serializeSubscriptions(subscriptions: RemoteSubscriptions): string {
  return JSON.stringify({ ...subscriptions, sessionIDs: [...subscriptions.sessionIDs] })
}

export function serializeNoticeFrame(frame: RemoteNoticeFrame): string {
  if (frame.type === "notice.removed") return JSON.stringify({ type: frame.type, ids: [...frame.ids], total: frame.total })
  if (frame.type === "notice.added") return JSON.stringify({ type: frame.type, notices: frame.notices.map(noticeWire), total: frame.total })
  if (frame.type === "notice.offline") return JSON.stringify({ type: frame.type, at: frame.at })
  if (frame.type === "notice.present")
    return JSON.stringify({ type: frame.type, items: frame.items.map((item) => item.kind === "notice"
      ? { kind: item.kind, notice: noticeWire(item.notice), ...(item.detail === undefined ? {} : { detail: alertDetailWire(item.detail) }) }
      : { kind: item.kind, at: item.at }) })
  return JSON.stringify({ type: frame.type })
}

export function noticePageValue(page: RemoteNoticePage) {
  return { notices: page.notices.map(noticeWire), ...(page.next === undefined ? {} : { next: page.next }), total: page.total, unavailable: page.unavailable }
}

export function noticeSequence(id: string): number | undefined {
  return noticeIDPattern.test(id) ? Number(id.slice(4)) : undefined
}

export function parseNoticePage(value: unknown): ParseResult<RemoteNoticePage> {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "notices" && key !== "next" && key !== "total" && key !== "unavailable")) return invalid()
  if (!Array.isArray(value.notices) || value.notices.length > RemoteLimits.noticePageSize || !isCount(value.total) || typeof value.unavailable !== "boolean") return invalid()
  const notices = parseNotices(value.notices)
  if (!notices.ok) return notices
  if (value.next !== undefined && (typeof value.next !== "string" || noticeSequence(value.next) === undefined)) return invalid()
  return { ok: true, value: { notices: notices.value, ...(value.next === undefined ? {} : { next: value.next }), total: value.total, unavailable: value.unavailable } }
}

export function serializeError(id: string, code: RemoteErrorCode, message: string): string {
  return JSON.stringify({ type: "response", id, ok: false, error: { code, message } })
}

export function parseClientMessage(raw: string): ParseResult<RemoteClientMessage> {
  if (raw.length > RemoteLimits.maxClientMessageChars)
    return fail("message_too_large", "Message exceeds the client frame bound")
  const frame = decodeJson(raw)
  if (!frame.ok) return frame
  return parseClientFrame(frame.value)
}

export function parseAgentMessage(raw: string): ParseResult<RemoteAgentMessage> {
  if (raw.length > RemoteLimits.maxAgentMessageChars)
    return fail("message_too_large", "Message exceeds the agent frame bound")
  const frame = decodeJson(raw)
  if (!frame.ok) return frame
  return parseAgentFrame(frame.value)
}

export function parseRelayToClientMessage(raw: string): ParseResult<RemoteRelayToClient> {
  if (raw.length > RemoteLimits.maxAgentMessageChars)
    return fail("message_too_large", "Message exceeds the agent frame bound")
  const frame = decodeJson(raw)
  if (!frame.ok) return frame
  if (isRecord(frame.value) && typeof frame.value.type === "string" && frame.value.type.startsWith("notice.")) return parseNoticeFrame(frame.value)
  const parsed = parseAgentFrame(frame.value)
  if (!parsed.ok) return parsed
  if (parsed.value.type === "completions" || parsed.value.type === "blocked") return invalid()
  return { ok: true, value: parsed.value }
}

export function isNoticeRequest(message: RemoteClientMessage): message is RemoteNoticeRequest {
  return message.type === "request" && (remoteNoticeOperations as readonly string[]).includes(message.operation)
}

/** Strict parser for the relay control surface received by the local agent. */
export function parseRelayToAgentMessage(raw: string): ParseResult<RemoteRelayToAgent> {
  if (raw.length > RemoteLimits.maxClientMessageChars)
    return fail("message_too_large", "Message exceeds the relay frame bound")
  const frame = decodeJson(raw)
  if (!frame.ok) return frame
  if (!isRecord(frame.value)) return invalid()
  if (frame.value.type === "ping" || frame.value.type === "pong")
    return withOnlyKeys(frame.value, ["type"], { type: frame.value.type })
  if (frame.value.type === "request") return parseRequest(frame.value)
  if (frame.value.type === "cancel") {
    const keys = withOnlyKeys(frame.value, ["type", "id"], frame.value)
    if (!keys.ok) return keys
    const id = requireID(frame.value.id)
    return id.ok ? { ok: true, value: { type: "cancel", id: id.value } } : id
  }
  if (frame.value.type === "subscriptions") return parseSubscriptions(frame.value)
  if (frame.value.type === "priority") {
    const keys = withOnlyKeys(frame.value, ["type", "clientID", "mode"], frame.value)
    if (!keys.ok) return keys
    if (!isClientID(frame.value.clientID) || !isPriorityMode(frame.value.mode)) return invalid()
    return { ok: true, value: { type: "priority", clientID: frame.value.clientID, mode: frame.value.mode } }
  }
  return invalid()
}

function parseClientFrame(frame: unknown): ParseResult<RemoteClientMessage> {
  if (!isRecord(frame)) return invalid()
  if (frame.type === "ping" || frame.type === "pong") return withOnlyKeys(frame, ["type"], { type: frame.type })
  if (frame.type === "cancel") {
    const keys = withOnlyKeys(frame, ["type", "id"], frame)
    if (!keys.ok) return keys
    const id = requireID(frame.id)
    return id.ok ? { ok: true, value: { type: "cancel", id: id.value } } : id
  }
  if (frame.type === "priority") {
    const keys = withOnlyKeys(frame, ["type", "mode"], frame)
    if (!keys.ok) return keys
    return isPriorityMode(frame.mode) ? { ok: true, value: { type: "priority", mode: frame.mode } } : invalid()
  }
  if (frame.type !== "request") return invalid()
  if (typeof frame.operation === "string" && (remoteNoticeOperations as readonly string[]).includes(frame.operation)) return parseNoticeRequest(frame)
  return parseRequest(frame)
}

function parseAgentFrame(frame: unknown): ParseResult<RemoteAgentMessage> {
  if (!isRecord(frame)) return invalid()
  if (frame.type === "ping" || frame.type === "pong") return withOnlyKeys(frame, ["type"], { type: frame.type })
  if (frame.type === "response") return parseResponse(frame)
  if (frame.type === "event") return parseEvent(frame)
  if (frame.type === "events") return parseEventBatch(frame)
  if (frame.type === "sessions") return parseSessions(frame)
  if (frame.type === "status") return parseStatus(frame)
  if (frame.type === "completions") return parseCompletions(frame)
  if (frame.type === "blocked") return parseBlocked(frame)
  return invalid()
}

function parseCompletions(frame: Record<string, unknown>): ParseResult<RemoteCompletions> {
  const keys = withOnlyKeys(frame, ["type", "data", "more"], frame.type)
  if (!keys.ok) return keys
  if (!Array.isArray(frame.data) || frame.data.length > RemoteLimits.maxCompletionBatch || typeof frame.more !== "boolean") return invalid()
  const data: RemoteWorkCompletion[] = []
  for (const item of frame.data) {
    if (!isRecord(item) || Object.keys(item).some((key) => !["id", "seq", "created", "sessionID", "title"].includes(key)) ||
      typeof item.id !== "string" || !/^evt_[A-Za-z0-9_-]+$/.test(item.id) || item.id.length > 128 ||
      typeof item.seq !== "number" || !Number.isSafeInteger(item.seq) || item.seq < 1 ||
      typeof item.created !== "number" || !Number.isSafeInteger(item.created) || item.created < 0 ||
      !isSessionID(item.sessionID) || item.sessionID.length > RemoteLimits.maxSessionIDChars ||
      (item.title !== undefined && !isAlertTitle(item.title))) return invalid()
    data.push({ id: item.id, seq: item.seq, created: item.created, sessionID: item.sessionID, ...(isAlertTitle(item.title) ? { title: item.title } : {}) })
  }
  if (new Set(data.map((item) => item.sessionID)).size !== data.length) return invalid()
  return { ok: true, value: { type: "completions", data, more: frame.more } }
}

function parseBlocked(frame: Record<string, unknown>): ParseResult<RemoteBlocked> {
  const keys = withOnlyKeys(frame, ["type", "sessionID", "title"], frame.type)
  if (!keys.ok) return keys
  const sessionID = frame.sessionID
  if (!isSessionID(sessionID) || sessionID.length > RemoteLimits.maxSessionIDChars || (frame.title !== undefined && !isAlertTitle(frame.title))) return invalid()
  return { ok: true, value: { type: "blocked", sessionID, ...(isAlertTitle(frame.title) ? { title: frame.title } : {}) } }
}

function parseRequest(frame: Record<string, unknown>): ParseResult<RemoteRequest> {
  const id = requireID(frame.id)
  if (!id.ok) return id
  const failRequest = (code: RemoteErrorCode, message: string): { readonly ok: false; readonly error: RemoteError; readonly id: string } =>
    ({ ok: false, error: { code, message }, id: id.value })
  const keys = withOnlyKeys(frame, ["type", "id", "operation", "sessionID", "input"], frame.type)
  if (!keys.ok) return keys
  if (typeof frame.operation !== "string" || !isOperation(frame.operation))
    return failRequest("unknown_operation", "Unknown operation")
  const operation = frame.operation
  if (frame.sessionID !== undefined && !isSessionID(frame.sessionID)) return invalid()
  if (requireSession(operation) && frame.sessionID === undefined)
    return failRequest("session_required", "Operation requires a session")
  if ((operation === "session.status" || operation === "workspace.catalog" || operation === "workspace.file.find" ||
    operation === "usage.providers" || operation === "usage.summary" || operation === "usage.report" ||
    operation === "machine.keepAwake.get" || operation === "machine.keepAwake.set" ||
    operation === "machine.latency.append" || operation === "machine.latency.list") && frame.sessionID !== undefined)
    return failRequest("invalid_message", "Global operation does not accept a session")
  if (frame.input !== undefined && !isRecord(frame.input)) return invalid()
  if (!validOperationInput(operation, frame.input)) return failRequest("invalid_message", "Input does not match the remote operation")
  if (operation === "session.family.activity" && isRecord(frame.input) && Array.isArray(frame.input.sessionIDs) && frame.input.sessionIDs.includes(frame.sessionID))
    return failRequest("invalid_message", "A family member cannot repeat the parent")
  return {
    ok: true,
    value:
      frame.input === undefined
        ? { type: "request", id: id.value, operation, ...(frame.sessionID === undefined ? {} : { sessionID: frame.sessionID }) }
        : {
            type: "request",
            id: id.value,
            operation,
            ...(frame.sessionID === undefined ? {} : { sessionID: frame.sessionID }),
            input: frame.input,
          },
  }
}

function validOperationInput(operation: RemoteOperation, input: unknown): boolean {
  if (operation === "machine.latency.append") return isRecord(input) && Object.keys(input).length === 1 &&
    Array.isArray(input.samples) && input.samples.length >= 1 && input.samples.length <= RemoteLimits.maxLatencyBatch &&
    input.samples.every(isRemoteLatencySample)
  if (operation === "machine.latency.list") return input === undefined || isRecord(input) &&
    Object.keys(input).every((key) => key === "limit" || key === "before") &&
    (input.limit === undefined || typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= RemoteLimits.maxLatencyPage) &&
    (input.before === undefined || typeof input.before === "string" && input.before.length > 0 && input.before.length <= 256)
  if (operation === "machine.keepAwake.get") return input === undefined
  if (operation === "machine.keepAwake.set") return isRecord(input) && typeof input.enabled === "boolean" && Object.keys(input).length === 1
  if (operation === "session.capturedChanges.list") return input === undefined || isRecord(input) && typeof input.cursor === "string" && input.cursor.length > 0 && input.cursor.length <= 256 && Object.keys(input).length === 1
  if (operation === "session.compaction.list") return input === undefined
  if (operation === "session.compact") return isRecord(input) && typeof input.id === "string" &&
    /^cmp_[A-Za-z0-9_-]+$/.test(input.id) && input.id.length <= 128 && Object.keys(input).length === 1
  if (operation === "session.snapshot") return input === undefined || (isRecord(input) &&
    typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 200 &&
    (input.before === undefined || (typeof input.before === "string" && input.before.length > 0 && input.before.length <= 256)) &&
    Object.keys(input).every((key) => key === "limit" || key === "before"))
  if (operation === "session.attachment.read") return isRecord(input) && typeof input.digest === "string" &&
    /^[0-9a-f]{64}$/.test(input.digest) && Object.keys(input).length === 1
  if (operation === "session.message.stream") return isRecord(input) && typeof input.messageID === "string" &&
    /^msg_[A-Za-z0-9_-]+$/.test(input.messageID) && input.messageID.length <= 128 && Object.keys(input).length === 1
  if (operation === "session.attachment.upload")
    return isRecord(input) && typeof input.uploadID === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.uploadID) &&
      typeof input.index === "number" && Number.isSafeInteger(input.index) && input.index >= 0 && input.index < RemoteLimits.maxAttachmentChunks && typeof input.last === "boolean" &&
      typeof input.data === "string" && input.data.length > 0 && input.data.length <= RemoteLimits.maxAttachmentChunkChars &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data) &&
      (input.last || !input.data.endsWith("=")) &&
      Object.keys(input).every((key) => key === "uploadID" || key === "index" || key === "last" || key === "data")
  if (operation === "usage.summary") return input === undefined
  if (operation === "usage.providers") return input === undefined || (isRecord(input) &&
    Object.keys(input).every((key) => key === "refresh") && (input.refresh === undefined || typeof input.refresh === "boolean"))
  if (operation === "usage.report") {
    if (!isRecord(input) || typeof input.group !== "string" || !["model", "hour", "day", "month", "session", "project", "agent"].includes(input.group) ||
      Object.keys(input).some((key) => !["group", "timeZone", "from", "to", "offset", "limit", "sort", "order"].includes(key))) return false
    const integer = (value: unknown, minimum: number, maximum: number) => value === undefined ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
    return integer(input.from, 0, Number.MAX_SAFE_INTEGER) && integer(input.to, 0, Number.MAX_SAFE_INTEGER) &&
      (input.timeZone === undefined || typeof input.timeZone === "string" && input.timeZone.length > 0 && input.timeZone.length <= 128) &&
      integer(input.offset, 0, Number.MAX_SAFE_INTEGER) && integer(input.limit, 1, 200) &&
      (input.from === undefined || input.to === undefined || (typeof input.from === "number" && typeof input.to === "number" && input.from < input.to)) &&
      (input.sort === undefined || (typeof input.sort === "string" && ["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"].includes(input.sort))) &&
      (input.order === undefined || input.order === "asc" || input.order === "desc")
  }
  if (operation === "workspace.list") return input === undefined || (isRecord(input) && input.sessionsOnly === true && Object.keys(input).length === 1)
  if (operation === "session.subagent.list") return input === undefined || (isRecord(input) && typeof input.cursor === "string" && input.cursor.length > 0 && input.cursor.length <= 1_024 && Object.keys(input).length === 1)
  if (operation === "session.subagent.cancel") return isRecord(input) && isSessionID(input.childID) && Object.keys(input).length === 1
  if (operation === "session.subagent.answer") return isRecord(input) && isSessionID(input.childID) && typeof input.questionID === "string" && /^qst_[A-Za-z0-9_-]+$/.test(input.questionID) && input.questionID.length <= 128 &&
    typeof input.text === "string" && input.text.trim().length > 0 && input.text.length <= 8_192 && Object.keys(input).every((key) => key === "childID" || key === "questionID" || key === "text")
  if (operation === "session.team.economics") return isRecord(input) && Object.keys(input).length === 1 && Array.isArray(input.sessionIDs) && input.sessionIDs.length > 0 && input.sessionIDs.length < RemoteLimits.maxFamilyMembers &&
    input.sessionIDs.every((id) => isSessionID(id) && id.length <= RemoteLimits.maxSessionIDChars) && new Set(input.sessionIDs).size === input.sessionIDs.length
  if (operation === "session.team.shell.list") return input === undefined
  if (operation === "session.team.shell.kill") return isRecord(input) && typeof input.shellID === "string" && /^sh_[A-Za-z0-9_-]+$/.test(input.shellID) && input.shellID.length <= 128 && Object.keys(input).length === 1
  if (operation === "session.side-chat.list") return input === undefined || isRecord(input) && typeof input.cursor === "string" && input.cursor.length > 0 && input.cursor.length <= 1_024 && Object.keys(input).length === 1
  if (operation === "session.side-chat.create") return isRecord(input) && isSessionID(input.id) && Object.keys(input).length === 1
  if (operation === "session.family.activity") return isRecord(input) && Object.keys(input).length === 1 && Array.isArray(input.sessionIDs) && input.sessionIDs.length < RemoteLimits.maxFamilyMembers &&
    input.sessionIDs.every((id) => isSessionID(id) && id.length <= RemoteLimits.maxSessionIDChars) && new Set(input.sessionIDs).size === input.sessionIDs.length
  if (operation === "session.status" || operation === "session.catalog" || operation === "session.todo.list") return input === undefined
  if (operation === "workspace.catalog") return isRecord(input) && validWorkspace(input.workspace) && Object.keys(input).length === 1
  if (operation === "session.file.find" || operation === "workspace.file.find")
    return isRecord(input) && (operation !== "workspace.file.find" || validWorkspace(input.workspace)) &&
      typeof input.query === "string" && input.query.length > 0 && input.query.length <= 200 &&
      (input.limit === undefined || (typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 50)) &&
      Object.keys(input).every((key) => key === "query" || key === "limit" || (operation === "workspace.file.find" && key === "workspace"))
  if (operation === "session.switchModel") return isRecord(input) && validModel(input.model) && Object.keys(input).length === 1
  if (operation === "session.switchAgent") return isRecord(input) && validName(input.agent) && Object.keys(input).length === 1
  if (operation === "session.skill") return isRecord(input) && validName(input.skill) &&
    (input.id === undefined || (typeof input.id === "string" && /^msg_[A-Za-z0-9_-]+$/.test(input.id) && input.id.length <= 128)) &&
    (input.resume === undefined || typeof input.resume === "boolean") &&
    Object.keys(input).every((key) => key === "skill" || key === "id" || key === "resume")
  if (operation === "session.prompt") return input === undefined || isRecord(input) &&
    Object.keys(input).every((key) => ["id", "text", "files", "agents", "delivery", "resume", "skills"].includes(key)) &&
    (input.skills === undefined || Array.isArray(input.skills) && input.skills.length <= RemoteLimits.maxPromptSkills &&
      input.skills.every((id: unknown) => validName(id) && typeof id === "string" && id.trim().length > 0))
  if (operation === "session.command") return isRecord(input) && typeof input.command === "string" && input.command.length > 0 &&
    Object.keys(input).every((key) => ["id", "command", "arguments", "files", "agents", "delivery"].includes(key))
  if (operation !== "session.create") return true
  if (
    !isRecord(input) ||
    !isSessionID(input.id) ||
    !validWorkspace(input.workspace) ||
    (input.agent !== undefined && !validName(input.agent)) ||
    (input.model !== undefined && !validModel(input.model))
  )
    return false
  return Object.keys(input).every((key) => key === "id" || key === "workspace" || key === "agent" || key === "model")
}

export function isRemoteLatencySample(value: unknown): value is RemoteLatencySample {
  if (!isRecord(value) || typeof value.at !== "string" || value.at.length !== 24 ||
    !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return false
  const duration = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= RemoteLimits.maxLatencyDurationMs
  if (value.kind === "long-task") return Object.keys(value).every((key) => key === "kind" || key === "at" || key === "durationMs") &&
    duration(value.durationMs) && typeof value.durationMs === "number" && value.durationMs >= 50
  if (value.kind !== "request" || typeof value.operation !== "string" || !isOperation(value.operation) ||
    value.operation === "machine.latency.append" || value.operation === "machine.latency.list" ||
    (typeof value.outcome !== "string" || !["ok", "failed", "unknown", "unavailable"].includes(value.outcome)) ||
    !duration(value.queueMs) || !duration(value.totalMs) ||
    (value.settlementMs !== undefined && !duration(value.settlementMs)) ||
    Object.keys(value).some((key) => !["kind", "at", "operation", "outcome", "reason", "queueMs", "settlementMs", "totalMs"].includes(key))) return false
  if (value.outcome === "unavailable") {
    if (value.reason !== undefined && (typeof value.reason !== "string" || !["not-connected", "in-flight-limit", "request-limit", "cancelled"].includes(value.reason))) return false
  } else if (value.reason !== undefined) return false
  return typeof value.queueMs === "number" && typeof value.totalMs === "number" &&
    (value.settlementMs === undefined ? value.queueMs === value.totalMs :
      typeof value.settlementMs === "number" && value.queueMs + value.settlementMs === value.totalMs)
}

function validWorkspace(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function validName(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function validModel(value: unknown): boolean {
  return isRecord(value) && validName(value.providerID) && validName(value.id) &&
    (value.variant === undefined || validName(value.variant)) &&
    (value.profile === undefined || validName(value.profile)) &&
    Object.keys(value).every((key) => key === "providerID" || key === "id" || key === "variant" || key === "profile")
}

function parseResponse(frame: Record<string, unknown>): ParseResult<RemoteResponse> {
  const id = requireID(frame.id)
  if (!id.ok) return id
  if (frame.ok === true) {
    const keys = withOnlyKeys(frame, ["type", "id", "ok", "value", "chunk"], frame.type)
    if (!keys.ok) return keys
    if (!("value" in frame)) return invalid()
    const chunk = parseChunk(frame.chunk)
    if (!chunk.ok) return chunk
    return {
      ok: true,
      value:
        chunk.value === undefined
          ? { type: "response", id: id.value, ok: true, value: frame.value }
          : { type: "response", id: id.value, ok: true, value: frame.value, chunk: chunk.value },
    }
  }
  if (frame.ok !== false) return invalid()
  const keys = withOnlyKeys(frame, ["type", "id", "ok", "error"], frame.type)
  if (!keys.ok) return keys
  const error = parseError(frame.error)
  if (!error.ok) return error
  return { ok: true, value: { type: "response", id: id.value, ok: false, error: error.value } }
}

function parseChunk(value: unknown): ParseResult<RemoteResponseChunk | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isRecord(value)) return invalid()
  const keys = withOnlyKeys(value, ["index", "last"], value)
  if (!keys.ok) return keys
  const index = value.index
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= RemoteLimits.maxChunksPerResponse)
    return invalid()
  if (typeof value.last !== "boolean") return invalid()
  return { ok: true, value: { index, last: value.last } }
}

/** Reassembles chunked response slices. Rejects a truncated or malformed sequence. */
export function parseChunkedValue(parts: readonly string[]): ParseResult<unknown> {
  if (parts.length === 0) return invalid()
  try {
    return { ok: true, value: JSON.parse(parts.join("")) }
  } catch {
    return invalid()
  }
}

function parseEvent(frame: Record<string, unknown>): ParseResult<RemoteEvent> {
  const keys = withOnlyKeys(frame, ["type", "sessionID", "event"], frame.type)
  if (!keys.ok) return keys
  if (!isSessionID(frame.sessionID)) return invalid()
  if (!("event" in frame)) return invalid()
  return { ok: true, value: { type: "event", sessionID: frame.sessionID, event: frame.event } }
}

function parseEventBatch(frame: Record<string, unknown>): ParseResult<RemoteEventBatch> {
  const keys = withOnlyKeys(frame, ["type", "sessionID", "events"], frame.type)
  if (!keys.ok) return keys
  if (!isSessionID(frame.sessionID)) return invalid()
  if (!Array.isArray(frame.events) || frame.events.length === 0 || frame.events.length > RemoteLimits.maxEventBatch) return invalid()
  return { ok: true, value: { type: "events", sessionID: frame.sessionID, events: frame.events } }
}

function parseSessions(frame: Record<string, unknown>): ParseResult<RemoteSessions> {
  return withOnlyKeys(frame, ["type"], { type: "sessions" })
}

function parseStatus(frame: Record<string, unknown>): ParseResult<RemoteStatus> {
  const keys = withOnlyKeys(frame, ["type", "running", "attention", "outstanding", "failed", "details"], frame.type)
  if (!keys.ok) return keys
  if (!Array.isArray(frame.running) || !Array.isArray(frame.attention) ||
    frame.running.length > RemoteLimits.maxStatusSessions || frame.attention.length > RemoteLimits.maxStatusSessions ||
    !frame.running.every(isSessionID) || !frame.attention.every(isSessionID) ||
    new Set(frame.running).size !== frame.running.length || new Set(frame.attention).size !== frame.attention.length ||
    (frame.outstanding !== undefined && (!Array.isArray(frame.outstanding) || frame.outstanding.length > RemoteLimits.maxStatusSessions ||
      !frame.outstanding.every(isSessionID) || new Set(frame.outstanding).size !== frame.outstanding.length))) return invalid()
  const attention = frame.attention
  if (frame.failed !== undefined && (!Array.isArray(frame.failed) || frame.failed.length > RemoteLimits.maxStatusSessions ||
    !frame.failed.every(isSessionID) || new Set(frame.failed).size !== frame.failed.length ||
    !frame.failed.every((id) => attention.includes(id)))) return invalid()
  const details = frame.details === undefined ? undefined : parseAttentionDetails(frame.details, attention)
  if (details === null) return invalid()
  return { ok: true, value: { type: "status", running: frame.running, attention: frame.attention,
    ...(frame.outstanding === undefined ? {} : { outstanding: frame.outstanding }),
    ...(frame.failed === undefined ? {} : { failed: frame.failed }),
    ...(details === undefined ? {} : { details }) } }
}

function parseAttentionDetails(value: unknown, attention: readonly string[]): readonly RemoteAttentionDetail[] | null {
  if (!Array.isArray(value) || value.length > attention.length) return null
  const details: RemoteAttentionDetail[] = []
  for (const item of value) {
    if (!isRecord(item) || !withOnlyKeys(item, ["sessionID", "title", "need"], item).ok) return null
    const sessionID = item.sessionID
    const title = isAlertTitle(item.title) ? item.title : undefined
    const need = isAttentionNeed(item.need) ? item.need : undefined
    if (!isSessionID(sessionID) || !attention.includes(sessionID) || details.some((detail) => detail.sessionID === sessionID) ||
      (item.title !== undefined && title === undefined) || (item.need !== undefined && need === undefined)) return null
    details.push({ sessionID, ...(title === undefined ? {} : { title }), ...(need === undefined ? {} : { need }) })
  }
  return details
}

function parseAlertDetail(value: unknown): RemoteAlertDetail | undefined {
  if (!isRecord(value) || !withOnlyKeys(value, ["title", "need", "repeat"], value).ok) return undefined
  const title = isAlertTitle(value.title) ? value.title : undefined
  const need = value.need === "failed" || value.need === "blocked" || isAttentionNeed(value.need) ? value.need : undefined
  if ((value.title !== undefined && title === undefined) || (value.need !== undefined && need === undefined) || (value.repeat !== undefined && value.repeat !== true)) return undefined
  return alertDetailWire({ title, need, ...(value.repeat === true ? { repeat: true } : {}) })
}

function alertDetailWire(detail: RemoteAlertDetail): RemoteAlertDetail {
  return { ...(detail.title === undefined ? {} : { title: detail.title }), ...(detail.need === undefined ? {} : { need: detail.need }),
    ...(detail.repeat === true ? { repeat: true } : {}) }
}

function isAttentionNeed(value: unknown): value is RemoteAttentionNeed {
  return value === "permission" || value === "question" || value === "review"
}

export function isAlertTitle(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Array.from(value).length <= RemoteLimits.maxAlertTitleChars && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
}

export function alertTitle(value: string): string | undefined {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  const points = Array.from(clean)
  const bounded = points.length <= RemoteLimits.maxAlertTitleChars ? clean : `${points.slice(0, RemoteLimits.maxAlertTitleChars - 1).join("").trimEnd()}…`
  return bounded.length === 0 ? undefined : bounded
}

const noticeIDPattern = /^ntc_[1-9][0-9]{0,14}$/

function noticeWire(notice: RemoteNotice) {
  return { id: notice.id, category: notice.category, sessionID: notice.sessionID, createdAt: notice.createdAt }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parseNoticeRequest(frame: Record<string, unknown>): ParseResult<RemoteNoticeRequest> {
  const id = requireID(frame.id)
  if (!id.ok) return id
  const failRequest = { ok: false, error: { code: "invalid_message", message: "Input does not match the remote operation" }, id: id.value } as const
  const keys = withOnlyKeys(frame, ["type", "id", "operation", "input"], frame.type)
  if (!keys.ok) return keys
  const operation = frame.operation as RemoteNoticeOperation
  if (operation === "notice.subscribe" || operation === "notice.readAll")
    return frame.input === undefined ? { ok: true, value: { type: "request", id: id.value, operation } } : failRequest
  if (!isRecord(frame.input)) return failRequest
  if (operation === "notice.list") {
    if (Object.keys(frame.input).some((key) => key !== "before") || typeof frame.input.before !== "string" || noticeSequence(frame.input.before) === undefined) return failRequest
    return { ok: true, value: { type: "request", id: id.value, operation, input: { before: frame.input.before } } }
  }
  if (Object.keys(frame.input).some((key) => key !== "ids")) return failRequest
  const ids = parseNoticeIDs(frame.input.ids)
  return ids.ok ? { ok: true, value: { type: "request", id: id.value, operation, input: { ids: ids.value } } } : failRequest
}

function parseNoticeFrame(frame: Record<string, unknown>): ParseResult<RemoteNoticeFrame> {
  if (frame.type === "notice.cleared" || frame.type === "notice.unavailable") {
    const keys = withOnlyKeys(frame, ["type"], frame.type)
    return keys.ok ? { ok: true, value: { type: frame.type } } : keys
  }
  if (frame.type === "notice.offline") {
    const keys = withOnlyKeys(frame, ["type", "at"], frame.type)
    return keys.ok && isCount(frame.at) && frame.at > 0 ? { ok: true, value: { type: "notice.offline", at: frame.at } } : invalid()
  }
  if (frame.type === "notice.present") {
    const keys = withOnlyKeys(frame, ["type", "items"], frame.type)
    if (!keys.ok) return keys
    return parsePresentations(frame.items)
  }
  if (frame.type === "notice.removed") {
    const keys = withOnlyKeys(frame, ["type", "ids", "total"], frame.type)
    if (!keys.ok) return keys
    const ids = parseNoticeIDs(frame.ids)
    return ids.ok && isCount(frame.total) ? { ok: true, value: { type: "notice.removed", ids: ids.value, total: frame.total } } : invalid()
  }
  if (frame.type !== "notice.added") return invalid()
  const keys = withOnlyKeys(frame, ["type", "notices", "total"], frame.type)
  if (!keys.ok) return keys
  if (!Array.isArray(frame.notices) || frame.notices.length === 0 || frame.notices.length > RemoteLimits.maxNoticeBatch || !isCount(frame.total)) return invalid()
  const notices = parseNotices(frame.notices)
  return notices.ok ? { ok: true, value: { type: "notice.added", notices: notices.value, total: frame.total } } : notices
}

function parsePresentations(values: unknown): ParseResult<RemoteNoticeFrame> {
  if (!Array.isArray(values) || values.length === 0 || values.length > RemoteLimits.maxNoticeBatch) return invalid()
  const items: RemoteNoticePresentation[] = []
  for (const value of values) {
    if (!isRecord(value)) return invalid()
    if (value.kind === "offline") {
      const at = value.at
      if (!withOnlyKeys(value, ["kind", "at"], value).ok || !isCount(at) || at <= 0 || items.some((item) => item.kind === "offline" && item.at === at)) return invalid()
      items.push({ kind: "offline", at })
      continue
    }
    if (value.kind !== "notice" || !withOnlyKeys(value, ["kind", "notice", "detail"], value).ok) return invalid()
    const notice = parseNotice(value.notice)
    const detail = value.detail === undefined ? undefined : parseAlertDetail(value.detail)
    if (!notice.ok || (value.detail !== undefined && detail === undefined) ||
      items.some((item) => item.kind === "notice" && item.notice.id === notice.value.id)) return invalid()
    items.push({ kind: "notice", notice: notice.value, ...(detail === undefined ? {} : { detail }) })
  }
  return { ok: true, value: { type: "notice.present", items } }
}

function parseNotices(values: readonly unknown[]): ParseResult<readonly RemoteNotice[]> {
  const notices: RemoteNotice[] = []
  for (const value of values) {
    const notice = parseNotice(value)
    if (!notice.ok || notices.some((entry) => entry.id === notice.value.id)) return invalid()
    notices.push(notice.value)
  }
  return { ok: true, value: notices }
}

function parseNotice(value: unknown): ParseResult<RemoteNotice> {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "id" && key !== "category" && key !== "sessionID" && key !== "createdAt")) return invalid()
  if (typeof value.id !== "string" || noticeSequence(value.id) === undefined) return invalid()
  if ((value.category !== "approval-requested" && value.category !== "agent-completed") || !isSessionID(value.sessionID) || !isCount(value.createdAt)) return invalid()
  return { ok: true, value: { id: value.id, category: value.category, sessionID: value.sessionID, createdAt: value.createdAt } }
}

function parseNoticeIDs(value: unknown): ParseResult<readonly string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > RemoteLimits.maxNoticeBatch) return invalid()
  const ids: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string" || noticeSequence(entry) === undefined || ids.includes(entry)) return invalid()
    ids.push(entry)
  }
  return { ok: true, value: ids }
}

function parseSubscriptions(frame: Record<string, unknown>): ParseResult<RemoteSubscriptions> {
  const keys = withOnlyKeys(frame, ["type", "clientID", "sessionIDs"], frame.type)
  if (!keys.ok) return keys
  if (!isClientID(frame.clientID)) return invalid()
  if (!Array.isArray(frame.sessionIDs) || frame.sessionIDs.length > RemoteLimits.maxSubscriptionsPerClient) return invalid()
  const sessionIDs: string[] = []
  for (const value of frame.sessionIDs) {
    if (!isSessionID(value)) return invalid()
    if (!sessionIDs.includes(value)) sessionIDs.push(value)
  }
  return { ok: true, value: { type: "subscriptions", clientID: frame.clientID, sessionIDs } }
}

function isClientID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)
}

function isPriorityMode(value: unknown): value is RemotePriorityMode {
  return value === "interactive" || value === "background"
}

function parseError(value: unknown): ParseResult<RemoteError> {
  if (!isRecord(value)) return invalid()
  const keys = withOnlyKeys(value, ["code", "message"], value)
  if (!keys.ok) return keys
  const code = value.code
  if (typeof code !== "string" || code.length === 0 || code.length > RemoteLimits.maxErrorCodeChars) return invalid()
  if (!isErrorCode(code)) return invalid()
  if (typeof value.message !== "string") return invalid()
  if (value.message.length > RemoteLimits.maxErrorMessageChars) return invalid()
  return { ok: true, value: { code, message: value.message } }
}

function decodeJson(raw: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return fail("invalid_message", "Message is not valid JSON")
  }
}

function withOnlyKeys<Value>(
  frame: Record<string, unknown>,
  allowed: readonly string[],
  value: Value,
): ParseResult<Value> {
  if (Object.keys(frame).some((key) => !allowed.includes(key))) return invalid()
  return { ok: true, value }
}

function requireID(value: unknown): ParseResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > RemoteLimits.maxRequestIDChars) return invalid()
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid()
  return { ok: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOperation(value: string): value is RemoteOperation {
  return (remoteOperations as readonly string[]).includes(value)
}

/** Session IDs are `packages/schema` session identifiers; reject anything else before forwarding. */
export function isSessionID(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= RemoteLimits.maxSessionIDChars &&
    /^ses[A-Za-z0-9_-]+$/.test(value)
  )
}

const remoteErrorCodeSet: ReadonlySet<string> = new Set(remoteErrorCodes)

function isErrorCode(value: string): value is RemoteErrorCode {
  return remoteErrorCodeSet.has(value)
}

function invalid(): { readonly ok: false; readonly error: RemoteError } {
  return fail("invalid_message", "Message does not match the remote envelope")
}

function fail(code: RemoteErrorCode, message: string): { readonly ok: false; readonly error: RemoteError } {
  return { ok: false, error: { code, message } }
}

/* -------------------------------------------------------------------------- */
/* Device authentication HTTP contract                                        */
/* -------------------------------------------------------------------------- */

/** Enrollment codes are shown once, in `XXXX-XXXX-XXXX-XXXX-XXXX` groups. */
export const enrollmentCodePattern = /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/

export const enrollmentCodeChars = 20

/** A P-256 public key in JWK form. Private keys never leave the device. */
export type RemotePublicKey = {
  readonly kty: "EC"
  readonly crv: "P-256"
  readonly x: string
  readonly y: string
}

export type RemoteDeviceInfo = {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly lastSeenAt?: number
  readonly revokedAt?: number
  readonly status: "active" | "revoked"
  /** Current authenticated local-agent presence, read from the device relay. */
  readonly online: boolean
}

export type MeResponse = {
  readonly user: { readonly id: string }
  readonly session: { readonly expiresAt: number }
  readonly devices: readonly RemoteDeviceInfo[]
}

/** `GET /api/devices` body. */
export type DevicesResponse = { readonly devices: readonly RemoteDeviceInfo[] }

export type CreateEnrollmentResponse = {
  readonly enrollmentID: string
  readonly code: string
  readonly expiresAt: number
}

export type EnrollRequest = {
  readonly enrollmentID: string
  readonly code: string
  readonly name: string
  readonly publicKey: RemotePublicKey
}

export type EnrollResponse = { readonly deviceID: string }

export type ChallengeRequest = { readonly deviceID: string }

export type ChallengeResponse = {
  readonly challengeID: string
  readonly nonce: string
  readonly expiresAt: number
}

export type DeviceTokenRequest = {
  readonly deviceID: string
  readonly challengeID: string
  readonly signature: string
}

export type DeviceRefreshRequest = { readonly deviceID: string; readonly refreshToken: string }

export type DeviceTokenResponse = {
  readonly accessToken: string
  readonly accessExpiresAt: number
  readonly refreshToken: string
  readonly refreshExpiresAt: number
}

export type ApiErrorResponse = { readonly error: RemoteError }

export const pushCategories = ["agent-completed", "approval-requested", "machine-offline"] as const
export type PushCategory = (typeof pushCategories)[number]
export type PushCategories = { readonly [Category in PushCategory]: boolean }
export type PushKeys = { readonly p256dh: string; readonly auth: string }
export type PushRegistration = { readonly endpoint: string; readonly keys: PushKeys; readonly categories: PushCategories }
export type PushRenewal = { readonly endpoint: string; readonly keys: PushKeys; readonly replaces: string }
export type PushSubscriptionInput = PushRegistration | PushRenewal

export type PushEndpointInput = { readonly endpoint: string }

export type PushKeyResponse = { readonly publicKey: string }

export type PushTestOutcome = "accepted" | "rejected" | "expired" | "unreachable"
export type PushTestResponse = { readonly outcome: PushTestOutcome; readonly status?: number }

export type RemoteUsageTokens = { readonly input: number; readonly output: number; readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number } }
export type RemoteUsageProvider = { readonly providerID: string; readonly label: string; readonly profile?: string;
  readonly status: "available" | "stale" | "unsupported" | "unauthorized" | "error";
  readonly source: "provider_api" | "local_client_rpc" | "response_headers" | "provider_internal_api" | "local_session";
  readonly stability: "stable" | "client_contract" | "observed" | "best_effort"; readonly updatedAt: number;
  readonly windows: readonly { readonly id: string; readonly label: string; readonly unit: "percent" | "usd" | "requests" | "tokens" | "count";
    readonly used?: number; readonly limit?: number; readonly remaining?: number; readonly unlimited?: boolean;
    readonly resetAt?: number; readonly periodSeconds?: number }[]; readonly message?: string }
export type RemoteUsageProvidersValue = { readonly data: readonly RemoteUsageProvider[] }
export type RemoteUsageMetrics = { readonly logical: number; readonly physical: number; readonly helpers: number;
  readonly continued: number; readonly fallback: number; readonly tokens: RemoteUsageTokens;
  readonly cost?: number; readonly costProvenance?: "recorded" | "current_catalog"; readonly cacheReadReported?: boolean }
export type RemoteUsageSummaryValue = { readonly data: RemoteUsageMetrics & {
  readonly models?: readonly { readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
    readonly requests: number; readonly tokens: RemoteUsageTokens; readonly cacheReadReported?: boolean;
    readonly cost?: number; readonly costProvenance?: "recorded" | "current_catalog" }[];
  readonly latestInvalidation?: string; readonly latestNamespace?: string;
  readonly latestTiming?: { readonly promptEvalDurationNs?: number; readonly generationDurationNs?: number; readonly loadDurationNs?: number } } }
export type RemoteUsageGroup = "model" | "hour" | "day" | "month" | "session" | "project" | "agent"
export type RemoteUsageReportInput = { readonly group: RemoteUsageGroup; readonly timeZone?: string; readonly from?: number; readonly to?: number;
  readonly offset?: number; readonly limit?: number;
  readonly sort?: "key" | "tokens" | "cost" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite";
  readonly order?: "asc" | "desc" }
export type RemoteUsageReportValue = { readonly data: { readonly group: RemoteUsageGroup;
  readonly rows: readonly (RemoteUsageMetrics & { readonly key: string; readonly label: string })[];
  readonly total: RemoteUsageMetrics; readonly rowCount: number; readonly nextOffset?: number } }

export function parsePushSubscription(value: unknown): ParseResult<PushSubscriptionInput> {
  if (!isRecord(value) || !isRecord(value.keys)) return invalidBody()
  const renewal = "replaces" in value
  if (!withOnlyKeys(value, ["endpoint", "keys", renewal ? "replaces" : "categories"], value).ok ||
    !withOnlyKeys(value.keys, ["p256dh", "auth"], value.keys).ok) return invalidBody()
  if (!isPushEndpoint(value.endpoint) || !isPushKey(value.keys.p256dh, 65, 87, 4) || !isPushKey(value.keys.auth, 16, 22)) return invalidBody()
  const keys = { p256dh: value.keys.p256dh, auth: value.keys.auth }
  if (renewal) return isPushEndpoint(value.replaces) ? { ok: true, value: { endpoint: value.endpoint, keys, replaces: value.replaces } } : invalidBody()
  const categories = value.categories
  if (!isRecord(categories) || Object.keys(categories).length !== pushCategories.length ||
    !pushCategories.every((category) => typeof categories[category] === "boolean")) return invalidBody()
  return { ok: true, value: { endpoint: value.endpoint, keys, categories: {
    "agent-completed": categories["agent-completed"] === true,
    "approval-requested": categories["approval-requested"] === true,
    "machine-offline": categories["machine-offline"] === true,
  } } }
}

export function parsePushEndpoint(value: unknown): ParseResult<PushEndpointInput> {
  if (!isRecord(value) || !withOnlyKeys(value, ["endpoint"], value).ok || !isPushEndpoint(value.endpoint)) return invalidBody()
  return { ok: true, value: { endpoint: value.endpoint } }
}

export function parsePushTestResponse(value: unknown): ParseResult<PushTestResponse> {
  if (!isRecord(value) || !withOnlyKeys(value, ["outcome", "status"], value).ok) return invalid()
  if (value.outcome === "unreachable") return value.status === undefined ? { ok: true, value: { outcome: "unreachable" } } : invalid()
  if ((value.outcome !== "accepted" && value.outcome !== "rejected" && value.outcome !== "expired") ||
    typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return invalid()
  return { ok: true, value: { outcome: value.outcome, status: value.status } }
}

function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false
    return url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com" ||
      url.hostname === "web.push.apple.com" || url.hostname.endsWith(".push.apple.com") ||
      url.hostname.endsWith(".notify.windows.com")
  } catch {
    return false
  }
}

function isPushKey(value: unknown, bytes: number, chars: number, first?: number): value is string {
  if (typeof value !== "string" || value.length !== chars || !isBase64Url(value)) return false
  try {
    const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/"))
    return decoded.length === bytes && (first === undefined || decoded.charCodeAt(0) === first)
  } catch {
    return false
  }
}

export const deviceNameLimit = 100

export function parseEnrollRequest(value: unknown): ParseResult<EnrollRequest> {
  if (!isRecord(value)) return invalidBody()
  const keys = withOnlyKeys(value, ["enrollmentID", "code", "name", "publicKey"], value)
  if (!keys.ok) return keys
  const enrollmentID = requireToken(value.enrollmentID, 64)
  if (!enrollmentID.ok) return enrollmentID
  if (typeof value.code !== "string" || !enrollmentCodePattern.test(value.code)) return invalidBody()
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > deviceNameLimit)
    return invalidBody()
  const publicKey = parsePublicKey(value.publicKey)
  if (!publicKey.ok) return publicKey
  return { ok: true, value: { enrollmentID: enrollmentID.value, code: value.code, name: value.name.trim(), publicKey: publicKey.value } }
}

export function parseChallengeRequest(value: unknown): ParseResult<ChallengeRequest> {
  if (!isRecord(value)) return invalidBody()
  const keys = withOnlyKeys(value, ["deviceID"], value)
  if (!keys.ok) return keys
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  return { ok: true, value: { deviceID: deviceID.value } }
}

export function parseDeviceTokenRequest(value: unknown): ParseResult<DeviceTokenRequest> {
  if (!isRecord(value)) return invalidBody()
  const keys = withOnlyKeys(value, ["deviceID", "challengeID", "signature"], value)
  if (!keys.ok) return keys
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  const challengeID = requireToken(value.challengeID, 64)
  if (!challengeID.ok) return challengeID
  if (typeof value.signature !== "string" || !isBase64Url(value.signature) || value.signature.length > 512) return invalidBody()
  return { ok: true, value: { deviceID: deviceID.value, challengeID: challengeID.value, signature: value.signature } }
}

export function parseDeviceRefreshRequest(value: unknown): ParseResult<DeviceRefreshRequest> {
  if (!isRecord(value)) return invalidBody()
  const keys = withOnlyKeys(value, ["deviceID", "refreshToken"], value)
  if (!keys.ok) return keys
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  if (typeof value.refreshToken !== "string" || !isBase64Url(value.refreshToken) || value.refreshToken.length > 256)
    return invalidBody()
  return { ok: true, value: { deviceID: deviceID.value, refreshToken: value.refreshToken } }
}

export function parsePublicKey(value: unknown): ParseResult<RemotePublicKey> {
  if (!isRecord(value)) return invalidBody()
  const keys = withOnlyKeys(value, ["kty", "crv", "x", "y"], value)
  if (!keys.ok) return keys
  if (value.kty !== "EC" || value.crv !== "P-256") return invalidBody()
  if (typeof value.x !== "string" || typeof value.y !== "string") return invalidBody()
  if (!isP256Coordinate(value.x) || !isP256Coordinate(value.y)) return invalidBody()
  return { ok: true, value: { kty: "EC", crv: "P-256", x: value.x, y: value.y } }
}

/** P-256 coordinates are 32 bytes encoded as unpadded base64url. */
function isP256Coordinate(value: string): boolean {
  return value.length === 43 && isBase64Url(value)
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value)
}

function requireToken(value: unknown, maxChars: number): ParseResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return invalidBody()
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalidBody()
  return { ok: true, value }
}

function invalidBody(): { readonly ok: false; readonly error: RemoteError } {
  return fail("invalid_message", "Request body does not match the remote contract")
}

/** Extract a bearer token from an `Authorization` header value. */
export function parseBearerToken(value: string | null): string | undefined {
  if (value === null) return undefined
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(value)
  return match?.[1]
}
