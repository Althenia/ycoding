import { Database } from "bun:sqlite"
import { beforeAll, describe, expect, test } from "bun:test"
import { parseClientMessage, parseRelayToAgentMessage, serializeResponse, serializeStatus, type RemoteNotice, type RemoteRequest, type RemoteStatus } from "@ycoding-ai/remote"
import type { PushEvent, PushOutcome } from "../../../infra/cloudflare/src/push/send"
import { createRelay } from "../../../infra/cloudflare/src/relay/core"
import { createNoticeStore } from "../../../infra/cloudflare/src/relay/notice-store"
import { createNoticeStorage } from "../../../infra/cloudflare/test/notice-storage"
import { createRemoteHttp } from "../src/remote/http"
import { createNotificationDelivery, type DesktopAlert } from "../src/remote/notifications"
import { normalizeNotificationPreferences } from "../src/remote/preferences"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { waitFor } from "./relay-double"

type PushServiceAnswer = "accepted" | "rejected" | "expired" | "unreachable"
type BrowserSession = { readonly token: string; readonly sessionID: string }
type PushServer = {
  readonly accountID: string
  readonly signIn: () => Promise<BrowserSession>
  readonly receiver: (endpoint: string) => Promise<{ readonly endpoint: string; readonly p256dh: Uint8Array; readonly auth: Uint8Array }>
  readonly route: (token: string, path: string, init: { readonly method: string; readonly body?: string }) => Promise<Response>
  readonly notify: (accountID: string, event: PushEvent) => Promise<readonly PushOutcome[]>
  readonly owners: () => Promise<readonly (readonly [string, string])[]>
  readonly close: () => void
}
const allOn = { "agent-completed": true, "approval-requested": true, "machine-offline": true }
const endpointFor = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")

const workerListeners = new Map<string, (event: unknown) => void>()
beforeAll(async () => {
  Reflect.set(globalThis, "addEventListener", (name: string, listener: (event: unknown) => void) => workerListeners.set(name, listener))
  Reflect.set(globalThis, "location", { origin: "http://127.0.0.1" })
  const worker = "../src/service-worker?notice-owner"
  await import(worker)
})

async function relayHarness() {
  const sockets = new Map<string, Bun.ServerWebSocket<{ id: string; browser: string }>>()
  const endpoints = new Map<string, { answer: PushServiceAnswer; readonly shown: string[] }>()
  let pushGate: Promise<void> | undefined
  const serverModule = "../../../infra/cloudflare/test/support/push-server"
  const { createPushServer } = await import(serverModule)
  const pushServer: PushServer = await createPushServer(async (endpoint: string, payload: () => Promise<unknown>) => {
    const target = endpoints.get(endpoint)
    if (target === undefined || target.answer === "unreachable") return 0
    if (target.answer === "accepted") {
      const event = await payload()
      Reflect.set(globalThis, "registration", { showNotification: async (_title: string, options: { readonly tag?: string } = {}) => { target.shown.push(options.tag ?? "") } })
      let pending: Promise<unknown> | undefined
      workerListeners.get("push")?.({ data: { json: () => event }, waitUntil: (promise: Promise<unknown>) => { pending = promise } })
      await pending
    }
    return target.answer === "accepted" ? 201 : target.answer === "rejected" ? 403 : 410
  })
  const agentRequests: RemoteRequest[] = []
  let storedStatus: RemoteStatus | undefined
  const database = new Database(":memory:")
  const baseNotices = createNoticeStore(createNoticeStorage(database))
  let appendFailure = false
  const notices = { ...baseNotices, append: (events: Parameters<typeof baseNotices.append>[0]) => {
    if (appendFailure) throw new Error("database or disk is full: SQLITE_FULL")
    return baseNotices.append(events)
  }, complete: (...input: Parameters<typeof baseNotices.complete>) => {
    if (appendFailure) throw new Error("database or disk is full: SQLITE_FULL")
    return baseNotices.complete(...input)
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
    notifyPush: async (accountID, event) => {
      await pushGate
      return pushServer.notify(accountID, event)
    },
  })
  const connection = { ownerID: pushServer.accountID, deviceID: "dev_test", browserSessionID: "browser_test", credentialExpiresAt: Date.now() + 600_000, subscriptions: [], noticesSubscribed: false, pending: [] }
  await relay.attach({ ...connection, connectionID: "agent", role: "agent" })
  await relay.handleAgentMessage("agent", JSON.stringify({ type: "completions", data: [], more: false }))
  const server = Bun.serve<{ id: string; browser: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/me") return Response.json({
        user: { id: connection.ownerID },
        session: { expiresAt: connection.credentialExpiresAt },
        devices: [{ id: connection.deviceID, name: "Test machine", status: "active", online: true, createdAt: 1 }],
      })
      if (server.upgrade(request, { data: { id: crypto.randomUUID(), browser: new URL(request.url).searchParams.get("browser") ?? "browser_test" } })) return undefined
      return new Response("WebSocket required", { status: 426 })
    },
    websocket: {
      async open(socket) {
        sockets.set(socket.data.id, socket)
        await relay.attach({ ...connection, browserSessionID: socket.data.browser, connectionID: socket.data.id, role: "client" })
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
  const browser = async (waitForSubscription = true, options: { readonly session?: BrowserSession; readonly created?: (store: RemoteStore) => void } = {}) => {
    const alerts: DesktopAlert[] = []
    const session = options.session ?? await pushServer.signIn()
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: `http://127.0.0.1:${server.port}` }),
      createTransport: (_deviceID, handlers) => createRemoteTransport({ url: `ws://127.0.0.1:${server.port}/?browser=${session.sessionID}`, handlers }),
      notificationDelivery: createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined),
        desktop: { show: (alert) => { alerts.push(alert) }, dispose: () => {} },
      }),
    })
    options.created?.(store)
    const before = subscribed.size
    await store.load()
    await waitFor(() => store.state().transport.kind === "open" && (!waitForSubscription || subscribed.size > before), 5_000)
    if (waitForSubscription) await waitFor(() => store.state().sessionStatus !== undefined, 5_000)
    return { store, alerts, session }
  }
  const register = async (session: BrowserSession, name: string, answer: PushServiceAnswer) => {
    const receiver = await pushServer.receiver(endpointFor(name))
    const shown: string[] = []
    endpoints.set(receiver.endpoint, { answer, shown })
    return { receiver, shown }
  }
  const enablePush = async (session: BrowserSession, name: string, answer: PushServiceAnswer = "accepted") => {
    const registered = await register(session, name, answer)
    const response = await pushServer.route(session.token, "/api/push/subscriptions", { method: "POST", body: JSON.stringify({ endpoint: registered.receiver.endpoint,
      keys: { p256dh: encode(registered.receiver.p256dh), auth: encode(registered.receiver.auth) }, categories: allOn }) })
    if (!response.ok) throw new Error(`Push registration failed with ${response.status}`)
    return registered.shown
  }
  const renewPush = async (session: BrowserSession, replaced: string, name: string, options: { readonly windows?: number; readonly during?: () => Promise<void> } = {}) => {
    const next = await register(session, name, "accepted")
    const posted: unknown[] = []
    const statuses: number[] = []
    Reflect.set(globalThis, "clients", { matchAll: async () => Array.from({ length: options.windows ?? 0 }, () => ({
      url: "http://127.0.0.1/remote", visibilityState: "hidden", focused: false, focus: async () => undefined, postMessage: (message: unknown) => { posted.push(message) } })) })
    const original = globalThis.fetch
    Reflect.set(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== "/api/push/subscriptions") return original(url, init)
      const response = await pushServer.route(session.token, "/api/push/subscriptions", { method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined })
      statuses.push(response.status)
      await options.during?.()
      return response
    })
    try {
      let pending: Promise<unknown> | undefined
      workerListeners.get("pushsubscriptionchange")?.({
        oldSubscription: { endpoint: endpointFor(replaced) },
        newSubscription: { endpoint: next.receiver.endpoint, getKey: (key: string) => (key === "p256dh" ? next.receiver.p256dh : next.receiver.auth).slice().buffer },
        waitUntil: (promise: Promise<unknown>) => { pending = promise },
      })
      await pending
    } finally {
      Reflect.set(globalThis, "fetch", original)
    }
    const old = endpoints.get(endpointFor(replaced))
    if (old !== undefined) old.answer = "expired"
    return { shown: next.shown, posted, statuses }
  }
  const status = (running: readonly string[], attention: readonly string[]) =>
    relay.handleAgentMessage("agent", serializeStatus({ type: "status", running, attention }))
  let completionSeq = 0
  const complete = (sessionIDs: readonly string[]) => relay.handleAgentMessage("agent", JSON.stringify({ type: "completions", data: sessionIDs.map((sessionID) => ({ id: `evt_fixture_${++completionSeq}`, seq: completionSeq, created: Date.now(), sessionID })), more: false }))
  return {
    browser, status, complete, agentRequests,
    signIn: () => pushServer.signIn(), enablePush, renewPush, owners: () => pushServer.owners(),
    answerPush: (name: string, answer: PushServiceAnswer) => { const target = endpoints.get(endpointFor(name)); if (target) target.answer = answer },
    holdPush: () => {
      let release: () => void = () => {}
      pushGate = new Promise<void>((resolve) => { release = resolve })
      return () => { pushGate = undefined; release() }
    },
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
    stop: async () => {
      await server.stop(true)
      pushServer.close()
    },
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
      await harness.complete(["ses_a"])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2 && second.store.state().notifications.length === 2)
      expect(rows(first.store)).toEqual([["approval-requested", "ses_b"], ["agent-completed", "ses_a"]])
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
      await harness.complete(["ses_a"])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2)
      first.store.dispose()
      const reloaded = await harness.browser()
      await waitFor(() => reloaded.store.state().notifications.length === 2)
      expect(rows(reloaded.store)).toEqual([["approval-requested", "ses_b"], ["agent-completed", "ses_a"]])
      expect(reloaded.store.state().notifications.some((entry) => entry.live)).toBe(false)
      expect(reloaded.alerts).toEqual([])
      reloaded.store.dispose()
    } finally { await harness.stop() }
  })

  test("status frames alone raise no work notice; an explicit completion receipt adds one synced notice", async () => {
    const harness = await relayHarness()
    try {
      const browser = await harness.browser()
      await harness.status(["ses_a"], [])
      await harness.status([], [])
      expect(browser.store.state().notifications).toHaveLength(0)
      await harness.complete(["ses_a"])
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
      await harness.complete(["ses_a"])
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
      await harness.complete(["ses_a"])
      await harness.status([], ["ses_b"])
      await waitFor(() => first.store.state().notifications.length === 2 && second.store.state().notifications.length === 2)
      await first.store.readAllNotifications()
      await waitFor(() => first.store.state().notifications.length === 0 && second.store.state().notifications.length === 0)
      expect(harness.stored()).toEqual([])
      await harness.status(["ses_c"], [])
      await harness.complete(["ses_c"])
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
      await harness.complete(["ses_a"])
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
      await harness.complete(["ses_a", "ses_far"])
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
      await harness.complete(["ses_a"])
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
      await harness.complete(["ses_a"])
      await harness.status([], [])
      await waitFor(() => entryIDs(first.store).length === 1)
      harness.failAppends(true)
      await harness.status(["ses_b"], [])
      await harness.complete(["ses_b"])
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


describe("one System alert per notice and browser through the real router, push store, sender, and relay core", () => {
  const tags = (alerts: readonly DesktopAlert[]) => alerts.map((alert) => alert.tag)

  test("a browser whose push the service accepted shows each notice once from its service worker and never from the open page", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      const shown = await harness.enablePush(tab.session, "laptop")
      await harness.status([], ["ses_a", "ses_b", "ses_c"])
      await waitFor(() => shown.length === 3 && tab.store.state().notifications.length === 3)
      await Bun.sleep(50)
      expect(tab.alerts).toEqual([])
      expect([...shown].sort()).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2", "ycoding-dev_test-ntc_3"])
      tab.store.dispose()
    } finally { await harness.stop() }
  })

  test("an open page presents what its browser's push definitely did not deliver, and stays silent when delivery is unknown", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      await harness.enablePush(tab.session, "laptop", "rejected")
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 1)
      harness.answerPush("laptop", "expired")
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 2)
      expect(await harness.owners()).toEqual([])
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 3)
      await harness.enablePush(tab.session, "laptop-2", "unreachable")
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.store.state().notifications.length === 4)
      await Bun.sleep(100)
      expect(tags(tab.alerts)).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2", "ycoding-dev_test-ntc_3"])
      tab.store.dispose()
    } finally { await harness.stop() }
  })

  test("two browsers on one account are judged by their own subscriptions: the rejected one's page shows exactly one, the accepted one's page none", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const laptop = await harness.browser()
      const phone = await harness.browser()
      await harness.enablePush(laptop.session, "laptop", "rejected")
      const phoneShown = await harness.enablePush(phone.session, "phone")
      await harness.status([], ["ses_a"])
      await waitFor(() => laptop.alerts.length === 1 && phoneShown.length === 1)
      await Bun.sleep(100)
      expect(tags(laptop.alerts)).toEqual(["ycoding-dev_test-ntc_1"])
      expect(phone.alerts).toEqual([])
      expect(phoneShown).toEqual(["ycoding-dev_test-ntc_1"])
      laptop.store.dispose()
      phone.store.dispose()
    } finally { await harness.stop() }
  })

  test("of several open tabs in one browser without push exactly one presents, while another browser presents its own", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const first = await harness.browser()
      const second = await harness.browser(true, { session: first.session })
      const phone = await harness.browser()
      await harness.status([], ["ses_a", "ses_b"])
      await waitFor(() => [first, second, phone].every((tab) => tab.store.state().notifications.length === 2))
      await waitFor(() => first.alerts.length + second.alerts.length === 2 && phone.alerts.length === 2)
      await Bun.sleep(100)
      expect([...tags(first.alerts), ...tags(second.alerts)].sort()).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2"])
      expect(tags(phone.alerts)).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2"])
      for (const tab of [first, second, phone]) tab.store.dispose()
    } finally { await harness.stop() }
  })
})

describe("the relay's presentation choice across page lifetimes", () => {
  const tags = (alerts: readonly DesktopAlert[]) => alerts.map((alert) => alert.tag)

  test("a browser that turns push on is judged by its own registration from the next notice, with nothing sent by its open page", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 1)
      const shown = await harness.enablePush(tab.session, "laptop")
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => shown.length === 1 && tab.store.state().notifications.length === 2)
      await Bun.sleep(100)
      expect(tags(tab.alerts)).toEqual(["ycoding-dev_test-ntc_1"])
      expect(shown).toEqual(["ycoding-dev_test-ntc_2"])
      tab.store.dispose()
    } finally { await harness.stop() }
  })

  test("a push failure settled after its page closed goes to the browser's open tab, and a tab opened later never replays it", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const first = await harness.browser()
      const second = await harness.browser(true, { session: first.session })
      await harness.enablePush(first.session, "laptop", "rejected")
      const release = harness.holdPush()
      await harness.status([], ["ses_a"])
      await waitFor(() => first.store.state().notifications.length === 1 && second.store.state().notifications.length === 1)
      first.store.dispose()
      await Bun.sleep(50)
      release()
      await waitFor(() => second.alerts.length === 1)
      const late = await harness.browser(true, { session: first.session })
      await Bun.sleep(100)
      expect(tags(first.alerts)).toEqual([])
      expect(tags(second.alerts)).toEqual(["ycoding-dev_test-ntc_1"])
      expect(late.alerts).toEqual([])
      second.store.dispose()
      late.store.dispose()
    } finally { await harness.stop() }
  })
})

describe("a service worker renewal of this browser's push subscription", () => {
  test("with every tab of the browser frozen, notices during and after the renewal are shown once by the service worker, which never messages a page", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const first = await harness.browser()
      const second = await harness.browser(true, { session: first.session })
      await harness.enablePush(first.session, "old")
      const renewal = await harness.renewPush(first.session, "old", "new", { windows: 2, during: async () => {
        await harness.status([], ["ses_a"])
        await Bun.sleep(100)
      } })
      expect(renewal.statuses).toEqual([200])
      expect(await harness.owners()).toEqual([[endpointFor("new"), first.session.sessionID]])
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => renewal.shown.length === 2 && second.store.state().notifications.length === 2)
      await Bun.sleep(100)
      expect(renewal.shown).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2"])
      expect([...first.alerts, ...second.alerts]).toEqual([])
      expect(renewal.posted).toEqual([])
      first.store.dispose()
      second.store.dispose()
    } finally { await harness.stop() }
  })

  test("a notice admitted before the renewal whose push is sent after it is shown once by the service worker", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      await harness.enablePush(tab.session, "old")
      const release = harness.holdPush()
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.store.state().notifications.length === 1)
      const renewal = await harness.renewPush(tab.session, "old", "new")
      release()
      await waitFor(() => renewal.shown.length === 1)
      await Bun.sleep(100)
      expect(renewal.shown).toEqual(["ycoding-dev_test-ntc_1"])
      expect(tab.alerts).toEqual([])
      tab.store.dispose()
    } finally { await harness.stop() }
  })

  test("after the service worker finishes a renewal, a push the new endpoint rejects is shown exactly once by the page", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      await harness.enablePush(tab.session, "old")
      await harness.renewPush(tab.session, "old", "new")
      harness.answerPush("new", "rejected")
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 1)
      await Bun.sleep(100)
      expect(tab.alerts.map((alert) => alert.tag)).toEqual(["ycoding-dev_test-ntc_1"])
      tab.store.dispose()
    } finally { await harness.stop() }
  })

  test("a renewal the relay refused leaves the page presenting what the browser's dropped subscription no longer receives", async () => {
    const harness = await relayHarness()
    try {
      await harness.status([], [])
      const tab = await harness.browser()
      await harness.enablePush(tab.session, "old", "expired")
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 1)
      const renewal = await harness.renewPush(tab.session, "old", "new")
      expect(renewal.statuses).toEqual([404])
      await harness.status([], [])
      await harness.status([], ["ses_a"])
      await waitFor(() => tab.alerts.length === 2)
      await Bun.sleep(100)
      expect(tab.alerts.map((alert) => alert.tag)).toEqual(["ycoding-dev_test-ntc_1", "ycoding-dev_test-ntc_2"])
      expect(renewal.shown).toEqual([])
      tab.store.dispose()
    } finally { await harness.stop() }
  })
})
