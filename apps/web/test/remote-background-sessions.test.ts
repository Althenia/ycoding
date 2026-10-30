import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const workspace = { id: "wsp_web", projectID: "prj_web", directory: "/work/web" }
const info = (id: string, title: string, updated: number, origin?: "dots-executor") => ({
  id, title, projectID: workspace.projectID, location: { directory: workspace.directory },
  time: { created: updated, updated }, ...(origin === undefined ? {} : { origin }),
})
const listed = [info("ses_plain", "Plain ordinary", 20), info("ses_dots_title", "Dots · unattributed", 10)]
const background = info("ses_dots_bg", "Renamed arbitrarily", 90, "dots-executor")
const dotsRoot = info("ses_dots_root", "Dots · unattributed", 80)

async function connect() {
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [], attention: [] } }
    if (request.operation === "session.get" && request.sessionID === background.id) return { ok: true, value: { data: background } }
    if (request.operation === "session.get" && request.sessionID === dotsRoot.id) return { ok: true, value: { data: dotsRoot } }
    if (request.operation === "session.list") return { ok: true, value: { data: request.input?.workspace === undefined ? [] : listed, cursor: {} } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  await store.load()
  await waitFor(() => store.state().sessions.length === listed.length)
  return { relay, store }
}

test("every Session list read asks the connector to exclude background Sessions", async () => {
  const { relay, store } = await connect()
  try {
    await waitFor(() => store.state().carouselSessions !== undefined)
    const reads = relay.requests.filter((request) => request.operation === "session.list")
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((request) => request.input?.background === "exclude")).toBe(true)
  } finally { store.dispose(); await relay.stop() }
}, 15_000)

test("an opened background Session stays addressable but never re-enters the picker", async () => {
  const { relay, store } = await connect()
  try {
    await store.selectSession(background.id)
    await waitFor(() => store.state().activeSessionID === background.id && store.state().selectedSessionInfo?.origin === "dots-executor")
    relay.pushStatus(["ses_plain"], [])
    await waitFor(() => store.state().sessions.find((row) => row.id === "ses_plain")?.running === true)
    expect(store.state().activeSessionID).toBe(background.id)
    expect(store.state().sessions.map((row) => row.id)).toEqual(["ses_plain", "ses_dots_title"])
    expect(store.state().advertised).not.toContain(background.id)
  } finally { store.dispose(); await relay.stop() }
}, 15_000)

test("an opened ordinary Dots root is still reinserted into the picker", async () => {
  const { relay, store } = await connect()
  try {
    await store.selectSession(dotsRoot.id)
    await waitFor(() => store.state().activeSessionID === dotsRoot.id)
    relay.pushStatus(["ses_plain"], [])
    await waitFor(() => store.state().sessions.some((row) => row.id === dotsRoot.id))
    expect(store.state().sessions.map((row) => row.id)).toContain("ses_dots_title")
  } finally { store.dispose(); await relay.stop() }
}, 15_000)
