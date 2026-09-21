import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, readSessionInfo, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { createSessionView, readSnapshot, type SessionView } from "../src/remote/projection"
import { applySessionEvent } from "../src/remote/projection"
import { startRelayDouble, waitFor, type RelayDouble, type RelayHandlerResult } from "./relay-double"

/** `Model.Ref` from packages/schema: `{ id, providerID, variant? }`, never a plain string. */
const model = { id: "gpt-6", providerID: "openai" } as const
const variantModel = { id: "gpt-6", providerID: "openai", variant: "high" } as const

/** Reads a snapshot or fails the test when the body is not a projection. */
function snapshotOf(payload: unknown) {
  const snapshot = readSnapshot(payload)
  if (snapshot === undefined) throw new Error("expected a session projection")
  return snapshot
}

const textOf = (view: SessionView | undefined) =>
  (view?.messages ?? []).flatMap((message) =>
    message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
  )

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  readonly flush: () => Promise<void>
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

async function harness(options: {
  snapshot?: (sessionID: string) => unknown
  handler?: (request: { operation: string; input?: Readonly<Record<string, unknown>>; sessionID?: string }) => RelayHandlerResult
  messages?: Record<string, readonly unknown[]>
  activeSessions?: Record<string, { type: "running" }>
} = {}): Promise<Harness> {
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a"],
    activeSessions: options.activeSessions,
    snapshot: options.snapshot,
    handler: options.handler,
    messages: options.messages,
  })
  const timers: (() => void)[] = []
  const schedule = (callback: () => void, ms = 0) => {
    if (ms >= 1_000) return () => {}
    timers.push(callback)
    return () => {
      const index = timers.indexOf(callback)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const flush = async () => {
    await Bun.sleep(15)
    for (const callback of timers.splice(0)) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule }),
    schedule,
    batchMs: 20,
    now: () => 1_000,
    createMessageID: () => "msg_local_1",
  })
  const runUntil = async (predicate: () => boolean, attempts = 100) => {
    for (let index = 0; index < attempts && !predicate(); index += 1) {
      await flush()
      await Bun.sleep(5)
    }
    if (!predicate()) throw new Error("runUntil did not settle")
  }
  return { store, relay, flush, runUntil, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("model references", () => {
  test("reads Model.Ref from a snapshot instead of dropping it", () => {
    const snapshot = snapshotOf({
      sourceEpoch: "epoch_1",
      session: { id: "ses_a", title: "t", agent: "god", model: variantModel, time: { created: 1, updated: 2 } },
      messages: [],
      watermark: { type: "log.synced", aggregateID: "ses_a", seq: 3 },
    })
    expect(snapshot.model).toEqual({ id: "gpt-6", providerID: "openai", variant: "high" })
  })

  test("reads Model.Ref from the session list", () => {
    const info = readSessionInfo({ id: "ses_a", title: "t", model, time: { created: 1, updated: 2 } })
    expect(info?.model).toEqual({ id: "gpt-6", providerID: "openai" })
  })

  test("applies Model.Ref from model selection and step start", () => {
    let view = createSessionView("ses_a")
    view = applySessionEvent(view, { type: "session.model.selected", data: { model } }, 1)
    expect(view.model).toEqual({ id: "gpt-6", providerID: "openai" })

    view = applySessionEvent(
      view,
      { type: "session.step.started", data: { assistantMessageID: "msg_a", agent: "god", model: variantModel } },
      2,
    )
    const assistant = view.messages.find((message) => message.kind === "assistant")
    expect(assistant).toMatchObject({ kind: "assistant", agent: "god", model: { id: "gpt-6", providerID: "openai", variant: "high" } })
  })

  test("keeps the assistant model from a snapshot message", () => {
    const snapshot = snapshotOf({
      sourceEpoch: "epoch_1",
      session: { title: "t" },
      messages: [{ id: "msg_a", type: "assistant", agent: "god", model, content: [{ type: "text", text: "hi" }], time: { created: 1 } }],
      watermark: { type: "log.synced", aggregateID: "ses_a", seq: 1 },
    })
    expect(snapshot.messages[0]).toMatchObject({ kind: "assistant", model: { id: "gpt-6", providerID: "openai" } })
  })

  test("never accepts a plain string model reference", () => {
    const snapshot = snapshotOf({
      session: { title: "t", model: "openai/gpt-6" },
      messages: [],
      watermark: { type: "log.synced", aggregateID: "ses_a", seq: 1 },
    })
    expect(snapshot.model).toBeUndefined()
    expect(readSessionInfo({ id: "ses_a", title: "t", model: "openai/gpt-6" })?.model).toBeUndefined()
  })
})

describe("snapshot synchronization", () => {
  test("rejects a body that is not a session projection", () => {
    expect(readSnapshot({ data: [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }] })).toBeUndefined()
    expect(readSnapshot(undefined)).toBeUndefined()
    expect(readSnapshot({ messages: [], session: {}, watermark: { type: "log.synced", aggregateID: "ses_a", seq: 4 } })).toMatchObject({
      messages: [],
      watermark: 4,
    })
  })

  test("keeps the projection and reports when the snapshot read fails", async () => {
    let fail = false
    const test = await harness({
      messages: { ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: (request) => (request.operation === "session.snapshot" && fail ? { ok: false, code: "internal_error", message: "boom" } : "default"),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])
      fail = true
      await test.store.reloadMessages()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])
      expect(test.store.state().notice).toContain("boom")
    } finally {
      await test.stop()
    }
  })

  test("ignores a stale snapshot below the applied watermark", async () => {
    let watermark = 10
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages: [{ id: "msg_live", type: "assistant", agent: "god", content: [{ type: "text", text: "LIVE" }], time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: watermark },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.watermark).toBe(10)

      watermark = 4
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_live", ordinal: 0, delta: "!" },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      await test.store.reloadMessages()
      expect(test.store.state().view?.watermark).toBeGreaterThanOrEqual(11)
      expect(textOf(test.store.state().view).join("")).toContain("LIVE")
    } finally {
      await test.stop()
    }
  })

  test("fences durable sequence per session aggregate and ignores other aggregates", async () => {
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages: [{ id: "msg_live", type: "assistant", agent: "god", content: [{ type: "text", text: "BASE" }], time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 10 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // Another session's aggregate must not advance or pollute this projection.
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_other", ordinal: 0, delta: "FOREIGN" },
        durable: { aggregateID: "ses_other", seq: 99, version: 1 },
        sourceEpoch: "epoch_1",
      })
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_dup", ordinal: 0, delta: "DUPLICATE" },
        durable: { aggregateID: "ses_a", seq: 10, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["BASE"])
      expect(test.store.state().view?.watermark).toBe(10)

      // A new process epoch does not reset the durable per-aggregate sequence.
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_new", ordinal: 0, delta: "NEXT-EPOCH" },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_2",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toContain("NEXT-EPOCH")
      expect(test.store.state().view?.watermark).toBe(11)

      // A gap means a durable event was missed, so the canonical snapshot is re-read.
      const before = test.relay.requests.filter((request) => request.operation === "session.snapshot").length
      test.relay.pushEvent("ses_a", {
        type: "session.execution.started",
        data: {},
        durable: { aggregateID: "ses_a", seq: 13, version: 1 },
        sourceEpoch: "epoch_2",
      })
      await test.flush()
      await test.runUntil(() => test.relay.requests.filter((request) => request.operation === "session.snapshot").length > before)
      expect(test.store.state().notice).toContain("missed")
    } finally {
      await test.stop()
    }
  })

  test("drops an ephemeral delta that the snapshot already covers", async () => {
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages: [{ id: "msg_a", type: "assistant", agent: "god", content: [{ type: "text", text: "HELLO" }], time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 10 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(textOf(test.store.state().view)).toEqual(["HELLO"])

      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: " WORLD" },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["HELLO"])

      // A durable text boundary opens the next stream, so later deltas append again.
      test.relay.pushEvent("ses_a", {
        type: "session.text.started",
        data: { assistantMessageID: "msg_b", ordinal: 0 },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_b", ordinal: 0, delta: "STREAMED" },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toContain("STREAMED")
    } finally {
      await test.stop()
    }
  })

  test("keeps deltas received while a snapshot is in flight", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.snapshot") await gate
        return "default" as const
      },
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages: [{ id: "msg_a", type: "assistant", agent: "god", content: [], time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 11 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      const selection = test.store.selectSession("ses_a")
      await Bun.sleep(5)
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: "STREAMED" },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["STREAMED"])
      release?.()
      await selection
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["STREAMED"])
    } finally {
      await test.stop()
    }
  })
})

describe("session state reads", () => {
  test("derives consumed user state from the projected timestamp", () => {
    const snapshot = snapshotOf({
      session: { title: "t" },
      messages: [
        { id: "msg_1", type: "user", text: "sent", time: { created: 1 } },
        { id: "msg_2", type: "user", text: "answered", time: { created: 2, consumed: 3 } },
      ],
      watermark: { type: "log.synced", aggregateID: "ses_a", seq: 2 },
    })
    expect(snapshot.messages[0]).toMatchObject({ kind: "user", state: "promoted" })
    expect(snapshot.messages[1]).toMatchObject({ kind: "user", state: "consumed" })
    // The projection carries no delivery mode, so none is invented.
    expect((snapshot.messages[0] as { delivery?: string }).delivery).toBeUndefined()
  })

  test("reports running sessions from the authoritative active read", async () => {
    const test = await harness({ activeSessions: { ses_a: { type: "running" } } })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      expect(test.relay.requests.some((request) => String(request.operation) === "session.active")).toBe(true)
      expect(test.store.state().sessions[0]?.running).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("leaves running unknown when the relay does not report it", async () => {
    const test = await harness({
      handler: (request) =>
        String(request.operation) === "session.active" ? { ok: false, code: "unknown_operation", message: "unsupported" } : "default",
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      expect(test.store.state().sessions[0]?.running).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("applies live status events and ignores todo updates without noise", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      test.relay.pushEvent("ses_a", { type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } })
      await test.flush()
      expect(test.store.state().view?.status).toBe("running")

      test.relay.pushEvent("ses_a", {
        type: "session.status",
        data: { sessionID: "ses_a", status: { type: "retry", attempt: 2, message: "rate limited", next: 5_000 } },
      })
      await test.flush()
      expect(test.store.state().view?.retry).toMatchObject({ attempt: 2, code: "rate limited" })

      test.relay.pushEvent("ses_a", { type: "session.idle", data: { sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view?.status).toBe("idle")

      test.relay.pushEvent("ses_a", {
        type: "todo.updated",
        data: { sessionID: "ses_a", todos: [{ content: "ship it", status: "pending", priority: "high" }] },
      })
      await test.flush()
      expect(test.store.state().unhandledEvents).toBe(0)
      expect(test.store.state().view?.unhandledEvents).toBe(0)
    } finally {
      await test.stop()
    }
  })
})
