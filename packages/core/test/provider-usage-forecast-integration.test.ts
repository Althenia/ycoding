import { expect } from "bun:test"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { observeMuseUsage } from "@ycoding-ai/core/plugin/provider/muse"
import { CopilotUsage } from "@ycoding-ai/core/provider-usage/copilot"
import { Integration } from "@ycoding-ai/schema/integration"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { UsageForecast } from "@ycoding-ai/schema/usage-forecast"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Database.node])))
const origin = 1_800_000_000_000
const minute = 60_000
const providerID = Provider.ID.make("anthropic")
const quota = (used: number, updatedAt: number, extra: Partial<ProviderUsage.Window> = {}) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Claude",
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt,
    windows: [
      new ProviderUsage.Window({
        id: "five-hour",
        label: "Five hours",
        unit: "percent",
        used,
        resetAt: origin + 300 * minute,
        ...extra,
      }),
    ],
  })
const create = (credentials: Credential.Interface, label: string) =>
  credentials.create({
    integrationID: Integration.ID.make(providerID),
    label,
    value: { type: "key", key: `fixture-${label}` },
  })

it.effect("a prior list warms the quota cache once per observation, forecasts never refresh, and profiles stay isolated without exposing account identity", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const work = yield* create(credentials, "Work")
    yield* create(credentials, "Personal")
    let now = origin
    let used = 10
    let loads = 0
    const service = ProviderUsageRuntime.make({
      credentials,
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      now: () => now,
      adapters: {
        [providerID]: (input) =>
          Effect.sync(() => {
            loads++
            return quota(input.credential.id === work.id ? used : 70, input.updatedAt)
          }),
      },
    })
    expect((yield* service.forecast({ localScope: "backend" })).quotas).toEqual([])
    expect(loads).toBe(0)
    yield* service.list()
    expect(loads).toBe(2)
    expect(
      (yield* service.forecast({ localScope: "backend" })).quotas!.every((value) => value.state === "insufficient"),
    ).toBe(true)
    for (let index = 0; index < 5; index++) yield* service.forecast({ localScope: "backend" })
    expect(loads).toBe(2)
    now += 5 * minute
    used = 20
    yield* service.list({ refresh: true })
    now += 5 * minute
    used = 30
    yield* service.list({ refresh: true })
    const result = yield* service.forecast({ localScope: "backend" })
    expect(result.quotas!.find((value) => value.profile === "Work")).toMatchObject({
      state: "estimated",
      method: "quota-delta-ema",
      evidence: "medium",
      ratePerHour: 120,
      observedFrom: origin,
      observedTo: now,
      projectedUsedAtReset: 610,
      source: "provider_internal_api",
      stability: "best_effort",
      updatedAt: now,
    })
    expect(result.quotas!.find((value) => value.profile === "Personal")).toMatchObject({
      state: "insufficient",
      reason: "No increase observed",
    })
    const encoded = JSON.stringify(Schema.encodeSync(UsageForecast.Info)(result))
    for (const forbidden of [work.id, "fixture-Work", "accountGeneration", "accountIdentityDigest", "raw"])
      expect(encoded).not.toContain(forbidden)
    const restarted = ProviderUsageRuntime.make({
      credentials,
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      now: () => now,
      adapters: { [providerID]: (input) => Effect.succeed(quota(used, input.updatedAt)) },
    })
    expect((yield* restarted.forecast({ localScope: "backend" })).quotas).toEqual([])
    yield* restarted.list()
    expect(
      (yield* restarted.forecast({ localScope: "backend" })).quotas!.every((value) => value.state === "insufficient"),
    ).toBe(true)
  }),
)

it.effect("alternating Claude header observations and refresh polls preserve source-specific evidence and labels", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const credential = yield* credentials.create({
      integrationID: Integration.ID.make(providerID),
      label: "Claude",
      value: {
        type: "oauth",
        methodID: Integration.MethodID.make("claude-code"),
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Number.MAX_SAFE_INTEGER,
        metadata: { managed: true, source: "11111111-1111-4111-8111-111111111111" },
      },
    })
    let now = origin
    const service = ProviderUsageRuntime.make({
      credentials,
      now: () => now,
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { [providerID]: (input) => Effect.succeed(quota(80, input.updatedAt)) },
    })
    for (const elapsed of [0, 5, 10]) {
      now = origin + elapsed * minute
      yield* service.observe(
        new ProviderUsage.Observation({
          providerID,
          label: "Claude",
          source: "response_headers",
          stability: "observed",
          observedAt: now,
          windows: quota(10 + elapsed, now).windows,
        }),
        SessionRunnerModel.accountIdentityDigest(credential),
      )
      now += minute
      yield* service.list({ refresh: true })
    }
    expect((yield* service.forecast({ localScope: "backend" })).quotas![0]).toMatchObject({
      state: "estimated",
      source: "response_headers",
      stability: "observed",
      updatedAt: origin + 10 * minute,
      observedFrom: origin,
      observedTo: origin + 10 * minute,
      ratePerHour: 60,
    })
  }),
)

it.effect("OAuth token rotation refreshes quota but retains the same account's stale windows on failure", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const value = Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("claude-code"),
      access: "fixture-old",
      refresh: "fixture-refresh",
      expires: 0,
    })
    const credential = yield* credentials.create({
      integrationID: Integration.ID.make(providerID),
      label: "Claude",
      value,
    })
    let failed = false
    const service = ProviderUsageRuntime.make({
      credentials,
      now: () => origin,
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: {
        [providerID]: (input) =>
          failed ? Effect.fail(new Error("fixture quota rejection")) : Effect.succeed(quota(25, input.updatedAt)),
      },
    })
    expect((yield* service.get({ providerID })).status).toBe("available")
    const rotated = yield* credentials.refresh(
      credential,
      Effect.succeed(Credential.OAuth.make({ ...value, access: "fixture-new", expires: Number.MAX_SAFE_INTEGER })),
    )
    expect(rotated?.accountGeneration).toBe(credential.accountGeneration)
    expect(rotated!.generation).toBeGreaterThan(credential.generation)
    failed = true
    expect(yield* service.get({ providerID })).toMatchObject({
      status: "stale",
      updatedAt: origin,
      windows: [{ used: 25 }],
    })
  }),
)

it.effect(
  "retains stale provider data but suppresses forecasts, and local-rate failures cannot block quota refresh",
  () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* create(credentials, "Work")
      let now = origin
      let failed = false
      const service = ProviderUsageRuntime.make({
        credentials,
        providers: { available: () => Effect.succeed([{ id: providerID }]) },
        now: () => now,
        adapters: {
          [providerID]: (input) =>
            failed
              ? Effect.fail(new Error("fixture private provider payload"))
              : Effect.succeed(quota(10 + (now - origin) / minute, input.updatedAt)),
        },
        localUsage: () => Effect.fail(new Error("fixture read failure")),
        localSpend: () => Effect.fail(new Error("fixture spend failure")),
      })
      for (const elapsed of [0, 5, 10]) {
        now = origin + elapsed * minute
        yield* service.get({ providerID, refresh: true })
      }
      expect((yield* service.forecast({ localScope: "location" })).quotas![0].state).toBe("estimated")
      failed = true
      now += 5 * minute
      const stale = yield* service.list({ refresh: true })
      expect(stale[0]).toMatchObject({ status: "stale", windows: [{ used: 20 }] })
      const result = yield* service.forecast({ localScope: "location" })
      expect(result).not.toHaveProperty("localRates")
      expect(result.quotas![0]).toMatchObject({ state: "insufficient", reason: "Quota observations are stale" })
      expect(result.quotas![0].ratePerHour).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain("fixture private provider payload")
      failed = false
      now += minute
      expect((yield* service.get({ providerID, refresh: true })).status).toBe("available")
    }),
)

it.effect(
  "stream observations accumulate before reads, stay account-bound, and restart after account replacement",
  () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const original = yield* credentials.create({
        integrationID: Integration.ID.make("muse"),
        label: "Work",
        value: { type: "key", key: "fixture-original" },
      })
      let now = origin
      const service = ProviderUsageRuntime.make({
        credentials,
        providers: { available: () => Effect.succeed([{ id: Provider.ID.make("muse") }]) },
        now: () => now,
        adapters: { muse: ProviderUsageRuntime.muse },
      })
      for (const elapsed of [0, 5, 10]) {
        now = origin + elapsed * minute
        yield* service.observe(
          new ProviderUsage.Observation({
            providerID: Provider.ID.make("muse"),
            label: "Muse",
            source: "response_stream",
            stability: "observed",
            observedAt: now,
            windows: [new ProviderUsage.Window({ ...quota(10 + elapsed, now).windows[0], id: "window" })],
          }),
          SessionRunnerModel.accountIdentityDigest(original),
        )
      }
      expect((yield* service.forecast({ localScope: "backend" })).quotas![0]).toMatchObject({
        state: "estimated",
        observedFrom: origin,
        observedTo: now,
        ratePerHour: 60,
      })
      const replaced = yield* credentials.create({
        integrationID: original.integrationID,
        label: "Work",
        value: { type: "key", key: "fixture-replaced" },
      })
      now += 5 * minute
      yield* service.observe(
        new ProviderUsage.Observation({
          providerID: Provider.ID.make("muse"),
          label: "Muse",
          source: "response_stream",
          stability: "observed",
          observedAt: now,
          windows: [new ProviderUsage.Window({ ...quota(80, now).windows[0], id: "window" })],
        }),
        SessionRunnerModel.accountIdentityDigest(replaced),
      )
      expect((yield* service.forecast({ localScope: "backend" })).quotas![0].state).toBe("insufficient")
      yield* service.observe(
        new ProviderUsage.Observation({
          providerID: Provider.ID.make("muse"),
          label: "Muse",
          source: "response_stream",
          stability: "observed",
          observedAt: now,
          windows: [new ProviderUsage.Window({ ...quota(25, now).windows[0], id: "window" })],
        }),
      )
      const result = yield* service.forecast({ localScope: "backend" })
      expect(result.quotas!.every((value) => value.state === "insufficient")).toBe(true)
    }),
)

it.effect(
  "maps recorded token categories and five-minute bins without mixing quota percentages or partial prices",
  () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* create(credentials, "Work")
      const scopes: UsageForecast.LocalScope[] = []
      const service = ProviderUsageRuntime.make({
        credentials,
        providers: { available: () => Effect.succeed([{ id: providerID }]) },
        now: () => origin + 60 * minute,
        adapters: { [providerID]: (input) => Effect.succeed(quota(90, input.updatedAt)) },
        localUsage: (scope, asOf) =>
          Effect.sync(() => {
            scopes.push(scope)
            return [
              {
                providerID,
                modelID: Model.ID.make("model"),
                profile: "Work",
                start: asOf - 5 * minute,
                requests: 1,
                tokens: { input: 100, output: 200, reasoning: 50, cache: { read: 100, write: 50 } },
                knownUSD: 0,
                pricedRequests: 1,
                unpricedRequests: 0,
              },
              {
                providerID,
                modelID: Model.ID.make("model"),
                profile: "Personal",
                start: asOf - 5 * minute,
                requests: 1,
                tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                pricedRequests: 0,
                unpricedRequests: 1,
              },
            ]
          }),
      })
      yield* service.list()
      const result = yield* service.forecast({ localScope: "location" })
      expect(scopes).toEqual(["location"])
      expect(result.localRates![0]).toMatchObject({
        profile: "Work",
        tokensPerMinute5: 100,
        tokensPerMinute60: 500 / 60,
        estimatedUSDPerHour: 0,
        coverage: { pricedRequests: 1, unpricedRequests: 0 },
      })
      expect(result.localRates![1].tokensPerMinute5).toBe(10)
      expect(result.localRates![1].estimatedUSDPerHour).toBeUndefined()
      expect(result.quotas![0].ratePerHour).toBeUndefined()
      expect(Schema.is(UsageForecast.Info)(result)).toBe(true)
    }),
)

it.effect("does not project unsupported rolling windows or observations with no account binding", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    yield* credentials.create({
      integrationID: Integration.ID.make("opencode-go"),
      label: "Go",
      value: { type: "key", key: "fixture-go" },
    })
    let now = origin
    const service = ProviderUsageRuntime.make({
      credentials,
      providers: { available: () => Effect.succeed([{ id: Provider.ID.make("opencode-go") }]) },
      now: () => now,
      adapters: {
        "opencode-go": (input) =>
          Effect.succeed(
            new ProviderUsage.Snapshot({
              ...quota((now - origin) / minute, now),
              providerID: input.providerID,
              windows: [
                new ProviderUsage.Window({
                  id: "session",
                  label: "Session",
                  unit: "percent",
                  used: (now - origin) / minute,
                  resetAt: origin + 300 * minute,
                  periodSeconds: 18000,
                }),
                new ProviderUsage.Window({
                  id: "future-window",
                  label: "Future",
                  unit: "percent",
                  used: 20,
                  resetAt: origin + 300 * minute,
                }),
                new ProviderUsage.Window({
                  id: "weekly",
                  label: "Weekly",
                  unit: "tokens",
                  used: 20,
                  resetAt: origin + 300 * minute,
                }),
                new ProviderUsage.Window({
                  id: "monthly",
                  label: "Monthly",
                  unit: "count",
                  remaining: 100,
                  periodSeconds: 3600,
                }),
              ],
            }),
          ),
      },
    })
    for (const elapsed of [0, 5, 10]) {
      now = origin + elapsed * minute
      yield* service.get({ providerID: Provider.ID.make("opencode-go"), refresh: true })
    }
    const result = yield* service.forecast({ localScope: "backend" })
    expect(result.quotas![0]).toMatchObject({
      state: "insufficient",
      reason: "Quota window semantics do not support projection",
    })
    expect(result.quotas![0].projectedUsedAtReset).toBeUndefined()
    expect(result.quotas!.every((value) => value.state === "insufficient" && value.ratePerHour === undefined)).toBe(true)
    const unbound = ProviderUsageRuntime.make({
      credentials,
      providers: { available: () => Effect.succeed([{ id: Provider.ID.make("muse") }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
      now: () => now,
    })
    yield* unbound.observe(
      new ProviderUsage.Observation({
        providerID: Provider.ID.make("muse"),
        label: "Muse",
        source: "response_stream",
        stability: "observed",
        observedAt: now,
        windows: [
          new ProviderUsage.Window({
            id: "window",
            label: "Window",
            unit: "percent",
            used: 20,
            resetAt: origin + 300 * minute,
          }),
        ],
      }),
    )
    expect((yield* unbound.forecast({ localScope: "backend" })).quotas![0]).toMatchObject({
      state: "insufficient",
      reason: "Quota account is unbound",
    })
  }),
)

it.effect("keeps model stream observations synchronous and preserves the response body", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    const credential = yield* credentials.create({
      integrationID: Integration.ID.make("muse"),
      label: "Muse",
      value: { type: "key", key: "fixture-muse" },
    })
    const now = Date.now()
    const service = ProviderUsageRuntime.make({
      credentials,
      providers: { available: () => Effect.succeed([{ id: Provider.ID.make("muse") }]) },
      adapters: { muse: ProviderUsageRuntime.muse },
    })
    const data = `data: ${JSON.stringify({
      type: "response.subscription_usage",
      subscription: {
        window: { used_percent: 10, resets_at: Math.floor((now + 300 * minute) / 1000), window_duration_mins: 300 },
      },
    })}\n\n`
    const response = observeMuseUsage(
      new Response(data, { headers: { "content-type": "text/event-stream" } }),
      service,
      SessionRunnerModel.accountIdentityDigest(credential),
    )
    expect(yield* Effect.promise(() => response.text())).toBe(data)
    expect((yield* service.forecast({ localScope: "backend" })).quotas![0]).toMatchObject({
      state: "insufficient",
      reason: "Collecting observations",
      windowID: "window",
    })
  }),
)

it.effect("uses low evidence for supported billing-cycle means and suppresses incompatible Copilot units", () =>
  Effect.gen(function* () {
    const credentials = yield* Credential.Service
    for (const id of ["cursor", "github-copilot"])
      yield* credentials.create({
        integrationID: Integration.ID.make(id),
        label: id,
        value: { type: "key", key: `fixture-${id}` },
      })
    const service = ProviderUsageRuntime.make({
      credentials,
      now: () => origin + 30 * minute,
      providers: {
        available: () => Effect.succeed(["cursor", "github-copilot"].map((id) => ({ id: Provider.ID.make(id) }))),
      },
      adapters: {
        cursor: (input) =>
          Effect.succeed(
            new ProviderUsage.Snapshot({
              ...quota(60, input.updatedAt),
              providerID: input.providerID,
              windows: [
                new ProviderUsage.Window({
                  id: "included",
                  label: "Included",
                  unit: "percent",
                  used: 60,
                  resetAt: origin + 60 * minute,
                  periodSeconds: 3600,
                }),
              ],
            }),
          ),
        "github-copilot": (input) =>
          Effect.succeed(
            CopilotUsage.normalizeQuota({
              ...input,
              response: {
                quota_reset_date: new Date(origin + 60 * minute).toISOString(),
                quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 150, percent_remaining: 50 } },
              },
            }),
          ),
      },
    })
    yield* service.list()
    const result = yield* service.forecast({ localScope: "backend" })
    expect(result.quotas!.find((value) => value.providerID === "cursor")).toMatchObject({
      state: "estimated",
      method: "window-mean",
      evidence: "low",
      ratePerHour: 120,
    })
    const copilot = result.quotas!.find((value) => value.providerID === "github-copilot")
    expect(copilot).toMatchObject({ state: "insufficient", reason: "Quota window semantics do not support projection" })
    expect(copilot?.exhaustionAt).toBeUndefined()
    expect(copilot?.ratePerHour).toBeUndefined()
  }),
)
