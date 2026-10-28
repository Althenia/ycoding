import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import type { RemoteSession } from "./context"
import { preloadUsage } from "./preload"
import { createRemoteQueries, createRemoteQueryClient, type RemoteLink } from "./queries"
import type { RemoteTransportRequest } from "./transport"
import { usageReportInputs, usageZoneKey } from "./ui/usage-model"

const now = Date.UTC(2026, 9, 28, 12)
let zone: string | null = null
let priorStorage: PropertyDescriptor | undefined

beforeEach(() => {
  setSystemTime(new Date(now))
  priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => (key === usageZoneKey ? zone : null) } })
})

afterEach(() => {
  setSystemTime()
  zone = null
  if (priorStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage")
  else Object.defineProperty(globalThis, "localStorage", priorStorage)
})

function session(connected: boolean) {
  const calls: { operation: string; request: RemoteTransportRequest | undefined }[] = []
  const queryClient = createRemoteQueryClient()
  const settled = new Promise<void>((resolve) => {
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") resolve()
    })
  })
  const link: RemoteLink = {
    request: async (_scope, operation, request) => {
      calls.push({ operation, request })
      return { status: "ok", value: { data: { status: "preparing" } } }
    },
    recoveries: () => 0,
    recovered: async () => false,
  }
  const state = () => ({
    activeDeviceID: "dev_1",
    generation: 1,
    transport: { kind: connected ? "open" : "closed" },
    connection: { kind: connected ? "connected" : "disconnected" },
  })
  const remote = { store: { queryClient, state }, queries: createRemoteQueries(link, queryClient) } as unknown as RemoteSession
  return { calls, remote, queryClient, settled }
}

test("usage warm-up issues one composed dashboard read with the page's default recipes and no refresh", async () => {
  const { calls, remote, queryClient, settled } = session(true)
  preloadUsage(remote)
  expect(queryClient.isFetching()).toBe(1)
  await settled
  const { daily, monthly, breakdown } = usageReportInputs(now, undefined)
  expect(calls).toEqual([{ operation: "usage.dashboard", request: { input: { daily, monthly, breakdown } } }])
  expect(queryClient.getQueryCache().getAll()).toHaveLength(1)
  queryClient.clear()
})

test("usage warm-up carries the selected local time zone in every report", async () => {
  zone = "local"
  const { calls, remote, queryClient, settled } = session(true)
  preloadUsage(remote)
  expect(queryClient.isFetching()).toBe(1)
  await settled
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const { daily, monthly, breakdown } = usageReportInputs(now, timeZone)
  expect(calls).toEqual([{ operation: "usage.dashboard", request: { input: { daily, monthly, breakdown } } }])
  expect([daily.timeZone, monthly.timeZone, breakdown.timeZone]).toEqual([timeZone, timeZone, timeZone])
  queryClient.clear()
})

test("usage warm-up reads nothing without an open connected device", () => {
  const { calls, remote, queryClient } = session(false)
  preloadUsage(remote)
  preloadUsage(undefined)
  expect(calls).toEqual([])
  expect(queryClient.isFetching()).toBe(0)
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  queryClient.clear()
})
