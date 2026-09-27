import { describe, expect, test } from "bun:test"
import { GoUsage } from "@ycoding-ai/core/provider-usage/go"
import { ProviderUsageV2 } from "@ycoding-ai/core/provider-usage"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const input = { providerID: ProviderV2.ID.make("opencode-go"), label: "OpenCode Go", updatedAt: 100 }

describe("OpenCodeUsage", () => {
  test("maps account-wide Go session, weekly, and monthly percent windows", () => {
    const snapshot = GoUsage.normalize({ ...input, response: { usage: {
      rolling: { percent: 12, resetsAt: "2026-09-28T00:00:00Z" },
      weekly: { percent: 40, resetsAt: "2026-09-30T00:00:00Z" },
      monthly: { percent: 51, resetsAt: "2026-10-01T00:00:00Z" },
    } } })
    expect(snapshot).toMatchObject({ windows: [
      { id: "session", label: "Session", unit: "percent", used: 12, resetAt: Date.parse("2026-09-28T00:00:00Z") },
      { id: "weekly", label: "Weekly", unit: "percent", used: 40 },
      { id: "monthly", label: "Monthly", unit: "percent", used: 51 },
    ] })
  })

  test("rejects missing percentages instead of inventing zero", () => {
    expect(() => GoUsage.normalize({ ...input, response: { usage: { rolling: {}, weekly: { percent: 1 }, monthly: { percent: 2 } } } })).toThrow()
  })

  test("uses a stored Go key and treats an entitlement rejection as no subscription", async () => {
    const urls: string[] = []
    const http = HttpClient.make((request) => Effect.sync(() => {
      urls.push(request.url)
      return HttpClientResponse.fromWeb(request, Response.json({ error: { type: "EntitlementError" } }, { status: 403 }))
    }))
    const snapshot = await Effect.runPromise(ProviderUsageV2.goUsage(http, {
      ...input, credential: new Credential.Info({
        id: Credential.ID.make("cred_go_usage"), integrationID: Integration.ID.make("opencode-go"),
        label: "default", value: { type: "key", key: "secret-go-key" },
      }),
    }))
    expect(urls).toEqual(["https://opencode.ai/zen/go/v1/usage"])
    expect(snapshot).toMatchObject({ status: "unsupported", windows: [], message: "No OpenCode Go subscription on this key" })
    expect(JSON.stringify(snapshot)).not.toContain("secret-go-key")
  })
})
