import { Database } from "bun:sqlite"
import { expect, jest, mock, test } from "bun:test"
import { ControlSchema, LedgerClass, PeerRole, QuotaPaceStatus, StatusSchema, create, operations, type Frame } from "../../../packages/protocol/src/v5"
import { Connection, frameReservation, handoffBinary, quotaToWire, receiveBinary, remoteEventTypes } from "../../../packages/remote/src/index"
import type { WorkerEnv } from "../src/env"
import type { RelayDeps } from "../src/relay/binary-core"
import { createNoticeStorage } from "./notice-storage"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: DurableObjectState, readonly env: WorkerEnv) {}
  },
}))

const { DeviceRelay } = await import("../src/relay/durable-object")

async function withDevice(run: (fixture: Awaited<ReturnType<typeof device>>) => Promise<void>) {
  const original = globalThis.WebSocketPair
  const originalResponsePair = globalThis.WebSocketRequestResponsePair
  const db = new Database(":memory:")
  jest.useFakeTimers()
  jest.setSystemTime(new Date(1_000_000))
  try {
    await run(await device(db))
  } finally {
    globalThis.WebSocketPair = original
    globalThis.WebSocketRequestResponsePair = originalResponsePair
    jest.useRealTimers()
    db.close()
  }
}

async function device(db: Database) {
  let alarm: number | undefined
  let alarms = 0
  let alarmWrites = 0
  let inbound = 0
  const closed: number[] = []
  const controls: string[] = []
  const quotaResults: QuotaPaceStatus[] = []
  const claims: { name: string; method: string; path: string; op: unknown }[] = []
  const sockets = new Map<WebSocket, readonly string[]>()
  let nextSocket: WebSocket
  globalThis.WebSocketPair = class {
    0 = nextSocket
    1 = nextSocket
  } as typeof WebSocketPair
  globalThis.WebSocketRequestResponsePair = class {
    constructor(readonly request: string, readonly response: string) {}
  }
  const id = { name: "v5:owner:device", equals: (other: { name: string }) => other.name === id.name }
  let offline: Awaited<ReturnType<RelayDeps["loadOfflineCheck"]>>
  let confirmations = 0
  let disconnected = false
  let autoResponse: WebSocketRequestResponsePair | undefined
  const ctx = {
    id,
    acceptWebSocket: (socket: WebSocket, tags: string[]) => { sockets.set(socket, tags) },
    getWebSockets: (tag?: string) => [...sockets].filter(([, tags]) => !tag || tags.includes(tag)).map(([socket]) => socket),
    setWebSocketAutoResponse: (pair?: WebSocketRequestResponsePair) => { autoResponse = pair },
    blockConcurrencyWhile: (operation: () => Promise<unknown>) => operation(),
    storage: {
      ...createNoticeStorage(db),
      get: async () => offline,
      put: async (_key: string, check: typeof offline) => { offline = check },
      delete: async () => { offline = undefined },
      setAlarm: async (at: number) => { alarm = at; alarmWrites++ },
      deleteAlarm: async () => { alarm = undefined },
      getAlarm: async () => alarm ?? null,
    },
  }
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", key.publicKey)
  const publicKey = JSON.stringify({ kty, crv, x, y })
  const env = {
    DEVICE_RELAY: {
      idFromName: () => id,
      getByName: (name: string) => ({
        fetch: async (request: Request) => {
          const body: unknown = await request.json()
          claims.push({ name, method: request.method, path: new URL(request.url).pathname,
            op: body && typeof body === "object" && "op" in body ? body.op : undefined })
          return Response.json({ status: "reserved", granted: [] })
        },
      }),
    },
    DB: { prepare: (query: string) => ({ bind: (name: string) => ({ first: async () => {
      if (disconnected) { confirmations++; return null }
      if (query.includes("FROM browser_session"))
        return { id: name, user_id: "owner", created_at: Date.now(), expires_at: Date.now() + 7_200_000, revoked_at: null }
      return { id: "device", user_id: "owner", name: "Device", alias: null, public_key_jwk: publicKey,
        created_at: Date.now(), last_seen_at: null, revoked_at: null }
    } }) }) },
  } as unknown as WorkerEnv
  const createRelay = (name = id.name) => new DeviceRelay({ ...ctx, id: { ...id, name } } as unknown as DurableObjectState, env)
  let adapter = createRelay()
  function peerFor(role: "agent" | "client") {
    const output: Uint8Array[] = []
    let attachment: unknown
    const socket = {
      readyState: WebSocket.OPEN,
      serializeAttachment: (value: unknown) => { attachment = structuredClone(value) },
      deserializeAttachment: () => attachment,
      send: (bytes: Uint8Array) => output.push(bytes),
      close: (code: number) => { closed.push(code); socket.readyState = WebSocket.CLOSED },
    } as unknown as WebSocket
    const peer = new Connection({ role: role === "agent" ? PeerRole.AGENT : PeerRole.REMOTE_CLIENT, peer: PeerRole.RELAY,
      operations, eventTypes: remoteEventTypes, now: performance.now() })
  async function exchange() {
    const clock = performance.now()
    for (const bytes of output.splice(0)) {
      const { frame } = receiveBinary(peer, bytes.slice().buffer, clock)
      if (frame?.body.case !== "control" || !frame.body.value.kind.case) continue
      if (frame.ledger === LedgerClass.NORMAL) peer.consume(LedgerClass.NORMAL, frame.deliveryOrdinal, clock)
      const control = frame.body.value.kind
      controls.push(control.case)
      if (control.case === "quotaPaceResult") quotaResults.push(control.value.status)
    }
    const frames: Uint8Array[] = []
    handoffBinary(peer, (bytes) => frames.push(bytes), clock)
    for (const bytes of frames) {
      inbound++
      await adapter.webSocketMessage(socket, bytes.slice().buffer)
    }
  }
  return {
    exchange,
    send(kind: Frame["body"] & { case: "control" }) {
      expect(peer.enqueue(kind, frameReservation(kind), performance.now())).toEqual([])
      return exchange()
    },
    async open(lifetime: number, handshake = true) {
      nextSocket = socket
      const response = await adapter.fetch(new Request(`https://relay.internal/ws/v5/${role}`, {
        headers: { upgrade: "websocket", "x-ycoding-protocol": "5", "x-ycoding-role": role,
          "x-ycoding-owner": "owner", "x-ycoding-device": "device", "x-ycoding-browser-session": role === "agent" ? "device" : "browser",
          "x-ycoding-credential-expires-at": String(Date.now() + lifetime) },
      }))
      expect(response.status).toBe(101)
      if (!handshake) return
      peer.start(performance.now())
      await exchange()
      await exchange()
      await exchange()
      expect(peer.state).toBe("established")
    },
    async disconnect() {
      sockets.delete(socket)
      disconnected = true
      socket.readyState = WebSocket.CLOSED
      await adapter.webSocketClose(socket)
      adapter = createRelay()
    },
  }
  }
  return {
    agent: peerFor("agent"),
    client: peerFor("client"),
    closed,
    controls,
    quotaResults,
    claims,
    autoResponse: () => autoResponse,
    createRelay,
    hibernate() {
      adapter = createRelay()
    },
    alarms: () => alarms,
    alarmWrites: () => alarmWrites,
    inbound: () => inbound,
    confirmations: () => confirmations,
    async advance(ms: number) {
      const end = Date.now() + ms
      while (alarm !== undefined && alarm <= end) {
        if (++alarms > 1) throw new Error("Device exceeded one Durable Object alarm in the simulation")
        jest.advanceTimersByTime(alarm - Date.now())
        alarm = undefined
        await adapter.alarm()
      }
      jest.advanceTimersByTime(end - Date.now())
    },
  }
}

test("an idle v5 agent and client stay within the hourly request budget without keeping the relay awake", async () => {
  await withDevice(async (d) => {
    await d.agent.open(7_200_000)
    await d.client.open(7_200_000)
    expect(jest.getTimerCount()).toBe(0)
    for (let tick = 0; tick < 180; tick++) {
      await d.advance(20_000)
      if (tick % 10 === 0) d.hibernate()
      await d.agent.exchange()
      await d.client.exchange()
      expect(jest.getTimerCount()).toBe(0)
    }
    await d.agent.exchange()
    await d.client.exchange()
    expect(d.closed).toEqual([])
    expect(d.alarms()).toBe(0)
    expect(d.alarmWrites()).toBe(1)
    expect(d.inbound()).toBe(364)
    d.hibernate()
    d.controls.length = 0
    await d.agent.send({ case: "control", value: create(ControlSchema, { kind: { case: "status", value: create(StatusSchema) } }) })
    await d.client.exchange()
    expect(d.controls).toContain("status")
    expect(d.closed).toEqual([])
  })
})

test("a v5 socket without a Hello closes at the handshake deadline without an alarm", async () => {
  await withDevice(async (d) => {
    await d.agent.open(60_000, false)
    await d.advance(4_999)
    expect(d.closed).toEqual([])
    await d.advance(1)
    expect(d.closed).toEqual([1008])
    expect(d.alarms()).toBe(0)
  })
})

test("a quieter v5 connection still expires without further socket messages", async () => {
  await withDevice(async (d) => {
    await d.agent.open(10_000)
    await d.advance(9_999)
    expect(d.closed).toEqual([])
    await d.advance(1)
    expect(d.closed).toEqual([4401])
    expect(d.alarms()).toBe(1)
  })
})

test("the v5 offline alarm survives reconstruction and runs once after the disconnected agent's grace period", async () => {
  await withDevice(async (d) => {
    await d.agent.open(60_000)
    await d.agent.disconnect()
    await d.advance(39_999)
    expect(d.confirmations()).toBe(0)
    await d.advance(1)
    expect(d.confirmations()).toBe(1)
    expect(d.alarms()).toBe(1)
  })
})

test("v4 registers a runtime heartbeat pair while v5 handles binary heartbeat frames in the relay", async () => {
  await withDevice(async (d) => {
    d.createRelay("owner:device")
    expect(d.autoResponse()).toEqual({ request: '{"type":"ping"}', response: '{"type":"pong"}' })
    d.createRelay()
    expect(d.autoResponse()).toBeUndefined()
    await d.agent.open(60_000)
    expect(d.controls).toContain("pong")
    d.controls.length = 0
    await d.advance(20_000)
    await d.agent.exchange()
    await d.agent.exchange()
    expect(d.controls).toEqual(["pong"])
    expect(d.closed).toEqual([])
  })
})

test("v5 status sends no owner quota request; each eligible quota frame sends one even if duplicated", async () => {
  await withDevice(async (d) => {
    await d.agent.open(60_000)
    await d.agent.send({ case: "control", value: create(ControlSchema, { kind: { case: "status", value: create(StatusSchema) } }) })
    expect(d.claims).toEqual([])
    const alert = (resetAt: number) => d.agent.send({ case: "control", value: create(ControlSchema, { kind: {
      case: "quotaPace", value: quotaToWire({ providerID: "anthropic", windowID: "five-hour", milestone: "almost-out", resetAt }),
    } }) })
    await alert(Date.now())
    expect(d.claims).toEqual([])
    const reset = Date.now() + 60_000
    await alert(reset)
    const reservation = { name: "owner:quota", method: "POST", path: "/_ycoding/quota", op: "reserve" }
    expect(d.claims).toEqual([reservation])
    await alert(reset)
    await d.agent.exchange()
    expect(d.claims).toEqual([reservation, reservation])
    expect(d.quotaResults).toEqual([QuotaPaceStatus.SETTLED, QuotaPaceStatus.SETTLED, QuotaPaceStatus.SETTLED])
  })
})
