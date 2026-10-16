import { describe, expect, test } from "bun:test"
import { remotePayloadCodecs } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, readSessionInfo, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { createSessionView, readSnapshot, type SessionView } from "../src/remote/projection"
import { applySessionEvent } from "../src/remote/projection"
import { startRelayDouble, waitFor, type RelayDouble, type RelayHandlerResult } from "./relay-double"
import { fixtureSnapshot } from "./wire-peer"
import { writeWireMessage } from "../src/remote/wire"

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
  readonly eventCount: () => number
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

async function harness(
  options: {
    snapshot?: (sessionID: string) => unknown
    handler?: (request: {
      operation: string
      input?: Readonly<Record<string, unknown>>
      sessionID?: string
    }) => RelayHandlerResult
    messages?: Record<string, readonly unknown[]>
    activeSessions?: Record<string, { type: "running" }>
  } = {},
): Promise<Harness> {
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a"],
    activeSessions: options.activeSessions,
    snapshot: options.snapshot,
    handler: options.handler,
    messages: options.messages,
  })
  const timers: (() => void)[] = []
  let eventCount = 0
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
      createRemoteTransport({
        url: relay.wsURL(deviceID),
        handlers: {
          ...handlers,
          onEvents: (sessionID, events) => {
            eventCount += events.length
            handlers.onEvents?.(sessionID, events)
          },
        },
        resetDelayMs: 10,
        maxDelayMs: 20,
        schedule,
      }),
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
  return {
    store,
    relay,
    flush,
    eventCount: () => eventCount,
    runUntil,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

describe("windowed history", () => {
  const message = (id: string) => ({ id, type: "user", text: id, time: { created: Number(id.slice(-1)) } })
  const page = (sessionID: string, messages: readonly unknown[], before?: string, seq = 8) => ({
    sourceEpoch: "epoch_1",
    session: { id: sessionID, title: "Window" },
    messages,
    watermark: { type: "log.synced", aggregateID: sessionID, seq },
    ...(before === undefined ? {} : { before }),
  })

  test("reads the newest window and prepends older pages without changing the live watermark", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.snapshot"
          ? {
              ok: true,
              value:
                request.input?.before === "older"
                  ? page("ses_a", [message("msg_1")], undefined, 3)
                  : page("ses_a", [message("msg_2"), message("msg_3")], "older"),
            }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.relay.requests.find((request) => request.operation === "session.snapshot")?.input).toEqual({
        limit: 100,
      })
      expect(test.store.state().view?.messages.map((entry) => entry.id)).toEqual(["msg_2", "msg_3"])
      expect(test.store.state().history).toEqual({ status: "idle", before: "older" })
      await test.store.loadOlderMessages()
      expect(test.relay.requests.findLast((request) => request.operation === "session.snapshot")?.input).toEqual({
        limit: 100,
        before: "older",
      })
      expect(test.store.state().view?.messages.map((entry) => entry.id)).toEqual(["msg_1", "msg_2", "msg_3"])
      expect(test.store.state().view?.watermark).toBe(8)
      expect(test.store.state().history).toEqual({ status: "idle" })
      await test.store.loadOlderMessages()
      expect(test.relay.requests.filter((request) => request.operation === "session.snapshot")).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("hydrates a durable queued prompt and replaces it once after promotion", async () => {
    const pending = {
      id: "msg_queued",
      sessionID: "ses_a",
      admittedSeq: 2,
      timeCreated: 2,
      type: "user",
      data: { text: "Continue after this", files: [] },
      delivery: "queue",
    }
    let admitted = true
    let promoted = false
    const test = await harness({
      handler: (request) => {
        if (request.operation === "session.snapshot")
          return {
            ok: true,
            value: page(
              "ses_a",
              promoted ? [{ id: pending.id, type: "user", text: pending.data.text, time: { created: 2 } }] : [],
              undefined,
              promoted ? 3 : 2,
            ),
          }
        if (request.operation === "session.pending.list")
          return { ok: true, value: { data: admitted ? [pending] : [] } }
        return "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages).toMatchObject([
        { kind: "user", id: pending.id, text: pending.data.text, state: "pending", delivery: "queue" },
      ])
      admitted = false
      promoted = true
      test.relay.pushEvent("ses_a", {
        type: "session.input.promoted",
        data: { sessionID: "ses_a", inputID: pending.id },
        durable: { aggregateID: "ses_a", seq: 3, version: 1 },
      })
      await test.runUntil(() => {
        const message = test.store.state().view?.messages[0]
        return message?.kind === "user" && message.state === "promoted"
      })
      await test.store.reloadMessages()
      expect(test.store.state().view?.messages.filter((entry) => entry.id === pending.id)).toHaveLength(1)
      expect(test.store.state().view?.messages[0]).toMatchObject({ kind: "user", state: "promoted" })
    } finally {
      await test.stop()
    }
  })

  test("a pending read started before promotion cannot resurrect its consumed row", async () => {
    const gate = Promise.withResolvers<void>()
    const pending = {
      id: "msg_wait",
      sessionID: "ses_a",
      admittedSeq: 2,
      timeCreated: 2,
      type: "user",
      data: { text: "Wait here" },
      delivery: "steer",
    }
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.snapshot") return { ok: true, value: page("ses_a", [], undefined, 2) }
        if (request.operation === "session.pending.list") {
          await gate.promise
          return { ok: true, value: { data: [pending] } }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      const selecting = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.pending.list"))
      test.relay.pushEvent("ses_a", {
        type: "session.input.promoted",
        data: { sessionID: "ses_a", inputID: pending.id },
        durable: { aggregateID: "ses_a", seq: 3, version: 1 },
      })
      await test.runUntil(() => test.store.state().view?.watermark === 3)
      gate.resolve()
      await selecting
      expect(
        test.store
          .state()
          .view?.messages.some(
            (entry) => entry.id === pending.id && entry.kind === "user" && entry.state === "pending",
          ),
      ).toBe(false)
    } finally {
      gate.resolve()
      await test.stop()
    }
  })

  test("refuses a pending row attributed to another Session", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.pending.list"
          ? {
              ok: true,
              value: {
                data: [
                  {
                    id: "msg_foreign",
                    sessionID: "ses_b",
                    admittedSeq: 1,
                    timeCreated: 2,
                    type: "user",
                    data: { text: "Private work" },
                    delivery: "steer",
                  },
                ],
              },
            }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages.some((entry) => entry.id === "msg_foreign")).toBe(false)
    } finally {
      await test.stop()
    }
  })

  test("reports a typed pending-read rejection without promoting or replaying any input", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.pending.list"
          ? { ok: false, code: "invalid_message", message: "Pending read rejected" }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().notice).toContain("Pending read rejected")
      expect(test.store.state().view?.messages).toEqual([])
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("a machine inventory invalidation rehydrates missed promoted history and pending inputs", async () => {
    let promoted = false
    const test = await harness({
      handler: (request) => {
        if (request.operation === "session.log")
          return {
            ok: true,
            value: {
              data: promoted
                ? [
                    {
                      type: "session.renamed",
                      durable: { aggregateID: "ses_a", seq: 4, version: 1 },
                      data: { sessionID: "ses_a", title: "Promoted" },
                    },
                  ]
                : [],
            },
          }
        if (request.operation === "session.snapshot")
          return { ok: true, value: page("ses_a", promoted ? [message("msg_9")] : [], undefined, promoted ? 4 : 1) }
        if (request.operation === "session.pending.list")
          return {
            ok: true,
            value: {
              data: promoted
                ? []
                : [
                    {
                      id: "msg_8",
                      sessionID: "ses_a",
                      admittedSeq: 2,
                      timeCreated: 2,
                      type: "user",
                      data: { text: "Queued" },
                      delivery: "queue",
                    },
                  ],
            },
          }
        return "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      promoted = true
      test.relay.pushSessions(["ses_a"])
      await test.runUntil(() => test.store.state().view?.messages.some((entry) => entry.id === "msg_9") === true)
      expect(test.store.state().view?.messages.some((entry) => entry.id === "msg_8")).toBe(false)
      expect(
        test.relay.requests.filter((request) => request.operation === "session.pending.list").length,
      ).toBeGreaterThanOrEqual(2)
      expect(
        test.relay.requests.filter((request) => request.operation === "session.todo.list").length,
      ).toBeGreaterThanOrEqual(2)
    } finally {
      await test.stop()
    }
  })

  test("a gap during a machine resync schedules a second authoritative window", async () => {
    const gate = Promise.withResolvers<void>()
    let snapshots = 0
    let advanced = false
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.log")
          return {
            ok: true,
            value: {
              data: advanced
                ? [
                    {
                      type: "session.renamed",
                      durable: { aggregateID: "ses_a", seq: 2, version: 1 },
                      data: { sessionID: "ses_a", title: "Changed" },
                    },
                  ]
                : [],
            },
          }
        if (request.operation === "session.snapshot") {
          snapshots += 1
          if (snapshots === 2) await gate.promise
          return {
            ok: true,
            value: page("ses_a", snapshots >= 3 ? [message("msg_9")] : [], undefined, snapshots >= 3 ? 4 : 1),
          }
        }
        if (request.operation === "session.pending.list") return { ok: true, value: { data: [] } }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      advanced = true
      test.relay.pushSessions(["ses_a"])
      await waitFor(() => snapshots === 2)
      test.relay.pushEvent("ses_a", {
        type: "session.execution.started",
        data: { sessionID: "ses_a" },
        durable: { aggregateID: "ses_a", seq: 4, version: 1 },
      })
      await test.flush()
      gate.resolve()
      await test.runUntil(() => test.store.state().view?.messages.some((entry) => entry.id === "msg_9") === true)
      expect(snapshots).toBeGreaterThanOrEqual(3)
    } finally {
      gate.resolve()
      await test.stop()
    }
  })

  test("rejects malformed binary first-window delivery and requires its durable watermark", async () => {
    const codec = remotePayloadCodecs.get("session.snapshot")!
    expect(() =>
      writeWireMessage(codec.result.schema, {
        data: Object.fromEntries(Object.entries(fixtureSnapshot("ses_a").data).filter(([key]) => key !== "watermark")),
      }),
    ).toThrow("SessionProjection.watermark")
    const test = await harness({
      handler: (request) =>
        request.operation === "session.snapshot"
          ? { wire: (peer, dispatch) => peer.malformedResult(dispatch, Uint8Array.of(10, 0)) }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages).toEqual([])
      expect(test.store.state().lastRelayDrop).toMatchObject({ code: 1002 })
      expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("merges a gap refresh by ID while retaining loaded older messages", async () => {
    let latest = message("msg_3")
    const test = await harness({
      handler: (request) =>
        request.operation === "session.snapshot"
          ? {
              ok: true,
              value:
                request.input?.before === "older"
                  ? page("ses_a", [message("msg_1")], undefined, 3)
                  : page("ses_a", [message("msg_2"), latest], "older", latest.text === "changed" ? 12 : 8),
            }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.loadOlderMessages()
      latest = { ...latest, text: "changed" }
      test.relay.pushEvent("ses_a", {
        type: "session.execution.started",
        data: {},
        durable: { aggregateID: "ses_a", seq: 12, version: 1 },
      })
      await test.runUntil(
        () =>
          test.store
            .state()
            .view?.messages.some(
              (entry) => entry.id === "msg_3" && entry.kind === "user" && entry.text === "changed",
            ) === true,
      )
      expect(test.store.state().view?.messages.map((entry) => entry.id)).toEqual(["msg_1", "msg_2", "msg_3"])
      expect(test.store.state().view?.watermark).toBe(12)
    } finally {
      await test.stop()
    }
  })

  test("does not revive an older assistant pruned by a reconciled compaction", async () => {
    let compacted = false
    const old = {
      id: "msg_old",
      type: "assistant",
      agent: "god",
      content: [{ type: "text", text: "Old answer" }],
      time: { created: 1 },
    }
    const fresh = {
      id: "msg_fresh",
      type: "assistant",
      agent: "god",
      content: [{ type: "text", text: "Current answer" }],
      time: { created: 3 },
    }
    const test = await harness({
      handler: (request) =>
        request.operation === "session.snapshot"
          ? {
              ok: true,
              value: page(
                "ses_a",
                request.input?.before === "older"
                  ? [old]
                  : compacted
                    ? [
                        {
                          id: "msg_compact",
                          type: "compaction",
                          jobID: "cmp_1",
                          trigger: "manual",
                          status: "completed",
                          revision: 1,
                          metrics: { excludedMessages: 1, excludedParts: 1, inputTokens: 100, retainedTokens: 40 },
                          boundary: { messageID: "msg_old", seq: 1 },
                          time: { created: 2 },
                        },
                        fresh,
                      ]
                    : [fresh],
                request.input?.before === "older" || compacted ? undefined : "older",
                compacted ? 9 : 5,
              ),
            }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.loadOlderMessages()
      expect(test.store.state().view?.messages.some((message) => message.id === "msg_old")).toBe(true)
      compacted = true
      await test.store.reloadMessages()
      expect(test.store.state().view?.messages.some((message) => message.id === "msg_old")).toBe(false)
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_old", ordinal: 0, delta: "LATE" },
      })
      await test.flush()
      expect(test.store.state().view?.messages.some((message) => message.id === "msg_old")).toBe(false)
    } finally {
      await test.stop()
    }
  })

  test("reports rejected history pages without retrying another request shape", async () => {
    let rejected = false
    const test = await harness({
      handler: (request) =>
        request.operation === "session.snapshot"
          ? request.input?.before === "older" || rejected
            ? { ok: false, code: "invalid_message", message: "Window rejected" }
            : { ok: true, value: page("ses_a", [message("msg_2")], "older") }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.loadOlderMessages()
      expect(test.store.state().history).toMatchObject({
        status: "error",
        before: "older",
        error: expect.stringContaining("Window rejected"),
      })
      expect(test.store.state().view?.messages.map((entry) => entry.id)).toEqual(["msg_2"])
      rejected = true
      await test.store.reloadMessages()
      expect(test.store.state().notice).toContain("Window rejected")
      expect(
        test.relay.requests
          .filter((request) => request.operation === "session.snapshot")
          .every((request) => request.input?.limit === 100),
      ).toBe(true)
    } finally {
      await test.stop()
    }
  })
})

describe("binary transcript delivery", () => {
  test("a complete typed bulk snapshot reaches the transcript without a separate content read", async () => {
    const text = "日本語 🌍 binary transcript\n".repeat(8_000)
    const test = await harness({ messages: { ses_a: [{ id: "msg_bulk", type: "user", text, time: { created: 1 } }] } })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages[0]).toMatchObject({ kind: "user", id: "msg_bulk", text })
      expect(test.store.state().transport.kind).toBe("open")
      expect(test.relay.requests.filter((request) => request.operation === "session.message")).toEqual([])
      expect(test.relay.closeEvents).toEqual([])
    } finally {
      await test.stop()
    }
  })

  for (const replace of [false, true])
    test(`typed resync refreshes the canonical window without losing resident content${replace ? " or writing into another Session" : ""}`, async () => {
      const gate = Promise.withResolvers<void>()
      let snapshots = 0
      const test = await harness({
        handler: async (request) => {
          if (request.operation !== "session.snapshot") return "default"
          if (request.sessionID === "ses_b")
            return {
              ok: true,
              value: {
                sourceEpoch: "epoch_1",
                session: { id: "ses_b" },
                messages: [{ id: "msg_b", type: "user", text: "Other Session", time: { created: 1 } }],
                watermark: { type: "log.synced", aggregateID: "ses_b", seq: 0 },
              },
            }
          if (++snapshots > 1) await gate.promise
          return {
            ok: true,
            value: {
              sourceEpoch: "epoch_1",
              session: { id: "ses_a" },
              messages: [
                {
                  id: "msg_a",
                  type: "user",
                  text: snapshots > 1 ? "Fresh content" : "Resident content",
                  time: { created: 1 },
                },
              ],
              watermark: { type: "log.synced", aggregateID: "ses_a", seq: snapshots > 1 ? 2 : 0 },
            },
          }
        },
      })
      try {
        await test.store.load()
        await test.runUntil(() => test.store.state().sessions.length > 0)
        await test.store.selectSession("ses_a")
        test.relay.pushResync("ses_a")
        await test.runUntil(() => snapshots === 2)
        expect(test.store.state().view?.messages[0]).toMatchObject({ id: "msg_a", text: "Resident content" })
        if (replace) await test.store.selectSession("ses_b")
        gate.resolve()
        await test.runUntil(() =>
          replace ? test.store.state().view?.id === "ses_b" : test.store.state().view?.watermark === 2,
        )
        expect(test.store.state().view?.messages[0]).toMatchObject(
          replace ? { id: "msg_b", text: "Other Session" } : { id: "msg_a", text: "Fresh content" },
        )
        expect(test.relay.requests.filter((request) => request.operation === "session.prompt")).toEqual([])
      } finally {
        gate.resolve()
        await test.stop()
      }
    })
})

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
    expect(assistant).toMatchObject({
      kind: "assistant",
      agent: "god",
      model: { id: "gpt-6", providerID: "openai", variant: "high" },
    })
  })

  test("keeps the assistant model from a snapshot message", () => {
    const snapshot = snapshotOf({
      sourceEpoch: "epoch_1",
      session: { title: "t" },
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          agent: "god",
          model,
          content: [{ type: "text", text: "hi" }],
          time: { created: 1 },
        },
      ],
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
  test("selected Session speed and context hydrate from the snapshot and are replaced by live diagnostics without another read", async () => {
    const speed = {
      model: { id: "gpt-5", providerID: "openai" },
      tokens: 12,
      durationNs: 2_000_000,
      tokensPerSecond: 6_000,
    }
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID, model: speed.model },
        messages: [
          {
            id: "msg_answer",
            type: "assistant",
            agent: "build",
            model: speed.model,
            content: [],
            tokens: { input: 60_000, output: 10_000, reasoning: 2_000, cache: { read: 2_000, write: 0 } },
            diagnostics: { contextLimit: 258_000 },
            time: { created: 1, completed: 2 },
          },
        ],
        generationSpeed: { latest: speed, recent: [speed] },
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 1 },
      }),
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.generationSpeed?.latest?.tokensPerSecond).toBe(6_000)
      expect(test.store.state().view?.contextWindow).toMatchObject({ used: 74_000, limit: 258_000 })
      await test.runUntil(() => test.store.state().view?.capturedChanges !== undefined)
      const requestCount = test.relay.requests.length
      const updated = { ...speed, tokens: 15, durationNs: 3_000_000, tokensPerSecond: 5_000 }
      test.relay.pushEvent("ses_a", {
        type: "session.diagnostics.updated",
        data: {
          sessionID: "ses_a",
          diagnostics: {
            model: speed.model,
            context: { total: 80_000, limit: 258_000, remaining: 178_000, percent: 31 },
            tokens: { uncachedInput: 60_000, output: 15_000, reasoning: 3_000, cacheRead: 2_000, cacheWrite: 0 },
            cache: { eligible: 62_000, mechanism: "openai-prefix-cache", readReported: true, writeReported: false },
            generationSpeed: { latest: updated, recent: [speed, updated] },
          },
        },
      })
      await test.runUntil(() => test.store.state().view?.generationSpeed?.latest?.tokensPerSecond === 5_000)
      expect(test.store.state().view?.contextWindow?.used).toBe(80_000)
      expect(test.relay.requests.filter((request) => request.operation === "session.snapshot")).toHaveLength(1)
      expect(test.relay.requests).toHaveLength(requestCount)
    } finally {
      await test.stop()
    }
  })

  test("live completed compaction prunes covered rows but a failed job preserves them", async () => {
    const messages = [
      {
        id: "msg_old",
        type: "assistant",
        agent: "god",
        content: [{ type: "text", text: "old" }],
        time: { created: 1 },
      },
      { id: "msg_boundary", type: "assistant", content: [{ type: "text", text: "covered" }], time: { created: 2 } },
      { id: "msg_new", type: "user", text: "new", time: { created: 3 } },
    ]
    let completed = false
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID },
        messages: completed
          ? [
              ...messages.slice(0, 2),
              {
                id: "msg_compaction",
                type: "compaction",
                jobID: "cmp_done",
                trigger: "manual",
                status: "completed",
                revision: 1,
                boundary: { messageID: "msg_boundary", seq: 2 },
                metrics: { excludedMessages: 2, excludedParts: 1, inputTokens: 10, retainedTokens: 4 },
                time: { created: 3 },
              },
              messages[2],
            ]
          : messages,
        watermark: { type: "log.synced", aggregateID: sessionID, seq: completed ? 4 : 1 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", {
        type: "session.compaction.failed",
        data: {
          sessionID: "ses_a",
          jobID: "cmp_fail",
          code: "provider_failed",
          error: { type: "compaction.failed", message: "failed" },
        },
      })
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.id === "cmp_fail") === true)
      expect(test.store.state().view?.messages.map((message) => message.id)).toContain("msg_old")
      test.relay.pushEvent("ses_a", {
        type: "session.compaction.ended",
        data: {
          sessionID: "ses_a",
          jobID: "cmp_done",
          boundary: { messageID: "msg_boundary", seq: 2 },
          revision: 1,
          metrics: { excludedMessages: 2, excludedParts: 1, inputTokens: 10, retainedTokens: 4 },
        },
      })
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.id === "cmp_done") === true)
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_new", "cmp_done"])
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_old", ordinal: 0, delta: "late" },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_new", "cmp_done"])
      completed = true
      await test.store.reloadMessages()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_compaction", "msg_new"])
    } finally {
      await test.stop()
    }
  })
  test("rejects a body that is not a session projection", () => {
    expect(readSnapshot({ data: [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }] })).toBeUndefined()
    expect(readSnapshot(undefined)).toBeUndefined()
    expect(
      readSnapshot({ messages: [], session: {}, watermark: { type: "log.synced", aggregateID: "ses_a", seq: 4 } }),
    ).toMatchObject({
      messages: [],
      watermark: 4,
    })
  })

  test("keeps the projection and reports when the snapshot read fails", async () => {
    let fail = false
    const test = await harness({
      messages: { ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: (request) =>
        request.operation === "session.snapshot" && fail
          ? { ok: false, code: "invalid_message", message: "boom" }
          : "default",
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

  test("silently ignores a stale background snapshot below the applied watermark", async () => {
    let watermark = 10
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID, title: "t", time: { created: 1, updated: 1 } },
        messages: [
          {
            id: "msg_live",
            type: "assistant",
            agent: "god",
            content: [{ type: "text", text: "LIVE" }],
            time: { created: 1 },
          },
        ],
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
        type: "session.text.ended",
        data: { assistantMessageID: "msg_live", ordinal: 0, text: "LIVE!" },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => test.store.state().view?.watermark === 11)
      await test.store.reloadMessages()
      expect(test.store.state().view?.watermark).toBe(11)
      expect(textOf(test.store.state().view)).toEqual(["LIVE!"])
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("fences durable sequence per session aggregate and ignores other aggregates", async () => {
    let snapshotWatermark = 10
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID, title: "t", time: { created: 1, updated: 1 } },
        messages: [
          {
            id: "msg_live",
            type: "assistant",
            agent: "god",
            content: [{ type: "text", text: "BASE" }],
            time: { created: 1 },
          },
        ],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: snapshotWatermark },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // Another session's aggregate must not advance or pollute this projection.
      test.relay.pushEvent("ses_a", {
        type: "session.text.ended",
        data: { assistantMessageID: "msg_other", ordinal: 0, text: "FOREIGN" },
        durable: { aggregateID: "ses_other", seq: 99, version: 1 },
        sourceEpoch: "epoch_1",
      })
      test.relay.pushEvent("ses_a", {
        type: "session.text.ended",
        data: { assistantMessageID: "msg_dup", ordinal: 0, text: "DUPLICATE" },
        durable: { aggregateID: "ses_a", seq: 10, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["BASE"])
      expect(test.store.state().view?.watermark).toBe(10)

      test.relay.pushEvent("ses_a", {
        type: "session.text.ended",
        data: { assistantMessageID: "msg_new", ordinal: 0, text: "NEXT" },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => test.store.state().view?.watermark === 11)
      expect(textOf(test.store.state().view)).toEqual(["BASE", "NEXT"])
      expect(test.store.state().view?.watermark).toBe(11)

      // A gap means a durable event was missed, so the canonical snapshot is re-read.
      const before = test.relay.requests.filter((request) => request.operation === "session.snapshot").length
      snapshotWatermark = 13
      test.relay.pushEvent("ses_a", {
        type: "session.execution.started",
        data: {},
        durable: { aggregateID: "ses_a", seq: 13, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      await test.runUntil(
        () => test.relay.requests.filter((request) => request.operation === "session.snapshot").length > before,
      )
      await test.runUntil(() => test.store.state().view?.watermark === 13)
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("drops an ephemeral delta that the snapshot already covers", async () => {
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID, title: "t", time: { created: 1, updated: 1 } },
        messages: [
          {
            id: "msg_a",
            type: "assistant",
            agent: "god",
            content: [{ type: "text", text: "HELLO" }],
            time: { created: 1 },
          },
        ],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 10 },
      }),
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(textOf(test.store.state().view)).toEqual(["HELLO"])

      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: " WORLD" },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => test.eventCount() === 1)
      await test.flush()
      expect(textOf(test.store.state().view)).toEqual(["HELLO"])

      // A durable text boundary opens the next stream, so later deltas append again.
      test.relay.pushEvent("ses_a", {
        type: "session.text.started",
        data: { assistantMessageID: "msg_b", ordinal: 0 },
        durable: { aggregateID: "ses_a", seq: 11, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => test.store.state().view?.watermark === 11)
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_b", ordinal: 0, delta: "STREAMED" },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => textOf(test.store.state().view).includes("STREAMED"))
      expect(textOf(test.store.state().view)).toContain("STREAMED")
    } finally {
      await test.stop()
    }
  })

  test("a resync keeps the streamed text of an open part and appends later deltas once", async () => {
    let watermark = 10
    const content: readonly unknown[] = [{ type: "text", text: "" }]
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages: [{ id: "msg_a", type: "assistant", agent: "god", content, time: { created: 1 } }],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: watermark },
      }),
    })
    const delta = (text: string) =>
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: text },
        sourceEpoch: "epoch_1",
      })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      delta("Hel")
      delta("lo")
      await test.runUntil(() => textOf(test.store.state().view).join("") === "Hello")

      watermark = 11
      await test.store.reloadMessages()
      expect(textOf(test.store.state().view)).toEqual(["Hello"])
      delta(" world")
      await test.runUntil(() => textOf(test.store.state().view).join("") === "Hello world")

      test.relay.pushEvent("ses_a", {
        type: "session.text.ended",
        data: { assistantMessageID: "msg_a", ordinal: 0, text: "Hello world!" },
        durable: { aggregateID: "ses_a", seq: 12, version: 1 },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(() => textOf(test.store.state().view).join("") === "Hello world!")
    } finally {
      await test.stop()
    }
  }, 30_000)

  test("a resync keeps an open thought and an open tool input, and never carries text into another part", async () => {
    let watermark = 10
    const messages: readonly unknown[] = [
      {
        id: "msg_a",
        type: "assistant",
        agent: "god",
        time: { created: 1 },
        content: [
          { type: "reasoning", text: "", time: { created: 1 } },
          {
            type: "tool",
            id: "call_1",
            name: "shell",
            time: { created: 2 },
            state: { status: "streaming", input: "" },
          },
          { type: "reasoning", text: "", time: { created: 3 } },
        ],
      },
    ]
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { title: "t", time: { created: 1, updated: 1 } },
        messages,
        watermark: { type: "log.synced", aggregateID: sessionID, seq: watermark },
      }),
    })
    const thought = (text: string) =>
      test.relay.pushEvent("ses_a", {
        type: "session.reasoning.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: text },
        sourceEpoch: "epoch_1",
      })
    const input = (text: string) =>
      test.relay.pushEvent("ses_a", {
        type: "session.tool.input.delta",
        data: { assistantMessageID: "msg_a", callID: "call_1", delta: text },
        sourceEpoch: "epoch_1",
      })
    const part = (kind: "reasoning" | "tool") => {
      const message = test.store.state().view?.messages.find((item) => item.id === "msg_a")
      return message?.kind === "assistant" ? message.parts.find((item) => item.kind === kind) : undefined
    }
    const thoughtText = () => {
      const found = part("reasoning")
      return found?.kind === "reasoning" ? found.text : undefined
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      thought("Consider")
      input('{"command":')
      await test.runUntil(() => thoughtText() === "Consider")

      watermark = 11
      await test.store.reloadMessages()
      expect(part("reasoning")).toMatchObject({ text: "Consider" })
      expect(
        test.store
          .state()
          .view?.messages.flatMap((item) =>
            item.kind === "assistant"
              ? item.parts.flatMap((entry) => (entry.kind === "reasoning" ? [entry.text] : []))
              : [],
          ),
      ).toEqual(["Consider", ""])
      expect(part("tool")).toMatchObject({ status: "streaming", inputText: '{"command":' })
      thought(" more")
      input('"ls"}')
      await test.runUntil(() => thoughtText() === "Consider more")
      expect(part("tool")).toMatchObject({ inputText: '{"command":"ls"}' })
      test.relay.pushEvent("ses_a", {
        type: "session.reasoning.delta",
        data: { assistantMessageID: "msg_a", ordinal: 2, delta: "Fresh" },
        sourceEpoch: "epoch_1",
      })
      await test.runUntil(
        () =>
          test.store
            .state()
            .view?.messages.some(
              (item) =>
                item.kind === "assistant" &&
                item.parts.some((entry) => entry.kind === "reasoning" && entry.text === "Fresh"),
            ) === true,
      )
      const texts = test.store
        .state()
        .view?.messages.flatMap((item) =>
          item.kind === "assistant"
            ? item.parts.flatMap((entry) => (entry.kind === "reasoning" ? [entry.text] : []))
            : [],
        )
      expect(texts).toEqual(["Consider more", "Fresh"])
    } finally {
      await test.stop()
    }
  }, 30_000)

  test("does not resurrect compacted assistant parts from late ephemeral frames after snapshot or reconnect", async () => {
    const test = await harness({
      snapshot: (sessionID) => ({
        sourceEpoch: "epoch_1",
        session: { id: sessionID },
        messages: [
          {
            id: "msg_old",
            type: "assistant",
            agent: "god",
            content: [
              { type: "reasoning", text: "Old thought" },
              { type: "text", text: "Old answer" },
            ],
            time: { created: 1 },
          },
          { id: "msg_boundary", type: "user", text: "Covered", time: { created: 2 } },
          {
            id: "msg_compact",
            type: "compaction",
            jobID: "cmp_1",
            trigger: "manual",
            status: "completed",
            revision: 1,
            boundary: { messageID: "msg_boundary", seq: 2 },
            metrics: { excludedMessages: 2, excludedParts: 2, inputTokens: 100, retainedTokens: 40 },
            time: { created: 3 },
          },
          {
            id: "msg_new",
            type: "assistant",
            agent: "god",
            content: [{ type: "text", text: "Visible" }],
            time: { created: 4 },
          },
        ],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 10 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_compact", "msg_new"])

      const late = () => {
        test.relay.pushEvent("ses_a", {
          type: "session.reasoning.delta",
          data: { assistantMessageID: "msg_old", ordinal: 0, delta: "LATE THOUGHT" },
          sourceEpoch: "epoch_1",
        })
        test.relay.pushEvent("ses_a", {
          type: "session.text.delta",
          data: { assistantMessageID: "msg_old", ordinal: 0, delta: "LATE ANSWER" },
          sourceEpoch: "epoch_1",
        })
        test.relay.pushEvent("ses_a", {
          type: "session.text.delta",
          data: { assistantMessageID: "msg_old", ordinal: 1, delta: "UNKNOWN OLD PART" },
          sourceEpoch: "epoch_1",
        })
      }
      late()
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_compact", "msg_new"])
      await test.store.reloadMessages()
      late()
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_compact", "msg_new"])
      expect(textOf(test.store.state().view)).toEqual(["Visible"])
    } finally {
      await test.stop()
    }
  })

  test("does not replay a compacted assistant delta received while its snapshot is in flight", async () => {
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
        session: { id: sessionID },
        messages: [
          {
            id: "msg_old",
            type: "assistant",
            agent: "god",
            content: [{ type: "text", text: "old" }],
            time: { created: 1 },
          },
          { id: "msg_boundary", type: "user", text: "covered", time: { created: 2 } },
          {
            id: "msg_compact",
            type: "compaction",
            jobID: "cmp_1",
            trigger: "manual",
            status: "completed",
            revision: 1,
            boundary: { messageID: "msg_boundary", seq: 2 },
            metrics: { excludedMessages: 2, excludedParts: 1, inputTokens: 100, retainedTokens: 40 },
            time: { created: 3 },
          },
        ],
        watermark: { type: "log.synced", aggregateID: sessionID, seq: 10 },
      }),
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      const selection = test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.snapshot"))
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_old", ordinal: 0, delta: "LATE" },
        sourceEpoch: "epoch_1",
      })
      await test.flush()
      release?.()
      await selection
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_compact"])
    } finally {
      release?.()
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
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot"))
      test.relay.pushEvent("ses_a", {
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a", ordinal: 0, delta: "STREAMED" },
        sourceEpoch: "epoch_1",
      })
      expect(textOf(test.store.state().view)).toEqual([])
      release?.()
      await selection
      await test.runUntil(() => textOf(test.store.state().view).includes("STREAMED"))
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

  test("reports family-running roots from the authoritative status read", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.status" ? { ok: true, value: { running: ["ses_a"], attention: [] } } : "default",
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await waitFor(() => test.store.state().sessionStatus !== undefined)
      expect(test.relay.requests.some((request) => request.operation === "session.status")).toBe(true)
      expect(test.store.state().sessions[0]?.running).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("leaves running unknown when the relay does not report it", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.status"
          ? { ok: false, code: "unknown_operation", message: "unsupported" }
          : "default",
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.status"))
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
      await test.runUntil(() => test.store.state().view?.status === "running")
      expect(test.store.state().view?.status).toBe("running")

      test.relay.pushEvent("ses_a", {
        type: "session.step.started",
        data: { sessionID: "ses_a", assistantMessageID: "msg_retry", agent: "god", model },
      })
      await test.runUntil(
        () => test.store.state().view?.messages.some((message) => message.id === "msg_retry") === true,
      )

      test.relay.pushEvent("ses_a", {
        type: "session.status",
        data: { sessionID: "ses_a", status: { type: "retry", attempt: 2, message: "rate limited", next: 5_000 } },
      })
      await test.runUntil(
        () =>
          test.store
            .state()
            .view?.messages.some((message) => message.kind === "assistant" && message.retry?.attempt === 2) === true,
      )
      expect(test.store.state().view?.messages.find((message) => message.id === "msg_retry")).toMatchObject({
        retry: { attempt: 2, code: "rate limited" },
      })

      test.relay.pushEvent("ses_a", { type: "session.idle", data: { sessionID: "ses_a" } })
      await test.runUntil(() => test.store.state().view?.status === "idle")
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
