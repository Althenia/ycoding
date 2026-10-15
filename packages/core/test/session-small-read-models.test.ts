import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionEvent } from "../src/session/event"
import { EventRuntime } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { SessionTable } from "../src/session/sql"
import { Skill } from "../src/skill"
import { Agent } from "../src/agent"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { Money } from "@ycoding-ai/schema/money"
import { sql } from "drizzle-orm"

const sessionID = SessionSchema.ID.make("ses_small_read_models")
const created = DateTime.makeUnsafe(0)
const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("gpt-5.6") })
const encode = Schema.encodeSync(SessionMessage.Info)

function run(
  effect: (
    store: SessionStore.Interface,
    db: Database.Interface["db"],
    queries: { sql: string; params: unknown[] }[],
  ) => Effect.Effect<void, unknown>,
) {
  const queries: { sql: string; params: unknown[] }[] = []
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (sql, params) =>
            Effect.sync(() => {
              queries.push({ sql, params })
            }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
      )
      yield* DatabaseMigration.apply(db)
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Read models" })
        .run()
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* SessionStore.Service
      yield* effect(store, db, queries)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, SessionStore.node]), [[Database.node, database]]),
      ),
      Effect.scoped,
    ),
  )
}

const insert = (db: Database.Interface["db"], seq: number, message: SessionMessage.Info) => Effect.gen(function* () {
  const { id, type, ...data } = encode(message)
  yield* db
    .run(
      sql`INSERT INTO session_message(id, type, data, seq, session_id, time_created, time_updated)
    VALUES (${id}, ${type}, ${JSON.stringify(data)}, ${seq}, ${sessionID}, 0, 0)`,
    )
    .pipe(Effect.orDie)
  const event = message.type === "assistant" && message.tokens ? {
    type: EventRuntime.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable.version),
    data: Schema.encodeSync(SessionEvent.Step.Ended.data)({ sessionID, assistantMessageID: message.id,
      finish: message.finish ?? "stop", cost: message.cost ?? Money.USD.zero, tokens: message.tokens }),
  } : message.type === "compaction" && message.status === "completed" && "reason" in message ? {
    type: EventRuntime.versionedType(SessionEvent.Compaction.EndedV1.type, SessionEvent.Compaction.EndedV1.durable.version),
    data: Schema.encodeSync(SessionEvent.Compaction.EndedV1.data)({ sessionID, reason: message.reason,
      text: message.summary, recent: message.recent }),
  } : undefined
  if (!event) return
  yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq })
    .onConflictDoUpdate({ target: EventSequenceTable.aggregate_id, set: { seq } }).run().pipe(Effect.orDie)
  yield* db.insert(EventTable).values({ id: EventRuntime.ID.make(`evt_read_${seq}`), aggregate_id: sessionID,
    seq, created: 0, type: event.type, data: event.data }).run().pipe(Effect.orDie)
})

async function readBytes(db: Database.Interface["db"], queries: { sql: string; params: unknown[] }[]) {
  const reads = queries.filter((query) => /\b(?:from|join) ["`]?session_message\b/i.test(query.sql))
  expect(reads.length).toBeGreaterThan(0)
  let bytes = 0
  for (const query of reads) {
    const rows = await Effect.runPromise(db.$client.unsafe(query.sql, query.params))
    bytes += JSON.stringify(rows).length
  }
  return bytes
}

test("skill statuses retain chronology without reading unrelated assistant payloads", () =>
  run((store, db, queries) =>
    Effect.gen(function* () {
      yield* insert(
        db,
        0,
        SessionMessage.Skill.make({
          id: SessionMessage.ID.make("msg_skill"),
          skill: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "guidance",
          time: { created },
        }),
      )
      yield* insert(
        db,
        1,
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_irrelevant"),
          agent: Agent.defaultID,
          model,
          content: [{ type: "text", text: "x".repeat(256_000) }],
          time: { created },
        }),
      )
      yield* insert(
        db,
        2,
        SessionMessage.AgentSelected.make({
          id: SessionMessage.ID.make("msg_switch"),
          agent: Agent.defaultID,
          time: { created },
        }),
      )
      queries.length = 0
      expect(yield* store.skills(sessionID)).toMatchObject([
        { id: "effect", content: "guidance", state: "inactive", inactiveReason: "agent_switched" },
      ])
      expect(yield* Effect.promise(() => readBytes(db, queries))).toBeLessThan(4_096)
    }),
  ))

test("diagnostics selects latest values and excludes assistant content", () =>
  run((store, db, queries) =>
    Effect.gen(function* () {
      const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } }
      yield* insert(
        db,
        0,
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_diagnostic"),
          agent: Agent.defaultID,
          model,
          tokens,
          cost: Money.USD.make(0.25),
          diagnostics: { contextLimit: 100 },
          content: [{ type: "text", text: "x".repeat(256_000) }],
          time: { created },
        }),
      )
      yield* insert(
        db,
        1,
        SessionMessage.User.make({ id: SessionMessage.ID.make("msg_boundary"), text: "boundary", time: { created } }),
      )
      queries.length = 0
      expect(yield* store.diagnostics(sessionID, SessionMessage.ID.make("msg_boundary"))).toMatchObject({
        context: { total: 20, limit: 100 },
        estimatedCost: 0.25,
      })
      expect(yield* Effect.promise(() => readBytes(db, queries))).toBeLessThan(4_096)
      expect(yield* store.diagnostics(sessionID, SessionMessage.ID.make("msg_missing"))).toBeUndefined()
    }),
  ))

test("diagnostics seeks each terminal type without scanning an active Step's event range", () =>
  run((store, db, queries) => Effect.gen(function* () {
    yield* insert(db, 0, SessionMessage.CompactionCompletedV1.make({
      id: SessionMessage.ID.make("msg_seek_compaction"), reason: "manual", summary: "summary", recent: "", time: { created },
    }))
    yield* insert(db, 1, SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_seek_active"), agent: Agent.defaultID, model, content: [], time: { created },
    }))
    for (let offset = 0; offset < 10_000; offset += 100)
      yield* db.insert(EventTable).values(Array.from({ length: 100 }, (_, index) => ({
        id: EventRuntime.ID.make(`evt_seek_${offset + index}`), aggregate_id: sessionID, seq: offset + index + 2,
        created: 0, type: EventRuntime.versionedType(SessionEvent.Text.Ended.type, SessionEvent.Text.Ended.durable.version),
        data: { sessionID, assistantMessageID: "msg_seek_active", ordinal: offset + index, text: "output" },
      }))).run().pipe(Effect.orDie)
    yield* insert(db, 10_002, SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_seek_boundary"), text: "boundary", time: { created },
    }))
    queries.length = 0
    expect(yield* store.diagnostics(sessionID, SessionMessage.ID.make("msg_seek_boundary"))).toBeUndefined()
    const query = queries.find((entry) => entry.sql.includes("json_patch"))
    expect(query).toBeDefined()
    const plan = yield* db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query!.sql}`, query!.params)
    expect(plan.filter((row) => row.detail.includes("event_aggregate_type_seq_idx") &&
      row.detail.includes("aggregate_id=? AND type=? AND seq>? AND seq<?"))).toHaveLength(2)
    expect(plan.filter((row) => row.detail.includes("event_aggregate_seq_idx"))).toHaveLength(0)
  })),
)

test("diagnostics preserves absent optional values, completed compactions and revert boundaries", () =>
  run((store, db) =>
    Effect.gen(function* () {
      const tokens = { input: 7, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
      const assistant = (id: string, withTokens = true) =>
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make(id),
          agent: Agent.defaultID,
          model,
          content: [],
          ...(withTokens ? { tokens } : {}),
          time: { created },
        })
      yield* insert(db, 0, assistant("msg_before"))
      expect(yield* store.diagnostics(sessionID)).toMatchObject({ context: { total: 8 }, estimatedCost: 0 })
      yield* insert(
        db,
        1,
        SessionMessage.CompactionCompletedV1.make({
          id: SessionMessage.ID.make("msg_compaction"),
          reason: "manual",
          summary: "summary",
          recent: "recent",
          time: { created },
        }),
      )
      expect(yield* store.diagnostics(sessionID)).toBeUndefined()
      expect(yield* store.diagnostics(sessionID, SessionMessage.ID.make("msg_before"))).toBeUndefined()
      yield* insert(db, 2, assistant("msg_after"))
      yield* insert(db, 3, assistant("msg_without_tokens", false))
      expect(yield* store.diagnostics(sessionID)).toMatchObject({ context: { total: 8 }, estimatedCost: 0 })
      expect(yield* store.diagnostics(sessionID, SessionMessage.ID.make("msg_after"))).toBeUndefined()
    }),
  ))

test("skill projection folds paged activations, tool snapshots, duplicates and explicit deactivations", () =>
  run((store, db) =>
    Effect.gen(function* () {
      for (let index = 0; index < 201; index += 1)
        yield* insert(
          db,
          index,
          SessionMessage.Skill.make({
            id: SessionMessage.ID.make(`msg_skill_${index}`),
            skill: Skill.ID.make(`skill-${index}`),
            name: Skill.Name.make(`Skill ${index}`),
            text: "guidance",
            time: { created },
          }),
        )
      const tool = (alreadyActive: boolean) =>
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: "call_skill",
          name: "skill",
          state: SessionMessage.ToolStateCompleted.make({
            input: { id: "tool-skill" },
            content: [{ type: "text", text: "x".repeat(256_000) }],
            structured: {
              name: "Tool skill",
              directory: "/skills",
              output: alreadyActive ? "duplicate" : "tool guidance",
              alreadyActive,
            },
          }),
          time: { created },
        })
      yield* insert(
        db,
        201,
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_tool_skill"),
          agent: Agent.defaultID,
          model,
          content: [tool(false)],
          time: { created },
        }),
      )
      yield* insert(
        db,
        202,
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_duplicate"),
          agent: Agent.defaultID,
          model,
          content: [tool(true)],
          skillDeactivations: [{ skill: Skill.ID.make("skill-0"), reason: "conflict_resolved" }],
          time: { created },
        }),
      )
      const statuses = yield* store.skills(sessionID)
      expect(statuses).toHaveLength(202)
      expect(statuses.find((status) => status.id === "skill-0")).toMatchObject({
        state: "inactive",
        inactiveReason: "conflict_resolved",
      })
      expect(statuses.find((status) => status.id === "tool-skill")).toMatchObject({
        content: "tool guidance",
        activationMessageID: "msg_tool_skill",
        state: "active",
      })
    }),
  ))
