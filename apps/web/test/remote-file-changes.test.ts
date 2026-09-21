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
 * Relay-double harness for the recorded file-change reads. It rides the shared double
 * over a real HTTP and WebSocket boundary and drives batching and reconnect timers by
 * hand, so a pending ledger read can be gated deterministically.
 */
async function harness(options: {
  readonly handler?: RequestHandler
  readonly requestTimeoutMs?: number
  readonly maxInFlight?: number
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
    now: () => 1_000,
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

const patch = (path: string, text: string, additions: number, deletions: number) => ({
  path,
  patch: text,
  additions,
  deletions,
})

/** A deferred ledger read: the test releases the response when it wants it to settle. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describe("recorded file changes", () => {
  test("reads the session's ledger on selection and keeps each path's patch", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.fileChange.list"
          ? {
              ok: true,
              value: {
                data: [
                  patch("src/remote/store.ts", "@@ -1 +1 @@\n-before\n+after", 1, 1),
                  patch("apps/web/README.md", "@@ -2 +2 @@", 2, 0),
                ],
              },
            }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => (test.store.state().view?.fileChanges.length ?? 0) === 2)
      expect(test.store.state().view?.fileChanges).toEqual([
        patch("src/remote/store.ts", "@@ -1 +1 @@\n-before\n+after", 1, 1),
        patch("apps/web/README.md", "@@ -2 +2 @@", 2, 0),
      ])
      expect(
        test.relay.requests
          .filter((request) => request.operation === "session.fileChange.list")
          .map((request) => request.sessionID),
      ).toEqual(["ses_a"])
    } finally {
      await test.stop()
    }
  })

  test("keeps a live record that lands while the ledger read is pending", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.fileChange.list") return "default"
        await gate.promise
        return {
          ok: true,
          value: { data: [patch("src/a.ts", "ledger", 1, 0), patch("src/b.ts", "b", 1, 0)] },
        }
      },
    })
    try {
      await connect(test)
      // The selection resolves its snapshot and then waits on the gated ledger read.
      void test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.fileChange.list"))
      test.relay.pushEvent("ses_a", {
        id: "evt_live",
        type: "session.file-change.recorded",
        data: { change: patch("src/a.ts", "live", 9, 9) },
      })
      await test.flush()
      expect(test.store.state().view?.fileChanges).toEqual([patch("src/a.ts", "live", 9, 9)])

      gate.release()
      await test.runUntil(() => (test.store.state().view?.fileChanges.length ?? 0) === 2)
      // The read describes an earlier instant, so the live record stays.
      expect(test.store.state().view?.fileChanges).toEqual([
        patch("src/a.ts", "live", 9, 9),
        patch("src/b.ts", "b", 1, 0),
      ])
    } finally {
      await test.stop()
    }
  })

  test("does not write a ledger read that settles after the selection moved", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.fileChange.list") return "default"
        if (request.sessionID === "ses_a") {
          await gate.promise
          return { ok: true, value: { data: [patch("src/from-ses-a.ts", "a", 1, 0)] } }
        }
        return { ok: true, value: { data: [patch("src/from-ses-b.ts", "b", 1, 0)] } }
      },
    })
    try {
      await connect(test)
      void test.store.selectSession("ses_a")
      await test.runUntil(() =>
        test.relay.requests.some(
          (request) => request.operation === "session.fileChange.list" && request.sessionID === "ses_a",
        ),
      )
      await test.store.selectSession("ses_b")
      await test.runUntil(() => test.store.state().view?.fileChanges[0]?.path === "src/from-ses-b.ts")

      gate.release()
      await test.flush()
      await test.flush()
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().view?.fileChanges).toEqual([patch("src/from-ses-b.ts", "b", 1, 0)])
    } finally {
      await test.stop()
    }
  })

  test("keeps live records and reports when the relay cannot answer the ledger read", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.fileChange.list"
          ? { ok: false, code: "unknown_operation", message: "unsupported operation" }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", {
        id: "evt_live",
        type: "session.file-change.recorded",
        data: { change: patch("src/a.ts", "live", 1, 0) },
      })
      await test.flush()
      expect(test.store.state().view?.fileChanges).toEqual([patch("src/a.ts", "live", 1, 0)])
      expect(test.store.state().notice).toContain("unsupported operation")
    } finally {
      await test.stop()
    }
  })

  test("reports a ledger read timeout rather than presenting an unconfirmed empty ledger", async () => {
    const gate = deferred()
    const test = await harness({
      requestTimeoutMs: 100,
      handler: async (request) => {
        if (request.operation !== "session.fileChange.list") return "default"
        await gate.promise
        return { ok: true, value: { data: [] } }
      },
    })
    try {
      await connect(test)
      const selecting = test.store.selectSession("ses_a")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.fileChange.list"))
      await test.flush()
      await selecting
      expect(test.store.state().notice).toContain("did not settle")
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("reports request saturation without falsely claiming the connection closed", async () => {
    const test = await harness({ maxInFlight: 4 })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      expect(test.store.state().transport.kind).toBe("open")
      expect(test.store.state().notice).toContain("request limit")
      expect(test.store.state().notice).not.toContain("closed")
    } finally {
      await test.stop()
    }
  })

  test("re-reads the ledger after a reconnect so a change missed while away is corrected", async () => {
    let ledger = [patch("src/a.ts", "first", 1, 0)]
    const test = await harness({
      handler: (request) =>
        request.operation === "session.fileChange.list" ? { ok: true, value: { data: ledger } } : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view?.fileChanges[0]?.patch === "first")

      // The device recorded another patch while this browser was disconnected.
      ledger = [patch("src/a.ts", "second", 4, 2)]
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.store.state().view?.fileChanges[0]?.patch === "second")
      expect(test.store.state().transport.kind).toBe("open")
      expect(
        test.relay.requests.filter((request) => request.operation === "session.fileChange.list").length,
      ).toBeGreaterThanOrEqual(2)
    } finally {
      await test.stop()
    }
  })
})
