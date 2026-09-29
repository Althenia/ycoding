import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, type RelayDouble, type RelayHandlerResult } from "./relay-double"

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  readonly flush: () => Promise<void>
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

type RequestHandler = (request: {
  readonly operation: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly sessionID?: string
}) => RelayHandlerResult

/**
 * Relay-double harness for the captured file-change reads. It rides the shared double
 * over a real HTTP and WebSocket boundary and drives batching and reconnect timers by
 * hand, so a pending read can be gated deterministically.
 */
async function harness(options: {
  readonly handler?: RequestHandler
  readonly requestTimeoutMs?: number
  readonly maxInFlight?: number
  readonly now?: () => number
} = {}): Promise<Harness> {
  const relay = await startRelayDouble({ handler: options.handler, advertisedSessions: ["ses_a", "ses_b"] })
  const timers: (() => void)[] = []
  // Exclude long-delay timers. A manual flush drives batching, reconnect backoff,
  // and the short request timeout selected by the timeout regression.
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
    const pending = timers.splice(0)
    for (const callback of pending) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({
        url: relay.wsURL(deviceID),
        handlers,
        resetDelayMs: 10,
        maxDelayMs: 20,
        schedule,
        requestTimeoutMs: options.requestTimeoutMs,
        maxInFlight: options.maxInFlight,
      }),
    schedule,
    batchMs: 20,
    now: options.now ?? (() => 1_000),
  })
  const runUntil = async (predicate: () => boolean, attempts = 200) => {
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
    runUntil,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

/** Loads the account and connects the only enrolled device. */
async function connect(test: Harness) {
  await test.store.load()
  await test.runUntil(() => test.store.state().sessions.length > 0)
}

/** A deferred read: the test releases the response when it wants it to settle. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("captured file changes", () => {
  test("reads the connector's captured summary", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.capturedChanges.list"
      ? { ok: true, value: { mode: "transcript", placementMessageID: "msg_reply", data: [{ path: "src/child.ts", additions: 1, deletions: 1, status: "modified", files: [{ path: "src/child.ts", diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }] }] } }
      : "default" })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.capturedChanges?.data.length === 1)
      expect(test.store.state().view?.capturedChanges).toMatchObject({ mode: "transcript", placementMessageID: "msg_reply", data: [{ path: "src/child.ts", additions: 1 }] })
      expect(test.relay.requests.filter((request) => request.operation === "session.capturedChanges.list")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("publishes captured pages only after the final cursor page settles", async () => {
    const gate = deferred()
    const change = (path: string) => ({ path, additions: 1, deletions: 1, status: "modified", files: [{ path, diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }] })
    const test = await harness({ handler: async (request) => {
      if (request.operation !== "session.capturedChanges.list") return "default"
      if (request.input?.cursor === "page_2") { await gate.promise; return { ok: true, value: { mode: "transcript", placementMessageID: "msg_reply", data: [change("src/b.ts")] } } }
      return { ok: true, value: { mode: "transcript", placementMessageID: "msg_reply", data: [change("src/a.ts")], cursor: { next: "page_2" } } }
    } })
    try {
      await connect(test)
      void test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.filter((request) => request.operation === "session.capturedChanges.list").length === 2)
      expect(test.store.state().view?.capturedChanges).toBeUndefined()
      gate.release()
      await test.runUntil(() => test.store.state().view?.capturedChanges?.data.length === 2)
      expect(test.store.state().view?.capturedChanges?.data.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
    } finally { gate.release(); await test.stop() }
  })

  test("re-reads captured changes after a same-device reconnect", async () => {
    let revision = 0
    const test = await harness({ handler: (request) => request.operation === "session.capturedChanges.list"
      ? { ok: true, value: revision === 0 ? { mode: "none", data: [] } : { mode: "transcript", placementMessageID: "msg_reply", data: [{ path: "src/new.ts", additions: 1, deletions: 0, status: "modified", files: [{ path: "src/new.ts", diff: "@@ -0,0 +1 @@\n+new", additions: 1, deletions: 0, status: "modified" }] }] } }
      : "default" })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.capturedChanges?.mode === "none")
      revision = 1
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.store.state().view?.capturedChanges?.data.length === 1)
      expect(test.relay.requests.filter((request) => request.operation === "session.capturedChanges.list").length).toBeGreaterThanOrEqual(2)
    } finally { await test.stop() }
  })

  test("coalesces parent settlement and completed-child notices into one budgeted captured refresh", async () => {
    let clock = 1_000
    let revision = 0
    const test = await harness({ now: () => clock, handler: (request) => request.operation === "session.capturedChanges.list"
      ? { ok: true, value: revision === 0 ? { mode: "none", data: [] } : { mode: "transcript", placementMessageID: "msg_reply", data: [{ path: "src/child.ts", additions: 1, deletions: 1, status: "modified", files: [{ path: "src/child.ts", diff: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1, status: "modified" }] }] } }
      : "default" })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.capturedChanges?.mode === "none")
      revision = 1
      clock += 10_000
      test.relay.pushEvent("ses_a", { id: "evt_step", type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "msg_reply" } })
      test.relay.pushEvent("ses_a", { id: "evt_child", type: "session.synthetic", durable: { aggregateID: "ses_a", seq: 2 }, data: { sessionID: "ses_a", metadata: { source: "subagent_notification", childID: "ses_child", type: "completed", revision: 1 }, text: "Child completed" } })
      await test.runUntil(() => test.store.state().view?.capturedChanges?.mode === "transcript")
      expect(test.relay.requests.filter((request) => request.operation === "session.capturedChanges.list")).toHaveLength(2)
    } finally { await test.stop() }
  })

  test("an older machine without captured changes gets no Conversation card or error", async () => {
    let clock = 1_000
    const test = await harness({ now: () => clock, handler: (request) => request.operation === "session.capturedChanges.list"
      ? { ok: false, code: "unknown_operation", message: "unsupported" }
      : "default" })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.capturedChanges.list"))
      await test.flush()
      await test.flush()
      expect(test.store.state().view?.capturedChanges).toBeUndefined()
      expect(test.store.state().notice).toBeUndefined()
      clock += 10_000
      test.relay.pushEvent("ses_a", { id: "evt_new_step", type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "msg_reply" } })
      await test.flush()
      await test.flush()
      await test.flush()
      expect(test.relay.requests.filter((request) => request.operation === "session.capturedChanges.list")).toHaveLength(1)
    } finally { await test.stop() }
  })
})
