import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
import { ProviderUsage } from "../src/provider-usage.js"
import { Remote } from "../src/remote.js"
import { UsageForecast } from "../src/usage-forecast.js"

const alert = {
  providerID: "anthropic",
  windowID: "five-hour",
  milestone: "will-run-out",
  resetAt: 1_800_001_800_000,
  title: "Will run out",
  body: "Quota use is at its limit or projected to exceed it before reset.",
} as const

test("a quota pace alert carries only the provider, window, milestone, reset, and generic copy", () => {
  expect(Object.keys(ProviderUsage.QuotaPaceAlert.fields).toSorted()).toEqual([
    "body",
    "milestone",
    "providerID",
    "resetAt",
    "title",
    "windowID",
  ])
  expect(Schema.encodeSync(ProviderUsage.QuotaPaceAlert)(Schema.decodeUnknownSync(ProviderUsage.QuotaPaceAlert)(alert))).toEqual(alert)
  const decode = Schema.decodeUnknownSync(ProviderUsage.QuotaPaceAlert)
  const { resetAt, ...withoutReset } = alert
  expect(resetAt).toBeGreaterThan(0)
  expect(() => decode(withoutReset)).toThrow()
  for (const invalid of [{ milestone: "healthy" }, { title: "" }, { body: "" }, { windowID: "" }, { resetAt: -1 }])
    expect(() => decode({ ...alert, ...invalid })).toThrow()
  expect(ProviderUsage.PaceMilestone.literals).toEqual(["almost-out", "cutting-it-close", "will-run-out"])
})

test("the quota pace event is an ephemeral canonical server event", () => {
  expect(ProviderUsage.Event.QuotaPace.type).toBe("provider.quota.pace")
  expect(ProviderUsage.Event.QuotaPace.durability).toBe("ephemeral")
  expect(EventManifest.Server.get("provider.quota.pace")).toBe(ProviderUsage.Event.QuotaPace)
  expect(EventManifest.Latest.get("provider.quota.pace")).toBe(ProviderUsage.Event.QuotaPace)
  expect(Array.from(EventManifest.Durable.values()).some((definition) => definition.type === "provider.quota.pace")).toBe(false)
  expect(Object.keys(ProviderUsage.Event.QuotaPace.data.fields).toSorted()).toEqual(
    Object.keys(ProviderUsage.QuotaPaceAlert.fields).toSorted(),
  )
})

test("a forecast quota carries an optional whole-window pace verdict", () => {
  const decode = Schema.decodeUnknownSync(UsageForecast.Pace)
  expect(decode({ verdict: "ahead", projectedUsedAtReset: 0 })).toEqual({ verdict: "ahead", projectedUsedAtReset: 0 })
  expect(decode({ verdict: "will-run-out", projectedUsedAtReset: 120.5, exhaustionAt: 1_800_000_000_000 })).toEqual({
    verdict: "will-run-out",
    projectedUsedAtReset: 120.5,
    exhaustionAt: 1_800_000_000_000,
  })
  for (const invalid of [
    { verdict: "healthy", projectedUsedAtReset: 1 },
    { verdict: "ahead", projectedUsedAtReset: -1 },
    { verdict: "ahead", projectedUsedAtReset: Number.POSITIVE_INFINITY },
    { verdict: "ahead", projectedUsedAtReset: 1, exhaustionAt: 1.5 },
    { verdict: "ahead" },
  ])
    expect(() => decode(invalid)).toThrow()
  expect(UsageForecast.Quota.fields.pace).toBeDefined()
  expect(
    Schema.decodeUnknownSync(UsageForecast.Quota)({
      providerID: "openai",
      windowID: "weekly",
      unit: "percent",
      source: "provider_api",
      stability: "stable",
      updatedAt: 1,
      state: "estimated",
      evidence: "medium",
      pace: { verdict: "cutting-it-close", projectedUsedAtReset: 98 },
    }).pace,
  ).toEqual({ verdict: "cutting-it-close", projectedUsedAtReset: 98 })
})

test("relay MCP status shares the remote connection states and exposes only an optional message and URL", () => {
  const decode = Schema.decodeUnknownSync(Remote.McpStatus)
  expect(Object.keys(Remote.McpStatus.fields).toSorted()).toEqual(["message", "state", "url"])
  expect(decode({ state: "on", url: "https://relay.example/api/mcp/devices/device" })).toEqual({
    state: "on",
    url: "https://relay.example/api/mcp/devices/device",
  })
  expect(decode({ state: "error", message: "Remote is not connected" })).toEqual({
    state: "error",
    message: "Remote is not connected",
  })
  for (const invalid of [{ state: "enabled" }, {}, { state: "off", url: 1 }]) expect(() => decode(invalid)).toThrow()
})
