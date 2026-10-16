import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderRequest } from "../src/provider-request.js"
import { UsageAccounting } from "../src/usage-accounting.js"
import { UsageAnchor } from "../src/usage-anchor.js"
import { UsageForecast } from "../src/usage-forecast.js"
import { SessionEvent } from "../src/session-event.js"

test("usage groups and filters preserve model while admitting typed new dimensions", () => {
  for (const group of ["model", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"])
    expect<unknown>(Schema.decodeUnknownSync(ProviderRequest.ReportInput)({ group, providerID: "openai", profile: "work", modelID: "m", selectedEffort: "high" }))
      .toEqual({ group, providerID: "openai", profile: "work", modelID: "m", selectedEffort: "high" })
  expect<unknown>(Schema.decodeUnknownSync(ProviderRequest.ReportDimensions)({ group: "provider-model", providerID: "openai", modelID: "m" }))
    .toEqual({ group: "provider-model", providerID: "openai", modelID: "m" })
  expect(() => Schema.decodeUnknownSync(ProviderRequest.ReportDimensions)({ group: "profile", providerID: "openai", profileState: "recorded" })).toThrow()
  expect<unknown>(Schema.decodeUnknownSync(ProviderRequest.ReportDimensions)({ group: "profile", providerID: "openai", profileState: "provider-default" }))
    .toEqual({ group: "profile", providerID: "openai", profileState: "provider-default" })
  const metrics = { logical: 0, physical: 0, helpers: 0, continued: 0, fallback: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const row = { key: '["provider","openai"]', label: "OpenAI", ...metrics }
  const report = { group: "provider", rows: [row], total: metrics, rowCount: 1 }
  const decodeReport = Schema.decodeUnknownSync(ProviderRequest.Report)
  expect(() => decodeReport(report)).toThrow()
  expect(decodeReport({ ...report, rows: [{ ...row, dimensions: { group: "provider", providerID: "openai" } }] }).rows).toHaveLength(1)
  expect(() => decodeReport({ ...report, rows: [{ ...row, dimensions: { group: "provider", providerID: "openai" }, model: { providerID: "openai", id: "arbitrary" } }] })).toThrow()
})

test("cost completeness distinguishes unpriced, partially priced and measured zero", () => {
  const decode = Schema.decodeUnknownSync(UsageAccounting.Cost)
  expect(decode({ pricedRequests: 0, unpricedRequests: 2 })).toEqual({ pricedRequests: 0, unpricedRequests: 2 })
  expect<unknown>(decode({ known: 0, total: 0, pricedRequests: 1, unpricedRequests: 0, provenance: "recorded" }).total).toBe(0)
  expect(decode({ known: 1, pricedRequests: 1, unpricedRequests: 1, provenance: "current_catalog" })).not.toHaveProperty("total")
  for (const value of [
    { total: 1, known: 1, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" },
    { known: 0, pricedRequests: 1, unpricedRequests: 0 },
    { total: 0, pricedRequests: 0, unpricedRequests: 1 },
  ]) expect(() => decode(value)).toThrow()
})

test("accounting lookups bound and deduplicate resident prompt and task identities", () => {
  for (const [schema, key, prefix] of [[UsageAccounting.PromptInput, "inputIDs", "msg"], [UsageAccounting.TaskInput, "sessionIDs", "ses"]] as const) {
    const decode = Schema.decodeUnknownSync(schema)
    expect<unknown>(decode({ [key]: [`${prefix}_1`] })).toEqual({ [key]: [`${prefix}_1`] })
    expect<unknown>(decode({ [key]: Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`) })).toEqual({ [key]: Array.from({ length: 100 }, (_, index) => `${prefix}_${index}`) })
    for (const ids of [[], [`${prefix}_1`, `${prefix}_1`], Array.from({ length: 101 }, (_, index) => `${prefix}_${index}`)])
      expect(() => decode({ [key]: ids })).toThrow()
  }
})

test("trusted causal references are additive on admitted input, request, launch and compaction facts", () => {
  const anchor = { sessionID: "ses_root", inputID: "msg_user" }
  expect<unknown>(Schema.decodeUnknownSync(UsageAnchor.Ref)(anchor)).toEqual(anchor)
  const admitted = { sessionID: "ses_child", inputID: "msg_child", input: { type: "user", data: { text: "work" }, delivery: "steer" } }
  const decodeInput = Schema.decodeUnknownSync(SessionEvent.InputAdmitted.data)
  expect<unknown>(decodeInput({ ...admitted, causedBy: anchor }).causedBy).toEqual(anchor)
  expect(decodeInput(admitted)).not.toHaveProperty("causedBy")
  const compaction = { sessionID: "ses_child", jobID: "cmp_job" }
  const decodeCompaction = Schema.decodeUnknownSync(SessionEvent.Compaction.Admitted.data)
  expect<unknown>(decodeCompaction({ ...compaction, usageAnchor: anchor }).usageAnchor).toEqual(anchor)
  expect(decodeCompaction(compaction)).not.toHaveProperty("usageAnchor")
  expect(SessionEvent.ProviderRequestRecorded.data.fields.usageAnchor).toBeDefined()
  const launch = { sessionID: "ses_child", change: { type: "launched", parentID: "ses_root", parentAssistantMessageID: "msg_assistant", toolCallID: "call_1", inputID: "msg_child", description: "task", agent: "build", model: { providerID: "openai", id: "m" }, promptDigest: "digest", background: true, delivery: "steer" } }
  const decodeTask = Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)
  expect(decodeTask({ ...launch, change: { ...launch.change, usageAnchor: anchor } }).change).toMatchObject({ usageAnchor: anchor })
  expect(decodeTask(launch).change).not.toHaveProperty("usageAnchor")
})

test("forecast retains native units, explicit local scope and absent unknown projections", () => {
  const decode = Schema.decodeUnknownSync(UsageForecast.Info)
  const forecast = { asOf: 100, localScope: "backend", localRates: [], quotas: [{ providerID: "openai", windowID: "daily", unit: "percent", source: "provider_api", stability: "stable", updatedAt: 100, state: "insufficient", evidence: "insufficient", reason: "Warming up" }] }
  expect<unknown>(Schema.encodeSync(UsageForecast.Info)(decode(forecast))).toEqual(forecast)
  expect(decode(forecast).quotas![0]).not.toHaveProperty("ratePerHour")
  expect(decode(forecast).quotas![0]).not.toHaveProperty("exhaustionAt")
  expect(() => Schema.decodeUnknownSync(UsageForecast.Input)({ localScope: "account" })).toThrow()
})
