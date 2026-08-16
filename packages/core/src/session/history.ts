import { and, asc, desc, eq, gte, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Instructions } from "../instructions/index"
import { InstructionState } from "./instruction-state"
import { SessionMessageTable } from "./sql"
import { EventTable } from "../event/sql"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction ? gte(SessionMessageTable.seq, compaction.seq) : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const messageEntries = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID))
  return yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
})

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* messageEntries(db, sessionID)).map((entry) => entry.message)
})

export function visibleForModel<T extends { readonly seq: number; readonly message: SessionMessage.Info }>(
  entries: ReadonlyArray<T>,
  durableBoundary?: number,
) {
  const boundary =
    durableBoundary ??
    entries.findLast((entry) =>
      entry.message.type === "synthetic" &&
      entry.message.metadata !== undefined &&
      typeof entry.message.metadata.projectArtifactsEnded === "object" &&
      entry.message.metadata.projectArtifactsEnded !== null,
    )?.seq
  if (boundary === undefined) return entries
  return entries.filter((entry) => {
    if (entry.seq >= boundary) return !isProjectArtifactBoundary(entry.message)
    return !isProjectArtifact(entry.message)
  })
}

const entriesVisibleForModel = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return visibleForModel(yield* messageEntries(db, sessionID), yield* latestProjectArtifactBoundary(db, sessionID))
})

export const forModel = Effect.fn("SessionHistory.forModel")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (yield* entriesVisibleForModel(db, sessionID)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.Instructions,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* entriesVisibleForModel(db, sessionID)
        const assembled = yield* InstructionState.assemble(db, sessionID, instructions)
        return {
          initial: assembled.initial,
          entries: [...messages, ...assembled.updates].toSorted((a, b) => a.seq - b.seq),
        }
      }),
    )
    .pipe(Effect.orDie)
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.Instructions,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* entriesVisibleForModel(db, sessionID)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        const entries = [...settled, ...assembled.updates].toSorted((a, b) => a.seq - b.seq)
        return {
          initial: assembled.initial,
          messages: entries.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

const latestProjectArtifactBoundary = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (
    yield* db
      .select({ seq: EventTable.seq })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          eq(EventTable.type, EventV2.versionedType(SessionEvent.ProjectArtifactsEnded.type, 1)),
        ),
      )
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
  )?.seq
})

function isProjectArtifact(message: SessionMessage.Info) {
  if (message.type === "skill" || message.type === "agent-switched") return message.artifact?.sourceScope === "project"
  if (message.type !== "user") return false
  const artifact = message.metadata?.projectArtifact
  return (
    artifact !== undefined &&
    typeof artifact === "object" &&
    artifact !== null &&
    "sourceScope" in artifact &&
    artifact.sourceScope === "project"
  )
}

function isProjectArtifactBoundary(message: SessionMessage.Info) {
  return (
    message.type === "synthetic" &&
    message.metadata !== undefined &&
    typeof message.metadata.projectArtifactsEnded === "object" &&
    message.metadata.projectArtifactsEnded !== null
  )
}

/** Returns the session's sole user message, or `undefined` once a second one exists. */
export const firstUserMessageIfOnly = Effect.fn("SessionHistory.firstUserMessageIfOnly")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .limit(2)
    .all()
    .pipe(Effect.orDie)
  if (rows.length !== 1) return undefined
  const message = yield* decodeMessageRow(rows[0]).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return message?.type === "user" ? message : undefined
})

export * as SessionHistory from "./history"
