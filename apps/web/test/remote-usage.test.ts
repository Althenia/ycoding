import { expect, test } from "bun:test"
import { createRemoteHttp } from "../src/remote/http"
import { createRemoteStore } from "../src/remote/store"
import { createRemoteTransport } from "../src/remote/transport"
import { startRelayDouble, waitFor } from "./relay-double"

const snapshot = { providerID: "openai", label: "Codex", status: "available", source: "provider_api", stability: "stable", updatedAt: 1000, windows: [{ id: "week", label: "Weekly", unit: "percent", used: 40, limit: 100 }] } as const

test("usage reads are cached per input, refreshed explicitly, and clear on device switch", async () => {
  const relay = await startRelayDouble()
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await Promise.all([store.loadUsage(), store.loadUsage()])
    expect(store.state().usage.providers.data).toEqual([snapshot])
    expect(store.state().usage.summary.data?.physical).toBe(1)
    await store.loadUsageReport({ group: "day", limit: 30 })
    await store.loadUsageReport({ limit: 30, group: "day" })
    expect(Object.values(store.state().usage.reports)[0]?.data?.rowCount).toBe(1)
    expect(relay.requests.filter((request) => request.operation === "usage.providers")).toHaveLength(1)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(1)
    await store.loadUsage({ refresh: true })
    expect(relay.requests.filter((request) => request.operation === "usage.providers").at(-1)?.input).toEqual({ refresh: true })
    store.connect("dev_other")
    expect(store.state().usage.providers.status).toBe("idle")
    expect(store.state().usage.reports).toEqual({})
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
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsage()
    expect(store.state().usage.providers.status).toBe("unsupported")
  } finally { store.dispose(); await relay.stop() }
})

test("an older connector's invalid_message for Local reports is an update prompt, not a blank report", async () => {
  const relay = await startRelayDouble({ handler: (request) => request.operation === "usage.report" && request.input?.timeZone !== undefined
    ? { ok: false, code: "invalid_message", message: "Unknown usage report field" } : "default" })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsageReport({ group: "day", limit: 30 })
    await store.loadUsageReport({ group: "day", timeZone: "Asia/Kathmandu", limit: 30 })
    const reports = Object.values(store.state().usage.reports)
    expect(reports.map((item) => item.status)).toEqual(["ready", "unsupported"])
    expect(reports[0]?.data?.rows).toHaveLength(1)
    expect(reports[1]?.data).toBeUndefined()
  } finally { store.dispose(); await relay.stop() }
})

test("a loading report is retried once after reconnect without an old response overwriting it", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    reads += 1
    if (reads === 1) await gate
    return "default" as const
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    const input = { group: "day" as const, timeZone: "Asia/Kathmandu", limit: 30 }
    const pending = store.loadUsageReport(input)
    await waitFor(() => relay.requests.some((request) => request.operation === "usage.report"))
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("loading")
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await store.loadUsageReport(input)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("ready")
    release?.()
    await pending
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("ready")
  } finally { release?.(); store.dispose(); await relay.stop() }
})

test("agent re-advertisement retries failed read-only Usage panels once while retaining good quotas", async () => {
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
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsage()
    expect(store.state().usage.providers.data).toEqual([snapshot])
    await Promise.all([
      store.loadUsage({ refresh: true }),
      store.loadUsageReport({ group: "day", limit: 30 }),
      store.loadUsageReport({ group: "model", limit: 200 }),
      store.loadUsageReport({ group: "model", limit: 25 }),
    ])
    expect(store.state().usage.providers).toMatchObject({ status: "loading", data: [snapshot] })
    expect(store.state().usage.summary.status).toBe("loading")
    expect(Object.values(store.state().usage.reports).map((report) => report.status)).toEqual(["loading", "loading", "loading"])
    relay.pushSessions([])
    await waitFor(() => store.state().usage.providers.status === "ready" && Object.values(store.state().usage.reports).every((report) => report.status === "ready"))
    expect([...attempts].sort()).toEqual([
      ["usage.providers", 3], ["usage.report:day:30", 2], ["usage.report:model:200", 2], ["usage.report:model:25", 2], ["usage.summary", 3],
    ])
    relay.pushStatus([], [])
    await Bun.sleep(25)
    expect([...attempts].sort()).toEqual([
      ["usage.providers", 3], ["usage.report:day:30", 2], ["usage.report:model:200", 2], ["usage.report:model:25", 2], ["usage.summary", 3],
    ])
  } finally { store.dispose(); await relay.stop() }
})

test("a second unknown Usage outcome becomes an error without another automatic replay", async () => {
  let reads = 0
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation !== "usage.report") return "default"
    reads += 1
    return reads <= 2 ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsageReport({ group: "day", limit: 30 })
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("loading")
    relay.pushStatus([], [])
    await waitFor(() => Object.values(store.state().usage.reports)[0]?.status === "error")
    relay.pushSessions([])
    await Bun.sleep(25)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await store.loadUsageReport({ group: "day", limit: 30 })
    await Bun.sleep(25)
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("error")
    await store.loadUsageReport({ group: "day", limit: 30 }, { refresh: true })
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("ready")
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(3)
  } finally { store.dispose(); await relay.stop() }
})

test("a client reconnect retries an unknown Usage report once without a mounted Usage page", async () => {
  let reads = 0
  const relay = await startRelayDouble({ handler: (request) => {
    if (request.operation !== "usage.report") return "default"
    reads += 1
    return reads === 1 ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsageReport({ group: "day", limit: 30 })
    expect(Object.values(store.state().usage.reports)[0]?.status).toBe("loading")
    relay.dropConnections(1012, "restart")
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await waitFor(() => Object.values(store.state().usage.reports)[0]?.status === "ready")
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
  } finally { store.dispose(); await relay.stop() }
})

test("a socket drop while a Usage read is in flight retries it on reconnect without a mounted page", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    reads += 1
    if (reads === 1) await gate
    return "default" as const
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    const pending = store.loadUsageReport({ group: "day", limit: 30 })
    await waitFor(() => reads === 1)
    relay.dropConnections(1012, "restart")
    await pending
    await waitFor(() => relay.connections === 2 && store.state().transport.kind === "open", 3_000)
    await waitFor(() => Object.values(store.state().usage.reports)[0]?.status === "ready")
    expect(reads).toBe(2)
  } finally { release?.(); store.dispose(); await relay.stop() }
})

test("a recovery frame preceding the unknown settlement still retries once, but a device switch never does", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation !== "usage.report") return "default" as const
    reads += 1
    if (reads === 1) {
      await gate
      return { ok: false, code: "outcome_unknown" as const, message: "Agent disconnected before settling this request" }
    }
    return "default" as const
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    const pending = store.loadUsageReport({ group: "day", limit: 30 })
    await waitFor(() => reads === 1)
    relay.pushStatus([], [])
    release?.()
    await pending
    await waitFor(() => Object.values(store.state().usage.reports)[0]?.status === "ready")
    expect(reads).toBe(2)
  } finally { release?.(); store.dispose(); await relay.stop() }

  const pendingRelay = await startRelayDouble({ handler: (request) => request.operation === "usage.report"
    ? { ok: false, code: "outcome_unknown", message: "Agent disconnected before settling this request" } : "default" })
  const switching = createRemoteStore({ http: createRemoteHttp({ baseURL: pendingRelay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: pendingRelay.wsURL(id), handlers }) })
  try {
    await switching.load()
    await waitFor(() => switching.state().transport.kind === "open")
    await switching.loadUsageReport({ group: "day", limit: 30 })
    switching.connect("dev_other")
    await waitFor(() => switching.state().activeDeviceID === "dev_other" && switching.state().transport.kind === "open")
    pendingRelay.pushSessions([])
    await Bun.sleep(25)
    expect(pendingRelay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(1)
  } finally { switching.dispose(); await pendingRelay.stop() }
})

test("a replaced device cannot publish its usage read", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const relay = await startRelayDouble({ handler: async (request) => {
    if (request.operation === "usage.providers") { await gate; return { ok: true, value: { data: [snapshot] } } }
    return "default"
  } })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    const pending = store.loadUsage()
    await waitFor(() => relay.requests.some((request) => request.operation === "usage.providers"))
    store.connect("dev_other")
    release?.()
    await pending
    expect(store.state().usage.providers.status).toBe("idle")
  } finally { release?.(); store.dispose(); await relay.stop() }
})

test("unreadable usage stays an error and report paging does not reuse a different input", async () => {
  const relay = await startRelayDouble({ usageProviders: [{ providerID: "openai", windows: "invalid" }], usageReport: (input) => ({
    group: input?.group, rows: [], total: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    rowCount: 2, nextOffset: input?.offset === 1 ? undefined : 1,
  }) })
  const store = createRemoteStore({ http: createRemoteHttp({ baseURL: relay.httpURL }), createTransport: (id, handlers) => createRemoteTransport({ url: relay.wsURL(id), handlers }) })
  try {
    await store.load()
    await waitFor(() => store.state().transport.kind === "open")
    await store.loadUsage()
    expect(store.state().usage.providers.status).toBe("error")
    await store.loadUsageReport({ group: "model", limit: 1 })
    await store.loadUsageReport({ group: "model", limit: 1, offset: 1 })
    expect(Object.values(store.state().usage.reports).map((entry) => entry.data?.nextOffset)).toEqual([1, undefined])
    expect(relay.requests.filter((request) => request.operation === "usage.report")).toHaveLength(2)
  } finally { store.dispose(); await relay.stop() }
})
