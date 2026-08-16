import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { SessionMessage } from "@ycoding-ai/schema"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionContextExclusionCleanup } from "@ycoding-ai/core/session/context-exclusion-cleanup"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import {
  CompactionManifestBlobTable,
  SessionContextExclusionTable,
  SessionContextRevisionTable,
  SessionMessageTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
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
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionContextExclusionCleanup.node]), [
    [SessionExecution.node, execution],
  ]),
)

const now = 31 * 24 * 60 * 60 * 1000
const stale = now - 30 * 24 * 60 * 60 * 1000 - 1
const recent = now - 30 * 24 * 60 * 60 * 1000
const manifestDigest = "a".repeat(64)

const insert = (id: SessionV2.ID, timeUpdated = stale) =>
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
      .values({ id, project_id: Project.ID.global, directory: "/project", title: id, time_updated: timeUpdated })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(CompactionManifestBlobTable)
      .values({
        digest: manifestDigest,
        schema_version: 1,
        content: {},
        input_tokens: 1,
        retained_tokens: 0,
        time_created: timeUpdated,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextRevisionTable)
      .values({ session_id: id, revision: 0, time_created: timeUpdated })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextExclusionTable)
      .values({
        session_id: id,
        context_revision: 0,
        target_key: "b".repeat(64),
        target_kind: "message",
        target_selector: { kind: "message", messageID: "msg_excluded", digest: "c".repeat(64) },
        reason: "exact_duplicate",
        manifest_digest: manifestDigest,
      })
      .run()
      .pipe(Effect.orDie)
  })

const exclusions = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionContextExclusionTable)
      .where(eq(SessionContextExclusionTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
  })

describe("SessionContextExclusionCleanup", () => {
  it.effect("prunes only stale inactive context exclusions", () =>
    Effect.gen(function* () {
      const staleID = SessionV2.ID.make("ses_context_exclusion_stale")
      const recentID = SessionV2.ID.make("ses_context_exclusion_recent")
      const activeID = SessionV2.ID.make("ses_context_exclusion_active")
      yield* insert(staleID)
      yield* insert(recentID, recent)
      yield* insert(activeID)
      active.add(activeID)

      expect(yield* exclusions(staleID)).toHaveLength(1)
      expect(yield* (yield* SessionContextExclusionCleanup.Service).cleanup(now)).toBe(1)
      expect(yield* exclusions(staleID)).toHaveLength(0)
      expect(yield* exclusions(recentID)).toHaveLength(1)
      expect(yield* exclusions(activeID)).toHaveLength(1)
      active.clear()
    }),
  )

  it.effect("retains canonical messages and durable compaction history after projection cleanup", () =>
    Effect.gen(function* () {
      const sessionID = SessionV2.ID.make("ses_context_exclusion_replay")
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const message = Schema.encodeSync(SessionMessage.Info)(
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_context_exclusion_replay"),
          type: "user",
          text: "canonical transcript",
          time: { created: DateTime.makeUnsafe(stale) },
        }),
      )
      const { id, type, ...data } = message
      yield* insert(sessionID)
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: 1,
          time_created: stale,
          time_updated: stale,
          data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        jobID: SessionCompaction.ID.make("cmp_context_exclusion_replay"),
        revision: 1,
        boundary: { messageID: SessionMessage.ID.make("msg_context_exclusion_replay"), seq: 1 },
        metrics: { excludedMessages: 1, excludedParts: 0, inputTokens: 1, retainedTokens: 0 },
      })

      expect(yield* (yield* SessionContextExclusionCleanup.Service).cleanup(now)).toBe(1)
      expect(yield* exclusions(sessionID)).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(
        Array.from(yield* Stream.runCollect(events.log({ aggregateID: sessionID }))).some(
          (event) => !EventV2.isSynced(event) && event.type === SessionEvent.Compaction.Ended.type,
        ),
      ).toBe(true)
    }),
  )
})
