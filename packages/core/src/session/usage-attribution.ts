export * as SessionUsageAttribution from "./usage-attribution"

import { Context, Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { Event } from "@ycoding-ai/schema/event"
import { UsageAnchor } from "@ycoding-ai/schema/usage-anchor"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"

export const Current = Context.Reference<UsageAnchor.Ref | null | undefined>(
  "@ycoding/SessionUsageAttribution/Current",
  {
    defaultValue: () => undefined,
  },
)

const contributors = new Map<symbol, { readonly sessionID: SessionSchema.ID; readonly anchor?: UsageAnchor.Ref }>()

export const active = Effect.sync(() => [...contributors.values()])

export function withAnchor<A, E, R>(
  sessionID: SessionSchema.ID,
  anchor: UsageAnchor.Ref | undefined,
  effect: Effect.Effect<A, E, R>,
) {
  const token = Symbol()
  return Effect.acquireUseRelease(
    Effect.sync(() => contributors.set(token, { sessionID, anchor })),
    () => effect.pipe(Effect.provideService(Current, anchor ?? null)),
    () =>
      Effect.sync(() => {
        contributors.delete(token)
      }),
  )
}

export function contribute<A, E, R>(
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const anchor = yield* dispatch(db, sessionID)
    return yield* withAnchor(sessionID, anchor, effect)
  })
}

const admittedType = Event.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)
const promotedType = Event.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version)
const revertedType = Event.versionedType(
  SessionEvent.RevertEvent.Committed.type,
  SessionEvent.RevertEvent.Committed.durable.version,
)
const decodeAnchor = Schema.decodeUnknownOption(Schema.fromJsonString(UsageAnchor.Ref))

export const admitted = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  inputID: SessionMessage.ID,
) {
  let before: number | undefined
  while (true) {
    const rows = yield* db
      .all<{ seq: number; data: string; created: number }>(
        sql`
      SELECT seq, data, created FROM event INDEXED BY event_aggregate_type_seq_idx
      WHERE aggregate_id = ${sessionID} AND type = ${admittedType}
        ${before === undefined ? sql`` : sql`AND seq < ${before}`} ORDER BY seq DESC LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(SessionEvent.InputAdmitted.data))(row.data)
      if (Option.isSome(decoded) && decoded.value.inputID === inputID)
        return { ...decoded.value, timeCreated: row.created }
    }
    yield* Effect.yieldNow
    if (rows.length < 200) return undefined
    before = rows.at(-1)!.seq
  }
})

export const resolve = Effect.fnUntraced(function* (db: Database.Interface["db"], reference: UsageAnchor.Ref) {
  const seen = new Set<string>()
  let cursor = reference
  while (true) {
    const key = JSON.stringify([cursor.sessionID, cursor.inputID])
    if (seen.has(key)) return undefined
    seen.add(key)
    const input = yield* admitted(db, cursor.sessionID, cursor.inputID)
    if (input?.causedBy) {
      cursor = input.causedBy
      continue
    }
    const session = yield* db
      .get<{ parentID: string | null }>(sql`SELECT parent_id AS parentID FROM session WHERE id = ${cursor.sessionID}`)
      .pipe(Effect.orDie)
    if (!session) return undefined
    const task = yield* db
      .get<{
        parentID: SessionSchema.ID
        messageID: SessionMessage.ID
        inputID: SessionMessage.ID
        anchor: string | null
      }>(
        sql`
      SELECT parent_id AS parentID, parent_assistant_message_id AS messageID, input_id AS inputID, usage_anchor AS anchor
      FROM session_task WHERE session_id = ${cursor.sessionID}
    `,
      )
      .pipe(Effect.orDie)
    if (!task || task.inputID !== cursor.inputID) return input?.input.type === "user" ? cursor : undefined
    if (task.anchor !== null) return Option.getOrUndefined(decodeAnchor(task.anchor))
    const parent = yield* db
      .get<{ inputID: SessionMessage.ID }>(
        sql`
      SELECT id AS inputID FROM session_message
      WHERE session_id = ${task.parentID} AND type = 'user' AND seq < (
        SELECT seq FROM session_message WHERE id = ${task.messageID} AND session_id = ${task.parentID}
      ) ORDER BY seq DESC LIMIT 1
    `,
      )
      .pipe(Effect.orDie)
    if (!parent) return undefined
    cursor = { sessionID: task.parentID, inputID: parent.inputID }
  }
})

export const current = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const reverted = yield* db
    .get<{ seq: number }>(
      sql`
    SELECT seq FROM event INDEXED BY event_aggregate_type_seq_idx
    WHERE aggregate_id = ${sessionID} AND type = ${revertedType} ORDER BY seq DESC LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  let before: number | undefined
  while (true) {
    const rows = yield* db
      .all<{ seq: number; inputID: SessionMessage.ID }>(
        sql`
      SELECT seq, json_extract(data, '$.inputID') AS inputID FROM event INDEXED BY event_aggregate_type_seq_idx
      WHERE aggregate_id = ${sessionID} AND type = ${promotedType}
        ${before === undefined ? sql`` : sql`AND seq < ${before}`}
        ${reverted === undefined ? sql`` : sql`AND seq > ${reverted.seq}`}
      ORDER BY seq DESC LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      const anchor = yield* resolve(db, { sessionID, inputID: row.inputID })
      if (anchor) return anchor
    }
    yield* Effect.yieldNow
    if (rows.length < 200) break
    before = rows.at(-1)!.seq
  }
  const user = yield* db
    .get<{ inputID: SessionMessage.ID }>(
      sql`
    SELECT id AS inputID FROM session_message WHERE session_id = ${sessionID} AND type = 'user' ORDER BY seq DESC LIMIT 1
  `,
    )
    .pipe(Effect.orDie)
  return user ? yield* resolve(db, { sessionID, inputID: user.inputID }) : undefined
})

export const dispatch = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const anchor = yield* Current
  return anchor === null ? undefined : (anchor ?? (yield* current(db, sessionID)))
})
