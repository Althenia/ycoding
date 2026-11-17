import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import type { RemoteTransportHandlers } from "../src/remote/transport"

function connectedStore(onCompact?: (input: Readonly<Record<string, unknown>> | undefined) => Promise<never>) {
  const handlers = new Map<string, RemoteTransportHandlers>()
  const requests: string[] = []
  const store = createRemoteStore({
    http: createRemoteHttp(),
    batchMs: 0,
    createTransport: (deviceID, callbacks) => {
      handlers.set(deviceID, callbacks)
      return {
        connect: () => callbacks.onStatus?.({ kind: "open" }),
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation, request) => {
          requests.push(operation)
          if (operation === "session.compact" && onCompact) return onCompact(request?.input)
          if (operation === "session.snapshot")
            return { status: "ok" as const, value: {
              sourceEpoch: "epoch_1", session: { id: "ses_a", title: "Root", time: { created: 1, updated: 1 } },
              messages: [], watermark: { type: "log.synced", aggregateID: "ses_a", seq: 0 },
            } }
          if (operation === "notice.subscribe") return { status: "ok" as const, value: { notices: [], total: 0, unavailable: false } }
          if (operation === "session.autonomy.get") return { status: "ok" as const, value: { data: { mode: "normal", permissions: "manual", guardrails: "manual", answers: "manual", effective: { permissions: "manual", guardrails: "manual", answers: "manual", inherited: {}, deferred: false, guardrailsEnabled: true } } } }
          return { status: "ok" as const, value: { data: [] } }
        },
      }
    },
  })
  return { store, handlers, requests }
}

const todo = (content: string) => ({ type: "todo.updated", data: { sessionID: "ses_a", todos: [{ content, status: "pending", priority: "high" }] } })

test("a synthetic streaming burst preserves delta order with one publication and no extra reads", async () => {
  const { store, handlers, requests } = connectedStore()
  try {
    store.connect("dev_1")
    await store.selectSession("ses_a")
    const before = requests.length
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications += 1 })
    const chunks = Array.from({ length: 128 }, (_, index) => `${index},`)
    handlers.get("dev_1")?.onEvents?.("ses_a", [
      { type: "session.text.started", data: { assistantMessageID: "msg_stream", ordinal: 0 } },
      ...chunks.map((delta) => ({ type: "session.text.delta", data: { assistantMessageID: "msg_stream", ordinal: 0, delta } })),
    ])
    await Bun.sleep(20)
    const message = store.state().view?.messages.find((entry) => entry.id === "msg_stream")
    expect(message?.kind).toBe("assistant")
    expect(message?.kind === "assistant" ? message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("") : undefined).toBe(chunks.join(""))
    expect(publications).toBe(1)
    expect(requests.length).toBe(before)
    unsubscribe()
  } finally { store.dispose() }
})

test("replaced device callbacks cannot publish streamed content into the selected device", async () => {
  const { store, handlers } = connectedStore()
  try {
    store.connect("dev_1")
    await store.selectSession("ses_a")
    const retired = handlers.get("dev_1")
    store.connect("dev_2")
    await store.selectSession("ses_a")
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications += 1 })
    retired?.onEvents?.("ses_a", [todo("Retired device")])
    await Bun.sleep(20)
    expect(store.state().activeDeviceID).toBe("dev_2")
    expect(store.state().todos?.[0]?.content).not.toBe("Retired device")
    expect(publications).toBe(0)
    handlers.get("dev_2")?.onEvents?.("ses_a", [todo("Current device")])
    await Bun.sleep(20)
    expect(store.state().todos?.[0]?.content).toBe("Current device")
    expect(publications).toBe(1)
    unsubscribe()
  } finally { store.dispose() }
})

test("one relay events batch yields one store notification", async () => {
  const { store, handlers } = connectedStore()
  try {
    store.connect("dev_1")
    await store.selectSession("ses_a")
    let notifications = 0
    const unsubscribe = store.subscribe(() => { notifications += 1 })
    handlers.get("dev_1")?.onEvents?.("ses_a", [todo("First"), todo("Second"), todo("Third")])
    await Bun.sleep(20)
    expect(store.state().todos?.[0]?.content).toBe("Third")
    expect(notifications).toBe(1)
    unsubscribe()
  } finally { store.dispose() }
})

test("the exposed container is the single state authority and a disposed store stops notifying", async () => {
  const { store } = connectedStore()
  store.connect("dev_1")
  await store.selectSession("ses_a")
  expect(store.container.state).toBe(store.state())
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.dispose()
  const afterDispose = notifications
  store.container.setState((previous) => ({ ...previous, notice: "late" }))
  expect(notifications).toBe(afterDispose)
})

test("a compaction settled by an events batch publishes with that batch, never before it", async () => {
  const requested = Promise.withResolvers<Readonly<Record<string, unknown>> | undefined>()
  const { store, handlers } = connectedStore((input) => {
    requested.resolve(input)
    return new Promise<never>(() => {})
  })
  try {
    store.connect("dev_1")
    await store.selectSession("ses_a")
    const compacting = store.compactSession()
    const jobID = (await requested.promise)?.id
    const published: { readonly todo: string | undefined; readonly pending: number }[] = []
    const unsubscribe = store.subscribe(() => { published.push({ todo: store.state().todos?.[0]?.content, pending: store.state().mutations.length }) })
    handlers.get("dev_1")?.onEvents?.("ses_a", [todo("First"), { type: "session.compaction.ended", data: { jobID } }])
    expect(await compacting).toBe(true)
    expect(published[0]).toEqual({ todo: "First", pending: 0 })
    unsubscribe()
  } finally { store.dispose() }
})
