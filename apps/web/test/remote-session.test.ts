import { describe, expect, test } from "bun:test"
import { canReplyToRequest } from "../src/remote/projection"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport, type RemoteTransport, type RemoteTransportStatus } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayDouble, type RelayHandlerResult } from "./relay-double"

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  readonly flush: () => Promise<void>
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  readonly stop: () => Promise<void>
}

async function harness(options: {
  handler?: (request: { operation: string; input?: Readonly<Record<string, unknown>>; sessionID?: string }) => RelayHandlerResult
  messages?: Record<string, readonly unknown[]>
  watermark?: number
  autonomy?: unknown
  permissions?: readonly unknown[]
  guardrailRequests?: readonly unknown[]
  forms?: readonly unknown[]
} = {}): Promise<Harness> {
  const relay = await startRelayDouble({
    handler: options.handler,
    messages: options.messages,
    watermark: options.watermark,
    autonomy: options.autonomy,
    permissions: options.permissions,
    guardrailRequests: options.guardrailRequests,
    forms: options.forms,
    advertisedSessions: ["ses_a", "ses_b"],
  })
  const timers: (() => void)[] = []
  // Long-delay timers (request timeouts, keepalives) are left to the real clock so a
  // manual flush only advances batching and reconnect backoff.
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
    runUntil,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

type FakeSocket = {
  readonly publish: (status: RemoteTransportStatus) => void
  readonly sessions: (sessionIDs: readonly string[]) => void
  readonly event: (sessionID: string, event: unknown) => void
  readonly reconnect: () => void
  readonly unsubscribes: string[]
}

/**
 * Drives the store through injected transports so a replaced socket's callbacks are
 * delivered by hand, in any order. A real socket cannot be asked to publish a frame
 * after the connection that replaced it is already live.
 */
async function fakeConnectionHarness() {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a", "ses_b"] })
  const sockets: FakeSocket[] = []
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
    createTransport: (_deviceID, handlers) => {
      const socket: FakeSocket = {
        publish: (status) => handlers.onStatus?.(status),
        sessions: (_sessionIDs) => handlers.onSessions?.(),
        event: (sessionID, event) => handlers.onEvent?.(sessionID, event),
        reconnect: () => handlers.onReconnect?.(),
        unsubscribes: [],
      }
      sockets.push(socket)
      const transport: RemoteTransport = {
        connect: () => handlers.onStatus?.({ kind: "open" }),
        // The replaced socket reports nothing; these cases publish its late frames by hand.
        close: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation, input) => {
          if (operation === "session.unsubscribe") socket.unsubscribes.push(String(input?.sessionID))
          if (operation === "session.snapshot") {
            return {
              status: "ok",
              value: {
                session: { title: "t" },
                messages: [],
                watermark: { type: "log.synced", aggregateID: input?.sessionID, seq: 0 },
              },
            }
          }
          if (operation === "session.list") return { status: "ok", value: { data: [] } }
          if (operation === "session.active") return { status: "ok", value: { data: {} } }
          return { status: "ok", value: { data: {} } }
        },
      }
      return transport
    },
    schedule,
    batchMs: 20,
    now: () => 1_000,
  })
  return {
    relay,
    store,
    sockets,
    flush,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

describe("remote store integration", () => {
  test("loads the owner, connects the only device, and lists advertised sessions", async () => {
    const test = await harness()
    try {
      await test.store.load()
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      await waitFor(() => test.store.state().connection.kind === "connected")
      await waitFor(() => test.store.state().sessions.length > 0)
      expect(test.store.state().advertised).toEqual(["ses_a", "ses_b"])
      const sessions = test.store.state().sessions
      expect(sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
      expect(sessions[0]).toMatchObject({
        title: "Alpha session",
        agent: "god",
        model: { id: "gpt-5", providerID: "openai" },
        modelLabel: "openai/gpt-5",
      })
    } finally {
      await test.stop()
    }
  })

  test("loads every backend Session page beyond the old five-page cap", async () => {
    const count = 1_205
    const relay = await startRelayDouble({
      handler: (request) => {
        if (request.operation !== "session.list") return "default"
        const offset = typeof request.input?.cursor === "string" ? Number(request.input.cursor) : 0
        const limit = typeof request.input?.limit === "number" ? request.input.limit : 200
        const data = Array.from({ length: Math.min(limit, count - offset) }, (_, index) => {
          const value = offset + index
          return {
            id: `ses_${value}`,
            title: `Session ${value}`,
            projectID: value % 2 === 0 ? "prj_api" : "prj_web",
            location: { directory: value % 2 === 0 ? "/work/api" : "/work/web" },
            time: { created: value, updated: value },
          }
        })
        const next = offset + data.length < count ? String(offset + data.length) : undefined
        return { ok: true, value: { data, cursor: { next } } }
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) =>
        createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().sessions.length === count)
      expect(store.state().sessions[0]?.id).toBe("ses_0")
      expect(store.state().sessions.at(-1)?.id).toBe("ses_1204")
      expect(store.state().sessions.slice(0, 2)).toMatchObject([
        { projectID: "prj_api", directory: "/work/api" },
        { projectID: "prj_web", directory: "/work/web" },
      ])
      expect(store.state().sessions.at(-1)).toMatchObject({ projectID: "prj_api", directory: "/work/api" })
      expect(relay.requests.filter((request) => request.operation === "session.list")).toHaveLength(7)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("create and delete invalidations supersede in-flight multi-page Session lists", async () => {
    const oldPage = Promise.withResolvers<void>()
    const createdPage = Promise.withResolvers<void>()
    let phase = "initial"
    let settledPages = 0
    const row = (id: string) => ({ id, title: id, time: { created: 1, updated: 1 } })
    const relay = await startRelayDouble({
      handler: async (request) => {
        if (request.operation !== "session.list") return "default"
        if (request.input?.cursor === "initial-tail") {
          await oldPage.promise
          return { ok: true, value: { data: [row("ses_stable")] } }
        }
        if (request.input?.cursor === "created-tail") {
          await createdPage.promise
          return { ok: true, value: { data: [row("ses_deleted"), row("ses_stable")] } }
        }
        if (request.input?.cursor === "final-tail") return { ok: true, value: { data: [row("ses_stable")] } }
        return { ok: true, value: {
          data: [row(phase === "initial" ? "ses_deleted" : "ses_created")],
          cursor: { next: `${phase === "deleted" ? "final" : phase}-tail` },
        } }
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => {
        const transport = createRemoteTransport({ url: relay.wsURL(deviceID), handlers })
        return { ...transport, request: async (operation, input) => {
          const outcome = await transport.request(operation, input)
          if (operation === "session.list") settledPages++
          return outcome
        } }
      },
    })
    const published: string[][] = []
    const unsubscribe = store.subscribe(() => published.push(store.state().sessions.map((session) => session.id)))
    try {
      await store.load()
      await waitFor(() => relay.requests.some((request) => request.input?.cursor === "initial-tail"))
      phase = "created"
      relay.pushSessions([])
      await waitFor(() => relay.requests.some((request) => request.input?.cursor === "created-tail"))
      phase = "deleted"
      relay.pushSessions([])
      await waitFor(() => store.state().sessions.length === 2)
      oldPage.resolve()
      createdPage.resolve()
      await waitFor(() => settledPages === 6)
      expect(store.state().sessions.map((session) => session.id)).toEqual(["ses_created", "ses_stable"])
      expect(published.filter((ids) => ids.length > 0).every((ids) => ids.join(",") === "ses_created,ses_stable")).toBe(true)
    } finally {
      oldPage.resolve()
      createdPage.resolve()
      unsubscribe()
      store.dispose()
      await relay.stop()
    }
  })

  test("reports an authenticated device offline when its open relay rejects the session list as agent unavailable", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.list"
          ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
          : "default",
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      expect(test.store.state().transport.kind).toBe("open")
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("restores an offline device after a later advertised session list succeeds", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list") return "default"
        lists += 1
        return lists === 1
          ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
          : "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      test.relay.pushSessions(["ses_a", "ses_b"])
      await test.runUntil(() => test.store.state().sessions.length === 2)

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("keeps the last session list when a connected device's agent becomes unavailable", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list") return "default"
        lists += 1
        return lists === 1 ? "default" : { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)

      test.relay.pushSessions(["ses_a", "ses_b"])
      await test.runUntil(() => test.store.state().connection.kind === "offline")

      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the selected device's last session list when an account refresh reports it offline", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().sessions.length === 2)

      test.relay.setMe({
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: false }],
      })
      await test.store.load()

      expect(test.store.state().connection).toEqual({ kind: "offline", deviceName: "Studio Mac" })
      expect(test.store.state().activeDeviceID).toBe("dev_1")
      expect(test.store.state().sessions.map((session) => session.id)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("reports a failed session list instead of presenting a connected empty backend", async () => {
    let lists = 0
    const test = await harness({
      handler: (request) => {
        if (request.operation !== "session.list") return "default"
        lists += 1
        return lists === 1 ? { ok: false, code: "internal_error", message: "the agent rejected this read" } : "default"
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().transport.kind === "open")
      await Bun.sleep(30)

      expect(test.store.state().connection).toEqual({
        kind: "error",
        message: "Session list: the agent rejected this read",
      })
      expect(test.store.state().sessions).toEqual([])

      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().sessions.length === 2)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
    } finally {
      await test.stop()
    }
  })

  test("keeps a generic closed relay distinct from an unavailable local agent", async () => {
    const test = await fakeConnectionHarness()
    try {
      test.store.connect("dev_1")
      test.sockets[0]?.publish({ kind: "closed", code: 1006, reason: "The relay connection closed unexpectedly", retryable: true })

      expect(test.store.state().connection).toEqual({ kind: "error", message: "The relay connection closed unexpectedly" })
    } finally {
      await test.stop()
    }
  })

  test("keeps the current device connected when a replaced read carries agent unavailable", async () => {
    let activeReads = 0
    let lists = 0
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list") {
          lists += 1
          return lists === 1
            ? { ok: false, code: "agent_unavailable", message: "No local agent is connected" }
            : "default"
        }
        if (request.operation === "session.active") {
          activeReads += 1
          if (activeReads === 1) await new Promise<void>(() => {})
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => activeReads === 1)

      // Closing the old transport settles its still-pending active read as unknown;
      // its completed list result must still remain fenced from the replacement.
      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().activeDeviceID === "dev_2" && test.store.state().sessions.length === 2)

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_2" })
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("reports a signed-out browser session without fabricating devices", async () => {
    const relay = await startRelayDouble({
      meStatus: 401,
      me: { error: { code: "unauthorized", message: "Sign in required" } },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "signed-out" })
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().sessions).toHaveLength(0)
      expect(store.state().mutations).toHaveLength(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("keeps a signed-in account with no enrolled device out of the signed-out state", async () => {
    const relay = await startRelayDouble({
      me: { user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 }, devices: [] },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().owner?.id).toBe("user_1")
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().connection).toEqual({ kind: "no-device-enrolled" })
      expect(store.state().notice).toBeUndefined()
      // No relay connection is opened without a device, so nothing is fabricated.
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("asks for a machine instead of signing out when the account has several devices", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [
          { id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true },
          { id: "dev_2", name: "Laptop", createdAt: 2, status: "active", online: true },
        ],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().activeDeviceID).toBeUndefined()
      expect(store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("auto-connects the one active device while retaining revoked device history", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [
          { id: "dev_revoked", name: "Old laptop", createdAt: 1, status: "revoked", online: false },
          { id: "dev_active", name: "Studio Mac", createdAt: 2, status: "active", online: true },
        ],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().connection.kind === "connected")
      expect(store.state().activeDeviceID).toBe("dev_active")
      expect(store.state().devices.map((device) => device.status)).toEqual(["revoked", "active"])
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("does not auto-connect a revoked device", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_revoked", name: "Old laptop", createdAt: 1, status: "revoked", online: false }],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "no-device-enrolled" })
      expect(store.state().devices.map((device) => device.status)).toEqual(["revoked"])
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("retains an offline active device without offering a relay connection", async () => {
    const relay = await startRelayDouble({
      me: {
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_offline", name: "Sleeping Mac", createdAt: 1, status: "active", online: false }],
      },
    })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().devices).toHaveLength(1)
      expect(store.state().devices[0]).toMatchObject({ id: "dev_offline", online: false })
      expect(store.state().activeDeviceID).toBeUndefined()
      expect(relay.connections).toBe(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("returns to a device-less state on disconnect while the account stays signed in", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.store.disconnect()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().activeDeviceID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("signs the browser out on logout even though the account still owns a device", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      await test.store.logout()
      expect(test.store.state().connection).toEqual({ kind: "signed-out" })
      expect(test.store.state().owner).toBeUndefined()
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().activeDeviceID).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("reports remote access as not configured when the deployment has no API", async () => {
    // A static deployment answers /api/me with the single-page fallback document.
    const relay = await startRelayDouble({ me: "<!doctype html><html><body>app shell</body></html>", meStatus: 200 })
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    })
    try {
      await store.load()
      expect(store.state().connection).toEqual({ kind: "unavailable", reason: "not-configured" })
      // The connection state already explains itself in the status strip and empty state.
      expect(store.state().notice).toBeUndefined()
      expect(store.state().devices).toHaveLength(0)
      expect(store.state().sessions).toHaveLength(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("resumes a session with subscribe plus a canonical snapshot", async () => {
    const test = await harness({
      messages: {
        ses_a: [
          { id: "msg_1", type: "user", text: "Old prompt", time: { created: 1 } },
          { id: "msg_2", type: "assistant", agent: "god", content: [{ type: "text", text: "Old answer" }], time: { created: 2, completed: 3 } },
        ],
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const operations = test.relay.requests.map((request) => request.operation)
      expect(operations).toContain("session.subscribe")
      expect(operations).toContain("session.snapshot")
      expect(operations.indexOf("session.snapshot")).toBeGreaterThan(operations.indexOf("session.subscribe"))
      const view = test.store.state().view
      expect(view?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
      expect(view?.title).toBe("Alpha session")
      expect(view?.watermark).toBe(0)
      expect(view?.sourceEpoch).toBe("epoch_1")
    } finally {
      await test.stop()
    }
  })

  test("unsubscribes the previous session when the selection moves on", async () => {
    const test = await harness()
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(unsubscribes()).toHaveLength(0)

      await test.store.selectSession("ses_b")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")
    } finally {
      await test.stop()
    }
  })

  test("ends the previous stream when the next session is not available", async () => {
    const test = await harness({
      handler: (request) =>
        request.operation === "session.subscribe" && request.sessionID === "ses_b"
          ? { ok: false, code: "session_not_allowed", message: "Session is not served by the connected agent" }
          : "default",
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      await test.store.selectSession("ses_b")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().notice).toBe("This session is not available from the connected device.")
      expect(test.store.state().activeSessionID).toBe("ses_b")
    } finally {
      await test.stop()
    }
  })

  test("a superseded selection releases its own stream and keeps the winner's", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.subscribe") await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated subscribe for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => releases.has("ses_a"))
      const second = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The winner settles first, then the superseded selection resolves.
      release("ses_b")
      await second
      expect(test.store.state().activeSessionID).toBe("ses_b")

      release("ses_a")
      await first
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")

      // The winner still owns its registration, so the next move releases it.
      await test.store.selectSession("ses_a")
      await waitFor(() => unsubscribes().length === 2)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a", "ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the selection's replay window when a reload settles during it", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    let gateSnapshots = false
    const test = await harness({
      watermark: 10,
      messages: { ses_b: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: async (request) => {
        if (request.operation === "session.snapshot" && gateSnapshots) await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated snapshot for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      gateSnapshots = true
      const reload = test.store.reloadMessages()
      await waitFor(() => releases.has("ses_a"))
      const selection = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The reload settles while the selection's own snapshot is still open.
      release("ses_a")
      await reload
      test.relay.pushEvent("ses_b", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a1", ordinal: 0, delta: "STREAMED" },
      })
      await test.flush()
      release("ses_b")
      await selection
      await test.flush()

      expect(test.store.state().activeSessionID).toBe("ses_b")
      const messages = test.store.state().view?.messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_a1"])
      const streamed = messages.flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
      expect(streamed).toEqual(["STREAMED"])
    } finally {
      await test.stop()
    }
  })

  test("releases only what the current connection registered", async () => {
    const test = await harness()
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // Reconnecting replaces the socket, and the relay tracks subscriptions per socket.
      test.store.connect("dev_1")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      // The replaced socket publishes its close after the new one is live.
      await test.flush()

      await test.store.selectSession("ses_b")
      expect(unsubscribes()).toHaveLength(0)

      // The live connection still owns the session it registered.
      await test.store.selectSession("ses_a")
      await waitFor(() => unsubscribes().length === 1)
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_b"])
    } finally {
      await test.stop()
    }
  })

  test("keeps the winner's snapshot when a superseded selection settles later", async () => {
    const gates = new Map<string, Promise<void>>()
    const releases = new Map<string, () => void>()
    const gateFor = (sessionID: string) => {
      const open = gates.get(sessionID)
      if (open !== undefined) return open
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.set(sessionID, gate)
      releases.set(sessionID, release)
      return gate
    }
    const test = await harness({
      watermark: 10,
      messages: { ses_b: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
      handler: async (request) => {
        if (request.operation === "session.snapshot") await gateFor(request.sessionID ?? "")
        return "default" as const
      },
    })
    const release = (sessionID: string) => {
      const open = releases.get(sessionID)
      if (open === undefined) throw new Error(`no gated snapshot for ${sessionID}`)
      open()
    }
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => releases.has("ses_a"))
      const second = test.store.selectSession("ses_b")
      await waitFor(() => releases.has("ses_b"))

      // The superseded selection settles while the winner's snapshot is still open.
      release("ses_a")
      await first
      test.relay.pushEvent("ses_b", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_a1", ordinal: 0, delta: "STREAMED" },
      })
      await test.flush()
      release("ses_b")
      await second
      await test.flush()

      expect(test.store.state().activeSessionID).toBe("ses_b")
      const messages = test.store.state().view?.messages ?? []
      expect(messages.map((message) => message.id)).toEqual(["msg_1", "msg_a1"])
      const streamed = messages.flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
      expect(streamed).toEqual(["STREAMED"])
    } finally {
      await test.stop()
    }
  })

  test("scopes subscriptions to the connection that registered them", async () => {
    // The relay tracks a client's subscriptions per socket, so a replaced socket's
    // close says nothing about the connection that replaced it. This double holds
    // that close back to publish it after the replacement has registered, an
    // ordering a real socket cannot be asked to produce.
    const sockets: { readonly publish: (status: RemoteTransportStatus) => void; readonly unsubscribes: string[] }[] = []
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: "http://127.0.0.1:1" }),
      createTransport: (_deviceID, handlers) => {
        const socket = { publish: handlers.onStatus ?? (() => {}), unsubscribes: [] as string[] }
        sockets.push(socket)
        const transport: RemoteTransport = {
          connect: () => handlers.onStatus?.({ kind: "open" }),
          // The replaced socket reports nothing here; the case publishes it by hand.
          close: () => {},
          status: () => ({ kind: "open" }),
          request: async (operation, input) => {
            if (operation === "session.unsubscribe") socket.unsubscribes.push(String(input?.sessionID))
            if (operation === "session.snapshot") {
              return {
                status: "ok",
                value: {
                  session: { title: "t" },
                  messages: [],
                  watermark: { type: "log.synced", aggregateID: input?.sessionID, seq: 0 },
                },
              }
            }
            return { status: "ok", value: { data: {} } }
          },
        }
        return transport
      },
    })
    try {
      store.connect("dev_1")
      await store.selectSession("ses_a")
      expect(sockets).toHaveLength(1)
      expect(sockets[0]?.unsubscribes).toEqual([])

      store.connect("dev_1")
      await store.selectSession("ses_b")
      // The replacement never registered ses_a, so it must not release it.
      expect(sockets[1]?.unsubscribes).toEqual([])

      // The replaced socket's late close must not end the live connection's stream.
      sockets[0]?.publish({ kind: "closed", code: 1000, reason: "switching device", retryable: false })
      expect(store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await store.selectSession("ses_a")
      expect(sockets[1]?.unsubscribes).toEqual(["ses_b"])
    } finally {
      store.dispose()
    }
  })

  test("a replaced connection's late rejection cannot tear down the live connection", async () => {
    const test = await fakeConnectionHarness()
    const alertIDs = () => test.store.state().notifications.map((entry) => entry.id)
    try {
      await test.store.load()
      expect(test.sockets).toHaveLength(1)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await test.store.selectSession("ses_a")
      test.sockets[0]?.event("ses_a", { id: "evt_done", type: "session.execution.succeeded", data: {} })
      await test.flush()
      expect(alertIDs()).toEqual(["agent-completed"])

      // The device switch replaces the socket, so the alerts it raised end with it.
      test.store.connect("dev_1")
      expect(test.sockets).toHaveLength(2)
      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      await test.store.selectSession("ses_a")
      test.sockets[1]?.event("ses_a", { id: "evt_done_again", type: "session.execution.succeeded", data: {} })
      await test.flush()
      expect(alertIDs()).toEqual(["agent-completed"])

      // A late 4401 from the replaced socket must not sign the browser out or end
      // the alerts of the connection that replaced it.
      test.sockets[0]?.publish({ kind: "closed", code: 4401, reason: "Your session expired.", retryable: false })

      expect(test.store.state().connection).toEqual({ kind: "connected", deviceName: "dev_1" })
      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.id)).toEqual(["dev_1"])
      expect(test.store.state().activeDeviceID).toBe("dev_1")
      expect(alertIDs()).toEqual(["agent-completed"])
    } finally {
      await test.stop()
    }
  })

  test("a live device rejection tears down that device and refreshes the still-signed-in account", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await test.runUntil(() => test.store.state().connection.kind === "connected")

      test.relay.setMe({
        user: { id: "user_1" },
        session: { expiresAt: 4_102_444_800_000 },
        devices: [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "revoked", online: false }],
      })
      test.relay.dropConnections(4403, "device revoked")
      await test.runUntil(() => test.store.state().connection.kind === "no-device-enrolled")

      expect(test.store.state().owner?.id).toBe("user_1")
      expect(test.store.state().devices.map((device) => device.status)).toEqual(["revoked"])
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.store.state().sessions).toHaveLength(0)
      expect(test.store.state().advertised).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("ignores frames and reconnects from the connection that was replaced", async () => {
    const test = await fakeConnectionHarness()
    const streamed = () =>
      (test.store.state().view?.messages ?? []).flatMap((message) =>
        message.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text) : [],
      )
    try {
      await test.store.load()
      await test.store.selectSession("ses_a")
      test.store.connect("dev_1")
      await test.store.selectSession("ses_a")

      // The replacement advertises and streams its own state.
      test.sockets[1]?.sessions(["ses_b"])
      expect(test.store.state().advertised).toEqual([])
      test.sockets[1]?.event("ses_a", {
        id: "evt_live",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_live", ordinal: 0, delta: "LIVE" },
      })
      await test.flush()
      expect(streamed()).toEqual(["LIVE"])

      // Frames and a reconnect from the replaced socket must not reach the store.
      test.sockets[0]?.sessions(["ses_stale"])
      test.sockets[0]?.event("ses_a", {
        id: "evt_stale",
        type: "session.text.delta",
        data: { assistantMessageID: "msg_stale", ordinal: 0, delta: "STALE" },
      })
      test.sockets[0]?.reconnect()
      await test.flush()

      expect(test.store.state().advertised).toEqual([])
      expect(streamed()).toEqual(["LIVE"])
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("keeps a superseded selection's snapshot failure out of the winner's context", async () => {
    let releaseFirst: (() => void) | undefined
    const firstSnapshot = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.snapshot" && request.sessionID === "ses_a") {
          await firstSnapshot
          return { ok: false, code: "internal_error", message: "snapshot read failed" }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)

      const first = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot" && request.sessionID === "ses_a"))
      const second = test.store.selectSession("ses_b")
      await second
      await waitFor(() => test.store.state().view?.id === "ses_b")
      expect(test.store.state().notice).toBeUndefined()

      releaseFirst?.()
      await first

      // The failed read belonged to a selection the winner already replaced.
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().view?.id).toBe("ses_b")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("keeps a replaced connection's snapshot failure out of the new connection", async () => {
    const test = await harness({
      handler: async (request) => {
        // The old connection's read never settles on the relay; the device switch
        // closes the socket, which is what settles it in the transport.
        if (request.operation === "session.snapshot" && request.sessionID === "ses_a") await new Promise<void>(() => {})
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      const selection = test.store.selectSession("ses_a")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.snapshot" && request.sessionID === "ses_a"))

      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await selection
      await test.flush()

      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().activeSessionID).toBeUndefined()
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("does not let a replaced connection's session list repopulate the new connection", async () => {
    let lists = 0
    let active = 0
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list") {
          lists += 1
          if (lists === 1) {
            return { ok: true, value: { data: [{ id: "ses_a", title: "Old device session", time: { created: 1, updated: 1 } }] } }
          }
          return { ok: false, code: "internal_error", message: "the new device is not ready" }
        }
        if (String(request.operation) === "session.active") {
          active += 1
          // The old connection's active read stays open, so its list result settles
          // while the socket is still the one the store shows.
          if (active === 1) await new Promise<void>(() => {})
          return "default" as const
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => lists === 1 && active === 1)

      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && lists === 2)
      await test.flush()

      // The new connection has no list of its own yet; the replaced device's
      // sessions must not stand in for it.
      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().sessions).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("keeps the newest advertisement's list when an earlier read settles later", async () => {
    let lists = 0
    let releaseOlder: (() => void) | undefined
    const olderRead = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list") {
          lists += 1
          if (lists === 1) {
            await olderRead
            return { ok: true, value: { data: [{ id: "ses_a", title: "Older list", time: { created: 1, updated: 1 } }] } }
          }
          return { ok: true, value: { data: [{ id: "ses_b", title: "Newer list", time: { created: 1, updated: 2 } }] } }
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await test.runUntil(() => lists === 1)
      test.relay.pushSessions(["ses_b"])
      await test.runUntil(() => lists === 2)
      await test.runUntil(() => test.store.state().sessions.length === 1)
      expect(test.store.state().sessions[0]?.title).toBe("Newer list")

      releaseOlder?.()
      await Bun.sleep(50)

      expect(test.store.state().sessions.map((session) => session.title)).toEqual(["Newer list"])
    } finally {
      await test.stop()
    }
  })

  test("does not apply a superseded session's autonomy response to the current view", async () => {
    let releaseYolo: (() => void) | undefined
    const yolo = new Promise<void>((resolve) => {
      releaseYolo = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.autonomy.set") {
          await yolo
          return "default" as const
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      const pending = test.store.setYolo(3)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.autonomy.set"))

      // The user moves to another session while the reply is still in flight.
      await test.store.selectSession("ses_b")
      await waitFor(() => test.store.state().view?.id === "ses_b" && test.store.state().view?.autonomy?.yolo === 0)

      releaseYolo?.()
      await pending

      expect(test.store.state().view?.id).toBe("ses_b")
      expect(test.store.state().view?.autonomy).toMatchObject({ yolo: 0 })
    } finally {
      await test.stop()
    }
  })

  test("keeps a reconnect reload out of the connection that replaced it", async () => {
    let holdLists = false
    let held = 0
    const heldLists = new Promise<void>(() => {})
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.list" && holdLists) {
          held += 1
          await heldLists
        }
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      // The reconnect's own list read stays open across the device switch.
      holdLists = true
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => held >= 1)

      holdLists = false
      test.store.connect("dev_2")
      await test.runUntil(() => test.store.state().transport.kind === "open" && test.store.state().sessions.length > 0)
      await test.flush()

      expect(test.store.state().activeDeviceID).toBe("dev_2")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("releases the reconnect's own stream when the selection moved on", async () => {
    let subscribes = 0
    let releaseReconnect: (() => void) | undefined
    const reconnectSubscribe = new Promise<void>((resolve) => {
      releaseReconnect = resolve
    })
    const test = await harness({
      handler: async (request) => {
        if (request.operation === "session.subscribe") {
          subscribes += 1
          // The reconnect re-registers the session on the live socket, and the user
          // moves on before that response settles.
          if (subscribes === 2) await reconnectSubscribe
        }
        return "default" as const
      },
    })
    const unsubscribes = () => test.relay.requests.filter((request) => request.operation === "session.unsubscribe")
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")

      test.relay.dropConnections(1006, "")
      await test.runUntil(() => subscribes === 2)

      await test.store.selectSession("ses_b")
      expect(test.store.state().activeSessionID).toBe("ses_b")

      releaseReconnect?.()
      await waitFor(() => unsubscribes().some((request) => request.sessionID === "ses_a"))
      expect(unsubscribes().map((request) => request.sessionID)).toEqual(["ses_a"])
      expect(test.store.state().activeSessionID).toBe("ses_b")
      expect(test.store.state().notice).toBeUndefined()
    } finally {
      await test.stop()
    }
  })

  test("a deliberate disconnect keeps the device-less state after the socket's late close", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.store.disconnect()
      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })

      // The real socket publishes its close after the synchronous close() call.
      await waitFor(() => test.relay.closeEvents.length > 0)
      await test.flush()

      expect(test.store.state().connection).toEqual({ kind: "no-device-selected" })
      expect(test.store.state().activeDeviceID).toBeUndefined()
      expect(test.store.state().owner?.id).toBe("user_1")
    } finally {
      await test.stop()
    }
  })

  test("batches streamed deltas into one state notification and keeps tool output bounded", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      let notifications = 0
      const unsubscribe = test.store.subscribe(() => (notifications += 1))

      for (const delta of ["Hel", "lo ", "world"]) {
        test.relay.pushEvent("ses_a", { id: "evt_1", type: "session.text.delta", data: { assistantMessageID: "msg_a1", ordinal: 0, delta } })
      }
      test.relay.pushEvent("ses_a", {
        id: "evt_2",
        type: "session.tool.success",
        data: {
          assistantMessageID: "msg_a1",
          callID: "call_1",
          content: [{ type: "text", text: "x".repeat(9_000) }],
        },
      })
      expect(notifications).toBe(0)
      await test.flush()
      expect(notifications).toBe(1)

      const assistant = test.store.state().view?.messages.find((message) => message.id === "msg_a1")
      expect(assistant?.kind).toBe("assistant")
      if (assistant?.kind !== "assistant") return
      expect(assistant.parts[0]).toMatchObject({ kind: "text", text: "Hello world" })
      const tool = assistant.parts.find((part) => part.kind === "tool")
      expect(tool?.kind).toBe("tool")
      if (tool?.kind !== "tool") return
      expect(tool.content[0]?.kind).toBe("text")
      expect(tool.content[0]?.kind === "text" ? tool.content[0].text.length : 0).toBe(9_000)
      unsubscribe()
    } finally {
      await test.stop()
    }
  })

  test("sends a prompt with a durable message id and clears the mutation on success", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Run the tests", delivery: "queue" })
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.prompt"))
      const prompt = test.relay.requests.find((request) => request.operation === "session.prompt")
      expect(prompt?.input).toEqual({ id: "msg_local_1", text: "Run the tests", delivery: "queue" })
      expect(prompt?.sessionID).toBe("ses_a")
      expect(test.store.state().mutations).toHaveLength(0)
      expect(test.store.state().view?.messages.at(-1)).toMatchObject({ kind: "user", id: "msg_local_1", text: "Run the tests", delivery: "queue" })
    } finally {
      await test.stop()
    }
  })

  test("keeps an uncertain mutation visible and retries it with the same message id on demand", async () => {
    let closeOnPrompt = true
    const test = await harness({
      handler: (request) => {
        if (request.operation === "session.prompt" && closeOnPrompt) {
          closeOnPrompt = false
          return "close"
        }
        return "default"
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.sendPrompt({ text: "Deploy", delivery: "steer" })
      const mutation = test.store.state().mutations[0]
      expect(mutation?.state).toBe("unknown")
      expect(mutation?.detail).toContain("Outcome unknown")
      if (!mutation) throw new Error("expected an unsettled mutation")

      await test.runUntil(() => test.store.state().transport.kind === "open")
      await test.store.retryMutation(mutation.id)
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.prompt").length === 2)
      const prompts = test.relay.requests.filter((request) => request.operation === "session.prompt")
      expect(prompts).toHaveLength(2)
      expect(prompts[0]?.input?.id).toBe(prompts[1]?.input?.id)
      expect(test.store.state().mutations).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("replies to permission, guardrail, and native form requests with protocol payloads", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { id: "evt_p", type: "permission.v2.asked", data: { id: "per_1", action: "edit", resources: ["src/**"] } })
      test.relay.pushEvent("ses_a", {
        id: "evt_g",
        type: "guardrail.asked",
        data: { id: "grq_1", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: true },
      })
      test.relay.pushEvent("ses_a", {
        id: "evt_q",
        type: "form.created",
        data: {
          form: {
            id: "frm_1",
            sessionID: "ses_a",
            title: "Question",
            metadata: { kind: "question" },
            fields: [{ key: "q0", type: "string", title: "Which?", options: [{ value: "a", label: "A" }], custom: true }],
          },
        },
      })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.kind)).toEqual(["permission", "guardrail", "form"])

      await test.store.replyPermission("per_1", "once")
      await test.store.replyGuardrail("grq_1", "reject")
      await test.store.replyForm("frm_1", { q0: "a" })
      await waitFor(() => test.relay.requests.filter((request) => request.operation.endsWith(".reply")).length === 3)
      const replies = test.relay.requests.filter((request) => request.operation.endsWith(".reply"))
      expect(replies.map((request) => request.operation)).toEqual([
        "session.permission.reply",
        "session.guardrail.reply",
        "session.form.reply",
      ])
      expect(replies[0]?.input).toEqual({ requestID: "per_1", reply: "once" })
      expect(replies[1]?.input).toEqual({ requestID: "grq_1", reply: "reject" })
      expect(replies[2]?.input).toEqual({ formID: "frm_1", answer: { q0: "a" } })
    } finally {
      await test.stop()
    }
  })

  test("hydrates native forms, applies live settlement, and cancels with the form payload", async () => {
    const form = {
      id: "frm_seed",
      sessionID: "ses_a",
      title: "Question",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }], custom: true }],
    }
    const test = await harness({ forms: [form] })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests).toMatchObject([{ kind: "form", id: "frm_seed", form }])

      test.relay.pushEvent("ses_a", { id: "evt_form_live", type: "form.created", data: { form: { ...form, id: "frm_live" } } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed", "frm_live"])

      test.relay.pushEvent("ses_a", { id: "evt_form_replied", type: "form.replied", data: { id: "frm_live", sessionID: "ses_a", answer: { q0: "core" } } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed"])

      test.relay.pushEvent("ses_a", { id: "evt_form_cancelled_created", type: "form.created", data: { form: { ...form, id: "frm_cancelled" } } })
      test.relay.pushEvent("ses_a", { id: "evt_form_cancelled", type: "form.cancelled", data: { id: "frm_cancelled", sessionID: "ses_a" } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_seed"])

      await test.store.cancelForm("frm_seed")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.cancel"))
      expect(test.relay.requests.find((request) => request.operation === "session.form.cancel")?.input).toEqual({ formID: "frm_seed" })
      expect(test.store.state().view?.requests).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("reconciles live permission, hard-review, and Form changes over pending list reads", async () => {
    const form = {
      id: "frm_live",
      sessionID: "ses_a",
      title: "Question",
      fields: [{ key: "q0", type: "string", title: "Which?" }],
    }
    const permission = { id: "per_live", action: "edit", resources: ["src/**"] }
    const guardrail = {
      id: "grq_live", sessionID: "ses_a", rootSessionID: "ses_a",
      action: "rm -rf build", resources: ["build"], reason: "Human decision", hardReview: true,
    }
    for (const settling of [false, true]) {
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { release = resolve })
      const test = await harness({
        ...(settling ? { permissions: [permission], guardrailRequests: [guardrail], forms: [form] } : {}),
        handler: async (request) => {
          if (request.operation !== "session.form.list") return "default" as const
          await gate
          return "default" as const
        },
      })
      try {
        await test.store.load()
        await waitFor(() => test.store.state().sessions.length > 0)
        const selected = test.store.selectSession("ses_a")
        await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.list"))
        if (settling) {
          test.relay.pushEvent("ses_a", { type: "permission.v2.replied", data: { requestID: permission.id, reply: "reject" } })
          test.relay.pushEvent("ses_a", { type: "guardrail.replied", data: { requestID: guardrail.id, sessionID: "ses_a", rootSessionID: "ses_a", reply: "reject" } })
          test.relay.pushEvent("ses_a", { type: "form.cancelled", data: { id: form.id, sessionID: "ses_a" } })
        } else {
          test.relay.pushEvent("ses_a", { type: "permission.v2.asked", data: permission })
          test.relay.pushEvent("ses_a", { type: "guardrail.asked", data: guardrail })
          test.relay.pushEvent("ses_a", { type: "form.created", data: { form } })
        }
        await test.flush()
        const expected = settling ? [] : [permission.id, guardrail.id, form.id]
        expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(expected)
        release?.()
        await selected
        expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(expected)
        if (!settling) {
          expect(test.store.state().view?.requests.find((request) => request.id === guardrail.id)).toMatchObject({ hardReview: true })
        }
      } finally {
        release?.()
        await test.stop()
      }
    }
  })

  test("refuses foreign forms and does not let a stale form reply alter a newly selected session", async () => {
    const form = (id: string, sessionID: string) => ({
      id,
      sessionID,
      title: "Question",
      metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: "Which module?", options: [{ value: "core", label: "Core" }] }],
    })
    let releaseReply: (() => void) | undefined
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve
    })
    const test = await harness({
      forms: [form("frm_a", "ses_a"), form("frm_b", "ses_b")],
      handler: async (request) => {
        if (request.operation !== "session.form.reply") return "default" as const
        await replyGate
        return "default" as const
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_a"])

      test.relay.pushEvent("ses_a", { id: "evt_form_foreign", type: "form.created", data: { form: form("frm_foreign", "ses_b") } })
      await test.flush()
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_a"])

      const reply = test.store.replyForm("frm_a", { q0: "core" })
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.form.reply"))
      await test.store.selectSession("ses_b")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_b"])
      if (releaseReply === undefined) throw new Error("Reply gate was not initialized")
      releaseReply()
      await reply
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["frm_b"])

      await test.store.replyForm("frm_foreign", { q0: "core" })
      expect(test.relay.requests.filter((request) => request.operation === "session.form.reply")).toHaveLength(1)
      expect(test.store.state().notice).toContain("another session")
    } finally {
      await test.stop()
    }
  })

  test("removes a request locally after a successful reply and keeps it on failure", async () => {
    let failReply = false
    const test = await harness({
      permissions: [{ id: "per_1", action: "edit", resources: ["src/**"] }],
      guardrailRequests: [
        { id: "grq_1", sessionID: "ses_a", rootSessionID: "ses_a", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: false },
      ],
      handler: (request) =>
        failReply && request.operation === "session.permission.reply"
          ? { ok: false, code: "internal_error", message: "reply failed" }
          : "default",
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1", "grq_1"])

      await test.store.replyGuardrail("grq_1", "reject")
      await waitFor(() => test.store.state().view?.requests.length === 1)
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1"])

      failReply = true
      await test.store.replyPermission("per_1", "once")
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_1"])
      expect(test.store.state().mutations.some((mutation) => mutation.state === "failed")).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("sets YOLO, sets a goal, and stops it through the autonomy operations", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.setYolo(3)
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.autonomy.set"))
      expect(test.relay.requests.find((request) => request.operation === "session.autonomy.set")?.input).toEqual({ yolo: 3 })
      expect(test.store.state().view?.autonomy).toMatchObject({ yolo: 3 })

      await test.store.setGoal("Ship the remote workspace")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.set"))
      expect(test.relay.requests.filter((request) => request.operation === "session.goal.set").at(-1)?.input).toEqual({
        goal: "Ship the remote workspace",
      })
      expect(test.store.state().view?.autonomy).toMatchObject({ mode: "goal", goal: { text: "Ship the remote workspace" } })

      await test.store.stopGoal()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.goal.stop"))
      expect(test.relay.requests.find((request) => request.operation === "session.goal.stop")?.input).toEqual({ goal: null })
    } finally {
      await test.stop()
    }
  })

  test("interrupts the active session", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      await test.store.interrupt()
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.interrupt"))
      expect(test.relay.requests.find((request) => request.operation === "session.interrupt")?.sessionID).toBe("ses_a")
    } finally {
      await test.stop()
    }
  })

  test("reloads history read-only after a reconnect and leaves the caller's draft untouched", async () => {
    const test = await harness({
      messages: {
        ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }],
      },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const draft = "work in progress"
      test.relay.dropConnections(1006, "")
      await test.runUntil(
        () => test.store.state().transport.kind === "open" && test.store.state().notice?.includes("read-only") === true,
      )
      expect(test.store.state().notice).toContain("read-only")
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])
      expect(draft).toBe("work in progress")
      expect(test.relay.requests.filter((request) => request.operation === "session.subscribe").length).toBeGreaterThanOrEqual(2)
    } finally {
      await test.stop()
    }
  })

  test("counts unknown events instead of rendering them", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", { id: "evt_x", type: "session.experimental.future", data: { anything: true } })
      test.relay.pushEvent("ses_a", { id: "evt_y", type: "session.context.observed", data: { source: "session-state", text: "…" } })
      await test.flush()
      expect(test.store.state().unhandledEvents).toBe(1)
      expect(test.store.state().view?.messages).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("drops the browser session and devices when the rejected relay refresh finds an expired account", async () => {
    const test = await harness()
    try {
      await test.store.load()
      await waitFor(() => test.store.state().connection.kind === "connected")
      test.relay.setMe({ error: { code: "unauthorized", message: "Sign in required" } }, 401)
      test.relay.dropConnections(4401, "Your session expired.")
      await waitFor(() => test.store.state().connection.kind === "signed-out")
      expect(test.store.state().devices).toHaveLength(0)
      expect(test.store.state().advertised).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("seeds chips from the authoritative autonomy read and lists pending requests", async () => {
    const test = await harness({
      autonomy: { mode: "normal", yolo: 2, goal: { text: "Ship it", status: "active", iteration: 4, noProgress: 0, maxNoProgress: 5 } },
      permissions: [{ id: "per_1", action: "edit", resources: ["src/**"] }],
      guardrailRequests: [
        { id: "grq_mine", sessionID: "ses_a", rootSessionID: "ses_a", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: false },
        { id: "grq_child", sessionID: "ses_child", rootSessionID: "ses_a", action: "rm -rf dist", resources: ["dist"], reason: "Deletion", hardReview: true },
      ],
      forms: [
        {
          id: "frm_1",
          sessionID: "ses_a",
          title: "Question",
          metadata: { kind: "question" },
          fields: [{ key: "q0", type: "string", title: "Which?", options: [{ value: "a", label: "A" }], custom: true }],
        },
      ],
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      const view = test.store.state().view
      expect(view?.autonomy).toMatchObject({ mode: "goal", yolo: 2, goal: { iteration: 4 } })
      expect(view?.requests.map((request) => request.id)).toEqual(["per_1", "grq_mine", "grq_child", "frm_1"])
      const foreign = view?.requests.find((request) => request.id === "grq_child")
      expect(foreign && canReplyToRequest(foreign, "ses_a")).toBe(false)
      const mine = view?.requests.find((request) => request.id === "grq_mine")
      expect(mine && canReplyToRequest(mine, "ses_a")).toBe(true)

      await test.store.replyGuardrail("grq_child", "reject")
      expect(test.relay.requests.some((request) => request.operation === "session.guardrail.reply")).toBe(false)
      expect(test.store.state().notice).toContain("another session")

      await test.store.replyGuardrail("grq_mine", "once")
      await waitFor(() => test.relay.requests.some((request) => request.operation === "session.guardrail.reply"))
    } finally {
      await test.stop()
    }
  })

  test("drops events at or below the snapshot watermark and applies later ones", async () => {
    const test = await harness({
      watermark: 5,
      messages: { ses_a: [{ id: "msg_1", type: "user", text: "before", time: { created: 1 } }] },
    })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      expect(test.store.state().view?.watermark).toBe(5)

      test.relay.pushEvent("ses_a", {
        id: "evt_dup",
        type: "session.text.delta",
        durable: { aggregateID: "ses_a", seq: 5, version: 1 },
        data: { assistantMessageID: "msg_dup", ordinal: 0, delta: "duplicate" },
      })
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1"])

      test.relay.pushEvent("ses_a", {
        id: "evt_next",
        type: "session.text.delta",
        durable: { aggregateID: "ses_a", seq: 6, version: 1 },
        data: { assistantMessageID: "msg_2", ordinal: 0, delta: "fresh" },
      })
      await test.flush()
      expect(test.store.state().view?.messages.map((message) => message.id)).toEqual(["msg_1", "msg_2"])
      expect(test.store.state().view?.watermark).toBe(6)
    } finally {
      await test.stop()
    }
  })

  test("re-reads the snapshot when a durable gap is detected", async () => {
    const test = await harness({ watermark: 5 })
    try {
      await test.store.load()
      await waitFor(() => test.store.state().sessions.length > 0)
      await test.store.selectSession("ses_a")
      test.relay.pushEvent("ses_a", {
        id: "evt_gap",
        type: "session.execution.started",
        durable: { aggregateID: "ses_a", seq: 9, version: 1 },
        data: {},
      })
      await test.flush()
      await waitFor(() => test.relay.requests.filter((request) => request.operation === "session.snapshot").length >= 2)
      expect(test.store.state().notice).toContain("missed")
    } finally {
      await test.stop()
    }
  })
})
