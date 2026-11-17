import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@ycoding-ai/core/credential"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { ClaudeUsage } from "@ycoding-ai/core/provider-usage/claude"
import { ProviderUsagePaceAlerts } from "@ycoding-ai/core/provider-usage/pace-alerts"
import { accountIdentityDigest } from "@ycoding-ai/core/provider-usage/service"
import { createClaudeCodeFetch } from "@ycoding-ai/core/plugin/provider/anthropic-claude-code"
import { Integration } from "@ycoding-ai/schema/integration"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"

const providerID = Provider.ID.make("anthropic")
const now = 1_800_000_000_000
const resetAt = now + 3_600_000
const profile = (label: string, active: boolean) =>
  new Credential.Info({
    id: Credential.ID.make(`cred_limit_${label}`),
    integrationID: Integration.ID.make("anthropic"),
    label,
    active,
    value: {
      type: "oauth",
      methodID: Integration.MethodID.make("claude-code"),
      access: "synthetic",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
      metadata: { managed: true, source: label },
    },
  })
const limited = profile("Limited", false)
const healthy = profile("Healthy", true)
const oauth = (used: number, updatedAt: number) =>
  ClaudeUsage.normalizeOAuth({
    providerID,
    label: "Claude",
    updatedAt,
    response: {
      five_hour: { utilization: 10, resets_at: resetAt },
      seven_day: { utilization: used, resets_at: resetAt },
      seven_day_sonnet: { utilization: 20, resets_at: resetAt },
    },
  })
const observation = (snapshot: ProviderUsage.Snapshot) =>
  new ProviderUsage.Observation({
    providerID,
    label: snapshot.label,
    source: snapshot.source,
    stability: snapshot.stability,
    observedAt: snapshot.updatedAt,
    windows: snapshot.windows,
  })

describe("Claude quota rejection attribution", () => {
  test("rejected unified and model windows override optimistic utilization without exhausting allowed windows", () => {
    const snapshot = ClaudeUsage.normalizeHeaders({
      providerID,
      label: "Claude",
      observedAt: now,
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(resetAt / 1000),
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.1",
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-utilization": "0.8",
        "anthropic-ratelimit-unified-7d-reset": String(resetAt / 1000),
        "anthropic-ratelimit-unified-7d-sonnet-status": "rejected",
        "anthropic-ratelimit-unified-7d-sonnet-reset": String(resetAt / 1000),
      },
    })
    expect(snapshot.windows.find((w) => w.id === "five-hour")?.used).toBe(10)
    for (const id of ["unified", "seven-day", "seven-day-sonnet"])
      expect(snapshot.windows.find((w) => w.id === id)).toMatchObject({ used: 100, resetAt })
  })

  test("a unified 429 with only reset metadata is visible while an ordinary throughput 429 invents no subscription limit", () => {
    const normalize = (headers: Record<string, string>) =>
      ClaudeUsage.normalizeHeaders({
        providerID,
        label: "Claude",
        observedAt: now,
        status: 429,
        headers,
      })
    expect(normalize({ "anthropic-ratelimit-unified-reset": String(resetAt / 1000) }).windows).toMatchObject([
      { id: "unified", used: 100, resetAt },
    ])
    expect(normalize({ "anthropic-ratelimit-requests-remaining": "0", "retry-after": "30" }).windows).toEqual([])
  })

  test("a single configured profile remains attributed on both snapshots and forecasts", async () => {
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([limited]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { anthropic: (input) => Effect.succeed(oauth(95, input.updatedAt)) },
      now: () => now,
    })
    expect(await Effect.runPromise(service.get({ providerID }))).toMatchObject({ profile: "Limited" })
    expect((await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas).toEqual(
      expect.arrayContaining([expect.objectContaining({ profile: "Limited", windowID: "seven-day" })]),
    )
  })

  test("a rejected response reaches account-bound quota and warnings without being masked by another profile or a newer OAuth poll", async () => {
    let clock = now
    const delivered: ProviderUsage.QuotaPaceAlert[] = []
    const alerts = ProviderUsagePaceAlerts.make({
      deliver: (alert) =>
        Effect.sync(() => {
          delivered.push(alert)
          return true
        }),
    })
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([limited, healthy]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { anthropic: (input) => Effect.succeed(oauth(input.credential.active ? 5 : 40, input.updatedAt)) },
      now: () => clock,
      alerts,
    })
    await Effect.runPromise(service.list())
    clock += 1000
    const fetcher = createClaudeCodeFetch({
      credentials: async () => ({ accessToken: "synthetic", refreshToken: "synthetic", expiresAt: Number.MAX_SAFE_INTEGER }),
      reload: async () => null,
      fetch: Object.assign(
        async () =>
          new Response('{"error":{"type":"rate_limit_error","message":"Quota exceeded"}}', {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-7d-status": "rejected",
              "anthropic-ratelimit-unified-7d-reset": String(resetAt / 1000),
            },
          }),
        { preconnect: fetch.preconnect },
      ),
      onResponse: async (response) => {
        const value = ClaudeUsage.normalizeHeaders({
          providerID,
          label: "Claude",
          observedAt: clock,
          status: response.status,
          headers: response.headers,
        })
        await Effect.runPromise(service.observe(observation(value), accountIdentityDigest(limited)))
      },
    })
    const response = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: '{"model":"claude-sonnet-5-5","messages":[]}',
    })
    expect(response.status).toBe(429)
    expect(await response.text()).toContain("Quota exceeded")
    clock += 1000
    const snapshots = await Effect.runPromise(service.list({ refresh: true }))
    expect(snapshots.find((s) => s.profile === "Limited")?.windows.find((w) => w.id === "seven-day")?.used).toBe(100)
    expect(snapshots.find((s) => s.profile === "Healthy")?.windows.find((w) => w.id === "seven-day")?.used).toBe(5)
    const forecasts = (await Effect.runPromise(service.forecast({ localScope: "backend" }))).quotas
    expect(forecasts?.find((q) => q.profile === "Limited" && q.windowID === "seven-day")?.state).toBe("exhausted")
    expect(forecasts?.find((q) => q.profile === "Healthy" && q.windowID === "seven-day")?.state).not.toBe("exhausted")
    expect(delivered.map((a) => a.milestone)).toEqual(["will-run-out", "almost-out"])
    expect(
      delivered.every((a) => a.body.includes("Limited") && a.body.includes("Weekly") && !a.body.includes("Healthy")),
    ).toBe(true)
  })

  test("a later allowed response and a new reset release an exhausted window", async () => {
    let clock = now
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([limited]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { anthropic: (input) => Effect.succeed(oauth(5, input.updatedAt)) },
      now: () => clock,
    })
    const observe = (used: number) =>
      Effect.runPromise(
        service.observe(
          observation(
            ClaudeUsage.normalizeHeaders({
              providerID,
              label: "Claude",
              observedAt: clock,
              headers: {
                "anthropic-ratelimit-unified-7d-utilization": String(used / 100),
                "anthropic-ratelimit-unified-7d-reset": String(resetAt / 1000),
              },
            }),
          ),
          accountIdentityDigest(limited),
        ),
      )
    await observe(100)
    clock += 1000
    await Effect.runPromise(
      service.observe(
        observation(
          ClaudeUsage.normalizeHeaders({
            providerID,
            label: "Claude",
            observedAt: clock,
            headers: { "anthropic-ratelimit-unified-5h-utilization": "0.1" },
          }),
        ),
        accountIdentityDigest(limited),
      ),
    )
    expect((await Effect.runPromise(service.get({ providerID }))).windows.find((w) => w.id === "seven-day")?.used).toBe(
      100,
    )
    clock += 1000
    await observe(15)
    expect((await Effect.runPromise(service.get({ providerID }))).windows.find((w) => w.id === "seven-day")?.used).toBe(
      15,
    )
    clock = resetAt + 1000
    expect(
      (await Effect.runPromise(service.get({ providerID, refresh: true }))).windows.find((w) => w.id === "seven-day")
        ?.used,
    ).toBe(5)
  })
})
