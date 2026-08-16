export * as SessionCompactionJob from "./compaction-job"

import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { Context, Data, DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import {
  CompactionManifestBlobTable,
  SessionCompactionJobTable,
  SessionContextStateTable,
  SessionMessageTable,
} from "./sql"

type DatabaseService = Database.Interface["db"]
type Row = typeof SessionCompactionJobTable.$inferSelect

export type Status = Row["status"]

export interface Job {
  readonly id: SessionCompaction.ID
  readonly sessionID: SessionSchema.ID
  readonly trigger: SessionCompaction.Trigger
  readonly admissionMode: SessionCompaction.AdmissionMode
  readonly requestedThrough: SessionCompaction.Boundary
  readonly baseContextRevision: number
  readonly legacyInputID?: NonNullable<Row["legacy_input_id"]>
  readonly targetMaxInputTokens?: number
  readonly configDigest?: string
  readonly status: Status
  readonly attempts: number
  readonly timeCreated: number
  readonly leaseOwner?: string
  readonly leaseExpiresAt?: number
  readonly manifestDigest?: string
  readonly errorCode?: SessionCompaction.FailureCode
  readonly errorMessage?: string
  readonly timeStarted?: number
  readonly timeEnded?: number
}

export interface AdmitInput {
  readonly id?: SessionCompaction.ID
  readonly sessionID: SessionSchema.ID
  readonly trigger: SessionCompaction.Trigger
  readonly admissionMode: SessionCompaction.AdmissionMode
  readonly requestedThrough: SessionCompaction.Boundary
  readonly baseContextRevision: number
  readonly targetMaxInputTokens: number
  readonly configDigest: string
}

type Lease = {
  readonly owner: string
  readonly now: number
  readonly expiresAt: number
}

export type ClaimInput = Lease &
  (
    | { readonly sessionID: SessionSchema.ID; readonly jobID?: never }
    | { readonly jobID: SessionCompaction.ID; readonly sessionID?: never }
  )

export interface EndInput {
  readonly id: SessionCompaction.ID
  readonly owner: string
  readonly manifestDigest: string
  readonly revision: number
  readonly boundary: SessionCompaction.Boundary
  readonly metrics: SessionCompaction.Metrics
  readonly now: number
}

export interface FailInput {
  readonly id: SessionCompaction.ID
  readonly owner?: string
  readonly code: SessionCompaction.FailureCode
  readonly now: number
}

export interface Recovery {
  readonly sessionID: SessionSchema.ID
  readonly at: number
}

export class Conflict extends Data.TaggedError("SessionCompactionJob.Conflict")<{
  readonly message: string
  readonly id?: SessionCompaction.ID
}> {}

export class Ownership extends Data.TaggedError("SessionCompactionJob.Ownership")<{
  readonly id: SessionCompaction.ID
  readonly owner?: string
  readonly message: string
}> {}

export type Admit = (input: AdmitInput) => Effect.Effect<SessionCompaction.Admission, Conflict>

export interface Interface {
  readonly admit: Admit
  readonly withAdmissionGate: <A, E, R>(
    sessionID: SessionSchema.ID,
    use: (admit: Admit) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Conflict, R>
  readonly get: (id: SessionCompaction.ID) => Effect.Effect<Job | undefined>
  readonly pending: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Job>>
  readonly claim: (input: ClaimInput) => Effect.Effect<Job | undefined, Conflict>
  readonly heartbeat: (
    id: SessionCompaction.ID,
    owner: string,
    expiresAt: number,
  ) => Effect.Effect<Job, Conflict | Ownership>
  readonly end: (input: EndInput) => Effect.Effect<Job, Conflict | Ownership>
  readonly fail: (input: FailInput) => Effect.Effect<Job, Conflict | Ownership>
  readonly recoverable: (now: number) => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly recoverySchedule: (now: number) => Effect.Effect<ReadonlyArray<Recovery>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCompactionJob") {}

const admissionLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
const stateLocks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service

    const admit: Interface["admit"] = (input) =>
      admissionLocks.withLock(input.sessionID)(stateLocks.withLock(input.sessionID)(admitUnlocked(db, events, input)))

    const withAdmissionGate: Interface["withAdmissionGate"] = (sessionID, use) =>
      admissionLocks.withLock(sessionID)(
        Effect.suspend(() =>
          use((input) => {
            if (input.sessionID !== sessionID)
              return conflict(input.id, "In-gate compaction admission must target the gated Session")
            return stateLocks.withLock(sessionID)(admitUnlocked(db, events, input))
          }),
        ),
      )

    const claim: Interface["claim"] = (input) =>
      Effect.gen(function* () {
        const row = input.jobID ? yield* findRow(db, input.jobID) : undefined
        if (input.jobID && !row) return undefined
        if (input.sessionID) return yield* stateLocks.withLock(input.sessionID)(claimUnlocked(db, events, input))
        if (!row) return undefined
        return yield* stateLocks.withLock(row.session_id)(claimUnlocked(db, events, input))
      })

    const heartbeat: Interface["heartbeat"] = (id, owner, expiresAt) =>
      Effect.gen(function* () {
        if (!owner || !isNonnegativeInteger(expiresAt)) return yield* conflict(id, "Heartbeat lease values are invalid")
        const updated = yield* db
          .update(SessionCompactionJobTable)
          .set({ lease_expires_at: expiresAt })
          .where(
            and(
              eq(SessionCompactionJobTable.id, id),
              eq(SessionCompactionJobTable.status, "running"),
              eq(SessionCompactionJobTable.lease_owner, owner),
              isNull(SessionCompactionJobTable.legacy_input_id),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (updated) return fromRow(updated)
        const current = yield* findRow(db, id)
        if (!current) return yield* conflict(id, "Compaction job does not exist")
        return yield* ownership(id, owner, "Compaction heartbeat is not owned by this lease")
      })

    const end: Interface["end"] = (input) =>
      withExistingJob(db, input.id, (row) => stateLocks.withLock(row.session_id)(endUnlocked(db, events, input)))

    const fail: Interface["fail"] = (input) =>
      withExistingJob(db, input.id, (row) => stateLocks.withLock(row.session_id)(failUnlocked(db, events, input)))

    return Service.of({
      admit,
      withAdmissionGate,
      get: (id) => findRow(db, id).pipe(Effect.map((row) => (row ? fromRow(row) : undefined))),
      pending: (sessionID) =>
        db
          .select()
          .from(SessionCompactionJobTable)
          .where(
            and(
              eq(SessionCompactionJobTable.session_id, sessionID),
              inArray(SessionCompactionJobTable.status, ["pending", "running"]),
              isNull(SessionCompactionJobTable.legacy_input_id),
            ),
          )
          .orderBy(asc(SessionCompactionJobTable.time_created), asc(SessionCompactionJobTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.map(fromRow)),
          ),
      claim,
      heartbeat,
      end,
      fail,
      recoverable: (now) => recoverable(db, now),
      recoverySchedule: (now) => recoverySchedule(db, now),
    })
  }),
)

export const node = makeGlobalNode({
  name: "session-compaction-job",
  layer,
  deps: [Database.node, EventV2.node],
})

const admitUnlocked = Effect.fn("SessionCompactionJob.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: AdmitInput,
): Effect.fn.Return<SessionCompaction.Admission, Conflict> {
  if (input.id) {
    const exact = yield* findRow(db, input.id)
    if (exact) {
      if (matchesAdmission(exact, input)) return admissionFromRow(exact)
      return yield* conflict(input.id, "Compaction job ID was reused with different admission input")
    }
  }
  yield* validateAdmission(db, input)
  const now = DateTime.toEpochMillis(yield* DateTime.now)
  const pending = yield* db
    .select()
    .from(SessionCompactionJobTable)
    .where(
      and(
        eq(SessionCompactionJobTable.session_id, input.sessionID),
        eq(SessionCompactionJobTable.status, "pending"),
        isNull(SessionCompactionJobTable.legacy_input_id),
      ),
    )
    .orderBy(asc(SessionCompactionJobTable.time_created), asc(SessionCompactionJobTable.id))
    .all()
    .pipe(Effect.orDie)
  if (pending.length > 1) return yield* conflict(input.id, "Session has more than one pending compaction job")
  const existing = pending[0]
  if (existing && compatible(existing, input)) return yield* advanceBoundary(db, existing, input.requestedThrough)
  if (existing)
    yield* settleFailed(db, events, existing, { id: existing.id, code: "superseded", now }).pipe(
      Effect.catchDefect(defectToConflict),
    )
  return yield* publishAdmission(db, events, input, now)
})

const publishAdmission = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: AdmitInput,
  now: number,
): Effect.fn.Return<SessionCompaction.Admission, Conflict> {
  const id = input.id ?? SessionCompaction.ID.create()
  yield* events
    .publish(
      SessionEvent.Compaction.Admitted,
      { sessionID: input.sessionID, jobID: id },
      {
        commit: () =>
          db
            .insert(SessionCompactionJobTable)
            .values({
              id,
              session_id: input.sessionID,
              trigger: input.trigger,
              admission_mode: input.admissionMode,
              requested_through_message_id: input.requestedThrough.messageID,
              requested_through_seq: input.requestedThrough.seq,
              base_context_revision: input.baseContextRevision,
              target_max_input_tokens: input.targetMaxInputTokens,
              config_digest: input.configDigest,
              status: "pending",
              attempts: 0,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie),
      },
    )
    .pipe(Effect.catchDefect(defectToConflict))
  const stored = yield* findRow(db, id)
  if (!stored) return yield* conflict(id, "Compaction admission did not create its durable row")
  return admissionFromRow(stored)
})

const claimUnlocked = Effect.fn("SessionCompactionJob.claim")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: ClaimInput,
): Effect.fn.Return<Job | undefined, Conflict> {
  if (
    !input.owner ||
    !isNonnegativeInteger(input.now) ||
    !isNonnegativeInteger(input.expiresAt) ||
    input.expiresAt <= input.now
  )
    return yield* conflict(input.jobID, "Compaction claim lease values are invalid")
  const target = input.jobID
    ? yield* findRow(db, input.jobID)
    : input.sessionID
      ? yield* nextClaimable(db, input.sessionID, input.now)
      : undefined
  if (!target) return undefined
  if (input.sessionID && target.session_id !== input.sessionID) return undefined
  if (target.legacy_input_id !== null)
    return yield* conflict(target.id, "Legacy compaction work is not claimable by this authority")
  if (target.status === "running") {
    if (target.lease_expires_at === null || target.lease_expires_at > input.now) return undefined
    const reclaimed = yield* db
      .update(SessionCompactionJobTable)
      .set({
        lease_owner: input.owner,
        lease_expires_at: input.expiresAt,
        attempts: sql`${SessionCompactionJobTable.attempts} + 1`,
      })
      .where(
        and(
          eq(SessionCompactionJobTable.id, target.id),
          eq(SessionCompactionJobTable.status, "running"),
          lte(SessionCompactionJobTable.lease_expires_at, input.now),
          isNull(SessionCompactionJobTable.legacy_input_id),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return reclaimed ? fromRow(reclaimed) : undefined
  }
  if (target.status !== "pending") return undefined
  const running = yield* db
    .select({ id: SessionCompactionJobTable.id })
    .from(SessionCompactionJobTable)
    .where(
      and(
        eq(SessionCompactionJobTable.session_id, target.session_id),
        eq(SessionCompactionJobTable.status, "running"),
        isNull(SessionCompactionJobTable.legacy_input_id),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (running) return undefined
  yield* events
    .publish(
      SessionEvent.Compaction.Started,
      { sessionID: target.session_id, jobID: target.id },
      {
        commit: () =>
          Effect.gen(function* () {
            const competing = yield* db
              .select({ id: SessionCompactionJobTable.id })
              .from(SessionCompactionJobTable)
              .where(
                and(
                  eq(SessionCompactionJobTable.session_id, target.session_id),
                  eq(SessionCompactionJobTable.status, "running"),
                  isNull(SessionCompactionJobTable.legacy_input_id),
                ),
              )
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (competing)
              return yield* Effect.die(
                new Conflict({ id: target.id, message: "Session already has running compaction work" }),
              )
            const claimed = yield* db
              .update(SessionCompactionJobTable)
              .set({
                status: "running",
                lease_owner: input.owner,
                lease_expires_at: input.expiresAt,
                attempts: sql`${SessionCompactionJobTable.attempts} + 1`,
                time_started: input.now,
              })
              .where(
                and(
                  eq(SessionCompactionJobTable.id, target.id),
                  eq(SessionCompactionJobTable.status, "pending"),
                  isNull(SessionCompactionJobTable.legacy_input_id),
                ),
              )
              .returning({ id: SessionCompactionJobTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!claimed)
              return yield* Effect.die(
                new Conflict({ id: target.id, message: "Compaction claim lost its pending authority" }),
              )
          }),
      },
    )
    .pipe(Effect.catchDefect(defectToConflict))
  const claimed = yield* findRow(db, target.id)
  if (!claimed) return yield* conflict(target.id, "Claimed compaction job no longer exists")
  return fromRow(claimed)
})

const endUnlocked = Effect.fn("SessionCompactionJob.end")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: EndInput,
): Effect.fn.Return<Job, Conflict | Ownership> {
  const row = yield* requireRow(db, input.id)
  if (row.legacy_input_id !== null)
    return yield* conflict(input.id, "Legacy compaction work is not settled by this authority")
  if (row.status === "ended") {
    if (row.manifest_digest === input.manifestDigest) return fromRow(row)
    return yield* conflict(input.id, "Ended compaction job was settled with a different manifest")
  }
  if (row.status !== "running") return yield* ownership(input.id, input.owner, "Compaction job is not running")
  if (row.lease_owner !== input.owner)
    return yield* ownership(input.id, input.owner, "Compaction settlement is not owned by this lease")
  if (
    input.revision !== row.base_context_revision + 1 ||
    input.boundary.messageID !== row.requested_through_message_id ||
    input.boundary.seq !== row.requested_through_seq
  )
    return yield* conflict(input.id, "Compaction settlement does not match its admitted revision and boundary")
  if (!DIGEST.test(input.manifestDigest) || !isNonnegativeInteger(input.now) || !validMetrics(input.metrics))
    return yield* conflict(input.id, "Compaction settlement values are invalid")
  const manifest = yield* db
    .select({ digest: CompactionManifestBlobTable.digest })
    .from(CompactionManifestBlobTable)
    .where(eq(CompactionManifestBlobTable.digest, input.manifestDigest))
    .get()
    .pipe(Effect.orDie)
  if (!manifest) return yield* conflict(input.id, "Compaction manifest is not durable")
  yield* events
    .publish(
      SessionEvent.Compaction.Ended,
      {
        sessionID: row.session_id,
        jobID: row.id,
        revision: input.revision,
        boundary: input.boundary,
        metrics: input.metrics,
      },
      {
        commit: () =>
          Effect.gen(function* () {
            const ended = yield* db
              .update(SessionCompactionJobTable)
              .set({
                status: "ended",
                lease_owner: null,
                lease_expires_at: null,
                manifest_digest: input.manifestDigest,
                time_ended: input.now,
              })
              .where(
                and(
                  eq(SessionCompactionJobTable.id, row.id),
                  eq(SessionCompactionJobTable.status, "running"),
                  eq(SessionCompactionJobTable.lease_owner, input.owner),
                ),
              )
              .returning({ id: SessionCompactionJobTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!ended)
              return yield* Effect.die(
                new Ownership({
                  id: row.id,
                  owner: input.owner,
                  message: "Compaction settlement lost lease ownership",
                }),
              )
          }),
      },
    )
    .pipe(Effect.catchDefect(defectToFailure))
  return fromRow(yield* requireRow(db, row.id))
})

const failUnlocked = Effect.fn("SessionCompactionJob.fail")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: FailInput,
): Effect.fn.Return<Job, Conflict | Ownership> {
  const row = yield* requireRow(db, input.id)
  if (row.legacy_input_id !== null)
    return yield* conflict(input.id, "Legacy compaction work is not settled by this authority")
  if (row.status === "failed") {
    if (row.error_code === input.code) return fromRow(row)
    return yield* conflict(input.id, "Failed compaction job was settled with a different code")
  }
  if (row.status === "ended") return yield* conflict(input.id, "Ended compaction job cannot fail")
  if (!isNonnegativeInteger(input.now)) return yield* conflict(input.id, "Compaction failure time is invalid")
  if (row.status === "pending" && input.code !== "cancelled" && input.code !== "superseded")
    return yield* conflict(input.id, "Pending compaction work can only be cancelled or superseded")
  if (row.status === "pending" && input.owner)
    return yield* ownership(input.id, input.owner, "Pending compaction work has no lease owner")
  if (row.status === "running" && row.lease_owner !== input.owner)
    return yield* ownership(input.id, input.owner, "Compaction failure is not owned by this lease")
  return yield* settleFailed(db, events, row, input).pipe(Effect.catchDefect(defectToFailure))
})

const settleFailed = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  row: Row,
  input: FailInput,
) {
  const message = FAILURE_MESSAGES[input.code]
  yield* events.publish(
    SessionEvent.Compaction.Failed,
    {
      sessionID: row.session_id,
      jobID: row.id,
      code: input.code,
      error: { type: `compaction_${input.code}`, message },
    },
    {
      commit: () =>
        Effect.gen(function* () {
          const statusFence = eq(SessionCompactionJobTable.status, row.status)
          const ownerFence =
            row.status === "running"
              ? eq(SessionCompactionJobTable.lease_owner, input.owner ?? "")
              : isNull(SessionCompactionJobTable.lease_owner)
          const failed = yield* db
            .update(SessionCompactionJobTable)
            .set({
              status: "failed",
              lease_owner: null,
              lease_expires_at: null,
              error_code: input.code,
              error_message: message,
              time_ended: input.now,
            })
            .where(and(eq(SessionCompactionJobTable.id, row.id), statusFence, ownerFence))
            .returning({ id: SessionCompactionJobTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!failed)
            return yield* Effect.die(
              new Ownership({ id: row.id, owner: input.owner, message: "Compaction failure lost lifecycle ownership" }),
            )
        }),
    },
  )
  return fromRow(yield* requireRow(db, row.id))
})

const validateAdmission = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: AdmitInput,
): Effect.fn.Return<void, Conflict> {
  if (
    !isNonnegativeInteger(input.baseContextRevision) ||
    !isNonnegativeInteger(input.targetMaxInputTokens) ||
    !isNonnegativeInteger(input.requestedThrough.seq) ||
    !DIGEST.test(input.configDigest)
  )
    return yield* conflict(input.id, "Compaction admission values are invalid")
  const state = yield* db
    .select({ status: SessionContextStateTable.status, revision: SessionContextStateTable.revision })
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!state || state.status !== "active" || state.revision !== input.baseContextRevision)
    return yield* conflict(input.id, "Compaction admission does not match the active context revision")
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.id, input.requestedThrough.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary || boundary.seq !== input.requestedThrough.seq)
    return yield* conflict(input.id, "Compaction admission boundary does not match canonical Session history")
})

const advanceBoundary = Effect.fnUntraced(function* (
  db: DatabaseService,
  row: Row,
  boundary: SessionCompaction.Boundary,
) {
  if (boundary.seq <= row.requested_through_seq) return admissionFromRow(row)
  const updated = yield* db
    .update(SessionCompactionJobTable)
    .set({ requested_through_message_id: boundary.messageID, requested_through_seq: boundary.seq })
    .where(and(eq(SessionCompactionJobTable.id, row.id), eq(SessionCompactionJobTable.status, "pending")))
    .returning()
    .get()
    .pipe(Effect.orDie)
  return admissionFromRow(updated ?? row)
})

const nextClaimable = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, now: number) {
  const rows = yield* db
    .select()
    .from(SessionCompactionJobTable)
    .where(
      and(
        eq(SessionCompactionJobTable.session_id, sessionID),
        inArray(SessionCompactionJobTable.status, ["pending", "running"]),
        isNull(SessionCompactionJobTable.legacy_input_id),
      ),
    )
    .orderBy(asc(SessionCompactionJobTable.time_created), asc(SessionCompactionJobTable.id))
    .all()
    .pipe(Effect.orDie)
  const running = rows.find((row) => row.status === "running")
  if (running) return running.lease_expires_at !== null && running.lease_expires_at <= now ? running : undefined
  return rows.find((row) => row.status === "pending")
})

const recoverable = Effect.fn("SessionCompactionJob.recoverable")(function* (db: DatabaseService, now: number) {
  if (!isNonnegativeInteger(now)) return []
  const rows = yield* db
    .select({ sessionID: SessionCompactionJobTable.session_id })
    .from(SessionCompactionJobTable)
    .where(
      and(
        isNull(SessionCompactionJobTable.legacy_input_id),
        or(
          eq(SessionCompactionJobTable.status, "pending"),
          and(eq(SessionCompactionJobTable.status, "running"), lte(SessionCompactionJobTable.lease_expires_at, now)),
        ),
      ),
    )
    .orderBy(asc(SessionCompactionJobTable.session_id))
    .all()
    .pipe(Effect.orDie)
  return [...new Set(rows.map((row) => row.sessionID))]
})

const recoverySchedule = Effect.fn("SessionCompactionJob.recoverySchedule")(function* (
  db: DatabaseService,
  now: number,
) {
  if (!isNonnegativeInteger(now)) return []
  const rows = yield* db
    .select({
      sessionID: SessionCompactionJobTable.session_id,
      status: SessionCompactionJobTable.status,
      leaseExpiresAt: SessionCompactionJobTable.lease_expires_at,
    })
    .from(SessionCompactionJobTable)
    .where(
      and(
        isNull(SessionCompactionJobTable.legacy_input_id),
        or(
          eq(SessionCompactionJobTable.status, "pending"),
          and(eq(SessionCompactionJobTable.status, "running"), isNotNull(SessionCompactionJobTable.lease_expires_at)),
        ),
      ),
    )
    .orderBy(asc(SessionCompactionJobTable.session_id))
    .all()
    .pipe(Effect.orDie)
  return Array.from(
    rows
      .reduce((schedule, row) => {
        if (row.status === "running" && row.leaseExpiresAt !== null) {
          schedule.set(row.sessionID, { sessionID: row.sessionID, at: Math.max(now, row.leaseExpiresAt) })
          return schedule
        }
        if (!schedule.has(row.sessionID)) schedule.set(row.sessionID, { sessionID: row.sessionID, at: now })
        return schedule
      }, new Map<SessionSchema.ID, Recovery>())
      .values(),
  )
})

const findRow = Effect.fnUntraced(function* (db: DatabaseService, id: SessionCompaction.ID) {
  return yield* db
    .select()
    .from(SessionCompactionJobTable)
    .where(eq(SessionCompactionJobTable.id, id))
    .get()
    .pipe(Effect.orDie)
})

const requireRow = Effect.fnUntraced(function* (
  db: DatabaseService,
  id: SessionCompaction.ID,
): Effect.fn.Return<Row, Conflict> {
  const row = yield* findRow(db, id)
  if (!row) return yield* conflict(id, "Compaction job does not exist")
  return row
})

const withExistingJob = <A, E>(
  db: DatabaseService,
  id: SessionCompaction.ID,
  use: (row: Row) => Effect.Effect<A, E>,
): Effect.Effect<A, E | Conflict> => requireRow(db, id).pipe(Effect.flatMap(use))

function fromRow(row: Row): Job {
  return {
    id: row.id,
    sessionID: row.session_id,
    trigger: row.trigger,
    admissionMode: row.admission_mode,
    requestedThrough: {
      messageID: row.requested_through_message_id,
      seq: EventV2.Seq.make(row.requested_through_seq),
    },
    baseContextRevision: row.base_context_revision,
    ...(row.legacy_input_id === null ? {} : { legacyInputID: row.legacy_input_id }),
    ...(row.target_max_input_tokens === null ? {} : { targetMaxInputTokens: row.target_max_input_tokens }),
    ...(row.config_digest === null ? {} : { configDigest: row.config_digest }),
    status: row.status,
    attempts: row.attempts,
    timeCreated: row.time_created,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.manifest_digest === null ? {} : { manifestDigest: row.manifest_digest }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.time_started === null ? {} : { timeStarted: row.time_started }),
    ...(row.time_ended === null ? {} : { timeEnded: row.time_ended }),
  }
}

function admissionFromRow(row: Row): SessionCompaction.Admission {
  return {
    id: row.id,
    sessionID: row.session_id,
    trigger: row.trigger,
    admissionMode: row.admission_mode,
    status: "pending",
    requestedThrough: {
      messageID: row.requested_through_message_id,
      seq: EventV2.Seq.make(row.requested_through_seq),
    },
    timeCreated: DateTime.makeUnsafe(row.time_created),
  }
}

function matchesAdmission(row: Row, input: AdmitInput) {
  return (
    row.session_id === input.sessionID &&
    row.trigger === input.trigger &&
    row.admission_mode === input.admissionMode &&
    row.requested_through_message_id === input.requestedThrough.messageID &&
    row.requested_through_seq === input.requestedThrough.seq &&
    row.base_context_revision === input.baseContextRevision &&
    row.target_max_input_tokens === input.targetMaxInputTokens &&
    row.config_digest === input.configDigest
  )
}

function compatible(row: Row, input: AdmitInput) {
  return (
    row.session_id === input.sessionID &&
    row.base_context_revision === input.baseContextRevision &&
    row.target_max_input_tokens === input.targetMaxInputTokens &&
    row.config_digest === input.configDigest
  )
}

const conflict = (id: SessionCompaction.ID | undefined, message: string) =>
  Effect.fail(new Conflict({ ...(id ? { id } : {}), message }))

const ownership = (id: SessionCompaction.ID, owner: string | undefined, message: string) =>
  Effect.fail(new Ownership({ id, ...(owner ? { owner } : {}), message }))

const defectToFailure = (defect: unknown) => {
  if (defect instanceof Conflict || defect instanceof Ownership) return Effect.fail(defect)
  return Effect.die(defect)
}

const defectToConflict = (defect: unknown) => {
  if (defect instanceof Conflict) return Effect.fail(defect)
  if (defect instanceof Ownership) return conflict(defect.id, defect.message)
  return Effect.die(defect)
}

const isNonnegativeInteger = (value: number) => Number.isInteger(value) && value >= 0
const DIGEST = /^[0-9a-f]{64}$/

const validMetrics = (metrics: SessionCompaction.Metrics) =>
  [metrics.excludedMessages, metrics.excludedParts, metrics.inputTokens, metrics.retainedTokens].every(
    isNonnegativeInteger,
  )

const FAILURE_MESSAGES: Record<SessionCompaction.FailureCode, string> = {
  cancelled: "Compaction was cancelled",
  superseded: "Compaction was superseded by a newer request",
  invalid_manifest: "Compaction produced an invalid manifest",
  protected_state_changed: "Protected Session state changed during compaction",
  context_limit_unresolved: "Compaction did not resolve the context limit",
  migration_failed: "Compaction migration failed",
  provider_failed: "Compaction provider request failed",
}
