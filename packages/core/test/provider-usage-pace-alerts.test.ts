import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderUsagePaceAlerts } from "@ycoding-ai/core/provider-usage/pace-alerts"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Provider } from "@ycoding-ai/schema/provider"

const now = 1_800_000_000_000
const resetAt = now + 1_800_000
const providerID = Provider.ID.make("anthropic")

function fixture() {
  const delivered: string[] = []
  let succeeds = true
  const alerts = ProviderUsagePaceAlerts.make({ deliver: (alert) => Effect.sync(() => { if (!succeeds) return false; delivered.push(alert.milestone); return true }) })
  return { delivered, fail: () => { succeeds = false }, succeed: () => { succeeds = true },
    observe: (used: number, reset = resetAt, at = now) => Effect.runPromise(alerts.observe({ account: "synthetic-account", semantics: "fixed-reset", now: at,
      snapshot: new ProviderUsage.Snapshot({ providerID, label: "Claude", status: "available", source: "response_headers", stability: "observed", updatedAt: at,
        windows: [new ProviderUsage.Window({ id: "five-hour", label: "Session", unit: "percent", used, limit: 100, resetAt: reset, periodSeconds: 3600 })] }) })) }
}

describe("quota pace milestone delivery", () => {
  test("records an already-exhausting first observation without alerting", async () => {
    const value = fixture()
    await value.observe(95)
    await value.observe(96)
    expect(value.delivered).toEqual([])
  })

  test("delivers worsening edges once, independently from remaining share", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(46)
    await value.observe(47)
    await value.observe(60)
    await value.observe(70)
    await value.observe(90)
    expect(value.delivered).toEqual(["cutting-it-close", "will-run-out"])
    await value.observe(90.01)
    await value.observe(95)
    expect(value.delivered).toEqual(["cutting-it-close", "will-run-out", "almost-out"])
  })

  test("a direct jump skips the less urgent pace milestone", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(60)
    expect(value.delivered).toEqual(["will-run-out"])
  })

  test("sustained ahead pace re-arms pace and remaining milestones", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(46)
    await value.observe(95)
    await value.observe(40)
    await value.observe(40.5, resetAt, now + 15 * 60_000)
    await value.observe(70, resetAt, now + 15 * 60_000 + 1_000)
    await value.observe(95, resetAt, now + 15 * 60_000 + 2_000)
    expect(value.delivered).toEqual(["cutting-it-close", "will-run-out", "almost-out", "cutting-it-close", "will-run-out", "almost-out"])
  })

  test("a projection flapping across a boundary alerts each milestone once per reset window", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(60)
    for (let index = 0; index < 5; index++) {
      await value.observe(46, resetAt, now + (index * 2 + 1) * 1_000)
      await value.observe(60, resetAt, now + (index * 2 + 2) * 1_000)
    }
    expect(value.delivered).toEqual(["will-run-out"])
  })

  test("brief ahead dips under fifteen minutes never re-arm", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(60)
    for (let index = 0; index < 5; index++) {
      await value.observe(40, resetAt, now + (index * 2 + 1) * 60_000)
      await value.observe(60, resetAt, now + (index * 2 + 2) * 60_000)
    }
    expect(value.delivered).toEqual(["will-run-out"])
  })

  test("ahead observations interrupted by a worse verdict restart the sustained span", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(60)
    await value.observe(40, resetAt, now + 60_000)
    await value.observe(64, resetAt, now + 10 * 60_000)
    await value.observe(40, resetAt, now + 12 * 60_000)
    await value.observe(40.1, resetAt, now + 20 * 60_000)
    await value.observe(95, resetAt, now + 21 * 60_000)
    expect(value.delivered).toEqual(["will-run-out", "almost-out"])
  })

  test("a restart that primes in an already-alerted verdict does not alert again when the projection flaps", async () => {
    const before = fixture()
    await before.observe(40)
    await before.observe(60)
    expect(before.delivered).toEqual(["will-run-out"])
    const after = fixture()
    await after.observe(60)
    await after.observe(46)
    await after.observe(60)
    expect(after.delivered).toEqual([])
  })

  test("a restart that primes below a milestone still alerts when it is first crossed", async () => {
    const after = fixture()
    await after.observe(46)
    await after.observe(60)
    expect(after.delivered).toEqual(["will-run-out"])
  })

  test("one-second reset jitter retains deduplication while a new reset re-arms it", async () => {
    const value = fixture()
    await value.observe(40)
    await value.observe(60)
    await value.observe(61, resetAt + 1000)
    expect(value.delivered).toEqual(["will-run-out"])
    await value.observe(62, resetAt + 2001)
    expect(value.delivered).toEqual(["will-run-out", "will-run-out"])
  })

  test("a failed delivery keeps the worsening edge pending", async () => {
    const value = fixture()
    await value.observe(40)
    value.fail()
    await value.observe(46)
    expect(value.delivered).toEqual([])
    value.succeed()
    await value.observe(47)
    await value.observe(48)
    expect(value.delivered).toEqual(["cutting-it-close"])
  })

  test("a hundred non-recovering observations deliver no more than three milestones", async () => {
    const value = fixture()
    for (let index = 0; index < 100; index++) await value.observe(40 + index * 0.6)
    expect(value.delivered).toEqual(["cutting-it-close", "will-run-out", "almost-out"])
  })

  test("a short recent burst with healthy whole-window pace never alerts", async () => {
    const value = fixture()
    await value.observe(10, resetAt, now - 600_000)
    await value.observe(10.1, resetAt, now - 300_000)
    await value.observe(40)
    expect(value.delivered).toEqual([])
  })
})
