import { describe, expect, test } from "bun:test"
import { ZAIUsage } from "@ycoding-ai/core/provider-usage/zai"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const input = { providerID: ProviderV2.ID.make("zai-coding-plan"), label: "Z.ai", updatedAt: 100 }

describe("ZAIUsage", () => {
  test("maps subscription windows by duration and monthly web-search count", () => {
    const snapshot = ZAIUsage.normalize({ ...input, quota: { data: { limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 20, nextResetTime: 1_800_000_000_000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 65, nextResetTime: 1_801_000_000_000 },
      { type: "TIME_LIMIT", unit: 5, number: 1, currentValue: 3, usage: 100, nextResetTime: 1_802_000_000_000 },
    ] } }, subscription: { data: [{ productName: "GLM Coding Max" }] } })
    expect(snapshot).toMatchObject({ label: "Z.ai GLM Coding Max", source: "provider_internal_api", stability: "best_effort", windows: [
      { id: "session", label: "Session", unit: "percent", used: 20, periodSeconds: 18000 },
      { id: "weekly", label: "Weekly", unit: "percent", used: 65, periodSeconds: 604800 },
      { id: "web-searches", label: "Web Searches", unit: "count", used: 3, limit: 100 },
    ] })
  })

  test("does not turn missing quotas into zeros", () => {
    const snapshot = ZAIUsage.normalize({ ...input, quota: { data: { limits: [] } } })
    expect(snapshot.windows).toEqual([])
    expect(() => ZAIUsage.normalize({ ...input, quota: { data: { limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5 },
    ] } } })).toThrow()
  })

  test("uses a stored Z.ai key and keeps quotas when optional plan lookup fails", async () => {
    const urls: string[] = []
    const http = HttpClient.make((request) => Effect.sync(() => {
      urls.push(request.url)
      return HttpClientResponse.fromWeb(request, request.url.endsWith("/list")
        ? Response.json({}, { status: 503 })
        : Response.json({ data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 12 }] } }))
    }))
    const snapshot = await Effect.runPromise(ProviderUsageV2.zai(http, {
      ...input, credential: new Credential.Info({
        id: Credential.ID.make("cred_zai_usage"), integrationID: Integration.ID.make("zai-coding-plan"),
        label: "default", value: { type: "key", key: "secret-zai-key" },
      }),
    }))
    expect(urls).toEqual([
      "https://api.z.ai/api/monitor/usage/quota/limit", "https://api.z.ai/api/biz/subscription/list",
    ])
    expect(snapshot.windows).toMatchObject([{ id: "session", used: 12 }])
    expect(JSON.stringify(snapshot)).not.toContain("secret-zai-key")
  })
})
