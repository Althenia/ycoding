import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { Model } from "@ycoding-ai/schema/model"
import { ModelIncident } from "@ycoding-ai/schema/model-incident"
import { Provider } from "@ycoding-ai/schema/provider"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261016080907_model-incident"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { node, Service } from "../src/model-incident/index"
import { RetentionSettings } from "../src/retention-settings"

const columns = (db: EffectDrizzleSqlite.EffectSQLiteDatabase, table: string) =>
  db.all<{ name: string; type: string; notnull: number; pk: number }>(sql.raw(`PRAGMA table_info('${table}')`))

test("the migration creates exactly the incident and clear tables with their indexes, no foreign keys and no sensitive columns", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.make().pipe(Effect.provide(EffectDrizzleSqlite.DefaultServices))
      yield* DatabaseMigration.apply(db)
      expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${migration.id}`)).toEqual([{ id: migration.id }])

      expect((yield* columns(db, "model_incident")).map((column) => [column.name, column.type, column.notnull])).toEqual([
        ["id", "TEXT", 0],
        ["time_created", "INTEGER", 1],
        ["kind", "TEXT", 1],
        ["provider_id", "TEXT", 1],
        ["model_id", "TEXT", 1],
        ["variant", "TEXT", 0],
        ["profile", "TEXT", 0],
        ["agent", "TEXT", 1],
        ["project_id", "TEXT", 1],
        ["session_id", "TEXT", 1],
        ["request_id", "TEXT", 0],
        ["category", "TEXT", 1],
        ["rule_ids", "TEXT", 1],
        ["target", "TEXT", 0],
        ["decided_by", "TEXT", 0],
      ])
      expect(
        (yield* columns(db, "model_guidance_clear")).map((column) => [column.name, column.type, column.notnull, column.pk]),
      ).toEqual([
        ["provider_id", "TEXT", 1, 1],
        ["model_id", "TEXT", 1, 2],
        ["cleared_at", "INTEGER", 1, 0],
      ])

      for (const table of ["model_incident", "model_guidance_clear"])
        expect(yield* db.all(sql.raw(`PRAGMA foreign_key_list('${table}')`))).toEqual([])
      const indexes = yield* db.all<{ name: string }>(sql`PRAGMA index_list('model_incident')`)
      const keyed = yield* Effect.forEach(
        indexes.filter((index) => index.name.startsWith("model_incident_")),
        (index) =>
          db
            .all<{ name: string }>(sql.raw(`PRAGMA index_info('${index.name}')`))
            .pipe(Effect.map((info) => [index.name, info.map((column) => column.name)] as const)),
      )
      expect(keyed.toSorted(([left], [right]) => left.localeCompare(right))).toEqual([
        ["model_incident_model_time_idx", ["provider_id", "model_id", "time_created"]],
        ["model_incident_request_id_idx", ["request_id"]],
        ["model_incident_time_created_id_idx", ["time_created", "id"]],
      ])

      yield* db.run("DROP TABLE model_incident")
      yield* db.run("DROP TABLE model_guidance_clear")
      yield* db.transaction(migration.up)
      expect((yield* columns(db, "model_incident")).length).toBe(15)
    }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped),
  ), 30_000)

test("Core report, recent and guidance results satisfy the Schema contract", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const incidents = yield* Service
      for (const [index, kind] of (["fallback", "guardrail-escalated", "guardrail-rejected"] as const).entries())
        yield* database.db.run(sql`
          INSERT INTO model_incident (id, time_created, kind, provider_id, model_id, variant, agent, project_id, session_id, request_id, category, rule_ids, target, decided_by)
          VALUES (${ModelIncident.ID.create()}, ${1_000 + index}, ${kind}, 'p', 'm', 'high', 'build', 'global', 'ses_gone', ${`req_${index}`}, 'ordinary',
            '["standard.review.outside-repo"]', ${kind === "fallback" ? '{"providerID":"q","id":"n"}' : null}, ${kind === "guardrail-rejected" ? "human" : null})
        `)
      const query = { provider: Provider.ID.make("p"), model: Model.ID.make("m") }
      for (const group of ["model", "agent"] as const) {
        const report = yield* incidents.report({ group })
        expect(Schema.decodeUnknownSync(ModelIncident.Report)(report)).toEqual(report)
      }
      const recent = yield* incidents.recent(query)
      expect(recent.items).toHaveLength(3)
      expect(Schema.decodeUnknownSync(ModelIncident.Recent)(recent)).toEqual(recent)
      for (const enabled of [true, false]) {
        const guidance = yield* incidents.guidance(query, enabled)
        expect(Schema.decodeUnknownSync(ModelIncident.Guidance)(guidance)).toEqual(guidance)
      }
      yield* incidents.clear(query)
      const cleared = yield* incidents.guidance(query, true)
      expect(Schema.decodeUnknownSync(ModelIncident.Guidance)(cleared)).toEqual(cleared)
      expect(cleared.clearedAt).toBeGreaterThan(0)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, node]), [
          [
            RetentionSettings.node,
            Layer.succeed(RetentionSettings.Service, {
              read: () => Effect.succeed({ recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 }),
            }),
          ],
        ]),
      ),
      Effect.scoped,
    ),
  ))
