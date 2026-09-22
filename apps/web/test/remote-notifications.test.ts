import { describe, expect, test } from "bun:test"
import type { RemoteDeviceInfo } from "@ycoding-ai/remote"
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
import { startRelayDouble, waitFor, type RelayDouble } from "./relay-double"

type Harness = {
  readonly store: RemoteStore
  readonly relay: RelayDouble
  /** Every desktop alert raised, in order. */
  readonly alerts: readonly DesktopAlert[]
  /** Alerts the notifier still holds open on screen. */
  readonly openAlerts: () => readonly DesktopAlert[]
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
  /** Overrides the enrolled devices so a case can switch between two of them. */
  readonly devices?: readonly RemoteDeviceInfo[]
} = {}): Promise<Harness> {
  const devices: readonly RemoteDeviceInfo[] =
    options.devices ?? [{ id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true }]
  const relay = await startRelayDouble({
    watermark: 5,
    advertisedSessions: ["ses_a", "ses_b"],
    messages: options.messages,
    permissions: options.permissions,
    guardrailRequests: options.guardrailRequests,
    me: { user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 }, devices },
  })
  const preferences = mutedStorage(options.muted ?? [])
  const alerts: DesktopAlert[] = []
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
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({ url: relay.wsURL(deviceID), handlers, resetDelayMs: 10, maxDelayMs: 20, schedule }),
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
  const runUntil = async (predicate: () => boolean, attempts = 100) => {
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

describe("remote notification delivery", () => {
  test("raises one notice and one desktop alert for one completed event", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["agent-completed"])
      expect(test.store.state().notifications[0]?.body).toBe("The active session finished its work.")
      expect(test.alerts).toHaveLength(1)

      // The same durable event again is a duplicate, not a second alert.
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.store.state().notifications).toHaveLength(1)
      expect(test.alerts).toHaveLength(1)
    } finally {
      await test.stop()
    }
  })

  test("raises approval, guardrail, and failure categories from the live event stream", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_20", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      test.relay.pushEvent("ses_a", { id: "evt_21", type: "guardrail.asked", data: { id: "grq_1", hardReview: true } })
      await test.flush()
      test.relay.pushEvent("ses_a", { id: "evt_22", type: "session.step.failed", durable: { aggregateID: "ses_a", seq: 6, version: 1 }, data: {} })
      await test.flush()

      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual([
        "approval-requested",
        "guardrail-blocked",
        "error",
      ])
      expect(test.alerts.map((alert) => alert.title)).toEqual([
        "YCoding — approval needed",
        "YCoding — guardrail review",
        "YCoding — session failure",
      ])
      expect(test.alerts.every((alert) => !alert.body.includes("per_1") && !alert.body.includes("grq_1"))).toBe(true)
    } finally {
      await test.stop()
    }
  })

  test("keeps a muted category silent on both channels", async () => {
    const test = await harness({
      muted: [
        ["error", "in-app"],
        ["error", "desktop"],
      ],
    })
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_6", type: "session.step.failed", durable: { aggregateID: "ses_a", seq: 6, version: 1 }, data: {} })
      await test.flush()
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.alerts).toHaveLength(0)
    } finally {
      await test.stop()
    }
  })

  test("reads the stored channel preference when the event arrives", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.togglePreference("agent-completed", "desktop")
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["agent-completed"])
      expect(test.alerts).toHaveLength(0)

      // Turning the channel back on needs no new store; the next event is delivered.
      test.togglePreference("agent-completed", "desktop")
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 7))
      await test.flush()
      expect(test.alerts).toHaveLength(1)
    } finally {
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
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["device-disconnected"])
      expect(test.alerts.map((alert) => alert.title)).toEqual(["YCoding — device disconnected"])
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
      test.relay.pushEvent("ses_a", { id: "evt_20", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      expect(test.openAlerts()).toHaveLength(1)

      test.store.disconnect()
      await test.flush()
      // A deliberate close is not a machine that stopped reporting, and the alerts
      // it raised end with the connection that raised them.
      expect(test.alerts.map((alert) => alert.title)).not.toContain("YCoding — device disconnected")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)

      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_21", type: "permission.v2.asked", data: { id: "per_2", action: "shell" } })
      await test.flush()
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
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.store.state().notifications.map((entry) => entry.category)).toEqual(["agent-completed"])
      expect(test.openAlerts()).toHaveLength(1)

      await test.store.logout()
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)

      // The delivery stays usable: the next connection raises its own alerts.
      await test.openSession()
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
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
      test.relay.pushEvent("ses_a", { id: "evt_20", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      expect(test.openAlerts()).toHaveLength(1)

      test.relay.setMe({ error: { code: "unauthorized", message: "Sign in required" } }, 401)
      test.relay.dropConnections(4401, "Your session expired.")
      await test.runUntil(() => test.store.state().connection.kind === "signed-out")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)

      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_21", type: "permission.v2.asked", data: { id: "per_2", action: "shell" } })
      await test.flush()
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
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.openAlerts()).toHaveLength(1)

      await test.connect("dev_2")
      expect(test.store.state().notifications).toHaveLength(0)
      expect(test.openAlerts()).toHaveLength(0)
      expect(test.disposals()).toBeGreaterThanOrEqual(1)
      expect(test.alerts.map((alert) => alert.title)).not.toContain("YCoding — device disconnected")

      // The new machine's events raise their own alert.
      await test.store.selectSession("ses_a")
      await test.flush()
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      await test.flush()
      expect(test.openAlerts()).toHaveLength(1)
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("replaces a repeated category instead of stacking notices", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", { id: "evt_30", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      test.relay.pushEvent("ses_a", { id: "evt_31", type: "permission.v2.asked", data: { id: "per_2", action: "write" } })
      await test.flush()
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["approval-requested"])
      expect(test.alerts).toHaveLength(2)
    } finally {
      await test.stop()
    }
  })

  test("dismisses one notice and leaves the rest in place", async () => {
    const test = await harness()
    try {
      await test.openSession()
      test.relay.pushEvent("ses_a", durable("session.execution.succeeded", 6))
      test.relay.pushEvent("ses_a", { id: "evt_32", type: "permission.v2.asked", data: { id: "per_1", action: "shell" } })
      await test.flush()
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["agent-completed", "approval-requested"])

      test.store.dismissNotification("agent-completed")
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["approval-requested"])
      test.store.dismissNotification("unknown")
      expect(test.store.state().notifications.map((entry) => entry.id)).toEqual(["approval-requested"])
    } finally {
      await test.stop()
    }
  })
})
