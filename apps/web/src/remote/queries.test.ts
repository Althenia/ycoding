import { describe, expect, test } from "bun:test"
import { createRemoteQueries, createRemoteQueryClient, keepAwakeState, remoteKeys, usageRead, type QueryScope, type RemoteLink } from "./queries"
import type { RemoteRequestOutcome, RemoteTransportRequest } from "./transport"

type View<T> = { status: "pending" | "error" | "success"; fetchStatus: "fetching" | "paused" | "idle"; data: T | undefined; error: Error | null }

const pending = <T>(fetchStatus: View<T>["fetchStatus"]) => new Proxy({ status: "pending", fetchStatus, error: null } as View<T>, {
  get(target, property) {
    if (property === "data") throw new Error("A pending read suspends the route panel")
    return Reflect.get(target, property)
  },
})

describe("query read helpers", () => {
  test("usage reads describe a pending query without reading its data", () => {
    expect(usageRead(pending("fetching"))).toEqual({ status: "loading" })
    expect(usageRead(pending("idle"))).toEqual({ status: "idle" })
  })

  test("usage reads keep settled data while a refresh is in flight", () => {
    expect(usageRead({ status: "success", fetchStatus: "fetching", data: { status: "ready", data: 3 }, error: null })).toEqual({ status: "loading", data: 3 })
    expect(usageRead({ status: "error", fetchStatus: "idle", data: { status: "ready", data: 3 }, error: new Error("lost") })).toEqual({ status: "error", data: 3, message: "lost" })
    expect(usageRead({ status: "success", fetchStatus: "idle", data: { status: "unsupported" }, error: null })).toEqual({ status: "unsupported" })
  })

  test("keep-awake reads describe a pending query without reading its data", () => {
    expect(keepAwakeState(pending("fetching"))).toEqual({ read: "loading" })
    expect(keepAwakeState(pending("idle"))).toEqual({ read: "idle" })
  })

  test("keep-awake reads keep an unconfirmed change while the machine is read again", () => {
    const change = { state: "unknown" as const, enabled: true, message: "unconfirmed" }
    expect(keepAwakeState({ status: "success", fetchStatus: "fetching", data: { read: "error", message: "lost", change }, error: null })).toEqual({ read: "loading", change })
  })
})

const report = { rows: [{ providerID: "p", modelID: "m", fallbacks: 1, escalated: 2, rejected: 3, last: 4 }], groups: 1 }
const agentReport = { rows: [{ providerID: "p", modelID: "m", agent: "build", fallbacks: 0, escalated: 1, rejected: 0, last: 9 }], groups: 3 }
const recent = { items: [{ id: "inc_1", time: 5, kind: "guardrail-rejected", category: "hard", ruleIDs: ["standard.review.force-push"], agent: "build", decidedBy: "human" }] } as const
const note = { enabled: true, text: "note" }

function incidents(answer: (operation: string, request: RemoteTransportRequest | undefined, scope: QueryScope) => RemoteRequestOutcome = (operation, request) => ({
  status: "ok",
  value: { data: operation === "incident.report" ? (request?.input?.group === "agent" ? agentReport : report) : operation === "incident.recent" ? recent : note },
}), recovered = false) {
  const calls: { operation: string; request: RemoteTransportRequest | undefined; scope: QueryScope }[] = []
  const link: RemoteLink = {
    request: async (scope, operation, request) => {
      calls.push({ operation, request, scope })
      return answer(operation, request, scope)
    },
    recoveries: () => 0,
    recovered: async () => recovered,
  }
  const client = createRemoteQueryClient()
  return { calls, client, queries: createRemoteQueries(link, client) }
}

const scope: QueryScope = { deviceID: "dev_1", generation: 1 }

test("Usage refresh starts its cached forecast without waiting for provider quota refresh", async () => {
  const providerGate = Promise.withResolvers<RemoteRequestOutcome>()
  const forecastStarted = Promise.withResolvers<void>()
  let providerReads = 0
  let forecastReads = 0
  const summary = { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const client = createRemoteQueryClient()
  const queries = createRemoteQueries({
    recoveries: () => 0,
    recovered: async () => false,
    request: async (_scope, operation) => {
      if (operation === "usage.providers") {
        providerReads++
        if (providerReads > 1) return providerGate.promise
        return { status: "ok", value: { data: [] } }
      }
      if (operation === "usage.forecast") {
        forecastReads++
        if (forecastReads > 1) forecastStarted.resolve()
        return { status: "ok", value: { data: { asOf: 1, localScope: "backend", localRates: [], quotas: [] } } }
      }
      return { status: "ok", value: { data: summary } }
    },
  }, client)
  await Promise.all([client.fetchQuery(queries.usageProviders(scope, true)), client.fetchQuery(queries.usageSummary(scope, true)), client.fetchQuery(queries.usageForecast(scope, true))])
  const refresh = queries.refreshUsage(scope)
  const timeout = setTimeout(() => forecastStarted.reject(new Error("Forecast waited for the provider quota refresh")), 500)
  try {
    await forecastStarted.promise
    expect(providerReads).toBe(2)
    expect(forecastReads).toBe(2)
  } finally {
    clearTimeout(timeout)
    providerGate.resolve({ status: "ok", value: { data: [] } })
    await refresh
    client.clear()
  }
})

describe("incident queries", () => {
  test("report reads forward the exact bounded input without a Session and key on every field", async () => {
    const { calls, client, queries } = incidents()
    const input = { group: "model", from: 1, to: 9, offset: 0, limit: 50 } as const
    expect(await client.fetchQuery(queries.incidentReport(scope, true, input))).toEqual({ status: "ready", data: report })
    expect(calls).toEqual([{ operation: "incident.report", request: { input }, scope }])
    await client.fetchQuery(queries.incidentReport(scope, true, input))
    expect(calls).toHaveLength(1)
    for (const changed of [{ ...input, group: "agent" }, { ...input, from: 2 }, { ...input, to: 10 }, { ...input, offset: 1 }, { ...input, limit: 51 }] as const)
      await client.fetchQuery(queries.incidentReport(scope, true, changed))
    expect(calls).toHaveLength(6)
    expect(new Set(calls.map((call) => JSON.stringify(remoteKeys.incidentReport(call.scope, call.request!.input as typeof input)))).size).toBe(6)
    expect(calls.every((call) => call.request?.sessionID === undefined)).toBe(true)
  })

  test("report reads keep the grouped agent column and drop fields the contract does not carry", async () => {
    const { client, queries } = incidents(() => ({ status: "ok", value: { data: { ...agentReport, rows: [{ ...agentReport.rows[0], directory: "/private", command: "rm" }] } } }))
    expect(await client.fetchQuery(queries.incidentReport(scope, true, { group: "agent" }))).toEqual({ status: "ready", data: agentReport })
  })

  test("report and recent reads are disabled outside their bounds and unreadable answers fail", async () => {
    const { calls, client, queries } = incidents()
    for (const options of [
      queries.incidentReport(scope, true, { group: "model", limit: 201 }), queries.incidentReport(scope, true, { group: "model", limit: 0 }),
      queries.incidentReport(scope, true, { group: "model", offset: -1 }), queries.incidentReport(scope, true, { group: "model", from: 5, to: 4 }),
      queries.incidentReport(undefined, true, { group: "model" }), queries.incidentReport(scope, false, { group: "model" }),
      queries.incidentRecent(scope, true, { provider: "p", model: "m", limit: 51 }), queries.incidentRecent(scope, true, { provider: "p", model: "m", limit: 0 }),
      queries.incidentRecent(scope, true, { provider: "", model: "m" }), queries.incidentRecent(undefined, true, { provider: "p", model: "m" }),
      queries.incidentGuidance(scope, true, { provider: "p", model: "" }), queries.incidentGuidance(undefined, true, { provider: "p", model: "m" }),
    ]) expect(options.enabled).toBe(false)
    expect(calls).toEqual([])
    const broken = incidents(() => ({ status: "ok", value: { data: { rows: [{ providerID: "p" }], groups: 1 } } }))
    await expect(broken.client.fetchQuery(broken.queries.incidentReport(scope, true, { group: "model" }))).rejects.toThrow("unreadable")
    const mismatched = incidents(() => ({ status: "ok", value: { data: agentReport } }))
    await expect(mismatched.client.fetchQuery(mismatched.queries.incidentReport(scope, true, { group: "model" }))).rejects.toThrow("unreadable")
  })

  test("recent reads forward the model filter and settle unknown operations as unsupported", async () => {
    const { calls, client, queries } = incidents()
    const input = { provider: "p", model: "m", agent: "build", limit: 20 }
    expect(await client.fetchQuery(queries.incidentRecent(scope, true, input))).toEqual({ status: "ready", data: recent })
    expect(calls).toEqual([{ operation: "incident.recent", request: { input }, scope }])
    const old = incidents(() => ({ status: "failed", error: { code: "unknown_operation", message: "Unknown operation" } }))
    expect(await old.client.fetchQuery(old.queries.incidentRecent(scope, true, { provider: "p", model: "m" }))).toEqual({ status: "unsupported" })
    expect(await old.client.fetchQuery(old.queries.incidentReport(scope, true, { group: "model" }))).toEqual({ status: "unsupported" })
    expect(await old.client.fetchQuery(old.queries.incidentGuidance(scope, true, { provider: "p", model: "m" }))).toEqual({ status: "unsupported" })
  })

  test("guidance reads address the optional Session at the frame, never in the input, and key on it", async () => {
    const { calls, client, queries } = incidents()
    expect(await client.fetchQuery(queries.incidentGuidance(scope, true, { provider: "p", model: "m" }))).toEqual({ status: "ready", data: note })
    expect(await client.fetchQuery(queries.incidentGuidance(scope, true, { provider: "p", model: "m", sessionID: "ses_1" }))).toEqual({ status: "ready", data: note })
    expect(await client.fetchQuery(queries.incidentGuidance(scope, true, { provider: "p", model: "m", sessionID: "ses_2" }))).toEqual({ status: "ready", data: note })
    expect(calls.map((call) => [call.operation, call.request])).toEqual([
      ["incident.guidance", { input: { provider: "p", model: "m" } }],
      ["incident.guidance", { input: { provider: "p", model: "m" }, sessionID: "ses_1" }],
      ["incident.guidance", { input: { provider: "p", model: "m" }, sessionID: "ses_2" }],
    ])
  })

  test("clearing guidance sends the mutation once, returns the new Guidance and refreshes only that model's guidance reads", async () => {
    const cleared = { enabled: true, clearedAt: 12 }
    const { calls, client, queries } = incidents((operation) => ({
      status: "ok",
      value: { data: operation === "incident.guidance.clear" ? cleared : operation === "incident.guidance" ? note : operation === "incident.report" ? report : recent },
    }))
    const model = { provider: "p", model: "m" }
    const other = { provider: "p", model: "other" }
    await client.fetchQuery(queries.incidentReport(scope, true, { group: "model" }))
    await client.fetchQuery(queries.incidentRecent(scope, true, model))
    await client.fetchQuery(queries.incidentGuidance(scope, true, model))
    await client.fetchQuery(queries.incidentGuidance(scope, true, { ...model, sessionID: "ses_1" }))
    await client.fetchQuery(queries.incidentGuidance(scope, true, other))
    calls.length = 0
    expect(await queries.clearIncidentGuidance(scope, { ...model, sessionID: "ses_1" })).toEqual(cleared)
    expect(calls).toEqual([{ operation: "incident.guidance.clear", request: { input: model, sessionID: "ses_1" }, scope }])
    const state = (options: { queryKey: readonly unknown[] }) => client.getQueryState(options.queryKey)?.isInvalidated
    expect(state(queries.incidentGuidance(scope, true, model))).toBe(true)
    expect(state(queries.incidentGuidance(scope, true, { ...model, sessionID: "ses_1" }))).toBe(true)
    expect(state(queries.incidentGuidance(scope, true, other))).toBe(false)
    expect(state(queries.incidentReport(scope, true, { group: "model" }))).toBe(false)
    expect(state(queries.incidentRecent(scope, true, model))).toBe(false)
  })

  test("an unconfirmed, failed, unavailable or unreadable clear is neither replayed nor reported as done", async () => {
    const unknown = incidents(() => ({ status: "unknown", error: { code: "outcome_unknown", message: "Socket closed" } }))
    await expect(unknown.queries.clearIncidentGuidance(scope, { provider: "p", model: "m" })).rejects.toThrow("Socket closed")
    expect(unknown.calls).toHaveLength(1)
    const rejected = incidents(() => ({ status: "failed", error: { code: "invalid_message", message: "Input does not match" } }))
    await expect(rejected.queries.clearIncidentGuidance(scope, { provider: "p", model: "m" })).rejects.toThrow("Input does not match")
    const closed = incidents(() => ({ status: "unavailable", reason: "not-connected" }))
    await expect(closed.queries.clearIncidentGuidance(scope, { provider: "p", model: "m" })).rejects.toThrow("unavailable")
    const unreadable = incidents(() => ({ status: "ok", value: { data: { enabled: "yes" } } }))
    await expect(unreadable.queries.clearIncidentGuidance(scope, { provider: "p", model: "m" })).rejects.toThrow("unreadable")
    expect(unknown.calls.length + rejected.calls.length + closed.calls.length + unreadable.calls.length).toBe(4)
  })

  test("an exhausted incident read replays nothing until its explicit retry issues one fresh read and clears the exhaustion", async () => {
    let lost = true
    const unknown: RemoteRequestOutcome = { status: "unknown", error: { code: "outcome_unknown", message: "Socket closed" } }
    const { calls, client, queries } = incidents((operation) => lost ? unknown : { status: "ok", value: { data: operation === "incident.report" ? report : operation === "incident.recent" ? recent : note } }, true)
    const input = { group: "model", offset: 0, limit: 25 } as const
    const recentInput = { provider: "p", model: "m", limit: 20 }
    const guidanceInput = { provider: "p", model: "m" }
    const reads = [
      () => client.fetchQuery(queries.incidentReport(scope, true, input)),
      () => client.fetchQuery(queries.incidentRecent(scope, true, recentInput)),
      () => client.fetchQuery(queries.incidentGuidance(scope, true, guidanceInput)),
    ]
    for (const read of reads) await expect(read()).rejects.toThrow()
    expect(calls).toHaveLength(6)
    for (const read of reads) await expect(read()).rejects.toThrow("Socket closed")
    expect(calls).toHaveLength(6)
    lost = false
    await queries.retryIncidentReport(scope, input)
    expect(calls.slice(6)).toEqual([{ operation: "incident.report", request: { input }, scope }])
    await queries.retryIncidentRecent(scope, recentInput)
    await queries.retryIncidentGuidance(scope, guidanceInput)
    expect(calls.slice(7).map((call) => call.operation)).toEqual(["incident.recent", "incident.guidance"])
    expect(await client.fetchQuery(queries.incidentReport(scope, true, input))).toEqual({ status: "ready", data: report })
    expect(await client.fetchQuery(queries.incidentRecent(scope, true, recentInput))).toEqual({ status: "ready", data: recent })
    expect(await client.fetchQuery(queries.incidentGuidance(scope, true, guidanceInput))).toEqual({ status: "ready", data: note })
    expect(calls).toHaveLength(9)
  })

  test("a retry reads only its own connection generation and keeps another exhausted read parked", async () => {
    const next: QueryScope = { deviceID: "dev_1", generation: 2 }
    let lost = true
    const unknown: RemoteRequestOutcome = { status: "unknown", error: { code: "outcome_unknown", message: "Socket closed" } }
    const { calls, client, queries } = incidents(() => lost ? unknown : { status: "ok", value: { data: report } }, true)
    const input = { group: "model" } as const
    for (const current of [scope, next]) await expect(client.fetchQuery(queries.incidentReport(current, true, input))).rejects.toThrow()
    calls.length = 0
    lost = false
    await queries.retryIncidentReport(scope, input)
    expect(calls.map((call) => call.scope)).toEqual([scope])
    expect(client.getQueryState(queries.incidentReport(scope, true, input).queryKey)?.status).toBe("success")
    expect(client.getQueryState(queries.incidentReport(next, true, input).queryKey)?.status).toBe("error")
    await expect(client.fetchQuery(queries.incidentReport(next, true, input))).rejects.toThrow("Socket closed")
    expect(calls).toHaveLength(1)
  })

  test("retrying a read never replays an unconfirmed clear", async () => {
    const { calls, client, queries } = incidents((operation) => operation === "incident.guidance.clear"
      ? { status: "unknown", error: { code: "outcome_unknown", message: "Socket closed" } }
      : { status: "ok", value: { data: note } })
    const model = { provider: "p", model: "m" }
    await client.fetchQuery(queries.incidentGuidance(scope, true, model))
    await expect(queries.clearIncidentGuidance(scope, model)).rejects.toThrow("Socket closed")
    await queries.retryIncidentGuidance(scope, model)
    expect(calls.map((call) => call.operation)).toEqual(["incident.guidance", "incident.guidance.clear", "incident.guidance"])
  })

  test("a replaced connection reads under its own generation and a late clear never invalidates the new one", async () => {
    const next: QueryScope = { deviceID: "dev_1", generation: 2 }
    const { client, queries } = incidents()
    const model = { provider: "p", model: "m" }
    await client.fetchQuery(queries.incidentGuidance(scope, true, model))
    await client.fetchQuery(queries.incidentGuidance(next, true, model))
    await queries.clearIncidentGuidance(scope, model)
    expect(client.getQueryState(queries.incidentGuidance(scope, true, model).queryKey)?.isInvalidated).toBe(true)
    expect(client.getQueryState(queries.incidentGuidance(next, true, model).queryKey)?.isInvalidated).toBe(false)
    expect(queries.incidentGuidance(scope, true, model).queryKey).not.toEqual(queries.incidentGuidance(next, true, model).queryKey)
  })
})
