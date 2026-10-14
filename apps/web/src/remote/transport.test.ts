import { expect, test } from "bun:test"
import { WireLimit, LedgerClass, create, ScopeSchema } from "@ycoding-ai/remote"
import { transportFixture, fillWindow, fixtureSnapshot, fixtureSourceEpoch } from "../../test/wire-peer"
import type { RemoteRequestTiming } from "./transport"

test("Ready, rather than native WebSocket open, establishes the binary runtime", () => {
  const f = transportFixture({ quiet: true })
  try {
    expect(f.transport.status().kind).toBe("connecting")
    expect(f.sockets[0]!.binaryType).toBe("arraybuffer")
  } finally {
    f.transport.close()
  }
})

test("canonical typed events are delivered as one ordered Session batch after snapshot hydration", async () => {
  const f = transportFixture()
  try {
    const subscribed = f.transport.request("event.subscribe", { sessionID: "ses_browser" })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { subscription_id: "sub-browser" })
    expect(await subscribed).toEqual({ status: "ok", value: { subscription_id: "sub-browser" } })
    const events = [0, 1, 2].map((ordinal) => ({
      id: `evt_${ordinal}`,
      created: 1,
      type: "session.text.delta",
      data: { sessionID: "ses_browser", assistantMessageID: "msg_browser", ordinal, delta: String(ordinal) },
    }))
    f.sockets[0]!.events("ses_browser", events)
    f.advance(50)
    expect(f.batches).toEqual([])
    const snapshot = f.transport.request("session.snapshot", { sessionID: "ses_browser", input: { limit: 100 } })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, fixtureSnapshot("ses_browser"))
    expect((await snapshot).status).toBe("ok")
    expect(f.batches).toEqual([{ sessionID: "ses_browser", events }])
    const released = f.transport.request("event.unsubscribe", {
      sessionID: "ses_browser",
      input: { subscription_id: "sub-browser" },
    })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { data: {} })
    expect((await released).status).toBe("ok")
    expect(f.sockets[0]!.failures).toEqual([])
  } finally {
    f.transport.close()
  }
})

for (const settlement of ["rejected", "timed-out", "cancelled"] as const)
  test(`a ${settlement} snapshot releases hydration without losing subsequent live events`, async () => {
    const f = transportFixture()
    try {
      const subscribed = f.transport.request("event.subscribe", { sessionID: "ses_browser" })
      f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { subscription_id: "sub-browser" })
      await subscribed
      const events = [
        {
          id: "evt_buffered",
          created: 1,
          type: "session.text.delta",
          data: { sessionID: "ses_browser", assistantMessageID: "msg_browser", ordinal: 0, delta: "buffered" },
        },
      ]
      f.sockets[0]!.events("ses_browser", events)
      f.advance(50)
      expect(f.batches).toEqual([])
      const controller = new AbortController()
      const snapshot = f.transport.request("session.snapshot", {
        sessionID: "ses_browser",
        input: { limit: 100 },
        timeoutMs: 10,
        signal: controller.signal,
      })
      if (settlement === "rejected")
        f.sockets[0]!.error(f.sockets[0]!.dispatches.at(-1)!, "ycoding.v5.InvalidRequestError", {
          _tag: "InvalidRequestError",
          message: "History rejected",
        })
      if (settlement === "timed-out") f.advance(11)
      if (settlement === "cancelled") controller.abort()
      expect((await snapshot).status).toBe(settlement === "rejected" ? "failed" : "unknown")
      expect(f.batches).toEqual([{ sessionID: "ses_browser", events }])
      const later = [{ ...events[0]!, id: "evt_later", data: { ...events[0]!.data, delta: "later" } }]
      f.sockets[0]!.events("ses_browser", later)
      f.advance(50)
      expect(f.batches).toEqual([
        { sessionID: "ses_browser", events },
        { sessionID: "ses_browser", events: later },
      ])
      expect(f.transport.status().kind).toBe("open")
      expect(f.sockets[0]!.failures).toEqual([])
    } finally {
      f.transport.close()
    }
  })

test("a successful resync snapshot clears invalidation without requesting another resync", async () => {
  let resyncs = 0
  const f = transportFixture({ handlers: { onSessions: () => resyncs++ } })
  try {
    const subscribed = f.transport.request("event.subscribe", { sessionID: "ses_browser" })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { subscription_id: "sub-browser" })
    await subscribed
    const initial = f.transport.request("session.snapshot", { sessionID: "ses_browser", input: { limit: 100 } })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, fixtureSnapshot("ses_browser"))
    await initial
    f.sockets[0]!.control({
      case: "resyncRequired",
      value: {
        scope: create(ScopeSchema, { target: { case: "session", value: "ses_browser" } }),
        sourceEpoch: fixtureSourceEpoch,
      },
    })
    expect(resyncs).toBe(1)
    const refreshed = f.transport.request("session.snapshot", { sessionID: "ses_browser", input: { limit: 100 } })
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, fixtureSnapshot("ses_browser"))
    expect((await refreshed).status).toBe("ok")
    expect(resyncs).toBe(1)
    expect(f.transport.status().kind).toBe("open")
  } finally {
    f.transport.close()
  }
})

test("JSON runtime frames close the binary connection rather than becoming successful observations", () => {
  const f = transportFixture()
  try {
    f.sockets[0]!.message('{"type":"event","sessionID":"ses_browser"}')
    expect(f.sockets[0]!.closes.at(-1)?.code).toBe(1002)
    expect(f.batches).toEqual([])
  } finally {
    f.transport.close()
  }
})

test("aborting a queued-unsent request removes it without sending or inventing settlement time", async () => {
  const timings: RemoteRequestTiming[] = []
  const f = transportFixture({ handlers: { onRequestTiming: (timing) => timings.push(timing) } })
  try {
    await fillWindow(f, WireLimit.CLIENT_RATE - 4)
    timings.length = 0
    const before = f.sockets[0]!.requests().length
    const controller = new AbortController()
    const queued = f.transport.request("session.list", { timeoutMs: 0, signal: controller.signal })
    f.advance(7)
    controller.abort()
    expect(await queued).toEqual({ status: "unavailable", reason: "cancelled" })
    expect(timings).toEqual([
      { operation: "session.list", outcome: "unavailable", reason: "cancelled", queueMs: 7, totalMs: 7 },
    ])
    f.advance(WireLimit.RATE_WINDOW_MS)
    expect(f.sockets[0]!.requests()).toHaveLength(before)
    expect(timings).toHaveLength(1)
  } finally {
    f.transport.close()
  }
})

test("paced queue time is distinct from response settlement and contains no request or result payload", async () => {
  const timings: RemoteRequestTiming[] = []
  const f = transportFixture({ handlers: { onRequestTiming: (timing) => timings.push(timing) } })
  try {
    await fillWindow(f, WireLimit.CLIENT_RATE - 4)
    timings.length = 0
    f.advance(25)
    const request = f.transport.request("session.list", { input: { search: "private query" }, timeoutMs: 0 })
    f.advance(WireLimit.RATE_WINDOW_MS - 25)
    f.advance(17)
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { data: { data: [], cursor: {} } })
    expect((await request).status).toBe("ok")
    expect(timings).toEqual([
      {
        operation: "session.list",
        outcome: "ok",
        queueMs: WireLimit.RATE_WINDOW_MS - 25,
        settlementMs: 17,
        totalMs: WireLimit.RATE_WINDOW_MS - 8,
      },
    ])
    expect(JSON.stringify(timings)).not.toMatch(/private|query|response/)
  } finally {
    f.transport.close()
  }
})

test("a timeout cancels one transmitted mutation as unknown and reconnect never replays it", async () => {
  const timings: RemoteRequestTiming[] = []
  const f = transportFixture({ handlers: { onRequestTiming: (timing) => timings.push(timing) } })
  try {
    const request = f.transport.request("session.interrupt", { sessionID: "ses_browser", timeoutMs: 35 })
    f.advance(35)
    expect(await request).toMatchObject({ status: "unknown", error: { code: "outcome_unknown" } })
    expect(
      f.sockets[0]!.sent.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "cancel"),
    ).toHaveLength(1)
    expect(timings).toEqual([
      { operation: "session.interrupt", outcome: "unknown", queueMs: 0, settlementMs: 35, totalMs: 35 },
    ])
    f.sockets[0]!.drop()
    f.advance(1)
    f.sockets[1]!.open()
    expect(f.sockets[1]!.requests()).toEqual([])
  } finally {
    f.transport.close()
  }
})

test("closing distinguishes transmitted and queued-unsent requests and clears both before replacement", async () => {
  const f = transportFixture()
  try {
    await fillWindow(f, WireLimit.CLIENT_RATE - 5)
    const transmitted = f.transport.request("session.interrupt", { sessionID: "ses_browser", timeoutMs: 0 })
    const queued = f.transport.request("session.interrupt", { sessionID: "ses_browser", timeoutMs: 0 })
    f.transport.close()
    expect((await transmitted).status).toBe("unknown")
    expect(await queued).toEqual({ status: "unavailable", reason: "not-connected" })
    f.transport.connect()
    f.sockets[1]!.open()
    f.advance(WireLimit.RATE_WINDOW_MS)
    expect(f.sockets[1]!.requests()).toEqual([])
  } finally {
    f.transport.close()
  }
})

test("timing observers cannot turn a successful response into a protocol failure", async () => {
  const f = transportFixture({
    handlers: {
      onRequestTiming: () => {
        throw new Error("diagnostics failure")
      },
    },
  })
  try {
    const request = f.transport.request("session.list")
    f.sockets[0]!.result(f.sockets[0]!.dispatches.at(-1)!, { data: { data: [], cursor: {} } })
    expect((await request).status).toBe("ok")
    expect(f.transport.status().kind).toBe("open")
  } finally {
    f.transport.close()
  }
})

test("a transmitted abort remains unknown, sends an eligible Tiny cancel and drops its late result", async () => {
  const f = transportFixture()
  try {
    const controller = new AbortController()
    const request = f.transport.request("session.interrupt", {
      sessionID: "ses_browser",
      signal: controller.signal,
      timeoutMs: 0,
    })
    const original = f.sockets[0]!.dispatches.at(-1)!
    await fillWindow(f, WireLimit.CLIENT_RATE - 5)
    f.sockets[0]!.holdMessages = true
    f.sockets[0]!.result(original, { data: {} })
    controller.abort()
    expect((await request).status).toBe("unknown")
    const cancel = f.sockets[0]!.sent.find(
      (frame) => frame.body.case === "control" && frame.body.value.kind.case === "cancel",
    )
    expect(cancel?.ledger).toBe(LedgerClass.TINY)
    expect(f.sockets[0]!.requests().filter((request) => request.operation === "session.interrupt")).toHaveLength(1)
    f.sockets[0]!.releaseMessages()
    expect(f.transport.status().kind).toBe("open")
  } finally {
    f.transport.close()
  }
})

test("pre-aborted and disconnected requests report no wire time and never send", async () => {
  const timings: RemoteRequestTiming[] = []
  const f = transportFixture({ handlers: { onRequestTiming: (timing) => timings.push(timing) } })
  try {
    expect(await f.transport.request("session.list", { signal: AbortSignal.abort() })).toEqual({
      status: "unavailable",
      reason: "cancelled",
    })
    f.transport.close()
    expect(await f.transport.request("session.list")).toEqual({ status: "unavailable", reason: "not-connected" })
    expect(timings).toEqual([
      { operation: "session.list", outcome: "unavailable", reason: "cancelled", queueMs: 0, totalMs: 0 },
      { operation: "session.list", outcome: "unavailable", reason: "not-connected", queueMs: 0, totalMs: 0 },
    ])
  } finally {
    f.transport.close()
  }
})

test("priority is socket-owned, deduplicated and resent after a hidden reconnect", () => {
  const f = transportFixture()
  const priorities = (index: number) =>
    f.sockets[index]!.sent.filter((frame) => frame.body.case === "control" && frame.body.value.kind.case === "priority")
  try {
    f.document.change(true)
    f.document.change(true)
    f.transport.setPriority("background")
    expect(priorities(0)).toHaveLength(2)
    f.document.change(false)
    expect(priorities(0)).toHaveLength(3)
    f.document.change(true)
    f.sockets[0]!.drop()
    f.advance(1)
    f.sockets[1]!.open()
    expect(priorities(1)).toHaveLength(1)
    const resumed = priorities(1)[0]!.body
    expect(resumed.case === "control" && resumed.value.kind.case === "priority" && resumed.value.kind.value.mode).toBe(
      2,
    )
  } finally {
    f.transport.close()
  }
})

test("a socket asset preserves the complete raw body and releases transferred consumer ownership", async () => {
  const f = transportFixture()
  try {
    const request = f.transport.request("session.attachment.read", {
      sessionID: "ses_browser",
      input: { digest: "a".repeat(64) },
    })
    const bytes = new Uint8Array(65537).fill(213)
    f.sockets[0]!.asset(f.sockets[0]!.dispatches.at(-1)!, bytes)
    const outcome = await request
    expect(outcome.status).toBe("ok")
    if (outcome.status !== "ok") throw new Error("Asset was not delivered")
    const asset = outcome.value as { data: Uint8Array; mime: string; release(): void }
    expect(asset.data).toEqual(bytes)
    expect(asset.mime).toBe("image/png")
    asset.release()
    asset.release()
    expect(f.sockets[0]!.failures).toEqual([])
  } finally {
    f.transport.close()
  }
})
