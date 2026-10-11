import { expect } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
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
