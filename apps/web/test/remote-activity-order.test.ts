import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayRequestHandler } from "./relay-double"

const workspace = { id: "wsp_fixture", projectID: "prj_fixture", directory: "/fixture/project" }
const row = (id: string, active: number | undefined, updated: number, pinned?: number) => ({ id, title: id, projectID: workspace.projectID, location: { directory: workspace.directory }, time: { created: 1, updated, ...(active === undefined ? {} : { active }), ...(pinned === undefined ? {} : { pinned }) } })
const rows = [row("ses_pinned", 1, 900, 1), row("ses_edited", 2, 1000), row("ses_recent", 500, 500), row("ses_running", 0, 1), row("ses_Z", 100, 100), row("ses_a", 100, 100), row("ses_missing", undefined, 200)]

async function harness(handler: RelayRequestHandler = () => "default") {
  const relay = await startRelayDouble({ advertisedSessions: rows.map((item) => item.id), handler: (request) => {
    const custom = handler(request)
    if (custom !== "default") return custom
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: ["ses_running"], attention: [] } }
    if (request.operation === "session.list") return { ok: true, value: { data: request.input?.status === "running" ? rows.filter((item) => item.id === "ses_running") : request.input?.status === "idle" ? rows.filter((item) => item.id !== "ses_running") : rows } }
    if (request.operation === "session.get") return { ok: true, value: { data: rows.find((item) => item.id === request.sessionID) } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }), batchMs: 1 })
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
