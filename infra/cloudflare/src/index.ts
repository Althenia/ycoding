import { DurableObject } from "cloudflare:workers"
import { relayTargets, smokeHostname, smokeSignal, type RelayRole } from "./policy"

type Database = {
  readonly prepare: (query: string) => {
    readonly first: () => Promise<{ readonly ok?: number } | null>
  }
}

type RelayStub = { readonly fetch: (request: Request) => Promise<Response> }
type RelayNamespace = { readonly getByName: (name: string) => RelayStub }

type Env = {
  readonly DB: Database
  readonly DEVICE_RELAY: RelayNamespace
}

type ConnectionMetadata = {
  readonly role: RelayRole
  readonly userId: "test-user"
  readonly deviceId: "test-device"
  readonly sessionId: "test-session"
  readonly connectionId: string
}

const relayName = "test-user:test-device"
const roleHeader = "x-ycoding-smoke-role"
const webSocketOpen = 1

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/" && smokeHostname(url.hostname))
      return new Response("Hello World!")
    if (request.method === "GET" && url.pathname === "/health") return health(env)
    if (url.pathname !== "/ws/agent" && url.pathname !== "/ws/client") return new Response("Not found", { status: 404 })
    if (!smokeHostname(url.hostname)) return new Response("Not found", { status: 404 })
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket upgrade required", { status: 426 })
    const headers = new Headers(request.headers)
    headers.set(roleHeader, url.pathname === "/ws/agent" ? "agent" : "client")
    return env.DEVICE_RELAY.getByName(relayName).fetch(new Request(request, { headers }))
  },
}

async function health(env: Env) {
  try {
    const result = await env.DB.prepare("SELECT 1 AS ok").first()
    if (result?.ok === 1) return Response.json({ status: "ok" })
  } catch {
    // Health responses intentionally omit provider and database details.
  }
  return Response.json({ status: "error" }, { status: 503 })
}

export class DeviceRelay extends DurableObject<Env> {
  override async fetch(request: Request) {
    const role = request.headers.get(roleHeader)
    if (role !== "agent" && role !== "client") return new Response("Invalid relay role", { status: 400 })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    if (role === "agent")
      for (const existing of this.ctx.getWebSockets("agent"))
        if (existing.readyState === webSocketOpen) existing.close(1012, "Agent connection replaced")
    this.ctx.acceptWebSocket(server, [role])
    server.serializeAttachment({
      role,
      userId: "test-user",
      deviceId: "test-device",
      sessionId: "test-session",
      connectionId: crypto.randomUUID(),
    } satisfies ConnectionMetadata)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(socket: WebSocket, value: string | ArrayBuffer) {
    const metadata = connectionMetadata(socket.deserializeAttachment())
    const signal = smokeSignal(value)
    if (!metadata || !signal) {
      socket.close(1003, "Only the ping-pong smoke protocol is supported")
      return
    }
    for (const target of relayTargets(metadata.role, signal)) {
      if (target === "self") {
        socket.send('{"type":"pong"}')
        continue
      }
      const encoded = signal.type === "ping" ? '{"type":"ping"}' : '{"type":"pong"}'
      for (const peer of this.ctx.getWebSockets(target)) if (peer.readyState === webSocketOpen) peer.send(encoded)
    }
  }
}

function connectionMetadata(value: unknown): ConnectionMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const role = Reflect.get(value, "role")
  const userId = Reflect.get(value, "userId")
  const deviceId = Reflect.get(value, "deviceId")
  const sessionId = Reflect.get(value, "sessionId")
  const connectionId = Reflect.get(value, "connectionId")
  if (role !== "agent" && role !== "client") return undefined
  if (userId !== "test-user" || deviceId !== "test-device" || sessionId !== "test-session") return undefined
  if (typeof connectionId !== "string" || connectionId.length === 0) return undefined
  return { role, userId, deviceId, sessionId, connectionId }
}
