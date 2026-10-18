import { describe, expect, test } from "bun:test"
import { quotaKey, type RemoteQuota } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createNotificationDelivery, type DesktopAlert } from "../src/remote/notifications"
import { normalizeNotificationPreferences } from "../src/remote/preferences"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const quota: RemoteQuota = { providerID: "prov_a", windowID: "weekly", milestone: "cutting-it-close", resetAt: 1_790_000_000_000 }
const devices = [
  { id: "dev_1", name: "Studio Mac", createdAt: 1, status: "active", online: true },
  { id: "dev_2", name: "Laptop", createdAt: 2, status: "active", online: true },
] as const

async function quotaHarness(preferences = normalizeNotificationPreferences(undefined)) {
  const relay = await startRelayDouble({
    advertisedSessions: ["ses_a"],
    me: { user: { id: "user_1" }, session: { expiresAt: 4_102_444_800_000 }, devices: [...devices] },
  })
  const alerts: DesktopAlert[] = []
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) =>
      createRemoteTransport({
        url: relay.wsURL(deviceID),
        handlers,
        resetDelayMs: 10,
        maxDelayMs: 20,
        schedule: () => () => {},
        createSocket: relay.createSocket,
      }),
    schedule: () => () => {},
    batchMs: 20,
    now: () => 1_000,
    notificationDelivery: createNotificationDelivery({
      preferences: () => preferences,
      desktop: { show: (alert) => alerts.push(alert), dispose: () => {} },
      now: () => 5_000,
    }),
  })
  await store.load()
  if (store.state().activeDeviceID === undefined) store.connect("dev_1")
  await waitFor(() => store.state().noticeSync.status === "ready")
  return { store, relay, alerts, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("live quota notices in the remote store", () => {
  test("a quota frame adds one local row for the verified source machine and a repeat adds none", async () => {
    const test = await quotaHarness()
    try {
      const device = test.store.state().activeDeviceID
      test.relay.pushNotices({ type: "notice.quota", ...quota, at: 5_000 })
      test.relay.pushNotices({ type: "notice.quota", ...quota, at: 5_001 })
      await waitFor(() => test.store.state().notifications.length === 1)
      await Bun.sleep(50)
      const rows = test.store.state().notifications
      expect(rows).toMatchObject([{ id: `quota_${device}_${quotaKey(quota)}`, category: "quota-pace", deviceID: device, synced: false, live: true }])
      expect(rows[0]?.sessionID).toBeUndefined()
      expect(test.store.state().noticeSync.total).toBe(0)
      expect(test.alerts).toEqual([])
    } finally { await test.stop() }
  })

  test("a quota row settles locally and read-all keeps the Session notice operation", async () => {
    const test = await quotaHarness()
    try {
      test.relay.pushNotices({ type: "notice.quota", ...quota, at: 5_000 })
      test.relay.pushNotices({ type: "notice.quota", ...quota, milestone: "will-run-out", at: 5_001 })
      await waitFor(() => test.store.state().notifications.length === 2)
      const [first, second] = test.store.state().notifications
      await test.store.readNotification(first!.id)
      expect(test.store.state().notifications.map((row) => row.id)).toEqual([second!.id])
      expect(test.relay.noticeRequests.map((request) => request.operation)).not.toContain("notice.read")
      await test.store.readAllNotifications()
      expect(test.store.state().notifications).toEqual([])
      expect(test.relay.noticeRequests.filter((request) => request.operation === "notice.readAll")).toHaveLength(1)
    } finally { await test.stop() }
  })

  test("In app off lists no row, and the fallback presentation follows only the System switch", async () => {
    const inAppOff = await quotaHarness(normalizeNotificationPreferences({ "quota-pace": { "in-app": false } }))
    try {
      inAppOff.relay.pushNotices({ type: "notice.quota", ...quota, at: 5_000 })
      inAppOff.relay.pushNotices({ type: "notice.present", items: [{ kind: "quota", ...quota }] })
      await waitFor(() => inAppOff.alerts.length === 1)
      expect(inAppOff.store.state().notifications).toEqual([])
      expect(inAppOff.alerts).toMatchObject([{ title: "YCoding — quota pace", usageDeviceID: inAppOff.store.state().activeDeviceID }])
    } finally { await inAppOff.stop() }
    const systemOff = await quotaHarness(normalizeNotificationPreferences({ "quota-pace": { desktop: false } }))
    try {
      systemOff.relay.pushNotices({ type: "notice.present", items: [{ kind: "quota", ...quota }] })
      await Bun.sleep(100)
      expect(systemOff.alerts).toEqual([])
    } finally { await systemOff.stop() }
  })

  test("a frame from a replaced connection is ignored", async () => {
    const test = await quotaHarness()
    try {
      test.store.connect("dev_2")
      await waitFor(() => test.store.state().activeDeviceID === "dev_2" && test.store.state().noticeSync.status === "ready")
      test.relay.pushNotices({ type: "notice.quota", ...quota, at: 5_000 })
      await waitFor(() => test.store.state().notifications.length === 1)
      expect(test.store.state().notifications[0]?.deviceID).toBe("dev_2")
    } finally { await test.stop() }
  })
})
