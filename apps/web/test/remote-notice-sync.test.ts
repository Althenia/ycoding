import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { parseClientMessage, parseRelayToAgentMessage, serializeResponse, serializeStatus, type RemoteNotice, type RemoteRequest, type RemoteStatus } from "@ycoding-ai/remote"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createNoticeStore } from "../../../infra/cloudflare/src/relay/notice-store"
import { createRemoteHttp } from "../src/remote/http"
import { createNotificationDelivery, type DesktopAlert } from "../src/remote/notifications"
import { normalizeNotificationPreferences } from "../src/remote/preferences"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { waitFor } from "./relay-double"

async function relayHarness() {
  const sockets = new Map<string, Bun.ServerWebSocket<{ id: string }>>()
  const agentRequests: RemoteRequest[] = []
  let storedStatus: RemoteStatus | undefined
  const database = new Database(":memory:")
  const baseNotices = createNoticeStore({ exec: (query, ...bindings) => {
    const rows = database.prepare(query).all(...(bindings as never[]))
    return { toArray: () => rows }
  } })
  let appendFailure = false
  const notices = { ...baseNotices, append: (events: Parameters<typeof baseNotices.append>[0]) => {
    if (appendFailure) throw new Error("database or disk is full: SQLITE_FULL")
    return baseNotices.append(events)
  } }
  const holds: { readonly match: (operation: string) => boolean; readonly release: Promise<void> }[] = []
  const subscribed = new Set<string>()
  const relay = createRelay({
    now: Date.now,
    newID: () => crypto.randomUUID().replaceAll("-", ""),
    send: (connectionID, raw) => {
      if (connectionID !== "agent") {
        sockets.get(connectionID)?.send(raw)
        return
      }
      const parsed = parseRelayToAgentMessage(raw)
      if (!parsed.ok) throw new Error(parsed.error.message)
      if (parsed.value.type !== "request") return
      const request = parsed.value
      agentRequests.push(request)
      const value = request.operation === "session.status" ? { running: [], attention: [] }
        : request.operation === "workspace.list" ? { data: [{ id: "wsp_a", projectID: "prj_a", directory: "/work/a" }] }
        : request.operation === "session.list" ? { data: [{ id: "ses_a", title: "Alpha session", time: { created: 1, updated: 2 } }] }
        : request.operation === "session.get" ? { data: { id: request.sessionID, title: `Detail of ${request.sessionID}`, time: { created: 1, updated: 2 } } }
        : { data: [] }
      void relay.handleAgentMessage("agent", serializeResponse({ type: "response", id: request.id, ok: true, value }))
    },
    close: (connectionID, code, reason) => sockets.get(connectionID)?.close(code, reason),
    saveSubscriptions: () => {},
    savePending: () => {},
    loadStatus: async () => storedStatus,
    saveStatus: async (status) => { storedStatus = status },
    loadOfflineCheck: async () => undefined,
    saveOfflineCheck: async () => undefined,
    notices,
    saveNoticeSubscription: (connectionID, value) => { if (value) subscribed.add(connectionID) },
    authorizeClientCommand: async () => ({ ok: true }),
    authorizeAgentCommand: async () => ({ ok: true }),
    authorityTtlMs: 5_000,
  })
  const connection = { ownerID: "usr_test", deviceID: "dev_test", browserSessionID: "browser_test", credentialExpiresAt: Date.now() + 600_000, subscriptions: [], noticesSubscribed: false, pending: [] }
  await relay.attach({ ...connection, connectionID: "agent", role: "agent" })
  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/me") return Response.json({
        user: { id: connection.ownerID },
        session: { expiresAt: connection.credentialExpiresAt },
        devices: [{ id: connection.deviceID, name: "Test machine", status: "active", online: true, createdAt: 1 }],
      })
      if (server.upgrade(request, { data: { id: crypto.randomUUID() } })) return undefined
      return new Response("WebSocket required", { status: 426 })
    },
    websocket: {
      async open(socket) {
        sockets.set(socket.data.id, socket)
        await relay.attach({ ...connection, connectionID: socket.data.id, role: "client" })
      },
      async message(socket, raw) {
        const parsed = parseClientMessage(String(raw))
        const held = parsed.ok && parsed.value.type === "request" ? holds.find((hold) => hold.match(parsed.value.type === "request" ? parsed.value.operation : "")) : undefined
        if (held !== undefined) await held.release
        return relay.handleClientMessage(socket.data.id, String(raw))
      },
      close(socket) {
        sockets.delete(socket.data.id)
        relay.detach(socket.data.id)
      },
    },
  })
  const browser = async (waitForSubscription = true) => {
    const alerts: DesktopAlert[] = []
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${server.port}` }),
      createTransport: (_deviceID, handlers) => createRemoteTransport({ url: `ws://127.0.0.1:${server.port}`, handlers }),
      notificationDelivery: createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined),
        desktop: { show: (alert) => { alerts.push(alert) }, dispose: () => {} },
      }),
    })
    const before = subscribed.size
    await store.load()
    await waitFor(() => store.state().transport.kind === "open" && (!waitForSubscription || subscribed.size > before), 5_000)
    if (waitForSubscription) await waitFor(() => store.state().sessionStatus !== undefined, 5_000)
    return { store, alerts }
  }
  const status = (running: readonly string[], attention: readonly string[]) =>
    relay.handleAgentMessage("agent", serializeStatus({ type: "status", running, attention }))
  return {
    browser, status, agentRequests,
    stored: () => (database.query("SELECT seq, category, session_id, created_at FROM notice ORDER BY seq").all() as { seq: number; category: RemoteNotice["category"]; session_id: string; created_at: number }[])
      .map((row) => ({ id: `ntc_${row.seq}`, category: row.category, sessionID: row.session_id, createdAt: row.created_at })),
    failAppends: (value: boolean) => { appendFailure = value },
    rawRequest: async (operation: string, input?: unknown) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
      const replies: string[] = []
      socket.addEventListener("message", (message) => { replies.push(String(message.data)) })
      await waitFor(() => socket.readyState === WebSocket.OPEN, 5_000)
      socket.send(JSON.stringify({ type: "request", id: "raw", operation, ...(input === undefined ? {} : { input }) }))
      await waitFor(() => replies.some((reply) => reply.includes('"id":"raw"')), 5_000)
      socket.close()
      return JSON.parse(replies.find((reply) => reply.includes('"id":"raw"')) ?? "null") as { ok: boolean }
    },
    hold: (operation: string) => {
      let release: () => void = () => {}
      const promise = new Promise<void>((resolve) => { release = resolve })
      holds.push({ match: (candidate) => candidate === operation, release: promise })
      return () => {
        holds.length = 0
        release()
      }
    },
    wsURL: `ws://127.0.0.1:${server.port}`,
    stop: async () => { await server.stop(true) },
  }
}

const rows = (store: { readonly state: () => { readonly notifications: readonly { readonly category: string; readonly sessionID?: string }[] } }) =>
  store.state().notifications.map((entry) => [entry.category, entry.sessionID])

const attention = (count: number, prefix = "ses_n") => Array.from({ length: count }, (_, index) => `${prefix}${index}`)
const entryIDs = (store: { readonly state: () => { readonly notifications: readonly { readonly id: string; readonly synced: boolean }[] } }) =>
  store.state().notifications.filter((entry) => entry.synced).map((entry) => entry.id)

describe("device-synced notices through the real relay core", () => {
  test("two browsers see the same live list, and each raises the alert and toast mark only for additions it watched", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      const second = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2 && second.store.state().notifications.length === 2)
      expect(rows(first.store)).toEqual([["agent-completed", "ses_a"], ["approval-requested", "ses_b"]])
      expect(rows(second.store)).toEqual(rows(first.store))
      expect(first.store.state().notifications.map((entry) => entry.id)).toEqual(second.store.state().notifications.map((entry) => entry.id))
      expect(first.store.state().notifications.every((entry) => entry.synced && entry.live)).toBe(true)
      expect(first.alerts.map((alert) => alert.tag)).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2"])
      expect(second.alerts).toHaveLength(2)
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })

  test("a browser that connects later receives the list silently, and it survives a reload", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2)
      first.store.dispose()
      const reloaded = await harness.browser()
      await waitFor(() => reloaded.store.state().notifications.length === 2)
      expect(rows(reloaded.store)).toEqual([["agent-completed", "ses_a"], ["approval-requested", "ses_b"]])
      expect(reloaded.store.state().notifications.some((entry) => entry.live)).toBe(false)
      expect(reloaded.alerts).toEqual([])
      reloaded.store.dispose()
    } finally { await harness.stop() }
  })

  test("status frames alone no longer raise a local notice: only the relay list does, once per transition", async () => {
    const harness = await relayHarness()
    try {
      const browser = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], [])
      await waitFor(() => browser.store.state().notifications.length === 1)
      await Bun.sleep(50)
      expect(rows(browser.store)).toEqual([["agent-completed", "ses_a"]])
      expect(browser.alerts).toHaveLength(1)
      expect(harness.stored()).toHaveLength(1)
      browser.store.dispose()
    } finally { await harness.stop() }
  })

  test("reading one notice removes it for every browser and from the relay, leaving the rest", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      const second = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2 && second.store.state().notifications.length === 2)
      const completed = second.store.state().notifications.find((entry) => entry.category === "agent-completed")
      await second.store.readNotification(completed?.id ?? "")
      await waitFor(() => first.store.state().notifications.length === 1 && second.store.state().notifications.length === 1)
      expect(rows(first.store)).toEqual([["approval-requested", "ses_b"]])
      expect(harness.stored().map((notice) => notice.sessionID)).toEqual(["ses_b"])
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })

  test("read all clears every browser and the relay, and a later transition still notifies", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      const second = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2 && second.store.state().notifications.length === 2)
      await first.store.readAllNotifications()
      await waitFor(() => first.store.state().notifications.length === 0 && second.store.state().notifications.length === 0)
      expect(harness.stored()).toEqual([])
      await harness.status(["ses_c"], [])
      await harness.status([], [])
      await waitFor(() => first.store.state().notifications.length === 1 && second.store.state().notifications.length === 1)
      expect(rows(second.store)).toEqual([["agent-completed", "ses_c"]])
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })

  test("nothing is read until a browser reads: loading, reconnecting, and a snapshot leave every notice in place", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], [])
      await waitFor(() => first.store.state().notifications.length === 1)
      const second = await harness.browser()
      await waitFor(() => second.store.state().notifications.length === 1)
      await Bun.sleep(50)
      expect(harness.stored()).toHaveLength(1)
      expect(harness.agentRequests.some((request) => String(request.operation).startsWith("notice."))).toBe(false)
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })

  test("titles resolve on the browser from the Session list or one detail read, and the relay never stores them", async () => {
    const harness = await relayHarness()
    try {
      const browser = await harness.browser()
      await waitFor(() => browser.store.state().sessions.some((session) => session.id === "ses_a"))
      await harness.status(["ses_a", "ses_far"], [])
      await harness.status([], [])
      await waitFor(() => browser.store.state().notifications.length === 2 && browser.store.state().notifications.every((entry) => entry.sessionTitle !== undefined))
      expect(browser.store.state().notifications.map((entry) => [entry.sessionID, entry.sessionTitle]).sort()).toEqual([
        ["ses_a", "Alpha session"], ["ses_far", "Detail of ses_far"],
      ])
      expect(harness.stored().every((notice) => !("title" in notice) && !("sessionTitle" in notice))).toBe(true)
      expect(harness.agentRequests.filter((request) => request.operation === "session.get").map((request) => request.sessionID)).toEqual(["ses_far"])
      expect(browser.alerts.every((alert) => !alert.body.includes("Detail of"))).toBe(true)
      browser.store.dispose()
    } finally { await harness.stop() }
  })

  test("a page with more unresolved Sessions than the detail-read budget eventually resolves every visible title", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      await harness.status([], attention(12, "ses_far_"))
      const browser = await harness.browser()
      await waitFor(() => browser.store.state().notifications.length === 12 &&
        browser.store.state().notifications.every((entry) => entry.sessionTitle !== undefined), 15_000)
      expect(harness.agentRequests.filter((request) => request.operation === "session.get")).toHaveLength(12)
      browser.store.dispose()
    } finally { await harness.stop() }
  }, 20_000)

  test("a browser that never opts in receives no notice frame from the relay", async () => {
    const harness = await relayHarness()
    try {
      const frames: string[] = []
      const socket = new WebSocket(harness.wsURL)
      socket.addEventListener("message", (message) => { frames.push(String(message.data)) })
      await waitFor(() => frames.length > 0)
      await harness.status(["ses_a"], [])
      await harness.status([], [])
      await waitFor(() => harness.stored().length === 1)
      await Bun.sleep(50)
      expect(frames.some((frame) => frame.includes("notice."))).toBe(false)
      socket.close()
    } finally { await harness.stop() }
  })

  test("a browser pages every stored notice past the old cap through Load more until the relay total is loaded", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      await harness.status([], attention(130))
      const browser = await harness.browser()
      await waitFor(() => browser.store.state().noticeSync.loaded === 50)
      expect(browser.store.state().noticeSync).toMatchObject({ status: "ready", total: 130, loaded: 50 })
      await browser.store.loadMoreNotifications()
      expect(browser.store.state().noticeSync).toMatchObject({ total: 130, loaded: 100 })
      await browser.store.loadMoreNotifications()
      expect(browser.store.state().noticeSync).toMatchObject({ total: 130, loaded: 130, loadingMore: false })
      expect(entryIDs(browser.store)).toEqual(harness.stored().map((notice) => notice.id).reverse())
      expect(browser.alerts).toEqual([])
      browser.store.dispose()
    } finally { await harness.stop() }
  }, 30_000)

  test("an initial page held while other browsers add, read, and read all lists exactly the final relay state", async () => {
    const harness = await relayHarness()
    try {
      const release = harness.hold("notice.subscribe")
      const late = await harness.browser(false)
      const other = await harness.browser(false)
      await harness.status([], [])
      await harness.status([], attention(3))
      await harness.rawRequest("notice.read", { ids: ["ntc_1"] })
      await harness.rawRequest("notice.readAll")
      await harness.status([], [...attention(3), "ses_x", "ses_y"])
      expect(harness.stored()).toHaveLength(2)
      release()
      await waitFor(() => late.store.state().noticeSync.status === "ready" && other.store.state().noticeSync.status === "ready", 5_000)
      for (const browser of [late, other]) {
        expect(entryIDs(browser.store)).toEqual(["ntc_5", "ntc_4"])
        expect(browser.store.state().noticeSync).toMatchObject({ total: 2, loaded: 2 })
        expect(browser.alerts).toEqual([])
      }
      await harness.rawRequest("notice.readAll")
      await waitFor(() => late.store.state().noticeSync.total === 0 && entryIDs(late.store).length === 0)
      late.store.dispose()
      other.store.dispose()
    } finally { await harness.stop() }
  }, 30_000)

  test("a Load more held while other clients read older notices and add new ones neither resurrects nor loses a notice", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      await harness.status([], attention(120))
      const browser = await harness.browser()
      await waitFor(() => browser.store.state().noticeSync.loaded === 50)
      const release = harness.hold("notice.list")
      const loading = browser.store.loadMoreNotifications()
      await waitFor(() => browser.store.state().noticeSync.loadingMore)
      await harness.rawRequest("notice.read", { ids: ["ntc_120", "ntc_60", "ntc_59", "ntc_10"] })
      await harness.status([], [...attention(120), "ses_late_a", "ses_late_b"])
      await waitFor(() => entryIDs(browser.store).includes("ntc_122"))
      release()
      await loading
      const removed = ["ntc_120", "ntc_60", "ntc_59", "ntc_10"]
      const server = harness.stored().map((notice) => notice.id)
      const held = entryIDs(browser.store)
      expect(new Set(held).size).toBe(held.length)
      expect(held.some((id) => removed.includes(id))).toBe(false)
      expect(held.every((id) => server.includes(id))).toBe(true)
      expect(browser.store.state().noticeSync.total).toBe(server.length)
      const oldest = Number(held.at(-1)?.slice(4))
      expect(server.filter((id) => Number(id.slice(4)) >= oldest).sort()).toEqual([...held].sort())
      while (browser.store.state().noticeSync.loaded < browser.store.state().noticeSync.total) await browser.store.loadMoreNotifications()
      expect(entryIDs(browser.store)).toEqual([...server].reverse())
      browser.store.dispose()
    } finally { await harness.stop() }
  }, 30_000)

  test("a relay storage failure is shown to every browser, keeps the stored notices, and read all recovers sync", async () => {
    const harness = await relayHarness()
    try {
      const first = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], [])
      await waitFor(() => entryIDs(first.store).length === 1)
      harness.failAppends(true)
      await harness.status(["ses_b"], [])
      await harness.status([], [])
      await waitFor(() => first.store.state().noticeSync.status === "error")
      expect(first.store.state().noticeSync.message).toBe("Some notifications could not be saved. Stored unread notifications remain available.")
      expect(harness.stored()).toHaveLength(1)
      const second = await harness.browser()
      expect(second.store.state().noticeSync).toMatchObject({ status: "error", total: 1 })
      expect(entryIDs(second.store)).toEqual(["ntc_1"])
      harness.failAppends(false)
      await first.store.readAllNotifications()
      await waitFor(() => first.store.state().noticeSync.status === "ready" && second.store.state().noticeSync.status === "ready")
      expect(entryIDs(first.store)).toEqual([])
      expect(harness.stored()).toEqual([])
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })
})
