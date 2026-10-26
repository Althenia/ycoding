import { hostname } from "node:os"
import { createRemoteControlAppServer, type RemoteControlBackend } from "./app-server"
import { Reassembler, encodeAck, encodeOutbound, encodePong } from "./envelope"
import { accountHash, type RemoteControlStateStore } from "./state"
import {
  buildConnectHeaders,
  buildEnrollHeaders,
  buildEnrollRequest,
  pingIntervalMs,
  pongTimeoutMs,
  streamCloseCode,
  decodeEnrollResponse,
  enrollURL,
  nextActionForHttp,
  parseRetryAfterMs,
  recognizedMissingAppServer,
  reconnectDelay,
  refreshURL,
  websocketURL,
  type Credential,
  type EnrollResponse,
} from "./types"

export interface RemoteControlSocket {
  readonly send: (text: string) => void
  readonly close: (code?: number) => void
  readonly onMessage: (handler: (text: string) => void) => void
  readonly onClose: (handler: () => void) => void
  readonly onError: (handler: (error: unknown) => void) => void
  readonly ping?: () => void
}

export type RemoteControlStatus = {
  readonly state: "off" | "connecting" | "on" | "error"
  readonly message?: string
  readonly profile?: string
  readonly environmentID?: string
  readonly serverName?: string
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export type RemoteControlHostDeps = {
  readonly store: RemoteControlStateStore
  readonly backend: RemoteControlBackend
  readonly codexHome: string
  readonly resolveCredential: (profile: string, rejectedAccessToken?: string) => Promise<Credential | undefined>
  readonly fetchFn?: FetchFn
  readonly connect: (url: string, headers: Record<string, string>) => Promise<RemoteControlSocket>
  readonly hostname?: () => string
  readonly deviceKind?: () => Promise<string | undefined>
  readonly now?: () => number
  readonly heartbeatMs?: number
  readonly pongTimeoutMs?: number
  readonly onDiagnostic?: (message: string) => void
}

class HostError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

function httpStatus(error: unknown) {
  if (typeof error === "object" && error !== null) {
    if ("status" in error && typeof error.status === "number") return error.status
    if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode
  }
  return undefined
}

function safeJSON(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

export function serverNameForHost(name: string) {
  if (process.platform !== "darwin") return name
  return name.includes(".") ? name : `${name}.local`
}

export function createRemoteControlHost(deps: RemoteControlHostDeps) {
  const fetchFn = deps.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init))
  const now = deps.now ?? Date.now
  let current: RemoteControlStatus = { state: "off" }
  let socket: RemoteControlSocket | undefined
  let running = false
  let generation = 0
  let attempt = 0
  let token: { readonly value: string; readonly expiresAt?: number; readonly credentialKey: string } | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastSeen = 0
  let closedWait: (() => void) | undefined

  async function post(url: string, credential: Credential, installationID: string, serverID?: string) {
    const name = serverNameForHost((deps.hostname ?? hostname)())
    const response = await fetchFn(url, {
      method: "POST",
      headers: buildEnrollHeaders({ credential, installationID }),
      body: JSON.stringify(buildEnrollRequest(serverID === undefined ? { name, installationID } : { name, installationID, serverID })),
    })
    const text = await response.text().catch(() => "")
    return { response, text }
  }

  function adopted(enrolled: EnrollResponse, credential: Credential): EnrollResponse {
    token = {
      value: enrolled.remoteControlToken,
      credentialKey: credential.key,
      ...(enrolled.expiresAt === undefined ? {} : { expiresAt: Date.parse(enrolled.expiresAt) }),
    }
    return enrolled
  }

  async function persist(enrolled: EnrollResponse, hash: string) {
    await deps.store.saveEnrollment({
      websocketURL: websocketURL(),
      accountHash: hash,
      enrollment: {
        serverID: enrolled.serverID,
        environmentID: enrolled.environmentID,
        serverName: serverNameForHost((deps.hostname ?? hostname)()),
        remoteControlEnabled: true,
        updatedAt: now(),
      },
    })
  }

  async function enroll(credential: Credential, installationID: string, hash: string): Promise<EnrollResponse> {
    let outcome = await post(enrollURL(), credential, installationID)
    if (!outcome.response.ok) {
      const action = nextActionForHttp({ phase: "enroll", status: outcome.response.status, recognizedMissingAppServer: recognizedMissingAppServer(outcome.text) })
      if (action === "delete_reenroll") {
        await deps.store.deleteEnrollment({ websocketURL: websocketURL(), accountHash: hash })
        outcome = await post(enrollURL(), credential, installationID)
      }
    }
    if (!outcome.response.ok) throw new HostError(`Remote-control enrollment failed (${outcome.response.status})`, parseRetryAfterMs(outcome.response.headers.get("retry-after"), now()))
    const decoded = decodeEnrollResponse(safeJSON(outcome.text))
    if (decoded === undefined) throw new HostError("Remote-control enrollment returned an unexpected response")
    await persist(decoded, hash)
    return adopted(decoded, credential)
  }

  async function refresh(credential: Credential, installationID: string, hash: string, serverID: string): Promise<EnrollResponse> {
    const outcome = await post(refreshURL(), credential, installationID, serverID)
    if (outcome.response.ok) {
      const decoded = decodeEnrollResponse(safeJSON(outcome.text))
      if (decoded === undefined) throw new HostError("Remote-control refresh returned an unexpected response")
      await persist(decoded, hash)
      return adopted(decoded, credential)
    }
    const action = nextActionForHttp({ phase: "refresh", status: outcome.response.status, recognizedMissingAppServer: recognizedMissingAppServer(outcome.text) })
    if (action === "delete_reenroll") return enroll(credential, installationID, hash)
    throw new HostError(`Remote-control refresh failed (${outcome.response.status})`, parseRetryAfterMs(outcome.response.headers.get("retry-after"), now()))
  }

  function tokenUsable(credential: Credential) {
    if (token === undefined || token.credentialKey !== credential.key) return false
    if (token.expiresAt === undefined || Number.isNaN(token.expiresAt)) return true
    return token.expiresAt > now() + 30_000
  }

  async function ensureEnrolled(credential: Credential, installationID: string, hash: string) {
    const existing = await deps.store.enrollment({ websocketURL: websocketURL(), accountHash: hash })
    if (existing !== undefined && tokenUsable(credential))
      return { serverID: existing.serverID, environmentID: existing.environmentID, remoteControlToken: token!.value } satisfies EnrollResponse
    if (existing !== undefined) return refresh(credential, installationID, hash, existing.serverID)
    return enroll(credential, installationID, hash)
  }

  async function openSocket(enrolled: EnrollResponse, installationID: string) {
    const serverName = serverNameForHost((deps.hostname ?? hostname)())
    const kind = deps.deviceKind === undefined ? undefined : await deps.deviceKind().catch(() => undefined)
    return deps.connect(websocketURL(), buildConnectHeaders({
      serverID: enrolled.serverID,
      serverName,
      token: enrolled.remoteControlToken,
      installationID,
      ...(kind === undefined ? {} : { deviceKind: kind }),
    }))
  }

  async function connectOnce(): Promise<void> {
    const state = await deps.store.load()
    if (!state.enabled) { current = { state: "off" }; return }
    if (state.profile === undefined) throw new HostError("Remote control requires a pinned ChatGPT profile")
    current = { state: "connecting", profile: state.profile }
    let credential = await deps.resolveCredential(state.profile)
    if (credential === undefined) throw new HostError("The pinned ChatGPT profile is unavailable")
    const hash = accountHash(credential.accountID)
    let enrolled = await ensureEnrolled(credential, state.installationID, hash)
    let opened: RemoteControlSocket
    try {
      opened = await openSocket(enrolled, state.installationID)
    } catch (error) {
      const status = httpStatus(error)
      if (status === undefined || nextActionForHttp({ phase: "websocket", status }) !== "refresh_reconnect") throw error
      const existing = await deps.store.enrollment({ websocketURL: websocketURL(), accountHash: hash })
      token = undefined
      enrolled = existing === undefined ? await enroll(credential, state.installationID, hash) : await refresh(credential, state.installationID, hash, existing.serverID)
      opened = await openSocket(enrolled, state.installationID)
    }
    socket = opened
    lastSeen = now()
    attempt = 0
    const gen = generation
    const envID = enrolled.environmentID
    let seq = 0
    let lastAddress: { readonly clientID: string; readonly streamID: string } | undefined
    const reassembler = new Reassembler()
    const appServer = createRemoteControlAppServer({
      backend: deps.backend,
      codexHome: deps.codexHome,
      notify: (method, params) => {
        if (lastAddress === undefined) return
        const text = JSON.stringify({ jsonrpc: "2.0", method, params })
        for (const frame of encodeOutbound({ text, clientID: lastAddress.clientID, streamID: lastAddress.streamID, envID, seqID: seq++ })) opened.send(frame)
      },
    })
    opened.onMessage((text) => {
      lastSeen = now()
      const event = reassembler.push(text)
      if (event.kind === "ping") {
        lastAddress = { clientID: event.clientID, streamID: event.streamID }
        opened.send(encodePong({ clientID: event.clientID, streamID: event.streamID, envID, seqID: seq++ }))
        return
      }
      if (event.kind === "closed") { opened.close(streamCloseCode); return }
      if (event.kind === "drop") deps.onDiagnostic?.(`Dropped remote-control frame: ${event.reason}`)
      if (event.kind !== "message") return
      lastAddress = { clientID: event.clientID, streamID: event.streamID }
      opened.send(encodeAck({ clientID: event.clientID, streamID: event.streamID, envID, seqID: seq++ }))
      void appServer.handle(event.text).then((reply) => {
        if (reply === undefined || gen !== generation) return
        for (const frame of encodeOutbound({ text: reply, clientID: event.clientID, streamID: event.streamID, envID, seqID: seq++ })) opened.send(frame)
      })
    })
    const closed = new Promise<void>((resolve) => { closedWait = resolve })
    opened.onClose(() => { if (gen === generation) current = { state: running ? "connecting" : "off", profile: state.profile }; closedWait?.() })
    opened.onError(() => { opened.close() })
    current = { state: "on", profile: state.profile, environmentID: enrolled.environmentID, serverName: serverNameForHost((deps.hostname ?? hostname)()) }
    startHeartbeat(opened, gen)
    void closed
  }

  function startHeartbeat(opened: RemoteControlSocket, gen: number) {
    stopHeartbeat()
    const interval = deps.heartbeatMs ?? pingIntervalMs
    const timeout = deps.pongTimeoutMs ?? pongTimeoutMs
    if (!running) return
    heartbeat = setInterval(() => {
      if (gen !== generation) return
      if (now() - lastSeen > timeout) { opened.close(); return }
      opened.ping?.()
    }, interval)
    heartbeat.unref?.()
  }
  function stopHeartbeat() { if (heartbeat) clearInterval(heartbeat); heartbeat = undefined }

  async function loop(gen: number): Promise<void> {
    while (running && gen === generation) {
      const closed = new Promise<void>((resolve) => { const prev = closedWait; closedWait = () => { prev?.(); resolve() } })
      try {
        await connectOnce()
        if (!running || gen !== generation) return
        if (current.state === "off") return
        await closed
      } catch (error) {
        if (!running || gen !== generation) return
        current = { state: "connecting", message: error instanceof Error ? error.message : "Remote control connection failed" }
        const delay = reconnectDelay({ attempt: attempt++, ...(error instanceof HostError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) })
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
      }
    }
  }

  return {
    status: async (): Promise<RemoteControlStatus> => {
      const state = await deps.store.load()
      if (!state.enabled) return { state: "off", ...(state.profile === undefined ? {} : { profile: state.profile }) }
      return current.state === "off" ? { state: "connecting", ...(state.profile === undefined ? {} : { profile: state.profile }) } : current
    },
    set: async (input: { readonly enabled: boolean; readonly profile?: string }): Promise<RemoteControlStatus> => {
      await deps.store.save(input.profile === undefined ? { enabled: input.enabled } : { enabled: input.enabled, profile: input.profile })
      if (input.enabled) { await startLoop(); return hostStatus() }
      await stop()
      return { state: "off" }
    },
    start: async () => startLoop(),
    connectOnce,
    stop,
    shutdown: stop,
  }

  async function startLoop(): Promise<void> {
    const state = await deps.store.load()
    if (!state.enabled) { current = { state: "off" }; return }
    if (running) return
    running = true
    const gen = ++generation
    void loop(gen)
  }
  async function hostStatus(): Promise<RemoteControlStatus> { return current }
  async function stop(): Promise<void> {
    running = false
    generation++
    stopHeartbeat()
    socket?.close()
    socket = undefined
    current = { state: "off" }
    closedWait?.()
  }
}

export async function defaultDeviceKind(run?: () => Promise<string | undefined>) {
  const name = run === undefined ? undefined : await run().catch(() => undefined)
  const { deviceKindFromMachineName } = await import("./types")
  return deviceKindFromMachineName(name)
}
