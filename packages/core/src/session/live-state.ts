export * as SessionLiveState from "./live-state"

import { Message } from "@ycoding-ai/ai"
import { Session } from "@ycoding-ai/schema/session"
import type { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { KeepAwake } from "../keep-awake"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { ContextManifest } from "./context-manifest"
import { SessionErrors } from "./error"
import { SessionEvent } from "./event"
import { SessionGuardrail } from "./guardrail"
import { SessionReviewFold } from "./review-fold"
import { readTeamObservation, renderTeamObservation } from "./orchestration-view"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { SessionRunnerCache } from "./runner/cache"
import {
  InstructionStateTable,
  SessionPendingTable,
  SessionTable,
  SessionTaskTable,
  SessionTodoStateTable,
  SessionTodoTable,
} from "./sql"

export interface Snapshot {
  readonly rendered: Message
  readonly text: string
  readonly teamView?: ReturnType<typeof renderTeamObservation>
  readonly sources: Readonly<Record<ProtectedStateSource, Source>>
}

export interface Source {
  readonly sequence: number
  readonly digest: string
}

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]
export type ProtectedStateSource = Exclude<ContextManifest.ProtectedStateSource, "project_artifacts">
type DatabaseSource = Exclude<ProtectedStateSource, "guardrails">

export interface DatabaseCapture {
  readonly autonomy: SessionAutonomy.State
  readonly permissionCeiling: ReturnType<typeof SessionPermissionCeiling.read>
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: string
    readonly priority: string
  }>
  readonly sources: Readonly<Record<DatabaseSource, Source>>
}

export interface Interface {
  readonly load: (sessionID: Session.ID) => Effect.Effect<Snapshot, SessionErrors.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionLiveState") {}

export const sourceOrder = [
  "instructions",
  "todos",
  "goal",
  "autonomy",
  "permissions",
  "guardrails",
  "pending_work",
  "orchestration",
] as const satisfies ReadonlyArray<ProtectedStateSource>

/** Stable identity prefix for the live-state observation and its checkpointed copy. */
export const authoritativeStatePrefix = "Authoritative current Session state (JSON):"

export const goalReminder = (autonomy: SessionAutonomy.State) => {
  if (!autonomy.goal) return undefined
  if (autonomy.goal.status !== "active")
    return `Autonomous goal is ${autonomy.goal.status}: ${autonomy.goal.text}`
  return [
    `Active autonomous goal (iteration ${autonomy.goal.iteration}, noProgress ${autonomy.goal.noProgress}/${autonomy.goal.maxNoProgress}): ${autonomy.goal.text}`,
    "Choose safe implementation options and continue independent work. Required answers remain manual unless the answering Session's auto-answer toggle is on. Model guardrail judgments require guardrails.decide_reviews; hard-review grading also respects guardrails.decide_hard_reviews. Both automatic answers and model guardrail judgments default off. While awake, ask the user when required; a child Session's questions go to its parent Session. Defer unresolved requests to the review box while asleep. Goals do not override these gates.",
    "Only call goal report after you encounter a blocker, try to resolve it yourself, and still cannot make progress.",
    "Do not call goal report for ordinary progress; each report consumes one no-progress retry attempt.",
    "Active background subagents or shells are unfinished work, not automatic no progress; continue useful independent work or finish the iteration and wait for automatic notification.",
    "Call goal complete only after the goal is achieved and verified. Completion remains your explicit agent-owned decision.",
  ].join("\n")
}

export const sleepReminder = (autonomy: SessionAutonomy.State, machineAwake?: boolean, lidAwake?: boolean) => {
  if (!autonomy.sleep)
    return undefined
  return [
    "The user is asleep and cannot interact. Make decisions independently, do not wait for user input, and keep working until the task is done.",
    "Automatic answers require the answering Session's auto-answer toggle and model guardrail judgments require guardrails.decide_reviews; both default off, including during sleep. Disabled or unsettled requests wait in the user's review box. Continue independent work without guessing answers or replaying deferred actions.",
    machineAwake === undefined
      ? undefined
      : machineAwake
        ? lidAwake
          ? "Keep-awake holds idle and lid-closed sleep off."
          : "Keep-awake holds idle sleep off; lid-closed keep-awake is unavailable or unreported, so closing the lid may sleep this machine."
        : "Keep-awake is not holding this machine awake; the machine may sleep.",
    "On battery keep-awake drains the battery and a closed lid traps heat.",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n")
}

export function toProtectedState(sources: Snapshot["sources"]): ReadonlyArray<ContextManifest.ProtectedStateEntry> {
  return sourceOrder.map((source) => ({ source, revision: sources[source].sequence, digest: sources[source].digest }))
}

export function toDatabaseProtectedState(
  sources: DatabaseCapture["sources"],
): ReadonlyArray<ContextManifest.ProtectedStateEntry> {
  return sourceOrder.flatMap((source) =>
    source === "guardrails" ? [] : [{ source, revision: sources[source].sequence, digest: sources[source].digest }],
  )
}

const instructionEventTypes = [
  EventRuntime.versionedType(SessionEvent.InstructionsUpdated.type, SessionEvent.InstructionsUpdated.durable.version),
  EventRuntime.versionedType(SessionEvent.Compaction.EndedV1.type, SessionEvent.Compaction.EndedV1.durable.version),
  EventRuntime.versionedType(SessionEvent.Compaction.Ended.type, SessionEvent.Compaction.Ended.durable.version),
  EventRuntime.versionedType(SessionEvent.Moved.type, SessionEvent.Moved.durable.version),
  EventRuntime.versionedType(SessionEvent.RevertEvent.Committed.type, SessionEvent.RevertEvent.Committed.durable.version),
]

const pendingEventTypes = [
  EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
  EventRuntime.versionedType(SessionEvent.InputPromoted.type, SessionEvent.InputPromoted.durable.version),
  EventRuntime.versionedType(SessionEvent.Compaction.AdmittedV1.type, SessionEvent.Compaction.AdmittedV1.durable.version),
  EventRuntime.versionedType(SessionEvent.Compaction.EndedV1.type, SessionEvent.Compaction.EndedV1.durable.version),
  EventRuntime.versionedType(SessionEvent.Compaction.FailedV1.type, SessionEvent.Compaction.FailedV1.durable.version),
]

const permissionEventTypes = [
  EventRuntime.versionedType(SessionEvent.Created.type, SessionEvent.Created.durable.version),
  EventRuntime.versionedType(SessionEvent.Forked.type, SessionEvent.Forked.durable.version),
]

export const captureDatabase = Effect.fn("SessionLiveState.captureDatabase")(function* (
  tx: DatabaseClient | Transaction,
  sessionID: Session.ID,
): Effect.fn.Return<DatabaseCapture, SessionErrors.NotFoundError> {
  return yield* Effect.gen(function* () {
    const session = yield* tx
      .select({
        autonomy: SessionTable.autonomy,
        autonomyRevision: SessionTable.autonomy_revision,
        orchestrationRevision: SessionTable.orchestration_revision,
        permission: SessionTable.permission,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
    if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })

    const todos = yield* tx
      .select({
        content: SessionTodoTable.content,
        status: SessionTodoTable.status,
        priority: SessionTodoTable.priority,
        position: SessionTodoTable.position,
      })
      .from(SessionTodoTable)
      .where(eq(SessionTodoTable.session_id, sessionID))
      .orderBy(asc(SessionTodoTable.position))
      .all()
    const todoState = yield* tx
      .select({ revision: SessionTodoStateTable.revision, digest: SessionTodoStateTable.digest })
      .from(SessionTodoStateTable)
      .where(eq(SessionTodoStateTable.session_id, sessionID))
      .get()
    const instructionState = yield* tx
      .select({ current: InstructionStateTable.current_values })
      .from(InstructionStateTable)
      .where(eq(InstructionStateTable.session_id, sessionID))
      .get()
    const pending = yield* tx
      .select({
        id: SessionPendingTable.id,
        type: SessionPendingTable.type,
        delivery: SessionPendingTable.delivery,
        admittedSeq: SessionPendingTable.admitted_seq,
      })
      .from(SessionPendingTable)
      .where(eq(SessionPendingTable.session_id, sessionID))
      .orderBy(asc(SessionPendingTable.admitted_seq), asc(SessionPendingTable.id))
      .all()
    const taskVersions = yield* tx
      .select({ sessionID: SessionTaskTable.session_id, revision: SessionTaskTable.revision })
      .from(SessionTaskTable)
      .where(eq(SessionTaskTable.parent_id, sessionID))
      .orderBy(asc(SessionTaskTable.session_id))
      .all()
    const instructionEvent = yield* tx
      .select({ sequence: EventTable.seq })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, instructionEventTypes)))
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
    const pendingEvent = yield* tx
      .select({ sequence: EventTable.seq })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, pendingEventTypes)))
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
    const permissionEvent = yield* tx
      .select({ sequence: EventTable.seq })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, permissionEventTypes)))
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
    let autonomy = SessionAutonomy.read(session.autonomy)
    let revision = session.autonomyRevision
    let ancestorID = sessionID
    while (true) {
      const task = yield* tx
        .select({ parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, ancestorID))
        .get()
      if (!task?.parentID) break
      const parent = yield* tx
        .select({ autonomy: SessionTable.autonomy, revision: SessionTable.autonomy_revision })
        .from(SessionTable)
        .where(eq(SessionTable.id, task.parentID))
        .get()
      if (!parent) break
      const state = SessionAutonomy.read(parent.autonomy)
      autonomy = { ...autonomy, sleep: state.sleep }
      revision += parent.revision
      ancestorID = task.parentID
    }
    const permissionCeiling = SessionPermissionCeiling.read(session.permission)
    const todoDigest = todoState?.digest ?? Hash.sha256(SessionRunnerCache.canonicalJson(todos))
    return {
      autonomy,
      permissionCeiling,
      todos: todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      })),
      sources: {
        instructions: {
          sequence: instructionEvent?.sequence ?? 0,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(instructionState?.current ?? {})),
        },
        todos: { sequence: todoState?.revision ?? 0, digest: todoDigest },
        goal: {
          sequence: session.autonomyRevision,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(autonomy.goal ?? null)),
        },
        autonomy: {
          sequence: revision,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(autonomy)),
        },
        permissions: {
          sequence: permissionEvent?.sequence ?? 0,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(permissionCeiling)),
        },
        pending_work: {
          sequence: pendingEvent?.sequence ?? 0,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(pending)),
        },
        orchestration: {
          sequence: session.orchestrationRevision,
          digest: Hash.sha256(SessionRunnerCache.canonicalJson(taskVersions)),
        },
      },
    }
  }).pipe(
    Effect.catch((error) => (error instanceof SessionErrors.NotFoundError ? Effect.fail(error) : Effect.die(error))),
  )
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const guardrails = yield* SessionGuardrail.Service
    const keepAwake = yield* KeepAwake.Service

    const loadDatabase = Effect.fn("SessionLiveState.loadDatabase")((sessionID: Session.ID) =>
      db
        .transaction((tx) => captureDatabase(tx, sessionID))
        .pipe(
          Effect.catch((error) =>
            error instanceof SessionErrors.NotFoundError ? Effect.fail(error) : Effect.die(error),
          ),
        ),
    )

    const load: Interface["load"] = Effect.fn("SessionLiveState.load")(function* (sessionID: Session.ID) {
      const before = yield* guardrails.snapshot(sessionID)
      const current = yield* loadDatabase(sessionID)
      const guardrail = yield* guardrails.snapshot(sessionID)
      if (before.sequence !== guardrail.sequence || before.digest !== guardrail.digest) return yield* load(sessionID)
      const awake = current.autonomy.sleep ? yield* keepAwake.get : undefined
      const reviewFamily = yield* SessionReviewFold.familyFold(db, sessionID)
      const openReviews = reviewFamily?.folded.filter(SessionReviewFold.isOpen) ?? []
      const reviewNotice = openReviews.length
        ? `Pending your review: ${openReviews.length} item(s) in this Session family (${openReviews.map((item) => `${item.kind} ${item.itemID}`).join(", ")}). The user decides them through the review box; decisions arrive as user messages without changing sleep. Do not guess outcomes, retry deferred actions, or call goal report for them. Continue independent work; when only these remain, state what is waiting and stop.`
        : undefined
      const text = [
        authoritativeStatePrefix +
          "\n" +
          SessionRunnerCache.canonicalJson({
            todos: current.todos,
            autonomy: current.autonomy,
            permissionCeiling: current.permissionCeiling,
          }),
        goalReminder(current.autonomy),
        sleepReminder(current.autonomy, awake?.state === "on", awake?.lid === "on"),
        reviewNotice,
      ]
        .filter((part): part is string => part !== undefined)
        .join("\n\n")
      const teamView = yield* readTeamObservation(db, sessionID)
      return {
        rendered: Message.make({
          role: "system",
          content: text,
          volatile: true,
        }),
        text,
        ...(teamView ? { teamView } : {}),
        sources: { ...current.sources, guardrails: guardrail },
      }
    })

    return Service.of({ load })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SessionGuardrail.node, KeepAwake.node],
})
