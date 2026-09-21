import { describe, expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { shellOutputFetchFor, shellOutputFor } from "../src/remote/projection"
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
 * Relay-double harness for the paged shell-output read. It rides the shared double over a
 * real HTTP and WebSocket boundary and drives batching by hand, so a page can be gated
 * deterministically while the selection or the connection changes underneath it.
 */
async function harness(options: { readonly handler?: RequestHandler } = {}): Promise<Harness> {
  const relay = await startRelayDouble({
    handler: options.handler,
    advertisedSessions: ["ses_a", "ses_b"],
    snapshot: (sessionID) => ({
      sourceEpoch: "epoch_1",
      session: { id: sessionID, title: sessionID, time: { created: 1, updated: 1 } },
      messages: sessionID === "ses_a" ? shellMessages() : [],
      watermark: { type: "log.synced", aggregateID: sessionID, seq: 0 },
    }),
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
    const pending = timers.splice(0)
    for (const callback of pending) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule }),
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

/** The device's first page: 20 bytes captured, 6 of them already sent to this client. */
const shellMessages = () => [
  {
    id: "msg_page",
    type: "shell",
    shellID: "sh_page",
    command: "bun test",
    status: "exited",
    exit: 0,
    output: { output: "first\n", cursor: 6, size: 20, truncated: false },
    time: { created: 1, completed: 2 },
  },
  {
    id: "msg_tool_shell",
    type: "assistant",
    agent: "god",
    content: [
      { type: "text", text: "I started the suite in the background." },
      {
        type: "tool",
        id: "call_bg",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun test --watch", background: true },
          content: [{ type: "text", text: "The command was moved to the background." }],
          structured: { shellID: "sh_bg", truncated: false, status: "running" },
        },
      },
    ],
    time: { created: 3, completed: 4 },
  },
]

/** Loads the account and connects the only enrolled device. */
async function connect(test: Harness) {
  await test.store.load()
  await test.runUntil(() => test.store.state().sessions.length > 0)
}

/** A deferred response: the test releases the page when it wants it to settle. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const shellRequests = (test: Harness) =>
  test.relay.requests.filter((request) => request.operation === "session.shell.output")

describe("paged shell output", () => {
  test("reads one explicit page at the client's cursor and appends it", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.shell.output"
          ? { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      await test.store.loadShellOutputPage("sh_page")
      await test.flush()

      // The device's own page is kept, and the fetched page is appended once.
      expect(shellOutputFor(test.store.state().view!, "sh_page")).toEqual({
        text: "first\nsecond\n",
        cursor: 13,
        size: 20,
        truncated: false,
      })
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toEqual({ state: "idle" })
      // The request names the shell, the session that owns it, the cursor, and one page budget.
      expect(shellRequests(test).map((request) => ({ sessionID: request.sessionID, input: request.input }))).toEqual([
        { sessionID: "ses_a", input: { shellID: "sh_page", cursor: 6, limit: 65_536 } },
      ])
      // A read is not a mutation: nothing is queued for a retry, and nothing else is requested.
      expect(test.store.state().mutations).toEqual([])
      await test.flush()
      await test.flush()
      expect(shellRequests(test)).toHaveLength(1)
    } finally {
      await test.stop()
    }
  })

  test("stops at the captured end with cursor equal to size", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.shell.output"
          ? { ok: true, value: { data: { output: "tail\n", cursor: 20, size: 20, truncated: false } } }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)
      expect(shellRequests(test)).toHaveLength(0)

      await test.store.loadShellOutputPage("sh_page")
      await test.flush()
      const output = shellOutputFor(test.store.state().view!, "sh_page")
      // Completion is the cursor reaching the settled size, not an empty page.
      expect(output?.cursor).toBe(output?.size)
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toEqual({ state: "idle" })
    } finally {
      await test.stop()
    }
  })

  test("ignores a second request while one page is in flight", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.shell.output") return "default"
        await gate.promise
        return { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      const first = test.store.loadShellOutputPage("sh_page")
      const second = test.store.loadShellOutputPage("sh_page")
      gate.release()
      await first
      await second
      await test.flush()
      expect(shellRequests(test)).toHaveLength(1)
      expect(shellOutputFor(test.store.state().view!, "sh_page")?.text).toBe("first\nsecond\n")
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("reports a settled page that added no output and retries only on request", async () => {
    let page = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.shell.output") return "default"
        page += 1
        // The first read meets a held incomplete character: no bytes, cursor unchanged.
        return page === 1
          ? { ok: true, value: { data: { output: "", cursor: 6, size: 20, truncated: false } } }
          : { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      await test.store.loadShellOutputPage("sh_page")
      await test.flush()
      expect(shellOutputFor(test.store.state().view!, "sh_page")).toEqual({
        text: "first\n",
        cursor: 6,
        size: 20,
        truncated: false,
      })
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toEqual({ state: "stalled" })
      // Nothing retries by itself while the device holds a partial character.
      await test.flush()
      await test.flush()
      expect(shellRequests(test)).toHaveLength(1)

      await test.store.loadShellOutputPage("sh_page")
      await test.flush()
      expect(shellOutputFor(test.store.state().view!, "sh_page")?.text).toBe("first\nsecond\n")
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toEqual({ state: "idle" })
      expect(shellRequests(test)).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("reports a device that does not offer paged output without changing the page", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.shell.output"
          ? { ok: false, code: "unknown_operation", message: "unsupported operation" }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      await test.store.loadShellOutputPage("sh_page")
      await test.flush()
      expect(shellOutputFor(test.store.state().view!, "sh_page")).toEqual({
        text: "first\n",
        cursor: 6,
        size: 20,
        truncated: false,
      })
      const fetch = shellOutputFetchFor(test.store.state().view!, "sh_page")
      expect(fetch?.state).toBe("error")
      expect(fetch?.state === "error" ? fetch.message : "").toContain("does not offer paged terminal output")
    } finally {
      await test.stop()
    }
  })

  test("does not write a page that settles after the selection moved", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.shell.output") return "default"
        await gate.promise
        return { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      const reading = test.store.loadShellOutputPage("sh_page")
      await test.runUntil(() => shellRequests(test).length === 1)
      await test.store.selectSession("ses_b")
      gate.release()
      await reading
      await test.flush()
      await test.flush()

      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(shellOutputFor(test.store.state().view!, "sh_page")).toBeUndefined()
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toBeUndefined()
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("does not write a page that settles after the selection returned to the same session", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.shell.output") return "default"
        await gate.promise
        return { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      const reading = test.store.loadShellOutputPage("sh_page")
      await test.runUntil(() => shellRequests(test).length === 1)
      await test.store.selectSession("ses_b")
      await test.store.selectSession("ses_a")
      gate.release()
      await reading
      await test.flush()
      await test.flush()

      // The page belonged to the selection generation that asked for it: the session that
      // was selected again shows the device page its own snapshot read, not that page.
      expect(test.store.state().activeSessionID).toBe("ses_a")
      expect(shellOutputFor(test.store.state().view!, "sh_page")).toEqual({
        text: "first\n",
        cursor: 6,
        size: 20,
        truncated: false,
      })
      expect(shellOutputFetchFor(test.store.state().view!, "sh_page")).toBeUndefined()
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("does not write a page that settles after the connection was replaced", async () => {
    const gate = deferred()
    const test = await harness({
      handler: async (request) => {
        if (request.operation !== "session.shell.output") return "default"
        await gate.promise
        return { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      const reading = test.store.loadShellOutputPage("sh_page")
      await test.runUntil(() => shellRequests(test).length === 1)
      test.store.connect("dev_1")
      gate.release()
      await reading
      await test.flush()
      await test.flush()

      // The replaced connection owns no session view, so the late page has nowhere to land.
      expect(test.store.state().activeSessionID).toBeUndefined()
      expect(test.store.state().view).toBeUndefined()
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("does not duplicate bytes when a snapshot reload delivers them while a page is in flight", async () => {
    const gate = deferred()
    let snapshots = 0
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.snapshot" && request.sessionID === "ses_a") {
          snapshots += 1
          // The device read the capture again and now holds 13 bytes of it.
          return {
            ok: true,
            value: {
              sourceEpoch: "epoch_1",
              session: { id: "ses_a", title: "ses_a", time: { created: 1, updated: 1 } },
              messages:
                snapshots === 1
                  ? shellMessages()
                  : [
                      {
                        id: "msg_page",
                        type: "shell",
                        shellID: "sh_page",
                        command: "bun test",
                        status: "exited",
                        exit: 0,
                        output: { output: "first\nsecond\n", cursor: 13, size: 20, truncated: false },
                        time: { created: 1, completed: 2 },
                      },
                    ],
              watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 },
            },
          }
        }
        if (request.operation !== "session.shell.output") return "default"
        await gate.promise
        return { ok: true, value: { data: { output: "second\n", cursor: 13, size: 20, truncated: false } } }
      },
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => shellOutputFor(test.store.state().view!, "sh_page") !== undefined)

      const reading = test.store.loadShellOutputPage("sh_page")
      await test.runUntil(() => shellRequests(test).length === 1)
      const before = shellOutputFor(test.store.state().view!, "sh_page")
      if (before === undefined) throw new Error("expected the shell message")
      // The device advanced to byte 13 while the page from byte 6 was still in flight.
      await test.store.reloadMessages()
      await test.runUntil(
        () => shellOutputFor(test.store.state().view!, "sh_page")?.cursor === 13,
      )
      gate.release()
      await reading
      await test.flush()

      expect(shellOutputFor(test.store.state().view!, "sh_page")).toEqual({
        text: "first\nsecond\n",
        cursor: 13,
        size: 20,
        truncated: false,
      })
    } finally {
      gate.release()
      await test.stop()
    }
  })

  test("reads a background shell tool's capture from the shell id the device reported", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.shell.output"
          ? { ok: true, value: { data: { output: "watch\n", cursor: 6, size: 40, truncated: false } } }
          : "default",
    })
    try {
      await connect(test)
      await test.store.selectSession("ses_a")
      await test.runUntil(() => test.store.state().view !== undefined)

      await test.store.loadShellOutputPage("sh_bg")
      await test.flush()
      expect(shellOutputFor(test.store.state().view!, "sh_bg")).toEqual({
        text: "watch\n",
        cursor: 6,
        size: 40,
        truncated: false,
      })
      expect(shellRequests(test).map((request) => request.input)).toEqual([{ shellID: "sh_bg", cursor: 0, limit: 65_536 }])
    } finally {
      await test.stop()
    }
  })
})
