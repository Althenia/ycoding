import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Database } from "@ycoding-ai/core/database/database"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { sqliteLayer } from "@ycoding-ai/core/database/sqlite.bun"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionDecisions } from "@ycoding-ai/core/session/decisions"
import { testEffect } from "./lib/effect"

const queries: { sql: string; params: unknown[] }[] = []
const database = Layer.effect(Database.Service, Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.make().pipe(
    Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
      logQuery: (sql, params) => Effect.sync(() => { queries.push({ sql, params }) }),
    }),
    Effect.provide(EffectDrizzleSqlite.DefaultServices),
  )
  yield* db.run("PRAGMA foreign_keys = ON")
  yield* DatabaseMigration.apply(db)
  return { db }
})).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))

const loadedDirectory = AbsolutePath.make("/synthetic/loaded")
const permissions: Permission.Request[] = [
  ["per_alpha", "ses_alpha"], ["per_archived", "ses_archived"], ["per_missing", "ses_missing"], ["per_idle", "ses_idle_3"],
].map(([id, sessionID]) => ({
  id: Permission.ID.make(id!), sessionID: Session.ID.make(sessionID!), action: "edit", resources: ["file.txt"], save: [], metadata: {},
}))
const forms: Form.Info[] = [{
  id: Form.ID.make("frm_global"), sessionID: "global" as Session.ID, title: "Global form",
  fields: [{ key: "email", type: "string", required: true }],
}]
const locations = Layer.effect(LocationServiceMap.Service, Effect.gen(function* () {
  const context = yield* Layer.build(Layer.mergeAll(
    Layer.mock(Permission.Service, { list: () => Effect.succeed(permissions) }),
    Layer.mock(Form.Service, { list: () => Effect.succeed(forms) }),
  ))
  return LocationServiceMap.Service.of({
    loaded: () => Effect.succeed([{ ref: { directory: loadedDirectory }, built: [Permission.node.name, Form.node.name] }]),
    get: () => { throw new Error("get must not boot a Location") },
    invalidate: () => Effect.void,
    contextEffect: () => Effect.sync(() => Context.makeUnsafe(context.mapUnsafe)),
  })
}))
const it = testEffect(Layer.mergeAll(database, SessionDecisions.layer.pipe(Layer.provide(locations), Layer.provide(database)))
  .pipe(Layer.provideMerge(database)))

const deferredType = "session.review.deferred.1"
const decidedType = "session.review.decided.1"
const withdrawnType = "session.review.withdrawn.1"
const consumedType = "session.review.consumed.1"
const deferral = (sessionID: string, itemID: unknown, text?: string) => ({
  sessionID, itemID, kind: "subagent_question", reason: "sleep_entry", origin: { questionID: "qst_synthetic" },
  payload: text === undefined ? { type: "subagent_question" } : { type: "subagent_question", text },
})

it.effect("lists exact open decisions while reading only candidate Session metadata and open review payloads", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const decisions = yield* SessionDecisions.Service
    const sessions: [string, string, string, number | null][] = [
      ["ses_alpha", "Alpha", "/alpha", null],
      ["ses_archived", "Archived", "/archived", 1],
      ["ses_beta", "Beta", "/beta", null],
      ...Array.from({ length: 24 }, (_, index): [string, string, string, number | null] => [`ses_idle_${index}`, `Idle ${index}`, "/idle", null]),
      ...Array.from({ length: 12 }, (_, index): [string, string, string, number | null] => [`ses_closed_${index}`, `Closed ${index}`, "/closed", null]),
    ]
    yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`)
    for (const [id, title, directory, archived] of sessions)
      yield* db.run(sql`INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
        VALUES (${id}, 'global', ${directory}, ${title}, 1, 1, ${archived})`)
    const seqs = new Map<string, number>()
    const event = (sessionID: string, type: string, data: unknown) => Effect.gen(function* () {
      const seq = (seqs.get(sessionID) ?? 0) + 1
      seqs.set(sessionID, seq)
      if (seq === 1) yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES (${sessionID}, 0)`)
      yield* db.run(sql`UPDATE event_sequence SET seq = ${seq} WHERE aggregate_id = ${sessionID}`)
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES (${`evt_${sessionID}_${seq}`}, ${sessionID}, ${seq}, ${seq}, ${type}, ${JSON.stringify(data)})`)
    })
    const alpha = "ses_alpha"
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a1", "open a1"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a2", "closed-payload a2"))
    yield* event(alpha, decidedType, { sessionID: alpha, itemID: "rvw_a2", decision: { kind: "subagent_question", text: "done" } })
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a3", "closed-payload a3"))
    yield* event(alpha, withdrawnType, { sessionID: alpha, itemID: "rvw_a3", reason: "task_closed" })
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a4", "open a4"))
    yield* event(alpha, decidedType, { sessionID: alpha, itemID: "rvw_a4", decision: { kind: "bogus" } })
    yield* event(alpha, decidedType, { sessionID: alpha, itemID: "rvw_a5", decision: { kind: "subagent_question", text: "early" } })
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a5", "open a5"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a6", "first a6"))
    yield* event(alpha, decidedType, { sessionID: alpha, itemID: "rvw_a6", decision: { kind: "subagent_question", text: "done" } })
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a6", "second a6"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a7"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a8", "valid a8"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a8"))
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a9", "open a9"))
    yield* event(alpha, consumedType, { sessionID: alpha, itemID: "rvw_a9" })
    yield* event(alpha, deferredType, deferral(alpha, "rvw_a0", "open a0"))
    yield* event(alpha, withdrawnType, { sessionID: alpha, itemID: "rvw_a0", reason: "bogus" })
    yield* event(alpha, deferredType, deferral(alpha, 42, "numeric id"))
    yield* event("ses_archived", deferredType, deferral("ses_archived", "rvw_b1", "archived b1"))
    yield* event("ses_beta", deferredType, deferral("ses_beta", "rvw_c1", "open c1"))
    for (let index = 0; index < 12; index++) {
      const id = `ses_closed_${index}`
      yield* event(id, deferredType, deferral(id, `rvw_closed_${index}`, `closed-payload ${index}`))
      yield* event(id, decidedType, { sessionID: id, itemID: `rvw_closed_${index}`, decision: { kind: "subagent_question", text: "done" } })
    }

    queries.length = 0
    const items = yield* decisions.list()
    expect(items.map((item) => [item.kind, item.id, item.sessionID, item.sessionTitle, item.directory, item.summary])).toEqual([
      ["permission", "per_alpha", "ses_alpha", "Alpha", "/alpha", "edit: file.txt"],
      ["permission", "per_idle", "ses_idle_3", "Idle 3", "/idle", "edit: file.txt"],
      ["form", "frm_global", "global", "Global", loadedDirectory, "Global form"],
      ["review", "rvw_a0", "ses_alpha", "Alpha", "/alpha", "open a0"],
      ["review", "rvw_a1", "ses_alpha", "Alpha", "/alpha", "open a1"],
      ["review", "rvw_a4", "ses_alpha", "Alpha", "/alpha", "open a4"],
      ["review", "rvw_a5", "ses_alpha", "Alpha", "/alpha", "open a5"],
      ["review", "rvw_a6", "ses_alpha", "Alpha", "/alpha", "second a6"],
      ["review", "rvw_a8", "ses_alpha", "Alpha", "/alpha", "valid a8"],
      ["review", "rvw_a9", "ses_alpha", "Alpha", "/alpha", "open a9"],
      ["review", "rvw_c1", "ses_beta", "Beta", "/beta", "open c1"],
    ])
    expect(items.find((item) => item.id === "frm_global")!.decide.map((choice) => choice.argv)).toEqual([
      ["ycoding", "api", "session.form.reply", "--param", "sessionID=global", "--param", "formID=frm_global",
        "--header", `x-ycoding-directory:${loadedDirectory}`, "--data", JSON.stringify({ answer: { email: "<answer:email>" } })],
      ["ycoding", "api", "session.form.cancel", "--param", "sessionID=global", "--param", "formID=frm_global",
        "--header", `x-ycoding-directory:${loadedDirectory}`],
    ])
    expect(items.find((item) => item.id === "rvw_a6")).toEqual({
      kind: "review", sessionID: "ses_alpha", sessionTitle: "Alpha", directory: "/alpha", id: "rvw_a6", summary: "second a6",
      options: { type: "subagent_question", text: "second a6" },
      decide: [
        { label: "Reply (replace answer values)", template: true,
          hint: "Replace each entire quoted placeholder, including its quotes, with a JSON value matching options. Replace <answer:fields> with the complete answer object, including only active fields.",
          argv: ["ycoding", "api", "session.review.decide", "--param", "sessionID=ses_alpha", "--param", "itemID=rvw_a6",
            "--data", JSON.stringify({ decision: { kind: "subagent_question", text: "<answer:text>" } })] },
        { label: "Dismiss", argv: ["ycoding", "api", "session.review.decide", "--param", "sessionID=ses_alpha", "--param", "itemID=rvw_a6",
          "--data", JSON.stringify({ decision: { kind: "subagent_question", dismissed: true } })] },
      ],
    })

    const reads = queries.filter((query) => /\bfrom "(session|event)"/i.test(query.sql))
    const results = yield* Effect.forEach(reads, (query) => db.$client.unsafe<Record<string, unknown>>(query.sql, query.params))
    const sessionRows = reads.flatMap((query, index) => /\bfrom "session"/i.test(query.sql) ? results[index]! : [])
    expect(sessionRows.map((row) => row.id).toSorted()).toEqual(["ses_alpha", "ses_beta", "ses_idle_3"])
    expect(JSON.stringify(results)).not.toContain("closed-payload")
    const plans = yield* Effect.forEach(reads, (query) => db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`, query.params))
    for (const [index, plan] of plans.entries())
      expect(plan.map((row) => row.detail).filter((detail) => /^SCAN (event|session)\b/.test(detail)), reads[index]!.sql).toEqual([])
    const discovery = plans.find((plan) => plan.some((row) => row.detail.includes("event_review_type_aggregate_seq_idx")))
    expect(discovery?.map((row) => row.detail).slice(0, 2)).toEqual([
      expect.stringMatching(/^SEARCH event USING (COVERING )?INDEX event_review_type_aggregate_seq_idx \(type=\?\)/),
      expect.stringMatching(/^SEARCH session USING INDEX sqlite_autoindex_session_1 \(id=\?\)/),
    ])
    expect(plans.flat().map((row) => row.detail).filter((detail) => detail.includes("event_aggregate_type_seq_idx"))).toEqual([])
  }),
)
