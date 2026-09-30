import { expect, test } from "bun:test"
import { parseClientMessage } from "@ycoding-ai/remote"
import { createRemoteTransport, type RemoteTransportOptions } from "./transport"

class Socket extends EventTarget {
  readyState = 0
  readonly CLOSED = 3
  readonly sent: string[] = []
  readonly closes: { code?: number; reason?: string }[] = []
  readonly callbacks = new Map<string, EventListener>()
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    if (typeof callback === "function") this.callbacks.set(type, callback)
    super.addEventListener(type, callback)
  }
  send(frame: string) { this.sent.push(frame) }
  close(code?: number, reason?: string) { this.readyState = 2; this.closes.push({ code, reason }) }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")) }
  message(data = '{"type":"pong"}') { this.dispatchEvent(new MessageEvent("message", { data })) }
}

class Signals extends EventTarget {
  readonly listeners = new Set<string>()
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    this.listeners.add(type)
    super.addEventListener(type, callback)
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
    this.listeners.delete(type)
    super.removeEventListener(type, callback)
  }
}

class Visibility extends Signals {
  hidden = false
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")) }
}

function fixture() {
  const document = new Visibility()
  const window = new Signals()
  const statuses: string[] = []
  const sockets: Socket[] = []
  const tasks: { at: number; callback: () => void; cancelled: boolean }[] = []
  let now = 0
  const schedule: NonNullable<RemoteTransportOptions["schedule"]> = (callback, ms) => {
    const task = { at: now + ms, callback, cancelled: false }
    tasks.push(task)
    return () => { task.cancelled = true }
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const task = tasks.filter((entry) => !entry.cancelled && entry.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!task) break
      task.cancelled = true
      now = task.at
      task.callback()
    }
    now = end
  }
  const transport = createRemoteTransport({
    url: "wss://relay.example.test/client", document, window,
    schedule, pingIntervalMs: 30, pongTimeoutMs: 10, resetDelayMs: 2, random: () => 0,
    handlers: { onStatus: (status) => { statuses.push(status.kind) } },
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket },
  })
  transport.connect()
  sockets[0]!.open()
  return { document, window, sockets, transport, advance, tasks, statuses }
}

test("a silent OPEN socket recovers without awaiting close or replaying sent and queued mutations", async () => {
  const f = fixture()
  try {
    f.advance(30)
    const mutations = Array.from({ length: 27 }, () => f.transport.request("session.interrupt", { sessionID: "ses_a", timeoutMs: 0 }))
    expect(f.sockets[0]!.sent).toHaveLength(27)
    f.advance(10)
    expect(f.sockets[0]!.closes).toHaveLength(1)
    expect(f.transport.status().kind).toBe("reconnecting")
    expect(await mutations[0]).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    expect(await mutations[26]).toEqual({ status: "unavailable", reason: "not-connected" })
    f.advance(1)
    f.sockets[1]!.open()
    expect(f.sockets[1]!.sent).toEqual([])
  } finally { f.transport.close() }
})

test("any received frame satisfies the liveness probe and repeated return signals coalesce", () => {
  const f = fixture()
  try {
    f.advance(30)
    expect(f.sockets[0]!.sent).toEqual(['{"type":"ping"}'])
    f.window.dispatchEvent(new Event("online"))
    f.document.change(false)
    expect(f.sockets[0]!.sent).toHaveLength(1)
    f.advance(9)
    f.sockets[0]!.message('{"type":"sessions"}')
    f.advance(1)
    expect(f.sockets[0]!.closes).toEqual([])
    expect(f.transport.status().kind).toBe("open")
    f.advance(29)
    expect(f.sockets[0]!.sent).toHaveLength(2)
  } finally { f.transport.close() }
})

test("a hidden page gets a fresh response window on foreground and network return", () => {
  const f = fixture()
  try {
    f.advance(30)
    f.document.change(true)
    f.advance(1000)
    expect(f.sockets[0]!.closes).toEqual([])
    f.document.change(false)
    expect(f.sockets[0]!.sent).toHaveLength(2)
    f.advance(9)
    f.sockets[0]!.message()
    f.advance(1)
    expect(f.sockets[0]!.closes).toEqual([])
    f.window.dispatchEvent(new Event("online"))
    expect(f.sockets[0]!.sent).toHaveLength(3)
    f.advance(10)
    expect(f.sockets[0]!.closes).toHaveLength(1)
  } finally { f.transport.close() }
})

test("retired socket callbacks cannot settle replacement requests or disturb its recovery", async () => {
  const f = fixture()
  try {
    const first = f.sockets[0]!
    f.transport.close()
    f.transport.connect()
    f.sockets[1]!.open()
    const result = f.transport.request("session.list", { timeoutMs: 0 })
    const parsed = parseClientMessage(f.sockets[1]!.sent[0]!)
    if (!parsed.ok || parsed.value.type !== "request") throw new Error("Expected the replacement request")
    const request = parsed.value
    const statuses = [...f.statuses]
    first.callbacks.get("message")!(new MessageEvent("message", { data: JSON.stringify({ type: "response", id: request.id, ok: true, value: "stale" }) }))
    first.callbacks.get("close")!(Object.assign(new Event("close"), { code: 4401, reason: "old" }))
    first.callbacks.get("error")!(new Event("error"))
    first.callbacks.get("open")!(new Event("open"))
    expect(f.statuses).toEqual(statuses)
    expect(f.transport.status().kind).toBe("open")
    f.sockets[1]!.message(JSON.stringify({ type: "response", id: request.id, ok: true, value: "current" }))
    expect(await result).toEqual({ status: "ok", value: "current" })
  } finally { f.transport.close() }
})

test("close and terminal authorization stop liveness timers and return listeners", () => {
  for (const code of [1000, 4401, 4403]) {
    const f = fixture()
    if (code === 1000) f.transport.close()
    else f.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code, reason: "credential refused" }))
    f.window.dispatchEvent(new Event("online"))
    f.document.change(false)
    f.advance(1000)
    expect(f.sockets).toHaveLength(1)
    expect(f.sockets[0]!.sent).toEqual([])
    expect(f.tasks.filter((task) => !task.cancelled)).toEqual([])
    expect(f.document.listeners.size).toBe(0)
    expect(f.window.listeners.size).toBe(0)
    expect(f.transport.status()).toMatchObject({ kind: "closed", retryable: false })
    f.transport.close()
  }
})

test("foreground and network return coalesce an immediate retry while backing off", () => {
  const f = fixture()
  try {
    f.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "network lost" }))
    expect(f.transport.status().kind).toBe("reconnecting")
    f.window.dispatchEvent(new Event("online"))
    f.document.change(false)
    expect(f.sockets).toHaveLength(2)
    expect(f.transport.status().kind).toBe("connecting")
    f.advance(1)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1]!.open()
    expect(f.transport.status().kind).toBe("open")
  } finally { f.transport.close() }
})
