import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import type { TodoView } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import type { RemoteTransportHandlers } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome } from "./relay-double"

const first = { content: "First", status: "pending", priority: "high" } as const
const second = { content: "Second", status: "in_progress", priority: "medium" } as const

test("a connector that never answers todo.list does not hold Session hydration or raise a state notice", async () => {
  const pending = Promise.withResolvers<{ readonly status: "ok"; readonly value: unknown }>()
  const store = createRemoteStore({ http: createRemoteHttp(), createTransport: (_deviceID, handlers) => ({
    connect: () => handlers.onStatus?.({ kind: "open" }), close: () => {}, status: () => ({ kind: "open" }),
    request: async (operation) => {
      if (operation === "session.snapshot") return { status: "ok" as const, value: {
        sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
        messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 },
      } }
      if (operation === "session.todo.list") return pending.promise
      if (operation === "notice.subscribe") return { status: "ok" as const, value: { notices: [], total: 0, unavailable: false } }
      if (operation === "session.autonomy.get") return { status: "ok" as const, value: { data: { mode: "normal", yolo: 0 } } }
      return { status: "ok" as const, value: { data: [] } }
    },
  }) })
  try {
    store.connect("dev_1")
    const selecting = store.selectSession("ses_a")
    expect(await Promise.race([selecting.then(() => true), Bun.sleep(150).then(() => false)])).toBe(true)
    expect(store.state().view?.id).toBe("ses_a")
    expect(store.state().view?.requests).toEqual([])
    expect(store.state().view?.autonomy?.mode).toBe("normal")
    expect(store.state().notice).toBeUndefined()
    expect(store.state().todos).toBeUndefined()
  } finally { pending.resolve({ status: "ok", value: { data: [] } }); store.dispose() }
})

test("selection reads todos, live updates replace the list, and reconnect reads again", async () => {
  let listed: readonly TodoView[] = [first]
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a", "ses_b"], handler: (request) =>
    request.operation === "session.todo.list" ? { ok: true, value: { data: listed } } : "default" })
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20 }),
    batchMs: 0,
  })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length > 0)
    await store.selectSession("ses_a")
    expect(store.state().todos).toEqual([first])
    relay.pushEvent("ses_b", { type: "todo.updated", data: { sessionID: "ses_b", todos: [second] } })
    await Bun.sleep(20)
    expect(store.state().todos).toEqual([first])
    relay.pushEvent("ses_a", { type: "todo.updated", data: { sessionID: "ses_a", todos: [second] } })
    await waitFor(() => store.state().todos?.[0]?.content === "Second")
    listed = [first, second]
    relay.dropConnections(1012, "restart")
    await waitFor(() => store.state().todos?.length === 2)
    listed = []
    await store.selectSession("ses_b")
    expect(store.state().todos).toEqual([])
  } finally {
    store.dispose()
    await relay.stop()
  }
})

test("a live todo update wins over a pending older list response", async () => {
  const held = Promise.withResolvers<RelayHandlerOutcome>()
  const relay = await startRelayDouble({ handler: (request) => request.operation === "session.todo.list" ? held.promise : "default" })
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }),
    batchMs: 0,
  })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length > 0)
    const selecting = store.selectSession("ses_a")
    await waitFor(() => relay.requests.some((request) => request.operation === "session.todo.list"))
    relay.pushEvent("ses_a", { type: "todo.updated", data: { sessionID: "ses_a", todos: [second] } })
    await waitFor(() => store.state().todos?.[0]?.content === "Second")
    held.resolve({ ok: true, value: { data: [first] } })
    await selecting
    expect(store.state().todos).toEqual([second])
  } finally {
    held.resolve("default")
    store.dispose()
    await relay.stop()
  }
})

test("a superseded same-Session read cannot overwrite reconnect's newer todo list", async () => {
  const held = Promise.withResolvers<{ readonly status: "ok"; readonly value: unknown }>()
  let handlers: RemoteTransportHandlers | undefined
  let reads = 0
  const store = createRemoteStore({
    http: createRemoteHttp(),
    createTransport: (_deviceID, callbacks) => {
      handlers = callbacks
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }),
        close: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation) => {
          if (operation === "session.snapshot") return { status: "ok" as const, value: {
            sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
            messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 },
          } }
          if (operation === "session.todo.list") return ++reads === 1 ? held.promise : { status: "ok" as const, value: { data: [second] } }
          return { status: "ok" as const, value: { data: [] } }
        },
      }
    },
  })
  try {
    store.connect("dev_1")
    const selecting = store.selectSession("ses_a")
    await waitFor(() => reads === 1)
    handlers?.onReconnect?.()
    await waitFor(() => reads === 2 && store.state().todos?.[0]?.content === "Second")
    held.resolve({ status: "ok", value: { data: [first] } })
    await selecting
    expect(store.state().todos).toEqual([second])
  } finally {
    held.resolve({ status: "ok", value: { data: [first] } })
    store.dispose()
  }
})
