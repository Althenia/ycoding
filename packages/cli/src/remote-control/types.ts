import { OpenAICodex } from "@ycoding-ai/core/plugin/provider/openai-codex"

// Every value in this module that the installed-host evidence does not pin
// exactly (wire field spellings, the websocket URL shape, the authorization
// scheme, device-kind vocabulary, message limits, and the missing-app-server
// recognition rule) is isolated here so a live correction is a one-file change.

export const baseURL = "https://chatgpt.com/backend-api/"
export const protocolVersion = "3"
export const maxMessageBytes = 1_073_741_824
export const maxSegmentCount = 10_486
export const chunkThresholdBytes = 102_400
export const maxChunkEnvelopeBytes = 153_600
export const pingIntervalMs = 30_000
export const pongTimeoutMs = 600_000
export const handshakeTimeoutMs = 10_000
export const streamCloseCode = 4000
/** Unproven literal for the enroll body's os field. */
export const enrollOs = process.platform === "darwin" ? "macos" : process.platform

const endpoint = (suffix: string) => `${baseURL}wham/remote/control/server/${suffix}`

export const enrollURL = () => endpoint("enroll")
export const refreshURL = () => endpoint("refresh")
export const pairURL = () => endpoint("pair")
export const pairStatusURL = () => endpoint("pair/status")
export const websocketURL = () => `${baseURL.replace(/^https:/, "wss:")}wham/remote/control`

export type Credential = {
  readonly access: string
  readonly accountID: string
  readonly key: string
  readonly profile: string
}

export type EnrollRequest = {
  readonly name: string
  readonly os: string
  readonly arch: string
  readonly app_server_version: string
  readonly installation_id: string
  readonly server_id?: string
}

export function buildEnrollRequest(input: {
  readonly name: string
  readonly installationID: string
  readonly serverID?: string
}): EnrollRequest {
  return {
    name: input.name,
    os: enrollOs,
    arch: process.arch,
    app_server_version: OpenAICodex.catalogClientVersion,
    installation_id: input.installationID,
    ...(input.serverID === undefined ? {} : { server_id: input.serverID }),
  }
}

export type EnrollResponse = {
  readonly serverID: string
  readonly environmentID: string
  readonly remoteControlToken: string
  readonly expiresAt?: string
}

function stringField(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = record[name]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/** expires_at representation is unproven; epoch-seconds number is inferred. */
function expiryField(record: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    const value = record[name]
    if (typeof value === "number" && Number.isFinite(value))
      return new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString()
    if (typeof value === "string" && value.length > 0) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && /^[0-9]+(\.[0-9]+)?$/.test(value.trim()))
        return new Date(numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric).toISOString()
      return value
    }
  }
  return undefined
}

export function decodeEnrollResponse(value: unknown): EnrollResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const serverID = stringField(record, "server_id", "serverId")
  const environmentID = stringField(record, "environment_id", "environmentId")
  const remoteControlToken = stringField(record, "remote_control_token", "remoteControlToken")
  if (!serverID || !environmentID || !remoteControlToken) return undefined
  const expiresAt = expiryField(record, "expires_at", "expiresAt")
  return {
    serverID,
    environmentID,
    remoteControlToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

export type PairingStartResponse = {
  readonly pairingCode?: string
  readonly manualPairingCode: string
  readonly serverID: string
  readonly environmentID: string
  readonly expiresAt?: string
}

export function decodePairingStartResponse(value: unknown): PairingStartResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const manualPairingCode = stringField(record, "manual_pairing_code", "manualPairingCode")
  const serverID = stringField(record, "server_id", "serverId")
  const environmentID = stringField(record, "environment_id", "environmentId")
  if (!manualPairingCode || !serverID || !environmentID) return undefined
  const pairingCode = stringField(record, "pairing_code", "pairingCode")
  const expiresAt = expiryField(record, "expires_at", "expiresAt")
  return {
    manualPairingCode,
    serverID,
    environmentID,
    ...(pairingCode === undefined ? {} : { pairingCode }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

export function authorizationHeader(token: string) {
  return `Bearer ${token}`
}

export function buildEnrollHeaders(input: { readonly credential: Credential; readonly installationID: string }) {
  return {
    authorization: authorizationHeader(input.credential.access),
    "chatgpt-account-id": input.credential.accountID,
    "x-codex-installation-id": input.installationID,
    "content-type": "application/json",
  }
}

export function buildConnectHeaders(input: {
  readonly serverID: string
  readonly serverName: string
  readonly token: string
  readonly installationID: string
  readonly deviceKind?: string
  readonly subscribeCursor?: string
}) {
  return {
    "x-codex-server-id": input.serverID,
    "x-codex-name": input.serverName,
    "x-codex-protocol-version": protocolVersion,
    authorization: authorizationHeader(input.token),
    "x-codex-installation-id": input.installationID,
    ...(input.deviceKind === undefined ? {} : { "x-codex-host-device-kind": input.deviceKind }),
    ...(input.subscribeCursor === undefined ? {} : { "x-codex-subscribe-cursor": input.subscribeCursor }),
  }
}

export function deviceKindFromMachineName(name: string | undefined) {
  if (name === undefined) return undefined
  return /mini/i.test(name) ? "mac_mini" : undefined
}

export function recognizedMissingAppServer(body: string | undefined) {
  if (body === undefined) return false
  try {
    const parsed: unknown = JSON.parse(body)
    const text = JSON.stringify(parsed).toLowerCase()
    return text.includes("app_server") || text.includes("server_not_found") || text.includes("environment_not_found")
  } catch {
    return false
  }
}

export type HttpPhase = "enroll" | "refresh" | "websocket"
export type HttpAction = "delete_reenroll" | "preserve_retry" | "refresh_reconnect"

export function nextActionForHttp(input: {
  readonly phase: HttpPhase
  readonly status: number
  readonly recognizedMissingAppServer?: boolean
}): HttpAction {
  if (input.phase === "websocket" && (input.status === 401 || input.status === 403)) return "refresh_reconnect"
  if (input.status === 404) {
    if (input.phase === "refresh" || input.recognizedMissingAppServer) return "delete_reenroll"
    return "preserve_retry"
  }
  return "preserve_retry"
}

export function reconnectDelay(input: {
  readonly attempt: number
  readonly retryAfterMs?: number
  readonly random?: () => number
}) {
  if (input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs))
    return Math.min(Math.max(Math.floor(input.retryAfterMs), 0), 120_000)
  const base = Math.min(1_000 * 2 ** Math.max(input.attempt, 0), 30_000)
  const jitter = Math.floor((input.random ?? Math.random)() * 250)
  return base >= 30_000 ? 30_000 : base + jitter
}

export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()) {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1_000
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(at - now, 0) : undefined
}

export function platformFamily() {
  if (process.platform === "win32") return "windows"
  return "unix"
}
