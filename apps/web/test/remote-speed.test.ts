import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, type RelayHandlerResult } from "./relay-double"

type Handler = (request: { readonly operation: string; readonly input?: Readonly<Record<string, unknown>>; readonly sessionID?: string }) => RelayHandlerResult

function gate() {
  const pending = Promise.withResolvers<void>()
  return { wait: pending.promise, release: pending.resolve }
}

async function harness(handler: Handler = () => "default") {
  const relay = await startRelayDouble({ handler, advertisedSessions: ["ses_a", "ses_b"] })
  const timers: { readonly callback: () => void; readonly ms: number }[] = []
  const schedule = (callback: () => void, ms = 0) => {
    const timer = { callback, ms }
    timers.push(timer)
    return () => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const signals: { readonly operation: string; readonly signal: AbortSignal | undefined }[] = []
  const flush = async () => {
    await Bun.sleep(15)
    for (const timer of timers.filter((entry) => entry.ms < 1_000)) {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
      timer.callback()
    }
  }
  const scheduledSince = (before: ReadonlySet<unknown>, ms: number) => timers.find((entry) => !before.has(entry) && entry.ms === ms)
  const fire = (timer: { readonly callback: () => void }) => {
    timers.splice(timers.indexOf(timer as (typeof timers)[number]), 1)
    timer.callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => {
      const transport = createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule, createSocket: relay.createSocket })
      return { ...transport, request: (operation, input) => {
        signals.push({ operation, signal: input?.signal })
        return transport.request(operation, input)
      } }
    },
    schedule,
    batchMs: 20,
    now: () => 1_000,
  })
  const runUntil = async (predicate: () => boolean, attempts = 200) => {
    for (let index = 0; index < attempts && !predicate(); index += 1) {
      await flush()
      await Bun.sleep(5)
    }
    if (!predicate()) throw new Error("runUntil did not settle")
  }
  const count = (operation: string, match: (input: Readonly<Record<string, unknown>> | undefined) => boolean = () => true) =>
    relay.requests.filter((request) => request.operation === operation && match(request.input)).length
  return {
    store, relay, flush, fire, scheduledSince, runUntil, signals, timers, count,
    connect: async () => {
      await store.load()
      await runUntil(() => store.state().sessions.length > 0)
    },
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

const stepEnded = (sessionID: string, id: string) => ({ id, type: "session.step.ended", data: { sessionID, assistantMessageID: "msg_reply" } })
const change = { placementMessageID: "msg_reply", path: "src/a.ts", additions: 1, deletions: 1, status: "modified", files: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }] }
const captured = (request: { readonly operation: string }) => request.operation === "session.capturedChanges.list"
const workspaceList = (input: Readonly<Record<string, unknown>> | undefined) => input?.workspace !== undefined

describe("captured changes refresh", () => {
  test("runs one read at a time, throttles from settle, and aborts a superseded read", async () => {
    const first = gate()
    const second = gate()
    let reads = 0
    const test = await harness(async (request) => {
      if (!captured(request)) return "default"
      reads += 1
      if (reads === 1) await first.wait
      if (reads === 2) await second.wait
      return { ok: true, value: { data: [change] } }
    })
    try {
      await test.connect()
      void test.store.selectSession("ses_a")
      await test.runUntil(() => test.count("session.capturedChanges.list") === 1)

      test.relay.pushEvent("ses_a", stepEnded("ses_a", "evt_1"))
      test.relay.pushEvent("ses_a", stepEnded("ses_a", "evt_2"))
      await test.flush()
      await test.flush()
      expect(test.count("session.capturedChanges.list")).toBe(1)

      const before = new Set(test.timers)
      first.release()
      await test.runUntil(() => test.store.state().view?.capturedChanges?.length === 1)
      await test.runUntil(() => test.scheduledSince(before, 10_000) !== undefined)
      expect(test.count("session.capturedChanges.list")).toBe(1)

      test.fire(test.scheduledSince(before, 10_000)!)
      await test.runUntil(() => test.count("session.capturedChanges.list") === 2)
      const superseded = test.signals.filter((entry) => entry.operation === "session.capturedChanges.list").at(-1)?.signal
      expect(superseded?.aborted).toBe(false)
      await test.store.selectSession("ses_b")
      expect(superseded?.aborted).toBe(true)
      second.release()
      await test.flush()
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().view?.id).toBe("ses_b")
    } finally { first.release(); second.release(); await test.stop() }
  })

  test("a Session-list invalidation neither refreshes captured changes nor reloads the selected history", async () => {
    const test = await harness()
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      let settled = -1
      await test.runUntil(() => {
        const requests = test.relay.requests.length
        const quiet = requests === settled && test.store.state().carouselStatus === "ready"
        settled = requests
        return quiet
      })
      const captures = test.count("session.capturedChanges.list")
      const snapshots = test.count("session.snapshot")
      const lists = test.count("session.list", workspaceList)
      const statuses = new Set<string>()
      const unsubscribe = test.store.subscribe(() => statuses.add(test.store.state().sessionListStatus))

      test.relay.pushSessions(["ses_a"])
      test.relay.pushSessions(["ses_a"])
      test.relay.pushSessions(["ses_a"])
      await test.runUntil(() => test.count("session.list", workspaceList) > lists)
      await test.flush()
      await test.flush()

      await test.runUntil(() => test.count("session.list", workspaceList) === lists + 2)
      await test.flush()
      expect(test.count("session.list", workspaceList)).toBe(lists + 2)
      expect(test.count("session.capturedChanges.list")).toBe(captures)
      expect(test.count("session.snapshot")).toBe(snapshots)
      expect(statuses.has("loading")).toBe(false)
      expect(test.store.state().sessionListStatus).toBe("ready")
      unsubscribe()
    } finally { await test.stop() }
  })

  test("a Session-list invalidation reloads the selected history only when the Session logged events past the applied watermark", async () => {
    let advanced = false
    const test = await harness((request) => {
      if (request.operation === "session.log") return { ok: true, value: { data: advanced ? [{ type: "session.step.ended", durable: { aggregateID: "ses_a", seq: 5, version: 1 } }] : [] } }
      return "default"
    })
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.count("session.log") >= 1)
      const snapshots = test.count("session.snapshot")
      test.relay.pushSessions(["ses_a"])
      await test.runUntil(() => test.count("session.log") >= 2)
      await test.flush()
      expect(test.count("session.snapshot")).toBe(snapshots)
      advanced = true
      await test.flush()
      test.relay.pushSessions(["ses_a"])
      await test.runUntil(() => test.count("session.snapshot") > snapshots)
    } finally { await test.stop() }
  })
})

describe("Session-list refresh pacing", () => {
  const row = (title: string) => ({ id: "ses_a", title, time: { created: 1, updated: 2 } })

  test("frames inside the window leave an in-flight list read valid and share one trailing refresh", async () => {
    const read = gate()
    let held = false
    let title = "Alpha session"
    const test = await harness(async (request) => {
      if (request.operation !== "session.list" || request.input?.workspace === undefined) return "default"
      const fresh = title
      if (held) await read.wait
      return { ok: true, value: { data: [row(fresh)] } }
    })
    const until = async (predicate: () => boolean) => {
      for (let index = 0; index < 200 && !predicate(); index += 1) await Bun.sleep(5)
      if (!predicate()) throw new Error("until did not settle")
    }
    try {
      await test.connect()
      await test.runUntil(() => test.store.state().sessionListStatus === "ready")
      await test.flush()
      await test.flush()
      held = true
      title = "Fresh"
      const lists = test.count("session.list", workspaceList)
      test.relay.pushSessions(["ses_a"])
      await until(() => test.count("session.list", workspaceList) === lists + 1)
      test.relay.pushSessions(["ses_a"])
      test.relay.pushSessions(["ses_a"])
      await Bun.sleep(20)
      held = false
      read.release()
      await until(() => test.store.state().sessions.find((session) => session.id === "ses_a")?.title === "Fresh")
      expect(test.count("session.list", workspaceList)).toBe(lists + 1)
      await test.runUntil(() => test.count("session.list", workspaceList) === lists + 2)
      await test.flush()
      expect(test.count("session.list", workspaceList)).toBe(lists + 2)
    } finally { read.release(); await test.stop() }
  })
})

describe("watermark confirmation", () => {
  test("reloads once when the log read fails and ignores an unsupported log", async () => {
    let log: "failed" | "unsupported" = "failed"
    const test = await harness((request) => {
      if (request.operation !== "session.log") return "default"
      return log === "failed" ? { ok: false, code: "internal_error", message: "boom" } : { ok: false, code: "unknown_operation", message: "unsupported" }
    })
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.count("session.snapshot") === 2)
      log = "unsupported"
      await test.store.selectSession("ses_b")
      await test.runUntil(() => test.count("session.log") === 2)
      await test.flush()
      expect(test.count("session.snapshot")).toBe(3)
    } finally { await test.stop() }
  })

  test("a log reply holding only events the view already applied reloads nothing", async () => {
    const test = await harness((request) => {
      if (request.operation === "session.log") return { ok: true, value: { data: [{ type: "session.step.ended", durable: { aggregateID: "ses_a", seq: 3, version: 1 } }] } }
      if (request.operation === "session.snapshot") return { ok: true, value: { sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Opened" }, messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 3 } } }
      return "default"
    })
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.count("session.log") === 1)
      await test.flush()
      expect(test.count("session.snapshot")).toBe(1)
    } finally { await test.stop() }
  })
})

describe("opening a Session", () => {
  const snapshot = (sessionID: string) => ({ ok: true as const, value: {
    sourceEpoch: "epoch_1", session: { id: sessionID, title: "Opened" },
    messages: [{ id: "msg_1", type: "user", text: "Hello", time: { created: 1 } }],
    watermark: { type: "log.synced", aggregateID: sessionID, seq: 3 },
  } })

  test("sends the subscription first and reads the snapshot and Session state without waiting for it", async () => {
    const subscribed = gate()
    const test = await harness(async (request) => {
      if (request.operation === "session.subscribe") await subscribed.wait
      if (request.operation === "session.snapshot") return snapshot(request.sessionID ?? "ses_a")
      return "default"
    })
    try {
      await test.connect()
      const selecting = test.store.selectSession("ses_a")
      await test.runUntil(() => ["session.snapshot", "session.autonomy.get", "session.permission.list", "session.guardrail.request.list", "session.form.list", "session.todo.list"]
        .every((operation) => test.count(operation) >= 1))
      const operations = test.relay.requests.map((request) => request.operation)
      expect(operations.indexOf("session.subscribe")).toBeLessThan(operations.indexOf("session.snapshot"))
      expect(test.store.state().view?.messages).toEqual([])
      expect(test.store.state().history).toBeUndefined()

      subscribed.release()
      await selecting
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])
    } finally { subscribed.release(); await test.stop() }
  })

  test("discards the snapshot and Session state read alongside a refused subscription", async () => {
    const test = await harness((request) => {
      if (request.operation === "session.subscribe") return { ok: false, code: "session_not_allowed", message: "refused" }
      if (request.operation === "session.snapshot") return snapshot(request.sessionID ?? "ses_a")
      if (request.operation === "session.autonomy.get") return { ok: true, value: { data: { mode: "goal", yolo: 2 } } }
      return "default"
    })
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      await test.flush()
      expect(test.store.state().notice).toBe("This session is not available from the connected device.")
      expect(test.store.state().view?.messages).toEqual([])
      expect(test.store.state().view?.autonomy?.mode).not.toBe("goal")
    } finally { await test.stop() }
  })

  test("an event logged between the snapshot read and the subscription taking effect reloads the history", async () => {
    let snapshots = 0
    const test = await harness((request) => {
      if (request.operation === "session.snapshot") {
        snapshots += 1
        return { ok: true, value: { ...snapshot(request.sessionID ?? "ses_a").value, watermark: { type: "log.synced", aggregateID: "ses_a", seq: snapshots === 1 ? 3 : 4 },
          messages: [{ id: snapshots === 1 ? "msg_1" : "msg_2", type: "user", text: "Hello", time: { created: 1 } }] } }
      }
      if (request.operation === "session.log") return { ok: true, value: { data: [{ type: "session.step.ended", durable: { aggregateID: "ses_a", seq: 4, version: 1 } }] } }
      return "default"
    })
    try {
      await test.connect()
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.messages.some((message) => message.id === "msg_2") === true)
      expect(test.relay.requests.find((request) => request.operation === "session.log")?.input).toEqual({ after: 3 })
      expect(snapshots).toBe(2)
    } finally { await test.stop() }
  })
})
