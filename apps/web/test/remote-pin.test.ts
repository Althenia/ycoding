import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayHandlerOutcome } from "./relay-double"

test("a pin refresh supersedes an older in-flight Session list", async () => {
  const held = Promise.withResolvers<RelayHandlerOutcome>()
  let holdNext = false
  let pinned = false
  const row = (isPinned: boolean) => ({ id: "ses_a", title: "Alpha session", time: { created: 1, updated: 2, ...(isPinned ? { pinned: 10 } : {}) } })
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.list") {
      if (holdNext) { holdNext = false; return held.promise }
      return { ok: true, value: { data: [row(pinned)] } }
    }
    if (request.operation === "session.pin") { pinned = true; return { ok: true, value: null } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }), batchMs: 0 })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.some((session) => session.id === "ses_a"))
    holdNext = true
    const before = relay.requests.filter((request) => request.operation === "session.list").length
    store.searchSessions("Alpha")
    await waitFor(() => relay.requests.filter((request) => request.operation === "session.list").length > before)
    expect((await store.pinSession("ses_a", true)).status).toBe("ok")
    await waitFor(() => store.state().sessions[0]?.pinnedAt === 10)
    held.resolve({ ok: true, value: { data: [row(false)] } })
    await waitFor(() => !store.state().sessionPageLoading)
    expect(store.state().sessions[0]?.pinnedAt).toBe(10)
  } finally { held.resolve("default"); store.dispose(); await relay.stop() }
})

test("a connection closed during pinning reports an unknown outcome without changing Sessions", async () => {
  const held = Promise.withResolvers<RelayHandlerOutcome>()
  const relay = await startRelayDouble({ handler: (request) => request.operation === "session.pin" ? held.promise : "default" })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }), batchMs: 0 })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.some((session) => session.id === "ses_a"))
    const pending = store.pinSession("ses_a", true)
    await waitFor(() => relay.requests.some((request) => request.operation === "session.pin"))
    store.disconnect()
    expect((await pending).status).toBe("unknown")
    expect(store.state().sessions).toEqual([])
  } finally { held.resolve("default"); store.dispose(); await relay.stop() }
})
