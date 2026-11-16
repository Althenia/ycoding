import { expect, test } from "bun:test"
import type { RemoteUsageProvider, RemoteUsageSummaryValue } from "@ycoding-ai/remote"
import { createRemoteQueries, createRemoteQueryClient, readUsageReport, type QueryScope } from "./queries"

const scope: QueryScope = { deviceID: "device_fixture", generation: 1 }
const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
const metrics = { logical: 1, physical: 1, helpers: 0, continued: 0, fallback: 0, tokens }
const provider = { providerID: "fixture", label: "Fixture", source: "provider_api", stability: "stable", status: "available", updatedAt: 1, windows: [{ id: "window", label: "Window", unit: "requests" }] } satisfies RemoteUsageProvider
const report = (fields: Record<string, unknown> = {}) => ({ group: "day" as const, rows: [{ ...metrics, key: "fixture", label: "Fixture", ...fields }], total: metrics, rowCount: 1 })

async function readAnswer(operation: "usage.providers" | "usage.summary", answer: unknown) {
  const client = createRemoteQueryClient()
  const queries = createRemoteQueries({ request: async () => ({ status: "ok", value: { data: answer } }), recoveries: () => 0, recovered: async () => false }, client)
  try {
    const request = operation === "usage.providers" ? client.fetchQuery(queries.usageProviders(scope, true)) : client.fetchQuery(queries.usageSummary(scope, true))
    return await request.then(
      (value) => ({ status: "resolved", value }),
      (cause: unknown) => ({ status: "rejected", message: cause instanceof Error ? cause.message : String(cause) }),
    )
  } finally { client.clear() }
}

test("Usage reports reject a string cache flag instead of exposing it as a boolean", () => {
  expect(readUsageReport(report({ cacheReadReported: "not-a-boolean" }), "day")).toBeUndefined()
  expect(readUsageReport({ ...report(), total: { ...metrics, cacheReadReported: "not-a-boolean" } }, "day")).toBeUndefined()
})

test.each([undefined, false, true])("Usage reports preserve an optional cache flag %j", (cacheReadReported) => {
  const answer = report(cacheReadReported === undefined ? {} : { cacheReadReported })
  expect(readUsageReport(answer, "day")).toEqual(answer)
  if (cacheReadReported === undefined) expect(readUsageReport(answer, "day")?.rows[0]).not.toHaveProperty("cacheReadReported")
})

test.each([
  { source: "future-source" }, { stability: "future-stability" }, { windows: [null] }, { windows: [{ id: "window", label: "Window", unit: "requests", unlimited: "yes" }] },
])("Usage providers reject malformed declared fields %j", async (fields) => {
  expect(await readAnswer("usage.providers", [{ ...provider, ...fields }])).toEqual({ status: "rejected", message: "The device returned unreadable usage data." })
})

test("Usage providers preserve valid literals, omitted options and unknown extension fields", async () => {
  const answer = [{ ...provider, futureMetadata: { fixture: true } }]
  expect(await readAnswer("usage.providers", answer)).toEqual({ status: "resolved", value: { status: "ready", data: answer } })
})

test.each(["provider_api", "local_client_rpc", "response_headers", "response_stream", "provider_internal_api", "local_session"])("Usage providers accept the declared source %s", async (source) => {
  const answer = [{ ...provider, source }]
  expect(await readAnswer("usage.providers", answer)).toEqual({ status: "resolved", value: { status: "ready", data: answer } })
})

test.each(["stable", "client_contract", "observed", "best_effort"])("Usage providers accept the declared stability %s", async (stability) => {
  const answer = [{ ...provider, stability }]
  expect(await readAnswer("usage.providers", answer)).toEqual({ status: "resolved", value: { status: "ready", data: answer } })
})

test("Usage summaries preserve valid optional models and their omitted fields", async () => {
  const summary = {
    ...metrics, cacheReadReported: false, models: [{ model: { providerID: "fixture", id: "model" }, requests: 1, tokens }],
    latestTiming: { generationDurationNs: 2 }, futureMetadata: { fixture: true },
  } satisfies RemoteUsageSummaryValue["data"] & { futureMetadata: { fixture: boolean } }
  expect(await readAnswer("usage.summary", summary)).toEqual({ status: "resolved", value: { status: "ready", data: summary } })
  expect(await readAnswer("usage.summary", metrics)).toEqual({ status: "resolved", value: { status: "ready", data: metrics } })
})

test.each([
  { cacheReadReported: "true" }, { models: {} }, { models: [null] },
  { models: [{ model: { providerID: "fixture", id: 3 }, requests: 1, tokens }] },
  { models: [{ model: { providerID: "fixture", id: "model" }, requests: 1, tokens, cacheReadReported: "true" }] },
])("Usage summaries reject malformed optional fields %j", async (fields) => {
  expect(await readAnswer("usage.summary", { ...metrics, ...fields })).toEqual({ status: "rejected", message: "The device returned unreadable usage data." })
})

test.each([
  { model: { providerID: "fixture", id: 3 } },
  { model: { providerID: "fixture", id: "model", profile: false } },
  { dimensions: { group: "future-group" } },
  { dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: "session", inputID: 3 } } },
])("Usage reports reject malformed optional model or dimensions %j", (fields) => {
  expect(readUsageReport(report(fields), "day")).toBeUndefined()
})

test("Usage typed groups keep their dimensions, attribution and profile-state rules", () => {
  const valid = { ...report(), group: "provider-profile-model", rows: [{ ...metrics, key: "fixture", label: "Fixture", dimensions: { group: "provider-profile-model", providerID: "fixture", modelID: "model", profileState: "recorded", profile: "profile" } }] } as const
  expect(readUsageReport(valid, "provider-profile-model")).toEqual(valid)
  expect(readUsageReport({ ...valid, rows: [{ ...valid.rows[0], dimensions: { ...valid.rows[0].dimensions, profile: undefined } }] }, "provider-profile-model")).toBeUndefined()
  const task = { ...report(), group: "task", rows: [{ ...metrics, key: "fixture", label: "Fixture", dimensions: { group: "task", attribution: "partial" } }] } as const
  expect(readUsageReport(task, "task")).toEqual(task)
})

test("Usage legacy groups preserve valid optional model and dimension metadata", () => {
  const answer = report({ model: { providerID: "fixture", id: "model", variant: "high", profile: "profile" }, dimensions: { group: "prompt", attribution: "complete", anchor: { sessionID: "session", inputID: "input" } }, futureMetadata: { fixture: true } })
  expect(readUsageReport(answer, "day")).toEqual(answer)
  expect(readUsageReport({ ...answer, group: "future-group" }, "day")).toBeUndefined()
})

test("Usage validation retains existing fractional amounts and finite signed token counts", async () => {
  const amounts = { ...metrics, logical: 0.5, tokens: { ...tokens, input: -1.5 } }
  const answer = { ...report(), rows: [{ ...amounts, key: "fixture", label: "Fixture" }], total: amounts }
  expect(readUsageReport(answer, "day")).toEqual(answer)
  const providers = [{ ...provider, updatedAt: -0.5, windows: [{ ...provider.windows[0]!, used: 0.5, resetAt: 0.5, periodSeconds: 0.5 }] }]
  expect(await readAnswer("usage.providers", providers)).toEqual({ status: "resolved", value: { status: "ready", data: providers } })
})
