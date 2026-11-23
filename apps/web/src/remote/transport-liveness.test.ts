import { expect, test } from "bun:test"
import { WireLimit } from "@ycoding-ai/remote"
import { fillWindow, transportFixture, type BinarySocket } from "../../test/wire-peer"

const probe = { pingIntervalMs: 50, pongTimeoutMs: 10 }
const pings = (socket: BinarySocket) =>
  socket.sent.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "ping").length

test("an unresponsive browser upgrade expires and reconnects without a close event", () => {
  const f = transportFixture({ open: false })
  try {
    const first = f.sockets[0]!
    first.close = (code, reason) => { first.closes.push({ code, reason }) }
    f.advance(WireLimit.HANDSHAKE_TIMEOUT_MS - 1)
    expect(f.transport.status().kind).toBe("connecting")
    f.advance(1)
    expect(f.transport.status().kind).toBe("reconnecting")
    expect(first.closes).toEqual([{ code: 1008, reason: "INCOMPATIBLE" }])
    f.advance(1)
    f.sockets[1]!.open()
    expect(f.transport.status().kind).toBe("open")
    first.open()
    expect(f.transport.status().kind).toBe("open")
  } finally { f.transport.close() }
})

test("a silent OPEN socket recovers without awaiting close or replaying sent and queued mutations", async () => {
  const f = transportFixture(probe)
  try {
    const first = f.sockets[0]!
    const reads = WireLimit.CLIENT_RATE - 5
    await fillWindow(f, reads)
    const beforeProbe = pings(first)
    first.holdMessages = true
    first.close = (code, reason) => { first.closes.push({ code, reason }) }
    f.advance(probe.pingIntervalMs)
    expect(pings(first)).toBe(beforeProbe + 1)
    const mutations = Array.from({ length: 2 }, () => f.transport.request("session.interrupt", { sessionID: "ses_a", timeoutMs: 0 }))
    expect(first.requests().slice(reads)).toEqual([expect.objectContaining({ operation: "session.interrupt", sessionID: "ses_a" })])
    f.advance(probe.pongTimeoutMs)
    expect(first.closes).toEqual([{ code: 4000, reason: "Relay heartbeat timed out" }])
    expect(f.transport.status().kind).toBe("reconnecting")
    expect(await mutations[0]).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    expect(await mutations[1]).toEqual({ status: "unavailable", reason: "not-connected" })
    f.advance(1)
    f.sockets[1]!.open()
    expect(f.transport.status().kind).toBe("open")
    expect(f.sockets[1]!.requests()).toEqual([])
  } finally { f.transport.close() }
})

test("any received frame satisfies the liveness probe and repeated return signals coalesce", () => {
  const f = transportFixture(probe)
  try {
    const first = f.sockets[0]!
    const beforeProbe = pings(first)
    first.holdMessages = true
    f.advance(probe.pingIntervalMs)
    expect(pings(first)).toBe(beforeProbe + 1)
    f.window.dispatchEvent(new Event("online"))
    f.document.change(false)
    expect(pings(first)).toBe(beforeProbe + 1)
    f.advance(9)
    first.holdMessages = false
    first.control({ case: "inventoryInvalidated", value: {} })
    f.advance(1)
    expect(first.closes).toEqual([])
    expect(f.transport.status().kind).toBe("open")
  } finally { f.transport.close() }
})

test("a hidden page gets a fresh response window on foreground and network return", () => {
  const f = transportFixture(probe)
  try {
    const first = f.sockets[0]!
    const beforeProbe = pings(first)
    first.holdMessages = true
    f.advance(probe.pingIntervalMs)
    expect(pings(first)).toBe(beforeProbe + 1)
    f.document.change(true)
    f.advance(1000)
    expect(first.closes).toEqual([])
    f.document.change(false)
    f.advance(9)
    expect(first.closes).toEqual([])
    f.window.dispatchEvent(new Event("online"))
    expect(pings(first)).toBe(beforeProbe + 1)
    f.advance(9)
    expect(first.closes).toEqual([])
    f.advance(1)
    expect(first.closes).toEqual([{ code: 4000, reason: "Relay heartbeat timed out" }])
  } finally { f.transport.close() }
})

test("retired socket callbacks cannot settle replacement requests or disturb its recovery", async () => {
  const f = transportFixture()
  try {
    const first = f.sockets[0]!
    const old = f.transport.request("session.list", { timeoutMs: 0 })
    let late: string | ArrayBuffer | undefined
    first.message = (data) => { late = data }
    first.result(first.dispatches[0]!, { data: { data: [], cursor: {} } })
    expect(late).toBeInstanceOf(ArrayBuffer)
    first.drop()
    expect(await old).toMatchObject({ status: "unknown" })
    f.advance(1)
    const replacement = f.sockets[1]!
    replacement.open()
    const result = f.transport.request("session.list", { timeoutMs: 0 })
    const statuses = [...f.statuses]
    first.callbacks.get("message")!(new MessageEvent("message", { data: late }))
    first.callbacks.get("close")!(Object.assign(new Event("close"), { code: 4401, reason: "old" }))
    first.callbacks.get("error")!(new Event("error"))
    first.callbacks.get("open")!(new Event("open"))
    expect(f.statuses).toEqual(statuses)
    expect(f.transport.status().kind).toBe("open")
    replacement.result(replacement.dispatches[0]!, { data: { data: [], cursor: {} } })
    expect(await result).toMatchObject({ status: "ok", value: { data: { data: [] } } })
  } finally { f.transport.close() }
})

test("close and terminal authorization stop liveness timers and return listeners", () => {
  for (const code of [1000, 4401, 4403]) {
    const f = transportFixture(probe)
    if (code === 1000) f.transport.close()
    else f.sockets[0]!.drop(code, "credential refused")
    const sent = f.sockets[0]!.sent.length
    f.window.dispatchEvent(new Event("online"))
    f.document.change(false)
    f.advance(1000)
    expect(f.sockets).toHaveLength(1)
    expect(f.sockets[0]!.sent).toHaveLength(sent)
    expect(f.tasks.filter((task) => !task.cancelled)).toEqual([])
    expect(f.document.listeners.size).toBe(0)
    expect(f.window.listeners.size).toBe(0)
    expect(f.transport.status()).toMatchObject({ kind: "closed", retryable: false })
    f.transport.close()
  }
})

test("foreground and network return coalesce an immediate retry while backing off", () => {
  const f = transportFixture()
  try {
    f.sockets[0]!.drop(1006, "network lost")
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
