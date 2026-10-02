import { describe, expect, test } from "bun:test"
import type { RemoteDeviceInfo, RemoteErrorCode, RemoteNoticePage, RemoteNoticeRequest } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import type { StorageLike } from "../src/lib/storage"
import { createNotificationDelivery, type DesktopAlert } from "../src/remote/notifications"
import {
  normalizeNotificationPreferences,
  readNotificationPreferences,
  toggleNotificationChannel,
  writeNotificationPreferences,
  type NotificationCategory,
  type NotificationChannel,
} from "../src/remote/preferences"
import { createRemoteStore, type RemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor, type RelayDouble, type RelayRequestHandler } from "./relay-double"

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  /** Every desktop alert raised, in order. */
  readonly alerts: readonly DesktopAlert[]
  /** Alerts the notifier still holds open on screen. */
  readonly openAlerts: () => readonly DesktopAlert[]
  readonly transports: readonly Parameters<Parameters<typeof createRemoteStore>[0]["createTransport"]>[1][]
  /** Times the store released the desktop notifier. */
  readonly disposals: () => number
  readonly flush: () => Promise<void>
  readonly runUntil: (predicate: () => boolean, attempts?: number) => Promise<void>
  /** Flips one stored channel, as the settings page does. */
  readonly togglePreference: (category: NotificationCategory, channel: NotificationChannel) => void
  /** Loads the account, connects the only device, and opens one session. */
  readonly openSession: (sessionID?: string) => Promise<void>
  /** Switches the connected device, as the device picker does. */
  readonly connect: (deviceID: string) => Promise<void>
  readonly stop: () => Promise<void>
}

type NoticeCategory = "agent-completed" | "approval-requested"

function storage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

/** Overrides the stored preference for the categories a case mutes. */
function mutedStorage(muted: readonly (readonly [NotificationCategory, NotificationChannel])[]): StorageLike {
  const target = storage()
  const preferences = muted.reduce(
    (current, [category, channel]) => toggleNotificationChannel(current, category, channel),
    readNotificationPreferences(target),
  )
  writeNotificationPreferences(target, preferences)
  return target
}

function durable(type: string, seq: number, sessionID = "ses_a"): unknown {
  return { id: `evt_${seq}`, type, durable: { aggregateID: sessionID, seq, version: 1 }, data: {} }
}

async function harness(options: {
  readonly muted?: readonly (readonly [NotificationCategory, NotificationChannel])[]
  readonly messages?: Record<string, readonly unknown[]>
  readonly permissions?: readonly unknown[]
  readonly guardrailRequests?: readonly unknown[]
  readonly handler?: RelayRequestHandler
  /** Overrides the enrolled devices so a case can switch between two of them. */
  readonly devices?: readonly RemoteDeviceInfo[]
  readonly noticeError?: { readonly code: RemoteErrorCode; readonly message: string }
  readonly noticePage?: RemoteNoticePage
  readonly noticeHandler?: (request: RemoteNoticeRequest) => unknown | Promise<unknown>
} = {}): Promise<Harness> {
  const devices: readonly RemoteDeviceInfo[] =
    options.devices ?? [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true }]
  const relay = await startRelayDouble({
    watermark: 5,
    advertisedSessions: ["ses_a", "ses_b"],
    messages: options.messages,
    permissions: options.permissions,
    guardrailRequests: options.guardrailRequests,
    handler: options.handler,
    noticeError: options.noticeError,
    noticePage: options.noticePage,
    noticeHandler: options.noticeHandler,
    me: { user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 }, devices },
  })
  const preferences = mutedStorage(options.muted ?? [])
  const alerts: DesktopAlert[] = []
  const transports: Parameters<Parameters<typeof createRemoteStore>[0]["createTransport"]>[1][] = []
  const openAlerts = new Set<DesktopAlert>()
  let disposals = 0
  const timers: (() => void)[] = []
  const schedule = (callback: () => void, ms = 0) => {
    if (ms >= 1_000) return () => {}
    timers.push(callback)
    return () => {
      const index = timers.indexOf(callback)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const flush = async () => {
    await Bun.sleep(15)
    const pending = timers.splice(0)
    for (const callback of pending) callback()
  }
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => {
      transports.push(handlers)
      return createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule, createSocket: relay.createSocket })
    },
    schedule,
    batchMs: 20,
    now: () => 1_000,
    notificationDelivery: createNotificationDelivery({
      preferences: () => readNotificationPreferences(preferences),
      desktop: {
        show: (alert) => {
          alerts.push(alert)
          openAlerts.add(alert)
        },
        dispose: () => {
          disposals += 1
          openAlerts.clear()
        },
      },
      now: () => 1_000,
    }),
  })
  const runUntil = async (predicate: () => boolean, attempts = 400) => {
    for (let index = 0; index < attempts && !predicate(); index += 1) {
      await flush()
      await Bun.sleep(5)
    }
    if (!predicate()) throw new Error("runUntil did not settle")
  }
  const connect = async (deviceID: string) => {
    store.connect(deviceID)
    await runUntil(() => store.state().sessions.length > 0)
  }
  const openSession = async (sessionID = "ses_a") => {
    await store.load()
    if (store.state().activeDeviceID === undefined) await connect(devices[0]?.id ?? "dev_1")
    else await runUntil(() => store.state().sessions.length > 0)
    await store.selectSession(sessionID)
    await flush()
  }
  return {
    store,
    relay,
    alerts,
    openAlerts: () => [...openAlerts],
    transports,
    disposals: () => disposals,
    flush,
    runUntil,
    togglePreference: (category, channel) => {
      writeNotificationPreferences(preferences, toggleNotificationChannel(readNotificationPreferences(preferences), category, channel))
    },
    openSession,
    connect,
    stop: async () => {
      store.dispose()
      await relay.stop()
    },
  }
}

let noticeSeq = 0

async function raised(test: Harness, category: NoticeCategory, sessionID = "ses_a") {
  const id = `ntc_${++noticeSeq}`
  const notice = { id, category, sessionID, createdAt: 1_000 + noticeSeq }
  test.relay.pushNotices({ type: "notice.added", notices: [notice], total: noticeSeq })
  test.relay.pushNotices({ type: "notice.present", items: [{ kind: "notice", notice }] })
  await test.runUntil(() => test.store.state().notifications.some((entry) => entry.id === id))
  return id
}

describe("remote notification delivery", () => {
  test("a synced notice outside the resident Sessions page takes its carousel title without a detail read", async () => {
    const test = await harness({ handler: (request) => {
      if (request.operation === "session.list" && request.input?.status === "running") return { ok: true, value: { data: [{ id: "ses_far", title: "Cross-workspace work", time: { created: 1, updated: 2 } }] } }
      if (request.operation === "session.list" && request.input?.status === "idle") return { ok: true, value: { data: [] } }
      return "default"
    } })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().carouselSessions?.some((row) => row.id === "ses_far") === true)
      expect(test.store.state().sessions.some((row) => row.id === "ses_far")).toBe(false)
      await raised(test, "agent-completed", "ses_far")
      expect(test.store.state().notifications[0]).toMatchObject({ sessionID: "ses_far", sessionTitle: "Cross-workspace work" })
      expect(test.relay.requests.filter((request) => request.operation === "session.get" && request.sessionID === "ses_far")).toHaveLength(0)
      expect(test.alerts[0]?.body).toBe("A session finished all its work.")
    } finally { await test.stop() }
  })

  test("coalesces one detail read for unresolved notices and fills retained copies in place", async () => {
    const detail = Promise.withResolvers<Awaited<ReturnType<RelayRequestHandler>>>()
    const test = await harness({ handler: (request) => request.operation === "session.get" && request.sessionID === "ses_far" ? detail.promise : "default" })
    try {
      await test.openSession()
      await raised(test, "agent-completed", "ses_far")
      await test.runUntil(() => test.relay.requests.filter((request) => request.operation === "session.get" && request.sessionID === "ses_far").length === 1)
      await raised(test, "approval-requested", "ses_far")
      const notices = test.store.state().notifications.filter((entry) => entry.sessionID === "ses_far")
      expect(notices).toHaveLength(2)
      detail.resolve({ ok: true, value: { data: { id: "ses_far", title: "Unlisted root", time: { created: 1, updated: 2 } } } })
      await test.runUntil(() => test.store.state().notifications.filter((entry) => entry.sessionID === "ses_far").every((entry) => entry.sessionTitle === "Unlisted root"))
      expect(test.store.state().notifications.filter((entry) => entry.sessionID === "ses_far").map((entry) => entry.id)).toEqual(notices.map((entry) => entry.id))
      expect(test.relay.requests.filter((request) => request.operation === "session.get" && request.sessionID === "ses_far")).toHaveLength(1)
      expect(test.alerts.every((alert) => !alert.body.includes("Unlisted root"))).toBe(true)
    } finally { detail.resolve("default"); await test.stop() }
  }, 15_000)

  test("a failed detail read keeps fixed copy and is not retried by later notices", async () => {
    const test = await harness({ handler: (request) => request.operation === "session.get" && request.sessionID === "ses_far"
      ? { ok: false, code: "session_not_allowed", message: "Unavailable" } : "default" })
    try {
      await test.openSession()
      await raised(test, "agent-completed", "ses_far")
      await test.runUntil(() => test.relay.requests.some((request) => request.operation === "session.get" && request.sessionID === "ses_far"))
      await raised(test, "approval-requested", "ses_far")
      expect(test.store.state().notifications.filter((entry) => entry.sessionID === "ses_far").map((entry) => [entry.sessionTitle, entry.body])).toEqual([
        [undefined, "A session is waiting for you."], [undefined, "A session finished all its work."],
      ])
      expect(test.relay.requests.filter((request) => request.operation === "session.get" && request.sessionID === "ses_far")).toHaveLength(1)
    } finally { await test.stop() }
  }, 15_000)

  test("subscribes to the relay notice log on every open connection, including a reconnect", async () => {
    const test = await harness()
    try {
      await test.openSession()
      expect(test.relay.noticeRequests.map((request) => request.operation)).toEqual(["notice.subscribe"])
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.relay.noticeRequests.length === 2)
      expect(test.relay.noticeRequests.map((request) => request.operation)).toEqual(["notice.subscribe", "notice.subscribe"])
    } finally { await test.stop() }
  })

  test("status frames raise no notice by themselves: only the relay's list does", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().sessionStatus !== undefined)
      test.relay.pushStatus(["ses_a"], [])
      await test.runUntil(() => test.store.state().sessionStatus?.running.has("ses_a") === true)
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      test.relay.pushStatus([], ["ses_a"])
      await test.runUntil(() => test.store.state().sessionStatus?.attention.has("ses_a") === true)
      test.relay.pushStatus([], [])
      await test.runUntil(() => test.store.state().sessionStatus?.attention.size === 0)
      expect(test.store.state().notifications).toEqual([])
      expect(test.alerts).toEqual([])
    } finally { await test.stop() }
  })

  test("raises one notice and one desktop alert for one relay notice", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "agent-completed")
      expect(test.store.state().notifications).toMatchObject([{ category: "agent-completed", body: "A session finished all its work.", synced: true, live: true }])
      expect(test.alerts).toHaveLength(1)

      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.store.state().notifications).toHaveLength(1)
      expect(test.alerts).toHaveLength(1)
    } finally {
      await test.stop()
    }
  })

  test("lists the subscribe page silently, keeps local notices through a resubscribe, and takes the badge total from the relay", async () => {
    const notice = { id: "ntc_50", category: "agent-completed", sessionID: "ses_b", createdAt: 2_000 } as const
    const test = await harness({ noticePage: { notices: [notice], total: 3, unavailable: false } })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().notifications.length === 1)
      test.relay.pushEvent("ses_a", { id: "evt_denied", type: "guardrail.decided", data: { decision: "deny" } })
      await test.runUntil(() => test.store.state().notifications.length === 2)
      expect(test.store.state().notifications.map((entry) => [entry.id, entry.synced, entry.live])).toEqual([
        ["ntc_50", true, false], [expect.stringMatching(/^notice_/), false, true],
      ])
      expect(test.store.state().noticeSync).toEqual({ status: "ready", total: 3, loaded: 1, hidden: 0, loadingMore: false, message: undefined })
      expect(test.alerts).toHaveLength(0)
      test.relay.setNoticePage({ notices: [], total: 0, unavailable: false })
      test.relay.dropConnections(1006, "")
      await test.runUntil(() => test.relay.noticeRequests.length === 2 && test.store.state().notifications.length === 1)
      expect(test.store.state().notifications[0]?.synced).toBe(false)
      expect(test.store.state().noticeSync).toMatchObject({ status: "ready", total: 0, loaded: 0 })
    } finally { await test.stop() }
  })

  test("a failed subscribe is visible, never reads as synced, and a reload recovers it", async () => {
    const test = await harness({ noticeError: { code: "internal_error", message: "Notification storage is unavailable" } })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.status === "error")
      expect(test.store.state().noticeSync).toMatchObject({ status: "error", message: "Notifications: Notification storage is unavailable", total: 0 })
      test.relay.setNoticeError(undefined)
      test.relay.setNoticePage({ notices: [{ id: "ntc_1", category: "agent-completed", sessionID: "ses_a", createdAt: 5 }], total: 1, unavailable: false })
      await test.store.reloadNotifications()
      expect(test.store.state().noticeSync).toMatchObject({ status: "ready", total: 1, loaded: 1, message: undefined })
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["ntc_1"])
    } finally { await test.stop() }
  })

  test("an unreadable page is rejected as a sync error instead of being listed", async () => {
    const test = await harness({ noticeHandler: (request) => request.operation === "notice.subscribe" ? { notices: [{ id: "bad" }], total: 1, unavailable: false } : undefined })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.status === "error")
      expect(test.store.state().noticeSync.message).toBe("Notifications could not be read from the relay.")
      expect(test.store.state().notifications).toEqual([])
    } finally { await test.stop() }
  })

  test("a relay storage fault is shown from the page flag and the live frame, and read all clears it", async () => {
    const test = await harness({ noticePage: { notices: [], total: 2, unavailable: true } })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.status === "error")
      expect(test.store.state().noticeSync.message).toBe("Some notifications could not be saved. Stored unread notifications remain available.")
      test.relay.pushNotices({ type: "notice.cleared" })
      await test.runUntil(() => test.store.state().noticeSync.status === "ready")
      expect(test.store.state().noticeSync).toMatchObject({ total: 0, message: undefined })
      test.relay.pushNotices({ type: "notice.unavailable" })
      await test.runUntil(() => test.store.state().noticeSync.status === "error")
      expect(test.store.state().noticeSync.message).toContain("could not be saved")
      expect(test.store.state().notice).toBe(test.store.state().noticeSync.message)
    } finally { await test.stop() }
  })

  test("Load more appends the next older page by cursor and keeps the relay total", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `ntc_${from - index}`, category: "agent-completed" as const, sessionID: "ses_a", createdAt: 1_000 + from - index }))
    const test = await harness({
      noticePage: { notices: page(120, 50), next: "ntc_71", total: 120, unavailable: false },
      noticeHandler: (request) => request.operation === "notice.list" ? { notices: page(70, 50), next: "ntc_21", total: 120, unavailable: false } : undefined,
    })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.loaded === 50)
      await test.store.loadMoreNotifications()
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.list").map((request) => request.input)).toEqual([{ before: "ntc_71" }])
      expect(test.store.state().noticeSync).toMatchObject({ status: "ready", total: 120, loaded: 100, loadingMore: false })
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual([...page(120, 50), ...page(70, 50)].map((entry) => entry.id))
      expect(test.alerts).toEqual([])
    } finally { await test.stop() }
  })

  test("a Load more response whose cursor a reload of the list replaced is discarded", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `ntc_${from - index}`, category: "agent-completed" as const, sessionID: "ses_a", createdAt: 1_000 + from - index }))
    let release: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => { release = resolve })
    const test = await harness({
      noticePage: { notices: page(120, 50), next: "ntc_71", total: 120, unavailable: false },
      noticeHandler: (request) => request.operation === "notice.list" ? held : undefined,
    })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.loaded === 50)
      const loading = test.store.loadMoreNotifications()
      await test.runUntil(() => test.relay.noticeRequests.some((request) => request.operation === "notice.list"))
      expect(test.store.state().noticeSync.loadingMore).toBe(true)
      test.relay.setNoticePage({ notices: page(30, 10), total: 10, unavailable: false })
      await test.store.reloadNotifications()
      release({ notices: page(70, 50), next: "ntc_21", total: 120, unavailable: false })
      await loading
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(page(30, 10).map((entry) => entry.id))
      expect(test.store.state().noticeSync).toMatchObject({ total: 10, loaded: 10 })
    } finally { release(undefined); await test.stop() }
  })

  test("a Load more response for a cursor that is no longer the oldest loaded notice is discarded", async () => {
    const page = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `ntc_${from - index}`, category: "agent-completed" as const, sessionID: "ses_a", createdAt: 1_000 + from - index }))
    let release: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => { release = resolve })
    const test = await harness({
      noticePage: { notices: page(60, 10), next: "ntc_51", total: 60, unavailable: false },
      noticeHandler: (request) => request.operation === "notice.list" ? held : undefined,
    })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.loaded === 10)
      const loading = test.store.loadMoreNotifications()
      await test.runUntil(() => test.relay.noticeRequests.some((request) => request.operation === "notice.list"))
      test.relay.pushNotices({ type: "notice.removed", ids: ["ntc_51"], total: 59 })
      await test.runUntil(() => test.store.state().noticeSync.loaded === 9)
      release({ notices: page(50, 50), total: 59, unavailable: false })
      await loading
      expect(test.store.state().notifications).toHaveLength(9)
      expect(test.store.state().noticeSync).toMatchObject({ loadingMore: false, loaded: 9 })
    } finally { release(undefined); await test.stop() }
  })

  test("a failed Load more is shown as a sync error without dropping the loaded notices", async () => {
    const test = await harness({
      noticePage: { notices: [{ id: "ntc_9", category: "agent-completed", sessionID: "ses_a", createdAt: 9 }], next: "ntc_9", total: 9, unavailable: false },
      noticeHandler: (request) => request.operation === "notice.list" ? { notices: [{ id: "ntc_8" }], total: 9, unavailable: false } : undefined,
    })
    try {
      await test.openSession()
      await test.runUntil(() => test.store.state().noticeSync.loaded === 1)
      await test.store.loadMoreNotifications()
      expect(test.store.state().noticeSync).toMatchObject({ status: "error", loadingMore: false, loaded: 1, message: "Notifications could not be read from the relay." })
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["ntc_9"])
    } finally { await test.stop() }
  })

  test("raises a synced attention notice and a local guardrail-block notice without its own System alert, while a failed step adds none", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_20", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      test.relay.pushEvent("ses_a", { id: "evt_21", type: "guardrail.asked", data: { id: "grq_1", hardReview: true } })
      await test.flush()
      await raised(test, "approval-requested", "ses_b")
      test.relay.pushEvent("ses_a", { id: "evt_denied", type: "guardrail.decided", data: { decision: "deny" } })
      await test.runUntil(() => test.store.state().notifications.length === 2)
      test.relay.pushEvent("ses_a", { id: "evt_22", type: "session.step.failed", durable: { aggregateID: "ses_a", seq: 6, version: 1 }, data: {} })
      await test.flush()

      expect(test.store.state().notifications.map((entry) => [entry.category, entry.synced])).toEqual([
        ["approval-requested", true],
        ["approval-requested", false],
      ])
      expect(test.alerts.map((alert) => alert.title)).toEqual(["YCoding — needs your attention"])
      expect(test.alerts.every((alert) => !alert.body.includes("per_1") && !alert.body.includes("grq_1"))).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("keeps a muted category silent on both channels", async () => {
    const test = await harness({
      muted: [
        ["approval-requested", "in-app"],
        ["approval-requested", "desktop"],
      ],
    })
    try {
      await test.openSession()
      const notice = { id: "ntc_51", category: "approval-requested" as const, sessionID: "ses_a", createdAt: 5 }
      test.relay.pushNotices({ type: "notice.added", notices: [notice], total: 1 })
      test.relay.pushNotices({ type: "notice.present", items: [{ kind: "notice", notice }] })
      test.relay.pushEvent("ses_a", { id: "evt_denied", type: "guardrail.decided", data: { decision: "deny" } })
      await test.flush()
      await Bun.sleep(30)
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.alerts).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("reads the stored channel preference when the notice arrives", async () => {
    const test = await harness()
    let phase = "open-session"
    let probing: Promise<void> | undefined
    const watchdog = setTimeout(() => {
      probing = test.relay.diagnostics().then((details) => { console.error(JSON.stringify({ diagnostic: "stored-channel", phase, transport: test.store.state().transport,
        connection: test.store.state().connection, sessionListStatus: test.store.state().sessionListStatus, noticeSync: test.store.state().noticeSync,
        notifications: test.store.state().notifications.map((entry) => entry.id), ...details })) })
    }, 4_000)
    try {
      await test.openSession()
      phase = "first-notice"
      test.togglePreference("agent-completed", "desktop")
      await raised(test, "agent-completed")
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["agent-completed"])
      expect(test.alerts).toHaveLength(0)

      test.togglePreference("agent-completed", "desktop")
      phase = "second-notice"
      await raised(test, "agent-completed")
      expect(test.alerts).toHaveLength(1)
    } finally {
      clearTimeout(watchdog)
      if (probing !== undefined) await probing
      await test.stop()
    }
  })

  test("does not alert on history, snapshot reloads, or a reconnect", async () => {
    const test = await harness({
      messages: {
        ses_a: [
          { id: "msg_1", type: "user", text: "before", time: { created: 1 } },
          { id: "msg_2", type: "assistant", agent: "god", content: [{ type: "text", text: "done" }], time: { created: 2, completed: 3 } },
        ],
      },
      permissions: [{ id: "per_old", sessionID: "ses_a", action: "shell", resources: ["bun test"] }],
      guardrailRequests: [
        { id: "grq_old", sessionID: "ses_a", rootSessionID: "ses_a", action: "rm -rf build", resources: ["build"], reason: "Deletion", hardReview: true },
      ],
    })
    try {
      await test.openSession()
      expect(test.store.state().view?.messages).toHaveLength(2)
      expect(test.store.state().view?.requests.map((request) => request.id)).toEqual(["per_old", "grq_old"])
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.alerts).toHaveLength(0)

      test.relay.dropConnections(1006, "")
      await test.runUntil(
        () => test.store.state().transport.kind === "open" && test.store.state().notice?.includes("read-only") === true,
      )
      expect(test.store.state().notifications).toEqual([])
      expect(test.alerts).toEqual([])
    } finally {
      await test.stop()
    }
  })

  test("does not alert when the relay never connects in the first place", async () => {
    const relay = await startRelayDouble()
    const alerts: DesktopAlert[] = []
    const store = createRemoteStore({
      http: createRemoteHttp({ baseURL: relay.httpURL }),
      createTransport: (_deviceID, handlers) => ({
        connect: () => handlers.onStatus?.({ kind: "closed", code: 1006, reason: "unreachable", retryable: true }),
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "closed", code: 1006, reason: "unreachable", retryable: true }) as const,
        request: async () => ({ status: "unavailable", reason: "not-connected" }) as const,
      }),
      notificationDelivery: createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined),
        desktop: {
          show: (alert) => {
            alerts.push(alert)
          },
          dispose: () => {},
        },
      }),
    })
    try {
      await store.load()
      await waitFor(() => store.state().transport.kind === "closed")
      expect(store.state().notifications).toHaveLength(0)
      expect(alerts).toHaveLength(0)
    } finally {
      store.dispose()
      await relay.stop()
    }
  })

  test("stays silent when the connection is closed deliberately", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "approval-requested")
      expect(test.openAlerts()).toHaveLength(1)

      test.store.disconnect()
      await test.flush()
      // A deliberate close is not a machine that stopped reporting, and the alerts
      // it raised end with the connection that raised them.
      expect(test.alerts.map((alert) => alert.title)).not.toContain("YCoding — device disconnected")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)

      await test.openSession()
      await raised(test, "approval-requested")
      expect(test.openAlerts()).toHaveLength(1)

      await test.store.logout()
      expect(test.alerts.map((alert) => alert.title)).not.toContain("YCoding — device disconnected")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("ends a connection's alerts on sign-out and raises new ones after signing in again", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "agent-completed")
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["agent-completed"])
      expect(test.openAlerts()).toHaveLength(1)

      await test.store.logout()
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)

      // The delivery stays usable: the next connection raises its own alerts.
      await test.openSession()
      await raised(test, "agent-completed")
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("ends a connection's alerts when the relay rejects the credential", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "approval-requested")
      expect(test.openAlerts()).toHaveLength(1)

      test.relay.setMe({ error: { code: "unauthorized", message: "Sign in required" } }, 401)
      test.relay.dropConnections(4401, "Your session expired.")
      await test.runUntil(() => test.store.state().connection.kind === "signed-out")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)

      await test.openSession()
      await raised(test, "approval-requested")
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("ends the previous machine's alerts when the device selection changes", async () => {
    const test = await harness({
      devices: [
        { id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true },
        { id: "dev_2", name: "Laptop", createdAt: 2, status: "active", online: true },
      ],
    })
    try {
      await test.openSession()
      await raised(test, "agent-completed")
      expect(test.openAlerts()).toHaveLength(1)

      await test.connect("dev_2")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)
      expect(test.alerts.map((alert) => alert.title)).not.toContain("YCoding — device disconnected")

      await test.store.selectSession("ses_a")
      await test.flush()
      await raised(test, "agent-completed")
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("keeps raised System alerts when the same machine reconnects or the workspace unmounts", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "approval-requested")
      expect(test.openAlerts()).toHaveLength(1)
      const disposals = test.disposals()

      await test.connect("dev_1")
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.disposals()).toBe(disposals)

      test.store.dispose()
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.disposals()).toBe(disposals)
    } finally {
      await test.stop()
    }
  })

  test("a presentation request that reaches the replaced connection of the same machine still raises its System alert", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await test.connect("dev_1")
      const before = test.alerts.length
      test.transports[0]?.onNotices?.({ type: "notice.present", items: [{ kind: "notice", notice: { id: "ntc_41", category: "approval-requested", sessionID: "ses_a", createdAt: 1 },
        detail: { title: "Fix login", need: "review" } }] })
      expect(test.alerts.slice(before)).toEqual([{ title: "YCoding — guardrail review", body: "“Fix login” is waiting for you to approve or reject a guarded action.",
        tag: "ycoding-dev_1-ntc_41", sessionID: "ses_a", notice: { deviceID: "dev_1", noticeID: "ntc_41" } }])
    } finally {
      await test.stop()
    }
  })

  test("keeps separate relay notices newest first", async () => {
    const test = await harness()
    try {
      await test.openSession()
      const first = await raised(test, "approval-requested")
      const second = await raised(test, "approval-requested")
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual([second, first])
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["approval-requested", "approval-requested"])
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("reading a synced notice asks the relay and waits for its removal, while a local notice goes at once", async () => {
    const test = await harness()
    try {
      await test.openSession()
      const synced = await raised(test, "agent-completed")
      test.relay.pushEvent("ses_a", { id: "evt_denied", type: "guardrail.decided", data: { decision: "deny" } })
      await test.runUntil(() => test.store.state().notifications.length === 2)
      const local = test.store.state().notifications.find((entry) => !entry.synced)?.id ?? ""

      await test.store.readNotification(local)
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual([synced])
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.read")).toEqual([])

      await test.store.readNotification(synced)
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.read").map((request) => request.input)).toEqual([{ ids: [synced] }])
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual([synced])
      test.relay.pushNotices({ type: "notice.removed", ids: [synced], total: 0 })
      await test.runUntil(() => test.store.state().notifications.length === 0)
      await test.store.readNotification("unknown")
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.read")).toHaveLength(1)
    } finally {
      await test.stop()
    }
  })

  test("read all removes local notices at once and asks the relay to clear the synced list", async () => {
    const test = await harness()
    try {
      await test.openSession()
      await raised(test, "agent-completed")
      test.relay.pushEvent("ses_a", { id: "evt_denied", type: "guardrail.decided", data: { decision: "deny" } })
      await test.runUntil(() => test.store.state().notifications.length === 2)
      await test.store.readAllNotifications()
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.readAll")).toHaveLength(1)
      expect(test.store.state().notifications.map((entry) => entry.synced)).toEqual([true])
    } finally {
      await test.stop()
    }
  })

  test("reports a read the relay could not take instead of hiding the notice", async () => {
    const test = await harness({ noticeError: { code: "rate_limited", message: "Too many requests" } })
    try {
      await test.openSession()
      const synced = await raised(test, "agent-completed")
      await test.store.readNotification(synced)
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual([synced])
      expect(test.store.state().notice).toBe("Notifications: Too many requests")
    } finally {
      await test.stop()
    }
  })
})
