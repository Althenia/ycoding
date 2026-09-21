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
  closed = false
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(_title: string, options?: NotificationOptions) {
    if (FakeNotification.refuseToConstruct) throw new Error("notification refused")
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
    expect(notificationCategory({ type: "session.execution.succeeded", data: {} })).toBe("agent-completed")
    expect(notificationCategory({ type: "session.execution.failed", data: { error: { code: "x", message: "y" } } })).toBe("error")
    expect(notificationCategory({ type: "session.step.failed", data: { assistantMessageID: "msg_1" } })).toBe("error")
    expect(notificationCategory({ type: "permission.v2.asked", data: { id: "per_1" } })).toBe("approval-requested")
    expect(notificationCategory({ type: "question.v2.asked", data: { id: "que_1" } })).toBe("approval-requested")
    expect(notificationCategory({ type: "guardrail.asked", data: { id: "grq_1", hardReview: true } })).toBe("guardrail-blocked")
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
    expect(test.delivery.entries()).toEqual([
      { id: "agent-completed", category: "agent-completed", ...NOTIFICATION_TEXT["agent-completed"], at: 1_001 },
    ])
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

  test("keeps one notice per category so repeated events cannot stack", () => {
    const test = deliveryWith({})
    for (const category of NOTIFICATION_CATEGORIES) test.delivery.deliver(category.id)
    expect(test.delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)

    test.delivery.deliver("error")
    expect(test.delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)
    const error = test.delivery.entries().find((entry) => entry.category === "error")
    expect(error?.at).toBe(NOTIFICATION_CATEGORIES.length + 1_001)
    expect(test.recorder.alerts).toHaveLength(NOTIFICATION_CATEGORIES.length + 1)
  })

  test("dismisses one notice without touching the others", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.deliver("agent-completed")
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["error", "agent-completed"])
    test.delivery.dismiss("error")
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["agent-completed"])
    test.delivery.dismiss("unknown")
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["agent-completed"])
  })

  test("releases the desktop notifier and its notices on dispose", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.dispose()
    expect(test.recorder.disposals()).toBe(1)
    expect(test.delivery.entries()).toHaveLength(0)
  })

  test("keeps delivering after dispose so the next connection can raise its own alerts", () => {
    const test = deliveryWith({})
    test.delivery.deliver("error")
    test.delivery.dispose()
    expect(test.delivery.entries()).toHaveLength(0)

    test.delivery.deliver("error")
    expect(test.delivery.entries().map((entry) => entry.id)).toEqual(["error"])
    expect(test.recorder.alerts).toHaveLength(2)
    expect(test.recorder.disposals()).toBe(1)
  })
})

describe("createDesktopNotifier", () => {
  test("never requests permission and stays silent until the browser already granted it", () => {
    withFakeNotification("default", () => {
      // The whole delivery path is exercised, not just the notifier: nothing may
      // prompt the browser, and an ungranted browser stays silent.
      const delivery = createNotificationDelivery({
        preferences: () => normalizeNotificationPreferences(undefined),
        desktop: createDesktopNotifier(),
      })
      for (const category of NOTIFICATION_CATEGORIES) delivery.deliver(category.id)
      expect(delivery.entries()).toHaveLength(NOTIFICATION_CATEGORIES.length)
      expect(FakeNotification.instances).toHaveLength(0)
      expect(FakeNotification.permissionRequests).toBe(0)
      delivery.dispose()
    })
  })

  test("replaces a live alert for the same category and closes every alert on dispose", () => {
    withFakeNotification("granted", () => {
      const notifier = createDesktopNotifier()
      notifier.show({ title: "first", body: "same category", tag: "ycoding-error" })
      notifier.show({ title: "second", body: "same category", tag: "ycoding-error" })
      notifier.show({ title: "other", body: "other category", tag: "ycoding-device-disconnected" })
      expect(FakeNotification.instances).toHaveLength(3)
      expect(FakeNotification.instances[0]?.closed).toBe(true)
      expect(FakeNotification.instances[1]?.closed).toBe(false)
      notifier.dispose()
      expect(FakeNotification.instances[1]?.closed).toBe(true)
      expect(FakeNotification.instances[2]?.closed).toBe(true)
      expect(FakeNotification.instances[1]?.onclose).toBeNull()
    })
  })

  test("survives a browser that refuses to construct an alert", () => {
    withFakeNotification("granted", () => {
      FakeNotification.refuseToConstruct = true
      const notifier = createDesktopNotifier()
      expect(() => notifier.show({ title: "YCoding", body: "body", tag: "ycoding-error" })).not.toThrow()
      notifier.dispose()
    })
  })

  test("does not reach for a browser API the delivery path never granted", () => {
    const scope = globalThis as NotificationGlobal
    const original = scope.Notification
    delete scope.Notification
    try {
      const test = deliveryWith({ notifier: createDesktopNotifier() })
      test.delivery.deliver("error")
      expect(test.delivery.entries()).toHaveLength(1)
      test.delivery.dispose()
    } finally {
      if (original !== undefined) scope.Notification = original
    }
  })
})
