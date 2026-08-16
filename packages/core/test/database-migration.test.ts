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
import dropApplicationCache from "../src/database/migration/20260725062914_drop-application-cache"
import dropSessionArchived from "../src/database/migration/20260801114207_drop-session-archived"
import retireSelfImprovement from "../src/database/migration/20260726182810_retire-self-improvement"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const migrations = [
  { id: "20260725062914_drop-application-cache" },
  { id: "20260726004318_self-improvement-generation-failure" },
  { id: "20260726160111_agentic-project-artifacts" },
  { id: "20260726182810_retire-self-improvement" },
  { id: "20260727000736_observation-session-identity" },
  { id: "20260727001011_observation-sessionless-identity" },
  { id: "20260728025034_dusty_havok" },
  { id: "20260728084114_provider-request-optional-cost" },
  { id: "20260801114207_drop-session-archived" },
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

describe("DatabaseMigration", () => {
  test("creates the current-only schema and format marker", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT id FROM database_format`)).toEqual({ id: DatabaseFormat.CurrentID })
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(migrations)
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
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual(migrations)
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
