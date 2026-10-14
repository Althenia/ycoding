import { expect, test } from "bun:test"
import { WireLimit } from "@ycoding-ai/remote"
import { transportFixture } from "../../test/wire-peer"

test.each([false, true])(
  "an unresponsive upgrade or Ready handshake expires without waiting for a native close (%s)",
  (open) => {
    const f = transportFixture({ open, quiet: true })
    try {
      f.advance(WireLimit.HANDSHAKE_TIMEOUT_MS)
      expect(f.transport.status().kind).toBe("reconnecting")
      expect(f.sockets[0]!.closes.at(-1)?.code).toBe(1008)
      f.advance(1)
      f.sockets[1]!.quiet = false
      f.sockets[1]!.open()
      expect(f.transport.status().kind).toBe("open")
    } finally {
      f.transport.close()
    }
  },
)

test("a silent open socket expires its heartbeat without replaying a transmitted mutation", async () => {
  const f = transportFixture({ pingIntervalMs: 50, pongTimeoutMs: 10 })
  try {
    f.sockets[0]!.quiet = true
    const request = f.transport.request("session.interrupt", { sessionID: "ses_browser", timeoutMs: 0 })
    f.advance(60)
    expect((await request).status).toBe("unknown")
    expect(f.sockets[0]!.closes.at(-1)).toEqual({ code: 4000, reason: "Relay heartbeat timed out" })
    f.advance(1)
    f.sockets[1]!.open()
    expect(f.sockets[1]!.requests()).toEqual([])
  } finally {
    f.transport.close()
  }
})

test("a hidden page pauses the probe deadline and foreground resumes a fresh response window", () => {
  const f = transportFixture({ pingIntervalMs: 50, pongTimeoutMs: 10 })
  try {
    f.sockets[0]!.quiet = true
    f.advance(50)
    f.document.change(true)
    f.advance(100)
    expect(f.sockets[0]!.closes).toEqual([])
    f.document.change(false)
    f.advance(9)
    expect(f.sockets[0]!.closes).toEqual([])
    f.advance(1)
    expect(f.sockets[0]!.closes.at(-1)?.code).toBe(4000)
  } finally {
    f.transport.close()
  }
})

test("retired native callbacks cannot settle replacement requests or disturb their owner", async () => {
  const f = transportFixture()
  try {
    const first = f.sockets[0]!
    f.transport.close()
    f.transport.connect()
    f.sockets[1]!.open()
    const request = f.transport.request("session.list", { timeoutMs: 0 })
    const statuses = [...f.statuses]
    first.callbacks.get("message")!(new MessageEvent("message", { data: "late" }))
    first.callbacks.get("close")!(Object.assign(new Event("close"), { code: 4401, reason: "old credential" }))
    first.callbacks.get("error")!(new Event("error"))
    first.callbacks.get("open")!(new Event("open"))
    expect(f.statuses).toEqual(statuses)
    f.sockets[1]!.result(f.sockets[1]!.dispatches.at(-1)!, { data: { data: [], cursor: {} } })
    expect((await request).status).toBe("ok")
  } finally {
    f.transport.close()
  }
})

test.each([1000, 4401, 4403])("explicit close and credential rejection release timers and listeners (%s)", (code) => {
  const f = transportFixture()
  if (code === 1000) f.transport.close()
  else f.sockets[0]!.drop(code, "credential refused")
  f.window.dispatchEvent(new Event("online"))
  f.document.change(false)
  f.advance(1000)
  expect(f.sockets).toHaveLength(1)
  expect(f.tasks.filter((task) => !task.cancelled)).toEqual([])
  expect(f.document.listeners.size).toBe(0)
  expect(f.window.listeners.size).toBe(0)
})

test("foreground and network return coalesce a single immediate retry during backoff", () => {
  const f = transportFixture({ resetDelayMs: 1000 })
  try {
    f.sockets[0]!.drop()
    f.document.change(false)
    f.window.dispatchEvent(new Event("online"))
    expect(f.sockets).toHaveLength(2)
    f.sockets[1]!.open()
    f.advance(1000)
    expect(f.sockets).toHaveLength(2)
    expect(f.transport.status().kind).toBe("open")
  } finally {
    f.transport.close()
  }
})
