/**
 * `DeviceRelay` Durable Object: one object per `<ownerID>:<deviceID>`.
 *
 * The object is a thin adapter over `relay/core.ts`: it owns the sockets, the
 * per-connection attachment and the expiry alarm. It
 * holds no session content and never executes session work.
 */

import { DurableObject } from "cloudflare:workers"
import { randomToken } from "../auth/crypto"
import { isSessionID, parseAgentMessage } from "../../../../packages/remote/src/index"
import { createD1AuthStore } from "../auth/d1-store"
import { createAuthService } from "../auth/service"
import type { WorkerEnv } from "../env"
import { createD1PushStore } from "../push/d1-store"
import { sendPushToOwner } from "../push/send"
import { createNoticeStore } from "./notice-store"
import { createRelay, type RelayAuthority, type RelayConnection } from "./core"

type Attachment = {
  readonly connectionID: string
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  readonly subscriptions: readonly string[]
  readonly noticesSubscribed: boolean
  readonly pending: readonly { readonly relayID: string; readonly clientID: string }[]
}

const webSocketOpen = 1
/** Revocation and expiry are re-validated at least this often during event delivery. */
const authorityTtlMs = 5_000
const heartbeatRequest = '{"type":"ping"}'
const heartbeatResponse = '{"type":"pong"}'
const streamIdleTimeoutMs = 30_000

type MessageStream = {
  readonly resolve: (response: Response) => void
  readonly controller: ReadableStreamDefaultController<Uint8Array>
  readonly body: ReadableStream<Uint8Array>
  readonly signal: AbortSignal
  readonly abort: () => void
  timeout: ReturnType<typeof setTimeout>
  started: boolean
}

export class DeviceRelay extends DurableObject<WorkerEnv> {
  readonly #service = createAuthService(createD1AuthStore(this.env.DB))
  readonly #messageStreams = new Map<string, MessageStream>()
  readonly #notices = createNoticeStore({
    sql: this.ctx.storage.sql,
    kv: this.ctx.storage.kv,
    transactionSync: (operation) => this.ctx.storage.transactionSync(operation),
  })
  readonly #relay = createRelay({
    now: () => Date.now(),
    newID: () => randomToken(9),
    send: (connectionID, message) => {
      if (this.#messageStreams.has(connectionID)) { this.#streamFrame(connectionID, message); return }
      const socket = this.#socketFor(connectionID)
      if (socket && socket.readyState === webSocketOpen) socket.send(message)
    },
    close: (connectionID, code, reason) => {
      if (this.#messageStreams.has(connectionID)) { this.#finishMessageStream(connectionID, code === 4401 ? 401 : code === 4403 ? 403 : 503); return }
      this.#socketFor(connectionID)?.close(code, reason)
    },
    saveSubscriptions: (connectionID, subscriptions) =>
      this.#patchAttachment(connectionID, (attachment) => ({ ...attachment, subscriptions })),
    savePending: (connectionID, pending) => this.#patchAttachment(connectionID, (attachment) => ({ ...attachment, pending })),
    loadStatus: () => this.ctx.storage.get("lastStatus"),
    saveStatus: (status) => this.ctx.storage.put("lastStatus", status),
    loadOfflineCheck: () => this.ctx.storage.get("offlineCheck"),
    saveOfflineCheck: async (check) => {
      if (check === undefined) await this.ctx.storage.delete("offlineCheck")
      else await this.ctx.storage.put("offlineCheck", check)
    },
    notices: this.#notices,
    saveNoticeSubscription: (connectionID, noticesSubscribed) =>
      this.#patchAttachment(connectionID, (attachment) => ({ ...attachment, noticesSubscribed })),
    authorizeClientCommand: async (sessionID, deviceID) =>
      toAuthority(await this.#service.authorizeClientCommand(sessionID, deviceID)),
    authorizeAgentCommand: async (deviceID) => toAuthority(await this.#service.authorizeAgentCommand(deviceID)),
    authorityTtlMs: authorityTtlMs,
    notifyPush: (accountID, event) => {
      const publicKey = this.env.VAPID_PUBLIC_KEY
      const privateKey = this.env.VAPID_PRIVATE_KEY
      const subject = this.env.VAPID_SUBJECT
      if (!publicKey || !privateKey || !subject) {
        console.info(JSON.stringify({ component: "web-push", category: event.category, host: "none", targetCount: 0, errorClass: "configuration_missing" }))
        return Promise.resolve([])
      }
      return sendPushToOwner({ store: createD1PushStore(this.env.DB), accountID, event,
        publicKey, privateKey, subject, now: Date.now, fetch: (input, init) => globalThis.fetch(input, init) }).catch((cause: unknown) => {
        console.error(JSON.stringify({ component: "web-push", category: event.category, host: "unknown", targetCount: null, errorClass: "dispatch_error" }))
        throw cause
      })
    },
  })
  readonly #attached = new Set<string>()
  #lastDeadline: number | undefined

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    // Heartbeats are answered by the runtime so an idle connection never wakes the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(heartbeatRequest, heartbeatResponse))
    this.ctx.blockConcurrencyWhile(() => this.#restoreConnections())
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/_ycoding/")) return this.#internal(url, request)

    const trusted = trustedConnection(request)
    if (!trusted) return new Response("Invalid relay connection", { status: 400 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 })

    const pair = new WebSocketPair()
    const attachment: Attachment = {
      ...trusted,
      connectionID: crypto.randomUUID(),
      subscriptions: [],
      noticesSubscribed: false,
      pending: [],
    }
    pair[1].serializeAttachment(attachment)
    this.ctx.acceptWebSocket(pair[1], [attachment.role])
    this.#attached.add(attachment.connectionID)
    await this.#relay.attach(toConnection(attachment))
    await this.#armAlarm()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(socket)
    if (!attachment) {
      socket.close(1003, "Connection metadata is missing")
      return
    }
    if (typeof message !== "string") {
      socket.close(1003, "Binary frames are not supported")
      return
    }
    await this.#restoreConnections()
    if (attachment.role === "agent") await this.#relay.handleAgentMessage(attachment.connectionID, message)
    else await this.#relay.handleClientMessage(attachment.connectionID, message)
    if (this.#attached.has(attachment.connectionID)) await this.#armAlarm()
    await this.#relay.settleDeliveries()
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = readAttachment(socket)
    if (!attachment) return
    this.#attached.delete(attachment.connectionID)
    if (attachment.role === "agent") await this.#relay.agentClosed(toConnection(attachment))
    else this.#relay.detach(attachment.connectionID)
    await this.#armAlarm()
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }

  override async alarm(): Promise<void> {
    await this.#restoreConnections()
    this.#relay.sweep()
    await this.#relay.confirmOffline()
    await this.#armAlarm()
    await this.#relay.settleDeliveries()
  }

  async #internal(url: URL, request: Request): Promise<Response> {
    if (request.headers.get("x-ycoding-internal") !== "1") return new Response("Not found", { status: 404 })
    await this.#restoreConnections()
    if (url.pathname === "/_ycoding/stream-message" || url.pathname === "/_ycoding/stream-attachment")
      return this.#streamContent(request, url.pathname === "/_ycoding/stream-message")
    if (url.pathname === "/_ycoding/close-device") {
      this.#relay.closeDevice()
      await this.ctx.storage.delete("lastStatus")
      this.#notices.clear()
    }
    if (url.pathname === "/_ycoding/presence")
      return new Response(JSON.stringify({ online: this.#relay.agentConnected() }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
    if (url.pathname === "/_ycoding/revoke-session") {
      const sessionID = request.headers.get("x-ycoding-target-session")
      if (sessionID === null || sessionID.length === 0) return new Response(null, { status: 204 })
      await this.#relay.revokeSession(sessionID)
    }
    await this.#armAlarm()
    return new Response(null, { status: 204 })
  }

  async #streamContent(request: Request, message: boolean): Promise<Response> {
    if (request.signal.aborted) return new Response(null, { status: 503 })
    const sessionID = request.headers.get("x-ycoding-target-session") ?? ""
    const item = request.headers.get(message ? "x-ycoding-target-message" : "x-ycoding-target-digest") ?? ""
    const ownerID = request.headers.get("x-ycoding-owner") ?? ""
    const deviceID = request.headers.get("x-ycoding-device") ?? ""
    const browserSessionID = request.headers.get("x-ycoding-browser-session") ?? ""
    const expiresAt = Number(request.headers.get("x-ycoding-credential-expires-at"))
    if (!isSessionID(sessionID) || sessionID.length > 128 || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerID) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(deviceID) || browserSessionID.length === 0 || !Number.isSafeInteger(expiresAt) ||
      (message ? !/^msg_[A-Za-z0-9_-]+$/.test(item) || item.length > 128 : !/^[0-9a-f]{64}$/.test(item)))
      return new Response("Invalid stream target", { status: 400 })
    if (!this.#relay.agentConnected()) return new Response("Local agent unavailable", { status: 503 })
    const connectionID = `http_${crypto.randomUUID()}`
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start: (value) => { controller = value },
      cancel: () => { this.#finishMessageStream(connectionID, 503, true) },
    })
    let resolve!: (response: Response) => void
    const ready = new Promise<Response>((settle) => { resolve = settle })
    const abort = () => this.#finishMessageStream(connectionID, 503)
    const timeout = setTimeout(abort, streamIdleTimeoutMs)
    this.#messageStreams.set(connectionID, { resolve, controller, body, signal: request.signal, abort, timeout, started: false })
    request.signal.addEventListener("abort", abort, { once: true })
    try {
      await this.#relay.attach({ connectionID, role: "client", ownerID, deviceID, browserSessionID,
        credentialExpiresAt: expiresAt, subscriptions: [], noticesSubscribed: false, pending: [] })
      if (!this.#messageStreams.has(connectionID)) return ready
      await this.#relay.handleClientMessage(connectionID, JSON.stringify({ type: "request", id: "stream", sessionID,
        operation: message ? "session.message.stream" : "session.attachment.read", input: message ? { messageID: item } : { digest: item } }))
    } catch {
      this.#finishMessageStream(connectionID, 503)
    }
    return ready
  }

  #streamFrame(connectionID: string, raw: string): void {
    const parsed = parseAgentMessage(raw)
    if (!parsed.ok || parsed.value.type !== "response") return
    const state = this.#messageStreams.get(connectionID)
    if (!state) return
    clearTimeout(state.timeout)
    state.timeout = setTimeout(state.abort, streamIdleTimeoutMs)
    const response = parsed.value
    if (!response.ok) {
      const status = response.error.code === "not_found" || response.error.code === "session_not_allowed" ? 404
        : response.error.code === "invalid_message" ? 400
        : response.error.code === "message_too_large" ? 413 : 503
      this.#finishMessageStream(connectionID, status, false, response.error.code)
      return
    }
    if (response.chunk && typeof response.value !== "string") { this.#finishMessageStream(connectionID, 503); return }
    if (!state.started) {
      state.started = true
      state.resolve(new Response(state.body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } }))
    }
    const text = response.chunk ? response.value : JSON.stringify(response.value)
    state.controller.enqueue(new TextEncoder().encode(String(text)))
    if (!response.chunk || response.chunk.last) this.#finishMessageStream(connectionID)
  }

  #finishMessageStream(connectionID: string, status = 200, cancelled = false, code?: string): void {
    const state = this.#messageStreams.get(connectionID)
    if (!state) return
    this.#messageStreams.delete(connectionID)
    clearTimeout(state.timeout)
    state.signal.removeEventListener("abort", state.abort)
    this.#relay.detach(connectionID)
    if (!state.started) state.resolve(new Response(code === undefined ? null : JSON.stringify({ error: { code } }), {
      status, headers: code === undefined ? undefined : { "content-type": "application/json", "cache-control": "no-store" },
    }))
    if (state.started && status === 200) state.controller.close()
    if (state.started && status !== 200 && !cancelled) state.controller.error(new Error("Remote stream did not complete"))
  }

  async #restoreConnections(): Promise<void> {
    const connections = this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = readAttachment(socket)
      if (!attachment || this.#attached.has(attachment.connectionID)) return []
      this.#attached.add(attachment.connectionID)
      return [toConnection(attachment)]
    })
    await this.#relay.restore(connections)
  }

  #socketFor(connectionID: string): WebSocket | undefined {
    for (const socket of this.ctx.getWebSockets())
      if (readAttachment(socket)?.connectionID === connectionID) return socket
    return undefined
  }

  #patchAttachment(connectionID: string, patch: (attachment: Attachment) => Attachment): void {
    const socket = this.#socketFor(connectionID)
    const attachment = socket ? readAttachment(socket) : undefined
    if (socket && attachment) socket.serializeAttachment(patch(attachment))
  }

  async #armAlarm(): Promise<void> {
    const deadline = this.#relay.nextDeadline()
    if (deadline === this.#lastDeadline) return
    this.#lastDeadline = deadline
    if (deadline === undefined) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(deadline)
  }
}

function trustedConnection(request: Request): Omit<Attachment, "connectionID" | "subscriptions" | "noticesSubscribed" | "pending"> | undefined {
  const role = request.headers.get("x-ycoding-role")
  const ownerID = request.headers.get("x-ycoding-owner")
  const deviceID = request.headers.get("x-ycoding-device")
  const browserSessionID = request.headers.get("x-ycoding-browser-session")
  const credentialExpiresAt = Number(request.headers.get("x-ycoding-credential-expires-at") ?? "0")
  if (role !== "agent" && role !== "client") return undefined
  if (ownerID === null || ownerID.length === 0 || ownerID.length > 64) return undefined
  if (deviceID === null || deviceID.length === 0 || deviceID.length > 64) return undefined
  if (browserSessionID === null || browserSessionID.length === 0 || browserSessionID.length > 64) return undefined
  if (!Number.isFinite(credentialExpiresAt) || credentialExpiresAt <= 0) return undefined
  return { role, ownerID, deviceID, browserSessionID, credentialExpiresAt }
}

function toConnection(attachment: Attachment): RelayConnection {
  return {
    connectionID: attachment.connectionID,
    role: attachment.role,
    ownerID: attachment.ownerID,
    deviceID: attachment.deviceID,
    browserSessionID: attachment.browserSessionID,
    credentialExpiresAt: attachment.credentialExpiresAt,
    subscriptions: attachment.subscriptions,
    noticesSubscribed: attachment.noticesSubscribed,
    pending: attachment.pending,
  }
}

function readAttachment(socket: WebSocket): Attachment | undefined {
  const value: unknown = socket.deserializeAttachment()
  if (!isRecord(value)) return undefined
  const record = value
  if (typeof record.connectionID !== "string" || record.connectionID.length === 0) return undefined
  if (record.role !== "agent" && record.role !== "client") return undefined
  if (typeof record.ownerID !== "string" || typeof record.deviceID !== "string") return undefined
  if (typeof record.browserSessionID !== "string" || typeof record.credentialExpiresAt !== "number") return undefined
  return {
    connectionID: record.connectionID,
    role: record.role,
    ownerID: record.ownerID,
    deviceID: record.deviceID,
    browserSessionID: record.browserSessionID,
    credentialExpiresAt: record.credentialExpiresAt,
    subscriptions: Array.isArray(record.subscriptions) ? record.subscriptions.filter(isString) : [],
    noticesSubscribed: record.noticesSubscribed === true,
    pending: Array.isArray(record.pending) ? record.pending.filter(isPending) : [],
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isPending(value: unknown): value is { relayID: string; clientID: string } {
  if (!isRecord(value)) return false
  return typeof value.relayID === "string" && typeof value.clientID === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toAuthority(outcome: { readonly ok: true } | { readonly ok: false; readonly reason: string }): RelayAuthority {
  return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason }
}
