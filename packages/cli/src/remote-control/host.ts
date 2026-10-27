import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import type { NativeDots } from "@ycoding-ai/core/dots/native"
import type { DotsAccess } from "@ycoding-ai/core/dots/access"
import { createRemoteControlAppServer } from "./app-server"
import { createRemoteControlBackend } from "./backend"
import { Reassembler, encodeAck, encodeOutbound, encodePong } from "./envelope"
import { accountHash, type RemoteControlStateStore } from "./state"
import {
  buildConnectHeaders,
  buildEnrollHeaders,
  buildEnrollRequest,
  pingIntervalMs,
  pongTimeoutMs,
  decodeEnrollResponse,
  enrollURL,
  nextActionForHttp,
  maxMessageBytes,
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
  readonly problem?: DotsAccess.TransportStatus["problem"]
  readonly profile?: string
  readonly environmentID?: string
  readonly serverName?: string
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export type RemoteControlHostDeps = {
  readonly store: RemoteControlStateStore
  readonly native: NativeDots.Host
  readonly codexHome: string
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
  constructor(message: string, readonly retryAfterMs?: number, readonly status?: number) {
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
  let retireSocket: (() => void) | undefined
  let unsubscribeConfiguration: (() => void) | undefined
  let configurationWork = Promise.resolve()
  let selected = ""
  let cancelBackoff: (() => void) | undefined

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
    if (!outcome.response.ok) throw new HostError(`Remote-control enrollment failed (${outcome.response.status})`, parseRetryAfterMs(outcome.response.headers.get("retry-after"), now()), outcome.response.status)
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
    throw new HostError(`Remote-control refresh failed (${outcome.response.status})`, parseRetryAfterMs(outcome.response.headers.get("retry-after"), now()), outcome.response.status)
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

  async function openSocket(enrolled: EnrollResponse, credential: Credential, installationID: string) {
    const serverName = serverNameForHost((deps.hostname ?? hostname)())
    const kind = deps.deviceKind === undefined ? undefined : await deps.deviceKind().catch(() => undefined)
    return deps.connect(websocketURL(), buildConnectHeaders({
      serverID: enrolled.serverID,
      serverName,
      token: enrolled.remoteControlToken,
      credential,
      installationID,
      ...(kind === undefined ? {} : { deviceKind: kind }),
    }))
  }

  async function connectOnce(): Promise<void> {
    const connectingGeneration = generation
    const failed = (problem: NonNullable<RemoteControlStatus["problem"]>, error: unknown): never => {
      const status = httpStatus(error)
      if (connectingGeneration === generation) current = { state: "error", problem: status === 401 || status === 403 ? "authentication" : problem }
      throw error
    }
    const state = await deps.store.load().catch((error: unknown) => failed("configuration", error))
    if (connectingGeneration !== generation) return
    const configuration = await deps.native.configuration().catch((error: unknown) => failed("configuration", error))
    if (connectingGeneration !== generation) return
    if (!configuration.enabled) { current = { state: "off" }; return }
    current = { state: "connecting", profile: configuration.profile }
    let credential = await deps.native.credential(configuration.profile).catch((error: unknown) => failed("authentication", error))
    if (connectingGeneration !== generation) return
    if (credential === undefined) return failed("authentication", new HostError("The pinned ChatGPT profile is unavailable"))
    if (credential.accountID !== configuration.accountID || credential.credentialID !== configuration.credentialID || credential.accountGeneration !== configuration.accountGeneration)
      return failed("authentication", new HostError("The pinned ChatGPT profile changed"))
    const hash = accountHash(credential.accountID)
    let enrolled = await ensureEnrolled(credential, state.installationID, hash).catch((error: unknown) => failed("enrollment", error))
    if (connectingGeneration !== generation) return
    let opened: RemoteControlSocket
    try {
      opened = await openSocket(enrolled, credential, state.installationID)
    } catch (error) {
      if (connectingGeneration !== generation) return
      const status = httpStatus(error)
      if (status === undefined || nextActionForHttp({ phase: "websocket", status }) !== "refresh_reconnect") return failed("connection", error)
      const refreshed = await deps.native.credential(configuration.profile, credential.access).catch((error: unknown) => failed("authentication", error))
      if (connectingGeneration !== generation) return
      if (!refreshed || refreshed.credentialID !== configuration.credentialID || refreshed.accountID !== configuration.accountID || refreshed.accountGeneration !== configuration.accountGeneration)
        return failed("authentication", new HostError("The pinned ChatGPT profile is unavailable"))
      credential = refreshed
      const existing = await deps.store.enrollment({ websocketURL: websocketURL(), accountHash: hash }).catch((error: unknown) => failed("enrollment", error))
      if (connectingGeneration !== generation) return
      token = undefined
      enrolled = await (existing === undefined ? enroll(credential, state.installationID, hash) : refresh(credential, state.installationID, hash, existing.serverID))
        .catch((error: unknown) => failed("enrollment", error))
      if (connectingGeneration !== generation) return
      opened = await openSocket(enrolled, credential, state.installationID).catch((error: unknown) => failed("connection", error))
    }
    if (connectingGeneration !== generation) { opened.close(); return }
    retireSocket?.()
    socket?.close()
    socket = opened
    lastSeen = now()
    attempt = 0
    const gen = generation
    const envID = enrolled.environmentID
    const reassembler = new Reassembler({ envID })
    const streams = new Map<string, { readonly server: ReturnType<typeof createRemoteControlAppServer>; seq: number }>()
    const retired = new Set<string>()
    let active = true
    const isCurrent = () => active && gen === generation && socket === opened
    let connection: NativeDots.Connection | undefined
    let dispatch: ((text: string) => void) | undefined
    const buffered: string[] = []
    let bufferedBytes = 0
    const retire = () => {
      if (!active) return
      active = false
      stopHeartbeat()
      buffered.length = 0
      for (const stream of streams.values()) stream.server.retire()
      streams.clear(); retired.clear(); reassembler.clear()
      connection?.retire()
    }
    retireSocket = retire
    opened.onClose(() => { if (!isCurrent()) return; retire(); current = { state: "error", problem: "connection" }; closedWait?.() })
    opened.onError(() => { if (!isCurrent()) return; current = { state: "error", problem: "connection" }; opened.close() })
    opened.onMessage((text) => {
      if (!isCurrent()) return
      if (dispatch) { dispatch(text); return }
      bufferedBytes += Buffer.byteLength(text)
      if (bufferedBytes > maxMessageBytes) { current = { state: "error", problem: "connection" }; retire(); opened.close(); closedWait?.(); return }
      buffered.push(text)
    })
    connection = await deps.native.attach({
      profile: configuration.profile, credentialID: configuration.credentialID,
      accountID: configuration.accountID, accountGeneration: configuration.accountGeneration,
      accessRevision: configuration.accessRevision,
      environmentID: envID, connectionID: randomUUID(), isCurrent,
    }).catch((error: unknown) => { retire(); opened.close(); return failed("configuration", error) })
    if (!isCurrent()) { connection.retire(); opened.close(); return }
    const streamFor = (event: { readonly clientID: string; readonly streamID: string; readonly envID: string }) => {
      const key = JSON.stringify([event.envID, event.clientID, event.streamID])
      const existing = streams.get(key)
      if (existing) return existing
      const current: { readonly server: ReturnType<typeof createRemoteControlAppServer>; seq: number } = { seq: 0, server: createRemoteControlAppServer({
        backend: createRemoteControlBackend({ channel: connection!.channel({ clientID: event.clientID, streamID: event.streamID }), profile: configuration.profile }),
        codexHome: deps.codexHome,
        requestScope: JSON.stringify([event.clientID, event.streamID]),
        send: (text) => {
          if (!isCurrent() || streams.get(key) !== current) return
          for (const frame of encodeOutbound({ text, clientID: event.clientID, streamID: event.streamID, envID, seqID: current.seq++ })) opened.send(frame)
        },
      }) }
      streams.set(key, current)
      return current
    }
    dispatch = (text) => {
      if (!isCurrent()) return
      const raw = safeJSON(text)
      if (typeof raw === "object" && raw !== null && "env_id" in raw && typeof raw.env_id === "string" && raw.env_id !== "" && raw.env_id !== envID) return
      if (typeof raw === "object" && raw !== null && "client_id" in raw && "stream_id" in raw &&
        retired.has(JSON.stringify([envID, raw.client_id, raw.stream_id]))) return
      lastSeen = now()
      const event = reassembler.push(text)
      if (event.kind === "closed") {
        const key = JSON.stringify([event.envID, event.clientID, event.streamID])
        streams.get(key)?.server.retire()
        streams.delete(key)
        retired.add(key)
        reassembler.forget(event)
        return
      }
      if (event.kind !== "drop") opened.send(encodeAck(event))
      if (event.kind === "ping") {
        const key = JSON.stringify([event.envID, event.clientID, event.streamID])
        if (retired.has(key)) return
        const stream = streamFor(event)
        opened.send(encodePong({ clientID: event.clientID, streamID: event.streamID, envID, seqID: stream.seq++ }))
        return
      }
      if (event.kind === "drop") {
        const record = event.reason === "missing_address" || event.reason === "unknown_type" ? safeJSON(text) : undefined
        const metadata = typeof record === "object" && record !== null && !Array.isArray(record) && typeof Reflect.get(record, "type") === "string"
          ? JSON.stringify({
              type: Reflect.get(record, "type").slice(0, 80),
              keys: Object.keys(record).sort().slice(0, 32).map((key) => key.slice(0, 80)),
              address: ["client_id", "env_id", "stream_id"].filter((key) => Object.hasOwn(record, key)),
            })
          : undefined
        deps.onDiagnostic?.(`Dropped remote-control frame: ${event.reason}${metadata === undefined ? "" : ` ${metadata}`}`)
      }
      if (event.kind !== "message") return
      const key = JSON.stringify([event.envID, event.clientID, event.streamID])
      if (retired.has(key)) return
      const owner = streamFor(event)
      void owner.server.handle(event.text).then((reply) => {
        if (reply === undefined || !isCurrent() || streams.get(key) !== owner) return
        for (const frame of encodeOutbound({ text: reply, clientID: event.clientID, streamID: event.streamID, envID, seqID: owner.seq++ })) opened.send(frame)
      })
    }
    for (const text of buffered) dispatch(text)
    buffered.length = 0
    current = { state: "on", profile: configuration.profile, environmentID: enrolled.environmentID, serverName: serverNameForHost((deps.hostname ?? hostname)()) }
    startHeartbeat(opened, gen)
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
      let signalClosed: () => void = () => {}
      const closed = new Promise<void>((resolve) => { signalClosed = resolve; closedWait = resolve })
      try {
        await connectOnce()
        if (!running || gen !== generation) return
        if (current.state === "off") return
        await closed
      } catch (error) {
        if (!running || gen !== generation) return
        if (current.state !== "error") current = { state: "error", problem: "connection" }
        const delay = reconnectDelay({ attempt: attempt++, ...(error instanceof HostError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { cancelBackoff = undefined; resolve() }, delay)
          timer.unref?.()
          cancelBackoff = () => { clearTimeout(timer); cancelBackoff = undefined; resolve() }
        })
      } finally {
        if (closedWait === signalClosed) closedWait = undefined
      }
    }
  }

  async function hostStatus(): Promise<RemoteControlStatus> {
    const serverName = serverNameForHost((deps.hostname ?? hostname)())
    const state = await deps.native.configuration().catch(() => undefined)
    if (state === undefined) return { state: "error", problem: "configuration", serverName }
    if (!state.enabled) return { state: "off", serverName }
    return current.state === "off" ? { state: "connecting", profile: state.profile, serverName } : { ...current, serverName }
  }

  return {
    status: hostStatus,
    start: async () => {
      unsubscribeConfiguration ??= deps.native.subscribeConfiguration(() => { invalidate(); void reconcile() })
      await reconcile()
    },
    connectOnce,
    stop,
    shutdown: stop,
  }

  function reconcile() {
    const requestedGeneration = generation
    const work = configurationWork.then(async () => {
      if (!unsubscribeConfiguration) return
      const configuration = await deps.native.configuration()
      if (!unsubscribeConfiguration || requestedGeneration !== generation) return
      const key = JSON.stringify(configuration)
      if (selected === key) return
      invalidate()
      selected = key
      token = undefined
      if (!configuration.enabled) return
      running = true
      current = { state: "connecting", profile: configuration.profile }
      void loop(generation)
    })
    configurationWork = work.catch(() => { if (unsubscribeConfiguration && requestedGeneration === generation) current = { state: "error", problem: "configuration" } })
    return configurationWork
  }
  function invalidate() {
    running = false
    generation++
    selected = ""
    cancelBackoff?.()
    stopHeartbeat()
    retireSocket?.()
    retireSocket = undefined
    socket?.close()
    socket = undefined
    current = { state: "off" }
    closedWait?.()
  }
  async function stop(): Promise<void> {
    unsubscribeConfiguration?.()
    unsubscribeConfiguration = undefined
    invalidate()
    await configurationWork
  }
}

export async function defaultDeviceKind(run?: () => Promise<string | undefined>) {
  const name = run === undefined ? undefined : await run().catch(() => undefined)
  const { deviceKindFromMachineName } = await import("./types")
  return deviceKindFromMachineName(name)
}
