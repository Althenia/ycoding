export {
  RemoteProtocolVersion,
  RemoteWebSocketPath,
  RelayLimits,
  remoteDescriptors,
  relayDescriptors,
  remoteEventTypes,
  createRelayConnection,
  receiveBinary,
  frameReservation,
  handoffBinary,
} from "./binary"
export { isProviderAuthorizationURL } from "./provider-auth"
export { RemoteAppPreview } from "./app-preview"
export {
  McpLimits,
  mcpScope,
  mcpHeaderNames,
  mcpResource,
  isMcpIdentifier,
  encodeMcpRequest,
  decodeMcpResponse,
} from "./mcp"
export type { McpForward, McpHeaders, McpPrincipal, McpResponse } from "./mcp"
export { quotaKey, quotaFromWire, quotaToWire } from "./quota"
export type { RemoteQuota, RemoteQuotaMilestone } from "./quota"
export { takeAsset } from "./asset"
export { httpBulkQuery, readHttpBulk } from "./http"
export * from "./payloads"
export {
  createRemoteConnection,
  remotePayloadCodecs,
  encodeRemoteRequest,
  decodeRemoteResult,
  decodeRemoteEvent,
  encodeRemoteScope,
  decodeRemoteScope,
} from "./client"
export type { RemoteConnectionOptions, RemotePayload } from "./client"
export { Connection, ReservationBudget, FailureCategory, PeerRole, WireLimit } from "./binary"
export type { Decision, Options, EventMetadata, Prepared, Incoming } from "@ycoding-ai/protocol/v5/connection"
export {
  create,
  encodeStrict,
  decodeStrict,
  encodeLossless,
  decodeLossless,
  FrameSchema,
  ScopeSchema,
  LosslessStringSchema,
  ControlSchema,
  TypedPayloadSchema,
  ResultSchema,
  PublicEventSchema,
  SessionLogItemSchema,
  EventRecordSchema,
  EventBatchSchema,
  StreamEndSchema,
  BulkStartSchema,
  BulkPieceSchema,
  BulkEndSchema,
  LedgerClass,
  ContentKind,
  Streaming,
  MutationClass,
  Settlement,
  ScopeKind,
  PriorityMode,
  AttentionNeed,
  NoticeCategory,
} from "@ycoding-ai/protocol/v5"
export type {
  Frame,
  Scope,
  LosslessString,
  Control,
  TypedPayload,
  PublicEvent,
  SessionLogItem,
  EventRecord,
  EventBatch,
  BulkStart,
  BulkPiece,
  BulkEnd,
  AssetMetadataResult,
  OperationDescriptor,
  Notice,
  Presentation,
  Status,
  Completion,
} from "@ycoding-ai/protocol/v5"

export const RemoteLimits = {
  noticePageSize: 50,
  maxNoticeBatch: 100,
  agentOfflineConfirmMs: 40_000,
  pushTestIntervalMs: 60_000,
} as const

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

export const remoteErrorCodes = [
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
] as const
export type RemoteErrorCode = (typeof remoteErrorCodes)[number]
export type RemoteError = { readonly code: RemoteErrorCode; readonly message: string }
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteError }

export type RemoteNoticeCategory = "approval-requested" | "agent-completed"
export type RemoteNotice = {
  readonly id: string
  readonly category: RemoteNoticeCategory
  readonly sessionID: string
  readonly createdAt: number
}
export type RemoteAlertDetail = {
  readonly title?: string
  readonly need?: "permission" | "question" | "review" | "failed" | "blocked" | "lost"
  readonly repeat?: true
}
export type RemoteWorkCompletion = {
  readonly id: string
  readonly seq: number
  readonly created: number
  readonly sessionID: string
  readonly title?: string
}

export function isSessionID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^ses[A-Za-z0-9_-]+$/.test(value)
}

export function noticeSequence(id: string): number | undefined {
  if (!/^ntc_[1-9][0-9]*$/.test(id)) return undefined
  const sequence = Number(id.slice(4))
  return Number.isSafeInteger(sequence) ? sequence : undefined
}

export function deviceSignaturePayload(challengeID: string, nonce: string): string {
  return `ycoding-device-v1\n${challengeID}\n${nonce}`
}

export const enrollmentCodePattern = /^[A-Z0-9]{4}(-[A-Z0-9]{4}){4}$/
export const enrollmentCodeChars = 20
export const deviceNameLimit = 100
export type RemotePublicKey = { readonly kty: "EC"; readonly crv: "P-256"; readonly x: string; readonly y: string }
export type RemoteDeviceInfo = {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly lastSeenAt?: number
  readonly revokedAt?: number
  readonly status: "active" | "revoked"
  readonly online: boolean
}
export type MeResponse = {
  readonly user: { readonly id: string }
  readonly session: { readonly expiresAt: number }
  readonly devices: readonly RemoteDeviceInfo[]
}
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
export type ChallengeResponse = { readonly challengeID: string; readonly nonce: string; readonly expiresAt: number }
export type DeviceTokenRequest = { readonly deviceID: string; readonly challengeID: string; readonly signature: string }
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
export type PushRegistration = {
  readonly endpoint: string
  readonly keys: PushKeys
  readonly categories: PushCategories
}
export type PushRenewal = { readonly endpoint: string; readonly keys: PushKeys; readonly replaces: string }
export type PushSubscriptionInput = PushRegistration | PushRenewal
export type PushEndpointInput = { readonly endpoint: string }
export type PushKeyResponse = { readonly publicKey: string }
export type PushTestOutcome = "accepted" | "rejected" | "expired" | "unreachable"
export type PushTestResponse = { readonly outcome: PushTestOutcome; readonly status?: number }

export function parsePushSubscription(value: unknown): ParseResult<PushSubscriptionInput> {
  if (!isRecord(value) || !isRecord(value.keys)) return invalidBody()
  const renewal = "replaces" in value
  if (!only(value, ["endpoint", "keys", renewal ? "replaces" : "categories"]) || !only(value.keys, ["p256dh", "auth"]))
    return invalidBody()
  if (
    !isPushEndpoint(value.endpoint) ||
    !isPushKey(value.keys.p256dh, 65, 87, 4) ||
    !isPushKey(value.keys.auth, 16, 22)
  )
    return invalidBody()
  const keys = { p256dh: value.keys.p256dh, auth: value.keys.auth }
  if (renewal)
    return isPushEndpoint(value.replaces)
      ? { ok: true, value: { endpoint: value.endpoint, keys, replaces: value.replaces } }
      : invalidBody()
  const categories = value.categories
  if (
    !isRecord(categories) ||
    Object.keys(categories).length !== pushCategories.length ||
    !pushCategories.every((category) => typeof categories[category] === "boolean")
  )
    return invalidBody()
  return {
    ok: true,
    value: {
      endpoint: value.endpoint,
      keys,
      categories: {
        "agent-completed": categories["agent-completed"] === true,
        "approval-requested": categories["approval-requested"] === true,
        "machine-offline": categories["machine-offline"] === true,
        "quota-pace": categories["quota-pace"] === true,
      },
    },
  }
}

export function parsePushEndpoint(value: unknown): ParseResult<PushEndpointInput> {
  if (!isRecord(value) || !only(value, ["endpoint"]) || !isPushEndpoint(value.endpoint)) return invalidBody()
  return { ok: true, value: { endpoint: value.endpoint } }
}

export function parsePushTestResponse(value: unknown): ParseResult<PushTestResponse> {
  if (!isRecord(value) || !only(value, ["outcome", "status"])) return invalidBody()
  if (value.outcome === "unreachable")
    return value.status === undefined ? { ok: true, value: { outcome: "unreachable" } } : invalidBody()
  if (
    (value.outcome !== "accepted" && value.outcome !== "rejected" && value.outcome !== "expired") ||
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    value.status < 100 ||
    value.status > 599
  )
    return invalidBody()
  return { ok: true, value: { outcome: value.outcome, status: value.status } }
}

function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false
  return (
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname === "web.push.apple.com" ||
    url.hostname.endsWith(".push.apple.com") ||
    url.hostname.endsWith(".notify.windows.com")
  )
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

export function parseEnrollRequest(value: unknown): ParseResult<EnrollRequest> {
  if (!isRecord(value) || !only(value, ["enrollmentID", "code", "name", "publicKey"])) return invalidBody()
  const enrollmentID = requireToken(value.enrollmentID, 64)
  if (!enrollmentID.ok) return enrollmentID
  if (typeof value.code !== "string" || !enrollmentCodePattern.test(value.code)) return invalidBody()
  if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > deviceNameLimit)
    return invalidBody()
  const publicKey = parsePublicKey(value.publicKey)
  if (!publicKey.ok) return publicKey
  return {
    ok: true,
    value: { enrollmentID: enrollmentID.value, code: value.code, name: value.name.trim(), publicKey: publicKey.value },
  }
}

export function parseChallengeRequest(value: unknown): ParseResult<ChallengeRequest> {
  if (!isRecord(value) || !only(value, ["deviceID"])) return invalidBody()
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  return { ok: true, value: { deviceID: deviceID.value } }
}

export function parseDeviceTokenRequest(value: unknown): ParseResult<DeviceTokenRequest> {
  if (!isRecord(value) || !only(value, ["deviceID", "challengeID", "signature"])) return invalidBody()
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  const challengeID = requireToken(value.challengeID, 64)
  if (!challengeID.ok) return challengeID
  if (typeof value.signature !== "string" || !isBase64Url(value.signature) || value.signature.length > 512)
    return invalidBody()
  return { ok: true, value: { deviceID: deviceID.value, challengeID: challengeID.value, signature: value.signature } }
}

export function parseDeviceRefreshRequest(value: unknown): ParseResult<DeviceRefreshRequest> {
  if (!isRecord(value) || !only(value, ["deviceID", "refreshToken"])) return invalidBody()
  const deviceID = requireToken(value.deviceID, 64)
  if (!deviceID.ok) return deviceID
  if (typeof value.refreshToken !== "string" || !isBase64Url(value.refreshToken) || value.refreshToken.length > 256)
    return invalidBody()
  return { ok: true, value: { deviceID: deviceID.value, refreshToken: value.refreshToken } }
}

export function parsePublicKey(value: unknown): ParseResult<RemotePublicKey> {
  if (!isRecord(value) || !only(value, ["kty", "crv", "x", "y"])) return invalidBody()
  if (value.kty !== "EC" || value.crv !== "P-256") return invalidBody()
  if (
    typeof value.x !== "string" ||
    typeof value.y !== "string" ||
    value.x.length !== 43 ||
    value.y.length !== 43 ||
    !isBase64Url(value.x) ||
    !isBase64Url(value.y)
  )
    return invalidBody()
  return { ok: true, value: { kty: "EC", crv: "P-256", x: value.x, y: value.y } }
}

export function parseBearerToken(value: string | null): string | undefined {
  return value === null ? undefined : /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(value)?.[1]
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value)
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}
function requireToken(value: unknown, maxChars: number): ParseResult<string> {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && /^[A-Za-z0-9_-]+$/.test(value)
    ? { ok: true, value }
    : invalidBody()
}
function invalidBody(): { readonly ok: false; readonly error: RemoteError } {
  return { ok: false, error: { code: "invalid_message", message: "Request body does not match the remote contract" } }
}
