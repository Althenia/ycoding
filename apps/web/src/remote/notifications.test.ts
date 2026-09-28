import { describe, expect, test } from "bun:test"
import {
  NOTIFICATION_CATEGORIES,
  normalizeNotificationPreferences,
  toggleNotificationChannel,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationPreferences,
} from "./preferences"
import {
  NOTIFICATION_TEXT,
  createDesktopNotifier,
  createNotificationDelivery,
  notificationCategory,
  type DesktopAlert,
  type DesktopNotifier,
} from "./notifications"

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
  test("maps each live event the workspace receives to one category", () => {
    expect(notificationCategory({ type: "session.execution.succeeded", data: {} })).toBeUndefined()
    expect(notificationCategory({ type: "session.execution.failed", data: { error: { code: "x", message: "y" } } })).toBe("error")
    expect(notificationCategory({ type: "session.step.failed", data: { assistantMessageID: "msg_1" } })).toBe("error")
    expect(notificationCategory({ type: "permission.v2.asked", data: { id: "per_1" } })).toBeUndefined()
    expect(notificationCategory({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_a" } } })).toBeUndefined()
    expect(notificationCategory({ type: "guardrail.asked", data: { id: "grq_1", hardReview: true } })).toBeUndefined()
  })

  test("treats only a blocking guardrail decision as a guardrail alert", () => {
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "deny" } })).toBe("guardrail-blocked")
    expect(notificationCategory({ type: "guardrail.decided", data: { decision: "cap_exceeded" } })).toBe("guardrail-blocked")
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

describe("createNotificationDelivery", () => {
  test("raises one in-app notice and one desktop alert for one event", () => {
    const test = deliveryWith({})
    test.delivery.deliver("agent-completed")
    expect(test.delivery.entries()).toMatchObject([{ category: "agent-completed", ...NOTIFICATION_TEXT["agent-completed"], at: 1_001, read: false }])
    expect(test.recorder.alerts).toHaveLength(1)
    expect(test.recorder.alerts[0]?.title).toBe(NOTIFICATION_TEXT["agent-completed"].title)
    expect(test.recorder.alerts[0]?.body).toBe(NOTIFICATION_TEXT["agent-completed"].body)
    expect(test.recorder.alerts[0]?.tag.length).toBeGreaterThan(0)
  })

  test("honors the stored preference of each channel separately", () => {
    const inAppMuted = deliveryWith({ preferences: () => mute("error", "in-app") })
    inAppMuted.delivery.deliver("error")
    expect(inAppMuted.delivery.entries()).toHaveLength(0)
    expect(inAppMuted.recorder.alerts).toHaveLength(1)

    const desktopMuted = deliveryWith({ preferences: () => mute("error", "desktop") })
    desktopMuted.delivery.deliver("error")
    expect(desktopMuted.delivery.entries()).toHaveLength(1)
    expect(desktopMuted.recorder.alerts).toHaveLength(0)

    const bothMuted = deliveryWith({
      preferences: () => mute("error", "in-app", mute("error", "desktop")),
    })
    bothMuted.delivery.deliver("error")
    expect(bothMuted.delivery.entries()).toHaveLength(0)
    expect(bothMuted.recorder.alerts).toHaveLength(0)
  })

  test("reads the preference at delivery time rather than at creation", () => {
    let preferences = mute("error", "in-app")
    const test = deliveryWith({ preferences: () => preferences })
    preferences = normalizeNotificationPreferences(undefined)
    test.delivery.deliver("error")
    expect(test.delivery.entries()).toHaveLength(1)
  })

  test("never copies event payload content into an alert", () => {
    const test = deliveryWith({})
    const payload = { type: "session.step.failed", data: { error: { code: "secret_code", message: "leaked-token-abc" } } }
    const category = notificationCategory(payload)
    expect(category).toBe("error")
    if (category === undefined) return
    test.delivery.deliver(category)
    const alert = test.recorder.alerts[0]
    expect(alert?.body).toBe(NOTIFICATION_TEXT.error.body)
    expect(alert?.title).not.toContain("secret_code")
    expect(alert?.body).not.toContain("leaked-token-abc")
    expect(test.delivery.entries()[0]?.body).not.toContain("leaked-token-abc")
  })

  test("keeps newest notices with session context, limits to 50, and marks or clears them", () => {
    const test = deliveryWith({})
    for (const category of NOTIFICATION_CATEGORIES) test.delivery.deliver(category.id)
    expect(test.delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)

    for (let index = 0; index < 52; index += 1) test.delivery.deliver("error", { sessionID: `ses_${index}`, sessionTitle: `Session ${index}` })
    expect(test.delivery.entries()).toHaveLength(50)
    expect(test.delivery.entries()[0]).toMatchObject({ category: "error", sessionID: "ses_51", sessionTitle: "Session 51", read: false })
    expect(test.delivery.entries().at(-1)?.sessionID).toBe("ses_2")
    test.delivery.markRead()
    expect(test.delivery.entries().every((entry) => entry.read)).toBe(true)
    test.delivery.clear()
    expect(test.delivery.entries()).toEqual([])
    expect(test.recorder.alerts.at(-1)?.body).toBe(NOTIFICATION_TEXT.error.body)
  })

  test("dismisses one notice without touching the others", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.deliver("agent-completed")
    const ids = test.delivery.entries().map((entry) => entry.id)
    expect(ids).toHaveLength(2)
    test.delivery.dismiss(ids[1]!)
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([ids[0]!])
    test.delivery.dismiss("unknown")
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([ids[0]!])
  })

  test("releases the desktop notifier and its notices on dispose", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.dispose()
    expect(test.recorder.disposals()).toBe(1)
    expect(test.delivery.entries()).toHaveLength(0)
  })

  test("keeps a machine-offline notice while disposing unrelated connection notices", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.deliver("device-disconnected")
    const id = test.delivery.entries()[0]!.id
    test.delivery.dispose(true)
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual([id])
    test.delivery.markRead()
    expect(test.delivery.entries()[0]?.read).toBe(true)
    test.delivery.dismiss(id)
    expect(test.delivery.entries()).toEqual([])
  })

  test("keeps delivering after dispose so the next connection can raise its own alerts", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.dispose()
    expect(test.delivery.entries()).toHaveLength(0)

    test.delivery.deliver("error")
    expect(test.delivery.entries().map((entry) => entry.category)).toEqual(["error"])
    expect(test.recorder.alerts).toHaveLength(2)
    expect(test.recorder.disposals()).toBe(1)
  })
})

describe("createDesktopNotifier", () => {
  test("shows each alert through the service worker, keyed like the push alert for the same Session", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      const delivery = createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined), desktop: createDesktopNotifier(async () => worker.registration),
      })
      delivery.deliver("approval-requested", { sessionID: "ses_a", sessionTitle: "Private Session" })
      delivery.deliver("error")
      await Bun.sleep(0)
      expect(worker.shown.map((item) => [item.title, item.options.tag, item.options.data])).toEqual([
        [NOTIFICATION_TEXT["approval-requested"].title, "ycoding-ses_a-approval-requested", { sessionID: "ses_a" }],
        [NOTIFICATION_TEXT.error.title, "ycoding-remote-error", undefined],
      ])
      expect(worker.shown[0]?.options.body).toBe(NOTIFICATION_TEXT["approval-requested"].body)
      expect(worker.shown[0]?.options.body).not.toContain("Private Session")
      expect(FakeNotification.instances).toHaveLength(0)
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
      await Bun.sleep(0)
      expect(delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)
      expect(worker.shown).toHaveLength(0)
      expect(FakeNotification.permissionRequests).toBe(0)
      delivery.dispose()
    })
  })

  test("closes only the alerts it raised when the connection ends", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      await worker.registration.showNotification("pushed", { tag: "ycoding-ses_z-agent-completed" })
      const notifier = createDesktopNotifier(async () => worker.registration)
      notifier.show({ title: "first", body: "same Session", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      notifier.show({ title: "second", body: "same Session", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      notifier.show({ title: "other", body: "no Session", tag: "ycoding-remote-device-disconnected" })
      await Bun.sleep(0)
      expect([...worker.open.keys()].sort()).toEqual(["ycoding-remote-device-disconnected", "ycoding-ses_a-error", "ycoding-ses_z-agent-completed"])
      notifier.dispose()
      await Bun.sleep(0)
      expect([...worker.open.keys()]).toEqual(["ycoding-ses_z-agent-completed"])
    })
  })

  test("retains one machine-offline desktop alert through account confirmation, then clears it on explicit disconnect", async () => {
    await withFakeNotificationAsync("granted", async () => {
      const worker = fakeWorkerRegistration()
      const notifier = createDesktopNotifier(async () => worker.registration)
      notifier.show({ title: "machine", body: "offline", tag: "ycoding-remote-device-disconnected" })
      notifier.show({ title: "step", body: "failed", tag: "ycoding-ses_a-error", sessionID: "ses_a" })
      await Bun.sleep(0)
      notifier.dispose(true)
      await Bun.sleep(0)
      expect([...worker.open.keys()]).toEqual(["ycoding-remote-device-disconnected"])
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
      test.delivery.deliver("error")
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
