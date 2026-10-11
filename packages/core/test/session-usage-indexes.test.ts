import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"

const queries = [
  {
    name: "session list newest first",
    sql: `SELECT * FROM session ORDER BY time_updated DESC, id DESC LIMIT 50`,
    index: "session_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list oldest first",
    sql: `SELECT * FROM session ORDER BY time_updated ASC, id ASC`,
    index: "session_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list by project",
    sql: `SELECT * FROM session WHERE project_id = 'p0' ORDER BY time_updated DESC, id DESC LIMIT 50`,
    index: "session_project_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list by parent",
    sql: `SELECT * FROM session WHERE parent_id = 'ses_0' ORDER BY time_updated DESC, id DESC`,
    index: "session_parent_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list roots",
    sql: `SELECT * FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT 50`,
    index: "session_parent_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list by workspace",
    sql: `SELECT * FROM session WHERE workspace_id = 'ws_0' ORDER BY time_updated DESC, id DESC LIMIT 50`,
    index: "session_workspace_time_updated_id_idx",
    sort: false,
  },
  {
    name: "session list by directory",
    sql: `SELECT * FROM session WHERE directory = '/d/0' ORDER BY time_updated DESC, id DESC LIMIT 50`,
    index: "session_directory_time_updated_id_idx",
    sort: false,
  },
  {
    name: "usage cleanup by age",
    sql: `SELECT id FROM session WHERE time_updated < 1000`,
    index: "session_time_updated_id_idx",
    sort: false,
  },
  {
    name: "local provider spend",
    sql: `SELECT model, cost, time_created FROM session_provider_request WHERE time_created >= 1000`,
    index: "session_provider_request_time_created_idx",
    sort: false,
  },
  {
    name: "usage report time range",
    sql: `SELECT * FROM session_provider_request WHERE time_created >= 1000 AND time_created < 500000 ORDER BY session_id ASC, request ASC`,
    index: "session_provider_request_time_created_idx",
    sort: true,
  },
  {
    name: "ended compaction since previous request",
    sql: `SELECT id FROM session_compaction_job WHERE session_id = 'ses_0' AND status = 'ended' AND time_ended > 10 ORDER BY time_ended DESC LIMIT 1`,
    index: "session_compaction_job_session_ended_idx",
    sort: false,
  },
] as const

test("session listing, usage, and compaction reads use the added indexes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.apply(db)
      yield* db.run(
        `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('p0', '/d/0', '[]', 1, 1), ('p1', '/d/1', '[]', 1, 1), ('p2', '/d/2', '[]', 1, 1), ('p3', '/d/3', '[]', 1, 1)`,
      )
      const sessions: string[] = []
      const requests: string[] = []
      for (let i = 0; i < 400; i++) {
        const parent = i % 5 === 0 ? "NULL" : `'ses_${i - (i % 5)}'`
        sessions.push(
          `('ses_${i}', 'p${i % 4}', 'ws_${i % 3}', ${parent}, '/d/${i % 4}', 'Session ${i}', 0, 0, 0, 0, 0, 0, ${i}, ${1_000_000 - i})`,
        )
      }
      for (let session = 0; session < 80; session++) {
        for (let request = 1; request <= 30; request++) {
          requests.push(
            `('prq_${session}_${request}', 'ses_${session}', '${request % 4 === 0 ? "helper" : "step"}', 'build', '{"providerID":"openai","id":"gpt"}', 'route', 'cache', 'system', 'tools', ${request}, 1, 'none', 'none', ${session * 1000 + request}, '{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}')`,
          )
        }
      }
      yield* db.run(
        `INSERT INTO session (id, project_id, workspace_id, parent_id, directory, title, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES ${sessions.join(",")}`,
      )
      yield* db.run(
        `INSERT INTO session_provider_request (id, session_id, source, agent, model, route_id, prompt_cache_key, system_digest, tool_digest, request, attempts, invalidation, continuation, time_created, tokens) VALUES ${requests.join(",")}`,
      )
      yield* db.run(`ANALYZE`)
      for (const query of queries) {
        const plan = yield* db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`)
        const detail = plan.map((row) => row.detail).join("\n")
        expect(detail, query.name).toContain(query.index)
        expect(detail.includes("USE TEMP B-TREE"), query.name).toBe(query.sort)
      }
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ),
)
