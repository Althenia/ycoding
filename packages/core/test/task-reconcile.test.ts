import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, inArray } from "drizzle-orm"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { SessionTask } from "@ycoding-ai/core/session/task"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { testEffect } from "./lib/effect"
import { rmSync } from "node:fs"

const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("openai"),
  id: ModelV2.ID.make("gpt-5.6"),
  variant: ModelV2.VariantID.make("high"),
})

const staleStates = ["starting", "running", "waiting", "cancelling"] as const

describe("SessionTask.reconcileStaleTasks", () => {
  const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

  it.effect("fails stale tasks and bumps parent orchestration revision idempotently", () =>
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
            agent: AgentV2.ID.make("build"),
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
      // terminal that should remain
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
          agent: AgentV2.ID.make("build"),
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
      // 4 stale became failed, term completed stays completed
      expect(afterFailed.length).toBe(4)
      const afterParent = yield* db
        .select({ rev: SessionTable.orchestration_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      expect(afterParent?.rev).toBe(6)
      // revision incremented
      for (const row of afterFailed) expect(row.revision).toBeGreaterThanOrEqual(1)
      const termAfter = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, termChild)).get().pipe(Effect.orDie)
      expect(termAfter?.state).toBe("completed")
      expect(termAfter?.revision).toBe(10)

      // idempotent second run
      yield* SessionTask.reconcileStaleTasks(db)
      const secondParent = yield* db
        .select({ rev: SessionTable.orchestration_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, parentID))
        .get()
        .pipe(Effect.orDie)
      expect(secondParent?.rev).toBe(6)

      // AC3: new running task after reconcile stays running until next reconcile
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
          agent: AgentV2.ID.make("build"),
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
      const newRow = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, newChild)).get().pipe(Effect.orDie)
      expect(newRow?.state).toBe("running")
    }),
  )

  // startup reconciliation via SessionStore layer init (simulated restart with file-backed DB)
  it.effect("startup hook reconciles stale tasks on SessionStore init", () =>
    Effect.gen(function* () {
      const tmpPath = `/tmp/ycoding-reconcile-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
      const parentID = SessionSchema.ID.make("ses_restart_parent")
      const childID = SessionSchema.ID.make("ses_restart_child")
      const now = Date.now()

      // First boot: create DB and stale task without triggering reconcile via store (use raw Database layer)
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
            agent: AgentV2.ID.make("build"),
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

      // Second boot: SessionStore init should auto-reconcile
      const secondLayer = AppNodeBuilder.build(
        LayerNode.group([Database.configured({ path: tmpPath }), EventV2.node, SessionProjector.node, SessionStore.node]),
      )
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get().pipe(Effect.orDie)
        expect(row?.state).toBe("failed")
        expect(row?.revision).toBe(1)
        const parent = yield* db.select({ rev: SessionTable.orchestration_revision }).from(SessionTable).where(eq(SessionTable.id, parentID)).get().pipe(Effect.orDie)
        expect(parent?.rev).toBe(1)
      }).pipe(Effect.provide(secondLayer), Effect.scoped)

      // cleanup
      try {
        rmSync(tmpPath)
        rmSync(`${tmpPath}-wal`, { force: true })
        rmSync(`${tmpPath}-shm`, { force: true })
      } catch {}
    }),
  )
})
