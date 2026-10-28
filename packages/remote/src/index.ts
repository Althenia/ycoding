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
import { parseProviderAuthInput, providerAuthOperations } from "./provider-auth.ts"
export { parseProviderAuthInput, providerAuthOperations, isProviderAuthorizationURL, type ProviderAuthOperation, type ProviderAuthInput, type ProviderAuthTarget, type ProviderAuthInfo, type ProviderAuthAttempt, type ProviderAuthStatus, type ProviderAuthPrompt } from "./provider-auth.ts"

export const RemoteProtocolVersion = 4

/** Versioned WebSocket routes derived from the envelope revision. */
export const RemoteWebSocketPath = {
  client: `/ws/v${RemoteProtocolVersion}/client`,
  agent: `/ws/v${RemoteProtocolVersion}/agent`,
} as const

/** Operations the relay proxies. Every other operation is rejected. */
export const remoteOperations = [
  ...providerAuthOperations,
  "workspace.list",
  "session.list",
  "session.active",
  "session.get",
  "session.delete",
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
  "session.pin",
  "session.unpin",
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
  "session.prediction",
  "session.promptGenerate",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.review.list",
  "session.review.decide",
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
  "dots.get",
  "dots.set",
  "session.skill",
  "usage.providers",
  "usage.summary",
  "usage.report",
  "session.usageReport",
  "session.promptCosts",
  "session.taskCosts",
  "usage.forecast",
  "usage.dashboard",
  "incident.report",
  "incident.recent",
  "incident.guidance",
  "incident.guidance.clear",
  "coordination.settings",
  "coordination.list",
  "coordination.create",
  "coordination.get",
  "coordination.update",
  "coordination.delete",
  "machine.keepAwake.get",
  "machine.keepAwake.set",
  "machine.telemetry.consent.get",
  "machine.telemetry.consent.set",
  "machine.latency.append",
  "machine.latency.list",
] as const

/** Operations that address one session and therefore require `sessionID`. */
export const remoteSessionOperations = [
  "session.get",
  "session.delete",
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
  "session.pin",
  "session.unpin",
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
  "session.prediction",
  "session.promptGenerate",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.review.list",
  "session.review.decide",
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
  "session.usageReport",
  "session.promptCosts",
  "session.taskCosts",
] as const

export type RemoteOperation = (typeof remoteOperations)[number]

export type RemoteDotsStatus = {
  readonly access: { readonly enabled: boolean; readonly revision: number }
  readonly configuration: { readonly ready: boolean; readonly profile?: string; readonly message?: string }
  readonly connection: { readonly state: "unavailable" | "off" | "connecting" | "connected" | "error"; readonly hostname?: string; readonly message?: string }
}

export function readDotsStatus(value: unknown): RemoteDotsStatus | undefined {
  if (!isRecord(value) || !isRecord(value.access) || !isRecord(value.configuration) || !isRecord(value.connection)) return undefined
  const access = value.access
  const configuration = value.configuration
  const connection = value.connection
  if (typeof access.enabled !== "boolean" || typeof access.revision !== "number" || !Number.isSafeInteger(access.revision) || access.revision < 0 ||
    typeof configuration.ready !== "boolean" || !dotsDisplayValue(configuration.profile, 256) || !dotsDisplayValue(configuration.message, 500) ||
    !dotsDisplayValue(connection.hostname, 256) || !dotsDisplayValue(connection.message, 500)) return undefined
  const state = connection.state
  if (state !== "unavailable" && state !== "off" && state !== "connecting" && state !== "connected" && state !== "error") return undefined
  return {
    access: { enabled: access.enabled, revision: access.revision },
    configuration: { ready: configuration.ready, ...(configuration.profile === undefined ? {} : { profile: configuration.profile }), ...(configuration.message === undefined ? {} : { message: configuration.message }) },
    connection: { state, ...(connection.hostname === undefined ? {} : { hostname: connection.hostname }), ...(connection.message === undefined ? {} : { message: connection.message }) },
  }
}

function dotsDisplayValue(value: unknown, limit: number): value is string | undefined {
  return value === undefined || typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
}

export function remoteDotsPeerLabel(metadata: unknown): string | undefined {
  if (!isRecord(metadata) || !isRecord(metadata.dots)) return
  const peer = metadata.dots
  if (peer.origin !== "dots-peer" || ![peer.profile, peer.dotID, peer.threadID, peer.itemID].every((value) => typeof value === "string" && value.length > 0)) return
  if (peer.turnID !== undefined && (typeof peer.turnID !== "string" || peer.turnID.length === 0)) return
  return `Dot ${peer.dotID} · external peer · ${peer.threadID}`.replace(/[\u0000-\u001f\u007f]/g, "�")
}

/**
 * Ordering class of every relay-proxied operation. Reads never wait for another request's
 * admission. Mutations keep arrival order per Session, or per connection when sessionless.
 * Typed against RemoteOperation so a new operation fails typecheck until it is classified.
 */
export const remoteOperationAccess: Record<RemoteOperation, "read" | "mutation"> = {
  "provider.auth.list": "read",
  "provider.auth.key": "mutation",
  "provider.auth.begin": "mutation",
  "provider.auth.status": "mutation",
  "provider.auth.complete": "mutation",
  "provider.auth.cancel": "mutation",
  "workspace.list": "read",
  "session.list": "read",
  "session.active": "read",
  "session.get": "read",
  "session.delete": "mutation",
  "session.messages": "read",
  "session.capturedChanges.list": "read",
  "session.compaction.list": "read",
  "session.compact": "mutation",
  "session.snapshot": "read",
  "session.pending.list": "read",
  "session.attachment.read": "read",
  "session.message.stream": "read",
  "session.todo.list": "read",
  "session.subagent.list": "read",
  "session.pin": "mutation",
  "session.unpin": "mutation",
  "session.subagent.cancel": "mutation",
  "session.subagent.answer": "mutation",
  "session.team.economics": "read",
  "session.team.shell.list": "read",
  "session.team.shell.kill": "mutation",
  "session.side-chat.list": "read",
  "session.side-chat.create": "mutation",
  "session.family.activity": "read",
  "session.log": "read",
  "session.subscribe": "mutation",
  "session.unsubscribe": "mutation",
  "session.prompt": "mutation",
  "session.attachment.upload": "mutation",
  "session.interrupt": "mutation",
  "session.prediction": "mutation",
  "session.promptGenerate": "mutation",
  "session.permission.list": "read",
  "session.permission.reply": "mutation",
  "session.guardrail.status": "read",
  "session.guardrail.request.list": "read",
  "session.guardrail.reply": "mutation",
  "session.review.list": "read",
  "session.review.decide": "mutation",
  "session.form.list": "read",
  "session.form.reply": "mutation",
  "session.form.cancel": "mutation",
  "session.shell.output": "read",
  "session.autonomy.get": "read",
  "session.autonomy.set": "mutation",
  "session.goal.set": "mutation",
  "session.goal.stop": "mutation",
  "session.create": "mutation",
  "session.status": "read",
  "session.catalog": "read",
  "workspace.catalog": "read",
  "session.file.find": "read",
  "workspace.file.find": "read",
  "session.switchModel": "mutation",
  "session.switchAgent": "mutation",
  "session.command": "mutation",
  "dots.get": "read",
  "dots.set": "mutation",
  "session.skill": "mutation",
  "usage.providers": "read",
  "usage.summary": "read",
  "usage.report": "read",
  "session.usageReport": "read",
  "session.promptCosts": "read",
  "session.taskCosts": "read",
  "usage.forecast": "read",
  "usage.dashboard": "read",
  "incident.report": "read",
  "incident.recent": "read",
  "incident.guidance": "read",
  "incident.guidance.clear": "mutation",
  "coordination.settings": "read",
  "coordination.list": "read",
  "coordination.create": "mutation",
  "coordination.get": "read",
  "coordination.update": "mutation",
  "coordination.delete": "mutation",
  "machine.keepAwake.get": "read",
  "machine.keepAwake.set": "mutation",
  "machine.telemetry.consent.get": "read",
  "machine.telemetry.consent.set": "mutation",
  "machine.latency.append": "mutation",
  "machine.latency.list": "read",
}

export type RemoteLatencySample =
  | { readonly kind: "request"; readonly at: string; readonly operation: Exclude<RemoteOperation, "machine.latency.append" | "machine.latency.list" | "machine.telemetry.consent.get" | "machine.telemetry.consent.set">; readonly outcome: "ok" | "failed" | "unknown" | "unavailable";
    readonly reason?: "not-connected" | "in-flight-limit" | "request-limit" | "cancelled"; readonly queueMs: number; readonly settlementMs?: number; readonly totalMs: number }
  | { readonly kind: "long-task"; readonly at: string; readonly durationMs: number }
  | { readonly kind: "client"; readonly at: string; readonly surface: "web"; readonly metric: "prompt.admit" | "stream.delay" | "transcript.load"; readonly durationMs: number }

export type RemoteTelemetryConsent = { readonly enabled: boolean; readonly noticeVersion: 1; readonly decidedAt: number }
export type RemoteTelemetryConsentState = { readonly noticeVersion: 1; readonly consent?: RemoteTelemetryConsent }

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
  maxSessionTitleChars: 120,
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
  | "telemetry_disabled"
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
  "telemetry_disabled",
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
export type RemoteRecoveryChoice = "continue" | "stop"
export const remoteRecoveryChoices: readonly RemoteRecoveryChoice[] = ["continue", "stop"]
export type RemoteStoppedRecovery = { readonly itemID: string }
export function isRemoteReviewItemID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^rvw_[A-Za-z0-9_-]+$/.test(value)
}
export type RemoteAttentionDetail = { readonly sessionID: string; readonly title?: string; readonly need?: RemoteAttentionNeed; readonly coordinatorSessionIDs?: readonly string[] }
export type RemoteStatus = { readonly type: "status"; readonly running: readonly string[]; readonly attention: readonly string[]; readonly outstanding?: readonly string[]; readonly failed?: readonly string[]; readonly lost?: readonly string[];
  readonly details?: readonly RemoteAttentionDetail[] }
export type RemoteWorkCompletion = { readonly id: string; readonly seq: number; readonly created: number; readonly sessionID: string; readonly title?: string; readonly coordinatorSessionIDs?: readonly string[] }
export type RemoteAlertDetail = { readonly title?: string; readonly need?: RemoteAttentionNeed | "failed" | "blocked" | "lost"; readonly repeat?: true; readonly coordinatorSessionIDs?: readonly string[] }
export type RemoteBlocked = { readonly type: "blocked"; readonly sessionID: string; readonly title?: string; readonly coordinatorSessionIDs?: readonly string[] }
export type RemoteCompletions = { readonly type: "completions"; readonly data: readonly RemoteWorkCompletion[]; readonly more: boolean }
export type RemoteSubscriptions = {
  readonly type: "subscriptions"
  readonly clientID: string
  readonly sessionIDs: readonly string[]
}
export type RemoteHeartbeat = { readonly type: "ping" } | { readonly type: "pong" }
export type RemoteCancel = { readonly type: "cancel"; readonly id: string }

export type RemoteQuota = { readonly providerID: string; readonly windowID: string;
  readonly milestone: "almost-out" | "cutting-it-close" | "will-run-out"; readonly resetAt: number }
export type RemoteQuotaFrame = RemoteQuota & { readonly type: "quota" }
export type RemoteQuotaResult = RemoteQuota & { readonly type: "quota.result"; readonly status: "settled" | "pending" }
export type RemoteQuotaNotice = RemoteQuota & { readonly type: "notice.quota"; readonly at: number }

export function quotaKey(quota: RemoteQuota): string {
  return JSON.stringify([quota.providerID, quota.windowID, quota.milestone, Math.round(quota.resetAt / 60_000)])
}

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
  | RemoteQuotaNotice
  | { readonly type: "notice.added"; readonly notices: readonly RemoteNotice[]; readonly total: number }
  | { readonly type: "notice.removed"; readonly ids: readonly string[]; readonly total: number }
  | { readonly type: "notice.cleared" }
  | { readonly type: "notice.unavailable" }
  | { readonly type: "notice.offline"; readonly at: number }
  | { readonly type: "notice.present"; readonly items: readonly RemoteNoticePresentation[] }

export type RemoteNoticePresentation = { readonly kind: "notice"; readonly notice: RemoteNotice; readonly detail?: RemoteAlertDetail } | { readonly kind: "offline"; readonly at: number } | (RemoteQuota & { readonly kind: "quota" })

/** Frames accepted from a browser connection. */
export type RemoteClientMessage = RemoteRequest | RemoteNoticeRequest | RemoteHeartbeat | RemoteCancel | RemotePriorityHint
/** Frames accepted from a local agent connection. */
export type RemoteAgentMessage = RemoteResponse | RemoteEvent | RemoteEventBatch | RemoteSessions | RemoteStatus | RemoteCompletions | RemoteBlocked | RemoteHeartbeat | RemoteQuotaFrame
/** Frames the relay sends to a browser connection. */
export type RemoteRelayToClient = RemoteResponse | RemoteEvent | RemoteEventBatch | RemoteSessions | RemoteStatus | RemoteHeartbeat | RemoteNoticeFrame
/** Frames the relay sends to a local agent connection. */
export type RemoteRelayToAgent = RemoteRequest | RemoteSubscriptions | RemoteHeartbeat | RemoteCancel | RemotePriority | RemoteQuotaResult

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
  return JSON.stringify({ type: frame.type, sessionID: frame.sessionID, ...(frame.title === undefined ? {} : { title: frame.title }),
    ...(frame.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: [...frame.coordinatorSessionIDs] }) })
}

export function serializeCompletions(frame: RemoteCompletions): string {
  return JSON.stringify({
    type: frame.type,
    data: frame.data.map((item) => ({ id: item.id, seq: item.seq, created: item.created, sessionID: item.sessionID, ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: [...item.coordinatorSessionIDs] }) })),
    more: frame.more,
  })
}

export function serializeSubscriptions(subscriptions: RemoteSubscriptions): string {
  return JSON.stringify({ ...subscriptions, sessionIDs: [...subscriptions.sessionIDs] })
}

export function serializeNoticeFrame(frame: RemoteNoticeFrame): string {
  if (frame.type === "notice.quota") return JSON.stringify({ type: frame.type, ...quotaWire(frame), at: frame.at })
  if (frame.type === "notice.removed") return JSON.stringify({ type: frame.type, ids: [...frame.ids], total: frame.total })
  if (frame.type === "notice.added") return JSON.stringify({ type: frame.type, notices: frame.notices.map(noticeWire), total: frame.total })
  if (frame.type === "notice.offline") return JSON.stringify({ type: frame.type, at: frame.at })
  if (frame.type === "notice.present")
    return JSON.stringify({ type: frame.type, items: frame.items.map((item) => item.kind === "notice"
      ? { kind: item.kind, notice: noticeWire(item.notice), ...(item.detail === undefined ? {} : { detail: alertDetailWire(item.detail) }) }
      : item.kind === "quota" ? { kind: item.kind, ...quotaWire(item) } : { kind: item.kind, at: item.at }) })
  return JSON.stringify({ type: frame.type })
}

function quotaWire(quota: RemoteQuota) {
  return { providerID: quota.providerID, windowID: quota.windowID, milestone: quota.milestone, resetAt: quota.resetAt }
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
  if (parsed.value.type === "completions" || parsed.value.type === "blocked" || parsed.value.type === "quota") return invalid()
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
  if (frame.value.type === "quota.result") {
    const keys = withOnlyKeys(frame.value, ["type", ...quotaFields, "status"], frame.value)
    const quota = parseQuota(frame.value)
    return keys.ok && quota && (frame.value.status === "settled" || frame.value.status === "pending")
      ? { ok: true, value: { type: "quota.result", ...quota, status: frame.value.status } }
      : invalid()
  }
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
  if (frame.type === "quota") {
    const keys = withOnlyKeys(frame, ["type", ...quotaFields], frame)
    const quota = parseQuota(frame)
    return keys.ok && quota ? { ok: true, value: { type: "quota", ...quota } } : invalid()
  }
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

function parseCoordinatorSessionIDs(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64 || !value.every(isSessionID) || new Set(value).size !== value.length) return null
  return value
}

function parseCompletions(frame: Record<string, unknown>): ParseResult<RemoteCompletions> {
  const keys = withOnlyKeys(frame, ["type", "data", "more"], frame.type)
  if (!keys.ok) return keys
  if (!Array.isArray(frame.data) || frame.data.length > RemoteLimits.maxCompletionBatch || typeof frame.more !== "boolean") return invalid()
  const data: RemoteWorkCompletion[] = []
  for (const item of frame.data) {
    if (!isRecord(item) || Object.keys(item).some((key) => !["id", "seq", "created", "sessionID", "title", "coordinatorSessionIDs"].includes(key)) ||
      typeof item.id !== "string" || !/^evt_[A-Za-z0-9_-]+$/.test(item.id) || item.id.length > 128 ||
      typeof item.seq !== "number" || !Number.isSafeInteger(item.seq) || item.seq < 1 ||
      typeof item.created !== "number" || !Number.isSafeInteger(item.created) || item.created < 0 ||
      !isSessionID(item.sessionID) || item.sessionID.length > RemoteLimits.maxSessionIDChars ||
      (item.title !== undefined && !isAlertTitle(item.title))) return invalid()
    const coordinatorSessionIDs = parseCoordinatorSessionIDs(item.coordinatorSessionIDs)
    if (coordinatorSessionIDs === null) return invalid()
    data.push({ id: item.id, seq: item.seq, created: item.created, sessionID: item.sessionID, ...(isAlertTitle(item.title) ? { title: item.title } : {}),
      ...(coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs }) })
  }
  if (new Set(data.map((item) => item.sessionID)).size !== data.length) return invalid()
  return { ok: true, value: { type: "completions", data, more: frame.more } }
}

function parseBlocked(frame: Record<string, unknown>): ParseResult<RemoteBlocked> {
  const keys = withOnlyKeys(frame, ["type", "sessionID", "title", "coordinatorSessionIDs"], frame.type)
  if (!keys.ok) return keys
  const sessionID = frame.sessionID
  const coordinatorSessionIDs = parseCoordinatorSessionIDs(frame.coordinatorSessionIDs)
  if (!isSessionID(sessionID) || sessionID.length > RemoteLimits.maxSessionIDChars || (frame.title !== undefined && !isAlertTitle(frame.title)) || coordinatorSessionIDs === null) return invalid()
  return { ok: true, value: { type: "blocked", sessionID, ...(isAlertTitle(frame.title) ? { title: frame.title } : {}),
    ...(coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs }) } }
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
  if (operation === "usage.forecast" && (!isRecord(frame.input) ||
    (frame.input.localScope === "location") !== (frame.sessionID !== undefined)))
    return failRequest("invalid_message", "Forecast scope requires a backend-resolved Session Location or an unscoped backend")
  if ((operation.startsWith("provider.auth.") || operation.startsWith("coordination.") || operation === "dots.get" || operation === "dots.set" || operation === "session.status" || operation === "workspace.catalog" || operation === "workspace.file.find" ||
    operation === "usage.providers" || operation === "usage.summary" || operation === "usage.report" || operation === "usage.dashboard" ||
    operation === "incident.report" || operation === "incident.recent" ||
    operation === "machine.keepAwake.get" || operation === "machine.keepAwake.set" ||
    operation === "machine.telemetry.consent.get" || operation === "machine.telemetry.consent.set" ||
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

function validUsageReportInput(input: unknown): boolean {
  if (!isRecord(input) || typeof input.group !== "string" || !["model", "hour", "day", "month", "session", "project", "agent", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"].includes(input.group) ||
    Object.keys(input).some((key) => !["group", "timeZone", "from", "to", "offset", "limit", "sort", "order", "providerID", "profile", "modelID", "selectedEffort"].includes(key))) return false
  const integer = (value: unknown, minimum: number, maximum: number) => value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
  return integer(input.from, 0, Number.MAX_SAFE_INTEGER) && integer(input.to, 0, Number.MAX_SAFE_INTEGER) &&
    [input.providerID, input.profile, input.modelID, input.selectedEffort].every((value) => value === undefined || validName(value)) &&
    (input.timeZone === undefined || typeof input.timeZone === "string" && input.timeZone.length > 0 && input.timeZone.length <= 128) &&
    integer(input.offset, 0, Number.MAX_SAFE_INTEGER) && integer(input.limit, 1, 200) &&
    (input.from === undefined || input.to === undefined || (typeof input.from === "number" && typeof input.to === "number" && input.from < input.to)) &&
    (input.sort === undefined || (typeof input.sort === "string" && ["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"].includes(input.sort))) &&
    (input.order === undefined || input.order === "asc" || input.order === "desc")
}

function validOperationInput(operation: RemoteOperation, input: unknown): boolean {
  if (operation === "dots.get") return input === undefined
  if (operation === "dots.set") return isRecord(input) && Object.keys(input).length === 2 &&
    typeof input.enabled === "boolean" && typeof input.expectedRevision === "number" &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0
  if (operation === "session.delete") return input === undefined || isRecord(input) && Object.keys(input).length === 0
  if (operation.startsWith("coordination.")) return validCoordinationInput(operation, input)
  if (operation === "session.list") return input === undefined || isRecord(input) &&
    (input.status === undefined || input.status === "waiting" || input.status === "running" || input.status === "idle") &&
    (input.around === undefined && input.before === undefined || isSessionID(input.around) && input.order === "active" && input.cursor === undefined &&
      (input.limit === undefined || typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= RemoteLimits.maxSessionListPage) &&
      (input.before === undefined || typeof input.before === "number" && Number.isSafeInteger(input.before) && input.before >= 0 && input.before < (typeof input.limit === "number" ? input.limit : 50)))
  if (operation.startsWith("provider.auth.")) return parseProviderAuthInput(operation, input) !== undefined
  if (operation === "machine.latency.append") return isRecord(input) && Object.keys(input).length === 1 &&
    Array.isArray(input.samples) && input.samples.length >= 1 && input.samples.length <= RemoteLimits.maxLatencyBatch &&
    input.samples.every(isRemoteLatencySample)
  if (operation === "machine.latency.list") return input === undefined || isRecord(input) &&
    Object.keys(input).every((key) => key === "limit" || key === "before") &&
    (input.limit === undefined || typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= RemoteLimits.maxLatencyPage) &&
    (input.before === undefined || typeof input.before === "string" && input.before.length > 0 && input.before.length <= 256)
  if (operation === "machine.keepAwake.get") return input === undefined
  if (operation === "machine.keepAwake.set") return isRecord(input) && typeof input.enabled === "boolean" && Object.keys(input).length === 1
  if (operation === "machine.telemetry.consent.get") return input === undefined
  if (operation === "machine.telemetry.consent.set") return isRecord(input) && typeof input.enabled === "boolean" && input.noticeVersion === 1 && Object.keys(input).length === 2
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
  if (operation === "usage.forecast") return isRecord(input) && Object.keys(input).length === 1 &&
    (input.localScope === "backend" || input.localScope === "location")
  if (operation === "incident.report") {
    if (!isRecord(input) || (input.group !== "model" && input.group !== "agent") ||
      !Object.keys(input).every((key) => ["group", "from", "to", "offset", "limit"].includes(key))) return false
    const integer = (value: unknown, minimum: number, maximum: number) => value === undefined ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
    return integer(input.from, 0, Number.MAX_SAFE_INTEGER) && integer(input.to, 0, Number.MAX_SAFE_INTEGER) &&
      integer(input.offset, 0, Number.MAX_SAFE_INTEGER) && integer(input.limit, 1, 200) &&
      (typeof input.from !== "number" || typeof input.to !== "number" || input.from <= input.to)
  }
  if (operation === "incident.recent") return isRecord(input) && validName(input.provider) && validName(input.model) &&
    (input.agent === undefined || validName(input.agent)) &&
    (input.limit === undefined || (typeof input.limit === "number" && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50)) &&
    Object.keys(input).every((key) => key === "provider" || key === "model" || key === "agent" || key === "limit")
  if (operation === "incident.guidance" || operation === "incident.guidance.clear") return isRecord(input) &&
    validName(input.provider) && validName(input.model) && Object.keys(input).length === 2
  if (operation === "session.promptCosts" || operation === "session.taskCosts") {
    const key = operation === "session.promptCosts" ? "inputIDs" : "sessionIDs"
    if (!isRecord(input) || Object.keys(input).length !== 1 || !Array.isArray(input[key])) return false
    const ids = input[key]
    return ids.length >= 1 && ids.length <= 100 && new Set(ids).size === ids.length &&
      ids.every((id) => typeof id === "string" && id.length <= 128 &&
        (operation === "session.promptCosts" ? /^msg_[A-Za-z0-9_-]+$/.test(id) : isSessionID(id)))
  }
  if (operation === "usage.dashboard") return isRecord(input) &&
    Object.keys(input).every((key) => key === "daily" || key === "monthly" || key === "breakdown" || key === "refresh") &&
    (input.refresh === undefined || typeof input.refresh === "boolean") &&
    [input.daily, input.monthly, input.breakdown].every((report) => report === undefined || validUsageReportInput(report))
  if (operation === "usage.report" || operation === "session.usageReport") return validUsageReportInput(input)
  if (operation === "workspace.list") return input === undefined || (isRecord(input) && input.sessionsOnly === true && Object.keys(input).length === 1)
  if (operation === "session.subagent.list") return input === undefined || (isRecord(input) && typeof input.cursor === "string" && input.cursor.length > 0 && input.cursor.length <= 1_024 && Object.keys(input).length === 1)
  if (operation === "session.pin" || operation === "session.unpin") return input === undefined
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
  if (operation === "session.prediction") return isRecord(input) && predictionMemory(input.memory) &&
    (input.hint === undefined || (typeof input.hint === "string" && input.hint.length <= 2_000)) &&
    Object.keys(input).every((key) => key === "memory" || key === "hint")
  if (operation === "session.promptGenerate") return isRecord(input) && predictionMemory(input.memory) &&
    (input.mode === "start" || input.mode === "steer" || input.mode === "queue" || input.mode === "goal") &&
    typeof input.intent === "string" && input.intent.length <= 4_000 && input.intent.trim().length > 0 &&
    Object.keys(input).every((key) => key === "mode" || key === "intent" || key === "memory")
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
    (input.model !== undefined && !validModel(input.model)) ||
    (input.title !== undefined && !isSessionTitle(input.title))
  )
    return false
  return Object.keys(input).every((key) => key === "id" || key === "workspace" || key === "agent" || key === "model" || key === "title")
}

function coordinationKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function coordinationInt(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function coordinationText(value: unknown, maximum: number): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
}

function coordinationID(value: unknown, prefix: string): boolean {
  return typeof value === "string" && value.length > prefix.length && value.length <= 96 && value.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length))
}

function coordinationTexts(value: unknown, maxItems: number, maxChars: number): boolean {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => coordinationText(item, maxChars))
}

function validCoordinationDelegated(value: unknown): boolean {
  if (!isRecord(value) || !coordinationKeys(value, ["categories", "actions", "resources", "expiresAt"])) return false
  return Array.isArray(value.categories) && value.categories.length <= 3 &&
    value.categories.every((category) => category === "question" || category === "permission" || category === "review") &&
    (value.actions === undefined || coordinationTexts(value.actions, 32, 512)) &&
    (value.resources === undefined || coordinationTexts(value.resources, 32, 512)) &&
    (value.expiresAt === undefined || coordinationInt(value.expiresAt, 0, Number.MAX_SAFE_INTEGER))
}

function validCoordinationSettings(value: unknown): boolean {
  if (!isRecord(value) || !coordinationKeys(value, ["concurrency", "delegatedDecisions"])) return false
  return (value.concurrency === null || coordinationInt(value.concurrency, 1, Number.MAX_SAFE_INTEGER)) &&
    (value.delegatedDecisions === undefined || validCoordinationDelegated(value.delegatedDecisions))
}

function validMemberSessionIDs(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(isSessionID)
}

function validCoordinationInput(operation: RemoteOperation, input: unknown): boolean {
  if (operation === "coordination.settings" || operation === "coordination.list") return input === undefined
  if (!isRecord(input)) return false
  if (operation === "coordination.create")
    return coordinationKeys(input, ["name", "masterSessionID", "memberSessionIDs"]) && coordinationText(input.name, 120) &&
      isSessionID(input.masterSessionID) && validMemberSessionIDs(input.memberSessionIDs)
  if (!coordinationID(input.groupID, "cgrp_")) return false
  if (operation === "coordination.get" || operation === "coordination.delete")
    return coordinationKeys(input, ["groupID"])
  if (operation === "coordination.update")
    return coordinationKeys(input, ["groupID", "revision", "name", "masterSessionID", "memberSessionIDs", "settings"]) &&
      coordinationInt(input.revision, 0, Number.MAX_SAFE_INTEGER) &&
      (input.name === undefined || coordinationText(input.name, 120)) &&
      (input.masterSessionID === undefined || isSessionID(input.masterSessionID)) &&
      (input.memberSessionIDs === undefined || validMemberSessionIDs(input.memberSessionIDs)) &&
      (input.settings === undefined || validCoordinationSettings(input.settings))
  return false
}

export type RemoteCoordinationDelegatedDecisions = { readonly categories: readonly ("question" | "permission" | "review")[]; readonly actions?: readonly string[]; readonly resources?: readonly string[]; readonly expiresAt?: number }
export type RemoteCoordinationSettings = { readonly enabled: boolean; readonly categories: readonly ("question" | "permission" | "review")[]; readonly actions?: readonly string[]; readonly resources?: readonly string[]; readonly expiresAt?: number }
export type RemoteCoordinationGroupSettings = { readonly concurrency: number | null; readonly delegatedDecisions?: RemoteCoordinationDelegatedDecisions }
export type RemoteCoordinationMemberState = "idle" | "running" | "waiting" | "failed"
export type RemoteCoordinationPendingRequest = { readonly kind: "question" | "permission" | "review"; readonly requestID: string; readonly fingerprint: string; readonly summary: string }
export type RemoteCoordinationParticipant = { readonly sessionID: string; readonly title: string; readonly location: { readonly directory: string; readonly workspaceID?: string }; readonly state: RemoteCoordinationMemberState; readonly lastActivity: number; readonly pending: readonly RemoteCoordinationPendingRequest[]; readonly drivenBy?: { readonly sessionID: string; readonly title: string } }
export type RemoteCoordinationGroupSummary = { readonly id: string; readonly name: string; readonly revision: number; readonly active: boolean; readonly pausedReason?: "interrupted" | "restart"; readonly masterSessionID: string; readonly memberCount: number; readonly settings: RemoteCoordinationGroupSettings; readonly time: { readonly created: number; readonly updated: number } }
export type RemoteCoordinationGroup = Omit<RemoteCoordinationGroupSummary, "masterSessionID" | "memberCount"> & { readonly master: RemoteCoordinationParticipant; readonly members: readonly RemoteCoordinationParticipant[] }

export function isRemoteLatencySample(value: unknown): value is RemoteLatencySample {
  if (!isRecord(value) || typeof value.at !== "string" || value.at.length !== 24 ||
    !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at) return false
  const duration = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input <= RemoteLimits.maxLatencyDurationMs
  if (value.kind === "long-task") return Object.keys(value).every((key) => key === "kind" || key === "at" || key === "durationMs") &&
    duration(value.durationMs) && typeof value.durationMs === "number" && value.durationMs >= 50
  if (value.kind === "client") return Object.keys(value).every((key) => key === "kind" || key === "at" || key === "surface" || key === "metric" || key === "durationMs") &&
    value.surface === "web" && ["prompt.admit", "stream.delay", "transcript.load"].includes(value.metric as string) && duration(value.durationMs)
  if (value.kind !== "request" || typeof value.operation !== "string" || !isOperation(value.operation) ||
    value.operation === "machine.latency.append" || value.operation === "machine.latency.list" ||
    value.operation === "machine.telemetry.consent.get" || value.operation === "machine.telemetry.consent.set" ||
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

function predictionMemory(value: unknown) {
  return Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length &&
    value.every((item) => item === "repository" || item === "knowledge")
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
  const keys = withOnlyKeys(frame, ["type", "running", "attention", "outstanding", "failed", "lost", "details"], frame.type)
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
  if (frame.lost !== undefined && (!Array.isArray(frame.lost) || frame.lost.length > RemoteLimits.maxStatusSessions ||
    !frame.lost.every(isSessionID) || new Set(frame.lost).size !== frame.lost.length ||
    !frame.lost.every((id) => attention.includes(id) && !(Array.isArray(frame.failed) && frame.failed.includes(id))))) return invalid()
  const details = frame.details === undefined ? undefined : parseAttentionDetails(frame.details, attention)
  if (details === null) return invalid()
  return { ok: true, value: { type: "status", running: frame.running, attention: frame.attention,
    ...(frame.outstanding === undefined ? {} : { outstanding: frame.outstanding }),
    ...(frame.failed === undefined ? {} : { failed: frame.failed }),
    ...(frame.lost === undefined ? {} : { lost: frame.lost }),
    ...(details === undefined ? {} : { details }) } }
}

function parseAttentionDetails(value: unknown, attention: readonly string[]): readonly RemoteAttentionDetail[] | null {
  if (!Array.isArray(value) || value.length > attention.length) return null
  const details: RemoteAttentionDetail[] = []
  for (const item of value) {
    if (!isRecord(item) || !withOnlyKeys(item, ["sessionID", "title", "need", "coordinatorSessionIDs"], item).ok) return null
    const sessionID = item.sessionID
    const title = isAlertTitle(item.title) ? item.title : undefined
    const need = isAttentionNeed(item.need) ? item.need : undefined
    const coordinatorSessionIDs = parseCoordinatorSessionIDs(item.coordinatorSessionIDs)
    if (!isSessionID(sessionID) || !attention.includes(sessionID) || details.some((detail) => detail.sessionID === sessionID) ||
      (item.title !== undefined && title === undefined) || (item.need !== undefined && need === undefined) || coordinatorSessionIDs === null) return null
    details.push({ sessionID, ...(title === undefined ? {} : { title }), ...(need === undefined ? {} : { need }),
      ...(coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs }) })
  }
  return details
}

function parseAlertDetail(value: unknown): RemoteAlertDetail | undefined {
  if (!isRecord(value) || !withOnlyKeys(value, ["title", "need", "repeat", "coordinatorSessionIDs"], value).ok) return undefined
  const title = isAlertTitle(value.title) ? value.title : undefined
  const need = value.need === "failed" || value.need === "blocked" || value.need === "lost" || isAttentionNeed(value.need) ? value.need : undefined
  const coordinatorSessionIDs = parseCoordinatorSessionIDs(value.coordinatorSessionIDs)
  if ((value.title !== undefined && title === undefined) || (value.need !== undefined && need === undefined) || (value.repeat !== undefined && value.repeat !== true) || coordinatorSessionIDs === null) return undefined
  return alertDetailWire({ title, need, ...(value.repeat === true ? { repeat: true } : {}), ...(coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs }) })
}

function alertDetailWire(detail: RemoteAlertDetail): RemoteAlertDetail {
  return { ...(detail.title === undefined ? {} : { title: detail.title }), ...(detail.need === undefined ? {} : { need: detail.need }),
    ...(detail.repeat === true ? { repeat: true } : {}),
    ...(detail.coordinatorSessionIDs === undefined ? {} : { coordinatorSessionIDs: [...detail.coordinatorSessionIDs] }) }
}

function isAttentionNeed(value: unknown): value is RemoteAttentionNeed {
  return value === "permission" || value === "question" || value === "review"
}

export function isAlertTitle(value: unknown): value is string {
  return boundedTitle(value, RemoteLimits.maxAlertTitleChars)
}

export function isSessionTitle(value: unknown): value is string {
  return boundedTitle(value, RemoteLimits.maxSessionTitleChars)
}

function boundedTitle(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    Array.from(value).length <= maxChars && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
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

const quotaFields = ["providerID", "windowID", "milestone", "resetAt"] as const

function parseQuota(frame: Record<string, unknown>): RemoteQuota | undefined {
  if (!isAlertTitle(frame.providerID) || Array.from(frame.providerID).length > 64 ||
    !isAlertTitle(frame.windowID) || Array.from(frame.windowID).length > 64 ||
    !isCount(frame.resetAt) || frame.resetAt === 0 ||
    frame.milestone !== "almost-out" && frame.milestone !== "cutting-it-close" && frame.milestone !== "will-run-out") return undefined
  return { providerID: frame.providerID, windowID: frame.windowID, milestone: frame.milestone, resetAt: frame.resetAt }
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
  if (frame.type === "notice.quota") {
    const keys = withOnlyKeys(frame, ["type", ...quotaFields, "at"], frame)
    const quota = parseQuota(frame)
    return keys.ok && quota && isCount(frame.at) && frame.at > 0
      ? { ok: true, value: { type: "notice.quota", ...quota, at: frame.at } }
      : invalid()
  }
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
    if (value.kind === "quota") {
      const quota = parseQuota(value)
      if (!quota || !withOnlyKeys(value, ["kind", ...quotaFields], value).ok ||
        items.some((item) => item.kind === "quota" && quotaKey(item) === quotaKey(quota))) return invalid()
      items.push({ kind: "quota", ...quota })
      continue
    }
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
  readonly alias?: string | null
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

export const deviceAliasLimit = 48
export type DeviceAliasRequest = { readonly alias: string | null }
export type DeviceAliasResponse = { readonly deviceID: string; readonly alias: string | null }

export function parseDeviceAliasRequest(value: unknown): ParseResult<DeviceAliasRequest> {
  if (!isRecord(value) || !withOnlyKeys(value, ["alias"], value).ok) return invalidBody()
  if (value.alias === null) return { ok: true, value: { alias: null } }
  if (typeof value.alias !== "string" || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(value.alias)) return invalidBody()
  const alias = value.alias.trim()
  return alias.length > 0 && alias.length <= deviceAliasLimit ? { ok: true, value: { alias } } : invalidBody()
}

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

export const pushCategories = ["agent-completed", "approval-requested", "machine-offline", "quota-pace"] as const
export type PushCategory = (typeof pushCategories)[number]
export type PushCategories = { readonly [Category in PushCategory]: boolean }
export type PushKeys = { readonly p256dh: string; readonly auth: string }
export const coordinationPushCategories = ["question", "permission", "review", "failure", "completion"] as const
export type CoordinationPushCategory = (typeof coordinationPushCategories)[number]
export type CoordinationPushFilter = { readonly scope: "all" | "coordinators" | "selected"; readonly sessionIDs?: readonly string[]; readonly categories?: readonly CoordinationPushCategory[] }
export type PushRegistration = { readonly endpoint: string; readonly keys: PushKeys; readonly categories: PushCategories; readonly coordinationFilter?: CoordinationPushFilter }
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
  readonly source: "provider_api" | "local_client_rpc" | "response_headers" | "response_stream" | "provider_internal_api" | "local_session";
  readonly stability: "stable" | "client_contract" | "observed" | "best_effort"; readonly updatedAt: number;
  readonly windows: readonly { readonly id: string; readonly label: string; readonly group?: string; readonly unit: "percent" | "usd" | "requests" | "tokens" | "count";
    readonly used?: number; readonly limit?: number; readonly remaining?: number; readonly unlimited?: boolean;
    readonly resetAt?: number; readonly periodSeconds?: number }[]; readonly message?: string }
export type RemoteUsageProvidersValue = { readonly data: readonly RemoteUsageProvider[] }
export type RemoteUsageMetrics = { readonly logical: number; readonly physical: number; readonly helpers: number;
  readonly continued: number; readonly fallback: number; readonly tokens: RemoteUsageTokens;
  readonly cost?: number; readonly costProvenance?: "recorded" | "current_catalog"; readonly cacheReadReported?: boolean;
  readonly costCoverage?: RemoteUsageCostCoverage;
  readonly outcomes?: { readonly completed: number; readonly failed: number; readonly cancelled: number } }
export type RemoteUsageCostCoverage = { readonly pricedRequests: number; readonly unpricedRequests: number }
export type RemoteUsageSummaryValue = { readonly data: RemoteUsageMetrics & {
  readonly models?: readonly { readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string };
    readonly requests: number; readonly tokens: RemoteUsageTokens; readonly cacheReadReported?: boolean;
    readonly cost?: number; readonly costProvenance?: "recorded" | "current_catalog" }[];
  readonly latestInvalidation?: string; readonly latestNamespace?: string;
  readonly latestTiming?: { readonly promptEvalDurationNs?: number; readonly generationDurationNs?: number; readonly loadDurationNs?: number } } }
export type RemoteUsageGroup = "model" | "hour" | "day" | "month" | "session" | "project" | "agent" |
  "provider" | "provider-profile-model" | "provider-model" | "model-id" | "profile" | "prompt" | "task"
export type RemoteUsageReportInput = { readonly group: RemoteUsageGroup; readonly timeZone?: string; readonly from?: number; readonly to?: number;
  readonly providerID?: string; readonly profile?: string; readonly modelID?: string; readonly selectedEffort?: string;
  readonly offset?: number; readonly limit?: number;
  readonly sort?: "key" | "tokens" | "cost" | "steps" | "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite";
  readonly order?: "asc" | "desc" }
export type RemoteUsageAnchor = { readonly sessionID: string; readonly inputID: string }
export type RemoteUsageDimensions =
  | { readonly group: "provider"; readonly providerID: string }
  | { readonly group: "provider-profile-model"; readonly providerID: string; readonly profile?: string; readonly profileState: "recorded" | "provider-default"; readonly modelID: string }
  | { readonly group: "provider-model"; readonly providerID: string; readonly modelID: string }
  | { readonly group: "model-id"; readonly modelID: string }
  | { readonly group: "profile"; readonly providerID: string; readonly profile?: string; readonly profileState: "recorded" | "provider-default" }
  | { readonly group: "prompt"; readonly anchor?: RemoteUsageAnchor; readonly attribution: "complete" | "partial" | "unattributed" }
  | { readonly group: "task"; readonly sessionID?: string; readonly attribution: "complete" | "partial" | "unattributed" }
export type RemoteUsageSpeed = { readonly firstOutputP50Ms?: number; readonly firstOutputP95Ms?: number; readonly firstOutputP99Ms?: number;
      readonly totalP50Ms?: number; readonly totalP95Ms?: number; readonly totalP99Ms?: number; readonly outputTokensPerSecond?: number; readonly samples: number;
      readonly generationSamples: number; readonly generationP50TokensPerSecond?: number; readonly generationP90TokensPerSecond?: number;
      readonly generationP95TokensPerSecond?: number; readonly meanTokensPerSecond?: number;
      readonly providerTimedSamples: number; readonly observedSamples: number }
export type RemoteUsageReportValue = { readonly data: { readonly group: RemoteUsageGroup;
  readonly rows: readonly (RemoteUsageMetrics & { readonly key: string; readonly label: string;
    readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string; readonly profile?: string };
    readonly dimensions?: RemoteUsageDimensions;
    readonly concurrency?: number;
    readonly speed?: RemoteUsageSpeed })[];
  readonly total: RemoteUsageMetrics; readonly rowCount: number; readonly nextOffset?: number; readonly speed?: RemoteUsageSpeed } }

export type RemoteUsageCost = RemoteUsageCostCoverage & { readonly total?: number; readonly known?: number; readonly provenance?: "recorded" | "current_catalog" }
export type RemoteUsageBreakdown = { readonly requests: number; readonly tokens: RemoteUsageTokens; readonly cost: RemoteUsageCost }
export type RemoteUsageHelper = RemoteUsageBreakdown & { readonly source: "step" | "title" | "goal" | "compaction" | "decision" | "prediction" | "prompt" }
export type RemoteUsagePromptInput = { readonly inputIDs: readonly string[] }
export type RemoteUsageTaskInput = { readonly sessionIDs: readonly string[] }
export type RemoteUsagePromptCost = { readonly anchor: RemoteUsageAnchor; readonly status: "settled" | "so-far";
  readonly attribution: "complete" | "partial" | "unattributed"; readonly history: "retained" | "partial";
  readonly total: RemoteUsageBreakdown; readonly main: RemoteUsageBreakdown; readonly children: RemoteUsageBreakdown; readonly helpers: readonly RemoteUsageHelper[] }
export type RemoteUsagePromptCostsValue = { readonly data: { readonly units: readonly RemoteUsagePromptCost[]; readonly unattributed: RemoteUsageBreakdown; readonly history: "retained" | "partial" } }
export type RemoteUsageTaskCost = { readonly sessionID: string; readonly usageAnchor?: RemoteUsageAnchor; readonly status: "settled" | "so-far";
  readonly attribution: "complete" | "partial" | "unattributed"; readonly history: "retained" | "partial";
  readonly total: RemoteUsageBreakdown; readonly main: RemoteUsageBreakdown; readonly children: RemoteUsageBreakdown; readonly helpers: readonly RemoteUsageHelper[] }
export type RemoteUsageTaskCostsValue = { readonly data: { readonly tasks: readonly RemoteUsageTaskCost[]; readonly total: RemoteUsageBreakdown; readonly history: "retained" | "partial" } }
export type RemoteUsageForecastInput = { readonly localScope: "backend" | "location" }
export type RemoteQuotaPace = { readonly verdict: "ahead" | "cutting-it-close" | "will-run-out"; readonly projectedUsedAtReset: number; readonly exhaustionAt?: number }
export type RemoteUsageForecast = { readonly asOf: number; readonly localScope: "backend" | "location";
  readonly localRates?: readonly { readonly providerID: string; readonly profile?: string; readonly modelID?: string;
    readonly observedFrom: number; readonly observedTo: number; readonly tokensPerMinute: number; readonly tokensPerMinute5?: number;
    readonly tokensPerMinute60?: number; readonly estimatedUSDPerHour?: number; readonly coverage: RemoteUsageCostCoverage }[];
  readonly quotas?: readonly { readonly providerID: string; readonly profile?: string; readonly windowID: string;
    readonly unit: RemoteUsageProvider["windows"][number]["unit"]; readonly source: RemoteUsageProvider["source"]; readonly stability: RemoteUsageProvider["stability"];
    readonly updatedAt: number; readonly state: "estimated" | "insufficient" | "exhausted" | "unlimited";
    readonly method?: "quota-delta-ema" | "window-mean"; readonly evidence: "low" | "medium" | "insufficient";
    readonly reason?: string; readonly observedFrom?: number; readonly observedTo?: number; readonly ratePerHour?: number;
    readonly exhaustionAt?: number; readonly projectedUsedAtReset?: number; readonly pace?: RemoteQuotaPace }[] }
export type RemoteUsageForecastValue = { readonly data: RemoteUsageForecast }
export type RemoteUsageDashboardInput = { readonly daily?: RemoteUsageReportInput; readonly monthly?: RemoteUsageReportInput; readonly breakdown?: RemoteUsageReportInput; readonly refresh?: boolean }
export type RemoteUsageLiveModel = { readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string; readonly profile?: string };
  readonly active: number; readonly streaming: number; readonly outputTokensPerSecond?: number }
export type RemoteUsageLive = { readonly asOf: number; readonly active: number; readonly streaming: number; readonly outputTokensPerSecond?: number;
  readonly models: readonly RemoteUsageLiveModel[]; readonly history: readonly { readonly at: number; readonly active: number; readonly outputTokensPerSecond?: number }[] }
export type RemoteUsageDashboardQuota =
  | { readonly status: "preparing" }
  | { readonly status: "ready"; readonly providers: readonly RemoteUsageProvider[]; readonly forecast: RemoteUsageForecast }
  | { readonly status: "error"; readonly message: string }
export type RemoteUsageDashboard =
  | { readonly status: "preparing" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly asOf: number; readonly revision: string; readonly summary: RemoteUsageSummaryValue["data"]; readonly quota: RemoteUsageDashboardQuota; readonly live: RemoteUsageLive;
    readonly daily?: RemoteUsageReportValue["data"]; readonly monthly?: RemoteUsageReportValue["data"]; readonly breakdown?: RemoteUsageReportValue["data"] }
export type RemoteUsageDashboardValue = { readonly data: RemoteUsageDashboard }

export type RemoteIncidentKind = "fallback" | "guardrail-escalated" | "guardrail-rejected"
export type RemoteIncidentModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string; readonly profile?: string }
export type RemoteIncidentReportInput = { readonly group: "model" | "agent"; readonly from?: number; readonly to?: number; readonly offset?: number; readonly limit?: number }
export type RemoteIncidentReportRow = { readonly providerID: string; readonly modelID: string; readonly agent?: string;
  readonly fallbacks: number; readonly escalated: number; readonly rejected: number; readonly last: number }
export type RemoteIncidentReport = { readonly data: { readonly rows: readonly RemoteIncidentReportRow[]; readonly groups: number } }
export type RemoteIncidentRecentInput = { readonly provider: string; readonly model: string; readonly agent?: string; readonly limit?: number }
export type RemoteIncidentItem = { readonly id: string; readonly time: number; readonly kind: RemoteIncidentKind; readonly category: string;
  readonly ruleIDs: readonly string[]; readonly agent: string; readonly variant?: string; readonly profile?: string;
  readonly target?: RemoteIncidentModelRef; readonly decidedBy?: "decision-model" | "client" }
export type RemoteIncidentRecent = { readonly data: { readonly items: readonly RemoteIncidentItem[] } }
export type RemoteIncidentGuidanceInput = { readonly provider: string; readonly model: string }
export type RemoteIncidentGuidance = { readonly data: { readonly text?: string; readonly clearedAt?: number; readonly enabled: boolean } }

export function parseCoordinationPushFilter(value: unknown): CoordinationPushFilter | undefined {
  if (!isRecord(value) || !withOnlyKeys(value, ["scope", "sessionIDs", "categories"], value).ok) return undefined
  if (value.scope !== "all" && value.scope !== "coordinators" && value.scope !== "selected") return undefined
  if (value.sessionIDs !== undefined && (!Array.isArray(value.sessionIDs) || value.sessionIDs.length > 128 ||
    !value.sessionIDs.every(isSessionID) || new Set(value.sessionIDs).size !== value.sessionIDs.length)) return undefined
  if (value.categories !== undefined && (!Array.isArray(value.categories) || value.categories.length > coordinationPushCategories.length ||
    !value.categories.every((category) => (coordinationPushCategories as readonly string[]).includes(category as string)) ||
    new Set(value.categories).size !== value.categories.length)) return undefined
  return { scope: value.scope,
    ...(value.sessionIDs === undefined ? {} : { sessionIDs: [...value.sessionIDs] as string[] }),
    ...(value.categories === undefined ? {} : { categories: [...value.categories] as CoordinationPushCategory[] }) }
}

export type CoordinationPushEvent = { readonly category: string; readonly need?: string; readonly sessionID?: string; readonly coordinatorSessionIDs?: readonly string[] }

export function coordinationPushCategory(event: CoordinationPushEvent): CoordinationPushCategory | undefined {
  if (event.category === "agent-completed") return "completion"
  if (event.category !== "approval-requested") return undefined
  if (event.need === "question") return "question"
  if (event.need === "permission") return "permission"
  if (event.need === "review") return "review"
  if (event.need === "blocked") return "review"
  if (event.need === "failed" || event.need === "lost") return "failure"
  return undefined
}

export function coordinationPushAllows(filter: CoordinationPushFilter | undefined, event: CoordinationPushEvent): boolean {
  if (filter === undefined) return true
  if (event.sessionID === undefined) return true
  if (filter.categories !== undefined) {
    const category = coordinationPushCategory(event)
    if (category === undefined || !filter.categories.includes(category)) return false
  }
  if (filter.scope === "all") return true
  if (event.coordinatorSessionIDs?.includes(event.sessionID) !== true) return false
  if (filter.scope === "coordinators") return true
  return (filter.sessionIDs ?? []).includes(event.sessionID)
}

export function parsePushSubscription(value: unknown): ParseResult<PushSubscriptionInput> {
  if (!isRecord(value) || !isRecord(value.keys)) return invalidBody()
  const renewal = "replaces" in value
  if (!withOnlyKeys(value, renewal ? ["endpoint", "keys", "replaces"] : ["endpoint", "keys", "categories", "coordinationFilter"], value).ok ||
    !withOnlyKeys(value.keys, ["p256dh", "auth"], value.keys).ok) return invalidBody()
  if (!isPushEndpoint(value.endpoint) || !isPushKey(value.keys.p256dh, 65, 87, 4) || !isPushKey(value.keys.auth, 16, 22)) return invalidBody()
  const keys = { p256dh: value.keys.p256dh, auth: value.keys.auth }
  if (renewal) return isPushEndpoint(value.replaces) ? { ok: true, value: { endpoint: value.endpoint, keys, replaces: value.replaces } } : invalidBody()
  const categories = value.categories
  if (!isRecord(categories) || Object.keys(categories).length !== pushCategories.length ||
    !pushCategories.every((category) => typeof categories[category] === "boolean")) return invalidBody()
  const coordinationFilter = value.coordinationFilter === undefined ? undefined : parseCoordinationPushFilter(value.coordinationFilter)
  if (value.coordinationFilter !== undefined && coordinationFilter === undefined) return invalidBody()
  return { ok: true, value: { endpoint: value.endpoint, keys, categories: {
    "agent-completed": categories["agent-completed"] === true,
    "approval-requested": categories["approval-requested"] === true,
    "machine-offline": categories["machine-offline"] === true,
    "quota-pace": categories["quota-pace"] === true,
  }, ...(coordinationFilter === undefined ? {} : { coordinationFilter }) } }
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
export { RemoteAppPreview } from "./app-preview.ts"
export { previewOperation, previewRequestHeaders, maxPreviewLeases, maxPreviewOrigins, maxPreviewHeaderChars, maxRegistrationMs, leaseTagPattern, parsePreviewState, parsePreviewStateAck, parsePreviewAllocate, parsePreviewAllocateAck, parsePreviewLease, parsePreviewLeaseAck, parsePreviewRevoke, parsePreviewRequest, parsePreviewInput, parsePreviewResult, parsePreviewOrigins, sameOrigins, previewCookie, isPreviewOrigin, sha256Hex, type PreviewMethod, type PreviewState, type PreviewStateAck, type PreviewAllocate, type PreviewAllocateAck, type PreviewLease, type PreviewLeaseAck, type PreviewRevoke, type PreviewInput, type PreviewRequest, type PreviewResult } from "./preview.ts"
