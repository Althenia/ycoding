import { describe, expect, test } from "bun:test"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderUsageCache } from "@ycoding-ai/core/provider-usage/cache"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Integration } from "@ycoding-ai/schema/integration"
import { Provider } from "@ycoding-ai/core/provider"
import { Deferred, Effect, Fiber, Schema } from "effect"

const providerID = Provider.ID.make("test-provider")

const snapshot = (used: number, updatedAt: number) =>
  new ProviderUsage.Snapshot({
    providerID,
    label: "Test provider",
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt,
    windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used })],
  })

describe("ProviderUsage schema", () => {
  test("omits unknown amounts instead of encoding zeros", () => {
    const value = new ProviderUsage.Snapshot({
      providerID,
      label: "Test provider",
      status: "unsupported",
      source: "provider_api",
      stability: "stable",
      updatedAt: 1,
      windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent" })],
      message: "Not reported",
    })

    expect(Schema.encodeSync(ProviderUsage.Snapshot)(value)).toEqual({
      providerID: "test-provider",
      label: "Test provider",
      status: "unsupported",
      source: "provider_api",
      stability: "stable",
      updatedAt: 1,
      windows: [{ id: "weekly", label: "Weekly", unit: "percent" }],
      message: "Not reported",
    })
  })
})

describe("ProviderUsageCache", () => {
  test("deduplicates concurrent refreshes and retains stale data after failure", async () => {
    let now = 1_000
    let loads = 0
    const cache = ProviderUsageCache.make({ now: () => now })
    const load = Effect.sleep("10 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          loads++
          return snapshot(25, now)
        }),
      ),
    )

    const [left, right] = await Effect.runPromise(
      Effect.all(
        [
          cache.get({ key: "provider:credential", ttlMs: 60_000, load }),
          cache.get({ key: "provider:credential", ttlMs: 60_000, load }),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(left).toEqual(right)
    expect(loads).toBe(1)

    now = 62_000
    const stale = await Effect.runPromise(
      cache.get({
        key: "provider:credential",
        ttlMs: 60_000,
        refresh: true,
        load: Effect.fail(new Error("secret upstream body")),
      }),
    )
    expect(stale).toMatchObject({ status: "stale", windows: [{ used: 25 }] })
    expect(stale.message).toBe("Provider usage refresh failed")
    expect(JSON.stringify(stale)).not.toContain("secret upstream body")
  })

  test("isolates cache entries by credential identity", async () => {
    const cache = ProviderUsageCache.make({ now: () => 1 })
    const first = await Effect.runPromise(
      cache.get({ key: "provider:cred-a", ttlMs: 60_000, load: Effect.succeed(snapshot(10, 1)) }),
    )
    const second = await Effect.runPromise(
      cache.get({ key: "provider:cred-b", ttlMs: 60_000, load: Effect.succeed(snapshot(80, 1)) }),
    )
    expect(first.windows[0]?.used).toBe(10)
    expect(second.windows[0]?.used).toBe(80)
  })
})

describe("ProviderUsageRuntime", () => {
  test("fences delayed replaced-account quota without re-fetching or blocking an independent profile", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let work = new Credential.Info({
      id: Credential.ID.make("cred_quota_work"),
      integrationID: Integration.ID.make(providerID),
      label: "Work",
      value: { type: "key", key: "fixture-old" },
    })
    const personal = new Credential.Info({
      id: Credential.ID.make("cred_quota_personal"),
      integrationID: work.integrationID,
      label: "Personal",
      value: { type: "key", key: "fixture-personal" },
    })
    const calls: Credential.ID[] = []
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([work, personal]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: {
        [providerID]: (input) =>
          Effect.gen(function* () {
            calls.push(input.credential.id)
            if (input.credential.id === work.id && input.credential.accountGeneration === 0) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            return snapshot(
              input.credential.id === personal.id ? 50 : input.credential.accountGeneration === 0 ? 10 : 90,
              1,
            )
          }),
      },
      now: () => 1,
    })
    const pending = Effect.runFork(service.get({ providerID, credentialID: work.id, refresh: true }))
    await Effect.runPromise(Deferred.await(entered))
    expect(await Effect.runPromise(service.get({ providerID, credentialID: personal.id }))).toMatchObject({
      profile: "Personal",
      windows: [{ used: 50 }],
    })
    work = new Credential.Info({
      ...work,
      accountGeneration: 1,
      generation: 1,
      value: { type: "key", key: "fixture-replacement" },
    })
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect(await Effect.runPromise(Fiber.join(pending))).toMatchObject({ status: "unsupported", windows: [] })
    expect(calls.filter((id) => id === work.id)).toHaveLength(1)
    expect(await Effect.runPromise(service.get({ providerID, credentialID: work.id }))).toMatchObject({
      profile: "Work",
      windows: [{ used: 90 }],
    })
  })

  test("keeps Claude response observations bound to their account when the active profile changes", async () => {
    const id = Provider.ID.make("anthropic")
    const sources = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
    let active = 0
    const profiles = () =>
      sources.map(
        (source, index) =>
          new Credential.Info({
            id: Credential.ID.make(`cred_claude_${index}`),
            integrationID: Integration.ID.make("anthropic"),
            label: index === 0 ? "Personal" : "Work",
            active: index === active,
            value: {
              type: "oauth",
              methodID: Integration.MethodID.make("claude-code"),
              access: source,
              refresh: "",
              expires: Number.MAX_SAFE_INTEGER,
              metadata: { authKind: "claude-code", managed: true, source },
            },
          }),
      )
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed(profiles()) },
      providers: { available: () => Effect.succeed([{ id }]) },
      adapters: {
        anthropic: (input) =>
          Effect.succeed(
            new ProviderUsage.Snapshot({
              providerID: id,
              label: "Claude",
              status: "available",
              source: "provider_internal_api",
              stability: "best_effort",
              updatedAt: 1,
              windows: [
                new ProviderUsage.Window({
                  id: "session",
                  label: "Session",
                  unit: "percent",
                  used: input.credential.label === "Personal" ? 15 : 75,
                }),
              ],
            }),
          ),
      },
      now: () => 1,
    })
    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID: id,
          label: "Claude",
          source: "response_headers",
          stability: "observed",
          observedAt: 2,
          windows: [new ProviderUsage.Window({ id: "session", label: "Session", unit: "percent", used: 15 })],
        }),
        SessionRunnerModel.accountIdentityDigest(profiles()[0]!),
      ),
    )
    expect((await Effect.runPromise(service.get({ providerID: id }))).windows[0]?.used).toBe(15)
    active = 1
    expect(await Effect.runPromise(service.get({ providerID: id }))).toMatchObject({
      profile: "Work",
      windows: [{ used: 75 }],
    })
    expect(
      await Effect.runPromise(service.get({ providerID: id, credentialID: Credential.ID.make("cred_claude_0") })),
    ).toMatchObject({ profile: "Personal", source: "response_headers", windows: [{ used: 15 }] })
  })

  test("replacing a named profile's credentials does not reuse the previous account's quota", async () => {
    let generation = 0
    const service = ProviderUsageRuntime.make({
      credentials: {
        all: () =>
          Effect.succeed([
            new Credential.Info({
              id: Credential.ID.make("cred_reconnected"),
              integrationID: Integration.ID.make("test-provider"),
              label: "Work",
              active: true,
              generation,
              value: { type: "key", key: generation === 0 ? "first-account" : "second-account" },
            }),
          ]),
      },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: { [providerID]: (input) => Effect.succeed(snapshot(input.credential.generation === 0 ? 10 : 80, 1)) },
      now: () => 1,
    })
    expect((await Effect.runPromise(service.get({ providerID }))).windows[0]?.used).toBe(10)
    generation = 1
    expect((await Effect.runPromise(service.get({ providerID }))).windows[0]?.used).toBe(80)
  })

  test("reports only measured YCoding-local daily spend separately from account quotas", () => {
    const now = new Date(2026, 8, 27, 12).getTime()
    const values = ProviderUsageRuntime.localSpendSnapshots(
      [
        { model: { providerID: "anthropic" }, cost: 0, timeCreated: now },
        { model: { providerID: "anthropic" }, cost: 0.75, timeCreated: now - 1_000 },
        { model: { providerID: "anthropic" }, cost: 2, timeCreated: now },
        { model: { providerID: "openai" }, cost: null, timeCreated: now },
        { model: { providerID: "opencode" }, cost: 0.25, timeCreated: now },
        { model: { providerID: "xai" }, cost: 1, timeCreated: now - 86_400_000 },
      ],
      now,
    )
    expect(values).toMatchObject([
      {
        providerID: "anthropic",
        profile: "YCoding local",
        source: "local_session",
        stability: "stable",
        windows: [{ id: "today", label: "Today", unit: "usd", used: 2.75 }],
      },
      {
        providerID: "opencode",
        label: "OpenCode Zen",
        profile: "YCoding local",
        source: "local_session",
        windows: [{ used: 0.25 }],
      },
    ])
    expect(values).toHaveLength(2)
  })

  test("lists local spend separately from a provider's account windows", async () => {
    const now = new Date(2026, 8, 27, 12).getTime()
    const service = ProviderUsageRuntime.make({
      credentials: {
        all: () =>
          Effect.succeed([
            new Credential.Info({
              id: Credential.ID.make("cred_local_spend"),
              integrationID: Integration.ID.make("anthropic"),
              label: "default",
              value: { type: "key", key: "secret" },
            }),
          ]),
      },
      providers: { available: () => Effect.succeed([{ id: Provider.ID.make("anthropic") }]) },
      adapters: {
        anthropic: (input) =>
          Effect.succeed(
            new ProviderUsage.Snapshot({
              providerID: input.providerID,
              label: "Claude",
              status: "available",
              source: "provider_internal_api",
              stability: "best_effort",
              updatedAt: now,
              windows: [new ProviderUsage.Window({ id: "session", label: "Session", unit: "percent", used: 35 })],
            }),
          ),
      },
      localSpend: () => Effect.succeed([{ model: { providerID: "anthropic" }, cost: 0.5, timeCreated: now }]),
      now: () => now,
    })
    expect(
      (await Effect.runPromise(service.list({ refresh: true }))).map((item) => [
        item.profile,
        item.source,
        item.windows[0]?.id,
      ]),
    ).toEqual([
      [undefined, "provider_internal_api", "session"],
      ["YCoding local", "local_session", "today"],
    ])
  })

  test("does not surface local spend for a provider disabled in the current Location", async () => {
    const now = new Date(2026, 8, 27, 12).getTime()
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([]) },
      providers: { available: () => Effect.succeed([]) },
      adapters: {},
      now: () => now,
      localSpend: () => Effect.succeed([{ model: { providerID: "anthropic" }, cost: 2, timeCreated: now }]),
    })
    expect(await Effect.runPromise(service.list())).toEqual([])
  })

  test("refreshes independent providers concurrently and preserves successes beside failures", async () => {
    const ready = await Effect.runPromise(Deferred.make<void>())
    const started: string[] = []
    const service = ProviderUsageRuntime.make({
      credentials: {
        all: () =>
          Effect.succeed(
            ["healthy", "failed"].map(
              (id) =>
                new Credential.Info({
                  id: Credential.ID.make(`cred_${id}`),
                  integrationID: Integration.ID.make(id),
                  label: "default",
                  value: { type: "key", key: "test-key", metadata: {} },
                }),
            ),
          ),
      },
      providers: {
        available: () => Effect.succeed(["healthy", "failed"].map((id) => ({ id: Provider.ID.make(id) }))),
      },
      adapters: Object.fromEntries(
        ["healthy", "failed"].map(
          (id) =>
            [
              id,
              (input: ProviderUsageRuntime.AdapterInput) =>
                Effect.gen(function* () {
                  started.push(id)
                  if (started.length === 2) yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(ready)
                  if (id === "failed") return yield* Effect.fail(new Error("private upstream details"))
                  return new ProviderUsage.Snapshot({
                    providerID: input.providerID,
                    label: input.label,
                    status: "available",
                    source: "provider_api",
                    stability: "stable",
                    updatedAt: input.updatedAt,
                    windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 25 })],
                  })
                }),
            ] as const,
        ),
      ),
    })

    try {
      const result = await Effect.runPromise(service.list({ refresh: true }).pipe(Effect.timeout("1 second")))
      expect(result).toMatchObject([
        { providerID: "failed", status: "error", message: "Provider usage refresh failed", windows: [] },
        { providerID: "healthy", status: "available", windows: [{ used: 25 }] },
      ])
      expect(JSON.stringify(result)).not.toContain("private upstream details")
    } finally {
      await Effect.runPromise(Deferred.succeed(ready, undefined))
    }
  })

  test("lists every connected provider once and reports unsupported connected providers honestly", async () => {
    const unsupportedProviderID = Provider.ID.make("connected-without-usage-adapter")
    const unconnectedProviderID = Provider.ID.make("unconnected-with-adapter")
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_connected_provider_usage"),
      integrationID: Integration.ID.make("test-provider"),
      label: "default",
      value: { type: "key", key: "secret", metadata: {} },
    })
    const calls: string[] = []
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([credential]) },
      providers: {
        available: () =>
          Effect.succeed([
            Provider.Info.empty(providerID),
            Provider.Info.empty(unsupportedProviderID),
            Provider.Info.empty(providerID),
          ]),
      },
      adapters: {
        "test-provider": ({ providerID, label, updatedAt }) =>
          Effect.sync(() => {
            calls.push(providerID)
            return new ProviderUsage.Snapshot({
              providerID,
              label,
              status: "available",
              source: "provider_api",
              stability: "stable",
              updatedAt,
              windows: [],
            })
          }),
        "unconnected-with-adapter": () =>
          Effect.sync(() => {
            calls.push(unconnectedProviderID)
            return snapshot(1, 100)
          }),
      },
      now: () => 100,
    })

    const values = await Effect.runPromise(service.list({ refresh: true }))

    expect(values.map((value) => [String(value.providerID), value.status])).toEqual([
      ["connected-without-usage-adapter", "unsupported"],
      ["test-provider", "available"],
    ])
    expect(values[0]?.message).toBe("Provider usage is unsupported")
    expect(calls).toEqual(["test-provider"])
  })

  test("resolves credentials safely and lets newer observations replace API snapshots", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_provider_usage"),
      integrationID: Integration.ID.make("test-provider"),
      label: "owner@example.com",
      value: { type: "key", key: "sk-secret-value", metadata: {} },
    })
    let loads = 0
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([credential]) },
      providers: { available: () => Effect.succeed([Provider.Info.empty(providerID)]) },
      adapters: {
        "test-provider": ({ providerID, label, updatedAt }) =>
          Effect.sync(() => {
            loads++
            return new ProviderUsage.Snapshot({
              providerID,
              label,
              status: "available",
              source: "provider_api",
              stability: "stable",
              updatedAt,
              windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 20 })],
            })
          }),
      },
      cache: ProviderUsageCache.make({ now: () => 100 }),
      now: () => 100,
    })

    const initial = await Effect.runPromise(service.get({ providerID }))
    expect(initial).toMatchObject({ label: "Test Provider", windows: [{ used: 20 }] })
    expect(JSON.stringify(initial)).not.toContain("owner@example.com")
    expect(JSON.stringify(initial)).not.toContain("sk-secret-value")

    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID,
          label: "Test Provider",
          source: "response_headers",
          stability: "observed",
          observedAt: 200,
          windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 35 })],
        }),
      ),
    )
    const observed = await Effect.runPromise(service.get({ providerID }))
    expect(observed).toMatchObject({ source: "response_headers", stability: "observed", windows: [{ used: 35 }] })
    expect(loads).toBe(1)

    const unsupported = await Effect.runPromise(service.get({ providerID: Provider.ID.make("missing-provider") }))
    expect(unsupported).toMatchObject({ status: "unsupported", windows: [] })
  })

  test("lists per-profile quotas without attributing account-unknown observations to the active profile", async () => {
    const profile = (id: string, label: string, active: boolean) =>
      new Credential.Info({
        id: Credential.ID.make(`cred_${id}`),
        integrationID: Integration.ID.make("test-provider"),
        label,
        active,
        value: { type: "key", key: `secret-${id}`, metadata: {} },
      })
    const single = Provider.ID.make("single-provider")
    const service = ProviderUsageRuntime.make({
      credentials: {
        all: () =>
          Effect.succeed([
            profile("work", "work", false),
            profile("personal", "personal", true),
            new Credential.Info({
              id: Credential.ID.make("cred_single"),
              integrationID: Integration.ID.make(single),
              label: "owner@example.com",
              value: { type: "key", key: "secret-single", metadata: {} },
            }),
          ]),
      },
      providers: { available: () => Effect.succeed([Provider.Info.empty(providerID), Provider.Info.empty(single)]) },
      adapters: Object.fromEntries(
        [providerID, single].map(
          (id) =>
            [
              id,
              (input: ProviderUsageRuntime.AdapterInput) =>
                Effect.succeed(
                  new ProviderUsage.Snapshot({
                    providerID: input.providerID,
                    label: input.label,
                    status: "available",
                    source: "provider_api",
                    stability: "stable",
                    updatedAt: input.updatedAt,
                    windows: [
                      new ProviderUsage.Window({
                        id: "weekly",
                        label: "Weekly",
                        unit: "percent",
                        used: input.credential.label === "work" ? 10 : 60,
                      }),
                    ],
                  }),
                ),
            ] as const,
        ),
      ),
      now: () => 100,
    })
    await Effect.runPromise(
      service.observe(
        new ProviderUsage.Observation({
          providerID,
          label: "Test Provider",
          source: "response_headers",
          stability: "observed",
          observedAt: 200,
          windows: [new ProviderUsage.Window({ id: "weekly", label: "Weekly", unit: "percent", used: 90 })],
        }),
      ),
    )

    const values = await Effect.runPromise(service.list({ refresh: true }))

    expect(
      values.map((value) => [String(value.providerID), value.profile, value.source, value.windows[0]?.used]),
    ).toEqual([
      ["single-provider", undefined, "provider_api", 60],
      ["test-provider", "personal", "provider_api", 60],
      ["test-provider", "work", "provider_api", 10],
      ["test-provider", undefined, "response_headers", 90],
    ])
    expect(JSON.stringify(values)).not.toContain("owner@example.com")
    expect(JSON.stringify(values)).not.toContain("secret-")
  })

  test("maps authenticated provider failures to safe status values", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_provider_usage_auth"),
      integrationID: Integration.ID.make("test-provider"),
      label: "default",
      value: { type: "key", key: "secret", metadata: {} },
    })
    const service = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([credential]) },
      providers: { available: () => Effect.succeed([Provider.Info.empty(providerID)]) },
      adapters: {
        "test-provider": () => Effect.fail(new ProviderUsageRuntime.RequestError({ status: 401 })),
      },
      now: () => 100,
    })

    const value = await Effect.runPromise(service.get({ providerID }))
    expect(value).toMatchObject({ status: "unauthorized", message: "Provider usage credentials are unauthorized" })
    expect(JSON.stringify(value)).not.toContain("secret")
  })
})
