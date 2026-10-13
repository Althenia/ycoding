import { DurableObject } from "cloudflare:workers"
import { RemoteWebSocketPath } from "../../../../packages/remote/src/index"
import { randomToken } from "../auth/crypto"
import { createD1AuthStore } from "../auth/d1-store"
import { createAuthService } from "../auth/service"
import type { WorkerEnv } from "../env"
import { createD1PushStore } from "../push/d1-store"
import { sendPushToOwner } from "../push/send"
import { createNoticeStore } from "./notice-store"
import { createRelay } from "./core"
import type { RelayAuthority, RelayConnection } from "./core"

export class DeviceRelay extends DurableObject<WorkerEnv> {
  readonly #service = createAuthService(createD1AuthStore(this.env.DB))
  readonly #notices = createNoticeStore({
    sql: this.ctx.storage.sql,
    kv: this.ctx.storage.kv,
    transactionSync: (operation) => this.ctx.storage.transactionSync(operation),
  })
  readonly #relay = createRelay({
    now: () => Date.now(),
    monotonic: () => performance.now(),
    newID: () => randomToken(24),
    send: (connectionID, bytes) => {
      const socket = this.#socketFor(connectionID)
      if (!socket || socket.readyState !== 1) throw new Error("Socket handoff unavailable")
      socket.send(bytes)
    },
    close: (connectionID, code, reason) => {
      const socket = this.#socketFor(connectionID)
      if (socket && (socket.readyState === 1 || socket.readyState === 2)) socket.close(code, reason)
    },
    notices: this.#notices,
    authorizeClientCommand: async (sessionID, deviceID) =>
      toAuthority(await this.#service.authorizeClientCommand(sessionID, deviceID)),
    authorizeAgentCommand: async (deviceID) => toAuthority(await this.#service.authorizeAgentCommand(deviceID)),
    loadOfflineCheck: () => this.ctx.storage.get("offlineCheck"),
    saveOfflineCheck: async (check) => {
      if (check === undefined) await this.ctx.storage.delete("offlineCheck")
      else await this.ctx.storage.put("offlineCheck", check)
    },
    notifyPush: (ownerID, event) => {
      const publicKey = this.env.VAPID_PUBLIC_KEY
      const privateKey = this.env.VAPID_PRIVATE_KEY
      const subject = this.env.VAPID_SUBJECT
      if (!publicKey || !privateKey || !subject) {
        console.info(
          JSON.stringify({
            component: "web-push",
            category: event.category,
            host: "none",
            targetCount: 0,
            errorClass: "configuration_missing",
          }),
        )
        return Promise.resolve([])
      }
      return sendPushToOwner({
        store: createD1PushStore(this.env.DB),
        accountID: ownerID,
        event,
        publicKey,
        privateKey,
        subject,
        now: Date.now,
        fetch: (input, init) => globalThis.fetch(input, init),
      })
    },
  })
  readonly #attached = new Set<string>()

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    void this.ctx.blockConcurrencyWhile(async () => {
      const restored = this.ctx.getWebSockets().flatMap((socket) => {
        const identity = readAttachment(socket)
        if (!identity) {
          socket.close(1012, "EPOCH")
          return []
        }
        return [identity]
      })
      await this.#relay.restore(restored)
    })
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/_ycoding/")) {
      if (request.headers.get("x-ycoding-internal") !== "1") return new Response("Not found", { status: 404 })
      if (url.pathname === "/_ycoding/presence")
        return Response.json({ online: this.#relay.agentConnected() }, { headers: { "cache-control": "no-store" } })
      if (url.pathname === "/_ycoding/stream-message" || url.pathname === "/_ycoding/stream-attachment") {
        const response = await this.#relay.readContent(request, url.pathname === "/_ycoding/stream-message")
        await this.#armAlarm()
        if (response.status !== 200) return response
        const length = response.headers.get("content-length")
        if (!response.body || length === null) throw new Error("HTTP bulk declaration is missing")
        const fixed = new FixedLengthStream(BigInt(length))
        this.ctx.waitUntil(response.body.pipeTo(fixed.writable))
        return new Response(fixed.readable, { status: response.status, headers: response.headers })
      }
      if (url.pathname === "/_ycoding/close-device") {
        this.#relay.closeDevice()
        this.#notices.clear()
      }
      if (url.pathname === "/_ycoding/revoke-session")
        await this.#relay.revokeSession(request.headers.get("x-ycoding-target-session") ?? "")
      await this.#armAlarm()
      return new Response(null, { status: 204 })
    }
    if (url.pathname !== RemoteWebSocketPath.agent && url.pathname !== RemoteWebSocketPath.client)
      return new Response("Not found", { status: 404 })
    const trusted = trustedConnection(request)
    if (
      !trusted ||
      (trusted.role === "agent" ? RemoteWebSocketPath.agent : RemoteWebSocketPath.client) !== url.pathname
    )
      return new Response("Invalid relay connection", { status: 400 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 })
    const pair = new WebSocketPair()
    const identity = { ...trusted, connectionID: crypto.randomUUID() }
    pair[1].serializeAttachment(identity)
    this.ctx.acceptWebSocket(pair[1], [identity.role])
    this.#attached.add(identity.connectionID)
    await this.#relay.attach(identity)
    await this.#armAlarm()
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const identity = readAttachment(socket)
    if (!identity || !this.#attached.has(identity.connectionID)) {
      socket.close(1012, "EPOCH")
      return
    }
    try {
      if (identity.role === "agent") await this.#relay.handleAgentMessage(identity.connectionID, message)
      else await this.#relay.handleClientMessage(identity.connectionID, message)
    } catch {
      this.#relay.detach(identity.connectionID)
      socket.close(1012, "EPOCH")
    }
    await this.#armAlarm()
    await this.#relay.settleDeliveries()
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const identity = readAttachment(socket)
    if (!identity) return
    this.#attached.delete(identity.connectionID)
    if (identity.role === "agent") await this.#relay.agentClosed(identity)
    else this.#relay.detach(identity.connectionID)
    await this.#armAlarm()
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }
  override async alarm(): Promise<void> {
    this.#relay.sweep()
    await this.#relay.confirmOffline()
    await this.#armAlarm()
    await this.#relay.settleDeliveries()
  }

  #socketFor(connectionID: string) {
    return this.ctx.getWebSockets().find((socket) => readAttachment(socket)?.connectionID === connectionID)
  }
  async #armAlarm() {
    const deadline = this.#relay.nextDeadline()
    if (deadline === undefined) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    await this.ctx.storage.setAlarm(deadline)
  }
}

function trustedConnection(request: Request): Omit<RelayConnection, "connectionID"> | undefined {
  const role = request.headers.get("x-ycoding-role")
  const ownerID = request.headers.get("x-ycoding-owner")
  const deviceID = request.headers.get("x-ycoding-device")
  const browserSessionID = request.headers.get("x-ycoding-browser-session")
  const credentialExpiresAt = Number(request.headers.get("x-ycoding-credential-expires-at") ?? "0")
  if (role !== "agent" && role !== "client") return undefined
  if (
    !ownerID ||
    !deviceID ||
    !browserSessionID ||
    [ownerID, deviceID, browserSessionID].some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))
  )
    return undefined
  if (!Number.isSafeInteger(credentialExpiresAt) || credentialExpiresAt <= 0) return undefined
  return { role, ownerID, deviceID, browserSessionID, credentialExpiresAt }
}

function readAttachment(socket: WebSocket): RelayConnection | undefined {
  const value: unknown = socket.deserializeAttachment()
  if (
    typeof value !== "object" ||
    value === null ||
    !("connectionID" in value) ||
    !("role" in value) ||
    !("ownerID" in value) ||
    !("deviceID" in value) ||
    !("browserSessionID" in value) ||
    !("credentialExpiresAt" in value)
  )
    return undefined
  if (
    typeof value.connectionID !== "string" ||
    (value.role !== "agent" && value.role !== "client") ||
    typeof value.ownerID !== "string" ||
    typeof value.deviceID !== "string" ||
    typeof value.browserSessionID !== "string" ||
    typeof value.credentialExpiresAt !== "number"
  )
    return undefined
  return {
    connectionID: value.connectionID,
    role: value.role,
    ownerID: value.ownerID,
    deviceID: value.deviceID,
    browserSessionID: value.browserSessionID,
    credentialExpiresAt: value.credentialExpiresAt,
  }
}

function toAuthority(
  outcome:
    | { readonly ok: true; readonly value: { readonly userID: string } }
    | { readonly ok: false; readonly reason: string },
): RelayAuthority {
  return outcome.ok ? { ok: true, ownerID: outcome.value.userID } : { ok: false, reason: outcome.reason }
}
