import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { ProviderUsagePaceAlerts } from "@ycoding-ai/core/provider-usage/pace-alerts"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"

const now = 1_800_000_000_000
const resetAt = now + 1_800_000
const providerID = Provider.ID.make("anthropic")

const window = (used: number, extra: Partial<ProviderUsage.Window> = {}) =>
  new ProviderUsage.Window({
    id: "five-hour",
    label: "Session",
    unit: "percent",
    used,
    limit: 100,
    resetAt,
    periodSeconds: 3600,
    ...extra,
  })

const empty = new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent" })

const input = (
  windows: ReadonlyArray<ProviderUsage.Window>,
  options: {
    account?: string
    updatedAt?: number
    at?: number
    status?: ProviderUsage.Status
    semantics?: "fixed-reset" | "balance"
  } = {},
) => ({
  account: options.account ?? "synthetic-account",
  semantics: options.semantics ?? ("fixed-reset" as const),
  now: options.at ?? now,
  snapshot: new ProviderUsage.Snapshot({
    providerID,
    label: "Claude",
    profile: "Work",
    status: options.status ?? "available",
    source: "response_headers",
    stability: "observed",
    updatedAt: options.updatedAt ?? now,
    windows,
  }),
})

function fixture(deliver?: (alert: ProviderUsage.QuotaPaceAlert) => Effect.Effect<boolean>) {
  const alerts: ProviderUsage.QuotaPaceAlert[] = []
  let outcome: "deliver" | "refuse" | "die" = "deliver"
  const service = ProviderUsagePaceAlerts.make({
    deliver:
      deliver ??
      ((alert) =>
        outcome === "die"
          ? Effect.die(new Error("synthetic delivery defect"))
          : Effect.sync(() => {
              if (outcome === "refuse") return false
              alerts.push(alert)
              return true
            })),
  })
  return {
    alerts,
    milestones: () => alerts.map((alert) => alert.milestone),
    refuse: () => (outcome = "refuse"),
    die: () => (outcome = "die"),
    accept: () => (outcome = "deliver"),
    observe: (value: ReturnType<typeof input>) => Effect.runPromise(service.observe(value)),
    service,
  }
}

describe("quota pace alert state", () => {
  test("delivers a payload with only the provider, window, milestone, reset, and generic copy", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    await value.observe(input([window(46)]))
    expect(value.alerts).toHaveLength(1)
    expect(Object.keys(value.alerts[0]!).toSorted()).toEqual(["body", "milestone", "providerID", "resetAt", "title", "windowID"])
    expect(value.alerts[0]).toMatchObject({
      providerID,
      windowID: "five-hour",
      milestone: "cutting-it-close",
      resetAt,
      title: "Cutting it close",
      body: "Projected quota use exceeds 90% of its limit at reset.",
    })
    expect(JSON.stringify(value.alerts)).not.toContain("synthetic-account")
    expect(JSON.stringify(value.alerts)).not.toContain("Work")
    expect(JSON.stringify(value.alerts)).not.toContain("Claude")
  })

  test("a held delivery serializes later observations so one edge never fires twice", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const delivered: string[] = []
    let started = 0
    const value = fixture((alert) =>
      Effect.gen(function* () {
        started++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        delivered.push(alert.milestone)
        return true
      }),
    )
    await value.observe(input([window(40)]))
    const first = Effect.runFork(value.service.observe(input([window(46)])))
    await Effect.runPromise(Deferred.await(entered))
    const second = Effect.runFork(value.service.observe(input([window(47)])))
    for (let turn = 0; turn < 20; turn++) await Effect.runPromise(Effect.yieldNow)
    expect(started).toBe(1)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(first))
    await Effect.runPromise(Fiber.join(second))
    expect(started).toBe(1)
    expect(delivered).toEqual(["cutting-it-close"])
  })

  test("an older observation is ignored", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    await value.observe(input([window(46)], { updatedAt: now - 1 }))
    expect(value.milestones()).toEqual([])
    await value.observe(input([window(46)]))
    expect(value.milestones()).toEqual(["cutting-it-close"])
  })

  test("an identical cached snapshot does not re-arm a milestone when only the clock advanced", async () => {
    const value = fixture()
    const later = now + 1_400_000
    await value.observe(input([window(40)]))
    await value.observe(input([window(46)]))
    await value.observe(input([window(46)], { at: later }))
    await value.observe(input([window(85)], { updatedAt: later, at: later }))
    expect(value.milestones()).toEqual(["cutting-it-close"])
  })

  test("a failed delivery is retried by an identical observation until it succeeds once", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    value.refuse()
    await value.observe(input([window(46)]))
    await value.observe(input([window(46)]))
    expect(value.milestones()).toEqual([])
    value.accept()
    await value.observe(input([window(46)]))
    await value.observe(input([window(46)]))
    expect(value.milestones()).toEqual(["cutting-it-close"])
  })

  test("a delivery defect keeps the edge pending and never fails the observation", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    value.die()
    await value.observe(input([window(46)]))
    value.accept()
    await value.observe(input([window(47)]))
    expect(value.milestones()).toEqual(["cutting-it-close"])
  })

  test("a pending cutting-it-close edge superseded by will-run-out sends only will-run-out", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    value.refuse()
    await value.observe(input([window(46)]))
    value.accept()
    await value.observe(input([window(60)]))
    expect(value.milestones()).toEqual(["will-run-out"])
  })

  test("no-data and unavailable observations neither prime nor disturb recorded signals", async () => {
    const value = fixture()
    await value.observe(input([empty]))
    await value.observe(input([window(95)], { status: "stale" }))
    await value.observe(input([window(95)]))
    expect(value.milestones()).toEqual([])
    await value.observe(input([empty], { updatedAt: now + 1 }))
    await value.observe(input([window(96)], { updatedAt: now + 2 }))
    expect(value.milestones()).toEqual([])
    const gap = fixture()
    await gap.observe(input([window(40)]))
    await gap.observe(input([empty], { updatedAt: now + 1 }))
    await gap.observe(input([window(46)], { updatedAt: now + 2 }))
    expect(gap.milestones()).toEqual(["cutting-it-close"])
  })

  test("a window with a reset but no period still alerts when under ten percent remains", async () => {
    const value = fixture()
    const balance = (remaining: number) =>
      new ProviderUsage.Window({ id: "credits", label: "Credits", unit: "percent", limit: 100, remaining, resetAt })
    await value.observe(input([balance(20)], { semantics: "balance" }))
    await value.observe(input([balance(10)], { semantics: "balance", updatedAt: now + 1 }))
    expect(value.milestones()).toEqual([])
    await value.observe(input([balance(9.9)], { semantics: "balance", updatedAt: now + 2 }))
    await value.observe(input([balance(5)], { semantics: "balance", updatedAt: now + 3 }))
    expect(value.milestones()).toEqual(["almost-out"])
  })

  test("a native currency window alerts below exactly ten percent remaining and not at it", async () => {
    const value = fixture()
    const credits = (remaining: number) =>
      new ProviderUsage.Window({ id: "credits", label: "Credits", unit: "usd", limit: 1.1, remaining, resetAt })
    await value.observe(input([credits(0.5)], { semantics: "balance" }))
    await value.observe(input([credits(0.11)], { semantics: "balance", updatedAt: now + 1 }))
    expect(value.milestones()).toEqual([])
    await value.observe(input([credits(0.1099)], { semantics: "balance", updatedAt: now + 2 }))
    expect(value.milestones()).toEqual(["almost-out"])
  })

  test("windows without a reported future reset never alert and never change recorded state", async () => {
    const value = fixture()
    const noReset = (used: number) => new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used, limit: 100, periodSeconds: 3600 })
    await value.observe(input([noReset(40)]))
    await value.observe(input([window(95)], { updatedAt: now + 1 }))
    await value.observe(input([noReset(96)], { updatedAt: now + 2 }))
    await value.observe(input([window(97)], { updatedAt: now + 3 }))
    expect(value.milestones()).toEqual([])
    const balance = new ProviderUsage.Window({ id: "credits", label: "Credits", unit: "usd", limit: 10, remaining: 0.5 })
    await value.observe(input([balance], { semantics: "balance" }))
    await value.observe(input([new ProviderUsage.Window({ id: "credits", label: "Credits", unit: "usd", limit: 10, remaining: 5 })], { semantics: "balance", updatedAt: now + 1 }))
    await value.observe(input([balance], { semantics: "balance", updatedAt: now + 2 }))
    expect(value.milestones()).toEqual([])
  })

  test("expired resets never alert and never change recorded state", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    await value.observe(input([window(95, { resetAt: now - 1 })], { updatedAt: now + 1 }))
    await value.observe(input([window(95, { resetAt: now })], { updatedAt: now + 2 }))
    expect(value.milestones()).toEqual([])
    await value.observe(input([window(46)], { updatedAt: now + 3 }))
    expect(value.milestones()).toEqual(["cutting-it-close"])
  })

  test("repeated sub-second reset jitter between adjacent observations never re-arms a milestone", async () => {
    const value = fixture()
    await value.observe(input([window(40)]))
    await value.observe(input([window(60)]))
    for (const [index, offset] of [500, 1000, 1500, 2000, 2500].entries())
      await value.observe(input([window(61 + index, { resetAt: resetAt + offset })]))
    expect(value.milestones()).toEqual(["will-run-out"])
  })

  test("accounts and windows keep independent signals", async () => {
    const value = fixture()
    await value.observe(input([window(40)], { account: "left" }))
    await value.observe(input([window(40)], { account: "right" }))
    await value.observe(input([window(46)], { account: "left" }))
    expect(value.milestones()).toEqual(["cutting-it-close"])
    await value.observe(input([window(46, { id: "weekly" })], { account: "right" }))
    expect(value.milestones()).toEqual(["cutting-it-close"])
    await value.observe(input([window(46)], { account: "right" }))
    expect(value.milestones()).toEqual(["cutting-it-close", "cutting-it-close"])
  })

  test("tracked state is bounded and an evicted window re-baselines without alerting", async () => {
    const value = fixture()
    await value.observe(input([window(40)], { account: "first" }))
    for (let index = 0; index < 256; index++) await value.observe(input([window(40)], { account: `account-${index}` }))
    await value.observe(input([window(60)], { account: "first" }))
    expect(value.milestones()).toEqual([])
    await value.observe(input([window(95)], { account: "first" }))
    expect(value.milestones()).toEqual(["almost-out"])
  })
})
