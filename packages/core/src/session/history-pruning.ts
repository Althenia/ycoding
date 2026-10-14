export * as SessionHistoryPruning from "./history-pruning"

import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm"
import { Cause, Clock, Duration, Effect } from "effect"
import { Database } from "../database/database"
import { EventRuntime } from "../event"
import { SessionContextState } from "./context-state"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionCompactionJobTable, SessionContextStateTable, SessionTable } from "./sql"

const errorRetention = Duration.days(7)
const sessionPageSize = 200
const messageBatchSize = 200
const eventBatchSize = 1000

const versioned = (definition: Extract<EventRuntime.Definition, { durability: "durable" }>) =>
  EventRuntime.versionedType(definition.type, definition.durable.version)

const contextObservedType = versioned(SessionEvent.ContextObserved)
const latestReadTypes = [
  SessionEvent.ContextObserved,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Execution.Failed,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
].map(versioned)
const messageEventTypes = [
  SessionEvent.Synthetic,
  SessionEvent.ContextObserved,
  SessionEvent.Skill.Activated,
  SessionEvent.Skill.Deactivated,
  SessionEvent.Shell.Started,
  SessionEvent.Shell.Ended,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Text.Started,
  SessionEvent.Text.Ended,
  SessionEvent.Reasoning.Started,
  SessionEvent.Reasoning.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Input.Ended,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Progress,
  SessionEvent.Tool.Success,
  SessionEvent.RetryScheduled,
  SessionEvent.InputConsumed,
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Interrupted,
].map(versioned)
const errorEventTypes = [
  SessionEvent.Step.Failed,
  SessionEvent.Tool.Failed,
  SessionEvent.Execution.Failed,
  SessionEvent.Compaction.Failed,
].map(versioned)

export interface Result {
  readonly messages: number
  readonly events: number
}

const none: Result = { messages: 0, events: 0 }

export function make(db: Database.Interface["db"], active: Effect.Effect<ReadonlySet<SessionSchema.ID>>) {
  const list = (values: ReadonlyArray<string | number>) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    )

  const eligible = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, manifestDigest: string) {
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

  const eventPlan = Effect.fnUntraced(function* (
    sessionID: SessionSchema.ID,
    checkpoint: SessionContextState.Checkpoint,
    now: number,
  ) {
    const expired = yield* db
      .get<{ seq: number | null }>(
        sql`SELECT max(json_extract(blob.content, '$.summary.coveredThrough.seq')) AS seq
          FROM session_compaction_job AS job
          JOIN compaction_manifest_blob AS blob ON blob.digest = job.manifest_digest
          WHERE job.session_id = ${sessionID} AND job.status = 'ended'
            AND job.time_ended <= ${now - Duration.toMillis(errorRetention)}`,
      )
      .pipe(Effect.orDie)
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
      errorFloor: Math.min(checkpoint.coveredThrough.seq, expired?.seq ?? 0),
      latest: latest.map((row) => row.seq),
      messages: kept.map((row) => row.id),
      shells: kept.flatMap((row) => (row.shellID === null ? [] : [row.shellID])),
    }
  })

  const deleteMessages = (sessionID: SessionSchema.ID, through: number) =>
    db
      .all<{ id: string }>(
        sql`DELETE FROM session_message WHERE rowid IN (
          SELECT rowid FROM session_message
          WHERE session_id = ${sessionID} AND seq < ${through} AND type <> 'compaction'
            AND id IS NOT (
              SELECT id FROM session_message WHERE session_id = ${sessionID} AND type = 'user' ORDER BY seq LIMIT 1
            )
            AND id NOT IN (
              SELECT fork_message_id FROM session WHERE fork_session_id = ${sessionID} AND fork_message_id IS NOT NULL
            )
          ORDER BY seq LIMIT ${messageBatchSize}
        ) RETURNING id`,
      )
      .pipe(Effect.orDie)

  const deleteEvents = (sessionID: SessionSchema.ID, plan: Effect.Success<ReturnType<typeof eventPlan>>) =>
    db
      .all<{ id: string }>(
        sql`DELETE FROM event WHERE rowid IN (
          SELECT rowid FROM event
          WHERE aggregate_id = ${sessionID}
            AND ((type IN (${list(messageEventTypes)}) AND seq < ${plan.floor})
              OR (type IN (${list(errorEventTypes)}) AND seq < ${plan.errorFloor}))
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
          LIMIT ${eventBatchSize}
        ) RETURNING id`,
      )
      .pipe(Effect.orDie)

  const batches = Effect.fnUntraced(function* (
    sessionID: SessionSchema.ID,
    manifestDigest: string,
    remove: () => Effect.Effect<ReadonlyArray<{ id: string }>>,
  ) {
    let deleted = 0
    while (true) {
      const count = yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              if (!(yield* eligible(sessionID, manifestDigest))) return 0
              return (yield* remove()).length
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (count === 0) return deleted
      deleted += count
      yield* Effect.yieldNow
    }
  })

  const prune = Effect.fn("SessionHistoryPruning.prune")(function* (sessionID: SessionSchema.ID) {
    const now = yield* Clock.currentTimeMillis
    const checkpoint = yield* SessionContextState.checkpoint(db, sessionID)
    if (!checkpoint) return none
    const messages = yield* batches(sessionID, checkpoint.manifestDigest, () =>
      deleteMessages(sessionID, checkpoint.coveredThrough.seq),
    )
    const plan = yield* eventPlan(sessionID, checkpoint, now)
    const events = yield* batches(sessionID, checkpoint.manifestDigest, () => deleteEvents(sessionID, plan))
    return { messages, events } satisfies Result
  })

  const sweep = Effect.fn("SessionHistoryPruning.sweep")(function* () {
    let cursor: SessionSchema.ID | undefined
    let result = none
    while (true) {
      const page = yield* db
        .select({ sessionID: SessionContextStateTable.session_id })
        .from(SessionContextStateTable)
        .where(
          and(
            eq(SessionContextStateTable.status, "active"),
            isNotNull(SessionContextStateTable.manifest_digest),
            cursor === undefined ? undefined : gt(SessionContextStateTable.session_id, cursor),
          ),
        )
        .orderBy(asc(SessionContextStateTable.session_id))
        .limit(sessionPageSize)
        .all()
        .pipe(Effect.orDie)
      for (const row of page) {
        const pruned = yield* prune(row.sessionID).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("session history pruning could not prune session", {
                sessionID: row.sessionID,
                cause,
              }).pipe(Effect.as(none)),
          ),
        )
        result = { messages: result.messages + pruned.messages, events: result.events + pruned.events }
      }
      if (page.length < sessionPageSize) break
      cursor = page.at(-1)!.sessionID
    }
    if (result.messages > 0 || result.events > 0) {
      yield* Effect.logInfo("session history pruning deleted compacted history", result)
      yield* Database.reclaim(db).pipe(Effect.orDie)
    }
    return result
  })

  return { prune, sweep }
}
