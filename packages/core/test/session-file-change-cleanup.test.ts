import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionFileChangeCleanup } from "@ycoding-ai/core/session/file-change-cleanup"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionFileChangeTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const active = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => active),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionFileChangeCleanup.node]),
    [[SessionExecution.node, execution]],
  ),
)

const now = 31 * 24 * 60 * 60 * 1000
const stale = now - 30 * 24 * 60 * 60 * 1000 - 1
const recent = now - 30 * 24 * 60 * 60 * 1000

const insertSession = (id: SessionV2.ID, timeUpdated = stale) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        directory: "/project",
        title: id,
        time_updated: timeUpdated,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionFileChangeTable)
      .values({
        session_id: id,
        path: RelativePath.make("src/file.ts"),
        patch: "@@",
        additions: 1,
        deletions: 0,
        latest_seq: 0,
      })
      .run()
      .pipe(Effect.orDie)
  })

const rowsFor = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionFileChangeTable)
      .where(eq(SessionFileChangeTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
  })

describe("SessionFileChangeCleanup", () => {
  it.effect("deletes stale file-change ledger rows only", () =>
    Effect.gen(function* () {
      const staleID = SessionV2.ID.make("ses_file_change_stale")
      const recentID = SessionV2.ID.make("ses_file_change_recent")
      yield* insertSession(staleID)
      yield* insertSession(recentID, recent)

      expect(yield* (yield* SessionFileChangeCleanup.Service).cleanup(now)).toBe(1)
      expect(yield* rowsFor(staleID)).toHaveLength(0)
      expect(yield* rowsFor(recentID)).toHaveLength(1)
    }),
  )

  it.effect("preserves executor-active stale Session ledgers", () =>
    Effect.gen(function* () {
      const activeID = SessionV2.ID.make("ses_file_change_active")
      yield* insertSession(activeID)
      active.add(activeID)

      expect(yield* (yield* SessionFileChangeCleanup.Service).cleanup(now)).toBe(0)
      expect(yield* rowsFor(activeID)).toHaveLength(1)
      active.clear()
    }),
  )

  it.effect("rebuilds a deleted stale ledger row from its retained file-change fact", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_file_change_recovery")
      const change = { path: RelativePath.make("src/recovered.ts"), patch: "@@", additions: 2, deletions: 1 }
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          directory: "/project",
          title: sessionID,
          time_updated: stale,
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionEvent.FileChange.Recorded, { sessionID, change })

      expect(yield* (yield* SessionFileChangeCleanup.Service).cleanup(now)).toBe(1)
      const recorded = Array.from(yield* Stream.runCollect(events.log({ aggregateID: sessionID }))).find(
        (event) => event.type === SessionEvent.FileChange.Recorded.type,
      )
      if (!recorded || EventV2.isSynced(recorded)) return yield* Effect.die("Retained file-change event is missing")
      const data = Schema.decodeUnknownSync(SessionEvent.FileChange.Recorded.data)(recorded.data)
      yield* db
        .insert(SessionFileChangeTable)
        .values({
          session_id: sessionID,
          path: data.change.path,
          patch: data.change.patch,
          additions: data.change.additions,
          deletions: data.change.deletions,
          latest_seq: recorded.durable?.seq ?? 0,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* rowsFor(sessionID)).toMatchObject([{ session_id: sessionID, ...change }])
    }),
  )
})
