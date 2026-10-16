import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageAnalyticsRequestTable } from "../src/usage-analytics.sql"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { AbsolutePath } from "@ycoding-ai/schema/schema"
import { Money } from "@ycoding-ai/schema/money"
import { SessionUsageRead } from "../src/session/usage-read"
import { tmpdir } from "node:os"

const runtime = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, Session.node, UsageAnalytics.node]),
  [[SessionExecution.node, SessionExecution.noopLayer]],
)

test("one recorded request projects immutable analytics once and family deletion preserves backend accounting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const events = yield* EventRuntime.Service
      const database = yield* Database.Service
      const root = yield* sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) } })
      const child = yield* sessions.create({ parentID: root.id })
      for (const [index, session] of [root, child].entries()) {
        const record = {
          id: ProviderRequest.ID.make(`prq_analytics_${index}`),
          sessionID: session.id,
          source: "step" as const,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ providerID: Provider.ID.make("p"), id: Model.ID.make("m") }),
          routeID: "route",
          promptCacheKey: "namespace",
          systemDigest: "system",
          toolDigest: "tools",
          request: 1,
          attempts: 2,
          invalidation: "first-request" as const,
          continuation: "full" as const,
          cost: Money.USD.make(index),
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          time: DateTime.makeUnsafe(Date.now()),
        }
        yield* events.publish(SessionEvent.ProviderRequestRecorded, record)
        yield* events.publish(SessionEvent.ProviderRequestRecorded, record)
      }
      expect(
        (yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM session_provider_request`))?.count,
      ).toBe(2)
      expect(yield* database.db.select().from(UsageAnalyticsRequestTable).all()).toHaveLength(2)
      const before = yield* sessions.usageAll()
      const report = yield* sessions.usageReportAll({ group: "model" })
      yield* database.db.run(sql`UPDATE session SET directory = '/moved' WHERE id = ${root.id}`)
      const bins = yield* SessionUsageRead.localUsage(database, {
        from: Date.now() - 3_600_000,
        to: Date.now() + 1,
        scope: {
          type: "location",
          location: root.location,
        },
      })
      expect(bins.reduce((sum, bin) => sum + bin.requests, 0)).toBe(2)
      yield* sessions.remove(root.id)
      expect(
        (yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM session_provider_request`))?.count,
      ).toBe(0)
      expect(yield* sessions.usageAll()).toEqual(before)
      expect(yield* sessions.usageReportAll({ group: "model" })).toEqual(report)
    }).pipe(Effect.provide(runtime), Effect.scoped),
  ))

test("analytics sweep keeps exactly thirty days and deletes older facts in bounded batches", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const analytics = yield* UsageAnalytics.Service
      const now = Date.now()
      const boundary = now - 30 * 86_400_000
      yield* database.db.run(sql`
      WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 1004)
      INSERT INTO usage_analytics_request
        (id, session_id, project_id, directory, session_updated, agent, source, model, task_path, request, attempts, continuation, invalidation, prompt_cache_key, tokens, time_created)
      SELECT printf('prq_sweep_%09d', value), 'ses_deleted', 'global', '/deleted', 0, 'build', 'step', '{"providerID":"p","id":"m"}', '[]',
        value + 1, 1, 'full', 'first-request', 'cache', '{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',
        CASE WHEN value = 1004 THEN ${boundary} ELSE ${boundary - 1} END FROM n
    `)
      expect(yield* analytics.cleanup(now)).toBe(1004)
      expect(
        (yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_analytics_request`))?.count,
      ).toBe(1)
      expect(yield* analytics.cleanup(now)).toBe(0)
    }).pipe(Effect.provide(runtime), Effect.scoped),
  ))
