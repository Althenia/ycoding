import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { RetentionSettings } from "../src/retention-settings"
import { SessionExecution } from "../src/session/execution"
import { SessionUsageCleanup } from "../src/session/usage-cleanup"
import { SessionFileChangeCleanup } from "../src/session/file-change-cleanup"
import { SessionContextExclusionCleanup } from "../src/session/context-exclusion-cleanup"
import { UsageAnalytics } from "../src/usage-analytics"
import { TelemetryConsent } from "../src/telemetry-consent"
import { WebLatency } from "../src/web-latency"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { Session } from "../src/session"
import { testEffect } from "./lib/effect"

let recordsDays = 2
let usageDays = 2
const active = new Set([Session.ID.make("ses_boundary_active")])
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      SessionUsageCleanup.node,
      SessionFileChangeCleanup.node,
      SessionContextExclusionCleanup.node,
      UsageAnalytics.node,
    ]),
    [
      [
        RetentionSettings.node,
        Layer.succeed(RetentionSettings.Service, {
          read: () => Effect.succeed({ recordsDays, usageDays, latencyDays: 2, incidentDays: 30 }),
        }),
      ],
      [SessionExecution.node, Layer.mock(SessionExecution.Service, { active: Effect.succeed(active) })],
    ],
  ),
)

it.effect(
  "each Session record sweep reads its current configured period, keeps the exact boundary and active Sessions, and leaves analytics alone",
  () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(0)
      recordsDays = 2
      const db = (yield* Database.Service).db
      const now = 100 * 86_400_000
      yield* db.run(
        "INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('global','/boundary','[]',0,0)",
      )
      yield* db.run(
        sql`INSERT INTO compaction_manifest_blob (digest,schema_version,content,input_tokens,retained_tokens,time_created) VALUES (${"a".repeat(64)},1,'{}',1,0,0)`,
      )
      for (const [name, updated] of [
        ["expired", now - 2 * 86_400_000 - 1],
        ["exact", now - 2 * 86_400_000],
        ["recent", now - 86_400_000],
        ["active", now - 3 * 86_400_000],
      ] as const) {
        const id = `ses_boundary_${name}`
        yield* db.run(
          sql`INSERT INTO session (id,project_id,directory,title,time_created,time_updated) VALUES (${id},'global','/boundary','Boundary',${updated},${updated})`,
        )
        yield* db.run(sql`INSERT INTO session_context_revision (session_id,revision,time_created) VALUES (${id},0,0)`)
        yield* db.run(sql`INSERT INTO session_context_exclusion (session_id,context_revision,target_key,target_kind,target_selector,reason,manifest_digest)
        VALUES (${id},0,${"b".repeat(64)},'message','{"kind":"message","messageID":"msg_boundary","digest":"digest"}','exact_duplicate',${"a".repeat(64)})`)
        yield* db.run(
          sql`INSERT INTO session_file_change (session_id,path,patch,additions,deletions,latest_seq) VALUES (${id},'a','patch',1,0,0)`,
        )
        yield* db.run(sql`INSERT INTO session_provider_request
        (id,session_id,source,agent,model,route_id,prompt_cache_key,system_digest,tool_digest,request,attempts,invalidation,continuation,tokens,time_created)
        VALUES (${"prq_" + name},${id},'step','build','{"providerID":"p","id":"m"}','route','cache','system','tools',1,1,'first-request','full','{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',${updated})`)
      }
      yield* UsageAnalytics.backfill(db)
      const cleanups = [
        yield* SessionUsageCleanup.Service,
        yield* SessionFileChangeCleanup.Service,
        yield* SessionContextExclusionCleanup.Service,
      ]
      for (const cleanup of cleanups) expect(yield* cleanup.cleanup(now)).toBe(1)
      for (const table of ["session_provider_request", "session_file_change", "session_context_exclusion"]) {
        expect(
          (yield* db.all<{ id: string }>(sql.raw(`SELECT session_id AS id FROM ${table} ORDER BY session_id`))).map(
            (row) => row.id,
          ),
        ).toEqual(["ses_boundary_active", "ses_boundary_exact", "ses_boundary_recent"])
      }
      recordsDays = 1
      for (const cleanup of cleanups) expect(yield* cleanup.cleanup(now)).toBe(1)
      for (const table of ["session_provider_request", "session_file_change", "session_context_exclusion"]) {
        expect(
          (yield* db.all<{ id: string }>(sql.raw(`SELECT session_id AS id FROM ${table} ORDER BY session_id`))).map(
            (row) => row.id,
          ),
        ).toEqual(["ses_boundary_active", "ses_boundary_recent"])
      }
      expect(
        (yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_analytics_request`))?.count,
      ).toBe(4)
    }),
)

it.effect("analytics usage sweep applies the current configured request-date boundary", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust(0)
    usageDays = 2
    const db = (yield* Database.Service).db
    const now = 100 * 86_400_000
    for (const [index, at] of [now - 2 * 86_400_000 - 1, now - 2 * 86_400_000, now - 86_400_000].entries())
      yield* db.run(sql`INSERT INTO usage_analytics_request
        (id,session_id,project_id,directory,session_updated,agent,source,model,task_path,request,attempts,continuation,invalidation,prompt_cache_key,tokens,time_created)
        VALUES (${"prq_period_" + index},'ses_gone','global','/gone',0,'build','step','{"providerID":"p","id":"m"}','[]',1,1,'full','first-request','cache','{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',${at})`)
    const analytics = yield* UsageAnalytics.Service
    expect(yield* analytics.cleanup(now)).toBe(1)
    usageDays = 1
    expect(yield* analytics.cleanup(now)).toBe(1)
    expect((yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM usage_analytics_request`))?.count).toBe(
      1,
    )
  }),
)

it.effect("latency retention uses the configured receipt-date boundary", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const consent = yield* TelemetryConsent.make(db)
    yield* consent.set({ enabled: true, noticeVersion: 1 })
    const sample = Schema.decodeUnknownSync(Telemetry.Sample)({
      kind: "long-task",
      at: "2026-10-15T00:00:00.000Z",
      durationMs: 70,
    })
    yield* WebLatency.append(db, [sample], 2)
    yield* TestClock.adjust("2 days")
    expect((yield* WebLatency.list(db, {}, 2)).data).toHaveLength(1)
    yield* TestClock.adjust("1 millis")
    expect((yield* WebLatency.list(db, {}, 2)).data).toHaveLength(0)
  }),
)
