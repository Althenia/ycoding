import { describe, expect, test } from "bun:test"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderUsageCache } from "@ycoding-ai/core/provider-usage/cache"
import { ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Effect, Schema } from "effect"

const providerID = ProviderV2.ID.make("test-provider")

const snapshot = (used: number, updatedAt: number) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Test provider",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt,
    windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used })],
  })

describe("ProviderUsage schema", () => {
  test("omits unknown amounts instead of encoding zeros", () => {
    const value = new ProviderUsage.Snapshot({
      providerID,
      label: "Test provider",
      status: "unsupported",
      source: "provider_api",
      stability: "stable",
      updatedAt: 1,
      windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent" })],
      message: "Not reported",
    })

    expect(Schema.encodeSync(ProviderUsage.Snapshot)(value)).toEqual({
      providerID: "test-provider",
      label: "Test provider",
      status: "unsupported",
      source: "provider_api",
      stability: "stable",
      updatedAt: 1,
      windows: [{ id: "weekly", label: "Weekly", unit: "percent" }],
      message: "Not reported",
    })
  })
})

describe("ProviderUsageCache", () => {
  test("deduplicates concurrent refreshes and retains stale data after failure", async () => {
    let now = 1_000
    let loads = 0
    const cache = ProviderUsageCache.make({ now: () => now })
    const load = Effect.sleep("10 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          loads++
          return snapshot(25, now)
        }),
      ),
    )

    const [left, right] = await Effect.runPromise(
      Effect.all([
        cache.get({ key: "provider:credential", ttlMs: 60_000, load }),
        cache.get({ key: "provider:credential", ttlMs: 60_000, load }),
      ], { concurrency: "unbounded" }),
    )
    expect(left).toEqual(right)
    expect(loads).toBe(1)

    now = 62_000
    const stale = await Effect.runPromise(
      cache.get({
        key: "provider:credential",
        ttlMs: 60_000,
        refresh: true,
        load: Effect.fail(new Error("secret upstream body")),
      }),
    )
    expect(stale).toMatchObject({ status: "stale", windows: [{ used: 25 }] })
    expect(stale.message).toBe("Provider usage refresh failed")
    expect(JSON.stringify(stale)).not.toContain("secret upstream body")
  })

  test("isolates cache entries by credential identity", async () => {
    const cache = ProviderUsageCache.make({ now: () => 1 })
    const first = await Effect.runPromise(
      cache.get({ key: "provider:cred-a", ttlMs: 60_000, load: Effect.succeed(snapshot(10, 1)) }),
    )
    const second = await Effect.runPromise(
      cache.get({ key: "provider:cred-b", ttlMs: 60_000, load: Effect.succeed(snapshot(80, 1)) }),
    )
    expect(first.windows[0]?.used).toBe(10)
    expect(second.windows[0]?.used).toBe(80)
  })
})

describe("ProviderUsageV2", () => {
  test("resolves credentials safely and lets newer observations replace API snapshots", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_provider_usage"),
      integrationID: Integration.ID.make("test-provider"),
      label: "owner@example.com",
      value: { type: "key", key: "sk-secret-value", metadata: {} },
    })
    let loads = 0
    const service = ProviderUsageV2.make({
      credentials: { all: () => Effect.succeed([credential]) },
      adapters: {
        "test-provider": ({ providerID, label, updatedAt }) =>
          Effect.sync(() => {
            loads++
            return new ProviderUsage.Snapshot({
              providerID,
              label,
              status: "available",
              source: "provider_api",
              stability: "stable",
              updatedAt,
              windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 20 })],
            })
          }),
      },
      cache: ProviderUsageCache.make({ now: () => 100 }),
      now: () => 100,
    })

    const initial = await Effect.runPromise(service.get({ providerID }))
    expect(initial).toMatchObject({ label: "Test Provider", windows: [{ used: 20 }] })
    expect(JSON.stringify(initial)).not.toContain("owner@example.com")
    expect(JSON.stringify(initial)).not.toContain("sk-secret-value")

    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID,
          label: "Test Provider",
          source: "response_headers",
          stability: "observed",
          observedAt: 200,
          windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 35 })],
        }),
      ),
    )
    const observed = await Effect.runPromise(service.get({ providerID }))
    expect(observed).toMatchObject({ source: "response_headers", stability: "observed", windows: [{ used: 35 }] })
    expect(loads).toBe(1)

    const unsupported = await Effect.runPromise(
      service.get({ providerID: ProviderV2.ID.make("missing-provider") }),
    )
    expect(unsupported).toMatchObject({ status: "unsupported", windows: [] })
  })

  test("maps authenticated provider failures to safe status values", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_provider_usage_auth"),
      integrationID: Integration.ID.make("test-provider"),
      label: "default",
      value: { type: "key", key: "secret", metadata: {} },
    })
    const service = ProviderUsageV2.make({
      credentials: { all: () => Effect.succeed([credential]) },
      adapters: {
        "test-provider": () => Effect.fail(new ProviderUsageV2.RequestError({ status: 401 })),
      },
      now: () => 100,
    })

    const value = await Effect.runPromise(service.get({ providerID }))
    expect(value).toMatchObject({ status: "unauthorized", message: "Provider usage credentials are unauthorized" })
    expect(JSON.stringify(value)).not.toContain("secret")
  })
})
