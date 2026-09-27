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
