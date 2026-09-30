import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { remoteKeys } from "../src/remote/queries"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { queriesOf } from "./remote-queries"
import { startRelayDouble, waitFor } from "./relay-double"

const snapshot = { providerID: "openai", label: "Codex", status: "available", source: "provider_api", stability: "stable", updatedAt: 1000, windows: [{ id: "week", label: "Weekly", unit: "percent", used: 40, limit: 100 }] } as const
const dayReport = { group: "day" as const, limit: 30 }

async function connected(relay: Awaited<ReturnType<typeof startRelayDouble>>) {
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  await store.load()
  await waitFor(() => store.state().transport.kind === "open")
  return { store, ...queriesOf(store) }
}

test("usage reads are cached per input, refreshed explicitly, and removed on device switch", async () => {
  const relay = await startRelayDouble()
  const { store, queries, scope, usage, scoped } = await connected(relay)
  try {
    const fetch = store.queryClient.fetchQuery.bind(store.queryClient)
    await Promise.all([fetch(queries.usageProviders(scope(), true)), fetch(queries.usageProviders(scope(), true)), fetch(queries.usageSummary(scope(), true))])
    expect(usage(remoteKeys.usageProviders(scope())).data).toEqual([snapshot])
    expect(usage(remoteKeys.usageSummary(scope())).data).toMatchObject({ physical: 1 })
    await fetch(queries.usageReport(scope(), true, dayReport))
    await fetch(queries.usageReport(scope(), true, { limit: 30, group: "day" }))
    expect(usage<{ rowCount: number }>(remoteKeys.usageReport(scope(), dayReport)).data?.rowCount).toBe(1)
    expect(relay.requests.filter((request) => request.operation === "usage.providers")).toHaveLength(1)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(1)
    await queries.refreshUsage(scope())
    expect(relay.requests.filter((request) => request.operation === "usage.providers").at(-1)?.input).toEqual({ refresh: true })
    expect(scoped()).toHaveLength(3)
    store.connect("dev_other")
    expect(scoped()).toHaveLength(0)
  } finally { store.dispose(); await relay.stop() }
})

test("a connection the browser replaces or disconnects stops reporting open", async () => {
  const relay = await startRelayDouble()
  const opens: (() => void)[] = []
  const store = createRemoteStore({
    http: createRemoteHttp({ baseURL: relay.httpURL }),
    createTransport: (_deviceID, handlers) => {
      let open = false
      return {
        connect: () => { opens.push(() => { open = true; handlers.onStatus?.({ kind: "open" }) }) },
        close: () => { open = false },
        setPriority: () => {},
        status: () => open ? { kind: "open" } as const : { kind: "idle" } as const,
        request: async () => ({ status: "unavailable", reason: "not-connected" }) as const,
      }
    },
  })
  try {
    store.connect("dev_studio")
    opens.shift()?.()
    expect(store.state().transport.kind).toBe("open")
    store.connect("dev_studio")
    expect(store.state().transport.kind).toBe("idle")
    opens.shift()?.()
    expect(store.state().transport.kind).toBe("open")
    store.disconnect()
    expect(store.state().transport.kind).toBe("idle")
  } finally { store.dispose(); await relay.stop() }
})

test("old connectors expose unsupported usage rather than empty metrics", async () => {
  const relay = await startRelayDouble({ handler: (request) => request.operation.startsWith("usage.")
    ? { ok: false, code: "unknown_operation", message: "Unknown operation" } : "default" })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    await store.queryClient.fetchQuery(queries.usageProviders(scope(), true))
    expect(usage(remoteKeys.usageProviders(scope())).status).toBe("unsupported")
  } finally { store.dispose(); await relay.stop() }
})

test("an older connector's invalid_message for Local reports is an update prompt, not a blank report", async () => {
  const relay = await startRelayDouble({ handler: (request) => request.operation === "usage.report" && request.input?.timeZone !== undefined
    ? { ok: false, code: "invalid_message", message: "Unknown usage report field" } : "default" })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    const local = { group: "day" as const, timeZone: "Asia/Kathmandu", limit: 30 }
    await store.queryClient.fetchQuery(queries.usageReport(scope(), true, dayReport))
    await store.queryClient.fetchQuery(queries.usageReport(scope(), true, local))
    expect(usage<{ rows: unknown[] }>(remoteKeys.usageReport(scope(), dayReport)).status).toBe("ready")
    expect(usage<{ rows: unknown[] }>(remoteKeys.usageReport(scope(), dayReport)).data?.rows).toHaveLength(1)
    expect(usage(remoteKeys.usageReport(scope(), local))).toEqual({ status: "unsupported" })
  } finally { store.dispose(); await relay.stop() }
})

test("a report in flight when the socket drops is retried once after reconnect and a late old response changes nothing", async () => {
  const gate = Promise.withResolvers<void>()
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    reads += 1
    if (reads === 1) await gate.promise
    return "default" as const
  } })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    const key = remoteKeys.usageReport(scope(), dayReport)
    const pending = store.queryClient.fetchQuery(queries.usageReport(scope(), true, dayReport))
    await waitFor(() => reads === 1)
    expect(usage(key).status).toBe("loading")
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await pending
    expect(usage(key).status).toBe("ready")
    expect(reads).toBe(2)
    gate.resolve()
    await Bun.sleep(25)
    expect(usage(key).status).toBe("ready")
    expect(reads).toBe(2)
  } finally { gate.resolve(); store.dispose(); await relay.stop() }
})

test("agent re-advertisement retries pending read-only Usage panels once while retaining good quotas", async () => {
  const attempts = new Map<string, number>()
  const relay = await startRelayDouble({ handler: (request) => {
    if (!request.operation.startsWith("usage.")) return "default"
    const key = request.operation === "usage.report" ? `${request.operation}:${request.input?.group}:${request.input?.limit}` : request.operation
    const count = (attempts.get(key) ?? 0) + 1
    attempts.set(key, count)
    if ((request.operation === "usage.providers" || request.operation === "usage.summary") && count === 1) return "default"
    return count === (request.operation === "usage.report" ? 1 : 2)
      ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default"
  } })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    const fetch = store.queryClient.fetchQuery.bind(store.queryClient)
    await Promise.all([fetch(queries.usageProviders(scope(), true)), fetch(queries.usageSummary(scope(), true))])
    expect(usage(remoteKeys.usageProviders(scope())).data).toEqual([snapshot])
    const reports = [{ group: "day" as const, limit: 30 }, { group: "model" as const, limit: 200 }, { group: "model" as const, limit: 25 }]
    void queries.refreshUsage(scope())
    reports.forEach((input) => { void fetch(queries.usageReport(scope(), true, input)).catch(() => {}) })
    await waitFor(() => attempts.get("usage.report:model:25") === 1 && attempts.get("usage.providers") === 2 && attempts.get("usage.summary") === 2)
    expect(usage(remoteKeys.usageProviders(scope()))).toMatchObject({ status: "loading", data: [snapshot] })
    expect(usage(remoteKeys.usageSummary(scope())).status).toBe("loading")
    expect(reports.map((input) => usage(remoteKeys.usageReport(scope(), input)).status)).toEqual(["loading", "loading", "loading"])
    relay.pushSessions([])
    await waitFor(() => usage(remoteKeys.usageProviders(scope())).status === "ready" && reports.every((input) => usage(remoteKeys.usageReport(scope(), input)).status === "ready"))
    const settled: [string, number][] = [["usage.providers", 3], ["usage.report:day:30", 2], ["usage.report:model:200", 2], ["usage.report:model:25", 2], ["usage.summary", 3]]
    expect([...attempts].sort()).toEqual(settled)
    relay.pushStatus([], [])
    await Bun.sleep(25)
    expect([...attempts].sort()).toEqual(settled)
  } finally { store.dispose(); await relay.stop() }
})

test("a second unknown Usage outcome becomes an error without another automatic replay until an explicit retry", async () => {
  let reads = 0
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation !== "usage.report") return "default"
    reads += 1
    return reads <= 2 ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default"
  } })
  const { store, queries, scope, usage, observe } = await connected(relay)
  const reports = () => relay.requests.filter((request) => request.operation === "usage.report")
  const observed = observe(queries.usageReport(scope(), true, dayReport))
  try {
    const key = remoteKeys.usageReport(scope(), dayReport)
    await waitFor(() => reports().length === 1)
    expect(usage(key).status).toBe("loading")
    relay.pushStatus([], [])
    await waitFor(() => usage(key).status === "error")
    relay.pushSessions([])
    await Bun.sleep(25)
    expect(reports()).toHaveLength(2)
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await Bun.sleep(25)
    expect(reports()).toHaveLength(2)
    expect(usage(key).status).toBe("error")
    await queries.retryUsageReport(scope(), dayReport)
    expect(usage(key).status).toBe("ready")
    expect(reports()).toHaveLength(3)
  } finally { observed.stop(); store.dispose(); await relay.stop() }
})

test("a client reconnect retries an unknown Usage report once without a mounted Usage page", async () => {
  let reads = 0
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation !== "usage.report") return "default"
    reads += 1
    return reads === 1 ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default"
  } })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    const pending = store.queryClient.fetchQuery(queries.usageReport(scope(), true, dayReport))
    await waitFor(() => reads === 1)
    expect(usage(remoteKeys.usageReport(scope(), dayReport)).status).toBe("loading")
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await pending
    expect(usage(remoteKeys.usageReport(scope(), dayReport)).status).toBe("ready")
    expect(reads).toBe(2)
  } finally { store.dispose(); await relay.stop() }
})

test("a recovery frame preceding the unknown settlement still retries once, but a device switch never does", async () => {
  const gate = Promise.withResolvers<void>()
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    reads += 1
    if (reads === 1) {
      await gate.promise
      return { ok: false, code: "outcome_unknown" as const, message: "Agent disconnected before settling this request" }
    }
    return "default" as const
  } })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    const pending = store.queryClient.fetchQuery(queries.usageReport(scope(), true, dayReport))
    await waitFor(() => reads === 1)
    relay.pushStatus([], [])
    gate.resolve()
    await pending
    expect(usage(remoteKeys.usageReport(scope(), dayReport)).status).toBe("ready")
    expect(reads).toBe(2)
  } finally { gate.resolve(); store.dispose(); await relay.stop() }

  const pendingRelay = await startRelayDouble({ handler: (request) => request.operation === "usage.report"
    ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default" })
  const switching = await connected(pendingRelay)
  try {
    const waiting = switching.store.queryClient.fetchQuery(switching.queries.usageReport(switching.scope(), true, dayReport)).catch((error: Error) => error)
    await waitFor(() => pendingRelay.requests.some((request) => request.operation === "usage.report"))
    switching.store.connect("dev_other")
    await waiting
    await waitFor(() => switching.store.state().activeDeviceID === "dev_other" && switching.store.state().transport.kind === "open")
    pendingRelay.pushSessions([])
    await Bun.sleep(25)
    expect(pendingRelay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(1)
  } finally { switching.store.dispose(); await pendingRelay.stop() }
})

test("a replaced device cannot publish its usage read, and its late answer never paints for the new device", async () => {
  const gate = Promise.withResolvers<void>()
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "usage.providers") { await gate.promise; return { ok: true, value: { data: [snapshot] } } }
    return "default"
  } })
  const { store, queries, scope, scoped } = await connected(relay)
  try {
    const pending = store.queryClient.fetchQuery(queries.usageProviders(scope(), true)).catch(() => undefined)
    await waitFor(() => relay.requests.some((request) => request.operation === "usage.providers"))
    const before = store.state().generation
    store.connect("dev_other")
    gate.resolve()
    await pending
    expect(scoped()).toHaveLength(0)
    expect(store.state().generation).toBe(before + 1)
  } finally { gate.resolve(); store.dispose(); await relay.stop() }
})

test("a read in flight when the device is replaced never retries against the replacement", async () => {
  const gate = Promise.withResolvers<void>()
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    await gate.promise
    return "default" as const
  } })
  const { store, queries, scope } = await connected(relay)
  try {
    const pending = store.queryClient.fetchQuery(queries.usageReport(scope(), true, dayReport)).catch(() => undefined)
    await waitFor(() => relay.requests.some((request) => request.operation === "usage.report"))
    store.connect("dev_other")
    await pending
    await waitFor(() => store.state().activeDeviceID === "dev_other" && store.state().transport.kind === "open")
    relay.pushSessions([])
    relay.pushStatus([], [])
    await Bun.sleep(50)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(1)
  } finally { gate.resolve(); store.dispose(); await relay.stop() }
})

test("reconnect refetches active usage while the previous values stay visible until the refetch settles", async () => {
  const gate = Promise.withResolvers<void>()
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.providers") return "default" as const
    reads += 1
    if (reads === 2) await gate.promise
    return "default" as const
  } })
  const { store, queries, scope, usage, observe } = await connected(relay)
  const observed = observe(queries.usageProviders(scope(), true))
  try {
    const key = remoteKeys.usageProviders(scope())
    await waitFor(() => usage(key).status === "ready")
    relay.dropConnections(1012, "restart")
    await waitFor(() => reads === 2, 3_000)
    expect(usage(key)).toMatchObject({ status: "loading", data: [snapshot] })
    gate.resolve()
    await waitFor(() => usage(key).status === "ready")
    expect(reads).toBe(2)
  } finally { gate.resolve(); observed.stop(); store.dispose(); await relay.stop() }
})

test("unreadable usage stays an error and report paging does not reuse a different input", async () => {
  const relay = await startRelayDouble({ usageProviders: [{ providerID: "openai", windows: "invalid" }], usageReport: (input) => ({
    group: input?.group, rows: [], total: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    rowCount: 2, nextOffset: input?.offset === 1 ? undefined : 1,
  }) })
  const { store, queries, scope, usage } = await connected(relay)
  try {
    await store.queryClient.fetchQuery(queries.usageProviders(scope(), true)).catch(() => undefined)
    expect(usage(remoteKeys.usageProviders(scope())).status).toBe("error")
    const first = { group: "model" as const, limit: 1 }
    const second = { group: "model" as const, limit: 1, offset: 1 }
    await store.queryClient.fetchQuery(queries.usageReport(scope(), true, first))
    await store.queryClient.fetchQuery(queries.usageReport(scope(), true, second))
    expect([first, second].map((input) => usage<{ nextOffset?: number }>(remoteKeys.usageReport(scope(), input)).data?.nextOffset)).toEqual([1, undefined])
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
  } finally { store.dispose(); await relay.stop() }
})
