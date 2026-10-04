import { describe, expect, test } from "bun:test"
import { GrokUsage } from "@ycoding-ai/core/provider-usage/grok"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const input = { providerID: Provider.ID.make("xai"), label: "Grok", updatedAt: 100 }

describe("GrokUsage", () => {
  test("shows the shared weekly pool and pay-as-you-go cap from credits-format billing", () => {
    const snapshot = GrokUsage.normalize({ ...input, response: { config: {
      creditUsagePercent: 35,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T00:00:00Z", end: "2026-09-28T00:00:00Z" },
      onDemandCap: { val: 2500 },
    } } })
    expect(snapshot).toMatchObject({ source: "provider_internal_api", stability: "best_effort", windows: [
      { id: "weekly", label: "Weekly", unit: "percent", used: 35, resetAt: Date.parse("2026-09-28T00:00:00Z") },
      { id: "extra-usage", label: "Extra usage", unit: "count", limit: 2500 },
    ] })
  })

  test("treats proto-JSON omitted zero as measured zero, without calling a monthly pool weekly", () => {
    const snapshot = GrokUsage.normalize({ ...input, response: { config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
    } } })
    expect(snapshot.windows).toMatchObject([{ id: "extra-usage", limit: 0 }])
    expect(snapshot.windows.some((window) => window.id === "weekly")).toBe(false)
  })

  test("rejects a malformed period rather than inventing a reset", () => {
    expect(() => GrokUsage.normalize({ ...input, response: { config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } } })).toThrow()
    expect(() => GrokUsage.normalize({ ...input, response: { config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T00:00:00Z", end: "2026-09-28T00:00:00Z" },
      onDemandCap: "unknown",
    } } })).toThrow()
  })

  test("uses only an already-stored Grok OAuth token for the billing request", async () => {
    const urls: string[] = []
    const http = HttpClient.make((request) => Effect.sync(() => {
      urls.push(request.url)
      return HttpClientResponse.fromWeb(request, Response.json({ config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-21T00:00:00Z", end: "2026-09-28T00:00:00Z" },
      } }))
    }))
    const snapshot = await Effect.runPromise(ProviderUsageRuntime.grok(http, {
      ...input, credential: new Credential.Info({
        id: Credential.ID.make("cred_grok_usage"), integrationID: Integration.ID.make("xai"), label: "default",
        value: { type: "oauth", methodID: Integration.MethodID.make("device"), access: "secret", refresh: "secret", expires: 0 },
      }),
    }))
    expect(urls).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits"])
    expect(snapshot.windows[0]).toMatchObject({ id: "weekly", used: 0 })
    expect(JSON.stringify(snapshot)).not.toContain("secret")
  })
})
