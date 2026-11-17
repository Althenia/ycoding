import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { sessionFilterCounts } from "../src/remote/ui/shell-model"
import { startRelayDouble, waitFor } from "./relay-double"

const workspace = { id: "wsp_web", projectID: "prj_web", directory: "/work/web" }
const session = (id: string, title: string, extra: { readonly agent?: string; readonly parentID?: string } = {}) => ({
  id, title, projectID: workspace.projectID, location: { directory: workspace.directory }, time: { created: 1, updated: 20 }, ...extra,
})
const owner = session("ses_owner", "Compaction planning")
const fork = session("ses_fork", "Fork")
const helper = session("ses_compaction_0123456789abcdef01234567", "Renamed internal worker", { parentID: owner.id, agent: "compaction" })
const child = session("ses_child", "Inspect UI", { parentID: owner.id, agent: "occam" })
const btw = session("ses_btw", "Side question", { parentID: owner.id, agent: "btw" })
const unparentedHelper = session("ses_compaction_abcdef0123456789abcdef01", "Renamed helper without parent metadata")
const all = [owner, fork, helper, child, btw, unparentedHelper]

test("hydration, inventory updates, search and reconnect keep helpers out of ordinary rows and counts", async () => {
  let revision = 0
  const relay = await startRelayDouble({ handler: request => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.status") return { ok: true, value: { running: [owner.id], attention: [] } }
    if (request.operation === "session.list") return { ok: true, value: { data: request.input?.status === "waiting" ? [] : all.map(row => row.id === owner.id ? { ...row, title: `Compaction planning ${revision}` } : row), cursor: {} } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10 }) })
  const check = () => {
    expect(store.state().sessions.map(row => row.id).sort()).toEqual([fork.id, owner.id])
    expect(store.state().carouselSessions?.map(row => row.id).sort()).toEqual([fork.id, owner.id])
    expect([...store.state().advertised].sort()).toEqual([fork.id, owner.id])
    expect(sessionFilterCounts(store.state().sessions, store.state().view, "all").all).toBe(2)
  }
  try {
    await store.load()
    await waitFor(() => store.state().sessionListStatus === "ready" && store.state().carouselStatus === "ready")
    check()
    revision = 1
    relay.pushSessions([])
    await waitFor(() => store.state().sessions.some(row => row.title === "Compaction planning 1"))
    check()
    store.searchSessions("Compaction")
    await waitFor(() => store.state().sessionListStatus === "ready")
    check()
    const connections = relay.connections
    revision = 2
    relay.dropConnections(1012, "synthetic reconnect")
    await waitFor(() => relay.connections > connections && store.state().sessions.some(row => row.title === "Compaction planning 2"))
    check()
    const reads = relay.requests.filter(request => request.operation === "session.list")
    expect(reads.every(request => request.input?.parentID === null && request.input?.background === "exclude")).toBe(true)
    expect(reads.some(request => request.input?.search === "Compaction")).toBe(true)
    expect(relay.requests.some(request => request.operation === "session.prompt")).toBe(false)
  } finally { store.dispose(); await relay.stop() }
}, 15_000)

test("opening a side chat retains its parent while direct-open helpers never enter the picker", async () => {
  const relay = await startRelayDouble({ snapshot: id => ({ session: all.find(row => row.id === id), messages: [], watermark: { aggregateID: id, seq: 0 } }), handler: request => {
    if (request.operation === "workspace.list") return { ok: true, value: { data: [workspace] } }
    if (request.operation === "session.list") return { ok: true, value: { data: [owner, fork], cursor: {} } }
    if (request.operation === "session.get") return { ok: true, value: { data: all.find(row => row.id === request.sessionID) } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => createRemoteTransport({ url: relay.wsURL(deviceID), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().sessionListStatus === "ready")
    for (const row of [btw, helper, unparentedHelper]) {
      await store.selectSession(row.id)
      expect(store.state().activeSessionID).toBe(row.id)
      expect(store.state().selectedSessionInfo).toMatchObject({ id: row.id, ...(row.parentID === undefined ? {} : { parentID: owner.id }) })
      expect(store.state().view?.id).toBe(row.id)
      store.refreshSessions()
      await waitFor(() => store.state().sessionListStatus === "ready")
      expect(store.state().sessions.map(item => item.id).sort()).toEqual([fork.id, owner.id])
    }
  } finally { store.dispose(); await relay.stop() }
}, 15_000)
