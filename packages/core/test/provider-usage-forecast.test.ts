import { describe, expect, test } from "bun:test"
import { ProviderUsageForecast } from "@ycoding-ai/core/provider-usage/forecast"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"

const minute = 60_000
const origin = 1_800_000_000_000
const providerID = Provider.ID.make("fixture")
const window = (used?: number, extra: Partial<ProviderUsage.Window> = {}) =>
  new ProviderUsage.Window({ id: "quota", label: "Quota", unit: "tokens", used, ...extra })
const snapshot = (at: number, value: ProviderUsage.Window, extra: Partial<ProviderUsage.Snapshot> = {}) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Fixture",
    source: "provider_api",
    stability: "stable",
    status: "available",
    updatedAt: origin + at * minute,
    windows: [value],
    ...extra,
  })
const observe = (
  store: ReturnType<typeof ProviderUsageForecast.make>,
  at: number,
  used?: number,
  extra: Partial<ProviderUsage.Window> = {},
  account = "account-generation-1",
) => {
  const value = snapshot(at, window(used, extra))
  store.observe({ account, snapshot: value, semantics: "fixed-reset" })
  return store.quota({
    account,
    snapshot: value,
    window: value.windows[0],
    now: value.updatedAt,
    semantics: "fixed-reset",
  })
}

describe("quota forecast observations", () => {
  test("warms up, deduplicates cached observations and requires ten minutes and material consumption", () => {
    const store = ProviderUsageForecast.make()
    expect(observe(store, 0, 10).reason).toBe("Collecting observations")
    for (let i = 0; i < 10; i++) observe(store, 0, 10)
    expect(observe(store, 10, 20).state).toBe("insufficient")
    expect(observe(store, 11, 21)).toMatchObject({ state: "estimated", evidence: "medium", method: "quota-delta-ema" })
    const flat = ProviderUsageForecast.make()
    observe(flat, 0, 10)
    observe(flat, 5, 10)
    expect(observe(flat, 10, 10)).toMatchObject({ state: "insufficient", reason: "No increase observed" })
    const tiny = ProviderUsageForecast.make()
    observe(tiny, 0, 10, { unit: "percent" })
    observe(tiny, 5, 10.1, { unit: "percent" })
    expect(observe(tiny, 10, 10.2, { unit: "percent" }).reason).toBe("Consumption below reporting resolution")
  })

  test("smooths irregular interval deltas with a 15-minute half-life, not refresh-count weights", () => {
    const store = ProviderUsageForecast.make()
    observe(store, 0, 0)
    observe(store, 10, 10)
    const value = observe(store, 25, 40)
    expect(value.ratePerHour).toBeCloseTo(90, 10)
    expect(value).toMatchObject({ observedFrom: origin, observedTo: origin + 25 * minute })
    expect(observe(store, 40, 40).ratePerHour).toBeCloseTo(45, 10)
  })

  test("labels coarse evidence low rather than manufacturing medium confidence", () => {
    const store = ProviderUsageForecast.make()
    observe(store, 0, 10)
    observe(store, 5, 10)
    expect(observe(store, 10, 20)).toMatchObject({ state: "estimated", evidence: "low" })
    const fractional = ProviderUsageForecast.make()
    observe(fractional, 0, 10, { unit: "percent" })
    observe(fractional, 5, 10.5, { unit: "percent" })
    expect(observe(fractional, 10, 11, { unit: "percent" })).toMatchObject({
      state: "estimated",
      evidence: "medium",
      ratePerHour: 6,
    })
  })

  test.each(["correction", "reset", "unit", "limit", "account", "period"] as const)(
    "breaks the comparable series on %s changes",
    (change) => {
      const store = ProviderUsageForecast.make()
      const extra = { limit: 100, resetAt: origin + 60 * minute, periodSeconds: 3600 }
      observe(store, 0, 10, extra)
      observe(store, 5, 20, extra)
      expect(observe(store, 10, 30, extra).state).toBe("estimated")
      const value = observe(
        store,
        15,
        change === "correction" ? 5 : 40,
        {
          ...extra,
          ...(change === "reset" ? { resetAt: origin + 120 * minute } : {}),
          ...(change === "unit" ? { unit: "requests" } : {}),
          ...(change === "limit" ? { limit: 200 } : {}),
          ...(change === "period" ? { periodSeconds: 7200 } : {}),
        },
        change === "account" ? "account-generation-2" : "account-generation-1",
      )
      expect(value.state).toBe("insufficient")
      expect(value.ratePerHour).toBeUndefined()
    },
  )

  test("preserves each source and selects the freshest series with sufficient comparable evidence", () => {
    const store = ProviderUsageForecast.make()
    const account = "private-account"
    for (const at of [0, 5, 10]) {
      store.observe({
        account,
        snapshot: snapshot(at, window(10 + at), {
          source: "response_headers",
          stability: "observed",
        }),
        semantics: "fixed-reset",
      })
      store.observe({
        account,
        snapshot: snapshot(at + 1, window(80), {
          source: "provider_internal_api",
          stability: "best_effort",
        }),
        semantics: "fixed-reset",
      })
    }
    const poll = snapshot(11, window(80), { source: "provider_internal_api", stability: "best_effort" })
    expect(
      store.quota({ account, snapshot: poll, window: poll.windows[0], now: poll.updatedAt, semantics: "fixed-reset" }),
    ).toMatchObject({
      state: "estimated",
      ratePerHour: 60,
      source: "response_headers",
      stability: "observed",
      updatedAt: origin + 10 * minute,
    })
    const fresh = snapshot(12, window(22), { source: "response_headers", stability: "observed" })
    store.observe({ account, snapshot: fresh, semantics: "fixed-reset" })
    expect(
      store.quota({
        account,
        snapshot: fresh,
        window: fresh.windows[0],
        now: fresh.updatedAt,
        semantics: "fixed-reset",
      }),
    ).toMatchObject({
      state: "estimated",
      observedFrom: origin,
      source: "response_headers",
      updatedAt: fresh.updatedAt,
    })
    for (const at of [16, 21])
      store.observe({
        account,
        snapshot: snapshot(at, window(80 + at - 11), {
          source: "provider_internal_api",
          stability: "best_effort",
        }),
        semantics: "fixed-reset",
      })
    expect(
      store.quota({
        account,
        snapshot: fresh,
        window: fresh.windows[0],
        now: origin + 21 * minute,
        semantics: "fixed-reset",
      }),
    ).toMatchObject({
      state: "estimated",
      source: "provider_internal_api",
      stability: "best_effort",
      updatedAt: origin + 21 * minute,
      observedFrom: origin + minute,
    })
  })

  test.each([100, 101])("reports percent usage of %s as exhausted without inventing a limit", (used) => {
    const result = observe(ProviderUsageForecast.make(), 0, used, { unit: "percent" })
    expect(result.state).toBe("exhausted")
    expect(result.ratePerHour).toBeUndefined()
    expect(result.exhaustionAt).toBeUndefined()
    expect(result.projectedUsedAtReset).toBeUndefined()
  })

  test("ignores out-of-order observations and invalidates same-time corrections", () => {
    const store = ProviderUsageForecast.make()
    observe(store, 0, 10)
    observe(store, 5, 20)
    const value = snapshot(10, window(30))
    observe(store, 10, 30)
    observe(store, 4, 500)
    expect(
      store.quota({
        account: "account-generation-1",
        snapshot: value,
        window: value.windows[0],
        now: value.updatedAt,
        semantics: "fixed-reset",
      }).ratePerHour,
    ).toBeCloseTo(120)
    expect(observe(store, 10, 35).state).toBe("insufficient")
  })

  test("breaks on replenishment even when a separate reported used counter stays monotonic", () => {
    const store = ProviderUsageForecast.make()
    observe(store, 0, 10, { remaining: 90 })
    observe(store, 5, 20, { remaining: 80 })
    expect(observe(store, 10, 30, { remaining: 70 }).state).toBe("estimated")
    expect(observe(store, 15, 40, { remaining: 85 }).state).toBe("insufficient")
  })

  test("rejects stale, future, expired, unbound and incompatible evidence without numbers", () => {
    const store = ProviderUsageForecast.make()
    const extra = { resetAt: origin + 30 * minute, limit: 100 }
    observe(store, 0, 0, extra)
    observe(store, 5, 10, extra)
    observe(store, 10, 20, extra)
    const value = snapshot(10, window(20, extra))
    for (const request of [
      { now: origin + 21 * minute },
      { now: origin + 9 * minute },
      { now: origin + 30 * minute },
      { account: undefined },
      { semantics: "rolling" as const },
      { snapshot: new ProviderUsage.Snapshot({ ...value, status: "stale" }) },
    ]) {
      const result = store.quota({
        account: "account-generation-1",
        snapshot: value,
        window: value.windows[0],
        now: value.updatedAt,
        semantics: "fixed-reset",
        ...request,
      })
      expect(result.state).toBe("insufficient")
      expect(result.ratePerHour).toBeUndefined()
      expect(result.exhaustionAt).toBeUndefined()
      expect(result.projectedUsedAtReset).toBeUndefined()
    }
  })

  test("projects only to the next reported reset and suppresses ETA after that reset", () => {
    const store = ProviderUsageForecast.make()
    const extra = { resetAt: origin + 30 * minute, limit: 100 }
    observe(store, 0, 0, extra)
    observe(store, 5, 10, extra)
    const result = observe(store, 10, 20, extra)
    expect(result.projectedUsedAtReset).toBeCloseTo(60)
    expect(result.exhaustionAt).toBeUndefined()
    const fast = ProviderUsageForecast.make()
    observe(fast, 0, 60, extra)
    observe(fast, 5, 70, extra)
    expect(observe(fast, 10, 80, extra).exhaustionAt).toBe(origin + 20 * minute)
    const atReset = ProviderUsageForecast.make()
    observe(atReset, 0, 40, extra)
    observe(atReset, 5, 50, extra)
    expect(observe(atReset, 10, 60, extra).exhaustionAt).toBeUndefined()
  })

  test("keeps absent limits absent and never converts percentage usage into tokens", () => {
    const store = ProviderUsageForecast.make()
    const extra = { unit: "percent" as const, resetAt: origin + 30 * minute }
    observe(store, 0, 10, extra)
    observe(store, 5, 20, extra)
    const result = observe(store, 10, 30, extra)
    expect(result.ratePerHour).toBeCloseTo(120)
    expect(result.projectedUsedAtReset).toBeCloseTo(70)
    expect(result.exhaustionAt).toBeUndefined()
    expect("limit" in result).toBe(false)
  })

  test("supports remaining-only finite balances with an ETA, but no fabricated reset projection", () => {
    const store = ProviderUsageForecast.make()
    observe(store, 0, undefined, { remaining: 40 })
    observe(store, 5, undefined, { remaining: 30 })
    const result = observe(store, 10, undefined, { remaining: 20 })
    expect(result.ratePerHour).toBeCloseTo(120)
    expect(result.exhaustionAt).toBe(origin + 20 * minute)
    expect(result.projectedUsedAtReset).toBeUndefined()
    expect(observe(store, 15, undefined, { remaining: 0 }).state).toBe("exhausted")
    expect(observe(store, 20, undefined, { unlimited: true }).state).toBe("unlimited")
  })

  test("emits low whole-window means only with explicitly supported complete-window semantics", () => {
    const store = ProviderUsageForecast.make()
    const value = snapshot(30, window(60, { resetAt: origin + 60 * minute, periodSeconds: 3600 }))
    store.observe({ account: "private", snapshot: value, semantics: "fixed-reset" })
    const input = {
      account: "private",
      snapshot: value,
      window: value.windows[0],
      now: value.updatedAt,
      semantics: "fixed-reset" as const,
    }
    expect(store.quota(input).state).toBe("insufficient")
    expect(store.quota({ ...input, wholeWindowMean: true })).toMatchObject({
      state: "estimated",
      method: "window-mean",
      evidence: "low",
      ratePerHour: 120,
      observedFrom: origin,
      observedTo: value.updatedAt,
      projectedUsedAtReset: 120,
    })
    for (const at of [35, 40]) {
      const next = snapshot(at, value.windows[0])
      store.observe({ account: "private", snapshot: next, semantics: "fixed-reset" })
      if (at === 40)
        expect(store.quota({ ...input, snapshot: next, now: next.updatedAt, wholeWindowMean: true }).reason).toBe(
          "No increase observed",
        )
    }
  })

  test("bounds observations and account/window history, and drops observations outside one hour", () => {
    const store = ProviderUsageForecast.make({ maxSeries: 2, maxObservations: 3 })
    observe(store, 0, 10, {}, "a")
    observe(store, 5, 20, {}, "a")
    observe(store, 10, 30, {}, "a")
    observe(store, 15, 40, {}, "a")
    expect(observe(store, 20, 50, {}, "a").observedFrom).toBe(origin + 10 * minute)
    observe(store, 20, 50, {}, "b")
    observe(store, 20, 50, {}, "c")
    expect(observe(store, 25, 60, {}, "a").state).toBe("insufficient")
    const horizon = ProviderUsageForecast.make()
    observe(horizon, 0, 0)
    observe(horizon, 5, 10)
    observe(horizon, 10, 20)
    expect(observe(horizon, 71, 100).state).toBe("insufficient")
  })

  test("keeps the evidence span under high-frequency stream observations instead of evicting every old point", () => {
    const store = ProviderUsageForecast.make()
    for (let second = 0; second < 15 * 60; second++) observe(store, second / 60, second)
    const result = observe(store, 15, 900)
    expect(result.state).toBe("estimated")
    expect(result.ratePerHour).toBeCloseTo(3600)
    expect(result.observedFrom).toBeLessThanOrEqual(origin + minute)
  })
})

describe("local recorded consumption", () => {
  test("uses five-minute bins and distinct 5/60-minute wall-clock rates with half-life smoothing", () => {
    const result = ProviderUsageForecast.localRates(
      [
        { start: origin, tokens: 300, knownUSD: 0.6, pricedRequests: 1, unpricedRequests: 0 },
        { start: origin + 55 * minute, tokens: 600, knownUSD: 1.2, pricedRequests: 1, unpricedRequests: 0 },
      ],
      origin + 60 * minute,
    )
    expect(result.tokensPerMinute5).toBe(120)
    expect(result.tokensPerMinute60).toBe(15)
    expect(result.tokensPerMinute).toBeGreaterThan(15)
    expect(result.tokensPerMinute).toBeLessThan(120)
    expect(result.estimatedUSDPerHour).toBeGreaterThan(1.8)
    expect(result.observedFrom).toBe(origin)
    expect(result.observedTo).toBe(origin + 60 * minute)
  })

  test("keeps partial pricing absent, measured zero explicit, and ignores out-of-horizon bins", () => {
    const result = ProviderUsageForecast.localRates(
      [
        { start: origin - 5 * minute, tokens: 9999, knownUSD: 999, pricedRequests: 1, unpricedRequests: 0 },
        { start: origin + 55 * minute, tokens: 0, knownUSD: 0, pricedRequests: 0, unpricedRequests: 1 },
      ],
      origin + 60 * minute,
    )
    expect(result.tokensPerMinute).toBe(0)
    expect(result.estimatedUSDPerHour).toBeUndefined()
    expect(result.coverage).toEqual({ pricedRequests: 0, unpricedRequests: 1 })
    expect(ProviderUsageForecast.localRates([], origin + 60 * minute).tokensPerMinute).toBe(0)
    expect(
      ProviderUsageForecast.localRates(
        [{ start: origin + 55 * minute, tokens: 1, pricedRequests: 1, unpricedRequests: 0 }],
        origin + 60 * minute,
      ).estimatedUSDPerHour,
    ).toBeUndefined()
  })
})
