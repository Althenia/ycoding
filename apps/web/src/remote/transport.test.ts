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

/** Sends `count` requests and answers each at once, so the rate window fills without holding in-flight slots. */
async function fillWindow(f: ReturnType<typeof fixture>, count: number) {
  for (let index = 0; index < count; index += 1) {
    const outcome = f.transport.request("session.list", { timeoutMs: 0 })
    const socket = f.sockets[0]!
    socket.message({ type: "response", id: socket.frames().at(-1)!.id, ok: true, value: null })
    await outcome
  }
}

test("aborting a request still queued removes it without sending and resolves cancelled", async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    await fillWindow(f, RemoteLimits.maxClientRequestsPerWindow - 3)
    const queued = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    expect(f.sockets[0]!.frames()).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 3)
    controller.abort()
    expect(await queued).toEqual({ status: "unavailable", reason: "cancelled" })
    f.advance(RemoteLimits.clientRateWindowMs)
    expect(f.sockets[0]!.frames()).toHaveLength(RemoteLimits.maxClientRequestsPerWindow - 3)
  } finally { f.transport.close() }
})

test("reports paced queue time separately from the completed request round trip without retaining payloads", async () => {
  const timings: unknown[] = []
  const f = fixture({ handlers: { onRequestTiming: (sample) => timings.push(sample) } })
  try {
    await fillWindow(f, RemoteLimits.maxClientRequestsPerWindow - 3)
    timings.length = 0
    f.advance(25)
    const outcome = f.transport.request("session.list", { input: { search: "private query" }, timeoutMs: 0 })
    f.advance(RemoteLimits.clientRateWindowMs - 25)
    const frame = f.sockets[0]!.frames().at(-1)!
    f.advance(17)
    f.sockets[0]!.message({ type: "response", id: frame.id, ok: true, value: { private: "response" } })
    expect(await outcome).toEqual({ status: "ok", value: { private: "response" } })
    expect(timings).toEqual([{ operation: "session.list", outcome: "ok", queueMs: 9_975, settlementMs: 17, totalMs: 9_992 }])
    expect(JSON.stringify(timings)).not.toMatch(/private|query|response"/)
  } finally { f.transport.close() }
})

test("records a queued cancellation without inventing response time or sending a request", async () => {
  const timings: unknown[] = []
  const f = fixture({ handlers: { onRequestTiming: (sample) => timings.push(sample) } })
  try {
    await fillWindow(f, RemoteLimits.maxClientRequestsPerWindow - 3)
    timings.length = 0
    const controller = new AbortController()
    const outcome = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    f.advance(7)
    controller.abort()
    expect(await outcome).toEqual({ status: "unavailable", reason: "cancelled" })
    expect(timings).toEqual([{ operation: "session.list", outcome: "unavailable", reason: "cancelled", queueMs: 7, totalMs: 7 }])
    f.advance(RemoteLimits.clientRateWindowMs)
    expect(timings).toHaveLength(1)
  } finally { f.transport.close() }
})

test("records sent timeout once and a rejected preflight with no wire time", async () => {
  const timings: unknown[] = []
  const f = fixture({ handlers: { onRequestTiming: (sample) => timings.push(sample) } })
  try {
    const outcome = f.transport.request("session.snapshot", { timeoutMs: 35 })
    f.advance(35)
    expect((await outcome).status).toBe("unknown")
    expect(timings).toEqual([{ operation: "session.snapshot", outcome: "unknown", queueMs: 0, settlementMs: 35, totalMs: 35 }])
    f.sockets[0]!.message({ type: "response", id: f.sockets[0]!.frames()[0]!.id, ok: true, value: "late" })
    expect(timings).toHaveLength(1)
    f.transport.close()
    expect((await f.transport.request("session.list")).status).toBe("unavailable")
    expect(timings.at(-1)).toEqual({ operation: "session.list", outcome: "unavailable", reason: "not-connected", queueMs: 0, totalMs: 0 })
  } finally { f.transport.close() }
})

test("keeps sent and unsent close outcomes distinct in the timing record", async () => {
  const timings: unknown[] = []
  const f = fixture({ handlers: { onRequestTiming: (sample) => timings.push(sample) } })
  try {
    const sent = f.transport.request("session.status", { timeoutMs: 0 })
    await fillWindow(f, RemoteLimits.maxClientRequestsPerWindow - 4)
    timings.length = 0
    const queued = f.transport.request("session.list", { timeoutMs: 0 })
    f.advance(9)
    f.sockets[0]!.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }))
    expect((await sent).status).toBe("unknown")
    expect(await queued).toEqual({ status: "unavailable", reason: "not-connected" })
    expect(timings).toEqual([
      { operation: "session.status", outcome: "unknown", queueMs: 0, settlementMs: 9, totalMs: 9 },
      { operation: "session.list", outcome: "unavailable", reason: "not-connected", queueMs: 9, totalMs: 9 },
    ])
  } finally { f.transport.close() }
})

test("a failed local timing observer cannot change a request outcome", async () => {
  const f = fixture({ handlers: { onRequestTiming: () => { throw new Error("observer failed") } } })
  try {
    const result = f.transport.request("session.list", { timeoutMs: 0 })
    const id = f.sockets[0]!.frames()[0]!.id
    f.sockets[0]!.message({ type: "response", id, ok: true, value: { data: [] } })
    expect(await result).toEqual({ status: "ok", value: { data: [] } })
    f.transport.close()
    expect(await f.transport.request("session.list")).toEqual({ status: "unavailable", reason: "not-connected" })
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
    await fillWindow(f, RemoteLimits.maxClientRequestsPerWindow - 4)
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
