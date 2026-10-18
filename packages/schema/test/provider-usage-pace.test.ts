import { expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
import { ProviderUsage } from "../src/provider-usage.js"

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
