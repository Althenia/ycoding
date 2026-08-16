import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Database } from "@ycoding-ai/core/database/database"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionTable, SessionTodoStateTable } from "@ycoding-ai/core/session/sql"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionTodo.node])))
const sessionID = SessionV2.ID.make("ses_todo_test")

describe("SessionTodo", () => {
  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          directory: "/project",
          title: "todo",
        })
        .run()
        .pipe(Effect.orDie)
      const todos = yield* SessionTodo.Service
      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        yield* db
          .select()
          .from(SessionTodoStateTable)
          .where(eq(SessionTodoStateTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        revision: 1,
        digest: "b1d409388d44fb1244d0f3ff45e08cff36bcf434e187f08182e49c64e829a16d",
      })
      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])
      expect(
        yield* db
          .select()
          .from(SessionTodoStateTable)
          .where(eq(SessionTodoStateTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        revision: 2,
        digest: "a2be55ec38c6884037940f27709c30fcd76feb064dc7c3a21d60e39c3558d37b",
      })
      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionTodoStateTable)
          .where(eq(SessionTodoStateTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        revision: 3,
        digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      })
    }),
  )
})
