import { expect, test } from "bun:test"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Deferred, Effect, Fiber } from "effect"

const now = 1_800_000_000_000
const providerID = Provider.ID.make("anthropic")
const quota = new ProviderUsage.Snapshot({ providerID, label: "Claude", status: "available", source: "provider_api", stability: "stable", updatedAt: now,
  windows: [new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used: 30, limit: 100, resetAt: now + 9_000_000, periodSeconds: 18_000 })] })
const credential = new Credential.Info({ id: Credential.ID.make("cred_quota_loading"), integrationID: Integration.ID.make("anthropic"), label: "Fixture", active: true,
  value: { type: "key", key: "synthetic-quota-key" } })

test("a cold forecast never starts a provider refresh", async () => {
  let calls = 0
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) }, providers: { available: () => Effect.succeed([{ id: providerID }]) },
    adapters: { anthropic: () => Effect.sync(() => { calls++; return quota }) }, now: () => now })
  expect(await Effect.runPromise(service.forecast({ localScope: "backend" }))).toMatchObject({ asOf: now, localScope: "backend", localRates: [] })
  expect(calls).toBe(0)
})

test("a forecast reads the last quota and local rates while a provider refresh is pending", async () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let calls = 0
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) }, providers: { available: () => Effect.succeed([{ id: providerID }]) },
    adapters: { anthropic: () => Effect.gen(function* () { calls++; if (calls > 1) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release) } return quota }) },
    localUsage: () => Effect.succeed([]), now: () => now })
  await Effect.runPromise(service.get({ providerID }))
  const refresh = Effect.runFork(service.get({ providerID, refresh: true }))
  await Effect.runPromise(Deferred.await(entered))
  try {
    const result = await Effect.runPromise(service.forecast({ localScope: "backend" }).pipe(Effect.timeout("500 millis")))
    expect(result.localRates).toEqual([])
    expect(result.quotas).toMatchObject([{ providerID, windowID: "five-hour" }])
    expect(calls).toBe(2)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(refresh))
  }
})

test("a forecast omits a quota cached for a replaced or rotated credential and never refreshes it", async () => {
  let current = credential
  let calls = 0
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([current]) }, providers: { available: () => Effect.succeed([{ id: providerID }]) },
    adapters: { anthropic: () => Effect.sync(() => { calls++; return quota }) }, now: () => now })
  await Effect.runPromise(service.get({ providerID }))
  expect((await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas).toMatchObject([{ providerID, windowID: "five-hour" }])
  current = new Credential.Info({ ...credential, generation: 1 })
  expect((await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas).toEqual([])
  current = new Credential.Info({ ...credential, accountGeneration: 1 })
  expect((await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas).toEqual([])
  expect(calls).toBe(1)
})

test("a forecast after a failed provider load reports no quota without retrying", async () => {
  let calls = 0
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([credential]) }, providers: { available: () => Effect.succeed([{ id: providerID }]) },
    adapters: { anthropic: () => Effect.sync(() => { calls++ }).pipe(Effect.andThen(Effect.fail(new Error("fixture provider failure")))) }, now: () => now })
  expect((await Effect.runPromise(service.list()))[0]).toMatchObject({ status: "error" })
  expect((await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas).toEqual([])
  expect(calls).toBe(1)
})

test("a forecast reads the account-unknown source from its cache only", async () => {
  const requests: Array<[boolean | undefined, boolean | undefined]> = []
  const service = ProviderUsageRuntime.make({ credentials: { all: () => Effect.succeed([]) }, providers: { available: () => Effect.succeed([{ id: providerID }]) }, adapters: {},
    accountUnknown: (refresh, cachedOnly) => Effect.sync(() => { requests.push([refresh, cachedOnly]); return [] }), now: () => now })
  await Effect.runPromise(service.list())
  await Effect.runPromise(service.forecast({ localScope: "backend" }))
  expect(requests).toEqual([[undefined, undefined], [undefined, true]])
})
