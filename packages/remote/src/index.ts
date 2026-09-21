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
 * - Browser: `GET /ws/v2/client?device=<deviceID>` authenticated by the browser
 *   session cookie, then device selection. Client frames are `request` and `ping`
 *   (plus the `pong` heartbeat reply).
 * - Local agent: `GET /ws/v2/agent` authenticated by `Authorization: Bearer <access
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
export const RemoteProtocolVersion = 2

/** Versioned WebSocket routes derived from the envelope revision. */
export const RemoteWebSocketPath = {
  client: `/ws/v${RemoteProtocolVersion}/client`,
  agent: `/ws/v${RemoteProtocolVersion}/agent`,
} as const

/** Operations the relay proxies. Every other operation is rejected. */
export const remoteOperations = [
  "session.list",
  "session.active",
  "session.get",
  "session.messages",
  "session.snapshot",
  "session.log",
  "session.subscribe",
  "session.unsubscribe",
  "session.prompt",
  "session.interrupt",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.question.list",
  "session.question.reply",
  "session.fileChange.list",
  "session.shell.output",
  "session.autonomy.get",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
] as const

/** Operations that address one session and therefore require `sessionID`. */
export const remoteSessionOperations = [
  "session.get",
  "session.messages",
  "session.snapshot",
  "session.log",
  "session.subscribe",
  "session.unsubscribe",
  "session.prompt",
  "session.interrupt",
  "session.permission.list",
  "session.permission.reply",
  "session.guardrail.status",
  "session.guardrail.request.list",
  "session.guardrail.reply",
  "session.question.list",
  "session.question.reply",
  "session.fileChange.list",
  "session.shell.output",
  "session.autonomy.get",
  "session.autonomy.set",
  "session.goal.set",
  "session.goal.stop",
] as const

export type RemoteOperation = (typeof remoteOperations)[number]

/** Shared bounds. Both sides enforce the same numbers so neither can drift. */
export const RemoteLimits = {
  maxClientMessageChars: 32_768,
  maxAgentMessageChars: 262_144,
  maxPendingRequestsPerClient: 32,
  maxSessionListPage: 200,
  maxSubscriptionsPerClient: 64,
  maxRequestIDChars: 64,
  maxSessionIDChars: 128,
  maxErrorCodeChars: 64,
  maxErrorMessageChars: 512,
  maxClientRequestsPerWindow: 30,
  clientRateWindowMs: 10_000,
  maxAgentMessagesPerWindow: 500,
  agentRateWindowMs: 10_000,
  /** Bounded chunk count per response; larger values are a policy violation. */
  maxChunksPerResponse: 64,
  /** Consecutive out-of-policy agent frames tolerated before the agent is closed. */
  maxAgentViolations: 8,
} as const

/** WebSocket close codes the relay uses. */
export const RemoteCloseCode = {
  normal: 1000,
  unsupported: 1003,
  policyViolation: 1008,
  tooLarge: 1009,
  serviceRestart: 1012,
  unauthorized: 4401,
  forbidden: 4403,
} as const

export type RemoteErrorCode =
  | "invalid_message"
  | "message_too_large"
  | "unknown_operation"
  | "session_required"
  | "session_not_allowed"
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
/** Bounded invalidation: clients page the authoritative backend list after receipt. */
export type RemoteSessions = { readonly type: "sessions" }
export type RemoteSubscriptions = {
  readonly type: "subscriptions"
  readonly clientID: string
  readonly sessionIDs: readonly string[]
}
export type RemoteHeartbeat = { readonly type: "ping" } | { readonly type: "pong" }

/** Frames accepted from a browser connection. */
export type RemoteClientMessage = RemoteRequest | RemoteHeartbeat
/** Frames accepted from a local agent connection. */
export type RemoteAgentMessage = RemoteResponse | RemoteEvent | RemoteSessions | RemoteHeartbeat
/** Frames the relay sends to a browser connection. */
export type RemoteRelayToClient = RemoteResponse | RemoteEvent | RemoteSessions | RemoteHeartbeat
/** Frames the relay sends to a local agent connection. */
export type RemoteRelayToAgent = RemoteRequest | RemoteSubscriptions | RemoteHeartbeat

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

export function serializeResponse(response: RemoteResponse): string {
  return JSON.stringify(response)
}

export function serializeEvent(event: RemoteEvent): string {
  return JSON.stringify(event)
}

export function serializeSessions(sessions: RemoteSessions): string {
  return JSON.stringify(sessions)
}

export function serializeSubscriptions(subscriptions: RemoteSubscriptions): string {
  return JSON.stringify({ ...subscriptions, sessionIDs: [...subscriptions.sessionIDs] })
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
  if (frame.value.type === "subscriptions") return parseSubscriptions(frame.value)
  return invalid()
}

function parseClientFrame(frame: unknown): ParseResult<RemoteClientMessage> {
  if (!isRecord(frame)) return invalid()
  if (frame.type === "ping" || frame.type === "pong") return withOnlyKeys(frame, ["type"], { type: frame.type })
  if (frame.type !== "request") return invalid()
  return parseRequest(frame)
}

function parseAgentFrame(frame: unknown): ParseResult<RemoteAgentMessage> {
  if (!isRecord(frame)) return invalid()
  if (frame.type === "ping" || frame.type === "pong") return withOnlyKeys(frame, ["type"], { type: frame.type })
  if (frame.type === "response") return parseResponse(frame)
  if (frame.type === "event") return parseEvent(frame)
  if (frame.type === "sessions") return parseSessions(frame)
  return invalid()
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
  if (frame.input !== undefined && !isRecord(frame.input)) return invalid()
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

function parseSessions(frame: Record<string, unknown>): ParseResult<RemoteSessions> {
  return withOnlyKeys(frame, ["type"], { type: "sessions" })
}

function parseSubscriptions(frame: Record<string, unknown>): ParseResult<RemoteSubscriptions> {
  const keys = withOnlyKeys(frame, ["type", "clientID", "sessionIDs"], frame.type)
  if (!keys.ok) return keys
  if (typeof frame.clientID !== "string" || frame.clientID.length === 0 || frame.clientID.length > 64) return invalid()
  if (!/^[A-Za-z0-9_-]+$/.test(frame.clientID)) return invalid()
  if (!Array.isArray(frame.sessionIDs) || frame.sessionIDs.length > RemoteLimits.maxSubscriptionsPerClient) return invalid()
  const sessionIDs: string[] = []
  for (const value of frame.sessionIDs) {
    if (!isSessionID(value)) return invalid()
    if (!sessionIDs.includes(value)) sessionIDs.push(value)
  }
  return { ok: true, value: { type: "subscriptions", clientID: frame.clientID, sessionIDs } }
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
