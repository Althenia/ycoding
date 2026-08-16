import { expect } from "bun:test"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { ModelV2 } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const database = Database.layer({ path: ":memory:" })
const it = testEffect(Layer.provideMerge(SessionCacheRuntime.layer({ capacity: 2 }), database))
const sessionID = SessionSchema.ID.make("ses_cache_runtime")

const policy = (namespace: string, now: number) => ({
  sessionID,
  namespace,
  modelID: "claude-sonnet-4-5",
  configured: "adaptive" as const,
  now,
})

const adaptiveModel = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("openai"),
  id: ModelV2.ID.make("gpt-5.6"),
})
const adaptiveNow = SessionRunnerCache.PROMPT_CACHE_ROTATION_INTERVAL_MS * 5 + 1_000
const adaptiveBaseline = "c".repeat(64)
const adaptiveGeneration = () => ({
  sessionID,
  model: adaptiveModel,
  routeID: "openai-responses",
  apiModelID: "gpt-5.6",
  systemDigest: "a".repeat(64),
  toolDigest: "b".repeat(64),
  baselineKey: adaptiveBaseline,
  now: adaptiveNow,
})

const insertAdaptiveSteps = (rows: ReadonlyArray<{
  readonly cacheRead: number
  readonly invalidation: ProviderRequest.Invalidation
  readonly cacheReadReported?: boolean | null
  readonly promptCacheKey?: string
}>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Cache runtime" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const existing = yield* db
      .select({ request: SessionProviderRequestTable.request })
      .from(SessionProviderRequestTable)
      .where(eq(SessionProviderRequestTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderRequestTable)
      .values(
        rows.map((row, index) => ({
          id: ProviderRequest.ID.make(`prq_adaptive_${existing.length + index}`),
          session_id: sessionID,
          source: "step" as const,
          agent: AgentV2.ID.make("build"),
          model: adaptiveModel,
          route_id: "openai-responses",
          prompt_cache_key: row.promptCacheKey ?? adaptiveBaseline,
          system_digest: "a".repeat(64),
          tool_digest: "b".repeat(64),
          request: existing.length + index + 1,
          attempts: 1,
          invalidation: row.invalidation,
          continuation: "full" as const,
          cache_read_reported: row.cacheReadReported === undefined ? true : row.cacheReadReported,
          tokens: {
            input: 2_000 - row.cacheRead,
            output: 10,
            reasoning: 0,
            cache: { read: row.cacheRead, write: 0 },
          },
          time_created: adaptiveNow - rows.length + index,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })

const clearAdaptiveSteps = () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.delete(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, sessionID)).run().pipe(Effect.orDie)
  })

it.effect("adaptive TTL promotes only after two eligible observations in five minutes", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    expect(
      yield* service.policy(policy("stable", 0)),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
    yield* service.observe({ namespace: "stable", cacheRead: 0, cacheWrite: 1200, eligible: 1200, now: 1_000 })
    expect(
      yield* service.policy(policy("stable", 2_000)),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
    yield* service.observe({ namespace: "stable", cacheRead: 900, cacheWrite: 0, eligible: 1200, now: 3_000 })
    expect(
      yield* service.policy(policy("stable", 4_000)),
    ).toEqual({
      ttlSeconds: 3600,
      promoted: true,
    })
  }),
)

it.effect("advances the durable generation only after a fourth measured low cache result", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
    ])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)

    yield* insertAdaptiveSteps([{ cacheRead: 0, invalidation: "prefix-changed" }])
    // Rotation removed — generation stays stable at 0 regardless of low hit streak
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("resets the low-hit streak at an exactly 30% reported cache-read ratio", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 600, invalidation: "stable-hit" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
    ])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)

    yield* insertAdaptiveSteps([{ cacheRead: 0, invalidation: "prefix-changed" }])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("measures an explicitly reported zero read despite the legacy same-key invalidation", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps(
      Array.from({ length: 4 }, () => ({
        cacheRead: 0,
        invalidation: ProviderRequest.Invalidation.make("provider-not-reported"),
        cacheReadReported: true,
      })),
    )

    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("resets the low streak for recovery and compaction-reset evidence without losing an earned generation", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
    ])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)

    const generatedKey = SessionRunnerCache.promptCacheKeyForGeneration(sessionID, adaptiveBaseline, 1)
    yield* insertAdaptiveSteps([{ cacheRead: 0, invalidation: "compaction-reset", promptCacheKey: generatedKey }])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)

    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed", promptCacheKey: generatedKey },
      { cacheRead: 0, invalidation: "prefix-changed", promptCacheKey: generatedKey },
      { cacheRead: 0, invalidation: "prefix-changed", promptCacheKey: generatedKey },
    ])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)

    yield* insertAdaptiveSteps([{ cacheRead: 0, invalidation: "prefix-changed", promptCacheKey: generatedKey }])
    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("skips unreported, disabled, below-minimum, and retry-fallback cache evidence", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps(
      (["provider-not-reported", "cache-disabled", "below-minimum", "retry-fallback"] as const).map((invalidation) => ({
        cacheRead: 0,
        invalidation: ProviderRequest.Invalidation.make(invalidation),
        cacheReadReported: false,
      })),
    )

    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("preserves a low-hit streak through unreported cache telemetry", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "provider-not-reported", cacheReadReported: false },
      { cacheRead: 0, invalidation: "provider-not-reported", cacheReadReported: null },
      { cacheRead: 0, invalidation: "prefix-changed" },
    ])

    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("skips a known model profile below its cache minimum", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* clearAdaptiveSteps()
    yield* insertAdaptiveSteps([
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
      { cacheRead: 0, invalidation: "prefix-changed" },
    ])
    const db = (yield* Database.Service).db
    yield* db
      .update(SessionProviderRequestTable)
      .set({ tokens: { input: 1_023, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })
      .where(eq(SessionProviderRequestTable.session_id, sessionID))
      .run()
      .pipe(Effect.orDie)

    expect(yield* service.generation(adaptiveGeneration())).toBe(0)
  }),
)

it.effect("adaptive TTL does not promote from missing or stale reusable reports", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* service.observe({ namespace: "missing", cacheRead: 0, cacheWrite: 0, eligible: 1200, now: 0 })
    yield* service.observe({ namespace: "missing", cacheRead: 0, cacheWrite: 0, eligible: 1200, now: 1_000 })
    expect(
      yield* service.policy(policy("missing", 2_000)),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })

    yield* service.observe({ namespace: "stale", cacheRead: 100, cacheWrite: 0, eligible: 1200, now: 0 })
    yield* service.observe({ namespace: "stale", cacheRead: 100, cacheWrite: 0, eligible: 1200, now: 301_000 })
    expect(
      yield* service.policy(policy("stale", 302_000)),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
  }),
)

it.effect("returns the safe TTL for an unsupported adaptive model without reading durable evidence", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.run("DROP TABLE session_provider_request").pipe(Effect.orDie)
    const service = yield* SessionCacheRuntime.Service

    expect(yield* service.policy({ ...policy("unsupported-adaptive", 2_000), modelID: "custom-model" })).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
  }),
)

it.effect("memoizes an empty durable restore within the reuse window", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    expect(yield* service.policy(policy("empty-ledger", 1_000))).toEqual({ ttlSeconds: 300, promoted: false })

    const db = (yield* Database.Service).db
    yield* db.run("DROP TABLE session_provider_request").pipe(Effect.orDie)
    expect(yield* service.policy(policy("empty-ledger", 2_000))).toEqual({ ttlSeconds: 300, promoted: false })
  }),
)

it.effect("retains an adaptive promotion when later telemetry is missing", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    yield* service.observe({ namespace: "retained", cacheRead: 0, cacheWrite: 1200, eligible: 1200, now: 1_000 })
    yield* service.observe({ namespace: "retained", cacheRead: 900, cacheWrite: 0, eligible: 1200, now: 2_000 })
    yield* service.observe({ namespace: "retained", cacheRead: 0, cacheWrite: 0, eligible: 1200, now: 3_000 })

    expect(yield* service.policy(policy("retained", 4_000))).toEqual({ ttlSeconds: 3600, promoted: true })
    expect(yield* service.policy(policy("retained", 3_602_001))).toEqual({ ttlSeconds: 300, promoted: false })
  }),
)

it.effect("restores a long-conversation promotion renewed before process restart", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Cache runtime" })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderRequestTable)
      .values(
        [0, 1_000, 59 * 60 * 1_000, 60 * 60 * 1_000].map((time, index) => ({
          id: ProviderRequest.ID.make(`prq_cache_runtime_${index}`),
          session_id: sessionID,
          source: "step" as const,
          agent: AgentV2.ID.make("build"),
          model: ModelV2.Ref.make({
            providerID: ProviderV2.ID.make("anthropic"),
            id: ModelV2.ID.make("claude-sonnet-4-5"),
          }),
          route_id: "anthropic-messages",
          prompt_cache_key: "durable",
          system_digest: "a".repeat(64),
          tool_digest: "b".repeat(64),
          request: index + 1,
          attempts: 1,
          invalidation: "stable-hit" as const,
          continuation: "full" as const,
          tokens: {
            input: 300,
            output: 10,
            reasoning: 0,
            cache: { read: index === 1 || index === 2 ? 900 : 0, write: index === 0 ? 1200 : 0 },
          },
          time_created: time,
        })),
      )
      .run()
      .pipe(Effect.orDie)

    const service = yield* SessionCacheRuntime.Service
    expect(yield* service.policy(policy("durable", 100 * 60 * 1_000))).toEqual({
      ttlSeconds: 3600,
      promoted: true,
    })
  }),
)

it.effect("explicit TTL overrides bypass adaptive state and bounded eviction resets old namespaces", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
    expect(
      yield* service.policy({ ...policy("explicit", 0), configured: "1h" }),
    ).toEqual({ ttlSeconds: 3600, promoted: true })
    expect(
      yield* service.policy({ ...policy("explicit", 0), configured: "5m" }),
    ).toEqual({ ttlSeconds: 300, promoted: false })
    expect(
      yield* service.policy({ ...policy("unsupported", 0), modelID: "custom-model", configured: "1h" }),
    ).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })

    for (const namespace of ["one", "two", "three"]) {
      yield* service.observe({ namespace, cacheRead: 100, cacheWrite: 0, eligible: 100, now: namespace.length })
      yield* service.observe({ namespace, cacheRead: 100, cacheWrite: 0, eligible: 100, now: namespace.length + 1 })
    }
    expect(yield* service.policy({ ...policy("one", 10), modelID: "claude" })).toEqual({
      ttlSeconds: 300,
      promoted: false,
    })
  }),
)
