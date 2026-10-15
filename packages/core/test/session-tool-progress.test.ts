import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Agent } from "@ycoding-ai/core/agent"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionTable, SessionMessageTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node])))
const model = { id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }]

describe("Tool.Progress", () => {
  it.effect("delivers progress live without persisting or projecting it, and settlements stay durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventRuntime.Service
      const sessionID = Session.ID.make("ses_tool_progress_live")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "progress" })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID, name: "bash" })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            assistantMessageID,
            callID,
            input: { command: "pwd" },
            executed: false,
          })
        })
      const live = yield* service.subscribe(SessionEvent.Tool.Progress).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* start("call-success")
      const published = yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect(published.durable).toBeUndefined()
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })
      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        executed: false,
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        executed: false,
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: { status: "error", structured: {}, content: [], error: { type: "unknown", message: "boom" } },
      })
      expect(Array.from(yield* Fiber.join(live)).map((event) => [event.data.callID, event.data.content])).toEqual([
        ["call-success", content("saved")],
        ["call-failed", content("before failure")],
      ])
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const types = (yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)).map((row) => row.type)
      expect(types.some((type) => type.startsWith("session.tool.progress"))).toBe(false)
      expect(types).toContain(EventRuntime.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(types).toContain(EventRuntime.versionedType(SessionEvent.Tool.Failed.type, 1))
    }),
  )
})
