export * as SessionHistoryPruning from "./history-pruning"

import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { EventRuntime } from "../event"
import { ToolOutputStore } from "../tool-output-store"
import { SessionContextState } from "./context-state"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionCompactionJobTable, SessionTable } from "./sql"

export const SETTLED_GRACE = Duration.minutes(1)
export const IMAGE_IDLE = Duration.hours(24)
const sessionPageSize = 200
const messageBatchSize = 50
const eventBatchSize = 100
const batchByteBudget = 2 * 1024 * 1024

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const versioned = (definition: Extract<EventRuntime.Definition, { durability: "durable" }>) =>
  EventRuntime.versionedType(definition.type, definition.durable.version)

// Rows written while tool progress was durable; current progress is live-only.
const storedToolProgressType = "session.tool.progress.1"
const contextObservedType = versioned(SessionEvent.ContextObserved)
const toolSuccessType = versioned(SessionEvent.Tool.Success)
const executionStartedType = versioned(SessionEvent.Execution.Started)
const terminalTypes = [
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
].map(versioned)
const latestSettledTypes = [
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Execution.Failed,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
].map(versioned)
const latestReadTypes = [contextObservedType, ...latestSettledTypes]
const settledMessageTypes = [
  SessionEvent.Synthetic,
  SessionEvent.Skill.Activated,
  SessionEvent.Skill.Deactivated,
  SessionEvent.Shell.Started,
  SessionEvent.Shell.Ended,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Text.Started,
  SessionEvent.Text.Ended,
  SessionEvent.Reasoning.Started,
  SessionEvent.Reasoning.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Input.Ended,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
  SessionEvent.RetryScheduled,
  SessionEvent.InputConsumed,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Execution.Failed,
].map(versioned)
const compactedEventTypes = [...settledMessageTypes, contextObservedType, storedToolProgressType]
const settledEventTypes = [
  ...settledMessageTypes,
  versioned(SessionEvent.ProviderRequestRecorded),
  versioned(SessionEvent.FileChange.Recorded),
]

export interface Result {
  readonly messages: number
  readonly events: number
  readonly images: number
}

export class BackupUnavailableError extends Schema.TaggedErrorClass<BackupUnavailableError>()(
  "SessionHistoryPruning.BackupUnavailableError",
  {},
) {}

const none: Result = { messages: 0, events: 0, images: 0 }

export function make(
  db: Database.Interface["db"],
  active: Effect.Effect<ReadonlySet<SessionSchema.ID>>,
  backup: Effect.Effect<boolean> = Effect.succeed(true),
) {
  const list = (values: ReadonlyArray<string | number>) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    )

  const compacted = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, manifestDigest: string) {
    if ((yield* active).has(sessionID)) return false
    const current = yield* SessionContextState.checkpoint(db, sessionID)
    if (current?.manifestDigest !== manifestDigest) return false
    const session = yield* db
      .select({ revert: SessionTable.revert })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session || session.revert !== null) return false
    const job = yield* db
      .select({ id: SessionCompactionJobTable.id })
      .from(SessionCompactionJobTable)
      .where(
        and(
          eq(SessionCompactionJobTable.session_id, sessionID),
          inArray(SessionCompactionJobTable.status, ["pending", "running"]),
        ),
      )
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    return job === undefined
  })

  const settled = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, idle: Duration.Duration) {
    if ((yield* active).has(sessionID)) return undefined
    const row = yield* db
      .get<{ seq: number; created: number; started: number | null; blocked: number }>(
        sql`SELECT terminal.seq AS seq, terminal.created AS created,
            (SELECT max(seq) FROM event WHERE aggregate_id = ${sessionID} AND type = ${executionStartedType}) AS started,
            (session.revert IS NOT NULL
              OR EXISTS (SELECT 1 FROM session_compaction_job
                WHERE session_id = ${sessionID} AND status IN ('pending', 'running'))
              OR EXISTS (SELECT 1 FROM session_context_state AS state
                JOIN compaction_manifest_blob AS blob ON blob.digest = state.manifest_digest
                WHERE state.session_id = ${sessionID} AND state.status = 'active'
                  AND json_type(blob.content, '$.remote') IS NOT NULL)) AS blocked
          FROM session CROSS JOIN event AS terminal
          WHERE session.id = ${sessionID} AND terminal.aggregate_id = ${sessionID}
            AND terminal.type IN (${list(terminalTypes)})
          ORDER BY terminal.seq DESC LIMIT 1`,
      )
      .pipe(Effect.orDie)
    if (!row || row.blocked === 1 || row.started === null || row.started > row.seq) return undefined
    if (row.created > (yield* Clock.currentTimeMillis) - Duration.toMillis(idle)) return undefined
    return row.seq
  })

  const compactedPlan = Effect.fnUntraced(function* (
    sessionID: SessionSchema.ID,
    checkpoint: SessionContextState.Checkpoint,
  ) {
    const latest = yield* db
      .all<{ seq: number }>(
        sql`SELECT max(seq) AS seq FROM event
          WHERE aggregate_id = ${sessionID} AND type IN (${list(latestReadTypes)})
          GROUP BY type, CASE WHEN type = ${contextObservedType} THEN json_extract(data, '$.source') END`,
      )
      .pipe(Effect.orDie)
    const kept = yield* db
      .all<{ id: string; shellID: string | null }>(
        sql`SELECT id, CASE WHEN type = 'shell' THEN json_extract(data, '$.shellID') END AS shellID
          FROM session_message WHERE session_id = ${sessionID} AND seq < ${checkpoint.coveredThrough.seq}`,
      )
      .pipe(Effect.orDie)
    return {
      floor: checkpoint.coveredThrough.seq,
      latest: latest.map((row) => row.seq),
      messages: kept.map((row) => row.id),
      shells: kept.flatMap((row) => (row.shellID === null ? [] : [row.shellID])),
    }
  })

  const compactedMessages = (sessionID: SessionSchema.ID, through: number) => (limit: number, after: number) =>
    sql`SELECT rowid, seq, octet_length(data) AS bytes FROM session_message
      WHERE session_id = ${sessionID} AND seq < ${through} AND seq > ${after} AND type <> 'compaction'
        AND id IS NOT (
          SELECT id FROM session_message WHERE session_id = ${sessionID} AND type = 'user' ORDER BY seq LIMIT 1
        )
        AND id NOT IN (
          SELECT fork_message_id FROM session WHERE fork_session_id = ${sessionID} AND fork_message_id IS NOT NULL
        )
      ORDER BY seq LIMIT ${limit}`

  const compactedEvents =
    (sessionID: SessionSchema.ID, plan: Effect.Success<ReturnType<typeof compactedPlan>>) =>
    (limit: number, after: number) =>
      sql`SELECT rowid, seq, octet_length(data) AS bytes FROM event INDEXED BY event_aggregate_seq_idx
        WHERE aggregate_id = ${sessionID} AND seq > ${after} AND seq < ${plan.floor} AND type IN (${list(compactedEventTypes)})
          ${plan.latest.length > 0 ? sql`AND seq NOT IN (${list(plan.latest)})` : sql``}
          ${
            plan.messages.length > 0
              ? sql`AND coalesce(json_extract(data, '$.assistantMessageID'), '') NOT IN (${list(plan.messages)})
                AND coalesce(json_extract(data, '$.activationMessageID'), '') NOT IN (${list(plan.messages)})
                AND ('msg_' || substr(id, 5)) NOT IN (${list(plan.messages)})
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(data, '$.inputIDs') AS input WHERE input.value IN (${list(plan.messages)})
                )`
              : sql``
          }
          ${plan.shells.length > 0 ? sql`AND coalesce(json_extract(data, '$.shell.id'), '') NOT IN (${list(plan.shells)})` : sql``}
        ORDER BY seq LIMIT ${limit}`

  const settledEvents =
    (sessionID: SessionSchema.ID, through: number, latest: ReadonlyArray<number>) => (limit: number, after: number) =>
      sql`SELECT rowid, seq, octet_length(data) AS bytes FROM event INDEXED BY event_aggregate_seq_idx
      WHERE aggregate_id = ${sessionID} AND seq > ${after} AND seq <= ${through} AND type IN (${list(settledEventTypes)})
        ${latest.length > 0 ? sql`AND seq NOT IN (${list(latest)})` : sql``}
        AND NOT (type = ${toolSuccessType} AND EXISTS (
          SELECT 1 FROM json_each(data, '$.content') AS item
          WHERE json_extract(item.value, '$.type') = 'file' AND json_extract(item.value, '$.mime') LIKE 'image/%'
        ))
      ORDER BY seq LIMIT ${limit}`

  const imageMarkers = (sessionID: SessionSchema.ID, through: number) => (limit: number, after: number) =>
    sql`SELECT rowid, seq, octet_length(data) AS bytes FROM event
      WHERE aggregate_id = ${sessionID} AND type = ${toolSuccessType} AND seq > ${after} AND seq <= ${through}
      ORDER BY seq LIMIT ${limit}`

  const imageMessages = (sessionID: SessionSchema.ID) => (limit: number, after: number) =>
    sql`SELECT rowid FROM session_message
      WHERE session_id = ${sessionID} AND type = 'assistant' AND seq > ${after}
        AND seq > coalesce((SELECT covered_through_seq FROM session_context_state
          WHERE session_id = ${sessionID} AND status = 'active' AND manifest_digest IS NOT NULL), -1)
        AND EXISTS (
          SELECT 1 FROM json_each(data, '$.content') AS part
          WHERE json_extract(part.value, '$.type') = 'tool'
            AND json_extract(part.value, '$.state.status') = 'completed'
            AND EXISTS (
              SELECT 1 FROM json_each(part.value, '$.state.content') AS item
              WHERE json_extract(item.value, '$.type') = 'file'
                AND json_extract(item.value, '$.mime') LIKE 'image/%'
                AND json_extract(item.value, '$.uri') LIKE 'data:%;base64,%'
            )
        )
      ORDER BY seq LIMIT ${limit}`

  const storedProgress = (sessionID: SessionSchema.ID, through: number) => (limit: number, after: number) =>
    sql`SELECT rowid, seq, octet_length(data) AS bytes FROM event
      WHERE aggregate_id = ${sessionID} AND type = ${storedToolProgressType} AND seq > ${after} AND seq <= ${through}
      ORDER BY seq LIMIT ${limit}`

  // Large rows dominate delete cost, so each batch also stops at a byte budget (always taking one row).
  const bounded = (candidates: SQL) =>
    sql`SELECT rowid FROM (
      SELECT rowid, row_number() OVER (ORDER BY seq) AS position, sum(bytes) OVER (ORDER BY seq) AS total
      FROM (${candidates})
    ) WHERE position = 1 OR total <= ${batchByteBudget}`

  const batches = Effect.fnUntraced(function* (
    eligible: Effect.Effect<boolean>,
    candidates: (limit: number, after: number) => SQL,
    remove: (after: number) => Effect.Effect<ReadonlyArray<number>>,
  ) {
    const pending = yield* db
      .get<{ found: number }>(sql`SELECT EXISTS (${candidates(1, -1)}) AS found`)
      .pipe(Effect.orDie)
    if (pending?.found !== 1) return 0
    if (!(yield* backup)) return yield* new BackupUnavailableError()
    let total = 0
    let after = -1
    while (true) {
      const removed = yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              if (!(yield* eligible)) return []
              return yield* remove(after)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (removed.length === 0) return total
      total += removed.length
      after = Math.max(after, ...removed)
      yield* Effect.yieldNow
    }
  })

  const deleted = (statement: SQL) =>
    db.all<{ seq: number }>(statement).pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.seq)),
    )

  const pruneCompacted = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const checkpoint = yield* SessionContextState.checkpoint(db, sessionID)
    if (!checkpoint) return { messages: 0, events: 0 }
    const eligible = compacted(sessionID, checkpoint.manifestDigest)
    if (!(yield* eligible)) return { messages: 0, events: 0 }
    const messages = compactedMessages(sessionID, checkpoint.coveredThrough.seq)
    const removedMessages = yield* batches(eligible, messages, (after) =>
      deleted(
        sql`DELETE FROM session_message WHERE rowid IN (${bounded(messages(messageBatchSize, after))}) RETURNING seq`,
      ),
    )
    const events = compactedEvents(sessionID, yield* compactedPlan(sessionID, checkpoint))
    const removedEvents = yield* batches(eligible, events, (after) =>
      deleted(sql`DELETE FROM event WHERE rowid IN (${bounded(events(eventBatchSize, after))}) RETURNING seq`),
    )
    return { messages: removedMessages, events: removedEvents }
  })

  const pruneSettled = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const through = yield* settled(sessionID, SETTLED_GRACE)
    if (through === undefined) return 0
    const latest = yield* db
      .all<{ seq: number }>(
        sql`SELECT max(seq) AS seq FROM event
          WHERE aggregate_id = ${sessionID} AND type IN (${list(latestSettledTypes)}) GROUP BY type`,
      )
      .pipe(Effect.orDie)
    const events = settledEvents(
      sessionID,
      through,
      latest.map((row) => row.seq),
    )
    return yield* batches(
      settled(sessionID, SETTLED_GRACE).pipe(Effect.map((current) => current !== undefined)),
      events,
      (after) =>
        deleted(sql`DELETE FROM event WHERE rowid IN (${bounded(events(eventBatchSize, after))}) RETURNING seq`),
    )
  })

  const pruneImages = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const through = yield* settled(sessionID, IMAGE_IDLE)
    if (through === undefined) return { events: 0, images: 0 }
    const eligible = settled(sessionID, IMAGE_IDLE).pipe(Effect.map((current) => current !== undefined))
    const messages = imageMessages(sessionID)
    let images = 0
    yield* batches(eligible, messages, (after) =>
      Effect.gen(function* () {
        const row = yield* db
          .get<{
            rowid: number
            seq: number
            data: string
          }>(sql`SELECT rowid, seq, data FROM session_message WHERE rowid IN (${messages(1, after)})`)
          .pipe(Effect.orDie)
        if (!row) return []
        const stripped = withoutToolImages(Option.getOrUndefined(decodeJson(row.data)))
        if (stripped && stripped.images > 0) {
          yield* db
            .run(sql`UPDATE session_message SET data = ${JSON.stringify(stripped.data)} WHERE rowid = ${row.rowid}`)
            .pipe(Effect.orDie)
          images += stripped.images
        }
        return [row.seq]
      }),
    )
    const markers = imageMarkers(sessionID, through)
    const events = yield* batches(eligible, markers, (after) =>
      deleted(sql`DELETE FROM event WHERE rowid IN (${bounded(markers(eventBatchSize, after))}) RETURNING seq`),
    )
    return { events, images }
  })

  const pruneStoredProgress = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const terminal = yield* db
      .get<{
        seq: number | null
      }>(sql`SELECT max(seq) AS seq FROM event WHERE aggregate_id = ${sessionID} AND type IN (${list(terminalTypes)})`)
      .pipe(Effect.orDie)
    if (terminal?.seq === null || terminal?.seq === undefined) return 0
    const events = storedProgress(sessionID, terminal.seq)
    return yield* batches(Effect.succeed(true), events, (after) =>
      deleted(sql`DELETE FROM event WHERE rowid IN (${bounded(events(eventBatchSize, after))}) RETURNING seq`),
    )
  })

  const prune = Effect.fn("SessionHistoryPruning.prune")(function* (sessionID: SessionSchema.ID) {
    const compactedResult = yield* pruneCompacted(sessionID)
    const progressEvents = yield* pruneStoredProgress(sessionID)
    const settledEvents = yield* pruneSettled(sessionID)
    const imageResult = yield* pruneImages(sessionID)
    return {
      messages: compactedResult.messages,
      events: compactedResult.events + progressEvents + settledEvents + imageResult.events,
      images: imageResult.images,
    } satisfies Result
  })

  const sweep = Effect.fn("SessionHistoryPruning.sweep")(
    function* () {
      let cursor: SessionSchema.ID | undefined
      let result = none
      while (true) {
        const page = yield* db
          .select({ sessionID: SessionTable.id })
          .from(SessionTable)
          .where(cursor === undefined ? undefined : gt(SessionTable.id, cursor))
          .orderBy(asc(SessionTable.id))
          .limit(sessionPageSize)
          .all()
          .pipe(Effect.orDie)
        for (const row of page) {
          const pruned = yield* prune(row.sessionID).pipe(
            Effect.catchDefect((cause) =>
              Effect.logError("session history pruning could not prune session", {
                sessionID: row.sessionID,
                cause,
              }).pipe(Effect.as(none)),
            ),
          )
          result = {
            messages: result.messages + pruned.messages,
            events: result.events + pruned.events,
            images: result.images + pruned.images,
          }
          yield* Effect.yieldNow
        }
        if (page.length < sessionPageSize) break
        cursor = page.at(-1)!.sessionID
      }
      if (result.messages > 0 || result.events > 0 || result.images > 0) {
        yield* Effect.logInfo("session history pruning deleted settled and compacted history", result)
        yield* Database.reclaim(db).pipe(Effect.orDie)
      }
      return result
    },
    Effect.catchTag("SessionHistoryPruning.BackupUnavailableError", () => Effect.succeed(none)),
  )

  return { prune, sweep }
}

function withoutToolImages(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.content)) return undefined
  let images = 0
  const content = data.content.map((part) => {
    if (!isRecord(part) || part.type !== "tool") return part
    const state = part.state
    if (!isRecord(state) || state.status !== "completed" || !Array.isArray(state.content)) return part
    const before = images
    const content = state.content.map((item) => {
      const text = imagePlaceholder(item)
      if (text === undefined) return item
      images += 1
      return { type: "text", text }
    })
    if (images === before) return part
    return {
      ...part,
      state: {
        ...state,
        structured: ToolOutputStore.omitBase64(state.structured, ToolOutputStore.MAX_BYTES),
        content,
      },
    }
  })
  return { data: { ...data, content }, images }
}

function imagePlaceholder(item: unknown) {
  if (!isRecord(item) || item.type !== "file" || typeof item.mime !== "string" || !item.mime.startsWith("image/"))
    return undefined
  if (typeof item.uri !== "string") return undefined
  const marker = item.uri.indexOf(";base64,")
  if (!item.uri.startsWith("data:") || marker === -1) return undefined
  const payload = item.uri.slice(marker + ";base64,".length)
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  const bytes = Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
  return `[Image removed from stored history: ${item.mime}, ${(bytes / 1024).toFixed(1)} KiB]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
