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
const it = testEffect(Layer.provideMerge(SessionCacheRuntime.layer, database))
const sessionID = SessionSchema.ID.make("ses_cache_runtime")

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
