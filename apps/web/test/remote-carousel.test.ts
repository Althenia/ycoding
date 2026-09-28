import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const root = (id: string, updated: number, pinned?: number) => ({
  id: `ses_${id}`, title: id, projectID: "prj_test", location: { directory: "/work" },
  time: { created: updated, updated, ...(pinned === undefined ? {} : { pinned }) },
})

test("carousel ranks every running family before recent roots regardless of pin and caps at ten", async () => {
  const running = [root("running_old", 10, 1), root("running_new", 300)]
  const recent = Array.from({ length: 12 }, (_, index) => root(`recent_${index}`, 290 - index * 10, index === 11 ? 1 : undefined))
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: running.map((item) => item.id), attention: [] } }
    if (request.operation !== "session.list" || request.input?.workspace !== undefined) return "default"
    if (request.input?.status === "running") return { ok: true, value: { data: request.input.order === "desc" ? [running[1], running[0]] : [running[1]], cursor: {} } }
    if (request.input?.status === "idle") return { ok: true, value: { data: recent.slice(0, Number(request.input.limit)), cursor: {} } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  try {
    await store.load()
    await waitFor(() => (store.state().carouselSessions?.length ?? 0) > 0)
    expect(store.state().carouselSessions?.map((session) => session.id)).toEqual([
      "ses_running_new", "ses_running_old", "ses_recent_0", "ses_recent_1", "ses_recent_2", "ses_recent_3", "ses_recent_4", "ses_recent_5", "ses_recent_6", "ses_recent_7",
    ])
    expect(store.state().carouselSessions?.map((session) => session.running)).toEqual([true, true, false, false, false, false, false, false, false, false])
    expect(relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace === undefined).map((request) => request.input)).toEqual([
      expect.objectContaining({ order: "desc", status: "running", parentID: null, limit: 10 }),
      expect.objectContaining({ order: "desc", status: "idle", parentID: null, limit: 10 }),
    ])
  } finally { store.dispose(); await relay.stop() }
}, 15_000)

test("carousel limits twelve running roots to the ten most recently active", async () => {
  const running = Array.from({ length: 12 }, (_, index) => root(`running_${index}`, 120 - index * 10, index === 11 ? 1 : undefined))
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: running.map((item) => item.id), attention: [] } }
    if (request.operation !== "session.list" || request.input?.workspace !== undefined) return "default"
    if (request.input?.status === "running") return { ok: true, value: { data: request.input.order === "desc" ? running.slice(0, Number(request.input.limit)) : [running[11], ...running.slice(0, 11)], cursor: {} } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  try {
    await store.load()
    await waitFor(() => (store.state().carouselSessions?.length ?? 0) > 0)
    expect(store.state().carouselSessions?.map((session) => session.id)).toEqual(Array.from({ length: 10 }, (_, index) => `ses_running_${index}`))
    expect(relay.requests.some((request) => request.operation === "session.list" && request.input?.status === "idle" && request.input?.workspace === undefined)).toBe(false)
  } finally { store.dispose(); await relay.stop() }
}, 15_000)

test("carousel shows recent idle roots without a running family and refreshes after an inventory change", async () => {
  const pinned = root("pinned_old", 10, 1)
  const recent = root("recent", 100)
  const newest = root("newest", 200)
  let idle = [recent, pinned]
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
    if (request.operation === "session.list" && request.input?.status === "running") return { ok: true, value: { data: [] } }
    if (request.operation === "session.list" && request.input?.status === "idle") return { ok: true, value: { data: idle } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  try {
    await store.load()
    await waitFor(() => store.state().carouselSessions?.length === 2)
    expect(store.state().carouselSessions?.map((session) => [session.id, session.running])).toEqual([
      ["ses_recent", false], ["ses_pinned_old", false],
    ])
    idle = [newest, recent, pinned]
    relay.pushSessions([newest.id])
    await waitFor(() => store.state().carouselSessions?.[0]?.id === newest.id, 6_500)
    expect(store.state().carouselSessions?.map((session) => session.id)).toEqual(["ses_newest", "ses_recent", "ses_pinned_old"])
  } finally { store.dispose(); await relay.stop() }
}, 8_000)

test("a failed recent read keeps known running cards visible and reports the failure", async () => {
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: [] } }
    if (request.operation === "session.list" && request.input?.status === "running") return { ok: true, value: { data: [root("running", 100)] } }
    if (request.operation === "session.list" && request.input?.status === "idle") return { ok: false, code: "internal_error", message: "Recent list unavailable" }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  try {
    await store.load()
    await waitFor(() => store.state().notice?.includes("Recent list unavailable") === true)
    expect(store.state().carouselSessions?.map((session) => [session.id, session.running])).toEqual([["ses_running", true]])
  } finally { store.dispose(); await relay.stop() }
})

test("a superseded running read does not issue a stale idle query", async () => {
  const first = Promise.withResolvers<void>()
  let runningID = "ses_old"
  let runningReads = 0
  let idleReads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: [runningID], attention: [] } }
    if (request.operation === "session.list" && request.input?.status === "running") {
      const id = runningID
      runningReads += 1
      if (runningReads === 1) await first.promise
      return { ok: true, value: { data: [root(id.slice(4), 100)] } }
    }
    if (request.operation === "session.list" && request.input?.status === "idle") { idleReads += 1; return { ok: true, value: { data: [] } } }
    return "default" as const
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  try {
    await store.load()
    await waitFor(() => runningReads === 1)
    runningID = "ses_new"
    relay.pushStatus([runningID], [])
    first.resolve()
    await waitFor(() => store.state().carouselSessions?.[0]?.id === runningID, 6_500)
    expect(idleReads).toBe(1)
  } finally { first.resolve(); store.dispose(); await relay.stop() }
}, 8_000)

test("a superseded idle read cannot publish stale carousel rows", async () => {
  const first = Promise.withResolvers<void>()
  let runningID = "ses_old"
  let idleReads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: [runningID], attention: [] } }
    if (request.operation === "session.list" && request.input?.status === "running") return { ok: true, value: { data: [root(runningID.slice(4), 100)] } }
    if (request.operation === "session.list" && request.input?.status === "idle") {
      idleReads += 1
      if (idleReads === 1) { await first.promise; return { ok: true, value: { data: [root("stale_idle", 90)] } } }
      return { ok: true, value: { data: [root("fresh_idle", 110)] } }
    }
    return "default" as const
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  const seen: string[][] = []
  const unsubscribe = store.subscribe(() => seen.push(store.state().carouselSessions?.map((session) => session.id) ?? []))
  try {
    await store.load()
    await waitFor(() => idleReads === 1)
    runningID = "ses_new"
    relay.pushStatus([runningID], [])
    first.resolve()
    await waitFor(() => store.state().carouselSessions?.[0]?.id === runningID, 6_500)
    expect(store.state().carouselSessions?.map((session) => session.id)).toEqual(["ses_new", "ses_fresh_idle"])
    expect(seen.some((ids) => ids.includes("ses_stale_idle"))).toBe(false)
  } finally { first.resolve(); unsubscribe(); store.dispose(); await relay.stop() }
}, 8_000)
