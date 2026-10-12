import { expect, spyOn, test } from "bun:test"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { ProjectSchema } from "@ycoding-ai/core/project/schema"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompletion } from "@ycoding-ai/core/session/completion"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Effect } from "effect"
import { sql } from "drizzle-orm"

test("completion pages seek each root's latest receipt without scanning unrelated event history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectSchema.ID.global, worktree: AbsolutePath.make("/completion-test"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values(
          ["ses_a", "ses_b", "ses_c", "ses_empty", "ses_child"].map((id, index) => ({
            id: SessionSchema.ID.make(id),
            project_id: ProjectSchema.ID.global,
            directory: "/completion-test",
            title: "Completion fixture",
            parent_id: id === "ses_child" ? SessionSchema.ID.make("ses_a") : undefined,
            time_updated: index + 1,
          })),
        )
        .run()
      yield* db.run(sql`INSERT INTO event_sequence(aggregate_id, seq) SELECT id, 20000 FROM session`)
      yield* db.run(sql`WITH RECURSIVE history(seq) AS (VALUES(1) UNION ALL SELECT seq + 1 FROM history WHERE seq < 20000)
        INSERT INTO event SELECT 'evt_history_' || seq, 'ses_empty', seq, seq, 'session.text.delta.1', json_object('text', hex(zeroblob(256))) FROM history`)
      for (const [sessionID, seq] of [
        ["ses_a", 1],
        ["ses_a", 8],
        ["ses_b", 5],
        ["ses_c", 3],
        ["ses_child", 10],
      ] as const)
        yield* db.run(
          sql`INSERT INTO event VALUES (${`evt_${sessionID}_${seq}`}, ${sessionID}, ${seq}, ${seq * 100}, 'session.work.completed.1', ${JSON.stringify({ sessionID, inputID: "msg_input", assistantMessageID: "msg_final" })})`,
        )
      const tracked = spyOn(db.$client, "unsafe")
      yield* Effect.addFinalizer(() => Effect.sync(() => tracked.mockRestore()))
      const first = yield* SessionCompletion.latest(db, { limit: 1 })
      expect(first).toEqual({
        data: [
          {
            id: EventRuntime.ID.make("evt_ses_a_8"),
            seq: EventRuntime.Seq.make(8),
            created: 800,
            sessionID: SessionSchema.ID.make("ses_a"),
            inputID: SessionMessage.ID.make("msg_input"),
            assistantMessageID: SessionMessage.ID.make("msg_final"),
          },
        ],
        next: SessionSchema.ID.make("ses_a"),
      })
      expect(tracked.mock.calls).toHaveLength(1)
      const firstQuery = tracked.mock.calls[0]
      const plan = yield* db.$client.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${firstQuery[0]}`, firstQuery[1])
      expect(plan.some((row) => /SCAN event\b|SCAN .*event_aggregate/.test(row.detail))).toBe(false)
      expect(
        plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("event_aggregate_type_seq_idx")),
      ).toBe(true)
      const second = yield* SessionCompletion.latest(db, { limit: 1, after: SessionSchema.ID.make("ses_a") })
      expect(second.data.map((row) => [row.sessionID, row.seq])).toEqual([
        [SessionSchema.ID.make("ses_b"), EventRuntime.Seq.make(5)],
      ])
      expect(second.next).toBe(SessionSchema.ID.make("ses_b"))
      const final = yield* SessionCompletion.latest(db, { limit: 1, after: SessionSchema.ID.make("ses_b") })
      expect(final.data.map((row) => [row.sessionID, row.seq])).toEqual([
        [SessionSchema.ID.make("ses_c"), EventRuntime.Seq.make(3)],
      ])
      expect(final.next).toBeUndefined()
      expect(yield* SessionCompletion.latest(db, { limit: 1, after: SessionSchema.ID.make("ses_c") })).toEqual({
        data: [],
      })
      yield* db.run(
        sql`INSERT INTO event VALUES ('evt_ses_a_20', 'ses_a', 20, 2000, 'session.work.completed.1', ${JSON.stringify({ sessionID: "ses_a", inputID: "msg_new", assistantMessageID: "msg_new_final" })})`,
      )
      expect((yield* SessionCompletion.latest(db, { limit: 1 })).data[0]).toMatchObject({
        sessionID: SessionSchema.ID.make("ses_a"),
        seq: EventRuntime.Seq.make(20),
        inputID: SessionMessage.ID.make("msg_new"),
      })
    }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped),
  ))
