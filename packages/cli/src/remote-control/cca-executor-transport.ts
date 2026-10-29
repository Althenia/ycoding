import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import os from "node:os"
import { WebSocket } from "ws"
import {
  CcaRelayCarrier,
  HARNESS_KEY_VALIDATION_TIMEOUT_MS,
  type CcaChannel,
  type CcaNoiseAcceptHandshakeInput,
  type CcaNoiseIdentity,
  type CcaNoisePublicKey,
  type CcaNoiseTransport,
  type WebSocketLike,
} from "./cca-relay"

export type {
  CcaChannel,
  CcaNoiseAcceptHandshakeInput,
  CcaNoiseIdentity,
  CcaNoisePublicKey,
  CcaNoiseTransport,
  WebSocketLike,
}

export const defaultRegistryBaseURL = "https://codex-cloud-environments.chatgpt.com/api"
export const defaultWsMaxPayload = 256 * 1024
export const ccaCompatibleExecServerVersion = "0.165.0-alpha.1.2"
export const ccaExecServerProviderId = "sha256:6c00ea8010dd56f75443a655293fd43e86b65f038786b1a257324d4a6028d4cf"
export const ccaExecServerPrependPathDir = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path"
export const ccaExecServerOriginator = "codex_cli_rs"
export const ccaRegistryRequestTimeoutMs = 10_000
export const ccaKeepaliveIntervalMs = 30_000
export const ccaPongTimeoutMs = 60_000
export const ccaWriteTimeoutMs = 60_000
const NOISE_RELAY_SECURITY_PROFILE = "noise_hybrid_ik_v1"

export type CcaExecutorCredential = {
  readonly accessToken: string
  readonly accountID: string
}

export type CcaRegistrationResult = {
  readonly environmentID: string
  readonly executorRegistrationID: string
  readonly url: string
  readonly securityProfile: string
}

export type CcaCredentialRefresh = (rejected: CcaExecutorCredential) => Promise<CcaExecutorCredential | undefined>

type RegistryRequestInput = {
  readonly environmentID: string
  readonly credential: CcaExecutorCredential
  readonly refreshCredential?: CcaCredentialRefresh
  readonly registryBaseURL?: string
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export type RegisterExecutorInput = RegistryRequestInput & {
  readonly identity: CcaNoiseIdentity
}

export type RegisterExecutorWithRetryInput = RegisterExecutorInput & {
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
}

export type ValidateHarnessKeyInput = RegistryRequestInput & {
  readonly executorRegistrationID: string
  readonly harnessPublicKey: CcaNoisePublicKey
  readonly harnessKeyAuthorization: string
  readonly streamID?: string
}

export class CcaRegistryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message)
    this.name = "CcaRegistryHttpError"
  }
}

export type StartCcaExecutorTransportOptions = {
  readonly environmentID: string
  readonly credential: CcaExecutorCredential
  readonly identity: CcaNoiseIdentity
  readonly signal?: AbortSignal
  readonly registryBaseURL?: string
  readonly registration?: CcaRegistrationResult
  readonly refreshCredential?: CcaCredentialRefresh
  readonly keepaliveIntervalMs?: number
  readonly pongTimeoutMs?: number
  readonly writeTimeoutMs?: number
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly connectWebSocket?: (url: string, headers: Record<string, string>) => WebSocketLike | Promise<WebSocketLike>
  readonly acceptHandshake?: (input: CcaNoiseAcceptHandshakeInput) => Promise<{
    readonly response: Uint8Array
    readonly transport: CcaNoiseTransport
  }>
  readonly onChannel: (channel: CcaChannel) => void | Promise<void>
}

export function validateRegistryBaseURL(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error("Invalid registry base URL format")
  }

  if (parsed.username || parsed.password) {
    throw new Error("Registry base URL must not contain userinfo")
  }

  const hostname = parsed.hostname.toLowerCase()
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"

  if (isLoopback) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Invalid registry URL scheme '${parsed.protocol}': http or https required for loopback`)
    }
    return parsed
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Invalid registry URL scheme '${parsed.protocol}': https required`)
  }

  const isTrustedHost = hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")
  if (!isTrustedHost) {
    throw new Error("Untrusted registry base URL host")
  }

  return parsed
}

export function validateWssEndpoint(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error("Invalid rendezvous URL format")
  }

  if (parsed.protocol !== "wss:") {
    throw new Error(`Invalid rendezvous URL scheme '${parsed.protocol}': wss required`)
  }

  if (parsed.username || parsed.password) {
    throw new Error("Rendezvous URL must not contain userinfo")
  }

  const hostname = parsed.hostname.toLowerCase()
  const isChatGPTDomain = hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")
  if (!isChatGPTDomain) {
    throw new Error("Untrusted rendezvous origin host")
  }

  return parsed
}

function operatingSystem(): string {
  if (process.platform === "darwin") return `Mac OS ${macProductVersion()}`
  if (process.platform === "win32") return `Windows ${os.release()}`
  return `Linux ${os.release()}`
}

function macProductVersion(): string {
  try {
    const plist = readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8")
    return /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() || "Unknown"
  } catch {
    return "Unknown"
  }
}

let execServerUserAgent: string | undefined

export function ccaExecServerUserAgent(): string {
  execServerUserAgent ??= `${ccaExecServerOriginator}/${ccaCompatibleExecServerVersion} (${operatingSystem()}; ${os.machine()}) unknown`
  return execServerUserAgent
}

function registryEndpoint(input: RegistryRequestInput, action: "register" | "validate"): string {
  const envId = input.environmentID.trim()
  const parsedBase = validateRegistryBaseURL(input.registryBaseURL ?? defaultRegistryBaseURL)
  const baseUrlHref = parsedBase.href.endsWith("/") ? parsedBase.href : `${parsedBase.href}/`
  return new URL(`cloud/environment/${encodeURIComponent(envId)}/${action}`, baseUrlHref).href
}

function registryHeaders(credential: CcaExecutorCredential): Record<string, string> {
  return {
    authorization: `Bearer ${credential.accessToken}`,
    "chatgpt-account-id": credential.accountID,
    originator: ccaExecServerOriginator,
    "User-Agent": ccaExecServerUserAgent(),
    "content-type": "application/json",
  }
}

function aborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

async function postRegistry<T>(
  input: RegistryRequestInput,
  label: string,
  url: string,
  body: string,
  extraHeaders: Record<string, string>,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const deadline = AbortSignal.timeout(input.timeoutMs ?? ccaRegistryRequestTimeoutMs)
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
  const effectiveFetch = input.fetch ?? fetch
  let credential = input.credential
  for (let retried = false; ; retried = true) {
    let response: Response
    try {
      response = await effectiveFetch(url, {
        method: "POST",
        headers: { ...registryHeaders(credential), ...extraHeaders },
        body,
        redirect: "error",
        signal,
      })
    } catch (error) {
      throw new Error(aborted(error) || signal.aborted ? `${label} timed out or was aborted` : `${label} request failed`)
    }
    if (response.status === 401 && !retried && input.refreshCredential) {
      const refreshed = await input.refreshCredential(credential).catch(() => undefined)
      if (refreshed !== undefined && refreshed.accessToken !== credential.accessToken) {
        await response.body?.cancel().catch(() => {})
        credential = refreshed
        continue
      }
    }
    try {
      return await read(response)
    } catch (error) {
      if (aborted(error)) throw new Error(`${label} timed out or was aborted`)
      throw error
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function registryErrorCode(text: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const body = objectRecord(parsed)
  if (body === undefined) return undefined
  if (body.error !== undefined && body.error !== null) {
    const code = objectRecord(body.error)?.code
    return typeof code === "string" ? code : undefined
  }
  const code = objectRecord(body.detail)?.code
  return typeof code === "string" ? code : undefined
}

export async function registerExecutorEnvironment(
  input: RegisterExecutorInput,
): Promise<CcaRegistrationResult> {
  const envId = input.environmentID.trim()
  if (!envId) {
    throw new Error("Environment ID is required")
  }
  const url = registryEndpoint(input, "register")
  const body = JSON.stringify({
    security_profile: NOISE_RELAY_SECURITY_PROFILE,
    executor_public_key: input.identity.publicKey,
  })

  const parsed = await postRegistry(input, "Executor registration", url, body, {}, async (response) => {
    if (!response.ok) {
      const text = await response.text().catch((error: unknown) => {
        if (aborted(error)) throw error
        return ""
      })
      throw new CcaRegistryHttpError(`Executor registration failed with status ${response.status}`, response.status, registryErrorCode(text))
    }
    try {
      return (await response.json()) as unknown
    } catch (error) {
      if (aborted(error)) throw error
      throw new Error("Executor registration returned an unparseable response")
    }
  })

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Executor registration returned an invalid payload")
  }

  const record = parsed as Record<string, unknown>
  const returnedEnvId = record.environment_id
  const returnedProfile = record.security_profile
  const returnedRegistrationId = record.executor_registration_id
  const returnedUrl = record.url

  if (returnedEnvId !== envId) {
    throw new Error("Environment registry returned a different environment id")
  }

  if (returnedProfile !== NOISE_RELAY_SECURITY_PROFILE) {
    throw new Error("Environment registry returned unsupported security profile")
  }

  if (typeof returnedRegistrationId !== "string" || !returnedRegistrationId.trim()) {
    throw new Error("Environment registry returned invalid executor_registration_id")
  }

  if (typeof returnedUrl !== "string" || !returnedUrl.trim()) {
    throw new Error("Environment registry returned incomplete connection url")
  }

  return {
    environmentID: returnedEnvId,
    executorRegistrationID: returnedRegistrationId.trim(),
    url: returnedUrl.trim(),
    securityProfile: returnedProfile,
  }
}

export function ccaRegistrationRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(500 * 2 ** Math.min(attempt, 4), 5_000)
  return base + Math.floor(random() * (Math.floor(base / 2) + 1))
}

function retryableRegistration(error: unknown): boolean {
  if (!(error instanceof CcaRegistryHttpError)) return false
  return (
    (error.status === 503 && error.code === "registration_conflict") ||
    (error.status === 502 && error.code === "authentication_service_unavailable")
  )
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

export async function registerExecutorEnvironmentWithRetry(
  input: RegisterExecutorWithRetryInput,
): Promise<CcaRegistrationResult> {
  const wait = input.wait ?? delay
  for (let attempt = 0; ; attempt++) {
    try {
      return await registerExecutorEnvironment(input)
    } catch (error) {
      if (!retryableRegistration(error)) throw error
      await wait(ccaRegistrationRetryDelay(attempt, input.random), input.signal)
      if (input.signal?.aborted) throw new Error("Executor registration timed out or was aborted")
    }
  }
}

const HYPHENATED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIMPLE_UUID = /^[0-9a-f]{32}$/i

function canonicalUuid(value: string): string | undefined {
  const inner = value.startsWith("urn:uuid:")
    ? value.slice("urn:uuid:".length)
    : value.startsWith("{") && value.endsWith("}")
      ? value.slice(1, -1)
      : value
  const hex = HYPHENATED_UUID.test(inner) ? inner.replaceAll("-", "") : inner === value && SIMPLE_UUID.test(value) ? value : undefined
  if (hex === undefined) return undefined
  const lower = hex.toLowerCase()
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`
}

export async function validateHarnessKey(
  input: ValidateHarnessKeyInput,
): Promise<void> {
  const url = registryEndpoint(input, "validate")

  const authBytes = new TextEncoder().encode(input.harnessKeyAuthorization)
  if (authBytes.length === 0 || authBytes.length > 4096) {
    throw new Error("Noise relay harness key authorization length is invalid")
  }

  const streamHeader = input.streamID === undefined ? undefined : canonicalUuid(input.streamID)
  const body = JSON.stringify({
    executor_registration_id: input.executorRegistrationID,
    harness_public_key: input.harnessPublicKey,
    harness_key_authorization: input.harnessKeyAuthorization,
  })

  const parsed = await postRegistry(
    { ...input, timeoutMs: input.timeoutMs ?? HARNESS_KEY_VALIDATION_TIMEOUT_MS },
    "Harness key validation",
    url,
    body,
    streamHeader === undefined ? {} : { "x-codex-noise-stream-id": streamHeader },
    async (response) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new CcaRegistryHttpError(`Harness key validation failed with status ${response.status}`, response.status, undefined)
      }
      try {
        return (await response.json()) as unknown
      } catch (error) {
        if (aborted(error)) throw error
        throw new Error("Harness key validation returned unparseable JSON")
      }
    },
  )

  if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).valid !== true) {
    throw new Error("Environment registry rejected Noise relay harness key")
  }
}

export async function startCcaExecutorTransport(
  options: StartCcaExecutorTransportOptions,
): Promise<{ close(): Promise<void> }> {
  let credential = options.credential
  const refreshCredential: CcaCredentialRefresh | undefined = options.refreshCredential && (async (rejected) => {
    const refreshed = await options.refreshCredential!(rejected)
    if (refreshed !== undefined) credential = refreshed
    return refreshed
  })
  const reg = options.registration ?? await registerExecutorEnvironmentWithRetry({
    environmentID: options.environmentID,
    credential,
    identity: options.identity,
    registryBaseURL: options.registryBaseURL,
    fetch: options.fetch,
    signal: options.signal,
    ...(refreshCredential === undefined ? {} : { refreshCredential }),
  })

  const validatedWss = validateWssEndpoint(reg.url)
  const dialWssUrl = validatedWss.href

  const requestId = `req_${randomUUID().replaceAll("-", "")}`
  const wsHeaders: Record<string, string> = {
    "x-request-id": requestId,
  }

  let socket: WebSocketLike
  if (options.connectWebSocket) {
    socket = await options.connectWebSocket(dialWssUrl, wsHeaders)
  } else {
    socket = new WebSocket(dialWssUrl, {
      headers: wsHeaders,
      maxPayload: defaultWsMaxPayload,
    })
  }

  const writeTimeout = options.writeTimeoutMs ?? ccaWriteTimeoutMs
  const pendingWrites = new Set<ReturnType<typeof setTimeout>>()
  const trackWrite = (write: (done: (error?: Error) => void) => void, completed?: () => void) => {
    const timer = setTimeout(() => onSocketTeardown(), writeTimeout)
    timer.unref?.()
    pendingWrites.add(timer)
    const done = (error?: Error) => {
      if (!pendingWrites.delete(timer)) return
      clearTimeout(timer)
      if (error) onSocketTeardown()
      else completed?.()
    }
    try {
      write(done)
    } catch (error) {
      pendingWrites.delete(timer)
      clearTimeout(timer)
      throw error
    }
  }
  const relaySocket: WebSocketLike = {
    get readyState() {
      return socket.readyState
    },
    send: (data) => trackWrite((done) => socket.send(data, done)),
    close: (code, reason) => (code === undefined ? socket.close() : socket.close(code, reason)),
  }

  const effectiveFetch = options.fetch ?? fetch
  const carrier = new CcaRelayCarrier({
    environmentID: options.environmentID,
    executorRegistrationID: reg.executorRegistrationID,
    identity: options.identity,
    socket: relaySocket,
    authorize: async (key: CcaNoisePublicKey, authorization: string, streamID: string) => {
      await validateHarnessKey({
        environmentID: options.environmentID,
        executorRegistrationID: reg.executorRegistrationID,
        credential,
        ...(refreshCredential === undefined ? {} : { refreshCredential }),
        harnessPublicKey: key,
        harnessKeyAuthorization: authorization,
        streamID,
        registryBaseURL: options.registryBaseURL,
        fetch: effectiveFetch,
        signal: options.signal,
      })
    },
    acceptHandshake: async (input) => {
      if (!options.acceptHandshake) {
        throw new Error("No Noise handshake implementation configured")
      }
      return options.acceptHandshake(input)
    },
  })

  carrier.onChannel(options.onChannel)

  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pongDeadline: ReturnType<typeof setTimeout> | null = null

  const cleanupKeepalive = () => {
    if (pingTimer !== null) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (pongDeadline !== null) {
      clearTimeout(pongDeadline)
      pongDeadline = null
    }
    for (const timer of pendingWrites) clearTimeout(timer)
    pendingWrites.clear()
  }

  const attach = socket.on ?? socket.addEventListener
  const remove = socket.off ?? socket.removeListener ?? socket.removeEventListener
  const listeners: Array<readonly [string, (...args: any[]) => void]> = []
  const listen = (event: string, listener: (...args: any[]) => void) => {
    if (!attach) return
    attach.call(socket, event, listener)
    listeners.push([event, listener])
  }
  const detach = () => {
    if (!remove) return
    for (const [event, listener] of listeners) remove.call(socket, event, listener)
    listeners.length = 0
  }
  let socketClosed = socket.readyState === 3
  let closing: Promise<void> | undefined
  let resolveClosing: () => void
  let rejectClosing: (error: Error) => void
  let closeRequested = false
  let closeSucceeded = true
  let settled = false
  const settleClosing = () => {
    if (socketClosed) detach()
    if (!closeRequested || settled) return
    if (!closeSucceeded || (!attach && !socketClosed)) {
      settled = true
      rejectClosing(new Error("CCA executor transport cleanup failed"))
    } else if (socketClosed) {
      settled = true
      resolveClosing()
    }
  }
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = new Promise<void>((resolve, reject) => {
      resolveClosing = resolve
      rejectClosing = reject
    })
    cleanupKeepalive()
    closeSucceeded = carrier.close()
    closeRequested = true
    settleClosing()
    return closing
  }
  const onSocketTeardown = () => {
    void close().catch(() => {})
  }
  const onSocketClose = () => {
    socketClosed = true
    onSocketTeardown()
    settleClosing()
  }

  const ping = socket.ping
  if (ping !== undefined && !socketClosed) {
    const keepaliveInterval = options.keepaliveIntervalMs ?? ccaKeepaliveIntervalMs
    const pongTimeout = options.pongTimeoutMs ?? ccaPongTimeoutMs
    let pingWriting = false
    let pongDuringWrite = false
    let tickPending = false

    const sendPing = () => {
      pingWriting = true
      pongDuringWrite = false
      try {
        trackWrite((done) => ping.call(socket, undefined, undefined, done), () => {
          pingWriting = false
          if (pongDuringWrite) return pongReceived()
          pongDeadline = setTimeout(() => onSocketTeardown(), pongTimeout)
        })
      } catch {
        onSocketTeardown()
      }
    }
    const pongReceived = () => {
      if (!tickPending) return
      tickPending = false
      sendPing()
    }

    pingTimer = setInterval(() => {
      if (pingWriting || pongDeadline !== null) tickPending = true
      else sendPing()
    }, keepaliveInterval)

    listen("pong", () => {
      if (pingWriting) {
        pongDuringWrite = true
        return
      }
      if (pongDeadline === null) return
      clearTimeout(pongDeadline)
      pongDeadline = null
      pongReceived()
    })
  }

  const onIncomingData = (data: unknown) => {
    let bytes: Uint8Array
    if (data instanceof Uint8Array) {
      bytes = data
    } else if (Buffer.isBuffer(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    } else if (typeof data === "object" && data !== null && "data" in data) {
      const inner = (data as { data: unknown }).data
      if (inner instanceof Uint8Array) {
        bytes = inner
      } else if (Buffer.isBuffer(inner)) {
        bytes = new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength)
      } else {
        return
      }
    } else {
      return
    }
    carrier.handleIncomingFrame(bytes).catch(onSocketTeardown)
  }

  listen("close", onSocketClose)
  listen("error", onSocketTeardown)
  listen("message", onIncomingData)
  if (socketClosed) onSocketClose()

  return { close }
}
