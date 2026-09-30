import { expect, test } from "bun:test"
import { RemoteLimits } from "@ycoding-ai/remote"
import { createRemoteTransport, type RemoteTransportOptions, type RemoteTransportStatus } from "./transport"

class Socket extends EventTarget {
  readyState = 0
  readonly CLOSED = 3
  readonly sent: string[] = []
  send(frame: string) { this.sent.push(frame) }
  close() { this.readyState = 3 }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")) }
  message(frame: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })) }
  priorities() { return this.frames().filter((frame) => frame.type === "priority") }
  frames() { return this.sent.map((frame) => JSON.parse(frame) as { type: string; id?: string; mode?: string }) }
}

class Visibility extends EventTarget {
  hidden = false
  change(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event("visibilitychange")) }
}

function fixture(options: Partial<RemoteTransportOptions> = {}) {
  const document = new Visibility()
  const sockets: Socket[] = []
  const statuses: RemoteTransportStatus[] = []
  const batches: { sessionID: string; events: readonly unknown[] }[] = []
  const tasks: { at: number; callback: () => void; cancelled: boolean }[] = []
  const clock = { now: 0 }
  const schedule: NonNullable<RemoteTransportOptions["schedule"]> = (callback, ms) => {
    const task = { at: clock.now + ms, callback, cancelled: false }
    tasks.push(task)
    return () => { task.cancelled = true }
  }
  const advance = (ms: number) => {
    const end = clock.now + ms
    for (;;) {
      const task = tasks.filter((entry) => !entry.cancelled && entry.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!task) break
      task.cancelled = true
      clock.now = task.at
      task.callback()
    }
    clock.now = end
  }
  const transport = createRemoteTransport({
    url: "wss://relay.example.test/client",
    document,
    schedule,
    now: () => clock.now,
    pingIntervalMs: 600_000,
    pongTimeoutMs: 500,
    resetDelayMs: 2,
    random: () => 0,
    handlers: {
      onStatus: (status) => { statuses.push(status) },
      onEvents: (sessionID, events) => { batches.push({ sessionID, events }) },
    },
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket },
    ...options,
  })
  transport.connect()
  sockets[0]!.open()
  return { document, sockets, statuses, batches, transport, advance, clock }
}

test("an events frame is delivered as one ordered batch", () => {
  const f = fixture()
  try {
    f.sockets[0]!.message({ type: "events", sessionID: "ses_a", events: [{ n: 1 }, { n: 2 }, { n: 3 }] })
    expect(f.batches).toEqual([{ sessionID: "ses_a", events: [{ n: 1 }, { n: 2 }, { n: 3 }] }])
  } finally { f.transport.close() }
})

test("a legacy event frame is delivered as a one-element batch", () => {
  const f = fixture()
  try {
    f.sockets[0]!.message({ type: "event", sessionID: "ses_a", event: { n: 1 } })
    expect(f.batches).toEqual([{ sessionID: "ses_a", events: [{ n: 1 }] }])
  } finally { f.transport.close() }
})

test("aborting a request still queued removes it without sending and resolves cancelled", async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    const filler = Array.from({ length: RemoteLimits.maxClientRequestsPerWindow - 3 }, () => f.transport.request("session.list", { timeoutMs: 0 }))
    const queued = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    expect(f.sockets[0]!.frames()).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 3)
    controller.abort()
    expect(await queued).toEqual({ status: "unavailable", reason: "cancelled" })
    f.advance(RemoteLimits.clientRateWindowMs)
    expect(f.sockets[0]!.frames()).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 3)
    expect(filler).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 3)
  } finally { f.transport.close() }
})

test("aborting a sent request sends a paced cancel, resolves cancelled, and drops the late response", async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    const outcome = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    const request = f.sockets[0]!.frames()[0]!
    controller.abort()
    expect(await outcome).toEqual({ status: "unavailable", reason: "cancelled" })
    expect(f.sockets[0]!.frames().slice(1)).toEqual([{ type: "cancel", id: request.id }])
    f.sockets[0]!.message({ type: "response", id: request.id, ok: true, value: "late" })
    expect(f.transport.status().kind).toBe("open")
    const next = f.transport.request("session.list", { timeoutMs: 0 })
    f.sockets[0]!.message({ type: "response", id: f.sockets[0]!.frames()[2]!.id, ok: true, value: "fresh" })
    expect(await next).toEqual({ status: "ok", value: "fresh" })
  } finally { f.transport.close() }
})

test("a cancel frame waits behind the client rate window like any other frame", async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    const outcome = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    Array.from({ length: RemoteLimits.maxClientRequestsPerWindow - 4 }, () => f.transport.request("session.list", { timeoutMs: 0 }))
    const sentBeforeCancel = f.sockets[0]!.frames().length
    controller.abort()
    expect(await outcome).toEqual({ status: "unavailable", reason: "cancelled" })
    expect(f.sockets[0]!.frames()).toHaveLength(sentBeforeCancel)
    f.advance(RemoteLimits.clientRateWindowMs)
    expect(f.sockets[0]!.frames().at(-1)).toMatchObject({ type: "cancel" })
  } finally { f.transport.close() }
})

test("an already aborted signal resolves cancelled without sending", async () => {
  const f = fixture()
  try {
    expect(await f.transport.request("session.list", { signal: AbortSignal.abort() })).toEqual({ status: "unavailable", reason: "cancelled" })
    expect(f.sockets[0]!.sent).toEqual([])
  } finally { f.transport.close() }
})

test("priority follows visibility, sends only on change, and is resent after reopen while hidden", () => {
  const f = fixture()
  try {
    f.document.change(false)
    expect(f.sockets[0]!.priorities()).toEqual([])
    f.document.change(true)
    f.document.change(true)
    expect(f.sockets[0]!.priorities()).toEqual([{ type: "priority", mode: "background" }])
    f.transport.setPriority("background")
    expect(f.sockets[0]!.priorities()).toHaveLength(1)
    f.document.change(false)
    expect(f.sockets[0]!.priorities().at(-1)).toEqual({ type: "priority", mode: "interactive" })
    f.document.change(true)
    f.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }))
    f.advance(2)
    f.sockets[1]!.open()
    expect(f.sockets[1]!.priorities()).toEqual([{ type: "priority", mode: "background" }])
  } finally { f.transport.close() }
})

test("an explicit priority call shares the visibility dedupe", () => {
  const f = fixture()
  try {
    f.transport.setPriority("background")
    f.transport.setPriority("background")
    f.transport.setPriority("interactive")
    expect(f.sockets[0]!.frames()).toEqual([
      { type: "priority", mode: "background" },
      { type: "priority", mode: "interactive" },
    ])
  } finally { f.transport.close() }
})

test("the interval between a ping and the next frame is published as a smoothed round trip", () => {
  const f = fixture({ pingIntervalMs: 1_000 })
  try {
    expect(f.transport.status()).toEqual({ kind: "open" })
    f.advance(1_000)
    expect(f.sockets[0]!.frames()).toEqual([{ type: "ping" }])
    f.advance(100)
    f.sockets[0]!.message({ type: "pong" })
    expect(f.transport.status()).toEqual({ kind: "open", rttMs: 100 })
    f.advance(1_000)
    f.advance(200)
    f.sockets[0]!.message({ type: "pong" })
    expect(f.transport.status()).toEqual({ kind: "open", rttMs: 130 })
    f.sockets[0]!.message({ type: "pong" })
    expect(f.transport.status()).toEqual({ kind: "open", rttMs: 130 })
  } finally { f.transport.close() }
})
