import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import schema from "../../src/database/schema"
import { sqliteLayer } from "../../src/database/sqlite.bun"
import { ContextManifest } from "../../src/session/context-manifest"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import {
  CompactionManifestBlobTable,
  InstructionStateTable,
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionTable,
} from "../../src/session/sql"

export const historyDatabase = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.transaction((tx) => schema.up(tx))
    return { db }
  }),
).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))

export const historyFixture = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  options: { readonly count?: number; readonly bytes?: number } = {},
) {
  const count = options.count ?? 12
  const bytes = options.bytes ?? 32
  const sessionID = SessionSchema.ID.make("ses_history_pruning")
  const ids = Array.from({ length: count }, (_, index) => SessionMessage.ID.make(`msg_history_pruning_${index}`))
  const covered = count - 11
  const data = (index: number) => ({ text: `${index}:` + "x".repeat(bytes), time: { created: index } })
  const summary = {
    text: "Earlier history checkpoint",
    coveredThrough: { messageID: ids[covered], seq: covered },
    digest: ContextManifest.payloadDigest(data(covered)),
  }
  const content = { summary }
  const manifestDigest = ContextManifest.payloadDigest(content)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/tmp", title: "History pruning" })
    .run()
  yield* db
    .insert(InstructionStateTable)
    .values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {}, current_values: {} })
    .run()
  for (let offset = 0; offset < count; offset += 200) {
    yield* db
      .insert(SessionMessageTable)
      .values(
        ids.slice(offset, offset + 200).map((id, local) => ({
          id,
          session_id: sessionID,
          type: "synthetic" as const,
          seq: offset + local,
          time_created: offset + local,
          time_updated: offset + local,
          data: data(offset + local),
        })),
      )
      .run()
  }
  yield* db
    .insert(CompactionManifestBlobTable)
    .values({
      digest: manifestDigest,
      schema_version: 1,
      content,
      input_tokens: 10000,
      retained_tokens: 100,
      time_created: 0,
    })
    .run()
  yield* db
    .insert(SessionContextRevisionTable)
    .values([
      { session_id: sessionID, revision: 0, time_created: 0 },
      {
        session_id: sessionID,
        revision: 1,
        parent_revision: 0,
        manifest_digest: manifestDigest,
        covered_through_message_id: ids[covered],
        covered_through_seq: covered,
        activation_event_id: "evt_history_pruning",
        activation_sequence: count,
        time_created: 0,
      },
    ])
    .run()
  yield* db
    .insert(SessionContextStateTable)
    .values({
      session_id: sessionID,
      status: "active",
      revision: 1,
      manifest_digest: manifestDigest,
      covered_through_message_id: ids[covered],
      covered_through_seq: covered,
      activated_event_id: "evt_history_pruning",
      time_activated: 0,
    })
    .run()
  return { sessionID, ids, summary, manifestDigest, tail: ids.slice(covered + 1), count }
})
