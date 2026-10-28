import { describe, expect, test } from "bun:test"
import type { RemoteUsageDashboard, RemoteUsageGroup } from "@ycoding-ai/remote"
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
const recent = { items: [{ id: "inc_1", time: 5, kind: "guardrail-rejected", category: "hard", ruleIDs: ["standard.review.force-push"], agent: "build", decidedBy: "client" }] } as const
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

describe("Projects reads and changes", () => {
  const participant = (id: string, state = "idle") => ({ sessionID: id, title: id, location: { directory: "/repo" }, state, lastActivity: 5, pending: [] })
  const summary = { id: "cgrp_1", name: "Release", revision: 4, active: true, masterSessionID: "ses_lead", memberCount: 1, settings: { concurrency: 2 }, time: { created: 1, updated: 9 } }
  const detail = { id: "cgrp_1", name: "Release", revision: 4, active: true, settings: { concurrency: 2 }, time: { created: 1, updated: 9 }, master: participant("ses_lead", "running"), members: [participant("ses_w1")] }
  const central = { enabled: true, categories: ["question", "permission", "review"] as const }
  const answers = (overrides: Record<string, RemoteRequestOutcome> = {}) => (operation: string): RemoteRequestOutcome => overrides[operation] ?? ({
    "coordination.list": { status: "ok", value: { data: [summary] } },
    "coordination.get": { status: "ok", value: { data: detail } },
    "coordination.settings": { status: "ok", value: { data: central } },
    "session.list": { status: "ok", value: { data: [{ id: "ses_x", title: "Triage", location: { directory: "/work/web" }, time: { updated: 1, active: 2 } }] } },
  } as Record<string, RemoteRequestOutcome>)[operation] ?? { status: "ok", value: { data: {} } }

  test("the overview reads each project's detail and the central policy once, with no lifecycle, capacity or receipt reads", async () => {
    const { calls, client, queries } = incidents(answers())
    const overview = await client.fetchQuery(queries.coordination(scope, true))
    expect(overview.status).toBe("ready")
    if (overview.status !== "ready") return
    expect(overview.groups.map((group) => [group.summary.id, group.detail.master.sessionID, group.detail.members.length])).toEqual([["cgrp_1", "ses_lead", 1]])
    expect(overview.central).toEqual(central)
    expect(calls.map((call) => call.operation).sort()).toEqual(["coordination.get", "coordination.list", "coordination.settings"])
    expect(calls.find((call) => call.operation === "coordination.get")?.request?.input).toEqual({ groupID: "cgrp_1" })
  })

  test("an older connector reads as unsupported and an unreadable central policy stays unavailable", async () => {
    const unknown: RemoteRequestOutcome = { status: "failed", error: { code: "unknown_operation", message: "unknown" } }
    const older = incidents(answers({ "coordination.list": unknown }))
    expect(await older.client.fetchQuery(older.queries.coordination(scope, true))).toEqual({ status: "unsupported" })
    const noSettings = incidents(answers({ "coordination.settings": unknown }))
    expect(await noSettings.client.fetchQuery(noSettings.queries.coordination(scope, true))).toMatchObject({ status: "ready", central: undefined })
    const garbled = incidents(answers({ "coordination.settings": { status: "ok", value: { data: { enabled: "maybe" } } } }))
    expect(await garbled.client.fetchQuery(garbled.queries.coordination(scope, true))).toMatchObject({ status: "ready", central: undefined })
  })

  test("an unreadable project answer fails the read instead of showing a partial project", async () => {
    const { client, queries } = incidents(answers({ "coordination.get": { status: "ok", value: { data: { name: "x" } } } }))
    await expect(client.fetchQuery(queries.coordination(scope, true))).rejects.toThrow("The device returned an unreadable project answer.")
  })

  test("an empty list is ready with no projects and reads no detail", async () => {
    const { calls, client, queries } = incidents(answers({ "coordination.list": { status: "ok", value: { data: [] } } }))
    expect(await client.fetchQuery(queries.coordination(scope, true))).toMatchObject({ status: "ready", groups: [] })
    expect(calls.some((call) => call.operation === "coordination.get")).toBe(false)
  })

  test("each change sends once with its operation name, keeps a refusal reason, and rereads the overview", async () => {
    const { calls, client, queries } = incidents(answers())
    await client.fetchQuery(queries.coordination(scope, true))
    for (const operation of ["coordination.create", "coordination.update", "coordination.delete"] as const) {
      expect(await queries.changeCoordination(scope, operation, { groupID: "cgrp_1", revision: 4 })).toEqual({ reached: true })
      expect(calls.filter((call) => call.operation === operation)).toHaveLength(1)
    }
    expect(calls.filter((call) => call.operation === "coordination.list")).toHaveLength(4)
    const refused = incidents(answers({ "coordination.update": { status: "failed", error: { code: "invalid_message", message: "Project revision changed" } } }))
    await refused.client.fetchQuery(refused.queries.coordination(scope, true))
    expect(await refused.queries.changeCoordination(scope, "coordination.update", { groupID: "cgrp_1", revision: 3 })).toEqual({ reached: false, message: "Projects: Project revision changed" })
    expect(refused.calls.filter((call) => call.operation === "coordination.list")).toHaveLength(2)
  })

  test("an unconfirmed change is never sent again and says so after rereading", async () => {
    const { calls, client, queries } = incidents(answers({ "coordination.create": { status: "unknown", error: { code: "outcome_unknown", message: "Request timed out" } } }))
    await client.fetchQuery(queries.coordination(scope, true))
    const result = await queries.changeCoordination(scope, "coordination.create", { name: "x" })
    expect(result).toEqual({ reached: false, unconfirmed: true, message: "Projects: Request timed out. The result is unconfirmed and was not sent again; the list below shows what the machine reports now." })
    expect(calls.filter((call) => call.operation === "coordination.create")).toHaveLength(1)
    expect(calls.filter((call) => call.operation === "coordination.list")).toHaveLength(2)
  })

  test("a connector without the operation says to update instead of failing generically", async () => {
    const { client, queries } = incidents(answers({ "coordination.delete": { status: "failed", error: { code: "unknown_operation", message: "unknown" } } }))
    await client.fetchQuery(queries.coordination(scope, true))
    expect(await queries.changeCoordination(scope, "coordination.delete", { groupID: "cgrp_1" })).toEqual({ reached: false, message: "Update YCoding on this machine to manage Projects from here." })
  })

  test("deleting a Session sends the Session delete for that Session alone and rereads the projects", async () => {
    const { calls, client, queries } = incidents(answers())
    await client.fetchQuery(queries.coordination(scope, true))
    expect(await queries.deleteProjectSession(scope, "ses_w1")).toEqual({ reached: true })
    const sent = calls.filter((call) => call.operation === "session.delete")
    expect(sent).toHaveLength(1)
    expect(sent[0]?.request?.sessionID).toBe("ses_w1")
    expect(calls.filter((call) => call.operation === "coordination.list")).toHaveLength(2)
  })

  test("a new Project Session is created once in the chosen workspace and confirmed by its echoed id", async () => {
    const created = answers({ "session.create": { status: "ok", value: { data: { id: "ses_new", title: "New", location: { directory: "/work/web" }, time: { created: 1, updated: 1 } } } } })
    const { calls, queries } = incidents(created)
    expect(await queries.createProjectSession(scope, "wsp_web", "ses_new")).toEqual({ reached: true, sessionID: "ses_new" })
    expect(calls.filter((call) => call.operation === "session.create").map((call) => call.request?.input)).toEqual([{ id: "ses_new", workspace: "wsp_web" }])
    expect(await queries.createProjectSession(scope, "wsp_web", "ses_new", "Release train")).toEqual({ reached: true, sessionID: "ses_new" })
    expect(calls.filter((call) => call.operation === "session.create").map((call) => call.request?.input)).toEqual([{ id: "ses_new", workspace: "wsp_web" }, { id: "ses_new", workspace: "wsp_web", title: "Release train" }])
    const mismatch = incidents(answers({ "session.create": { status: "ok", value: { data: { id: "ses_other" } } } }))
    expect(await mismatch.queries.createProjectSession(scope, "wsp_web", "ses_new")).toEqual({ reached: false, message: "The device returned a different Session than the one requested. Check Sessions before trying again." })
    const unknown = incidents(answers({ "session.create": { status: "unknown", error: { code: "outcome_unknown", message: "Request timed out" } } }))
    expect(await unknown.queries.createProjectSession(scope, "wsp_web", "ses_new")).toEqual({ reached: false, unconfirmed: true, message: "Session creation: Request timed out. The Session may already exist; it was not created again." })
    expect(unknown.calls.filter((call) => call.operation === "session.create")).toHaveLength(1)
    const refused = incidents(answers({ "session.create": { status: "failed", error: { code: "invalid_message", message: "Workspace is unavailable" } } }))
    expect(await refused.queries.createProjectSession(scope, "wsp_web", "ses_new")).toEqual({ reached: false, message: "Session creation: Workspace is unavailable" })
  })

  test("Session candidates read root Sessions across directories with the search text", async () => {
    const { calls, client, queries } = incidents(answers())
    const found = await client.fetchQuery(queries.projectCandidates(scope, true, "triage"))
    expect(found).toEqual([{ id: "ses_x", title: "Triage", directory: "/work/web", active: 2 }])
    expect(calls.find((call) => call.operation === "session.list")?.request?.input).toEqual({ limit: 25, order: "active", parentID: null, searchFields: "summary", search: "triage" })
    await client.fetchQuery(queries.projectCandidates(scope, true, ""))
    expect(calls.filter((call) => call.operation === "session.list").at(-1)?.request?.input).not.toHaveProperty("search")
  })

  test("a replaced connection never reads or invalidates the new generation", async () => {
    const next: QueryScope = { deviceID: "dev_1", generation: 2 }
    const { client, queries } = incidents(answers())
    await client.fetchQuery(queries.coordination(scope, true))
    await client.fetchQuery(queries.coordination(next, true))
    await queries.changeCoordination(scope, "coordination.update", { groupID: "cgrp_1", revision: 4 })
    expect(client.getQueryState(queries.coordination(next, true).queryKey)?.isInvalidated).toBe(false)
    expect(queries.coordination(scope, true).queryKey).not.toEqual(queries.coordination(next, true).queryKey)
  })
})

describe("usage dashboard query", () => {
  const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
  const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens }
  const reportOf = (group: RemoteUsageGroup) => ({ group, rows: [], total: metrics, rowCount: 0 })
  const input = {
    daily: { group: "day", from: 0, to: 10, timeZone: "UTC", limit: 30, sort: "key", order: "asc" },
    monthly: { group: "model", from: 0, to: 10, timeZone: "UTC", limit: 200, sort: "cost", order: "desc" },
    breakdown: { group: "provider-model", from: 0, to: 10, timeZone: "UTC", limit: 25 },
  } as const
  const ready = {
    status: "ready", asOf: 5, revision: "r1", summary: metrics, quota: { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } },
    daily: reportOf("day"), monthly: reportOf("model"), breakdown: reportOf("provider-model"),
  } satisfies Extract<RemoteUsageDashboard, { readonly status: "ready" }>
  const dashboard = (answers: (call: number) => RemoteRequestOutcome) => {
    const calls: { operation: string; request: RemoteTransportRequest | undefined; scope: QueryScope }[] = []
    const client = createRemoteQueryClient()
    const queries = createRemoteQueries({
      recoveries: () => 0,
      recovered: async () => false,
      request: async (requestScope, operation, request) => {
        calls.push({ operation, request, scope: requestScope })
        return answers(calls.length)
      },
    }, client)
    return { calls, client, queries }
  }
  const data = (value: unknown): RemoteRequestOutcome => ({ status: "ok", value: { data: value } })

  test("sends one composed request without a Session and returns ready, preparing, and error unchanged", async () => {
    const answers = [ready, { status: "preparing" }, { status: "error", message: "failed" }]
    const { calls, client, queries } = dashboard((call) => data(answers[call - 1]))
    expect(await client.fetchQuery(queries.usageDashboard(scope, true, input))).toEqual({ status: "ready", data: ready })
    client.clear()
    expect(await client.fetchQuery(queries.usageDashboard(scope, true, input))).toEqual({ status: "ready", data: { status: "preparing" } })
    client.clear()
    expect(await client.fetchQuery(queries.usageDashboard(scope, true, input))).toEqual({ status: "ready", data: { status: "error", message: "failed" } })
    expect(calls.map((call) => call.operation)).toEqual(["usage.dashboard", "usage.dashboard", "usage.dashboard"])
    expect(calls.every((call) => call.request?.sessionID === undefined && JSON.stringify(call.request?.input) === JSON.stringify(input))).toBe(true)
  })

  test("caches only a ready answer and keys on every report but not on refresh", async () => {
    const { calls, client, queries } = dashboard((call) => data(call === 1 ? { status: "preparing" } : ready))
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    expect(calls).toHaveLength(2)
    expect(remoteKeys.usageDashboard(scope, { ...input, refresh: true })).toEqual(remoteKeys.usageDashboard(scope, input))
    for (const changed of [{ ...input, daily: { ...input.daily, from: 1 } }, { ...input, monthly: { ...input.monthly, limit: 100 } }, { ...input, breakdown: { ...input.breakdown, group: "model" } }] as const)
      expect(remoteKeys.usageDashboard(scope, changed)).not.toEqual(remoteKeys.usageDashboard(scope, input))
    expect(remoteKeys.usageDashboard({ ...scope, generation: 2 }, input)).not.toEqual(remoteKeys.usageDashboard(scope, input))
  })

  test("an input with fewer slots sends and keys only those slots and expects exactly those slots back", async () => {
    const { daily: _daily, monthly: _monthly, breakdown: _breakdown, ...bare } = ready
    const single = { breakdown: input.breakdown } as const
    const { calls, client, queries } = dashboard(() => data({ ...bare, breakdown: ready.breakdown }))
    expect(await client.fetchQuery(queries.usageDashboard(scope, true, single))).toEqual({ status: "ready", data: { ...bare, breakdown: ready.breakdown } })
    expect(calls.map((call) => call.request?.input)).toEqual([single])
    const none = dashboard(() => data(bare))
    expect(await none.client.fetchQuery(none.queries.usageDashboard(scope, true, {}))).toEqual({ status: "ready", data: bare })
    expect(none.calls.map((call) => call.request?.input)).toEqual([{}])
    expect(remoteKeys.usageDashboard(scope, single)).not.toEqual(remoteKeys.usageDashboard(scope, {}))
    expect(remoteKeys.usageDashboard(scope, single)).not.toEqual(remoteKeys.usageDashboard(scope, input))
    expect(remoteKeys.usageDashboard(scope, { daily: input.daily })).not.toEqual(remoteKeys.usageDashboard(scope, { monthly: input.daily }))
    for (const [requested, answer] of [
      [single, bare], [single, { ...bare, daily: ready.daily }], [single, { ...bare, breakdown: ready.daily }], [{}, { ...bare, breakdown: ready.breakdown }],
    ] as const) {
      const mismatched = dashboard(() => data(answer))
      await expect(mismatched.client.fetchQuery(mismatched.queries.usageDashboard(scope, true, requested))).rejects.toThrow()
    }
  })

  test("refresh is a one-shot request flag that later reads never resend", async () => {
    const { calls, client, queries } = dashboard(() => data({ status: "preparing" }))
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    await queries.refreshUsageDashboard(scope, input)
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    await client.refetchQueries({ queryKey: remoteKeys.usageDashboard(scope, input), type: "all" })
    expect(calls.map((call) => call.request?.input)).toEqual([input, { ...input, refresh: true }, input, input])
    expect(calls.every((call) => call.operation === "usage.dashboard")).toBe(true)
  })

  test("an old connector is unsupported without any fallback read, and unreadable answers fail", async () => {
    const old = dashboard(() => ({ status: "failed", error: { code: "unknown_operation", message: "Unknown operation" } }) as RemoteRequestOutcome)
    expect(await old.client.fetchQuery(old.queries.usageDashboard(scope, true, input))).toEqual({ status: "unsupported" })
    expect(old.calls.map((call) => call.operation)).toEqual(["usage.dashboard"])
    const { breakdown: _breakdown, ...incomplete } = ready
    for (const value of [incomplete, { ...ready, status: "stale" }, { status: "error" }, { ...ready, daily: reportOf("month") }, { ...ready, asOf: -1 }, { ...ready, revision: 1 }]) {
      const unreadable = dashboard(() => data(value))
      await expect(unreadable.client.fetchQuery(unreadable.queries.usageDashboard(scope, true, input))).rejects.toThrow()
    }
    const gated = dashboard(() => data(ready))
    expect([gated.queries.usageDashboard(undefined, true, input).enabled, gated.queries.usageDashboard(scope, false, input).enabled,
      gated.queries.usageDashboard(scope, true, { ...input, daily: { ...input.daily, limit: 201 } }).enabled,
      gated.queries.usageDashboard(scope, true, input).enabled]).toEqual([false, false, false, true])
  })
})

describe("usage dashboard preparing progression", () => {
  const input = { breakdown: { group: "model", from: 0, to: 10, limit: 25 } } as const
  const bare = { status: "ready", asOf: 5, revision: "r1", summary: { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, quota: { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } } } satisfies Extract<RemoteUsageDashboard, { readonly status: "ready" }>
  const interval = (state: { status: string; data: unknown }) => {
    const queries = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: bare } }) }, createRemoteQueryClient())
    const options = queries.usageDashboard(scope, true, input) as unknown as { refetchInterval: (query: { state: typeof state }) => number | false }
    return options.refetchInterval({ state })
  }
  const received = (data: unknown) => ({ status: "success", data: { status: "ready", data } })

  test("polls only a received preparing answer", () => {
    expect(interval(received({ status: "preparing" }))).toBe(1_000)
    expect(interval(received({ status: "error", message: "failed" }))).toBe(false)
    expect(interval(received(bare))).toBe(false)
    expect(interval(received({ ...bare, quota: { status: "preparing" } }))).toBe(1_000)
    expect(interval(received({ ...bare, quota: { status: "error", message: "Provider quotas are unavailable right now." } }))).toBe(false)
    expect(interval(received({ ...bare, quota: { status: "ready", providers: [], forecast: { asOf: 4, localScope: "backend" } } }))).toBe(false)
    expect(interval({ status: "success", data: { status: "unsupported" } })).toBe(false)
    expect(interval({ status: "pending", data: undefined })).toBe(false)
    expect(interval({ status: "error", data: { status: "ready", data: { status: "preparing" } } })).toBe(false)
  })

  test("quota preparing is read as a ready accounting answer and polls until quota arrives, then stops", async () => {
    const pending = { ...bare, quota: { status: "preparing" } } as const
    let calls = 0
    const client = createRemoteQueryClient()
    const queries = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: ++calls === 1 ? pending : bare } }) }, client)
    const first = await client.fetchQuery(queries.usageDashboard(scope, true, {}))
    expect(first).toEqual({ status: "ready", data: pending })
    const options = queries.usageDashboard(scope, true, {}) as unknown as { refetchInterval: (query: { state: { status: string; data: unknown } }) => number | false }
    expect(options.refetchInterval({ state: { status: "success", data: first } })).toBe(1_000)
    const second = await client.fetchQuery({ ...queries.usageDashboard(scope, true, {}), staleTime: 0 })
    expect(second).toEqual({ status: "ready", data: bare })
    expect(options.refetchInterval({ state: { status: "success", data: second } })).toBe(false)
    expect(calls).toBe(2)
    client.clear()
  })

  test("a quota error is a readable settled quota state that is never polled", async () => {
    const failed = { ...bare, quota: { status: "error", message: "Provider quotas are unavailable right now." } } as const
    const client = createRemoteQueryClient()
    const queries = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: failed } }) }, client)
    expect(await client.fetchQuery(queries.usageDashboard(scope, true, {}))).toEqual({ status: "ready", data: failed })
    const options = queries.usageDashboard(scope, true, {}) as unknown as { staleTime: (query: { state: { data: unknown } }) => number }
    expect(options.staleTime({ state: { data: { status: "ready", data: failed } } })).toBe(60_000)
    expect(options.staleTime({ state: { data: { status: "ready", data: { ...bare, quota: { status: "preparing" } } } } })).toBe(0)
    client.clear()
  })

  test("a quota error without a message is unreadable", async () => {
    const client = createRemoteQueryClient()
    const queries = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: { ...bare, quota: { status: "error" } } } }) }, client)
    await expect(client.fetchQuery(queries.usageDashboard(scope, true, {}))).rejects.toThrow()
  })

  test("a ready answer without a readable quota section is unreadable", async () => {
    const { quota: _quota, ...withoutQuota } = bare
    for (const value of [withoutQuota, { ...bare, quota: { status: "stale" } }, { ...bare, quota: { status: "ready", providers: [] } }, { ...bare, quota: { status: "ready", providers: "none", forecast: bare.quota.forecast } }]) {
      const client = createRemoteQueryClient()
      const unreadable = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: value } }) }, client)
      await expect(client.fetchQuery(unreadable.usageDashboard(scope, true, {}))).rejects.toThrow()
    }
  })

  test("a preload-only read leaves no observer and therefore no poller", async () => {
    const client = createRemoteQueryClient()
    const queries = createRemoteQueries({ recoveries: () => 0, recovered: async () => false, request: async () => ({ status: "ok", value: { data: { status: "preparing" } } }) }, client)
    await client.fetchQuery(queries.usageDashboard(scope, true, input))
    expect(client.getQueryCache().find({ queryKey: remoteKeys.usageDashboard(scope, input) })?.getObserversCount()).toBe(0)
    client.clear()
  })
})
