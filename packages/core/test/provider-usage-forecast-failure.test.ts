import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ProviderUsageRuntime } from "../src/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"
import { Model } from "@ycoding-ai/schema/model"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { UsageForecast } from "@ycoding-ai/schema/usage-forecast"

const providerID = Provider.ID.make("anthropic")
const now = 1_800_000_000_000
const defaults = {
  credentials: { all: () => Effect.succeed([]) },
  providers: { available: () => Effect.succeed([]) },
  adapters: {},
  now: () => now,
}

test("a failed local usage read leaves rates unavailable without hiding successful quota reads", async () => {
  const service = ProviderUsageRuntime.make({ ...defaults, localUsage: () => Effect.fail(new Error("read failed")) })
  const result = await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(result).not.toHaveProperty("localRates")
  expect(result.quotas).toEqual([])
})

test("a failed local rate computation is unavailable rather than empty", async () => {
  const service = ProviderUsageRuntime.make({ ...defaults, localUsage: () => Effect.succeed([{
    providerID, modelID: Model.ID.make("claude-test"), start: now - 60_000, requests: 1, pricedRequests: 0, unpricedRequests: 1,
    get tokens(): never { throw new Error("unreadable token totals") },
  }]) })
  const result = await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(result).not.toHaveProperty("localRates")
  expect(result.quotas).toEqual([])
})

test("a failed quota listing leaves quotas unavailable without hiding successful local reads", async () => {
  const service = ProviderUsageRuntime.make({ ...defaults, providers: { available: () => Effect.die(new Error("listing failed")) }, localUsage: () => Effect.succeed([]) })
  const result = await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(result).not.toHaveProperty("quotas")
  expect(result.localRates).toEqual([])
})

test("a failed whole forecast omits both populations", async () => {
  const snapshot = new ProviderUsage.Snapshot({ providerID, label: "Claude", status: "available", source: "provider_api", stability: "stable", updatedAt: now, windows: [] })
  const service = ProviderUsageRuntime.make({ ...defaults, providers: { available: () => Effect.succeed([{ id: providerID }]) }, accountUnknown: () => Effect.succeed([{
    ...snapshot, get windows(): never { throw new Error("unreadable quota windows") },
  }]) })
  const result = await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(result).toEqual({ asOf: now, localScope: "backend" })
})

test("successful empty reads retain present empty populations in the encoded forecast", async () => {
  const service = ProviderUsageRuntime.make({ ...defaults, localUsage: () => Effect.succeed([]) })
  const result = await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(Schema.encodeSync(UsageForecast.Info)(result)).toEqual({ asOf: now, localScope: "backend", localRates: [], quotas: [] })
})
