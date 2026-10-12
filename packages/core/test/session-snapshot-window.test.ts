import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionHistory } from "../src/session/history"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Database.node))
const sessionID = SessionSchema.ID.make("ses_snapshot_window_payload")

it.effect("snapshot windows read payloads only for returned messages, not the next-page sentinel", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }).run()
    yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/tmp", title: "Window" }).run()
    for (const [seq, data] of [[1, "invalid JSON outside the window"], [3, JSON.stringify({ text: "older", time: { created: 3 } })], [5, JSON.stringify({ text: "newest", time: { created: 5 } })]] as const) {
      yield* database.db.run(sql`insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
        values (${`msg_window_${seq}`}, ${sessionID}, 'synthetic', ${seq}, ${seq}, ${seq}, ${data})`)
    }
    const first = yield* SessionHistory.snapshotWindow(database.db, sessionID, 2)
    expect(first.messages.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_window_3"), SessionMessage.ID.make("msg_window_5")])
    expect(first.before).toBeDefined()
    const second = yield* SessionHistory.snapshotWindow(database.db, sessionID, 1, 5)
    expect(second.messages.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_window_3")])
    expect(second.before).toBeDefined()
    expect(yield* SessionHistory.snapshotCursor(sessionID, second.before!)).toBe(3)
    const outside = yield* SessionHistory.snapshotWindow(database.db, sessionID, 1, 1)
    expect(outside).toEqual({ messages: [] })
    expect((yield* SessionHistory.snapshotWindow(database.db, sessionID, 1, 3).pipe(Effect.exit))._tag).toBe("Failure")
  }),
)

it.effect("places chronological instruction notices at the update event sequence", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessionID = SessionSchema.ID.make("ses_instruction_notice_order")
    const instructionType = EventRuntime.versionedType(
      SessionEvent.InstructionsUpdated.type,
      SessionEvent.InstructionsUpdated.durable.version,
    )
    yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }).run()
    yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/tmp", title: "Notices" }).run()
    yield* database.db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 9 }).run()
    const messages = [
      [2, "msg_prompt", "synthetic", JSON.stringify({ text: "Prompt", time: { created: 2 } })],
      [6, "msg_assistant", "assistant", JSON.stringify({
        agent: "build",
        model: { providerID: "fixture", id: "fixture" },
        content: [{ type: "text", text: "Answer" }],
        time: { created: 6 },
      })],
      [8, "msg_later", "synthetic", JSON.stringify({ text: "Later", time: { created: 8 } })],
    ] as const
    for (const [seq, id, type, data] of messages) {
      yield* database.db.run(sql`insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
        values (${id}, ${sessionID}, ${type}, ${seq}, ${seq}, ${seq}, ${data})`)
    }
    for (const [seq, id, key] of [
      [1, "evt_instruction_initial", "core/environment"],
      [4, "evt_instruction_date", "core/date"],
      [9, "evt_instruction_files", "core/instructions"],
    ] as const) {
      yield* database.db.insert(EventTable).values({
        id: EventRuntime.ID.make(id),
        aggregate_id: sessionID,
        seq,
        created: seq,
        type: instructionType,
        data: { sessionID, delta: { [key]: "a".repeat(64) } },
      }).run()
    }

    const full = yield* SessionHistory.transcript(database.db, sessionID)
    expect(full.map((message) => message.type === "system" ? message.text : message.id)).toEqual([
      "msg_prompt",
      "Instructions updated: core/date",
      "msg_assistant",
      "msg_later",
      "Instructions updated: core/instructions",
    ])
    expect(full.some((message) => message.type === "system" && message.text.includes("core/environment"))).toBe(false)

    const newest = yield* SessionHistory.snapshotWindow(database.db, sessionID, 2)
    expect(newest.messages.map((message) => message.type === "system" ? message.text : message.id)).toEqual([
      "msg_assistant",
      "msg_later",
      "Instructions updated: core/instructions",
    ])
    expect(newest.before).toBeDefined()
    const older = yield* SessionHistory.snapshotWindow(
      database.db,
      sessionID,
      2,
      yield* SessionHistory.snapshotCursor(sessionID, newest.before!),
    )
    expect(older.messages.map((message) => message.type === "system" ? message.text : message.id)).toEqual([
      "msg_prompt",
      "Instructions updated: core/date",
    ])
    expect(older.messages[1]?.id).toBe(SessionMessage.ID.fromEvent(EventRuntime.ID.make("evt_instruction_date")))
  }),
)
