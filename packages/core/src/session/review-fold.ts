export * as SessionReviewFold from "./review-fold"

import { Session } from "@ycoding-ai/schema/session"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Form } from "@ycoding-ai/schema/form"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Clock, Effect, Option, Schema } from "effect"
import { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { ModelIncident } from "../model-incident/index"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionMessageTable, SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"

export const ID = SessionReview.ID
export type ID = typeof ID.Type

export class FullError extends Schema.TaggedErrorClass<FullError>()("SessionReview.FullError", {
  sessionID: Session.ID,
  limit: Schema.Int,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionReview.NotFoundError", {
  itemID: ID,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionReview.ConflictError", {
  itemID: ID,
  message: Schema.String,
}) {}

export class InvalidDecisionError extends Schema.TaggedErrorClass<InvalidDecisionError>()(
  "SessionReview.InvalidDecisionError",
  { itemID: ID, message: Schema.String },
) {}

export interface OpenInput {
  readonly sessionID: Session.ID
  readonly rootID?: Session.ID
  readonly kind: SessionReview.Kind
  readonly reason: SessionReview.Reason
  readonly choice?: string
  readonly confidence?: number
  readonly grades?: ReadonlyArray<Guardrail.Grade>
  readonly origin: SessionReview.Origin
  readonly payload: SessionReview.Payload
  readonly limit: number
  readonly conversion?: boolean
}

export interface Folded {
  readonly itemID: ID
  readonly sessionID: Session.ID
  readonly kind: SessionReview.Kind
  readonly reason: SessionReview.Reason
  readonly choice?: string
  readonly confidence?: number
  readonly grades?: ReadonlyArray<Guardrail.Grade>
  readonly origin: SessionReview.Origin
  readonly payload: SessionReview.Payload
  readonly created: number
  readonly decision?: SessionReview.Decision
  readonly withdrawn?: "reverted" | "task_closed"
  readonly consumed: boolean
  readonly revision: number
  readonly source?: Form.DotsClientReplySource
}

type DatabaseClient = Database.Interface["db"]

const locks = KeyedMutex.makeUnsafe<Session.ID>()
export const withFamilyLock = locks.withLock

const deferredType = EventRuntime.versionedType(SessionEvent.Review.Deferred.type, 1)
const decidedType = EventRuntime.versionedType(SessionEvent.Review.Decided.type, 1)
const withdrawnType = EventRuntime.versionedType(SessionEvent.Review.Withdrawn.type, 1)
const consumedType = EventRuntime.versionedType(SessionEvent.Review.Consumed.type, 1)
const reviewTypes = [deferredType, decidedType, withdrawnType, consumedType]

const decodeDeferred = Schema.decodeUnknownOption(SessionEvent.Review.Deferred.data)
const decodeDecided = Schema.decodeUnknownOption(SessionEvent.Review.Decided.data)
const decodeWithdrawn = Schema.decodeUnknownOption(SessionEvent.Review.Withdrawn.data)
const decodeConsumed = Schema.decodeUnknownOption(SessionEvent.Review.Consumed.data)

export function fingerprint(input: {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly workdir: string
  readonly ruleIDs?: ReadonlyArray<string>
  readonly hardReview?: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
}): SessionReview.Fingerprint {
  return Hash.json({
    action: input.action,
    resources: [...input.resources],
    workdir: input.workdir,
    ruleIDs: [...(input.ruleIDs ?? [])].toSorted(),
    hardReview: input.hardReview ?? false,
    metadata: input.metadata ?? {},
  }) as SessionReview.Fingerprint
}

export function promptID(itemID: ID): SessionMessage.ID {
  return SessionMessage.ID.make(`msg_review_${Hash.sha256(itemID).slice(0, 24)}`)
}

export function pendingFingerprint(item: Folded) {
  return Hash.json(item.payload.type === "permission" ? { ...item,
    payload: Object.fromEntries(Object.entries(item.payload).filter(([key]) => key !== "fingerprintVersion")),
  } : item)
}

export function matchesFingerprint(payload: SessionReview.Payload, expected: string, historical?: string) {
  return "fingerprint" in payload && (payload.fingerprint === expected ||
    (payload.type === "permission" && payload.fingerprintVersion === 1 && historical !== undefined && payload.fingerprint === historical))
}

export const rootOf = Effect.fnUntraced(function* (db: DatabaseClient, sessionID: Session.ID) {
  let current: Session.ID = sessionID
  while (true) {
    const row = yield* db
      .select({ parentID: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, current))
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    if (!row.parentID) return current
    current = row.parentID
  }
})

export interface FamilySession {
  readonly id: Session.ID
  readonly title: string
  readonly archived: boolean
}

export const familySessions = Effect.fnUntraced(function* (db: DatabaseClient, rootID: Session.ID) {
  const sessions: FamilySession[] = []
  const queue: Session.ID[] = [rootID]
  while (queue.length > 0) {
    const id = queue.shift()!
    const row = yield* db
      .select({ id: SessionTable.id, title: SessionTable.title, archived: SessionTable.time_archived })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie)
    if (!row) {
      sessions.push({ id, title: "", archived: false })
      continue
    }
    sessions.push({ id: row.id, title: row.title, archived: row.archived !== null })
    const children = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.parent_id, id))
      .orderBy(asc(SessionTable.id))
      .all()
      .pipe(Effect.orDie)
    queue.push(...children.map((child) => child.id))
  }
  return sessions
})

export const fold = Effect.fnUntraced(function* (db: DatabaseClient, sessionIDs: ReadonlyArray<Session.ID>) {
  if (sessionIDs.length === 0) return [] as Folded[]
  const rows = yield* db
    .select({ aggregate: EventTable.aggregate_id, type: EventTable.type, data: EventTable.data, created: EventTable.created, revision: EventTable.seq })
    .from(EventTable)
    .where(and(inArray(EventTable.aggregate_id, [...sessionIDs]), inArray(EventTable.type, reviewTypes)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const items = new Map<string, Folded>()
  for (const row of rows) {
    if (row.type === deferredType) {
      const data = decodeDeferred(row.data)
      if (Option.isNone(data)) continue
      items.set(data.value.itemID, {
        itemID: data.value.itemID,
        sessionID: Session.ID.make(row.aggregate),
        kind: data.value.kind,
        reason: data.value.reason,
        ...(data.value.choice === undefined ? {} : { choice: data.value.choice }),
        ...(data.value.confidence === undefined ? {} : { confidence: data.value.confidence }),
        ...(data.value.grades === undefined ? {} : { grades: data.value.grades }),
        origin: data.value.origin,
        payload: data.value.payload,
        created: row.created,
        consumed: false,
        revision: row.revision,
      })
      continue
    }
    if (row.type === decidedType) {
      const data = decodeDecided(row.data)
      if (Option.isNone(data)) continue
      const current = items.get(data.value.itemID)
      if (current) items.set(current.itemID, { ...current, decision: data.value.decision, revision: row.revision, ...(data.value.source === undefined ? {} : { source: data.value.source }) })
      continue
    }
    if (row.type === withdrawnType) {
      const data = decodeWithdrawn(row.data)
      if (Option.isNone(data)) continue
      const current = items.get(data.value.itemID)
      if (current) items.set(current.itemID, { ...current, withdrawn: data.value.reason, revision: row.revision })
      continue
    }
    const data = decodeConsumed(row.data)
    if (Option.isNone(data)) continue
    const current = items.get(data.value.itemID)
    if (current) items.set(current.itemID, { ...current, consumed: true, revision: row.revision })
  }
  return Array.from(items.values()).toSorted((left, right) => (left.itemID < right.itemID ? -1 : 1))
})

export const isOpen = (item: Folded) => item.decision === undefined && item.withdrawn === undefined

export const familyFold = Effect.fnUntraced(function* (db: DatabaseClient, sessionID: Session.ID) {
  const rootID = yield* rootOf(db, sessionID)
  if (!rootID) return undefined
  const sessions = yield* familySessions(db, rootID)
  const folded = yield* fold(db, sessions.map((session) => session.id))
  return { rootID, sessions, folded }
})

export const openCount = Effect.fnUntraced(function* (db: DatabaseClient, sessionID: Session.ID) {
  const family = yield* familyFold(db, sessionID)
  if (!family) return 0
  return family.folded.filter(isOpen).length
})

export const toItem = Effect.fnUntraced(function* (
  db: DatabaseClient,
  rootID: Session.ID,
  sessions: ReadonlyArray<FamilySession>,
  folded: Folded,
) {
  const owner = sessions.find((session) => session.id === folded.sessionID)
  const task = yield* db
    .select({ agent: SessionTaskTable.agent, description: SessionTaskTable.description })
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.session_id, folded.sessionID))
    .get()
    .pipe(Effect.orDie)
  const raw = {
    itemID: folded.itemID,
    kind: folded.kind,
    reason: folded.reason,
    ...(folded.choice === undefined ? {} : { choice: folded.choice }),
    ...(folded.confidence === undefined ? {} : { confidence: folded.confidence }),
    ...(folded.grades === undefined ? {} : { grades: folded.grades }),
    origin: folded.origin,
    payload: folded.payload,
    sessionID: folded.sessionID,
    rootSessionID: rootID,
    sessionTitle: owner?.title ?? "",
    created: folded.created,
    ...(task ? { child: { agent: task.agent, description: task.description } } : {}),
  }
  return yield* Schema.decodeUnknownEffect(SessionReview.Item)(raw).pipe(Effect.orDie)
})

export const open = Effect.fn("SessionReviewFold.open")(function* (
  db: DatabaseClient,
  events: EventRuntime.Interface,
  input: OpenInput,
) {
  const rootID = input.rootID ?? (yield* rootOf(db, input.sessionID))
  if (!rootID) return yield* Effect.die(new Error(`Session not found: ${input.sessionID}`))
  return yield* withFamilyLock(rootID)(
    Effect.gen(function* () {
      const sessions = yield* familySessions(db, rootID)
      const folded = yield* fold(db, sessions.map((session) => session.id))
      if (!input.conversion && folded.filter(isOpen).length >= input.limit)
        return yield* new FullError({ sessionID: input.sessionID, limit: input.limit })
      const itemID = ID.create()
      const time = yield* Clock.currentTimeMillis
      const payload = input.payload
      yield* events.publish(
        SessionEvent.Review.Deferred,
        {
          sessionID: input.sessionID,
          itemID,
          kind: input.kind,
          reason: input.reason,
          ...(input.choice === undefined ? {} : { choice: input.choice }),
          ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
          ...(input.grades === undefined ? {} : { grades: input.grades }),
          origin: input.origin,
          payload,
        } as SessionEvent.Review.Deferred["data"],
        payload.type === "guardrail" && input.reason !== "sleep_entry" && input.reason !== "disabled"
          ? {
              commit: () =>
                ModelIncident.recordEscalation(db, {
                  sessionID: input.sessionID,
                  requestID: payload.requestID,
                  ...("messageID" in input.origin ? { messageID: input.origin.messageID } : {}),
                  ruleIDs: payload.ruleIDs,
                  hardReview: payload.hardReview,
                  time,
                }),
            }
          : undefined,
      )
      const created = (yield* fold(db, [input.sessionID])).find((item) => item.itemID === itemID)
      if (!created) return yield* Effect.die(new Error(`Review item was not recorded: ${itemID}`))
      return yield* toItem(db, rootID, sessions, created)
    }),
  )
})

export const withdrawItem = Effect.fnUntraced(function* (
  events: EventRuntime.Interface,
  sessionID: Session.ID,
  itemID: ID,
  reason: "reverted" | "task_closed",
) {
  yield* events.publish(SessionEvent.Review.Withdrawn, { sessionID, itemID, reason })
})

export const withdrawSession = Effect.fn("SessionReviewFold.withdrawSession")(function* (
  db: DatabaseClient,
  events: EventRuntime.Interface,
  sessionID: Session.ID,
  reason: "reverted" | "task_closed",
) {
  const folded = yield* fold(db, [sessionID])
  yield* Effect.forEach(
    folded.filter(isOpen),
    (item) => withdrawItem(events, sessionID, item.itemID, reason),
    { discard: true },
  )
})

const messageSeq = Effect.fnUntraced(function* (
  db: DatabaseClient,
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
) {
  const message = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, messageID))
    .get()
    .pipe(Effect.orDie)
  if (message) return message.seq
  const pending = yield* db
    .select({ seq: SessionPendingTable.admitted_seq })
    .from(SessionPendingTable)
    .where(and(eq(SessionPendingTable.id, messageID), eq(SessionPendingTable.session_id, sessionID)))
    .get()
    .pipe(Effect.orDie)
  return pending?.seq
})

export const withdrawals = Effect.fn("SessionReviewFold.withdrawals")(function* (
  db: DatabaseClient,
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  inclusive = false,
) {
  const boundary = yield* messageSeq(db, sessionID, messageID)
  if (boundary === undefined) return []
  const folded = yield* fold(db, [sessionID])
  const withdrawn: SessionEvent.Review.Withdrawn["data"][] = []
  for (const item of folded) {
    if (item.withdrawn !== undefined || item.consumed) continue
    if (!("messageID" in item.origin)) continue
    const seq = yield* messageSeq(db, sessionID, item.origin.messageID)
    if (seq !== undefined && (inclusive ? seq >= boundary : seq > boundary))
      withdrawn.push({ sessionID, itemID: item.itemID, reason: "reverted" })
  }
  return withdrawn
})

export const withdrawAfter = Effect.fn("SessionReviewFold.withdrawAfter")(function* (
  db: DatabaseClient,
  events: EventRuntime.Interface,
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
) {
  const items = yield* withdrawals(db, sessionID, messageID)
  yield* events.publishBatch(items.map((data) => ({ definition: SessionEvent.Review.Withdrawn, data })))
})

export const consume = Effect.fn("SessionReviewFold.consume")(function* (
  db: DatabaseClient,
  events: EventRuntime.Interface,
  sessionID: Session.ID,
  kind: "guardrail" | "permission",
  expected: string,
  historical?: string,
) {
  const rootID = yield* rootOf(db, sessionID)
  if (!rootID) return false
  return yield* withFamilyLock(rootID)(
    Effect.gen(function* () {
      const folded = yield* fold(db, [sessionID])
      const grant = folded.find(
        (item) =>
          item.kind === kind &&
          item.withdrawn === undefined &&
          !item.consumed &&
          item.decision !== undefined &&
          "reply" in item.decision &&
          item.decision.reply !== "reject" &&
          matchesFingerprint(item.payload, expected, historical),
      )
      if (!grant) return false
      yield* events.publish(SessionEvent.Review.Consumed, { sessionID, itemID: grant.itemID })
      return true
    }),
  )
})

export const ownsQuestion = Effect.fnUntraced(function* (
  db: DatabaseClient,
  sessionID: Session.ID,
  questionID: string,
) {
  const task = yield* db.select({ state: SessionTaskTable.state, questionID: SessionTaskTable.question_id }).from(SessionTaskTable)
    .where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
  if (task?.state !== "waiting" || task.questionID !== questionID) return false
  const folded = yield* fold(db, [sessionID])
  return folded.some(
    (item) =>
      item.withdrawn === undefined &&
      (item.kind === "subagent_question" || item.kind === "recovery") &&
      "questionID" in item.origin &&
      item.origin.questionID === questionID,
  )
})

export const isStoppedRecovery = (item: Folded) =>
  item.kind === "recovery" &&
  item.withdrawn === undefined &&
  item.decision?.kind === "recovery" &&
  "choice" in item.decision &&
  item.decision.choice === "stop"

export const stoppedRecovery = Effect.fnUntraced(function* (db: DatabaseClient, sessionID: Session.ID) {
  return (yield* fold(db, [sessionID])).findLast(isStoppedRecovery)?.itemID
})

export const decidedAggregates = Effect.fnUntraced(function* (db: DatabaseClient) {
  const rows = yield* db
    .select({ aggregate: EventTable.aggregate_id })
    .from(EventTable)
    .where(eq(EventTable.type, decidedType))
    .all()
    .pipe(Effect.orDie)
  return Array.from(new Set(rows.map((row) => Session.ID.make(row.aggregate))))
})
