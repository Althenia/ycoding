import { describe, expect, test } from "bun:test"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { MuseUsage } from "@ycoding-ai/core/provider-usage/muse"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { Effect } from "effect"

const event = {
  subscription: {
    tier: "27681527378179523",
    weekly: { resets_at: 1792368000, used_percent: 0 },
    window: { resets_at: 1791876076, used_percent: 0, window_duration_mins: 300 },
  },
  type: "response.subscription_usage",
}

describe("MuseUsage", () => {
  test("normalizes live subscription windows with reported zeros and millisecond resets", () => {
    expect(MuseUsage.normalize(event, 100)).toMatchObject({
      providerID: "muse",
      label: "Muse (Meta)",
      status: "available",
      source: "response_stream",
      stability: "observed",
      updatedAt: 100,
      windows: [
        {
          id: "window",
          label: "5-hour window",
          unit: "percent",
          used: 0,
          resetAt: 1791876076000,
          periodSeconds: 18000,
        },
        { id: "weekly", label: "Weekly", unit: "percent", used: 0, resetAt: 1792368000000, periodSeconds: 604800 },
      ],
    })
  })

  test("omits absent metrics, preserves fractional percentages, and labels shorter windows", () => {
    const snapshot = MuseUsage.normalize(
      {
        type: event.type,
        subscription: { window: { window_duration_mins: 30, resets_at: 1791876076 }, weekly: { used_percent: 0.5 } },
      },
      100,
    )
    expect(snapshot?.windows[0]).toMatchObject({
      label: "30-minute window",
      resetAt: 1791876076000,
      periodSeconds: 1800,
    })
    expect(snapshot?.windows[0]?.used).toBeUndefined()
    expect(snapshot?.windows[1]).toMatchObject({ used: 0.5, periodSeconds: 604800 })
    expect(snapshot?.windows[1]?.resetAt).toBeUndefined()
    expect(MuseUsage.normalize({ type: event.type, subscription: {} }, 100)?.windows).toEqual([])
  })

  for (const payload of [
    undefined,
    {},
    { type: event.type, subscription: "invalid" },
    { type: event.type, subscription: { window: { used_percent: -1 } } },
    { type: event.type, subscription: { weekly: { used_percent: 101 } } },
    { type: event.type, subscription: { window: { resets_at: "1791876076" } } },
    { type: event.type, subscription: { window: { window_duration_mins: 0 } } },
  ])
    test(`rejects malformed subscription metrics (${JSON.stringify(payload)})`, () => {
      expect(MuseUsage.normalize(payload, 100)).toBeUndefined()
    })

  test("returns an explicit no-data snapshot without a network request", async () => {
    const providerID = Provider.ID.make("muse")
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_muse_usage"),
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: Credential.Key.make({ type: "key", key: "fixture" }),
    })
    expect(
      await Effect.runPromise(
        ProviderUsageRuntime.muse({ providerID, label: "Muse (Meta)", credential, updatedAt: 100 }),
      ),
    ).toMatchObject({
      providerID,
      label: "Muse (Meta)",
      status: "unsupported",
      source: "response_stream",
      stability: "observed",
      updatedAt: 100,
      windows: [],
      message: "Quota is reported after the next Muse response",
    })
  })
})
