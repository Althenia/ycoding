import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { SessionTask } from "@ycoding-ai/core/session/task"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionTaskNotificationTable } from "@ycoding-ai/core/session/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { testEffect } from "./lib/effect"
import { rmSync } from "node:fs"

const model = CatalogModel.Ref.make({
  providerID: Provider.ID.make("openai"),
  id: CatalogModel.ID.make("gpt-5.6"),
  variant: CatalogModel.VariantID.make("high"),
})

const staleStates = ["starting", "running", "waiting", "cancelling"] as const

describe("SessionTask.reconcileStaleTasks", () => {
  const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node])))

  it.effect("records stale tasks as lost durably and reconciles only once per database", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const parentID = SessionSchema.ID.make("ses_task_reconcile_parent")
      const now = Date.now()
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: parentID,
          project_id: Project.ID.global,
          directory: "/tmp",
          title: "parent",
          orchestration_revision: 5,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      let idx = 0
      for (const state of staleStates) {
        const childID = SessionSchema.ID.make(`ses_task_recon_${state}`)
        yield* db
          .insert(SessionTable)
          .values({
            id: childID,
            project_id: Project.ID.global,
            parent_id: parentID,
            directory: "/tmp",
            title: childID,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTaskTable)
          .values({
            session_id: childID,
            parent_id: parentID,
            parent_assistant_message_id: SessionMessage.ID.make(`msg_parent_${idx}`),
            tool_call_id: `call_${idx}`,
            input_id: SessionMessage.ID.make(`msg_input_${idx}`),
            description: `task ${state}`,
            agent: Agent.ID.make("build"),
            model,
            prompt_digest: `digest_${idx}`,
            background: true,
            delivery: "steer",
            state,
            revision: idx,
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
        idx++
      }
      const termChild = SessionSchema.ID.make("ses_task_recon_term_completed")
      yield* db
        .insert(SessionTable)
        .values({
          id: termChild,
          project_id: Project.ID.global,
          parent_id: parentID,
          directory: "/tmp",
          title: termChild,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTaskTable)
        .values({
          session_id: termChild,
          parent_id: parentID,
          parent_assistant_message_id: SessionMessage.ID.make("msg_parent_term"),
          tool_call_id: "call_term",
          input_id: SessionMessage.ID.make("msg_input_term"),
          description: "terminal",
          agent: Agent.ID.make("build"),
          model,
          prompt_digest: "digest_term",
          background: true,
          delivery: "steer",
          state: "completed",
          revision: 10,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const beforeParent = yield* db
        .select({ rev: SessionTable.orchestration_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      expect(beforeParent?.rev).toBe(5)

      yield* SessionTask.reconcileStaleTasks(db)
      const afterStale = yield* db.select().from(SessionTaskTable).where(inArray(SessionTaskTable.state, [...staleStates])).all().pipe(Effect.orDie)
      expect(afterStale.length).toBe(0)
      const afterFailed = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.state, "failed")).all().pipe(Effect.orDie)
      expect(afterFailed.length).toBe(0)
      const lost = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.state, "lost")).all().pipe(Effect.orDie)
      expect(lost.length).toBe(4)
      const history = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(history).toHaveLength(4)
      expect(history.every((row) => Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)(row.data).change.type === "lost")).toBe(true)
      const afterParent = yield* db
        .select({ rev: SessionTable.orchestration_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      expect(afterParent?.rev).toBe(9)
      for (const row of lost) expect(row.revision).toBeGreaterThanOrEqual(1)
      const termAfter = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, termChild)).get().pipe(Effect.orDie)
      expect(termAfter?.state).toBe("completed")
      expect(termAfter?.revision).toBe(10)

      yield* SessionTask.reconcileStaleTasks(db)
      const secondParent = yield* db
        .select({ rev: SessionTable.orchestration_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      expect(secondParent?.rev).toBe(9)

      const newChild = SessionSchema.ID.make("ses_task_new_running")
      yield* db
        .insert(SessionTable)
        .values({ id: newChild, project_id: Project.ID.global, parent_id: parentID, directory: "/tmp", title: newChild, time_created: now, time_updated: now })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTaskTable)
        .values({
          session_id: newChild,
          parent_id: parentID,
          parent_assistant_message_id: SessionMessage.ID.make("msg_parent_new"),
          tool_call_id: "call_new",
          input_id: SessionMessage.ID.make("msg_input_new"),
          description: "new running",
          agent: Agent.ID.make("build"),
          model,
          prompt_digest: "digest_new",
          background: true,
          delivery: "steer",
          state: "running",
          revision: 0,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionTask.reconcileStaleTasks(db)
      const newRow = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, newChild)).get().pipe(Effect.orDie)
      expect(newRow?.state).toBe("running")
    }),
  )

  it.effect("startup hook reconciles stale tasks on SessionStore init", () =>
    Effect.gen(function* () {
      const tmpPath = `/tmp/ycoding-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      const parentID = SessionSchema.ID.make("ses_restart_parent")
      const childID = SessionSchema.ID.make("ses_restart_child")
      const now = Date.now()

      const firstLayer = Database.layer({ path: tmpPath })
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({ id: parentID, project_id: Project.ID.global, directory: "/tmp", title: "parent", orchestration_revision: 0, time_created: now, time_updated: now })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({ id: childID, project_id: Project.ID.global, parent_id: parentID, directory: "/tmp", title: childID, time_created: now, time_updated: now })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTaskTable)
          .values({
            session_id: childID,
            parent_id: parentID,
            parent_assistant_message_id: SessionMessage.ID.make("msg_restart_parent"),
            tool_call_id: "call_restart",
            input_id: SessionMessage.ID.make("msg_restart_input"),
            description: "stale running",
            agent: Agent.ID.make("build"),
            model,
            prompt_digest: "digest_restart",
            background: true,
            delivery: "steer",
            state: "running",
            revision: 0,
            time_created: now,
            time_updated: now,
          })
          .run()
          .pipe(Effect.orDie)
      }).pipe(Effect.provide(firstLayer), Effect.scoped)

      const secondLayer = AppNodeBuilder.build(
        LayerNode.group([Database.configured({ path: tmpPath }), EventRuntime.node, SessionProjector.node, SessionStore.node]),
      )
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get().pipe(Effect.orDie)
        expect(row?.state).toBe("lost")
        expect(row?.revision).toBe(1)
        const parent = yield* db.select({ rev: SessionTable.orchestration_revision }).from(SessionTable).where(eq(SessionTable.id, parentID)).get().pipe(Effect.orDie)
        expect(parent?.rev).toBe(1)
      }).pipe(Effect.provide(secondLayer), Effect.scoped)

      try {
        rmSync(tmpPath)
        rmSync(`${tmpPath}-wal`, { force: true })
        rmSync(`${tmpPath}-shm`, { force: true })
      } catch {}
    }),
  )

  it.effect("rebuilds the same task projection from the reconciled durable history", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventRuntime.Service
      const parentID = SessionSchema.ID.make("ses_fold_parent")
      const childID = SessionSchema.ID.make("ses_fold_child")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }).run().pipe(Effect.orDie)
      for (const sessionID of [parentID, childID]) {
        yield* events.publish(SessionEvent.Created, {
          sessionID,
          parentID: sessionID === childID ? parentID : undefined,
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/tmp") },
          title: sessionID,
          created: Date.now(),
        })
      }
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: childID, change: {
        type: "launched", parentID, parentAssistantMessageID: SessionMessage.ID.make("msg_fold_parent"),
        toolCallID: "call_fold", inputID: SessionMessage.ID.make("msg_fold_input"), description: "fold",
        agent: Agent.ID.make("build"), model, promptDigest: "digest", background: true, delivery: "steer",
      } })
      yield* events.publish(SessionEvent.Task.Updated, { sessionID: childID, change: { type: "started" } })
      yield* SessionTask.reconcileStaleTasks(db)
      const live = yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie)
      expect(live[0]?.state).toBe("lost")
      const notifications = yield* db.select().from(SessionTaskNotificationTable).all().pipe(Effect.orDie)
      const history = yield* db.select().from(EventTable).orderBy(EventTable.seq).all().pipe(Effect.orDie)
      const replayLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node]))
      const rebuilt = yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventRuntime.Service
        yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] }).run().pipe(Effect.orDie)
        for (const row of history) yield* events.replay({
          id: row.id, aggregateID: row.aggregate_id, seq: row.seq, type: row.type,
          created: DateTime.makeUnsafe(row.created), data: row.data,
        })
        return { tasks: yield* db.select().from(SessionTaskTable).all().pipe(Effect.orDie),
          notifications: yield* db.select().from(SessionTaskNotificationTable).all().pipe(Effect.orDie) }
      }).pipe(Effect.provide(replayLayer.pipe(Layer.fresh)), Effect.scoped)
      expect(rebuilt.tasks).toEqual(live)
      expect(rebuilt.notifications).toEqual(notifications)
    }),
  )
})
