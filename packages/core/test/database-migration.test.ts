import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { DatabaseFormat } from "@ycoding-ai/core/database/format"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"
import previousSchema from "./fixture/database-current-2026-07-25"
import dropApplicationCache from "../src/database/migration/20260725062914_drop-application-cache"
import dropSessionArchived from "../src/database/migration/20260801114207_drop-session-archived"
import retireSelfImprovement from "../src/database/migration/20260726182810_retire-self-improvement"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const previousFormatID = "current-2026-07-25"
const previousMigrations = [
  { id: "20260725062914_drop-application-cache" },
  { id: "20260726004318_self-improvement-generation-failure" },
  { id: "20260726160111_agentic-project-artifacts" },
  { id: "20260726182810_retire-self-improvement" },
  { id: "20260727000736_observation-session-identity" },
  { id: "20260727001011_observation-sessionless-identity" },
  { id: "20260728025034_dusty_havok" },
  { id: "20260728084114_provider-request-optional-cost" },
  { id: "20260801114207_drop-session-archived" },
  { id: "20260803004514_session-file-change-ledger" },
  { id: "20260803011247_session-usage" },
]
const currentMigrations = [
  ...previousMigrations,
  { id: "20260804120956_selective-compaction-harness" },
  { id: "20260804123002_continuation-generation-fence" },
  { id: "20260804142728_session-authority-revisions" },
]
const selectiveCompactionTables = [
  "compaction_manifest_blob",
  "session_compaction_job",
  "session_context_exclusion",
  "session_context_revision",
  "session_context_state",
  "session_provider_continuation",
  "session_provider_state_blob",
  "session_provider_state_link",
  "session_todo_state",
]
const projectArtifactTables = [
  "project_artifact",
  "project_artifact_activation",
  "project_artifact_feedback",
  "project_artifact_global_scope",
  "project_artifact_legacy_cleanup",
  "project_artifact_observation",
  "project_artifact_operation",
  "project_artifact_project_scope",
  "project_artifact_scope",
  "project_artifact_terminal",
  "project_artifact_trash",
  "project_artifact_version",
  "project_artifact_write",
]
const legacySelfImprovementTables = [
  "self_improvement_approval",
  "self_improvement_approval_request",
  "self_improvement_artifact",
  "self_improvement_artifact_slot",
  "self_improvement_artifact_version",
  "self_improvement_audit_entry",
  "self_improvement_bandit_state",
  "self_improvement_context_desired_state",
  "self_improvement_context_outbox",
  "self_improvement_context_selection_evidence",
  "self_improvement_evaluation_baseline",
  "self_improvement_evaluation_decision",
  "self_improvement_evaluation_finding",
  "self_improvement_evaluation_run",
  "self_improvement_evaluation_sample",
  "self_improvement_evaluation_suite_revision",
  "self_improvement_generation_lease",
  "self_improvement_generation_strategy_arm",
  "self_improvement_idempotency",
  "self_improvement_model_route_arm",
  "self_improvement_observation",
  "self_improvement_pull_event",
  "self_improvement_reward_event",
  "self_improvement_rollback",
  "self_improvement_routing_decision",
  "self_improvement_session_evidence",
  "self_improvement_stage_transition",
]

function seedPreviousDatabase(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return Effect.gen(function* () {
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* previousSchema.up(tx)
        yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* Effect.forEach(previousMigrations, (migration) =>
          tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, 1)`),
        )
        yield* tx.run(sql`CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
        yield* tx.run(sql`INSERT INTO database_format (id, time_created) VALUES (${previousFormatID}, 1)`)
      }),
    )
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
  })
}

function seedSession(db: EffectDrizzleSqlite.EffectSQLiteDatabase, sessionID: string) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes)
      VALUES ('global', '/project', 1, 1, '[]')
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
      VALUES (${sessionID}, 'global', '/project', 'Migration fixture', 1, 1)
    `)
  })
}

function seedMessage(
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  input: { readonly id: string; readonly sessionID: string; readonly type: string; readonly seq: number; readonly data?: object },
) {
  return db.run(sql`
    INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (${input.id}, ${input.sessionID}, ${input.type}, ${input.seq}, 1, 1, ${JSON.stringify(input.data ?? {})})
  `)
}

function seedEvent(
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  input: { readonly id: string; readonly sessionID: string; readonly seq: number; readonly type: string; readonly data: object },
) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`INSERT OR REPLACE INTO event_sequence (aggregate_id, seq) VALUES (${input.sessionID}, ${input.seq})`,
    )
    yield* db.run(sql`
      INSERT INTO event (id, aggregate_id, seq, created, type, data)
      VALUES (${input.id}, ${input.sessionID}, ${input.seq}, 1, ${input.type}, ${JSON.stringify(input.data)})
    `)
  })
}

function applicationSchema(db: EffectDrizzleSqlite.EffectSQLiteDatabase) {
  return db
    .all<{ type: string; name: string; table_name: string; sql: string }>(sql`
      SELECT type, name, tbl_name AS table_name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND name NOT IN ('database_format', 'migration')
      ORDER BY type, name
    `)
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          ...row,
          sql: row.type === "table" ? normalizeTableSql(row.sql) : row.sql.replaceAll('"', "`"),
        })),
      ),
    )
}

function normalizeTableSql(sql: string) {
  const value = sql.replaceAll('"', "`").trim()
  const bodyStart = value.indexOf("(")
  const bodyEnd = value.lastIndexOf(")")
  if (bodyStart === -1 || bodyEnd < bodyStart) throw new Error(`Invalid CREATE TABLE statement: ${value}`)
  const suffix = normalizeSqlWhitespace(value.slice(bodyEnd + 1))
  return `${normalizeSqlWhitespace(value.slice(0, bodyStart))} (${splitTableDefinitions(value.slice(bodyStart + 1, bodyEnd))
    .map(normalizeSqlWhitespace)
    .toSorted()
    .join(", ")})${suffix ? ` ${suffix}` : ""}`
}

function splitTableDefinitions(value: string) {
  const definitions = new Array<string>()
  let start = 0
  let depth = 0
  let quote: "'" | "`" | undefined
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      if (character !== quote) continue
      if (value[index + 1] === quote) {
        index++
        continue
      }
      quote = undefined
      continue
    }
    if (character === "'" || character === "`") {
      quote = character
      continue
    }
    if (character === "(") {
      depth++
      continue
    }
    if (character === ")") {
      depth--
      continue
    }
    if (character !== "," || depth !== 0) continue
    definitions.push(value.slice(start, index))
    start = index + 1
  }
  if (quote || depth !== 0) throw new Error(`Invalid CREATE TABLE body: ${value}`)
  definitions.push(value.slice(start))
  return definitions
}

function normalizeSqlWhitespace(value: string) {
  let normalized = ""
  let pendingSpace = false
  let quote: "'" | "`" | undefined
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      normalized += character
      if (character !== quote) continue
      if (value[index + 1] === quote) {
        normalized += value[++index]
        continue
      }
      quote = undefined
      continue
    }
    if (character === "'" || character === "`") {
      if (pendingSpace && normalized) normalized += " "
      normalized += character
      pendingSpace = false
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      pendingSpace = true
      continue
    }
    if (pendingSpace && normalized) normalized += " "
    normalized += character
    pendingSpace = false
  }
  if (quote) throw new Error(`Invalid SQL: ${value}`)
  return normalized
}

describe("DatabaseMigration", () => {
  test("creates the current-only schema and format marker", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(DatabaseFormat.CurrentID).toBe("current-2026-08-04")
        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: DatabaseFormat.CurrentID })
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(currentMigrations)
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'compaction_manifest_blob',
              'session_compaction_job',
              'session_context_exclusion',
              'session_context_revision',
              'session_context_state',
              'session_provider_continuation',
              'session_provider_state_blob',
              'session_provider_state_link',
              'session_todo_state'
            )
            ORDER BY name
          `),
        ).toEqual(selectiveCompactionTables.map((name) => ({ name })))
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND (name = 'project_artifact' OR name LIKE 'project_artifact_%')
            ORDER BY name
          `),
        ).toEqual(projectArtifactTables.map((name) => ({ name })))
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type IN ('table', 'view')
              AND name IN ('session', 'session_pending', 'session_message')
            ORDER BY name
          `),
        ).toEqual([
          { name: "session" },
          { name: "session_message" },
          { name: "session_pending" },
        ])
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE name LIKE 'cache_%'
            ORDER BY name
          `),
        ).toEqual([])
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name IN ('message', 'part', '__drizzle_migrations')
            ORDER BY name
          `),
        ).toEqual([])

        const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session)`)).map((column) => column.name)
        expect(columns).toContain("permission")
        expect(columns).toContain("autonomy")
        for (const removed of [
          "slug",
          "version",
          "share_url",
          "summary_additions",
          "summary_deletions",
          "summary_files",
          "summary_diffs",
          "metadata",
          "time_compacting",
          "time_archived",
        ]) {
          expect(columns).not.toContain(removed)
        }
        expect(yield* db.get(sql`SELECT name, "notnull", dflt_value FROM pragma_table_info('credential') WHERE name = 'generation'`)).toEqual({
          name: "generation",
          notnull: 1,
          dflt_value: "0",
        })
        expect(
          yield* db.get(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND name = 'session_pending_session_compaction_idx'
          `),
        ).toBeUndefined()
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'self_improvement_%'
            ORDER BY name
          `),
        ).toEqual([])
      }),
    )
  })

  test("reopens a current database idempotently", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: DatabaseFormat.CurrentID })
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(currentMigrations)
      }),
    )
  })

  test("produces the same application schema from a fresh or previous-format database", async () => {
    const fresh = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        return yield* applicationSchema(db)
      }),
    )
    const upgraded = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* DatabaseMigration.apply(db)
        return yield* applicationSchema(db)
      }),
    )

    expect(upgraded).toEqual(fresh)
  })

  test("upgrades the immediately previous format without rewriting canonical rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* seedSession(db, "ses_upgrade")
        yield* seedMessage(db, {
          id: "msg_upgrade_boundary",
          sessionID: "ses_upgrade",
          type: "user",
          seq: 4,
          data: { text: "survives" },
        })
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_legacy_compaction', 'ses_upgrade', 'compaction', '{}', NULL, 5, 2)
        `)
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_pending_user', 'ses_upgrade', 'user', '{"text":"kept"}', 'queue', 6, 3)
        `)
        yield* db.run(sql`
          INSERT INTO credential (id, integration_id, label, value, time_created, time_updated)
          VALUES ('cred_legacy', 'test', 'legacy', '{"type":"key","key":"redacted"}', 1, 1)
        `)
        const canonicalMessage = yield* db.get(sql`SELECT * FROM session_message WHERE id = 'msg_upgrade_boundary'`)

        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: DatabaseFormat.CurrentID })
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(currentMigrations)
        expect(yield* db.get(sql`SELECT * FROM session_message WHERE id = 'msg_upgrade_boundary'`)).toEqual(
          canonicalMessage,
        )
        expect(yield* db.get(sql`SELECT status, revision, manifest_digest, error_code FROM session_context_state`)).toEqual({
          status: "active",
          revision: 0,
          manifest_digest: null,
          error_code: null,
        })
        expect(
          yield* db.get(sql`
            SELECT legacy_input_id, trigger, admission_mode, requested_through_message_id,
                   requested_through_seq, base_context_revision, target_max_input_tokens,
                   config_digest, status, attempts
            FROM session_compaction_job
          `),
        ).toEqual({
          legacy_input_id: "msg_legacy_compaction",
          trigger: "manual",
          admission_mode: "background",
          requested_through_message_id: "msg_upgrade_boundary",
          requested_through_seq: 4,
          base_context_revision: 0,
          target_max_input_tokens: null,
          config_digest: null,
          status: "pending",
          attempts: 0,
        })
        expect(yield* db.all(sql`SELECT id, type FROM session_pending ORDER BY admitted_seq`)).toEqual([
          { id: "msg_pending_user", type: "user" },
        ])
        expect(yield* db.get(sql`SELECT generation FROM credential WHERE id = 'cred_legacy'`)).toEqual({ generation: 0 })
        expect(
          yield* db.get(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name = 'session_pending_session_compaction_idx'
          `),
        ).toBeUndefined()
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`DELETE FROM session WHERE id = 'ses_upgrade'`)
        expect(yield* db.all(sql`SELECT id FROM session_compaction_job`)).toEqual([])
        expect(yield* db.all(sql`SELECT session_id FROM session_context_state`)).toEqual([])
        expect(yield* db.all(sql`SELECT session_id FROM session_context_revision`)).toEqual([])
      }),
    )
  })

  test("uses the latest valid legacy replacement as revision-zero provenance", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* seedSession(db, "ses_replaced")
        yield* seedMessage(db, {
          id: "msg_summary",
          sessionID: "ses_replaced",
          type: "compaction",
          seq: 7,
          data: { status: "completed", reason: "manual", summary: "summary", recent: "recent" },
        })
        yield* seedEvent(db, {
          id: "evt_replaced",
          sessionID: "ses_replaced",
          seq: 8,
          type: "session.compaction.replaced.1",
          data: {
            sessionID: "ses_replaced",
            summaryMessageID: "msg_summary",
            through: 7,
            summaryRevision: 1,
            deletedMessageCount: 4,
            remainingMessageCount: 1,
          },
        })
        const event = yield* db.get(sql`SELECT * FROM event WHERE id = 'evt_replaced'`)
        const message = yield* db.get(sql`SELECT * FROM session_message WHERE id = 'msg_summary'`)

        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.get(sql`
            SELECT status, revision, covered_through_message_id, covered_through_seq,
                   activated_event_id, time_activated, error_code
            FROM session_context_state
          `),
        ).toEqual({
          status: "active",
          revision: 0,
          covered_through_message_id: "msg_summary",
          covered_through_seq: 7,
          activated_event_id: "evt_replaced",
          time_activated: 1,
          error_code: null,
        })
        expect(yield* db.get(sql`SELECT * FROM event WHERE id = 'evt_replaced'`)).toEqual(event)
        expect(yield* db.get(sql`SELECT * FROM session_message WHERE id = 'msg_summary'`)).toEqual(message)
      }),
    )
  })

  test("falls back to the latest valid legacy ended checkpoint", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* seedSession(db, "ses_ended")
        yield* seedMessage(db, {
          id: "msg_ended",
          sessionID: "ses_ended",
          type: "compaction",
          seq: 3,
          data: { status: "completed", reason: "auto", summary: "summary", recent: "recent" },
        })
        yield* seedEvent(db, {
          id: "evt_ended",
          sessionID: "ses_ended",
          seq: 4,
          type: "session.compaction.ended.1",
          data: { sessionID: "ses_ended", reason: "auto", text: "summary", recent: "recent" },
        })

        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.get(sql`
            SELECT status, covered_through_message_id, covered_through_seq, activated_event_id, error_code
            FROM session_context_state
          `),
        ).toEqual({
          status: "active",
          covered_through_message_id: "msg_ended",
          covered_through_seq: 3,
          activated_event_id: "evt_ended",
          error_code: null,
        })
      }),
    )
  })

  test("quarantines malformed legacy lineage without deleting surviving history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* seedSession(db, "ses_quarantine")
        yield* seedMessage(db, {
          id: "msg_surviving",
          sessionID: "ses_quarantine",
          type: "user",
          seq: 2,
          data: { text: "survives" },
        })
        yield* seedEvent(db, {
          id: "evt_malformed",
          sessionID: "ses_quarantine",
          seq: 3,
          type: "session.compaction.replaced.1",
          data: {
            sessionID: "ses_quarantine",
            summaryMessageID: "msg_missing",
            through: 2,
            summaryRevision: 1,
            deletedMessageCount: 1,
            remainingMessageCount: 1,
          },
        })
        const events = yield* db.all(sql`SELECT * FROM event ORDER BY seq`)
        const messages = yield* db.all(sql`SELECT * FROM session_message ORDER BY seq`)

        yield* DatabaseMigration.apply(db)

        expect(
          yield* db.get(sql`
            SELECT status, revision, manifest_digest, covered_through_message_id,
                   covered_through_seq, activated_event_id, error_code
            FROM session_context_state
          `),
        ).toEqual({
          status: "quarantined",
          revision: 0,
          manifest_digest: null,
          covered_through_message_id: null,
          covered_through_seq: null,
          activated_event_id: null,
          error_code: "legacy_lineage_invalid",
        })
        expect(yield* db.all(sql`SELECT * FROM event ORDER BY seq`)).toEqual(events)
        expect(yield* db.all(sql`SELECT * FROM session_message ORDER BY seq`)).toEqual(messages)
      }),
    )
  })

  test("rolls back an upgrade when a legacy barrier has no recoverable boundary", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* seedSession(db, "ses_no_boundary")
        yield* db.run(sql`
          INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
          VALUES ('msg_no_boundary', 'ses_no_boundary', 'compaction', '{}', NULL, 1, 2)
        `)

        const exit = yield* Effect.exit(DatabaseMigration.apply(db))

        expect(String(exit)).toContain("legacy compaction barrier has no surviving message boundary")
        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: previousFormatID })
        expect(yield* db.get(sql`SELECT id FROM session_pending`)).toEqual({ id: "msg_no_boundary" })
        expect(
          yield* db.get(sql`
            SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_compaction_job'
          `),
        ).toBeUndefined()
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(credential)`)).map((column) => column.name),
        ).not.toContain("generation")
      }),
    )
  })

  test("rejects a stale previous marker after its one upgrade migration completed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* seedPreviousDatabase(db)
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`UPDATE database_format SET id = ${previousFormatID}`)

        const before = yield* db.all(sql`SELECT id, time_completed FROM migration ORDER BY id`)
        const exit = yield* Effect.exit(DatabaseMigration.apply(db))

        expect(String(exit)).toContain("DatabaseFormatUnsupportedError")
        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: previousFormatID })
        expect(yield* db.all(sql`SELECT id, time_completed FROM migration ORDER BY id`)).toEqual(before)
      }),
    )
  })

  test("drops every application cache table from an existing current-format database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        for (const name of [
          "cache_artifact_fts",
          "cache_artifact_chunk",
          "cache_artifact",
          "cache_edge",
          "cache_evidence",
          "cache_metric",
          "cache_observation",
          "cache_tombstone",
          "cache_validation",
        ])
          yield* db.run(sql.raw(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`))

        yield* DatabaseMigration.applyOnly(db, [dropApplicationCache])

        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE name LIKE 'cache_%'
            ORDER BY name
          `),
        ).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([
          { id: "20260725062914_drop-application-cache" },
        ])
      }),
    )
  })

  test("drops the session archive timestamp while retaining the remaining columns", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql.raw(
            `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, time_archived INTEGER, time_suspended INTEGER)`,
          ),
        )
        yield* db.run(sql`INSERT INTO session (id, title, time_archived) VALUES ('ses_1', 'kept', 1785584106948)`)

        yield* DatabaseMigration.applyOnly(db, [dropSessionArchived])
        yield* DatabaseMigration.applyOnly(db, [dropSessionArchived])

        const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session)`)).map((column) => column.name)
        expect(columns).toEqual(["id", "title", "time_suspended"])
        expect(yield* db.get(sql`SELECT id, title FROM session`)).toEqual({ id: "ses_1", title: "kept" })
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([
          { id: "20260801114207_drop-session-archived" },
        ])
      }),
    )
  })

  test("retires exactly the 27 legacy self-improvement tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* Effect.forEach(legacySelfImprovementTables, (name) =>
          db.run(sql.raw(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`)),
        )
        yield* db.run(sql`CREATE TABLE retained_current (id TEXT PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [retireSelfImprovement])
        yield* DatabaseMigration.applyOnly(db, [retireSelfImprovement])

        expect(legacySelfImprovementTables).toHaveLength(27)
        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'self_improvement_%'
            ORDER BY name
          `),
        ).toEqual([])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retained_current'`),
        ).toEqual({ name: "retained_current" })
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([
          { id: "20260726182810_retire-self-improvement" },
        ])
      }),
    )
  })

  test("retires legacy self-improvement tables that still hold referencing rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* Effect.forEach(
          legacySelfImprovementTables.filter(
            (name) => name !== "self_improvement_artifact_version" && name !== "self_improvement_stage_transition",
          ),
          (name) => db.run(sql.raw(`CREATE TABLE ${name} (id TEXT PRIMARY KEY)`)),
        )
        yield* db.run(
          sql.raw(
            `CREATE TABLE self_improvement_artifact_version (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES self_improvement_artifact(id))`,
          ),
        )
        yield* db.run(
          sql.raw(
            `CREATE TABLE self_improvement_stage_transition (id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES self_improvement_artifact_version(id))`,
          ),
        )
        yield* db.run(sql`INSERT INTO self_improvement_artifact (id) VALUES ('artifact')`)
        yield* db.run(sql`INSERT INTO self_improvement_artifact_version (id, artifact_id) VALUES ('v1', 'artifact')`)
        yield* db.run(sql`INSERT INTO self_improvement_stage_transition (id, version_id) VALUES ('t1', 'v1')`)

        yield* DatabaseMigration.applyOnly(db, [retireSelfImprovement])

        expect(
          yield* db.all<{ name: string }>(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'self_improvement_%'
            ORDER BY name
          `),
        ).toEqual([])
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("rejects a pre-current database without mutating it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE sentinel (value TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO sentinel (value) VALUES ('unchanged')`)

        const exit = yield* Effect.exit(DatabaseMigration.apply(db))

        expect(String(exit)).toContain("DatabaseFormatUnsupportedError")
        expect(String(exit)).toContain("unsupported pre-current format")
        expect(yield* db.get(sql`SELECT value FROM sentinel`)).toEqual({ value: "unchanged" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'database_format'`),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()
      }),
    )
  })

  test("rejects an unknown format marker without mutating it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO database_format (id, time_created) VALUES ('old', 1)`)
        yield* db.run(sql`CREATE TABLE sentinel (value TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO sentinel (value) VALUES ('unchanged')`)

        const exit = yield* Effect.exit(DatabaseMigration.apply(db))

        expect(String(exit)).toContain("DatabaseFormatUnsupportedError")
        expect(yield* db.get(sql`SELECT value FROM sentinel`)).toEqual({ value: "unchanged" })
        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: "old" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()
      }),
    )
  })

  test("applies future current-format migrations once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migration: DatabaseMigration.Migration = {
          id: "future",
          up: (tx) => tx.run(sql`CREATE TABLE future_current (id TEXT PRIMARY KEY)`),
        }

        yield* DatabaseMigration.applyOnly(db, [migration])
        yield* DatabaseMigration.applyOnly(db, [migration])

        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'future_current'`),
        ).toEqual({ name: "future_current" })
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "future" }])
      }),
    )
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layer({ path: filename }), Database.layer({ path: filename })]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })

  if (process.platform === "linux") {
    test("declared schema has no ungenerated changes", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }
})
