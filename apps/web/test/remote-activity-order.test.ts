import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { createRemoteStoreClock } from "./remote-store-clock"
import { listPage, parseListQuery } from "../../../packages/cli/src/remote-operations"
import { startRelayDouble, waitFor, type RelayRequestHandler } from "./relay-double"

const workspace = { id: "wsp_fixture", projectID: "prj_fixture", directory: "/fixture/project" }
const row = (id: string, active: number | undefined, updated: number, pinned?: number) => ({ id, title: id, projectID: workspace.projectID, location: { directory: workspace.directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated, ...(active === undefined ? {} : { active }), ...(pinned === undefined ? {} : { pinned }) } })
const rows = [row("ses_pinned", 1, 900, 1), row("ses_edited", 2, 1000), row("ses_recent", 500, 500), row("ses_running", 0, 1), row("ses_Z", 100, 100), row("ses_a", 100, 100), row("ses_missing", undefined, 200)]

async function harness(handler: RelayRequestHandler = () => "default", clock?: ReturnType<typeof createRemoteStoreClock>) {
  const relay = await startRelayDouble({ advertisedSessions: rows.map((item) => item.id), handler: (request) => {
    const custom = handler(request)
    if (custom !== "default") return custom
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: [] } }
    if (request.operation === "session.list") return { ok: true, value: { data: request.input?.status === "running" ? rows.filter((item) => item.id === "ses_running") : request.input?.status === "idle" ? rows.filter((item) => item.id !== "ses_running") : rows } }
    if (request.operation === "session.get") return { ok: true, value: { data: rows.find((item) => item.id === request.sessionID) } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), batchMs: 1,
    ...(clock === undefined ? {} : { schedule: clock.schedule, monotonicNow: clock.now }) })
  await store.load()
  await waitFor(() => store.state().sessions.length === rows.length && store.state().carouselStatus === "ready")
  return { store, relay, close: async () => { store.dispose(); await relay.stop() } }
}

test("Session list and bounded carousel prioritize canonical running then actual activity, not pins or metadata edits", async () => {
  const h = await harness()
  try {
    const expected = ["ses_running", "ses_recent", "ses_missing", "ses_Z", "ses_a", "ses_edited", "ses_pinned"]
    expect(h.store.state().sessions.map((item) => item.id)).toEqual(expected)
    expect(h.store.state().carouselSessions?.map((item) => item.id)).toEqual(expected)
    expect(h.relay.requests.filter((request) => request.operation === "session.list").every((request) => request.input?.order === "active")).toBe(true)
    expect(h.store.state().sessions.find((item) => item.id === "ses_missing")?.activeAt).toBeUndefined()
    h.relay.pushStatus(["ses_pinned"], [])
    await waitFor(() => h.store.state().sessions[0]?.id === "ses_pinned")
    expect(h.store.state().sessions.slice(1).map((item) => item.id)).toEqual(["ses_recent", "ses_missing", "ses_Z", "ses_a", "ses_edited", "ses_running"])
  } finally { await h.close() }
})

test("settled activity reorders both visible collections without erasing rows or fabricating model timing", async () => {
  const h = await harness()
  try {
    await h.store.selectSession("ses_pinned")
    h.relay.pushEvent("ses_pinned", { type: "session.execution.succeeded", created: 600, data: {} })
    await waitFor(() => h.store.state().view?.activeAt === 600)
    expect(h.store.state().sessions.slice(0, 2).map((item) => item.id)).toEqual(["ses_running", "ses_pinned"])
    expect(h.store.state().carouselSessions?.slice(0, 2).map((item) => item.id)).toEqual(["ses_running", "ses_pinned"])
    expect(h.store.state().sessions).toHaveLength(rows.length)
    expect(h.store.state().view?.executionStarted).toBeUndefined()
  } finally { await h.close() }
})

test("a selected root injected outside the current page retains activity position and cursor pages omit no loaded rows", async () => {
  let selected = false
  const extra = row("ses_page2", 150, 150)
  const h = await harness((request) => {
    if (request.operation !== "session.list" || request.input?.workspace === undefined || !selected) return "default"
    return { ok: true, value: { data: request.input?.cursor === "next_fixture" ? [extra] : rows.filter((item) => item.id !== "ses_edited"), cursor: request.input?.cursor === "next_fixture" ? { previous: "prev_fixture" } : { next: "next_fixture" } } }
  })
  try {
    await h.store.selectSession("ses_edited")
    selected = true
    h.relay.pushSessions(rows.map((item) => item.id))
    await waitFor(() => h.store.state().sessionHasNext)
    expect(h.store.state().sessions.at(-2)?.id).toBe("ses_edited")
    await h.store.nextSessionsPage()
    expect(h.store.state().sessions.map((item) => item.id)).toEqual(["ses_running", "ses_recent", "ses_missing", "ses_page2", "ses_Z", "ses_a", "ses_edited", "ses_pinned"])
  } finally { await h.close() }
})

test("canonical root running can represent a live background shell without starting a model execution", async () => {
  const h = await harness()
  try {
    await h.store.selectSession("ses_running")
    expect(h.store.state().view?.status).toBe("running")
    expect(h.store.state().view?.executionStarted).toBeUndefined()
    h.relay.pushEvent("ses_running", { type: "session.execution.succeeded", created: 700, data: {} })
    await waitFor(() => h.store.state().view?.activeAt === 700)
    expect(h.store.state().view?.status).toBe("running")
    expect(h.store.state().carouselSessions?.find((item) => item.id === "ses_running")?.running).toBe(true)
    h.relay.pushStatus([], [])
    await waitFor(() => h.store.state().view?.status === "idle")
    expect(h.store.state().view?.executionStarted).toBeUndefined()
  } finally { await h.close() }
})

test("waiting status and failure-only transitions reorder every collection and an injected open root", async () => {
  let omitOpen = false
  const h = await harness((request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: ["ses_edited", "ses_pinned"], failed: ["ses_pinned"] } }
    if (request.operation === "session.list" && request.input?.workspace !== undefined && omitOpen)
      return { ok: true, value: { data: rows.filter((row) => row.id !== "ses_edited") } }
    if (request.operation === "session.list" && request.input?.status === "waiting") return { ok: true, value: { data: rows.filter((row) => row.id === "ses_edited") } }
    return "default"
  })
  try {
    const expected = ["ses_edited", "ses_running", "ses_recent", "ses_missing", "ses_Z", "ses_a", "ses_pinned"]
    expect(h.store.state().sessions.map((row) => row.id)).toEqual(expected)
    expect(h.store.state().carouselSessions?.map((row) => row.id)).toEqual(expected)
    await h.store.selectSession("ses_edited")
    omitOpen = true
    h.relay.pushSessions(rows.map((row) => row.id))
    await waitFor(() => h.relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined).length >= 2)
    await waitFor(() => h.store.state().sessionListStatus === "ready")
    expect(h.store.state().sessions.map((row) => row.id)).toEqual(expected)
    h.relay.pushStatus(["ses_running"], ["ses_edited", "ses_pinned"], [], ["ses_edited", "ses_pinned"])
    await waitFor(() => h.store.state().sessions[0]?.id === "ses_running")
    expect(h.store.state().carouselSessions?.[0]?.id).toBe("ses_running")
    h.relay.pushStatus(["ses_running"], ["ses_edited", "ses_pinned"], [], ["ses_pinned"])
    await waitFor(() => h.store.state().sessions[0]?.id === "ses_edited")
    expect(h.store.state().carouselSessions?.[0]).toMatchObject({ id: "ses_edited", attention: true, failed: false })
  } finally { await h.close() }
})

test("waiting-only changes refresh filtered pages and discover previously unloaded carousel roots", async () => {
  const clock = createRemoteStoreClock()
  let attention = ["ses_edited"]
  const extra = row("ses_unloaded", 0, 0)
  const h = await harness((request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention } }
    if (request.operation !== "session.list") return "default"
    if (request.input?.status === "waiting") return { ok: true, value: { data: [...rows, extra].filter((row) => attention.includes(row.id)) } }
    return "default"
  }, clock)
  try {
    h.store.searchSessions("", "waiting")
    await clock.advanceBy(1_000)
    await waitFor(() => h.store.state().sessionListStatus === "ready" && h.store.state().sessionFilter === "waiting")
    expect(h.store.state().sessions.map((row) => row.id)).toEqual(["ses_edited"])
    attention = [extra.id]
    h.relay.pushStatus(["ses_running"], attention)
    await waitFor(() => h.store.state().sessionStatus?.attention.has(extra.id) === true)
    expect(h.store.state().sessions.some((row) => row.id === "ses_edited")).toBe(false)
    await clock.advanceBy(5_000)
    await waitFor(() => h.store.state().sessions[0]?.id === extra.id && h.store.state().carouselSessions?.[0]?.id === extra.id)
    expect(h.store.state().sessions.map((row) => row.id)).toEqual([extra.id])
    expect(h.relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined).at(-1)?.input?.status).toBe("waiting")
    attention = []
    h.relay.pushStatus(["ses_running"], [])
    await waitFor(() => h.store.state().sessionStatus?.attention.size === 0)
    expect(h.store.state().sessions).toEqual([])
    await clock.advanceBy(5_000)
    await waitFor(() => h.store.state().carouselSessions?.[0]?.id === "ses_running")
  } finally { await h.close() }
})

test.each(["waiting", "running"] as const)("real connector pages remain complete through moving %s groups after store ID dedupe", async (group) => {
  const inventory = Array.from({ length: 100 }, (_, index) => row(`ses_move_${String(index).padStart(3, "0")}`, index === 80 ? 2_000 : 1_000 - index, 1_000 - index))
  let waiting = new Set(group === "waiting" ? inventory.slice(0, 25).map((row) => row.id) : [])
  let running = new Set(inventory.slice(0, group === "waiting" ? 50 : 25).map((row) => row.id))
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [...running], attention: [...waiting] } }
    if (request.operation === "session.list") return { ok: true, value: listPage(inventory, parseListQuery({ ...request.input, workspace: undefined }), running, waiting) }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  const seen = new Set<string>()
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length === 25 && store.state().carouselStatus === "ready")
    store.state().sessions.forEach((row) => seen.add(row.id))
    if (group === "waiting") waiting = new Set([...waiting].filter((id) => id !== inventory[0]!.id).concat(inventory[80]!.id))
    if (group === "running") running = new Set([...running].filter((id) => id !== inventory[0]!.id).concat(inventory[80]!.id))
    for (let page = 0; page < 10 && store.state().sessionHasNext; page += 1) {
      await store.nextSessionsPage()
      const ids = store.state().sessions.map((row) => row.id)
      expect(new Set(ids).size).toBe(ids.length)
      ids.forEach((id) => seen.add(id))
    }
    expect([...seen].sort()).toEqual(inventory.map((row) => row.id).sort())
    const backwards = new Set(store.state().sessions.map((row) => row.id))
    for (let page = 0; page < 10 && store.state().sessionHasPrevious; page += 1) {
      await store.previousSessionsPage()
      const ids = store.state().sessions.map((row) => row.id)
      expect(new Set(ids).size).toBe(ids.length)
      ids.forEach((id) => backwards.add(id))
    }
    expect([...backwards].sort()).toEqual(inventory.map((row) => row.id).sort())
  } finally { store.dispose(); await relay.stop() }
})

test("status refresh retains a loaded multi-page window instead of collapsing it to page one", async () => {
  const inventory = Array.from({ length: 100 }, (_, index) => row(`ses_keep_${String(index).padStart(3, "0")}`, 1_000 - index, 1_000 - index))
  let waiting = new Set<string>()
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [...waiting] } }
    if (request.operation === "session.list") return { ok: true, value: listPage(inventory, parseListQuery({ ...request.input, workspace: undefined }), new Set(), waiting) }
    return "default"
  } })
  const clock = createRemoteStoreClock()
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), schedule: clock.schedule, monotonicNow: clock.now })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length === 25 && store.state().carouselStatus === "ready")
    await store.nextSessionsPage()
    expect(store.state().sessions).toHaveLength(50)
    store.setSessionListAnchor(inventory[35]!.id)
    waiting = new Set([inventory[1]!.id])
    relay.pushStatus([], [...waiting])
    await waitFor(() => store.state().sessionStatus?.attention.has(inventory[1]!.id) === true)
    await clock.advanceBy(5_000)
    await waitFor(() => relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined).length >= 3)
    await waitFor(() => !store.state().sessionPageLoading)
    expect(store.state().sessions.map((row) => row.id).sort()).toEqual(inventory.slice(0, 50).map((row) => row.id).sort())
    expect(store.state().sessionListStatus).toBe("ready")
    expect(relay.requests.some((request) => request.operation === "session.list" && request.input?.around === inventory[35]!.id && request.input.before === 10)).toBe(true)
  } finally { store.dispose(); await relay.stop() }
})

test("paged classification keeps waiting-first order when the global status read is unavailable", async () => {
  const inventory = [row("ses_wait_small", 1, 1), row("ses_run_small", 2, 2), row("ses_idle_small", 3, 3)]
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: false, code: "message_too_large", message: "Status output exceeds its frame bound" }
    if (request.operation === "session.list") return { ok: true, value: listPage(inventory, parseListQuery({ ...request.input, workspace: undefined }), new Set([inventory[1]!.id]), new Set([inventory[0]!.id])) }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().carouselStatus === "ready")
    expect(store.state().sessions.map((row) => row.id)).toEqual(inventory.map((row) => row.id))
    expect(store.state().sessions[0]?.attention).toBe(true)
    expect(store.state().sessions.every((row) => row.failed === undefined)).toBe(true)
    expect(store.state().carouselSessions?.every((row) => row.failed === undefined)).toBe(true)
  } finally { store.dispose(); await relay.stop() }
})

test.each([
  ["invalid_message", 'Unknown input field "around"'],
  ["invalid_message", 'Unknown input field "before"'],
  ["internal_error", "Temporary inventory failure"],
] as const)("a failed anchored refresh preserves ready rows, connection and paging: %s %s", async (code, message) => {
  const inventory = Array.from({ length: 100 }, (_, index) => row(`ses_refresh_${index}`, 1_000 - index, 1_000 - index))
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
    if (request.operation !== "session.list") return "default"
    if (request.input?.around !== undefined) return { ok: false, code, message }
    return { ok: true, value: listPage(inventory, parseListQuery({ ...request.input, workspace: undefined }), new Set(), new Set()) }
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().sessions.length === 25 && store.state().carouselStatus === "ready")
    await store.nextSessionsPage()
    const connection = store.state().connection
    const ids = store.state().sessions.map((row) => row.id)
    const next = store.state().sessionHasNext
    const previous = store.state().sessionHasPrevious
    store.setSessionListAnchor(inventory[35]!.id)
    relay.pushSessions(inventory.map((row) => row.id))
    await waitFor(() => relay.requests.some((request) => request.input?.around === inventory[35]!.id))
    await waitFor(() => !store.state().sessionPageLoading)
    expect(store.state().sessionListStatus).toBe("ready")
    expect(store.state().connection).toBe(connection)
    expect(store.state().sessions.map((row) => row.id)).toEqual(ids)
    expect([store.state().sessionHasNext, store.state().sessionHasPrevious]).toEqual([next, previous])
    expect(store.state()).toMatchObject({ sessionListNotice: code === "invalid_message" ? expect.stringContaining("Update YCoding on this machine") : expect.stringContaining(message) })
    const reads = relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined).length
    await store.nextSessionsPage()
    expect(store.state().sessions).toHaveLength(75)
    expect(store.state()).toMatchObject({ sessionListNotice: undefined })
    expect(relay.requests.filter((request) => request.operation === "session.list" && request.input?.workspace !== undefined)).toHaveLength(reads + 1)
  } finally { store.dispose(); await relay.stop() }
})

const flags = (items: readonly { readonly id: string; readonly attention?: boolean; readonly failed?: boolean; readonly lost?: boolean }[] | undefined) =>
  items?.map((item) => [item.id, item.attention === true, item.failed === true, item.lost === true])

test("lost-only attention is a loss warning in the Session list and carousel that never joins or outranks the waiting group", async () => {
  const h = await harness((request) => {
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: ["ses_a", "ses_edited", "ses_running"], lost: ["ses_edited", "ses_running"] } }
    if (request.operation === "session.list" && request.input?.status === "waiting") return { ok: true, value: { data: rows.filter((item) => item.id === "ses_a") } }
    return "default"
  })
  try {
    const expected = [["ses_a", true, false, false], ["ses_running", false, false, true], ["ses_recent", false, false, false], ["ses_missing", false, false, false],
      ["ses_Z", false, false, false], ["ses_edited", false, false, true], ["ses_pinned", false, false, false]]
    await waitFor(() => flags(h.store.state().carouselSessions)?.length === rows.length && h.store.state().carouselSessions?.[0]?.id === "ses_a")
    expect(flags(h.store.state().sessions)).toEqual(expected)
    expect(flags(h.store.state().carouselSessions)).toEqual(expected)
    expect(h.store.state().sessionStatus?.lost).toEqual(new Set(["ses_edited", "ses_running"]))
  } finally { await h.close() }
})

test("a lost-only status requests no Waiting carousel page", async () => {
  const h = await harness((request) => request.operation === "session.status"
    ? { ok: true, value: { running: [], attention: ["ses_edited"], lost: ["ses_edited"] } } : "default")
  try {
    expect(h.relay.requests.some((request) => request.operation === "session.list" && request.input?.status === "waiting")).toBe(false)
    expect(flags(h.store.state().carouselSessions)?.find((item) => item[0] === "ses_edited")).toEqual(["ses_edited", false, false, true])
  } finally { await h.close() }
})

test("pushed status frames add, replace, and clear loss on the rows", async () => {
  const h = await harness()
  try {
    const row = (id: string) => flags(h.store.state().sessions)?.find((item) => item[0] === id)
    h.relay.pushStatus([], ["ses_a", "ses_edited"], undefined, undefined, ["ses_edited"])
    await waitFor(() => row("ses_edited")?.[3] === true)
    expect(row("ses_edited")).toEqual(["ses_edited", false, false, true])
    expect(row("ses_a")).toEqual(["ses_a", true, false, false])
    expect(h.store.state().sessions[0]?.id).toBe("ses_a")
    h.relay.pushStatus([], ["ses_a", "ses_edited"])
    await waitFor(() => row("ses_edited")?.[3] === false)
    expect(row("ses_edited")).toEqual(["ses_edited", true, false, false])
    h.relay.pushStatus([], [])
    await waitFor(() => row("ses_edited")?.[1] === false)
    expect(h.store.state().sessions.every((item) => item.lost !== true)).toBe(true)
  } finally { await h.close() }
})

test("a Session list status snapshot carries loss into list and carousel rows when no status read settled", async () => {
  const h = await harness((request) => {
    if (request.operation === "session.status") return { ok: false, code: "internal_error", message: "Status unavailable" }
    if (request.operation === "session.list") return { ok: true, value: { data: rows, status: { running: [], attention: ["ses_edited"], lost: ["ses_edited"] } } }
    return "default"
  })
  try {
    await waitFor(() => h.store.state().sessions.some((item) => item.lost === true))
    expect(h.store.state().sessionStatus).toBeUndefined()
    await waitFor(() => h.store.state().carouselSessions?.some((item) => item.lost === true) === true)
    for (const items of [h.store.state().sessions, h.store.state().carouselSessions]) {
      expect(flags(items)?.filter((item) => item[1] || item[3])).toEqual([["ses_edited", false, false, true]])
    }
  } finally { await h.close() }
})
