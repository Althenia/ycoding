import { describe, expect, test } from "bun:test"
import { quotaKey, type RemoteNoticeFrame, type RemoteQuota } from "@ycoding-ai/remote"
import { createRemoteHttp } from "../src/remote/http"
import { createNotificationDelivery, type DesktopAlert } from "../src/remote/notifications"
import { normalizeNotificationPreferences } from "../src/remote/preferences"
import { createRemoteStore } from "../src/remote/store"
import type { RemoteTransport, RemoteTransportHandlers } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const quota: RemoteQuota = { providerID: "prov_a", windowID: "weekly", milestone: "cutting-it-close", resetAt: 1_790_000_000_000 }

async function quotaHarness(preferences = normalizeNotificationPreferences(undefined)) {
  const relay = await startRelayDouble({ advertisedSessions: ["ses_a"] })
  const sockets: { readonly deviceID: string; readonly handlers: RemoteTransportHandlers; readonly requests: string[] }[] = []
  const alerts: DesktopAlert[] = []
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (deviceID, handlers) => {
      const socket = { deviceID, handlers, requests: [] as string[] }
      sockets.push(socket)
      const transport: RemoteTransport = {
        connect: () => handlers.onStatus?.({ kind: "open" }),
        close: () => {},
        setPriority: () => {},
        status: () => ({ kind: "open" }),
        request: async (operation) => {
          socket.requests.push(operation)
          if (operation === "notice.subscribe") return { status: "ok", value: { notices: [], total: 0, unavailable: false } }
          return { status: "ok", value: { data: operation.endsWith(".list") ? [] : {} } }
        },
      }
      return transport
    },
    notificationDelivery: createNotificationDelivery({ preferences: () => preferences, desktop: { show: (alert) => alerts.push(alert), dispose: () => {} }, now: () => 5_000 }),
    schedule: () => () => {},
    now: () => 1_000,
  })
  await store.load()
  await waitFor(() => sockets.length > 0 && store.state().noticeSync.status === "ready")
  const send = (frame: RemoteNoticeFrame, socket = sockets.at(-1)!) => socket.handlers.onNotices?.(frame)
  return { store, sockets, alerts, send, stop: async () => { store.dispose(); await relay.stop() } }
}

describe("live quota notices in the remote store", () => {
  test("a quota frame adds one local row for the verified source machine and a repeat adds none", async () => {
    const test = await quotaHarness()
    try {
      const device = test.store.state().activeDeviceID
      test.send({ type: "notice.quota", ...quota, at: 5_000 })
      test.send({ type: "notice.quota", ...quota, at: 5_001 })
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
      test.send({ type: "notice.quota", ...quota, at: 5_000 })
      test.send({ type: "notice.quota", ...quota, milestone: "will-run-out", at: 5_001 })
      const requests = test.sockets.at(-1)!.requests
      const [first, second] = test.store.state().notifications
      await test.store.readNotification(first!.id)
      expect(test.store.state().notifications.map((row) => row.id)).toEqual([second!.id])
      expect(requests).not.toContain("notice.read")
      await test.store.readAllNotifications()
      expect(test.store.state().notifications).toEqual([])
      expect(requests.filter((operation) => operation.startsWith("notice.") && operation !== "notice.subscribe")).toEqual(["notice.readAll"])
    } finally { await test.stop() }
  })

  test("In app off lists no row, and the fallback presentation follows only the System switch", async () => {
    const inAppOff = await quotaHarness(normalizeNotificationPreferences({ "quota-pace": { "in-app": false } }))
    try {
      inAppOff.send({ type: "notice.quota", ...quota, at: 5_000 })
      inAppOff.send({ type: "notice.present", items: [{ kind: "quota", ...quota }] })
      expect(inAppOff.store.state().notifications).toEqual([])
      expect(inAppOff.alerts).toMatchObject([{ title: "YCoding — quota pace", usageDeviceID: inAppOff.store.state().activeDeviceID }])
    } finally { await inAppOff.stop() }
    const systemOff = await quotaHarness(normalizeNotificationPreferences({ "quota-pace": { desktop: false } }))
    try {
      systemOff.send({ type: "notice.present", items: [{ kind: "quota", ...quota }] })
      expect(systemOff.alerts).toEqual([])
    } finally { await systemOff.stop() }
  })

  test("a frame from a replaced connection is ignored", async () => {
    const test = await quotaHarness()
    try {
      const old = test.sockets[0]!
      test.store.connect("dev_2")
      expect(test.sockets.length).toBe(2)
      test.send({ type: "notice.quota", ...quota, at: 5_000 }, old)
      expect(test.store.state().notifications).toEqual([])
    } finally { await test.stop() }
  })
})
