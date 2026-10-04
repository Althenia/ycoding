import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequestTable, SessionTable, SessionUsageTable } from "@ycoding-ai/core/session/sql"
import { SessionUsageCleanup } from "@ycoding-ai/core/session/usage-cleanup"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { testEffect } from "./lib/effect"

const active = new Set<Session.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => active),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node, SessionUsageCleanup.node]),
    [[SessionExecution.node, execution]],
  ),
)

const now = 31 * 24 * 60 * 60 * 1000
const stale = now - 30 * 24 * 60 * 60 * 1000 - 1
const recent = now - 30 * 24 * 60 * 60 * 1000
const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("gpt-5.6"), providerID: Provider.ID.make("openai") })

const insert = (id: Session.ID, timeUpdated = stale) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id, project_id: Project.ID.global, directory: "/project", title: id, time_updated: timeUpdated })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderRequestTable)
      .values({
        id: ProviderRequest.ID.make(`prq_${id}`),
        session_id: id,
        source: "step",
        agent: Agent.ID.make("build"),
        model,
        route_id: "openai-responses",
        prompt_cache_key: "cache-key",
        system_digest: "system",
        tool_digest: "tools",
        request: 1,
        attempts: 1,
        invalidation: "first-request",
        continuation: "full",
        cost: 0.01,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time_created: timeUpdated,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionUsageTable)
      .values({
        session_id: id,
        model_key: '["openai","gpt-5.6",null]',
        model,
        logical: 1,
        physical: 1,
        helpers: 0,
        continued: 0,
        fallback: 0,
        cost: 0.01,
        input: 1,
        output: 1,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
      })
      .run()
      .pipe(Effect.orDie)
  })

const counts = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return {
      raw: (yield* db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, sessionID)).all().pipe(Effect.orDie)).length,
      aggregate: (yield* db.select().from(SessionUsageTable).where(eq(SessionUsageTable.session_id, sessionID)).all().pipe(Effect.orDie)).length,
    }
  })

describe("SessionUsageCleanup", () => {
  it.effect("prunes only stale inactive usage projections", () =>
    Effect.gen(function* () {
      // Let the startup cleanup suspend before inserting the retention-boundary fixtures.
      yield* TestClock.adjust(0)
      const staleID = Session.ID.make("ses_usage_stale")
      const recentID = Session.ID.make("ses_usage_recent")
      const activeID = Session.ID.make("ses_usage_active")
      yield* insert(staleID)
      yield* insert(recentID, recent)
      yield* insert(activeID)
      active.add(activeID)

      expect(yield* (yield* SessionUsageCleanup.Service).cleanup(now)).toBe(1)
      expect(yield* counts(staleID)).toEqual({ raw: 0, aggregate: 0 })
      expect(yield* counts(recentID)).toEqual({ raw: 1, aggregate: 1 })
      expect(yield* counts(activeID)).toEqual({ raw: 1, aggregate: 1 })
      active.clear()
    }),
  )
})
