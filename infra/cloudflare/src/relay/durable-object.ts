/**
 * `DeviceRelay` Durable Object: one object per `<ownerID>:<deviceID>`.
 *
 * The object is a thin adapter over `relay/core.ts`: it owns the sockets, the
 * per-connection attachment and the expiry alarm. It
 * holds no session content and never executes session work.
 */

import { DurableObject } from "cloudflare:workers"
import { randomToken } from "../auth/crypto"
import { createD1AuthStore } from "../auth/d1-store"
import { createAuthService } from "../auth/service"
import type { WorkerEnv } from "../env"
import { createRelay, type RelayAuthority, type RelayConnection } from "./core"

type Attachment = {
  readonly connectionID: string
  readonly role: "agent" | "client"
  readonly ownerID: string
  readonly deviceID: string
  readonly browserSessionID: string
  readonly credentialExpiresAt: number
  readonly subscriptions: readonly string[]
  readonly pending: readonly { readonly relayID: string; readonly clientID: string }[]
}

const webSocketOpen = 1
/** Revocation and expiry are re-validated at least this often during event delivery. */
const authorityTtlMs = 5_000
const heartbeatRequest = '{"type":"ping"}'
const heartbeatResponse = '{"type":"pong"}'

export class DeviceRelay extends DurableObject<WorkerEnv> {
  readonly #service = createAuthService(createD1AuthStore(this.env.DB))
  readonly #relay = createRelay({
    now: () => Date.now(),
    newID: () => randomToken(9),
    send: (connectionID, message) => {
      const socket = this.#socketFor(connectionID)
      if (socket && socket.readyState === webSocketOpen) socket.send(message)
    },
    close: (connectionID, code, reason) => this.#socketFor(connectionID)?.close(code, reason),
    saveSubscriptions: (connectionID, subscriptions) =>
      this.#patchAttachment(connectionID, (attachment) => ({ ...attachment, subscriptions })),
    savePending: (connectionID, pending) => this.#patchAttachment(connectionID, (attachment) => ({ ...attachment, pending })),
    authorizeClientCommand: async (sessionID, deviceID) =>
      toAuthority(await this.#service.authorizeClientCommand(sessionID, deviceID)),
    authorizeAgentCommand: async (deviceID) => toAuthority(await this.#service.authorizeAgentCommand(deviceID)),
    authorityTtlMs: authorityTtlMs,
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
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = readAttachment(socket)
    if (!attachment) return
    this.#attached.delete(attachment.connectionID)
    this.#relay.detach(attachment.connectionID)
    await this.#armAlarm()
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }

  override async alarm(): Promise<void> {
    await this.#restoreConnections()
    this.#relay.sweep()
    await this.#armAlarm()
  }

  async #internal(url: URL, request: Request): Promise<Response> {
    if (request.headers.get("x-ycoding-internal") !== "1") return new Response("Not found", { status: 404 })
    await this.#restoreConnections()
    if (url.pathname === "/_ycoding/close-device") this.#relay.closeDevice()
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

function trustedConnection(request: Request): Omit<Attachment, "connectionID" | "subscriptions" | "pending"> | undefined {
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
