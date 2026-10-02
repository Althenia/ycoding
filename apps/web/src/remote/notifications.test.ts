import { describe, expect, test } from "bun:test"
import type { RemoteAlertDetail } from "@ycoding-ai/remote"
import {
  NOTIFICATION_CATEGORIES,
  normalizeNotificationPreferences,
  toggleNotificationChannel,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
} from "./preferences"
import {
  NOTICE_WINDOW,
  NOTIFICATION_TEXT,
  createDesktopNotifier,
  createNotificationDelivery,
  notificationCategory,
  type DesktopAlert,
  type DesktopNotifier,
} from "./notifications"
import { notificationSessionTitle } from "./store"

/** The DOM global is replaced for the duration of the check, then restored. */
type NotificationGlobal = { Notification?: typeof Notification }

/**
 * The browser notification API only exists in a browser, so the notifier's
 * permission, replacement, and teardown behavior is checked against a stand-in
 * constructed and restored around each assertion.
 */
class FakeNotification {
  static permission: NotificationPermission = "granted"
  static instances: FakeNotification[] = []
  static permissionRequests = 0
  static refuseToConstruct = false
  static reset(permission: NotificationPermission) {
    FakeNotification.permission = permission
    FakeNotification.instances = []
    FakeNotification.permissionRequests = 0
    FakeNotification.refuseToConstruct = false
  }
  readonly tag: string
  readonly title: string
  readonly body: string
  closed = false
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onclick: (() => void) | null = null
  constructor(title: string, options?: NotificationOptions) {
    if (FakeNotification.refuseToConstruct) throw new Error("notification refused")
    this.title = title
    this.body = options?.body ?? ""
    this.tag = options?.tag ?? ""
    FakeNotification.instances.push(this)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.permissionRequests += 1
    return FakeNotification.permission
  }
}

function withFakeNotification(permission: NotificationPermission, run: () => void): void {
  const scope = globalThis as NotificationGlobal
  const original = scope.Notification
  FakeNotification.reset(permission)
  scope.Notification = FakeNotification as unknown as typeof Notification
  try {
    run()
  } finally {
    if (original === undefined) delete scope.Notification
    else scope.Notification = original
  }
}

function desktopRecorder() {
  const alerts: DesktopAlert[] = []
  let disposals = 0
  const notifier: DesktopNotifier = {
    show: (alert) => {
      alerts.push(alert)
    },
    dispose: () => {
      disposals += 1
    },
  }
  return { alerts, disposals: () => disposals, notifier }
}

function mute(
  category: NotificationCategory,
  channel: NotificationChannel,
  base: NotificationPreferences = normalizeNotificationPreferences(undefined),
): NotificationPreferences {
  return toggleNotificationChannel(base, category, channel)
}

function clock(start = 1_000): () => number {
  let value = start
  return () => (value += 1)
}

function deliveryWith(options: {
  readonly preferences?: () => NotificationPreferences
  readonly notifier?: DesktopNotifier
  readonly now?: () => number
}) {
  const recorder = desktopRecorder()
  return {
    recorder,
    delivery: createNotificationDelivery({
      preferences: options.preferences ?? (() => normalizeNotificationPreferences(undefined)),
      desktop: options.notifier ?? recorder.notifier,
      now: options.now ?? clock(),
    }),
  }
}

describe("notificationCategory", () => {
  test("finished and attention use fixed privacy-safe copy", () => {
    expect(NOTIFICATION_TEXT["agent-completed"]).toEqual({ title: "YCoding — work finished", body: "A session finished all its work." })
    expect(NOTIFICATION_TEXT["approval-requested"]).toEqual({ title: "YCoding — needs your attention", body: "A session is waiting for you." })
    expect(NOTIFICATION_TEXT["machine-offline"]).toEqual({ title: "YCoding — machine offline", body: "The connected machine stopped reporting." })
  })
  test("maps each live event the workspace receives to one category", () => {
    expect(notificationCategory({ type: "session.execution.succeeded", data: {} })).toBeUndefined()
    expect(notificationCategory({ type: "session.execution.failed", data: { error: { code: "x", message: "y" } } })).toBeUndefined()
    expect(notificationCategory({ type: "session.step.failed", data: { assistantMessageID: "msg_1" } })).toBeUndefined()
    expect(notificationCategory({ type: "permission.v2.asked", data: { id: "per_1" } })).toBeUndefined()
    expect(notificationCategory({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_a" } } })).toBeUndefined()
    expect(notificationCategory({ type: "guardrail.asked", data: { id: "grq_1", hardReview: true } })).toBeUndefined()
  })

  test("treats only a blocking guardrail decision as a guardrail alert", () => {
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "deny" } })).toBe("approval-requested")
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "cap_exceeded" } })).toBe("approval-requested")
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "allow" } })).toBeUndefined()
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "ask" } })).toBeUndefined()
  })

  test("ignores payloads that do not carry a category", () => {
    const ignored = [
      undefined,
      null,
      "session.execution.succeeded",
      7,
      [],
      { data: {} },
      { type: 42, data: {} },
      { type: "session.text.delta", data: { assistantMessageID: "msg_1", ordinal: 0, delta: "hi" } },
      { type: "session.execution.interrupted", data: { reason: "user" } },
      { type: "session.execution.succeeded" },
    ]
    for (const payload of ignored) expect({ payload, category: notificationCategory(payload) }).toEqual({ payload, category: undefined })
  })

  test("uses fixed copy that carries no session, tool, path, or credential content", () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const text = NOTIFICATION_TEXT[category.id]
      expect(text.title).toContain("YCoding")
      expect(text.body.length).toBeGreaterThan(0)
      // Desktop alerts can surface on a locked screen, so the copy stays generic.
      expect(`${text.title} ${text.body}`).not.toMatch(/[/\\]|ses_|msg_|evt_|grq_|per_|que_|\btoken\b|\bbearer\b/i)
    }
  })
})

test("an event for another Session never borrows the selected Session title", () => {
  const state = { sessions: [], carouselSessions: [], selectedSessionInfo: { id: "ses_selected", title: "Selected work" } }
  expect(notificationSessionTitle(state, "ses_other")).toBeUndefined()
  expect(notificationSessionTitle(state, "ses_selected")).toBe("Selected work")
})

describe("createNotificationDelivery", () => {
  test("fills retained notices for one Session without changing IDs or desktop copy", () => {
    const test = deliveryWith({})
    test.delivery.deliver("agent-completed", { sessionID: "ses_a" })
    test.delivery.deliver("approval-requested", { sessionID: "ses_a" })
    test.delivery.deliver("approval-requested", { sessionID: "ses_b" })
    const before = test.delivery.entries().map((entry) => [entry.id, entry.category])
    expect(test.delivery.setSessionTitle("ses_a", "Named work")).toBe(true)
    expect(test.delivery.entries().map((entry) => [entry.id, entry.category])).toEqual(before)
    expect(test.delivery.entries().map((entry) => entry.sessionTitle)).toEqual([undefined, "Named work", "Named work"])
    expect(test.delivery.setSessionTitle("ses_a", "Different title")).toBe(false)
    expect(test.recorder.alerts.every((alert) => !alert.body.includes("Named work"))).toBe(true)
  })

  test("raises one in-app notice and leaves the System alert to the relay for one local event", () => {
    const test = deliveryWith({})
    test.delivery.deliver("agent-completed")
    expect(test.delivery.entries()).toMatchObject([{ category: "agent-completed", ...NOTIFICATION_TEXT["agent-completed"], at: 1_001, synced: false, live: true }])
    expect(test.recorder.alerts).toEqual([])
  })

  test("a local guardrail-block notice and the relay notice for the same Session keep one row", () => {
    const later = deliveryWith({})
    later.delivery.deliver("approval-requested", { sessionID: "ses_a" })
    later.delivery.receive({ id: "ntc_3", category: "approval-requested", at: 2, sessionID: "ses_a" }, "dev_1")
    expect(later.delivery.entries().map((entry) => entry.id)).toEqual(["ntc_3"])
    const earlier = deliveryWith({})
    earlier.delivery.receive({ id: "ntc_3", category: "approval-requested", at: 2, sessionID: "ses_a" }, "dev_1")
    earlier.delivery.deliver("approval-requested", { sessionID: "ses_a" })
    earlier.delivery.deliver("approval-requested", { sessionID: "ses_b" })
    expect(earlier.delivery.entries().map((entry) => entry.sessionID)).toEqual(["ses_b", "ses_a"])
  })

  test("each confirmed machine outage adds one fixed in-app notice, and only a relay directive raises its System alert", () => {
    const test = deliveryWith({})
    test.delivery.offline("dev_1", 1_000)
    test.delivery.offline("dev_1", 1_000)
    expect(test.delivery.entries()).toMatchObject([{ category: "machine-offline", ...NOTIFICATION_TEXT["machine-offline"], at: 1_000 }])
    expect(test.recorder.alerts).toEqual([])
    test.delivery.offline("dev_1", 9_000)
    test.delivery.present([{ kind: "offline", at: 1_000 }, { kind: "offline", at: 9_000 }], "dev_1")
    test.delivery.present([{ kind: "offline", at: 1_000 }], "dev_2")
    expect(test.recorder.alerts).toEqual([
      { ...NOTIFICATION_TEXT["machine-offline"], tag: "ycoding-dev_1-offline-1000" },
      { ...NOTIFICATION_TEXT["machine-offline"], tag: "ycoding-dev_1-offline-9000" },
      { ...NOTIFICATION_TEXT["machine-offline"], tag: "ycoding-dev_2-offline-1000" },
    ])
    expect(test.delivery.entries()).toHaveLength(2)
  })

  test("honors the stored preference of each channel separately", () => {
    const inAppMuted = deliveryWith({ preferences: () => mute("approval-requested", "in-app") })
    inAppMuted.delivery.deliver("approval-requested")
    expect(inAppMuted.delivery.entries()).toHaveLength(0)
    expect(inAppMuted.recorder.alerts).toHaveLength(0)

    const desktopMuted = deliveryWith({ preferences: () => mute("approval-requested", "desktop") })
    desktopMuted.delivery.deliver("approval-requested")
    expect(desktopMuted.delivery.entries()).toHaveLength(1)
    expect(desktopMuted.recorder.alerts).toHaveLength(0)

    const bothMuted = deliveryWith({
      preferences: () => mute("approval-requested", "in-app", mute("approval-requested", "desktop")),
    })
    bothMuted.delivery.deliver("approval-requested")
    expect(bothMuted.delivery.entries()).toHaveLength(0)
    expect(bothMuted.recorder.alerts).toHaveLength(0)
  })

  test("reads the preference at delivery time rather than at creation", () => {
    let preferences = mute("approval-requested", "in-app")
    const test = deliveryWith({ preferences: () => preferences })
    preferences = normalizeNotificationPreferences(undefined)
    test.delivery.deliver("approval-requested")
    expect(test.delivery.entries()).toHaveLength(1)
  })

  test("never copies event payload content into a notice", () => {
    const test = deliveryWith({})
    const payload = { type: "guardrail.decided", data: { decision: "deny", error: { code: "secret_code", message: "leaked-token-abc" } } }
    const category = notificationCategory(payload)
    expect(category).toBe("approval-requested")
    if (category === undefined) return
    test.delivery.deliver(category)
    expect(test.delivery.entries()[0]?.body).toBe(NOTIFICATION_TEXT["approval-requested"].body)
    expect(test.delivery.entries()[0]?.title).not.toContain("secret_code")
    expect(test.delivery.entries()[0]?.body).not.toContain("leaked-token-abc")
  })

  test("keeps the newest local notices with session context up to the local limit", () => {
    const test = deliveryWith({})
    for (const category of NOTIFICATION_CATEGORIES) test.delivery.deliver(category.id)
    expect(test.delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)

    for (let index = 0; index < 52; index += 1) test.delivery.deliver("approval-requested", { sessionID: `ses_${index}`, sessionTitle: `Session ${index}` })
    expect(test.delivery.entries()).toHaveLength(50)
    expect(test.delivery.entries()[0]).toMatchObject({ category: "approval-requested", sessionID: "ses_51", sessionTitle: "Session 51" })
    expect(test.delivery.entries().at(-1)?.sessionID).toBe("ses_2")
  })

  test("removes notices by id without touching the others", () => {
    const test = deliveryWith({})
    test.delivery.deliver("approval-requested")
    test.delivery.deliver("agent-completed")
    test.delivery.offline("dev_1", 1_000)
    const ids = test.delivery.entries().map((entry) => entry.id)
    expect(ids).toHaveLength(3)
    test.delivery.remove([ids[1]!, "unknown"])
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([ids[0]!, ids[2]!])
    test.delivery.remove([])
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([ids[0]!, ids[2]!])
  })

  test("lists a synced live notice with the relay id, time, and live mark without raising a System alert itself", () => {
    const test = deliveryWith({})
    test.delivery.receive({ id: "ntc_7", category: "approval-requested", at: 555, sessionID: "ses_a", sessionTitle: "Named" }, "dev_1")
    expect(test.delivery.entries()).toEqual([{ id: "ntc_7", category: "approval-requested", ...NOTIFICATION_TEXT["approval-requested"], at: 555, sessionID: "ses_a", sessionTitle: "Named", synced: true, live: true }])
    expect(test.recorder.alerts).toEqual([])
  })

  test("each presented notice raises its own alert so a repeat in the same Session is not silently replaced", () => {
    const test = deliveryWith({})
    const notice = (id: string) => ({ kind: "notice" as const, notice: { id, category: "agent-completed" as const, sessionID: "ses_a", createdAt: 1 } })
    test.delivery.present([notice("ntc_8"), notice("ntc_9")], "dev_1")
    expect(test.recorder.alerts).toEqual([
      { ...NOTIFICATION_TEXT["agent-completed"], tag: "ycoding-dev_1-ntc_8", sessionID: "ses_a", notice: { deviceID: "dev_1", noticeID: "ntc_8" } },
      { ...NOTIFICATION_TEXT["agent-completed"], tag: "ycoding-dev_1-ntc_9", sessionID: "ses_a", notice: { deviceID: "dev_1", noticeID: "ntc_9" } },
    ])
  })

  test("a presented notice names its Session and what the Session needs", () => {
    const test = deliveryWith({})
    const attention = (id: string, detail: RemoteAlertDetail) =>
      ({ kind: "notice" as const, notice: { id, category: "approval-requested" as const, sessionID: "ses_a", createdAt: 1 }, detail })
    test.delivery.present([
      attention("ntc_1", { title: "Fix login", need: "permission" }), attention("ntc_2", { title: "Fix login", need: "question" }),
      attention("ntc_3", { title: "Fix login", need: "review" }), attention("ntc_4", { title: "Fix login", need: "failed" }),
      attention("ntc_5", { title: "Fix login" }), attention("ntc_6", { need: "failed" }),
      { kind: "notice", notice: { id: "ntc_7", category: "agent-completed", sessionID: "ses_a", createdAt: 1 }, detail: { title: "Fix login" } },
    ], "dev_1")
    expect(test.recorder.alerts.map((alert) => [alert.title, alert.body])).toEqual([
      ["YCoding — approval needed", "“Fix login” is waiting for you to allow or deny a tool request."],
      ["YCoding — question for you", "“Fix login” is waiting for your answer."],
      ["YCoding — guardrail review", "“Fix login” is waiting for you to approve or reject a guarded action."],
      ["YCoding — session failed", "“Fix login” stopped with an error. Open it to review and retry."],
      ["YCoding — needs your attention", "“Fix login” is waiting for you."],
      ["YCoding — session failed", "A session stopped with an error. Open it to review and retry."],
      ["YCoding — work finished", "“Fix login” finished all its work."],
    ])
  })

  test("a presented notice honors each channel preference like a local one", () => {
    const present = { kind: "notice" as const, notice: { id: "ntc_1", category: "agent-completed" as const, sessionID: "ses_a", createdAt: 1 } }
    const inAppMuted = deliveryWith({ preferences: () => mute("agent-completed", "in-app") })
    inAppMuted.delivery.receive({ id: "ntc_1", category: "agent-completed", at: 1, sessionID: "ses_a" }, "dev_1")
    inAppMuted.delivery.present([present], "dev_1")
    expect(inAppMuted.delivery.entries()).toEqual([])
    expect(inAppMuted.recorder.alerts).toHaveLength(1)
    const desktopMuted = deliveryWith({ preferences: () => mute("agent-completed", "desktop") })
    desktopMuted.delivery.receive({ id: "ntc_1", category: "agent-completed", at: 1, sessionID: "ses_a" }, "dev_1")
    desktopMuted.delivery.present([present], "dev_1")
    expect(desktopMuted.delivery.entries()).toHaveLength(1)
    expect(desktopMuted.recorder.alerts).toEqual([])
  })

  test("replacing the synced list keeps local entries, orders newest first, and raises no alert or live mark", () => {
    const test = deliveryWith({})
    test.delivery.offline("dev_1", 1_000)
    test.delivery.receive({ id: "ntc_5", category: "agent-completed", at: 10, sessionID: "ses_gone" }, "dev_1")
    const alerts = test.recorder.alerts.length
    test.delivery.replaceSynced([
      { id: "ntc_3", category: "approval-requested", at: 200, sessionID: "ses_c" },
      { id: "ntc_2", category: "approval-requested", at: 200, sessionID: "ses_b", sessionTitle: "Beta" },
      { id: "ntc_1", category: "agent-completed", at: 100, sessionID: "ses_a" },
    ])
    expect(test.recorder.alerts).toHaveLength(alerts)
    expect(test.delivery.entries().map((entry) => [entry.id, entry.synced, entry.live])).toEqual([
      [expect.stringMatching(/^offline_/), false, true], ["ntc_3", true, false], ["ntc_2", true, false], ["ntc_1", true, false],
    ])
    expect(test.delivery.entries().find((entry) => entry.id === "ntc_2")?.sessionTitle).toBe("Beta")
    expect(test.delivery.syncedLoaded()).toBe(3)
    expect(test.delivery.oldestSynced()).toBe("ntc_1")
    test.delivery.replaceSynced([])
    expect(test.delivery.entries().map((entry) => entry.category)).toEqual(["machine-offline"])
    expect(test.delivery.syncedLoaded()).toBe(0)
    expect(test.delivery.oldestSynced()).toBeUndefined()
  })

  test("appending an older page is silent, skips notices already held, and keeps the newest-first order", () => {
    const test = deliveryWith({})
    test.delivery.replaceSynced([
      { id: "ntc_9", category: "agent-completed", at: 90, sessionID: "ses_a" },
      { id: "ntc_8", category: "agent-completed", at: 80, sessionID: "ses_b" },
    ])
    const alerts = test.recorder.alerts.length
    test.delivery.appendSynced([
      { id: "ntc_8", category: "agent-completed", at: 80, sessionID: "ses_b" },
      { id: "ntc_7", category: "approval-requested", at: 70, sessionID: "ses_c" },
    ])
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["ntc_9", "ntc_8", "ntc_7"])
    expect(test.delivery.entries().every((entry) => !entry.live)).toBe(true)
    expect(test.recorder.alerts).toHaveLength(alerts)
    expect(test.delivery.oldestSynced()).toBe("ntc_7")
  })

  test("a live notice already held from a page neither repeats its alert nor its row", () => {
    const test = deliveryWith({})
    test.delivery.replaceSynced([{ id: "ntc_4", category: "agent-completed", at: 40, sessionID: "ses_a" }])
    test.delivery.receive({ id: "ntc_4", category: "agent-completed", at: 40, sessionID: "ses_a" }, "dev_1")
    expect(test.delivery.entries()).toHaveLength(1)
    expect(test.recorder.alerts).toEqual([])
  })

  test("a page honors the in-app preference by counting hidden notices as loaded, not listed", () => {
    const test = deliveryWith({ preferences: () => mute("agent-completed", "in-app") })
    test.delivery.replaceSynced([
      { id: "ntc_2", category: "approval-requested", at: 2, sessionID: "ses_b" },
      { id: "ntc_1", category: "agent-completed", at: 1, sessionID: "ses_a" },
    ])
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["ntc_2"])
    expect(test.delivery.syncedLoaded()).toBe(2)
    expect(test.delivery.syncedHidden()).toBe(1)
    expect(test.delivery.oldestSynced()).toBe("ntc_1")
    test.delivery.receive({ id: "ntc_3", category: "agent-completed", at: 3, sessionID: "ses_c" }, "dev_1")
    expect(test.delivery.syncedHidden()).toBe(2)
    expect(test.recorder.alerts).toEqual([])
    test.delivery.remove(["ntc_1", "ntc_3"])
    expect(test.delivery.syncedHidden()).toBe(0)
  })

  test("the loaded synced window is bounded to the newest entries and local notices stay outside it", () => {
    const test = deliveryWith({})
    test.delivery.offline("dev_1", 1_000)
    const older = Array.from({ length: NOTICE_WINDOW }, (_, index) => ({ id: `ntc_${index + 1}`, category: "agent-completed" as const, at: index + 1, sessionID: "ses_a" }))
    test.delivery.replaceSynced([...older].reverse())
    expect(test.delivery.syncedLoaded()).toBe(NOTICE_WINDOW)
    test.delivery.receive({ id: `ntc_${NOTICE_WINDOW + 1}`, category: "approval-requested", at: NOTICE_WINDOW + 1, sessionID: "ses_b" }, "dev_1")
    expect(test.delivery.syncedLoaded()).toBe(NOTICE_WINDOW)
    expect(test.delivery.oldestSynced()).toBe("ntc_2")
    expect(test.delivery.entries().some((entry) => entry.id === "ntc_1")).toBe(false)
    expect(test.delivery.entries().some((entry) => !entry.synced)).toBe(true)
  })

  test("clearing the synced list keeps local notices", () => {
    const test = deliveryWith({})
    test.delivery.offline("dev_1", 1_000)
    test.delivery.replaceSynced([{ id: "ntc_1", category: "agent-completed", at: 1, sessionID: "ses_a" }])
    test.delivery.clearSynced()
    expect(test.delivery.entries().map((entry) => entry.category)).toEqual(["machine-offline"])
    expect(test.delivery.syncedLoaded()).toBe(0)
  })

  test("releases the desktop notifier and its notices on dispose", () => {
    const test = deliveryWith({})
    test.delivery.deliver("approval-requested")
    test.delivery.dispose()
    expect(test.recorder.disposals()).toBe(1)
    expect(test.delivery.entries()).toHaveLength(0)
  })

  test("keeps a machine-offline notice while disposing unrelated connection notices", () => {
    const test = deliveryWith({})
    test.delivery.deliver("approval-requested")
    test.delivery.offline("dev_1", 1_000)
    const id = test.delivery.entries().find((entry) => entry.category === "machine-offline")!.id
    test.delivery.dispose(true)
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([id])
    test.delivery.remove([id])
    expect(test.delivery.entries()).toEqual([])
  })

  test("keeps delivering after dispose so the next connection can raise its own alerts", () => {
    const test = deliveryWith({})
    test.delivery.deliver("approval-requested")
    test.delivery.dispose()
    expect(test.delivery.entries()).toHaveLength(0)

    test.delivery.deliver("approval-requested")
    test.delivery.present([{ kind: "offline", at: 1_000 }], "dev_1")
    expect(test.delivery.entries().map((entry) => entry.category)).toEqual(["approval-requested"])
    expect(test.recorder.alerts).toHaveLength(1)
    expect(test.recorder.disposals()).toBe(1)
  })
})

describe("createDesktopNotifier", () => {
  test("shows each presented alert through the service worker, keyed like the push alert for the same notice", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      const delivery = createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined), desktop: createDesktopNotifier(async () => worker.registration),
      })
      delivery.deliver("approval-requested", { sessionID: "ses_a", sessionTitle: "Private Session" })
      await Bun.sleep(0)
      expect(worker.shown).toEqual([])
      expect(FakeNotification.instances).toHaveLength(0)
      delivery.present([{ kind: "notice", notice: { id: "ntc_4", category: "approval-requested", sessionID: "ses_a", createdAt: 1 },
        detail: { title: "Fix login", need: "question" } }], "dev_1")
      await Bun.sleep(0)
      expect(worker.shown.at(-1)).toMatchObject({ title: "YCoding — question for you",
        options: { body: "“Fix login” is waiting for your answer.", tag: "ycoding-dev_1-ntc_4", data: { sessionID: "ses_a", deviceID: "dev_1", noticeID: "ntc_4" } } })
      expect(worker.shown.at(-1)?.options).not.toHaveProperty("renotify")
      delivery.present([{ kind: "notice", notice: { id: "ntc_4", category: "approval-requested", sessionID: "ses_a", createdAt: 1 },
        detail: { title: "Fix login", need: "failed", repeat: true } }], "dev_1")
      await Bun.sleep(0)
      expect(worker.shown.at(-1)).toMatchObject({ title: "YCoding — session failed", options: { tag: "ycoding-dev_1-ntc_4", renotify: true } })
      delivery.dispose()
    })
  })

  test("never requests permission and stays silent until the browser already granted it", async () => {
    await withFakeNotificationAsync("default", async () => {
      const worker = fakeWorkerRegistration()
      const delivery = createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined),
        desktop: createDesktopNotifier(async () => worker.registration),
      })
      for (const category of NOTIFICATION_CATEGORIES) delivery.deliver(category.id)
      delivery.present([{ kind: "notice", notice: { id: "ntc_1", category: "agent-completed", sessionID: "ses_a", createdAt: 1 } }, { kind: "offline", at: 1_000 }], "dev_1")
      await Bun.sleep(0)
      expect(delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)
      expect(worker.shown).toHaveLength(0)
      expect(FakeNotification.permissionRequests).toBe(0)
      delivery.dispose()
    })
  })

  test("registers the built worker on demand when a granted alert arrives before page-load registration", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const original = Reflect.get(globalThis, "navigator")
      const worker = fakeWorkerRegistration()
      const registered: string[] = []
      Reflect.set(globalThis, "navigator", { serviceWorker: {
        getRegistration: async () => undefined,
        ready: Promise.resolve(worker.registration),
        register: async (url: string, options: { type: string }) => {
          registered.push(`${url}:${options.type}`)
          return worker.registration
        },
      } })
      try {
        const notifier = createDesktopNotifier()
        notifier.show({ title: "YCoding — work finished", body: "A session finished all its work.", tag: "ycoding-ses_a-agent-completed", sessionID: "ses_a" })
        await Bun.sleep(0)
        expect(registered).toEqual(["/sw.js:module"])
        expect(worker.shown).toMatchObject([{ title: "YCoding — work finished", options: { tag: "ycoding-ses_a-agent-completed", data: { sessionID: "ses_a" } } }])
        notifier.dispose()
      } finally {
        Reflect.set(globalThis, "navigator", original)
      }
    })
  })

  test("waits for an installing worker to activate before posting a granted alert", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const original = Reflect.get(globalThis, "navigator")
      const worker = fakeWorkerRegistration()
      const shownEarly: string[] = []
      let activate: (value: typeof worker.registration) => void = () => undefined
      const ready = new Promise<typeof worker.registration>((resolve) => { activate = resolve })
      Reflect.set(globalThis, "navigator", { serviceWorker: {
        getRegistration: async () => ({ active: null, showNotification: async () => { shownEarly.push("before activation") } }),
        ready,
      } })
      try {
        createDesktopNotifier().show({ title: "YCoding — work finished", body: "A session finished all its work.", tag: "ycoding-ses_a-agent-completed" })
        await Bun.sleep(0)
        expect(shownEarly).toEqual([])
        activate(worker.registration)
        await Bun.sleep(0)
        expect(worker.shown).toMatchObject([{ title: "YCoding — work finished" }])
      } finally {
        Reflect.set(globalThis, "navigator", original)
      }
    })
  })

  test("closes only the alerts it raised when the connection ends", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      await worker.registration.showNotification("pushed", { tag: "ycoding-ses_z-agent-completed" })
      const notifier = createDesktopNotifier(async () => worker.registration)
      notifier.show({ title: "first", body: "same Session", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      notifier.show({ title: "second", body: "same Session", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      notifier.show({ title: "other", body: "no Session", tag: "ycoding-dev_1-offline-1000" })
      await Bun.sleep(0)
      expect([...worker.open.keys()].sort()).toEqual(["ycoding-dev_1-offline-1000", "ycoding-ses_a-error", "ycoding-ses_z-agent-completed"])
      notifier.dispose()
      await Bun.sleep(0)
      expect([...worker.open.keys()]).toEqual(["ycoding-ses_z-agent-completed"])
    })
  })

  test("retains one machine-offline desktop alert through account confirmation, then clears it on explicit disconnect", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      const notifier = createDesktopNotifier(async () => worker.registration)
      notifier.show({ title: "machine", body: "offline", tag: "ycoding-dev_1-offline-1000" })
      notifier.show({ title: "step", body: "failed", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      await Bun.sleep(0)
      notifier.dispose(true)
      await Bun.sleep(0)
      expect([...worker.open.keys()]).toEqual(["ycoding-dev_1-offline-1000"])
      notifier.dispose()
      await Bun.sleep(0)
      expect([...worker.open.keys()]).toEqual([])
    })
  })

  test("stays silent without a service worker or when the worker refuses an alert", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const absent = createDesktopNotifier(async () => undefined)
      expect(() => absent.show({ title: "YCoding", body: "body", tag: "ycoding-remote-error" })).not.toThrow()
      absent.dispose()
      const refusing = createDesktopNotifier(async () => ({
        showNotification: () => Promise.reject(new Error("refused")),
        getNotifications: () => Promise.reject(new Error("refused")),
      }))
      refusing.show({ title: "YCoding", body: "body", tag: "ycoding-remote-error" })
      refusing.dispose()
      await Bun.sleep(0)
      expect(FakeNotification.instances).toHaveLength(0)
    })
  })

  test("does not reach for a browser API the delivery path never granted", () => {
    const scope = globalThis as NotificationGlobal
    const original = scope.Notification
    delete scope.Notification
    try {
      let requested = 0
      const test = deliveryWith({ notifier: createDesktopNotifier(async () => { requested += 1; return undefined }) })
      test.delivery.deliver("approval-requested")
      expect(test.delivery.entries()).toHaveLength(1)
      expect(requested).toBe(0)
      test.delivery.dispose()
    } finally {
      if (original !== undefined) scope.Notification = original
    }
  })
})

async function withFakeNotificationAsync(permission: NotificationPermission, run: () => Promise<void>): Promise<void> {
  const scope = globalThis as NotificationGlobal
  const original = scope.Notification
  FakeNotification.reset(permission)
  scope.Notification = FakeNotification as unknown as typeof Notification
  try {
    await run()
  } finally {
    if (original === undefined) delete scope.Notification
    else scope.Notification = original
  }
}

function fakeWorkerRegistration() {
  const shown: { readonly title: string; readonly options: NotificationOptions }[] = []
  const open = new Map<string, { readonly tag: string; close: () => void }>()
  const registration = {
    showNotification: async (title: string, options: NotificationOptions = {}) => {
      shown.push({ title, options })
      const tag = options.tag ?? ""
      open.set(tag, { tag, close: () => { open.delete(tag) } })
    },
    getNotifications: async () => [...open.values()],
  }
  return { registration, shown, open }
}
