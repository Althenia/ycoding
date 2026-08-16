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

it.effect("adaptive TTL promotes only after two eligible observations in five minutes", () =>
  Effect.gen(function* () {
    const service = yield* SessionCacheRuntime.Service
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
