import { expect, test } from "bun:test"
import { Credential } from "@ycoding-ai/core/credential"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { ProviderUsagePaceAlerts } from "@ycoding-ai/core/provider-usage/pace-alerts"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Integration } from "@ycoding-ai/schema/integration"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Effect } from "effect"

const now = 1_800_000_000_000
const resetAt = now + 1_800_000
const providerID = Provider.ID.make("anthropic")
const credential = new Credential.Info({
  id: Credential.ID.make("cred_pace_retain"),
  integrationID: Integration.ID.make("anthropic"),
  label: "Fixture",
  active: true,
  value: { type: "key", key: "synthetic-pace-key" },
})
const windows = (used: number) => [
  new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used, limit: 100, resetAt, periodSeconds: 3600 }),
  new ProviderUsage.Window({ id: "credits", label: "Credits", unit: "usd", remaining: 5, limit: 10 }),
]
const snapshot = (used: number, updatedAt = now) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Claude",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt,
    windows: windows(used),
  })
const base = {
  credentials: { all: () => Effect.succeed([credential]) },
  providers: { available: () => Effect.succeed([{ id: providerID }]) },
  now: () => now,
}

test("a provider refresh submits one single-window observation per window with its quota semantics and bound account", async () => {
  const submitted: Array<Parameters<ProviderUsagePaceAlerts.Interface["observe"]>[0]> = []
  const service = ProviderUsageRuntime.make({
    ...base,
    adapters: { anthropic: (input) => Effect.succeed(snapshot(40, input.updatedAt)) },
    alerts: { observe: (request) => Effect.sync(() => void submitted.push(request)) },
  })
  await Effect.runPromise(service.get({ providerID }))
  expect(submitted.map((request) => [request.snapshot.windows.length, request.snapshot.windows[0]!.id, request.semantics, request.now])).toEqual([
    [1, "five-hour", "fixed-reset", now],
    [1, "credits", "balance", now],
  ])
  expect(new Set(submitted.map((request) => request.account)).size).toBe(1)
  expect(submitted[0]!.account).toBe(SessionRunnerModel.accountIdentityDigest(credential))
})

test("stream observations submit only when bound to an account", async () => {
  const submitted: string[] = []
  const service = ProviderUsageRuntime.make({
    ...base,
    adapters: {},
    alerts: { observe: (request) => Effect.sync(() => void submitted.push(request.account)) },
  })
  const observation = new ProviderUsage.Observation({
    providerID,
    label: "Claude",
    source: "response_headers",
    stability: "observed",
    observedAt: now,
    windows: windows(40),
  })
  await Effect.runPromise(service.observe(observation))
  expect(submitted).toEqual([])
  await Effect.runPromise(service.observe(observation, "digest-account"))
  expect(submitted).toEqual(["digest-account", "digest-account"])
})

test("a failing alert collaborator never fails a provider read", async () => {
  const service = ProviderUsageRuntime.make({
    ...base,
    adapters: { anthropic: (input) => Effect.succeed(snapshot(40, input.updatedAt)) },
    alerts: { observe: () => Effect.die(new Error("synthetic alert failure")) },
  })
  expect((await Effect.runPromise(service.get({ providerID }))).status).toBe("available")
})

test("cache reads and forecasts re-submit the same observation without duplicating an alert", async () => {
  const delivered: string[] = []
  const alerts = ProviderUsagePaceAlerts.make({
    deliver: (alert) => Effect.sync(() => void delivered.push(`${alert.windowID}:${alert.milestone}`)).pipe(Effect.as(true)),
  })
  let used = 40
  const service = ProviderUsageRuntime.make({
    ...base,
    adapters: { anthropic: (input) => Effect.succeed(snapshot(used, input.updatedAt)) },
    alerts,
  })
  await Effect.runPromise(service.get({ providerID, refresh: true }))
  used = 46
  await Effect.runPromise(service.get({ providerID, refresh: true }))
  for (let index = 0; index < 3; index++) {
    await Effect.runPromise(service.get({ providerID }))
    await Effect.runPromise(service.list())
    await Effect.runPromise(service.forecast({ localScope: "backend" }))
  }
  expect(delivered).toEqual(["five-hour:cutting-it-close"])
})

test("two Locations observing one account share alert state and deliver a flapping milestone once", async () => {
  const delivered: string[] = []
  const alerts = ProviderUsagePaceAlerts.make({
    deliver: (alert) => Effect.sync(() => void delivered.push(`${alert.windowID}:${alert.milestone}`)).pipe(Effect.as(true)),
  })
  let clock = now
  const location = (used: () => number) =>
    ProviderUsageRuntime.make({
      ...base,
      now: () => clock,
      adapters: { anthropic: (input) => Effect.succeed(snapshot(used(), input.updatedAt)) },
      alerts,
    })
  let first = 40
  let second = 40
  const a = location(() => first)
  const b = location(() => second)
  const read = (service: ReturnType<typeof location>) => {
    clock += 1_000
    return Effect.runPromise(service.get({ providerID, refresh: true }))
  }
  await read(a)
  await read(b)
  second = 60
  await read(b)
  for (let index = 0; index < 4; index++) {
    first = 46
    await read(a)
    second = 60
    await read(b)
    first = 60
    await read(a)
    second = 46
    await read(b)
  }
  expect(delivered).toEqual(["five-hour:will-run-out"])
})
