import { RemoteWebSocketPath } from "../../../../packages/remote/src/index"
import { randomToken } from "../auth/crypto"
import type { AuthService } from "../auth/service"
import {
  createRelay,
  type DeviceSnapshot,
  type PeerSnapshot,
  type RelayAuthority,
  type RelayConnection,
  type RelayDeps,
} from "./binary-core"

export const binaryRelaySocketTag = "v5"

type RelayDelivery = Pick<RelayDeps, "notices" | "loadOfflineCheck" | "saveOfflineCheck" | "notifyPush" | "quota">
type Attachment = { identity: RelayConnection; generation?: number; device?: DeviceSnapshot; peer?: PeerSnapshot }

const persistRetryMs = 1_000

export class BinaryRelayAdapter {
  #relay: ReturnType<typeof createRelay>
  readonly #attached = new Map<string, RelayConnection>()
  #protocolTimer?: ReturnType<typeof setTimeout>
  #protocolDeadline?: number
  #alarmAt?: number | null
  #generation = 0
  #resumable?: boolean

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly namespace: DurableObjectNamespace,
    private readonly service: AuthService,
    private readonly delivery: RelayDelivery,
  ) {
    this.#relay = this.#createRelay()
    this.ctx.setWebSocketAutoResponse()
    const restored = this.#resume()
    for (const socket of this.ctx.getWebSockets())
      if (!restored.has(socket)) closeSocket(socket, 1012, "EPOCH")
    this.#armProtocolTimer()
  }

  #createRelay(): ReturnType<typeof createRelay> {
    const { delivery, service } = this
    return createRelay({
      ...delivery,
      now: () => Date.now(),
      monotonic: () => performance.now(),
      scheduleProtocol: () => this.#settle(),
      newID: () => randomToken(24),
      send: (connectionID, bytes) => {
        const socket = this.#socketFor(connectionID)
        if (socket?.readyState !== WebSocket.OPEN) throw new Error("Socket handoff unavailable")
        socket.send(bytes)
      },
      close: (connectionID, code, reason) => {
        const socket = this.#socketFor(connectionID)
        if (socket) closeSocket(socket, code, reason)
      },
      authorizeClientCommand: async (sessionID, deviceID) =>
        toAuthority(await service.authorizeClientCommand(sessionID, deviceID)),
      authorizeAgentCommand: async (deviceID) => toAuthority(await service.authorizeAgentCommand(deviceID)),
    })
  }

  #resume(): Set<WebSocket> {
    const saved = this.ctx
      .getWebSockets(binaryRelaySocketTag)
      .map((socket) => ({ socket, attachment: readAttachment(socket) }))
    const latest = saved.find((entry) => entry.attachment?.device)?.attachment
    const device = latest?.device
    if (!device) return new Set()
    const restored = saved.flatMap(({ socket, attachment }) =>
      attachment?.peer && attachment.generation === latest.generation && device.peers.includes(attachment.identity.connectionID)
        ? [{ socket, identity: attachment.identity, peer: attachment.peer }]
        : [],
    )
    try {
      this.#relay.resume(device, restored)
    } catch (error) {
      console.error("v5 relay snapshot could not be restored", error)
      this.#relay = this.#createRelay()
      return new Set()
    }
    for (const entry of restored) this.#attached.set(entry.identity.connectionID, entry.identity)
    this.#generation = latest.generation ?? 0
    this.#resumable = true
    return new Set(restored.map((entry) => entry.socket))
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname.startsWith("/_ycoding/")) return this.#internal(pathname, request)
    if (pathname !== RemoteWebSocketPath.agent && pathname !== RemoteWebSocketPath.client)
      return new Response("Not found", { status: 404 })
    const trusted = trustedConnection(request)
    if (
      !trusted ||
      request.headers.get("x-ycoding-protocol") !== "5" ||
      pathname !== RemoteWebSocketPath[trusted.role] ||
      !this.namespace.idFromName(`v5:${trusted.ownerID}:${trusted.deviceID}`).equals(this.ctx.id)
    ) return new Response("Invalid relay connection", { status: 400 })
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 })

    const pair = new WebSocketPair()
    const identity = { ...trusted, connectionID: crypto.randomUUID() }
    pair[1].serializeAttachment({ identity } satisfies Attachment)
    this.ctx.acceptWebSocket(pair[1], [binaryRelaySocketTag, identity.role, identity.connectionID])
    this.#attached.set(identity.connectionID, identity)
    try {
      await this.#relay.attach(identity)
      this.#settle()
      await this.#armAlarm()
    } catch (error) {
      this.#failSocket(pair[1], identity.connectionID)
      throw error
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const identity = this.#identity(socket)
    if (!identity) {
      closeSocket(socket, 1012, "EPOCH")
      return
    }
    try {
      if (identity.role === "agent") await this.#relay.handleAgentMessage(identity.connectionID, message)
      else await this.#relay.handleClientMessage(identity.connectionID, message)
    } catch {
      this.#failSocket(socket, identity.connectionID)
    }
    await this.#armAlarm()
    await this.#relay.settleDeliveries()
    this.#settle()
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const identity = this.#identity(socket)
    if (!identity) return
    this.#attached.delete(identity.connectionID)
    if (identity.role === "agent") await this.#relay.agentClosed(identity)
    else this.#relay.detach(identity.connectionID)
    this.#settle()
    await this.#armAlarm()
  }

  async alarm(): Promise<void> {
    this.#alarmAt = undefined
    this.#relay.sweep()
    await this.#relay.confirmOffline()
    await this.#armAlarm()
    await this.#relay.settleDeliveries()
    this.#settle()
  }

  async #internal(pathname: string, request: Request): Promise<Response> {
    if (request.headers.get("x-ycoding-internal") !== "1") return new Response("Not found", { status: 404 })
    switch (pathname) {
      case "/_ycoding/v5/presence":
        return Response.json({ online: this.#relay.agentConnected() }, { headers: { "cache-control": "no-store" } })
      case "/_ycoding/v5/stream-message":
      case "/_ycoding/v5/stream-attachment": {
        const response = await this.#relay.readContent(request, pathname === "/_ycoding/v5/stream-message")
        await this.#armAlarm()
        if (response.status !== 200) return response
        const length = response.headers.get("content-length")
        if (!response.body || length === null || !/^[0-9]+$/.test(length)) {
          await response.body?.cancel()
          throw new Error("HTTP bulk declaration is missing or invalid")
        }
        const fixed = new FixedLengthStream(BigInt(length))
        this.ctx.waitUntil(response.body.pipeTo(fixed.writable))
        const headers = new Headers(response.headers)
        headers.set("content-encoding", "identity")
        headers.set("cache-control", "no-store, no-transform")
        return new Response(fixed.readable, { status: response.status, headers, encodeBody: "manual" })
      }
      case "/_ycoding/v5/close-device":
        this.#relay.closeDevice()
        this.#settle()
        this.delivery.notices.clear()
        break
      case "/_ycoding/v5/revoke-session": {
        const sessionID = request.headers.get("x-ycoding-target-session")
        if (sessionID) await this.#relay.revokeSession(sessionID)
        break
      }
      default:
        return new Response("Not found", { status: 404 })
    }
    this.#settle()
    await this.#armAlarm()
    return new Response(null, { status: 204 })
  }

  #identity(socket: WebSocket): RelayConnection | undefined {
    const connectionID = readAttachment(socket)?.identity.connectionID
    return connectionID === undefined ? undefined : this.#attached.get(connectionID)
  }

  #socketFor(connectionID: string): WebSocket | undefined {
    return this.ctx.getWebSockets(connectionID)[0]
  }

  #failSocket(socket: WebSocket, connectionID: string): void {
    closeSocket(socket, 1012, "EPOCH")
    this.#attached.delete(connectionID)
    this.#relay.detach(connectionID)
  }

  async #armAlarm(): Promise<void> {
    const deadline = await this.#relay.nextAlarm() ?? null
    this.#alarmAt ??= await this.ctx.storage.getAlarm()
    if (deadline === this.#alarmAt) return
    this.#alarmAt = deadline
    try {
      if (deadline === null) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(deadline)
    } catch (error) {
      if (this.#alarmAt === deadline) this.#alarmAt = undefined
      throw error
    }
  }

  #settle(): void {
    this.#persist()
    this.#armProtocolTimer()
  }

  #persist(): void {
    const sockets = this.ctx
      .getWebSockets(binaryRelaySocketTag)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
    const snapshot = this.#relay.snapshot()
    if (snapshot) {
      const generation = ++this.#generation
      try {
        for (const socket of sockets) {
          const identity = this.#identity(socket)
          if (!identity) continue
          const peer = snapshot.peers.find((entry) => entry.connectionID === identity.connectionID)
          socket.serializeAttachment(
            (peer ? { identity, generation, device: snapshot.device, peer } : { identity }) satisfies Attachment,
          )
        }
        this.#resumable = true
        return
      } catch (error) {
        console.error("v5 relay snapshot exceeds the WebSocket attachment limit", error)
      }
    }
    if (this.#resumable === false) return
    this.#resumable = false
    for (const socket of sockets) {
      const identity = this.#identity(socket)
      if (identity) socket.serializeAttachment({ identity } satisfies Attachment)
    }
  }

  #armProtocolTimer(): void {
    let deadline = this.#relay.nextProtocolDeadline()
    if (this.#resumable === false) {
      const retry = performance.now() + persistRetryMs
      const pending = this.#protocolDeadline !== undefined && this.#protocolDeadline <= retry ? this.#protocolDeadline : retry
      deadline = Math.min(deadline ?? Infinity, pending)
    }
    if (deadline === this.#protocolDeadline) return
    if (this.#protocolTimer !== undefined) clearTimeout(this.#protocolTimer)
    this.#protocolDeadline = deadline
    this.#protocolTimer = deadline === undefined ? undefined : setTimeout(() => {
      this.#protocolDeadline = undefined
      this.#protocolTimer = undefined
      this.#relay.sweep()
    }, Math.max(0, Math.ceil(deadline - performance.now())))
  }
}

function readAttachment(socket: WebSocket): Attachment | undefined {
  const value: unknown = socket.deserializeAttachment()
  if (typeof value !== "object" || value === null || !("identity" in value)) return undefined
  const identity: unknown = value.identity
  if (
    typeof identity !== "object" || identity === null ||
    !("connectionID" in identity) || typeof identity.connectionID !== "string"
  ) return undefined
  return value as Attachment
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close(code, reason)
}

function trustedConnection(request: Request): Omit<RelayConnection, "connectionID"> | undefined {
  const role = request.headers.get("x-ycoding-role")
  const ownerID = request.headers.get("x-ycoding-owner")
  const deviceID = request.headers.get("x-ycoding-device")
  const browserSessionID = request.headers.get("x-ycoding-browser-session")
  const credentialExpiresAt = Number(request.headers.get("x-ycoding-credential-expires-at"))
  if (role !== "agent" && role !== "client") return undefined
  if (
    !ownerID || !deviceID || !browserSessionID ||
    [ownerID, deviceID, browserSessionID].some((id) => !/^[A-Za-z0-9_-]{1,64}$/.test(id)) ||
    !Number.isSafeInteger(credentialExpiresAt) || credentialExpiresAt <= 0
  ) return undefined
  return { role, ownerID, deviceID, browserSessionID, credentialExpiresAt }
}

function toAuthority(outcome: Awaited<ReturnType<AuthService["authorizeClientCommand"]>>): RelayAuthority {
  return outcome.ok ? { ok: true, ownerID: outcome.value.userID } : { ok: false, reason: outcome.reason }
}
