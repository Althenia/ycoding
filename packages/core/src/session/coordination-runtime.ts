export * as CoordinationRuntime from "./coordination-runtime"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Agent } from "@ycoding-ai/schema/agent"
import { Form } from "@ycoding-ai/schema/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Model } from "@ycoding-ai/schema/model"
import { Permission } from "@ycoding-ai/schema/permission"
import { SessionStatusEvent } from "@ycoding-ai/schema/session-status-event"
import { NotificationType } from "@ycoding-ai/schema/session-orchestration"
import path from "node:path"
import fs from "node:fs/promises"
import { homedir } from "node:os"
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { CoordinationDecisionRuntime } from "../coordination/decisions"
import { CoordinationService } from "../coordination/index"
import { CoordinationMemberTable } from "../coordination/sql"
import { Database } from "../database/database"
import { FSUtil } from "../fs-util"
import { hostDirectory } from "../host-directory"
import { makeGlobalNode, type Node } from "../effect/app-node"
import { Job } from "../job"
import { KVTable } from "../kv/sql"
import { Project } from "../project"
import { ProjectTable } from "../project/sql"
import { CoordinationModel } from "./coordination-model"
import { SessionStepBoundary } from "./step-boundary"
import { SessionCompletion } from "./completion"
import { DecisionChoice } from "../decision-choice"
import { CoordinationEscalation } from "./coordination-escalation"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime, versionedType } from "../event"
import { EventTable } from "../event/sql"
import { LocationServiceMap } from "../location-service-map"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { CoordinationDecisions } from "./coordination-decisions"
import { SessionEvent } from "./event"
import { SessionExecution } from "./execution"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionOrchestration } from "./orchestration"
import { SessionOrchestrationIdentity } from "./orchestration-identity"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { SessionPending } from "./pending"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { Session } from "../session"
import { SessionMessageTable, SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"
import { SessionStore } from "./store"
import { SessionTask } from "./task"

export class RefusedError extends Schema.TaggedErrorClass<RefusedError>()("Coordination.RefusedError", {
  message: Schema.String,
}) {}

export const notice = "project_notification"
export const escalation = "project_escalation"
export const maxExcerpt = 500
export const inactiveMessage = "Project is inactive; send a message in the master chat to resume"
export const limitMessage = (limit: number) => `Project concurrency limit ${limit} reached`
export const waitingMessage = (sessionID: SessionSchema.ID, pending: ReadonlyArray<Coordination.PendingRequest>) =>
  `Session ${sessionID} is waiting on ${pending.map((request) => `${request.kind} ${request.requestID}`).join(", ")} and cannot receive input until each settles; settle it with answer, escalate it, or interrupt the member to withdraw it`

export interface SendInput {
  readonly sessionID: SessionSchema.ID
  readonly text: string
  readonly delivery?: SessionPending.Delivery
  readonly messageID?: SessionMessage.ID
  readonly model?: Model.Ref
  readonly taskTitle?: string
  readonly dependsOnTaskIDs?: ReadonlyArray<SessionMessage.ID>
}

export interface SendResult {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly state: Coordination.MemberState
  readonly reconciled: boolean
}

export interface AnswerInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly kind: Coordination.RequestKind
  readonly fingerprint: string
  readonly rationale: string
  readonly confidence?: number
  readonly answer?: Form.Answer
  readonly decision?: CoordinationDecisions.Decision
}

export interface Roster {
  readonly project: { readonly id: Coordination.GroupID; readonly name: string; readonly active: boolean; readonly pausedReason?: Coordination.PausedReason; readonly concurrency: number | null }
  readonly members: ReadonlyArray<Coordination.Participant>
}

export interface AssignInput {
  readonly sessionID: SessionSchema.ID
  readonly ownerSessionID: SessionSchema.ID
}

export interface ReleaseInput {
  readonly sessionID: SessionSchema.ID
  readonly reason: Coordination.ReleaseReason
}

export interface OwnershipResult {
  readonly sessionID: SessionSchema.ID
  readonly owner?: { readonly sessionID: SessionSchema.ID; readonly title: string }
}

export type CreateInput = {
  readonly id: SessionSchema.ID
  readonly agentPermissions: Permission.Ruleset
  readonly ownerSessionID?: SessionSchema.ID
  readonly title?: string
  readonly prompt?: string
  readonly model?: Model.Ref
} & (
  | { readonly directory: string; readonly projectID?: never; readonly name?: never }
  | { readonly projectID: Project.ID; readonly directory?: never; readonly name?: never }
  | { readonly name: string; readonly directory?: never; readonly projectID?: never }
)

export interface Worktree {
  readonly directory: AbsolutePath
  readonly branch: string
}

export interface CreateResult {
  readonly sessionID: SessionSchema.ID
  readonly directory: AbsolutePath
  readonly location: SessionSchema.Info["location"]
  readonly model: Model.Ref | null
  readonly enrollment: { readonly groupID: Coordination.GroupID; readonly member: boolean; readonly error?: string }
  readonly branch?: string
  readonly owner?: { readonly sessionID: SessionSchema.ID; readonly title: string }
  readonly prompt?: SendResult | { readonly refused: string }
}

export interface EscalateInput {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly kind: Coordination.RequestKind
  readonly fingerprint: string
  readonly reason: string
}

export interface EscalateResult {
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly requestSessionID?: SessionSchema.ID
  readonly messageID?: SessionMessage.ID
  readonly delivered: boolean
  readonly decision: CoordinationDecisions.EscalateResult
}

export type Delegation = "routine" | "decline-only" | `explicit-decision:${string}`

export type RequestDetail = { readonly requestSessionID?: SessionSchema.ID } & (
  | { readonly kind: "permission"; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }
  | { readonly kind: "review"; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly ruleIDs: ReadonlyArray<string>; readonly reason: string; readonly hardReview: boolean; readonly standard: boolean; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }
  | { readonly kind: "question"; readonly requestID: string; readonly fingerprint: string; readonly title: string; readonly fields: ReadonlyArray<{ readonly key: string; readonly type: string; readonly title?: string; readonly required?: boolean; readonly options?: ReadonlyArray<string> }>; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }
)

export type NotificationEvent = "started" | "progress" | "completed" | "failed" | "interrupted" | "question" | "permission" | "review" | "escalated"

const urgentEvents: ReadonlySet<NotificationEvent> = new Set(["failed", "question", "permission", "review", "escalated"])

const handledEvents = [
  SessionEvent.InputAdmitted,
  SessionEvent.Execution.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  Form.Event.Created,
  Permission.Event.Asked,
  Guardrail.Event.Asked,
  Coordination.Event.OwnerChanged,
  Coordination.Event.Changed,
  Coordination.Event.Deleted,
  SessionEvent.Archived,
  SessionEvent.Deleted,
  SessionEvent.Task.Updated,
] as const
type HandledEvent = EventRuntime.SubscribePayload<typeof handledEvents>

const boardEvents = [
  ...handledEvents, SessionEvent.InputPromoted, SessionEvent.InputConsumed, SessionEvent.Renamed, SessionEvent.ModelSelected,
  SessionEvent.Unarchived, SessionEvent.RevertEvent.Cleared, SessionStatusEvent.Idle,
  SessionEvent.Review.Deferred, SessionEvent.Review.Decided, SessionEvent.Review.Withdrawn, SessionEvent.Review.Consumed,
  Form.Event.Replied, Form.Event.Cancelled, Form.Event.TimedOut, Form.Event.Deferred,
  Permission.Event.Replied, Permission.Event.Deferred,
  Guardrail.Event.Replied, Guardrail.Event.Cancelled, Guardrail.Event.Deferred,
] as const
type BoardEvent = EventRuntime.SubscribePayload<typeof boardEvents>
const boardReadinessEvents: ReadonlySet<string> = new Set([
  SessionEvent.InputAdmitted.type, SessionEvent.InputConsumed.type, SessionEvent.Execution.Succeeded.type, SessionEvent.Execution.Failed.type,
  SessionEvent.Execution.Interrupted.type, SessionStatusEvent.Idle.type, Coordination.Event.OwnerChanged.type, SessionEvent.Task.Updated.type,
  SessionEvent.Archived.type, SessionEvent.Unarchived.type, SessionEvent.RevertEvent.Cleared.type, SessionEvent.Review.Decided.type,
  SessionEvent.Review.Withdrawn.type, SessionEvent.Review.Consumed.type, Form.Event.Replied.type, Form.Event.Cancelled.type,
  Form.Event.TimedOut.type, Permission.Event.Replied.type, Guardrail.Event.Replied.type, Guardrail.Event.Cancelled.type,
])

const taskEvent = { durable: { aggregate: "groupID", version: 1 } } as const
const TaskRecorded = EventRuntime.durable({ type: "coordination.task.recorded", ...taskEvent,
  schema: { groupID: Coordination.GroupID, task: Coordination.BoardTask, text: Schema.String,
    delivery: Schema.optionalKey(Schema.Literals(["steer", "queue"])), model: Schema.optionalKey(Model.Ref) } })
const TaskDispatched = EventRuntime.durable({ type: "coordination.task.dispatched", ...taskEvent,
  schema: { groupID: Coordination.GroupID, taskID: SessionMessage.ID } })
const TaskSettled = EventRuntime.durable({ type: "coordination.task.settled", ...taskEvent,
  schema: { groupID: Coordination.GroupID, taskID: SessionMessage.ID, state: Coordination.TaskState, result: Schema.optionalKey(Coordination.TaskResult) } })
const recordedType = versionedType(TaskRecorded.type, 1)
const dispatchedType = versionedType(TaskDispatched.type, 1)
const settledType = versionedType(TaskSettled.type, 1)
const taskReceipt = (kind: string, id: SessionMessage.ID) => EventRuntime.ID.make(`evt_project_task_${kind}_${Hash.sha256(Buffer.from(id, "utf16le"))}`)
const terminalTask = (state: Coordination.BoardTask["state"]) => state === "completed" || state === "failed" || state === "cancelled"

const staleOwnerStates: ReadonlySet<string> = new Set(["cancelling", "cancelled", "failed", "lost"])
const ownerEndingChanges: ReadonlySet<string> = new Set(["cancelled", "failed", "lost", "question_asked"])

export type RecoverError = Session.ScopeUnavailableError | SessionOrchestration.ServiceUnavailableError | EventRuntime.TaskOwnerUnavailableError

export interface Interface {
  readonly board: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Board, CoordinationService.NotFoundError>
  readonly member: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<MemberResult, RefusedError>
  readonly setModel: (caller: SessionSchema.ID, input: ModelInput) => Effect.Effect<MemberResult, RefusedError>
  readonly get: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Info, CoordinationService.NotFoundError>
  readonly summaries: () => Effect.Effect<ReadonlyArray<Coordination.GroupSummary>>
  readonly roster: (caller: SessionSchema.ID) => Effect.Effect<Roster, RefusedError>
  readonly send: (caller: SessionSchema.ID, input: SendInput) => Effect.Effect<SendResult, RefusedError | Session.ScopeUnavailableError>
  readonly answer: (caller: SessionSchema.ID, input: AnswerInput) => Effect.Effect<CoordinationDecisions.Result, RefusedError>
  readonly interrupt: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly state: Coordination.MemberState }, RefusedError>
  readonly inspect: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID; readonly requestID: string }) => Effect.Effect<RequestDetail, RefusedError>
  readonly escalate: (caller: SessionSchema.ID, input: EscalateInput) => Effect.Effect<EscalateResult, RefusedError | Session.ScopeUnavailableError | SessionOrchestration.ServiceUnavailableError>
  readonly assign: (caller: SessionSchema.ID, input: AssignInput) => Effect.Effect<OwnershipResult, RefusedError | EventRuntime.TaskOwnerUnavailableError>
  readonly release: (caller: SessionSchema.ID, input: ReleaseInput) => Effect.Effect<OwnershipResult, RefusedError>
  readonly remove: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID }, options?: { readonly groupID?: Coordination.GroupID }) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly removed: true }, RefusedError | EventRuntime.TaskOwnerUnavailableError>
  readonly attach: <E = never>(caller: SessionSchema.ID, input: Coordination.AttachInput, options?: AttachOptions<E>) => Effect.Effect<Coordination.AttachResult, RefusedError | EventRuntime.TaskOwnerUnavailableError | E>
  readonly create: <E = never>(
    caller: SessionSchema.ID,
    input: CreateInput,
    worktree?: (name: string) => Effect.Effect<Worktree, E>,
    authorizeMkdir?: (directory: AbsolutePath, mkdir: Effect.Effect<void, RefusedError>) => Effect.Effect<void, E | RefusedError>,
  ) => Effect.Effect<CreateResult, RefusedError | E | Session.ScopeUnavailableError | EventRuntime.TaskOwnerUnavailableError>
}

export interface AttachOptions<E> {
  readonly groupID?: Coordination.GroupID
  readonly authorizeLocation?: (location: Coordination.AttachResult["location"]) => Effect.Effect<void, E>
}

export interface MemberResult {
  readonly sessionID: SessionSchema.ID
  readonly location: SessionSchema.Info["location"]
  readonly model: Model.Ref | null
  readonly state: Coordination.MemberState
  readonly owner?: OwnershipResult["owner"]
}

export interface ModelInput {
  readonly sessionID: SessionSchema.ID
  readonly expectedModel: Model.Ref | null
  readonly model: Model.Ref
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly coordination: Pick<CoordinationService.Interface, "get" | "list" | "scopeOf" | "memberOf" | "accessOf" | "withOwnership" | "activate" | "pause" | "setOwner" | "addMember" | "removeMember">
  readonly decisions: Pick<CoordinationDecisions.Interface, "pending" | "evaluate" | "escalate">
  readonly execution: Pick<SessionExecution.Interface, "active" | "wake" | "interrupt">
  readonly sessions: Pick<Session.Interface, "create" | "get" | "outstanding">
  readonly recordOpened?: Project.Interface["recordOpened"]
  readonly orchestration: Pick<SessionOrchestration.Interface, "notice">
  readonly validateModel: (sessionID: SessionSchema.ID, model: Model.Ref) => Effect.Effect<void, RefusedError>
  readonly jobs: Pick<Job.Interface, "list" | "outstandingSessions">
}

const executionTypes = [
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
].map((definition) => versionedType(definition.type, definition.durable.version))
const failedType = versionedType(SessionEvent.Execution.Failed.type, SessionEvent.Execution.Failed.durable.version)

const refuse = (message: string) => new RefusedError({ message })
const CreationPlacement = Schema.Struct({ digest: Schema.String, directory: AbsolutePath, branch: Schema.optional(Schema.String) })
const fileErrorCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error ? error.code : undefined

export const authorizeMember = Effect.fn("CoordinationRuntime.authorizeMember")(function* (
  coordination: Pick<CoordinationService.Interface, "accessOf" | "scopeOf">,
  caller: SessionSchema.ID,
  sessionID: SessionSchema.ID,
) {
  const access = yield* coordination.accessOf(caller)
  if (access === undefined) return yield* refuse("The project tool is only available to a Project's Master and its subagents")
  if (access.role === "executor" && (yield* coordination.scopeOf(caller)) === undefined)
    return yield* refuse("The project tool is only available to a Project's Master and its subagents")
  const scope = access.scope
  if (!scope.memberSessionIDs.includes(sessionID)) return yield* refuse(`Session ${sessionID} is not a member of this Project`)
  if (!CoordinationService.canAct(access, sessionID)) {
    const target = yield* coordination.accessOf(sessionID)
    return yield* refuse(target?.ownerSessionID === scope.masterSessionID
      ? `Only the Project's Master acts on Session ${sessionID} until the Master assigns it an owner`
      : `Session ${sessionID} is owned by another Session; only its owner or the Master acts on it`)
  }
  return scope
})

const clip = (text: string) => (text.length > maxExcerpt ? `${text.slice(0, maxExcerpt - 1)}…` : text)

export function make(options: Options): Omit<Interface, "setModel"> & { readonly handle: (event: BoardEvent) => Effect.Effect<void>; readonly recover: () => Effect.Effect<void, RecoverError> } {
  const { db, events, coordination, decisions, execution, sessions, orchestration, jobs } = options
  const senders = new Map<SessionSchema.ID, SessionSchema.ID>()
  const sendLock = KeyedMutex.makeUnsafe<Coordination.GroupID>()
  const createLock = KeyedMutex.makeUnsafe<SessionSchema.ID>()

  const underOwnership = <A, E, R>(caller: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const access = yield* coordination.accessOf(caller)
      return yield* (access === undefined ? effect : coordination.withOwnership(access.scope.groupID, effect))
    })

  const scopeFor = Effect.fnUntraced(function* (caller: SessionSchema.ID) {
    const access = yield* coordination.accessOf(caller)
    if (access === undefined || access.role === "executor") return yield* refuse("The project tool is only available to a Project's Master and its subagents")
    return access.scope
  })

  const memberScope = (caller: SessionSchema.ID, sessionID: SessionSchema.ID) => authorizeMember(coordination, caller, sessionID)

  const runningSender = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, running: ReadonlySet<SessionSchema.ID>) {
    const sender = senders.get(member)
    if (sender === undefined || sender === scope.masterSessionID || !running.has(sender)) return undefined
    const current = yield* coordination.scopeOf(sender)
    return current?.groupID === scope.groupID ? sender : undefined
  })

  const ownerOf = Effect.fnUntraced(function* (groupID: Coordination.GroupID, sessionID: SessionSchema.ID) {
    return yield* db.select({ sessionID: SessionTable.id, title: SessionTable.title })
      .from(CoordinationMemberTable)
      .innerJoin(SessionTable, eq(SessionTable.id, CoordinationMemberTable.owner_session_id))
      .where(and(eq(CoordinationMemberTable.group_id, groupID), eq(CoordinationMemberTable.session_id, sessionID)))
      .get().pipe(Effect.orDie)
  })

  const ownership = (owner: OwnershipResult["owner"]) => (owner === undefined ? {} : { owner })

  const ownerProblem = Effect.fnUntraced(function* (scope: CoordinationService.Scope, ownerSessionID: SessionSchema.ID) {
    if (ownerSessionID === scope.masterSessionID) return undefined
    const task = yield* db.select({ state: SessionTaskTable.state, archived: SessionTable.time_archived }).from(SessionTaskTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionTaskTable.session_id))
      .where(and(eq(SessionTaskTable.session_id, ownerSessionID), eq(SessionTaskTable.parent_id, scope.masterSessionID)))
      .get().pipe(Effect.orDie)
    if (task === undefined) return `Session ${ownerSessionID} is not a subagent the Master launched`
    if (task.archived !== null) return `Subagent ${ownerSessionID} is archived and cannot own members`
    if (staleOwnerStates.has(task.state)) return `Subagent ${ownerSessionID} is ${task.state} and cannot own members`
    return undefined
  })

  const assign: Interface["assign"] = Effect.fn("CoordinationRuntime.assign")(function* (caller, input) {
    const scope = yield* scopeFor(caller)
    if (caller !== scope.masterSessionID) return yield* refuse("Only the Project's Master assigns member ownership")
    if (!scope.memberSessionIDs.includes(input.sessionID)) return yield* refuse(`Session ${input.sessionID} is not a member of this Project`)
    const problem = yield* ownerProblem(scope, input.ownerSessionID)
    if (problem !== undefined) return yield* refuse(problem)
    yield* coordination.setOwner(scope.groupID, { sessionID: input.sessionID, ownerSessionID: input.ownerSessionID }).pipe(Effect.orDie)
    yield* SessionTask.superviseAttached(db, events, input.ownerSessionID)
    return { sessionID: input.sessionID, ...ownership(yield* ownerOf(scope.groupID, input.sessionID)) }
  })

  const release: Interface["release"] = Effect.fn("CoordinationRuntime.release")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const owner = yield* ownerOf(scope.groupID, input.sessionID)
    if (owner === undefined) return yield* refuse(`Session ${input.sessionID} has no owner to release`)
    if (caller !== scope.masterSessionID)
      return yield* refuse("Only the Project's Master releases member ownership; supervisors stay attached until the Master releases or transfers it")
    yield* coordination.setOwner(scope.groupID, { sessionID: input.sessionID, reason: input.reason }).pipe(Effect.orDie)
    return { sessionID: input.sessionID }
  })

  const create: Interface["create"] = (caller, input, worktree, authorizeMkdir) =>
    createLock.withLock(input.id)(Effect.gen(function* () {
      const scope = yield* underOwnership(caller, Effect.gen(function* () {
        const current = yield* scopeFor(caller)
        if (caller !== current.masterSessionID) return yield* refuse("Only the Project's Master creates member Sessions")
        const problem = input.ownerSessionID === undefined ? undefined : yield* ownerProblem(current, input.ownerSessionID)
        if (problem !== undefined) return yield* refuse(problem)
        return current
      }))
      if (input.model !== undefined) yield* options.validateModel(caller, input.model)
      if (input.prompt !== undefined && !scope.active) return yield* refuse(inactiveMessage)
      const master = yield* sessions.get(caller).pipe(Effect.mapError(() => refuse(`Session ${caller} does not exist`)))
      const recorded = yield* sessions.get(input.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
      const key = `project.member.create:${input.id}`
      const digest = Hash.json({ caller, groupID: scope.groupID, input })
      const saved = (yield* db.select({ value: KVTable.value }).from(KVTable).where(eq(KVTable.key, key)).get().pipe(Effect.orDie))?.value
      const placement = saved === undefined ? undefined : yield* Schema.decodeUnknownEffect(CreationPlacement)(saved).pipe(Effect.mapError(() => refuse(`Creation receipt for Session ${input.id} is invalid`)))
      if (placement !== undefined && placement.digest !== digest) return yield* refuse(`Session ${input.id} creation identity was already used with different input`)
      if (input.projectID === Project.ID.global) return yield* refuse("The global Project has no repository directory; pass directory to choose the member's folder")
      const selected = input.projectID === undefined ? undefined : yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, input.projectID)).get().pipe(Effect.orDie)
      if (input.projectID !== undefined && selected === undefined) return yield* refuse(`Project ${input.projectID} does not exist`)
      const admitted = input.directory === undefined ? undefined : hostDirectory(input.directory, homedir())
      if (input.directory !== undefined && admitted === undefined)
        return yield* refuse("Choose an absolute directory path or a path starting with ~/")
      const directory = admitted === undefined ? undefined : AbsolutePath.make(admitted)
      if (directory !== undefined && placement !== undefined && directory !== placement.directory)
        return yield* refuse(`Session ${input.id} directory changed after creation was recorded`)
      const canonical = selected === undefined ? undefined : AbsolutePath.make(selected.worktree)
      if (canonical !== undefined && placement !== undefined && canonical !== placement.directory)
        return yield* refuse(`Project ${input.projectID} canonical Location changed after creation was recorded`)
      if (canonical !== undefined) {
        const exists = yield* Effect.tryPromise({ try: () => fs.stat(canonical), catch: () => refuse(`Project directory ${canonical} is unavailable`) })
        if (!exists.isDirectory()) return yield* refuse(`Project directory ${canonical} is not a directory`)
      }
      const chosen = directory ?? canonical
      const expected = chosen ?? placement?.directory
      if (recorded !== undefined && (recorded.parentID !== undefined || recorded.scope === "standalone" || recorded.location.workspaceID !== undefined ||
        (expected !== undefined && recorded.location.directory !== expected)))
        return yield* refuse(`Session ${input.id} already exists at a different Location`)
      if (recorded !== undefined && canonical === undefined && placement === undefined)
        return yield* refuse(`Session ${input.id} has no matching ${directory === undefined ? "worktree" : "directory"} creation receipt`)
      if (directory !== undefined) {
        const unavailable = (error: unknown) => refuse(fileErrorCode(error) === "ENOTDIR" || fileErrorCode(error) === "EEXIST"
          ? `Project path ${directory} is not a directory`
          : `Project directory ${directory} could not be opened or created`)
        const stat = yield* Effect.tryPromise({
          try: () => fs.stat(directory).catch((error: unknown) => {
            if (fileErrorCode(error) === "ENOENT") return undefined
            throw error
          }),
          catch: unavailable,
        })
        if (stat !== undefined && !stat.isDirectory()) return yield* refuse(`Project path ${directory} is not a directory`)
        if (stat === undefined) {
          const mkdir = Effect.tryPromise({ try: () => fs.mkdir(directory, { recursive: true }), catch: unavailable }).pipe(Effect.asVoid)
          yield* (authorizeMkdir === undefined ? mkdir : authorizeMkdir(directory, mkdir))
        }
        if (options.recordOpened !== undefined) yield* options.recordOpened(directory)
      }
      const created: { readonly directory: AbsolutePath; readonly branch?: string } = chosen !== undefined
        ? { directory: chosen }
        : placement !== undefined
          ? { directory: placement.directory, branch: placement.branch }
          : worktree !== undefined && input.name !== undefined
            ? yield* worktree(input.name)
            : yield* refuse("Explicit worktree creation requires a worktree provider")
      if (placement === undefined) yield* db.insert(KVTable).values({ key, value: { digest, directory: created.directory, ...(created.branch === undefined ? {} : { branch: created.branch }) } })
        .onConflictDoNothing().run().pipe(Effect.orDie)
      const partial = (message: string, sessionID?: SessionSchema.ID) =>
        refuse(`Created ${created.branch === undefined ? `Session placement at ${created.directory}` : `worktree ${created.directory} on branch ${created.branch}`}${sessionID === undefined ? "" : ` and Session ${sessionID}`}, but ${message}; nothing was removed`)
      const member = recorded ?? (yield* sessions.create({
        id: input.id,
        location: { directory: created.directory },
        title: input.title ?? input.name ?? selected?.name ?? (path.basename(created.directory) || created.directory),
        permissionCeiling: SessionPermissionCeiling.inherit(master.permissionCeiling, input.agentPermissions),
        ...(input.model === undefined ? {} : { model: input.model }),
      }).pipe(Effect.catch(error => sessions.get(input.id).pipe(
        Effect.mapError(() => partial(`creating its Session failed: ${error.message}`, input.id)),
        Effect.flatMap(session => session.parentID === undefined && session.location.directory === created.directory
          ? Effect.succeed(session)
          : Effect.fail(partial("its Session identity has conflicting placement", input.id))),
      ))))
      const enrollment = yield* coordination.withOwnership(scope.groupID, Effect.gen(function* () {
        const access = yield* coordination.accessOf(caller)
        if (access?.role !== "master" || access.scope.groupID !== scope.groupID)
          return yield* partial(`Session ${caller} is no longer this Project's Master`, member.id)
        const problem = input.ownerSessionID === undefined ? undefined : yield* ownerProblem(access.scope, input.ownerSessionID)
        if (problem !== undefined) return yield* partial(problem, member.id)
        if (!access.scope.memberSessionIDs.includes(member.id)) yield* coordination.addMember(scope.groupID, { sessionID: member.id, ...(input.ownerSessionID === undefined ? {} : { ownerSessionID: input.ownerSessionID }) })
          .pipe(Effect.mapError((error) => partial(`adding it to the Project failed: ${error.message}`, member.id)))
        if (input.ownerSessionID !== undefined) yield* SessionTask.superviseAttached(db, events, input.ownerSessionID)
        return { groupID: scope.groupID, member: true } as CreateResult["enrollment"]
      })).pipe(Effect.catchTag("Coordination.RefusedError", error => Effect.succeed({ groupID: scope.groupID, member: false, error: error.message })))
      const prompt = input.prompt === undefined || !enrollment.member
        ? undefined
        : yield* underOwnership(caller, send(caller, { sessionID: member.id, text: input.prompt, messageID: SessionMessage.ID.make(`msg_project_create_${input.id}`) })).pipe(
          Effect.catchTag("Coordination.RefusedError", (error) => Effect.succeed({ refused: error.message })),
        )
      const confirmed = yield* sessions.get(member.id).pipe(Effect.mapError(() => partial("its Session could not be read back", member.id)))
      return {
        sessionID: member.id,
        directory: confirmed.location.directory,
        location: confirmed.location,
        model: confirmed.model ?? null,
        enrollment,
        ...(created.branch === undefined ? {} : { branch: created.branch }),
        ...ownership(yield* ownerOf(scope.groupID, member.id)),
        ...(prompt === undefined ? {} : { prompt }),
      } satisfies CreateResult
    })).pipe(Effect.withSpan("CoordinationRuntime.create"))

  const summarize = (member: SessionSchema.ID, item: CoordinationDecisions.PendingSnapshot): Coordination.PendingRequest => {
    const origin = requestOrigin(member, item)
    if (item.kind === "permission")
      return { kind: "permission", requestID: item.request.id, fingerprint: item.fingerprint, summary: clip([item.request.action, ...item.request.resources].join(" ")), ...origin }
    if (item.kind === "review")
      return { kind: "review", requestID: item.request.id, fingerprint: item.fingerprint, summary: clip(`${item.request.action} ${item.request.resources.join(" ")}: ${item.request.reason}`), ...origin }
    return { kind: "question", requestID: item.form.id, fingerprint: item.fingerprint, summary: clip(item.form.title), ...origin }
  }

  const descendantsOf = (member: SessionSchema.ID) =>
    db.all<{ id: SessionSchema.ID }>(sql`WITH RECURSIVE family(id) AS (
      SELECT ${SessionTable.id} FROM ${SessionTable} WHERE ${SessionTable.id} = ${member}
      UNION SELECT child.id FROM session child JOIN family ON child.parent_id = family.id WHERE child.time_archived IS NULL
    ) SELECT id FROM family WHERE id != ${member}`).pipe(Effect.orDie, Effect.map((rows) => rows.map((row) => row.id)))

  const familyPending = Effect.fnUntraced(function* (scope: CoordinationService.Scope, coordinatorSessionID: SessionSchema.ID, member: SessionSchema.ID) {
    return yield* decisions.pending({
      groupID: scope.groupID, coordinatorSessionID, targetSessionID: member, descendantSessionIDs: yield* descendantsOf(member), limit: Coordination.maxPending,
    })
  })

  const childQuestions = (member: SessionSchema.ID, limit: number, after?: SessionSchema.ID) => db.select({ task: SessionTaskTable }).from(SessionTaskTable)
    .where(and(eq(SessionTaskTable.state, "waiting"), isNotNull(SessionTaskTable.question_id), isNotNull(SessionTaskTable.question), isNotNull(SessionTaskTable.question_time),
      after === undefined ? undefined : gt(SessionTaskTable.session_id, after),
      sql`${SessionTaskTable.session_id} in (WITH RECURSIVE family(id) AS (SELECT id FROM session WHERE parent_id = ${member} AND time_archived IS NULL
        UNION SELECT child.id FROM session child JOIN family ON child.parent_id = family.id WHERE child.time_archived IS NULL) SELECT id FROM family)`))
    .orderBy(asc(SessionTaskTable.session_id)).limit(limit).all().pipe(Effect.orDie)
  const childFingerprint = (task: typeof SessionTaskTable.$inferSelect) => Hash.json({ sessionID: task.session_id, questionID: task.question_id, revision: task.revision })

  const rootOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    let root = sessionID
    for (let depth = 0; depth < 64; depth++) {
      const row = yield* db.select({ parent: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, root)).get().pipe(Effect.orDie)
      if (row?.parent === null || row?.parent === undefined) break
      root = row.parent
    }
    return root
  })

  const lastFailed = (sessionID: SessionSchema.ID) =>
    db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, executionTypes)))
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie, Effect.map((row) => row?.type === failedType))

  const hasPendingInput = (sessionIDs: ReadonlyArray<SessionSchema.ID>) =>
    sessionIDs.length === 0
      ? Effect.succeed(new Set<SessionSchema.ID>())
      : db
          .select({ id: SessionPendingTable.session_id })
          .from(SessionPendingTable)
          .where(inArray(SessionPendingTable.session_id, [...sessionIDs]))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => new Set(rows.map((row) => row.id))))

  const participant = Effect.fnUntraced(function* (scope: CoordinationService.Scope, sessionID: SessionSchema.ID, running: ReadonlySet<SessionSchema.ID>) {
    const row = yield* db
      .select({ title: SessionTable.title, directory: SessionTable.directory, workspaceID: SessionTable.workspace_id, updated: SessionTable.time_updated })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const own = yield* decisions.pending({ groupID: scope.groupID, coordinatorSessionID: scope.masterSessionID, targetSessionID: sessionID, limit: Coordination.maxPending })
    const pending = (sessionID === scope.masterSessionID ? own : yield* familyPending(scope, scope.masterSessionID, sessionID)).map((item) => summarize(sessionID, item))
    if (sessionID !== scope.masterSessionID && pending.length < Coordination.maxPending) {
      for (const { task } of yield* childQuestions(sessionID, Coordination.maxPending - pending.length)) {
        if (task.question_id !== null) pending.push({ kind: "question", requestID: task.question_id, requestSessionID: task.session_id,
          fingerprint: childFingerprint(task), summary: "Managed child question; the parent Session owns the reply" })
      }
    }
    const state: Coordination.MemberState =
      own.length > 0 ? "waiting" : running.has(sessionID) ? "running" : (yield* lastFailed(sessionID)) ? "failed" : "idle"
    const sender = yield* runningSender(scope, sessionID, running)
    const driver = sender !== undefined
      ? yield* db.select({ sessionID: SessionTable.id, title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, sender)).get().pipe(Effect.orDie)
      : undefined
    const owner = yield* ownerOf(scope.groupID, sessionID)
    return {
      sessionID,
      title: row?.title ?? "",
      location: { directory: AbsolutePath.make(row?.directory ?? "/"), ...(row?.workspaceID ? { workspaceID: row.workspaceID } : {}) },
      state,
      lastActivity: row?.updated ?? 0,
      pending,
      ...(driver === undefined ? {} : { drivenBy: driver }),
      ...(owner === undefined ? {} : { owner }),
    } satisfies Coordination.Participant
  })

  const stateOf = (scope: CoordinationService.Scope, sessionID: SessionSchema.ID) =>
    sessions.outstanding().pipe(Effect.flatMap(({ running }) => participant(scope, sessionID, running)), Effect.map((value) => value.state))

  const member: Interface["member"] = (caller, input) => underOwnership(caller, Effect.gen(function* () {
    const scope = yield* memberScope(caller, input.sessionID)
    const session = yield* sessions.get(input.sessionID).pipe(Effect.mapError(() => refuse(`Session ${input.sessionID} does not exist`)))
    return { sessionID: session.id, location: session.location, model: session.model ?? null,
      state: yield* stateOf(scope, session.id), ...ownership(yield* ownerOf(scope.groupID, session.id)) }
  }))

  const get: Interface["get"] = Effect.fn("CoordinationRuntime.get")(function* (groupID) {
    const group = yield* coordination.get(groupID)
    const scope: CoordinationService.Scope = {
      groupID: group.id, masterSessionID: group.masterSessionID, memberSessionIDs: group.memberSessionIDs, settings: group.settings, active: group.active,
    }
    const { running } = yield* sessions.outstanding()
    return {
      id: group.id,
      name: group.name,
      revision: group.revision,
      active: group.active,
      ...(group.pausedReason === undefined ? {} : { pausedReason: group.pausedReason }),
      master: yield* participant(scope, group.masterSessionID, running),
      members: yield* Effect.forEach(group.memberSessionIDs, (sessionID) => participant(scope, sessionID, running)),
      settings: group.settings,
      time: group.time,
    } satisfies Coordination.Info
  })

  const summaries: Interface["summaries"] = Effect.fn("CoordinationRuntime.summaries")(function* () {
    return (yield* coordination.list()).map((group): Coordination.GroupSummary => ({
      id: group.id, name: group.name, revision: group.revision, active: group.active, masterSessionID: group.masterSessionID,
      memberCount: group.memberSessionIDs.length, settings: group.settings, time: group.time,
      ...(group.pausedReason === undefined ? {} : { pausedReason: group.pausedReason }),
    }))
  })

  const roster: Interface["roster"] = Effect.fn("CoordinationRuntime.roster")(function* (caller) {
    const scope = yield* scopeFor(caller)
    const group = yield* coordination.get(scope.groupID).pipe(Effect.orDie)
    const { running } = yield* sessions.outstanding()
    return {
      project: { id: scope.groupID, name: group.name, active: scope.active, concurrency: scope.settings.concurrency, ...(group.pausedReason === undefined ? {} : { pausedReason: group.pausedReason }) },
      members: yield* Effect.forEach(scope.memberSessionIDs, (sessionID) => participant(scope, sessionID, running)),
    }
  })

  const send = Effect.fn("CoordinationRuntime.send")(function* (caller: SessionSchema.ID, input: SendInput, tracked = false) {
    const scope = yield* memberScope(caller, input.sessionID)
    const messageID = input.messageID ?? SessionMessage.ID.create()
    const delivery = input.delivery ?? "queue"
    return yield* sendLock.withLock(scope.groupID)(
      SessionPending.withInboxLock(input.sessionID)(
        Effect.gen(function* () {
          if (!tracked && (yield* eventByID(taskReceipt("recorded", messageID))) !== undefined)
            return yield* refuse("Message identity belongs to a tracked Project task")
          const existing = yield* SessionPending.lookup(db, input.sessionID, messageID).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof SessionPending.LifecycleConflict ? Effect.fail(refuse(`Message ${messageID} is already used`)) : Effect.die(defect),
            ),
          )
          if (existing !== undefined) {
            if (tracked) return yield* refuse("Message identity is already used")
            const metadata = existing.type === "user" ? existing.data.metadata : undefined
            const provenance = metadata?.coordination as { groupID?: unknown } | undefined
            if (existing.type !== "user" || existing.sessionID !== input.sessionID || metadata?.inputOrigin !== "coordination" || provenance?.groupID !== scope.groupID || existing.data.text !== input.text)
              return yield* refuse(`Message ${messageID} is already used with different content`)
            return { sessionID: input.sessionID, messageID, state: yield* stateOf(scope, input.sessionID), reconciled: true }
          }
          const current = yield* memberScope(caller, input.sessionID)
          if (current?.groupID !== scope.groupID || !current.memberSessionIDs.includes(input.sessionID)) return yield* refuse(`Session ${input.sessionID} is not a member of this Project`)
          if (current === undefined || !current.active) return yield* refuse(inactiveMessage)
          const waiting = (yield* decisions.pending({ groupID: scope.groupID, coordinatorSessionID: caller, targetSessionID: input.sessionID, limit: Coordination.maxPending }))
            .map((item) => summarize(input.sessionID, item))
          if (waiting.length > 0) return yield* refuse(waitingMessage(input.sessionID, waiting))
          const { running } = yield* sessions.outstanding()
          const queued = yield* hasPendingInput(scope.memberSessionIDs)
          const busy = (sessionID: SessionSchema.ID) => running.has(sessionID) || queued.has(sessionID)
          const limit = current.settings.concurrency
          if (limit !== null && !busy(input.sessionID) && scope.memberSessionIDs.filter(busy).length >= limit)
            return yield* refuse(limitMessage(limit))
          if (input.model !== undefined) yield* options.validateModel(input.sessionID, input.model)
          yield* events.publish(SessionEvent.InputAdmitted, {
            sessionID: input.sessionID,
            inputID: messageID,
            input: {
              type: "user",
              delivery,
              data: {
                text: input.text,
                metadata: {
                  inputOrigin: "coordination",
                  coordination: { groupID: scope.groupID, masterSessionID: scope.masterSessionID, senderSessionID: caller, messageID, ...(input.model === undefined ? {} : { model: input.model }) },
                },
              },
            },
          }, tracked ? { id: taskReceipt("admitted", messageID) } : undefined)
          senders.set(input.sessionID, caller)
          yield* execution.wake(input.sessionID)
          return { sessionID: input.sessionID, messageID, state: yield* stateOf(scope, input.sessionID), reconciled: false }
        }),
      ),
    )
  })

  const eventByID = (id: EventRuntime.ID) => db.select().from(EventTable).where(eq(EventTable.id, id)).get().pipe(Effect.orDie)
  const sessionRow = (id: SessionSchema.ID) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
  const groupJournal = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
    const rows = yield* db.select().from(EventTable).where(and(eq(EventTable.aggregate_id, groupID), inArray(EventTable.type, [
      recordedType, dispatchedType, settledType, versionedType(Coordination.Event.OwnerChanged.type, 1), versionedType(Coordination.Event.Changed.type, 1),
    ]))).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
    const tasks = new Map<SessionMessage.ID, { task: Coordination.BoardTask; text: string; delivery?: SessionPending.Delivery; model?: Model.Ref; dispatched: boolean }>()
    const owners = new Map<SessionSchema.ID, SessionSchema.ID | undefined>()
    const handoffs: Coordination.BoardHandoff[] = []
    for (const row of rows) {
      if (row.type === recordedType) {
        const { task, text, delivery, model } = Schema.decodeUnknownSync(TaskRecorded.data)(row.data)
        tasks.set(task.taskID, { task, text, delivery, model, dispatched: false })
      } else if (row.type === dispatchedType) {
        const { taskID } = Schema.decodeUnknownSync(TaskDispatched.data)(row.data)
        const entry = tasks.get(taskID)
        if (entry) entry.dispatched = true
      } else if (row.type === settledType) {
        const { taskID, state, result } = Schema.decodeUnknownSync(TaskSettled.data)(row.data)
        const entry = tasks.get(taskID)
        if (entry) entry.task = { ...entry.task, state, ...(result === undefined ? {} : { result }) }
      } else if (row.type === versionedType(Coordination.Event.OwnerChanged.type, 1)) {
        const { sessionID, ownerSessionID } = Schema.decodeUnknownSync(Coordination.Event.OwnerChanged.data)(row.data)
        const previous = owners.get(sessionID)
        owners.set(sessionID, ownerSessionID)
        handoffs.push({ sessionID, time: row.created, ...(previous === undefined ? {} : { fromSessionID: previous }), ...(ownerSessionID === undefined ? {} : { toSessionID: ownerSessionID }) })
      } else {
        const { memberSessionIDs } = Schema.decodeUnknownSync(Coordination.Event.Changed.data)(row.data)
        for (const owner of owners.keys()) if (!memberSessionIDs.includes(owner)) owners.delete(owner)
      }
    }
    return { tasks, handoffs }
  })

  const board: Interface["board"] = Effect.fn("CoordinationRuntime.board")(function* (groupID) {
    const group = yield* coordination.get(groupID)
    const { tasks, handoffs } = yield* groupJournal(groupID)
    const { running } = yield* sessions.outstanding()
    const owners = new Map(yield* Effect.forEach(group.memberSessionIDs, (id) => ownerOf(groupID, id).pipe(Effect.map((owner) => [id, owner?.sessionID] as const))))
    const supervisors = new Set([...owners.values(), ...handoffs.map((handoff) => handoff.toSessionID)])
    const nodes: Coordination.BoardNode[] = []
    const reviews: Coordination.BoardReview[] = []
    const waiting = new Set<SessionSchema.ID>()
    for (const sessionID of [group.masterSessionID, ...group.memberSessionIDs]) {
      const row = yield* sessionRow(sessionID)
      if (row === undefined) continue
      const master = sessionID === group.masterSessionID
      const children: Coordination.BoardNode[] = []
      const parents = [sessionID]
      const seen = new Set(parents)
      while (parents.length > 0) {
        const parent = parents.pop()!
        const tasks = yield* db.select({ task: SessionTaskTable, session: SessionTable }).from(SessionTaskTable)
          .innerJoin(SessionTable, and(eq(SessionTable.id, SessionTaskTable.session_id), eq(SessionTable.parent_id, parent), isNull(SessionTable.time_archived)))
          .where(eq(SessionTaskTable.parent_id, parent)).orderBy(asc(SessionTaskTable.session_id)).all().pipe(Effect.orDie)
        for (const { task, session } of tasks) {
          if (seen.has(session.id)) continue
          seen.add(session.id)
          parents.push(session.id)
          const supervisor = parent === group.masterSessionID && (supervisors.has(session.id) || task.state === "supervising")
          children.push({ sessionID: session.id, parentSessionID: parent, role: supervisor ? "supervisor" : "subagent", title: session.title,
            state: task.state, agentID: Agent.ID.make(session.agent ?? task.agent), model: session.model ?? task.model })
        }
      }
      const descendants = children.map((child) => child.sessionID)
      const pending = yield* decisions.pending({ groupID, coordinatorSessionID: group.masterSessionID, targetSessionID: sessionID, descendantSessionIDs: descendants, limit: Coordination.maxPending })
      for (const item of pending) {
        const request = summarize(sessionID, item)
        if (request.requestSessionID !== undefined && !descendants.includes(request.requestSessionID)) continue
        reviews.push({ sessionID, request })
        waiting.add(request.requestSessionID ?? sessionID)
      }
      nodes.push({ sessionID, role: master ? "master" : "member", title: row.title,
        ...(master ? {} : { parentSessionID: owners.get(sessionID) ?? group.masterSessionID }),
        state: running.has(sessionID) ? "running" : (yield* lastFailed(sessionID)) ? "failed" : "idle",
        ...(row.agent === null ? {} : { agentID: Agent.ID.make(row.agent) }), ...(row.model === null ? {} : { model: row.model }),
      }, ...children)
    }
    const visible = new Set(nodes.map((node) => node.sessionID))
    return {
      groupID, handoffs, reviews,
      nodes: nodes.map((node) => ({ ...node, state: waiting.has(node.sessionID) ? "waiting" : node.state,
        ...(node.role === "member" && node.parentSessionID !== undefined && !visible.has(node.parentSessionID) ? { parentSessionID: group.masterSessionID } : {}),
      })),
      tasks: yield* Effect.forEach([...tasks.values()], ({ task, dispatched }) => Effect.gen(function* () {
        if (terminalTask(task.state)) return task
        const state: Coordination.BoardTask["state"] = task.dependsOnTaskIDs.some((id) => tasks.get(id)?.task.state !== "completed") ? "blocked"
          : reviews.some((review) => review.sessionID === task.sessionID) ? "waiting"
          : dispatched && (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).where(and(eq(SessionMessageTable.session_id, task.sessionID), eq(SessionMessageTable.id, task.taskID))).get().pipe(Effect.orDie)) !== undefined ? "running" : "queued"
        return { ...task, state }
      })),
    }
  })

  const settleAssignment = (groupID: Coordination.GroupID, task: Coordination.BoardTask, state: Coordination.BoardTask["state"], result?: Coordination.TaskResult) =>
    events.publish(TaskSettled, { groupID, taskID: task.taskID, state, ...(result === undefined ? {} : { result }) }, { id: taskReceipt("settled", task.taskID) })

  const assignmentOutcome = Effect.fnUntraced(function* (task: Coordination.BoardTask) {
    const admission = yield* eventByID(taskReceipt("admitted", task.taskID))
    if (admission === undefined) return { state: "failed" as const, result: { summary: "Dispatch could not be verified; task was not replayed" } }
    const rows = yield* db.select().from(EventTable).where(and(eq(EventTable.aggregate_id, task.sessionID), gt(EventTable.seq, admission.seq), inArray(EventTable.type, [
      ...executionTypes, versionedType(SessionEvent.InputPromoted.type, 1), versionedType(SessionEvent.Step.Ended.type, 1),
    ]))).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
    let promoted = false
    let started = false
    let messageID: SessionMessage.ID | undefined
    for (const row of rows) {
      if (row.type === versionedType(SessionEvent.Execution.Started.type, 1)) started = true
      if (row.type === versionedType(SessionEvent.InputPromoted.type, 1)) {
        if (row.data.inputID === task.taskID) promoted = true
        else if (promoted) return { state: "cancelled" as const }
      }
      if (promoted && row.type === versionedType(SessionEvent.Step.Ended.type, 1) && Schema.is(SessionMessage.ID)(row.data.assistantMessageID)) messageID = row.data.assistantMessageID
      if (promoted && row.type === versionedType(SessionEvent.Execution.Succeeded.type, 1)) {
        if (messageID === undefined) return { state: "completed" as const }
        const latest = yield* SessionHistory.latest(db, task.sessionID, "assistant").pipe(Effect.catchTag("Session.MessageDecodeError", () => Effect.succeed(undefined)))
        const summary = latest?.id === messageID ? assistantExcerpt(latest) : undefined
        return { state: "completed" as const, result: { messageID, ...(summary === undefined ? {} : { summary }) } }
      }
      if ((started || promoted) && row.type === failedType) {
        const { error } = Schema.decodeUnknownSync(SessionEvent.Execution.Failed.data)(row.data)
        if (promoted || error.type !== "interrupted") return { state: "failed" as const, result: { ...(messageID === undefined ? {} : { messageID }), summary: clip(error.message) } }
        started = false
      }
      if ((started || promoted) && row.type === versionedType(SessionEvent.Execution.Interrupted.type, 1)) return { state: "cancelled" as const }
    }
    return undefined
  })

  const advanceTasks = Effect.fnUntraced(function* (groupID: Coordination.GroupID) {
    const group = yield* coordination.get(groupID).pipe(Effect.option)
    if (group._tag === "None") return
    const { tasks } = yield* groupJournal(groupID)
    if (tasks.size === 0) return
    const busy = new Set<SessionSchema.ID>()
    for (const entry of tasks.values()) {
      if (!entry.dispatched || terminalTask(entry.task.state)) continue
      const outcome = yield* assignmentOutcome(entry.task)
      if (outcome === undefined) busy.add(entry.task.sessionID)
      else {
        yield* settleAssignment(groupID, entry.task, outcome.state, outcome.result)
        entry.task = { ...entry.task, state: outcome.state }
      }
    }
    for (const { task, dispatched, text, delivery, model } of tasks.values()) {
      if (dispatched || terminalTask(task.state)) continue
      const scope = yield* memberScope(task.ownerSessionID, task.sessionID).pipe(Effect.option)
      const session = yield* sessionRow(task.sessionID)
      if (scope._tag === "None" || scope.value.groupID !== groupID || group.value.masterSessionID !== scope.value.masterSessionID || !session || session.time_archived !== null) {
        yield* settleAssignment(groupID, task, "cancelled")
        continue
      }
      const running = yield* execution.active
      const queued = yield* hasPendingInput(scope.value.memberSessionIDs)
      const limit = scope.value.settings.concurrency
      if (!scope.value.active || session.time_suspended !== null || session.revert !== null || busy.has(task.sessionID) || running.has(task.sessionID) || queued.has(task.sessionID)
        || task.dependsOnTaskIDs.some((id) => tasks.get(id)?.task.state !== "completed")
        || (limit !== null && scope.value.memberSessionIDs.filter((id) => running.has(id) || queued.has(id) || busy.has(id)).length >= limit)
        || (yield* familyPending(scope.value, task.ownerSessionID, task.sessionID)).length > 0) continue
      yield* events.publish(TaskDispatched, { groupID, taskID: task.taskID }, { id: taskReceipt("dispatched", task.taskID) })
      const result = yield* send(task.ownerSessionID, { sessionID: task.sessionID, messageID: task.taskID, text, delivery, model }, true).pipe(Effect.result)
      if (result._tag === "Failure") {
        if ((yield* eventByID(taskReceipt("admitted", task.taskID))) === undefined) yield* settleAssignment(groupID, task, "failed", { summary: clip(result.failure.message) })
        else yield* Effect.logWarning("Project task was admitted but could not be woken", { taskID: task.taskID })
      } else busy.add(task.sessionID)
    }
  })

  const sendTask = Effect.fnUntraced(function* (caller: SessionSchema.ID, input: SendInput) {
    const scope = yield* memberScope(caller, input.sessionID)
    const taskID = input.messageID ?? SessionMessage.ID.create()
    const title = input.taskTitle ?? "Project assignment"
    const dependsOnTaskIDs = input.dependsOnTaskIDs ?? []
    if (!Schema.is(Coordination.TaskTitle)(title) || !Schema.is(Coordination.TaskDependencies)(dependsOnTaskIDs)
        || new Set(dependsOnTaskIDs).size !== dependsOnTaskIDs.length || input.text.length < 1 || input.text.length > 32000)
      return yield* refuse("Invalid Project task title, message or dependencies")
    const { tasks } = yield* groupJournal(scope.groupID)
    const existing = tasks.get(taskID)
    const task: Coordination.BoardTask = { taskID, title, sessionID: input.sessionID, ownerSessionID: caller, dependsOnTaskIDs, state: "queued" }
    if (existing !== undefined) {
      const identity = (task: Coordination.BoardTask, text: string, delivery: SessionPending.Delivery | undefined, model: Model.Ref | undefined) =>
        Hash.json([task.sessionID, task.ownerSessionID, task.title, task.dependsOnTaskIDs, text, delivery ?? "queue", model ?? null])
      if (identity(existing.task, existing.text, existing.delivery, existing.model) !== identity(task, input.text, input.delivery, input.model))
        return yield* refuse("Task identity is already used with different content")
    } else {
      if (!scope.active) return yield* refuse(inactiveMessage)
      if (dependsOnTaskIDs.some((id) => !tasks.has(id))) return yield* refuse("A dependency must name a previously recorded task in this Project")
      if ((yield* eventByID(taskReceipt("recorded", taskID))) !== undefined) return yield* refuse("Task identity is already used")
      const used = yield* SessionPending.lookup(db, input.sessionID, taskID).pipe(Effect.catchDefect((defect) =>
        defect instanceof SessionPending.LifecycleConflict ? Effect.fail(refuse("Message identity is already used")) : Effect.die(defect)))
      if (used !== undefined) return yield* refuse("Message identity is already used")
      if (input.model !== undefined) yield* options.validateModel(input.sessionID, input.model)
      yield* events.publish(TaskRecorded, { groupID: scope.groupID, task, text: input.text,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }), ...(input.model === undefined ? {} : { model: input.model }),
      }, { id: taskReceipt("recorded", taskID) })
    }
    yield* advanceTasks(scope.groupID)
    yield* invalidateBoard(scope.groupID)
    return { sessionID: input.sessionID, messageID: taskID, state: yield* stateOf(scope, input.sessionID), reconciled: existing !== undefined }
  })

  const invalidateBoard = (groupID: Coordination.GroupID) => coordination.get(groupID).pipe(
    Effect.flatMap(({ revision, masterSessionID }) => events.publish(Coordination.Event.Updated, { groupID, revision, sessionID: masterSessionID })), Effect.ignore,
  )

  const answer: Interface["answer"] = Effect.fn("CoordinationRuntime.answer")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    return yield* decisions.evaluate({
      groupID: scope.groupID,
      coordinatorSessionID: caller,
      targetSessionID: input.sessionID,
      descendantSessionIDs: yield* descendantsOf(input.sessionID),
      requestID: input.requestID,
      kind: input.kind,
      fingerprint: input.fingerprint,
      rationale: input.rationale,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
    })
  })

  const interrupt: Interface["interrupt"] = Effect.fn("CoordinationRuntime.interrupt")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    yield* execution.interrupt(input.sessionID)
    return { sessionID: input.sessionID, state: yield* stateOf(scope, input.sessionID) }
  })

  const fenced = <A, E, R>(caller: SessionSchema.ID, groupID: Coordination.GroupID | undefined, effect: Effect.Effect<A, E, R>) =>
    groupID === undefined ? underOwnership(caller, effect) : coordination.withOwnership(groupID, effect)

  const masterScope = Effect.fnUntraced(function* (caller: SessionSchema.ID, groupID: Coordination.GroupID | undefined, refusal: string) {
    const access = yield* coordination.accessOf(caller)
    if (groupID !== undefined && (access?.role !== "master" || access.scope.groupID !== groupID)) return yield* refuse(`Session ${caller} is not the Master of Project ${groupID}`)
    if (access?.role !== "master") return yield* refuse(refusal)
    return access.scope
  })

  const remove: Interface["remove"] = Effect.fn("CoordinationRuntime.remove")(function* (caller, input, options) {
    const scope = yield* masterScope(caller, options?.groupID, "Only the Project's Master removes member Sessions")
    if (!scope.memberSessionIDs.includes(input.sessionID)) return yield* refuse(`Session ${input.sessionID} is not a member of this Project`)
    const active = yield* execution.active
    if (active.has(input.sessionID) || (yield* SessionCompletion.backgroundWork(db, jobs, input.sessionID, active)) || (yield* hasDetachBlockingInput(input.sessionID)) || (yield* familyPending(scope, caller, input.sessionID)).length > 0)
      return yield* refuse(`Session ${input.sessionID} has active work or pending requests; wait for it to settle or interrupt it before removing it from the Project`)
    yield* coordination.removeMember(scope.groupID, { sessionID: input.sessionID }).pipe(Effect.mapError((error) => refuse(error.message)))
    yield* SessionTask.completeUnownedSupervisors(db, events)
    return { sessionID: input.sessionID, removed: true as const }
  })

  const planAttach = Effect.fnUntraced(function* (caller: SessionSchema.ID, input: Coordination.AttachInput, groupID: Coordination.GroupID | undefined) {
    const scope = yield* masterScope(caller, groupID, "Only the Project's Master attaches Sessions")
    const ownerSessionID = input.ownerSessionID ?? scope.masterSessionID
    const problem = yield* ownerProblem(scope, ownerSessionID)
    if (problem !== undefined) return yield* refuse(problem)
    if (input.sessionID === scope.masterSessionID) return yield* refuse("The Project's Master cannot attach itself as a member")
    const session = yield* sessions.get(input.sessionID).pipe(Effect.mapError(() => refuse(`Session ${input.sessionID} does not exist`)))
    if (session.parentID !== undefined) return yield* refuse(`Session ${session.id} is a child Session, not a root`)
    if (session.time.archived !== undefined) return yield* refuse(`Session ${session.id} is archived`)
    if (session.scope === "standalone") return yield* refuse(`Session ${session.id} is a standalone Session and cannot join a Project`)
    const receipt = { groupID: scope.groupID, sessionID: session.id, location: session.location, ownerSessionID }
    if (!scope.memberSessionIDs.includes(session.id)) return { receipt, member: false }
    if ((yield* ownerOf(scope.groupID, session.id))?.sessionID !== ownerSessionID)
      return yield* refuse(`Session ${session.id} is already a member of this Project with a different owner; use assign to change its owner`)
    return { receipt, member: true }
  })

  const attach: Interface["attach"] = (caller, input, options) => Effect.gen(function* () {
    const planned = yield* fenced(caller, options?.groupID, planAttach(caller, input, options?.groupID))
    if (planned.member) return { ...planned.receipt, reconciled: true }
    if (options?.authorizeLocation !== undefined) yield* options.authorizeLocation(planned.receipt.location)
    return yield* coordination.withOwnership(planned.receipt.groupID, Effect.gen(function* () {
      const current = yield* planAttach(caller, input, options?.groupID)
      if (current.receipt.groupID !== planned.receipt.groupID || current.receipt.location.directory !== planned.receipt.location.directory ||
        current.receipt.location.workspaceID !== planned.receipt.location.workspaceID)
        return yield* refuse(`Session ${input.sessionID} or the caller's Project changed during authorization; read the Project again before retrying`)
      if (current.member) return { ...current.receipt, reconciled: true }
      yield* coordination.addMember(current.receipt.groupID, { sessionID: input.sessionID, ownerSessionID: current.receipt.ownerSessionID, preserveAutonomy: true })
        .pipe(Effect.mapError((error) => refuse(error.message)))
      yield* SessionTask.superviseAttached(db, events, current.receipt.ownerSessionID)
      return { ...current.receipt, reconciled: false }
    }))
  }).pipe(Effect.withSpan("CoordinationRuntime.attach"))

  const assistantExcerpt = (assistant: SessionMessage.Info | undefined) => {
    if (assistant === undefined || assistant.type !== "assistant") return undefined
    if (assistant.error !== undefined) return clip(assistant.error.message)
    const text = assistant.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
    return text.length > 0 ? clip(text) : undefined
  }
  const excerptOf = (sessionID: SessionSchema.ID) => SessionHistory.latest(db, sessionID, "assistant").pipe(Effect.map(assistantExcerpt))

  const titleOf = (sessionID: SessionSchema.ID) =>
    db.select({ title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie, Effect.map((row) => row?.title ?? ""))

  const noticeID = (scope: CoordinationService.Scope, member: SessionSchema.ID, event: NotificationEvent, identity: string) =>
    SessionMessage.ID.make(`msg_project_notice_${Hash.sha256(`${scope.groupID}\0${member}\0${event}\0${identity}`).slice(0, 24)}`)

  const handoffIdentity = (receiver: SessionSchema.ID, request: Coordination.PendingRequest) =>
    `handoff\0${receiver}\0${request.requestID}\0${request.fingerprint}`

  const noticeDelivered = (receiver: SessionSchema.ID, id: SessionMessage.ID) =>
    SessionPending.lookup(db, receiver, id).pipe(
      Effect.catchDefect((defect) => (defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(true as const) : Effect.die(defect))),
      Effect.map((found) => found !== undefined),
    )

  const deliver = Effect.fnUntraced(function* (input: {
    readonly scope: CoordinationService.Scope
    readonly member: SessionSchema.ID
    readonly event: NotificationEvent
    readonly identity: string
    readonly receiver: SessionSchema.ID
    readonly resume: boolean
    readonly detail: Record<string, unknown>
    readonly escalationReason?: string
  }) {
    const escalated = input.escalationReason !== undefined
    const data = {
      source: escalated ? escalation : notice,
      groupID: input.scope.groupID,
      memberSessionID: input.member,
      ...(escalated ? { reason: input.escalationReason } : { title: yield* titleOf(input.member) }),
      event: input.event,
      ...input.detail,
    }
    const id = noticeID(input.scope, input.member, input.event, input.identity)
    if (yield* noticeDelivered(input.receiver, id)) return id
    yield* orchestration
      .notice({
        id,
        sessionID: input.receiver,
        text: `Project ${escalated ? "escalation" : "notification"}:\n${JSON.stringify(data)}`,
        description: `Project ${escalated ? "escalation" : "notification"}`,
        metadata: data,
        resume: input.resume,
      })
      .pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.catchTag("Session.SyntheticConflictError", () => Effect.void),
      )
    return id
  })

  const handoff = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, receiver: SessionSchema.ID | undefined, wake: boolean, reason = "unowned") {
    const target = receiver ?? scope.masterSessionID
    const pending = yield* familyPending(scope, target, member)
    yield* Effect.forEach(pending, (item) => {
      const request = summarize(member, item)
      return deliver({ scope, member, event: item.kind, identity: handoffIdentity(target, request), receiver: target, resume: wake,
        ...(receiver === undefined ? { escalationReason: reason } : {}),
        detail: { requestID: request.requestID, fingerprint: request.fingerprint, ...(request.requestSessionID === undefined ? {} : { requestSessionID: request.requestSessionID }),
          ...(receiver === undefined ? {} : { excerpt: request.summary }) } })
    }, { discard: true })
    let after: SessionSchema.ID | undefined
    while (true) {
      const children = yield* childQuestions(member, 100, after)
      if (children.length === 0) break
      for (const { task } of children) {
        const fingerprint = childFingerprint(task)
        yield* deliver({ scope, member, event: "question", identity: `child-question\0${target}\0${fingerprint}`, receiver: target, resume: wake,
          ...(receiver === undefined ? { escalationReason: reason } : {}),
          detail: { kind: "question", requestID: task.question_id, requestSessionID: task.session_id, revision: task.revision, fingerprint } })
      }
      after = children.at(-1)!.task.session_id
      yield* Effect.yieldNow
    }
  })

  const heldByHandoff = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, receiver: SessionSchema.ID, requestID: string) {
    const pending = yield* familyPending(scope, receiver, member)
    for (const item of pending) {
      const request = summarize(member, item)
      if (request.requestID === requestID && (yield* noticeDelivered(receiver, noticeID(scope, member, item.kind, handoffIdentity(receiver, request))))) return true
    }
    return false
  })

  const releaseStale = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, wake: boolean) {
    yield* coordination.setOwner(scope.groupID, { sessionID: member, reason: "released" }).pipe(Effect.orDie)
    yield* handoff(scope, member, undefined, wake, "owner-failed")
  })

  const receiverOf = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, wake: boolean) {
    const owner = (yield* ownerOf(scope.groupID, member))?.sessionID
    if (owner === undefined) return undefined
    if ((yield* ownerProblem(scope, owner)) === undefined) return owner
    yield* releaseStale(scope, member, wake)
    return undefined
  })

  const deliveredSequence = (scope: CoordinationService.Scope, member: SessionSchema.ID, receiver: SessionSchema.ID) =>
    db.select({ sequence: sql<number | null>`max(json_extract(${EventTable.data}, '$.input.data.metadata.memberSequence'))` })
      .from(EventTable).where(and(
        // A receipt can live in a previous owner's Session after an ownership transfer.
        sql`${EventTable.aggregate_id} IN (
          SELECT ${receiver}
          UNION
          SELECT json_extract(ownership.data, '$.ownerSessionID')
          FROM event AS ownership
          WHERE ownership.aggregate_id = ${scope.groupID}
            AND ownership.type = ${versionedType(Coordination.Event.OwnerChanged.type, Coordination.Event.OwnerChanged.durable.version)}
            AND json_extract(ownership.data, '$.sessionID') = ${member}
            AND json_type(ownership.data, '$.ownerSessionID') = 'text'
        )`,
        eq(EventTable.type, versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)),
        sql`json_extract(${EventTable.data}, '$.input.data.metadata.source') = ${notice}`,
        sql`json_extract(${EventTable.data}, '$.input.data.metadata.groupID') = ${scope.groupID}`,
        sql`json_extract(${EventTable.data}, '$.input.data.metadata.memberSessionID') = ${member}`)).get()
      .pipe(Effect.orDie, Effect.map(row => row?.sequence ?? -1))

  const notify = Effect.fnUntraced(function* (
    scope: CoordinationService.Scope,
    member: SessionSchema.ID,
    event: NotificationEvent,
    identity: string,
    detail: { readonly requestID?: string; readonly excerpt?: string; readonly requestSessionID?: SessionSchema.ID },
    wake = true,
  ) {
    const previousOwner = yield* ownerOf(scope.groupID, member)
    const receiver = yield* receiverOf(scope, member, wake)
    if (detail.requestID !== undefined && (yield* heldByHandoff(scope, member, receiver ?? scope.masterSessionID, detail.requestID))) return
    const pending = detail.requestID === undefined ? undefined :
      (yield* familyPending(scope, scope.masterSessionID, member))
        .map((item) => summarize(member, item)).find(request => request.requestID === detail.requestID)
    if (receiver === undefined) {
      if (!urgentEvents.has(event)) return
      yield* deliver({ scope, member, event, identity: pending === undefined ? identity : handoffIdentity(scope.masterSessionID, pending),
        receiver: scope.masterSessionID, resume: wake, escalationReason: previousOwner === undefined ? "unowned" : "owner-failed",
        detail: detail.requestID === undefined ? {} : { requestID: detail.requestID, ...(detail.requestSessionID === undefined ? {} : { requestSessionID: detail.requestSessionID }), ...(pending === undefined ? {} : { fingerprint: pending.fingerprint }) } })
      return
    }
    const retained = yield* db.select({ sequence: EventTable.seq }).from(EventTable).where(sql`${EventTable.id} = ${identity}`).get().pipe(Effect.orDie)
    if (!urgentEvents.has(event) && retained !== undefined && retained.sequence <= (yield* deliveredSequence(scope, member, receiver))) return
    const routed = event !== "started" && event !== "progress" && (scope.active || urgentEvents.has(event))
    yield* deliver({ scope, member, event, identity: pending === undefined ? identity : handoffIdentity(receiver, pending), receiver, resume: wake && routed,
      detail: { ...detail, ...(pending === undefined ? {} : { fingerprint: pending.fingerprint }), ...(retained === undefined ? {} : { memberSequence: retained.sequence }) } })
  })

  const deliverHeld = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, receiver: SessionSchema.ID, wake: boolean) {
    const membershipTypes = [Coordination.Event.Created, Coordination.Event.Changed].map(definition => versionedType(definition.type, definition.durable.version))
    let joined: number | undefined
    let before: number | undefined
    let boundary = false
    while (!boundary) {
      const history = yield* db.select().from(EventTable).where(and(eq(EventTable.aggregate_id, scope.groupID), inArray(EventTable.type, membershipTypes),
        before === undefined ? undefined : lt(EventTable.seq, before))).orderBy(desc(EventTable.seq)).limit(100).all().pipe(Effect.orDie)
      if (history.length === 0) break
      for (const row of history) {
        const snapshot = Schema.decodeUnknownSync(Coordination.Event.Created.data)(row.data)
        if (!snapshot.memberSessionIDs.includes(member)) { boundary = true; break }
        joined = row.created
      }
      before = history.at(-1)!.seq
      yield* Effect.yieldNow
    }
    if (joined === undefined) return
    const delivered = yield* deliveredSequence(scope, member, receiver)
    const types = [SessionEvent.Execution.Started, SessionEvent.Step.Ended, SessionEvent.Execution.Succeeded, SessionEvent.Execution.Interrupted]
      .map(definition => versionedType(definition.type, definition.durable.version))
    const held = and(eq(EventTable.aggregate_id, member), gte(EventTable.created, joined), gt(EventTable.seq, delivered), inArray(EventTable.type, types))
    const latest = yield* db.select().from(EventTable).where(held).orderBy(desc(EventTable.seq)).limit(1).get().pipe(Effect.orDie)
    if (latest === undefined) return
    const amount = yield* db.select({ count: count() }).from(EventTable).where(held).get().pipe(Effect.orDie)
    const event: NotificationEvent = latest.type === types[0] ? "started" : latest.type === types[1] ? "progress" : latest.type === types[2] ? "completed" : "interrupted"
    if (event === "completed" && (yield* workRemains(member))) return
    yield* deliver({ scope, member, event, identity: `held\0${receiver}\0${latest.id}`, receiver,
      resume: wake && scope.active && event !== "started" && event !== "progress",
      detail: { memberSequence: latest.seq, held: { count: amount?.count ?? 0 } } })
  })

  const escalate: Interface["escalate"] = Effect.fn("CoordinationRuntime.escalate")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const descendantSessionIDs = yield* descendantsOf(input.sessionID)
    const decision = yield* decisions.escalate({
      groupID: scope.groupID,
      coordinatorSessionID: caller,
      targetSessionID: input.sessionID,
      descendantSessionIDs,
      requestID: input.requestID,
      kind: input.kind,
      fingerprint: input.fingerprint,
      reason: input.reason,
    })
    const origin = decision.requestSessionID === undefined ? {} : { requestSessionID: decision.requestSessionID }
    if (decision.to !== "master") return { sessionID: input.sessionID, requestID: input.requestID, ...origin, delivered: false, decision }
    const messageID = yield* deliver({
      scope,
      member: input.sessionID,
      event: "escalated",
      identity: `${input.requestID}\0${caller}`,
      receiver: scope.masterSessionID,
      resume: true,
      escalationReason: input.reason,
      detail: { requestID: input.requestID, fingerprint: input.fingerprint, kind: input.kind, ...origin, escalatedBy: { sessionID: caller, title: yield* titleOf(caller) } },
    })
    return { sessionID: input.sessionID, requestID: input.requestID, ...origin, messageID, delivered: true, decision }
  })

  const inspect: Interface["inspect"] = Effect.fn("CoordinationRuntime.inspect")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const item = (yield* familyPending(scope, caller, input.sessionID))
      .find((pending) => (pending.kind === "question" ? pending.form.id : pending.request.id) === input.requestID)
    if (item === undefined) return yield* refuse(`Request ${input.requestID} is not pending for Session ${input.sessionID}`)
    return { ...requestDetail(item), ...requestOrigin(input.sessionID, item) }
  })

  const memberEvent = Effect.fnUntraced(function* (
    sessionID: string,
    event: NotificationEvent,
    identity: string,
    detail: (() => Effect.Effect<{ readonly requestID?: string; readonly excerpt?: string }, unknown>) | { readonly requestID?: string; readonly excerpt?: string; readonly requestSessionID?: SessionSchema.ID },
  ) {
    if (!Schema.is(SessionSchema.ID)(sessionID)) return
    const scope = yield* coordination.memberOf(sessionID)
    if (scope === undefined) return
    yield* notify(scope, sessionID, event, identity, typeof detail === "function" ? yield* detail() : detail)
  })

  const requestEvent = Effect.fnUntraced(function* (sessionID: string, event: NotificationEvent, requestID: string, excerpt: string) {
    if (!Schema.is(SessionSchema.ID)(sessionID)) return
    const member = yield* rootOf(sessionID)
    const scope = yield* coordination.memberOf(member)
    if (scope === undefined) return
    if (member !== sessionID && !(yield* descendantsOf(member)).includes(sessionID)) return
    yield* notify(scope, member, event, requestID, { requestID, excerpt, ...(member === sessionID ? {} : { requestSessionID: sessionID }) })
  })

  const hasDetachBlockingInput = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const inbox = yield* db.select({ id: SessionPendingTable.id, type: SessionPendingTable.type, data: SessionPendingTable.data })
      .from(SessionPendingTable).where(eq(SessionPendingTable.session_id, sessionID)).all().pipe(Effect.orDie)
    for (const row of inbox) {
      const meta = row.type === "synthetic" ? row.data.metadata : undefined
      if (meta?.source !== "subagent_notification" || !Schema.is(SessionSchema.ID)(meta.childID) || !Schema.is(NotificationType)(meta.type)
        || typeof meta.revision !== "number" || !Number.isSafeInteger(meta.revision) || meta.revision < 0) return true
      const task = yield* db.select().from(SessionTaskTable).where(and(eq(SessionTaskTable.session_id, meta.childID), eq(SessionTaskTable.parent_id, sessionID))).get().pipe(Effect.orDie)
      if (!task || !["completed", "failed", "cancelled", "lost"].includes(task.state) || task.revision < meta.revision ||
        row.id !== SessionOrchestrationIdentity.launch(sessionID, task.parent_assistant_message_id, task.tool_call_id).notification(meta.revision, meta.type)) return true
    }
    return false
  })

  const workRemains = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    return (yield* SessionCompletion.backgroundWork(db, jobs, sessionID, yield* execution.active)) || (yield* SessionCompletion.hasPending(db, [sessionID]))
  })

  const masterOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const scope = yield* coordination.scopeOf(sessionID)
    return scope !== undefined && scope.masterSessionID === sessionID ? scope : undefined
  })

  const handle = Effect.fnUntraced(function* (event: HandledEvent) {
    if (event.type === Coordination.Event.Changed.type || event.type === Coordination.Event.Deleted.type || event.type === SessionEvent.Deleted.type) {
      yield* SessionTask.completeUnownedSupervisors(db, events)
      return
    }
    if (event.type === SessionEvent.Archived.type) {
      const scope = yield* coordination.memberOf(event.data.sessionID)
      if (scope !== undefined && (yield* ownerOf(scope.groupID, event.data.sessionID)) !== undefined)
        yield* coordination.setOwner(scope.groupID, { sessionID: event.data.sessionID, reason: "released" }).pipe(Effect.orDie)
      const access = yield* coordination.accessOf(event.data.sessionID)
      if (access !== undefined)
        for (const member of access.ownedSessionIDs) yield* releaseStale(access.scope, member, true)
      yield* SessionTask.completeUnownedSupervisors(db, events)
      return
    }
    if (event.type === SessionEvent.Execution.Started.type || event.type === SessionEvent.Step.Ended.type) {
      yield* memberEvent(event.data.sessionID, event.type === SessionEvent.Execution.Started.type ? "started" : "progress", event.id, {})
      return
    }
    if (event.type === Coordination.Event.OwnerChanged.type) {
      yield* SessionTask.completeUnownedSupervisors(db, events)
      const scope = yield* coordination.memberOf(event.data.sessionID)
      if (scope === undefined || scope.groupID !== event.data.groupID) return
      const receiver = yield* receiverOf(scope, event.data.sessionID, true)
      if (receiver !== event.data.ownerSessionID) return
      if (receiver !== undefined) {
        yield* SessionTask.superviseAttached(db, events, receiver)
        yield* deliverHeld(scope, event.data.sessionID, receiver, true)
      }
      yield* handoff(scope, event.data.sessionID, receiver, true)
      return
    }
    if (event.type === SessionEvent.Task.Updated.type) {
      if (event.data.change.type === "question_asked") {
        const root = yield* rootOf(event.data.sessionID)
        const scope = yield* coordination.memberOf(root)
        if (scope !== undefined) {
          yield* handoff(scope, root, yield* receiverOf(scope, root, true), true)
        }
        return
      }
      const access = yield* coordination.accessOf(event.data.sessionID)
      if (access === undefined || (yield* ownerProblem(access.scope, event.data.sessionID)) === undefined) return
      for (const member of access.ownedSessionIDs) yield* releaseStale(access.scope, member, true)
      return
    }
    if (event.type === SessionEvent.InputAdmitted.type) {
      const data = event.data
      if (data.input.type !== "user" || data.input.data.metadata?.inputOrigin !== "direct") return
      const scope = yield* masterOf(data.sessionID)
      if (scope !== undefined) yield* coordination.activate(scope.groupID)
      return
    }
    if (event.type === SessionEvent.Execution.Interrupted.type) {
      const data = event.data
      const scope = yield* masterOf(data.sessionID)
      if (scope !== undefined && data.reason === "user") yield* coordination.pause(scope.groupID)
      yield* memberEvent(data.sessionID, "interrupted", event.id, { excerpt: `Interrupted (${data.reason})` })
      return
    }
    if (event.type === SessionEvent.Execution.Succeeded.type) {
      const sessionID = event.data.sessionID
      if (yield* workRemains(sessionID)) return
      yield* memberEvent(sessionID, "completed", event.id, () => excerptOf(sessionID).pipe(Effect.map((excerpt) => (excerpt === undefined ? {} : { excerpt }))))
      return
    }
    if (event.type === SessionEvent.Execution.Failed.type) {
      yield* memberEvent(event.data.sessionID, "failed", event.id, { excerpt: clip(event.data.error.message) })
      return
    }
    if (event.type === Form.Event.Created.type) {
      const form = event.data.form
      yield* requestEvent(form.sessionID, "question", form.id, clip(form.title))
      return
    }
    if (event.type === Permission.Event.Asked.type) {
      const data = event.data
      yield* requestEvent(data.sessionID, "permission", data.id, clip([data.action, ...data.resources].join(" ")))
      return
    }
    const data = event.data
    yield* requestEvent(data.sessionID, "review", data.id, clip(`${data.action} ${data.resources.join(" ")}: ${data.reason}`))
  })

  const recover = Effect.fn("CoordinationRuntime.recover")(function* () {
    yield* SessionTask.completeUnownedSupervisors(db, events)
    const types = [SessionEvent.Execution.Started, SessionEvent.Step.Ended, SessionEvent.Execution.Succeeded,
      SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted].map((definition) => versionedType(definition.type, definition.durable.version))
    for (const group of yield* coordination.list()) {
      yield* coordination.withOwnership(group.id, advanceTasks(group.id))
      const joined = new Map<SessionSchema.ID, number>()
      let groupAfter = -1
      while (true) {
        const changes = yield* db.select().from(EventTable).where(and(eq(EventTable.aggregate_id, group.id), gt(EventTable.seq, groupAfter),
          inArray(EventTable.type, [Coordination.Event.Created, Coordination.Event.Changed].map((definition) => versionedType(definition.type, definition.durable.version)))))
          .orderBy(asc(EventTable.seq)).limit(100).all().pipe(Effect.orDie)
        if (changes.length === 0) break
        for (const change of changes) {
          const snapshot = Schema.decodeUnknownSync(Coordination.Event.Created.data)(change.data)
          for (const member of joined.keys()) if (!snapshot.memberSessionIDs.includes(member)) joined.delete(member)
          for (const member of snapshot.memberSessionIDs) if (!joined.has(member)) joined.set(member, change.created)
        }
        groupAfter = changes.at(-1)!.seq
        yield* Effect.yieldNow
      }
      for (const member of group.memberSessionIDs) {
        const since = joined.get(member)
        if (since === undefined) continue
        yield* coordination.withOwnership(group.id, Effect.gen(function* () {
          const scope = yield* coordination.memberOf(member)
          if (scope?.groupID !== group.id) return
          if ((yield* sessions.get(member).pipe(Effect.orDie)).time.archived !== undefined) {
            if ((yield* ownerOf(scope.groupID, member)) !== undefined)
              yield* coordination.setOwner(scope.groupID, { sessionID: member, reason: "released" }).pipe(Effect.orDie)
            return
          }
          const receiver = yield* receiverOf(scope, member, false)
          if (receiver !== undefined) yield* deliverHeld(scope, member, receiver, false)
          yield* handoff(scope, member, receiver, false)
        }))
        let after = -1
        while (true) {
          const retained = yield* db.select().from(EventTable)
            .where(and(eq(EventTable.aggregate_id, member), gt(EventTable.seq, after), gte(EventTable.created, since), inArray(EventTable.type, types)))
            .orderBy(asc(EventTable.seq)).limit(100).all().pipe(Effect.orDie)
          if (retained.length === 0) break
          for (const event of retained) {
            yield* coordination.withOwnership(group.id, Effect.gen(function* () {
              const scope = yield* coordination.memberOf(member)
              if (scope?.groupID !== group.id) return
              const kind: NotificationEvent = event.type === versionedType(SessionEvent.Execution.Started.type, 1) ? "started"
                : event.type === versionedType(SessionEvent.Step.Ended.type, 1) ? "progress"
                : event.type === versionedType(SessionEvent.Execution.Succeeded.type, 1) ? "completed"
                : event.type === failedType ? "failed" : "interrupted"
              if (kind === "completed" && (yield* workRemains(member))) return
              const detail = kind === "failed" ? { excerpt: clip(Schema.decodeUnknownSync(SessionEvent.Execution.Failed.data)(event.data).error.message) }
                : kind === "interrupted" ? { excerpt: `Interrupted (${Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)(event.data).reason})` } : {}
              yield* notify(scope, member, kind, event.id, detail, false)
            }))
          }
          after = retained.at(-1)!.seq
          yield* Effect.yieldNow
        }
      }
    }
  })

  return {
    recover,
    get,
    board,
    summaries,
    roster,
    send: (caller, input) => underOwnership(caller, input.taskTitle !== undefined || input.dependsOnTaskIDs !== undefined ? sendTask(caller, input) : send(caller, input)),
    answer: (caller, input) => underOwnership(caller, answer(caller, input)),
    interrupt: (caller, input) => underOwnership(caller, interrupt(caller, input)),
    escalate: (caller, input) => underOwnership(caller, escalate(caller, input)),
    inspect: (caller, input) => underOwnership(caller, inspect(caller, input)),
    assign: (caller, input) => underOwnership(caller, assign(caller, input)),
    release: (caller, input) => underOwnership(caller, release(caller, input)),
    remove: (caller, input, options) => fenced(caller, options?.groupID, remove(caller, input, options)),
    attach,
    create,
    member,
    handle: (event) =>
      Effect.gen(function* () {
        if (event.type === Coordination.Event.Changed.type || event.type === Coordination.Event.Deleted.type) {
          yield* coordination.withOwnership(event.data.groupID, handle(event).pipe(Effect.andThen(advanceTasks(event.data.groupID))))
          yield* invalidateBoard(event.data.groupID)
          return
        }
        const sessionID = event.type === Form.Event.Created.type ? event.data.form.sessionID : event.data.sessionID
        if (!Schema.is(SessionSchema.ID)(sessionID)) return
        if (handledEvents.some((definition) => definition.type === event.type) &&
          (event.type !== SessionEvent.Task.Updated.type || ownerEndingChanges.has(event.data.change.type))) {
          const legacy = handle(event as HandledEvent)
          const access = yield* coordination.accessOf(sessionID)
          yield* (access === undefined ? legacy : coordination.withOwnership(access.scope.groupID, legacy))
        }
        const root = yield* rootOf(sessionID)
        const scope = (yield* coordination.scopeOf(root)) ?? (yield* coordination.memberOf(root))
        if (scope === undefined) return
        if (boardReadinessEvents.has(event.type)) yield* coordination.withOwnership(scope.groupID, advanceTasks(scope.groupID))
        yield* invalidateBoard(scope.groupID)
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning("Project event handling failed", { type: event.type, cause: Cause.pretty(cause) }),
        ),
      ),
  }
}

const text = (value: string, limit = 500) => DecisionChoice.redactText(value).slice(0, limit)

function requestOrigin(member: SessionSchema.ID, item: CoordinationDecisions.PendingSnapshot) {
  const sessionID = item.kind === "question" ? item.form.sessionID : item.request.sessionID
  return sessionID === member ? {} : { requestSessionID: SessionSchema.ID.make(sessionID) }
}
const boundedResources = (resources: ReadonlyArray<string>) => resources.slice(0, 20).map((resource) => text(resource))

function requestDetail(item: CoordinationDecisions.PendingSnapshot): RequestDetail {
  const escalation = (value: Coordination.Escalation | undefined) => CoordinationEscalation.redacted(value)
  if (item.kind === "question") {
    const explicit = CoordinationDecisions.coordinatorDecisionReason({
      kind: "question", action: "question", resources: [],
      metadata: {
        requireExplicitDecision: item.form.metadata?.requireExplicitDecision,
        title: item.form.title,
        fields: item.form.fields.map((field) => ("title" in field ? (field.title ?? field.key) : field.key)),
        metadata: item.form.metadata,
      },
    })
    return {
      kind: "question", requestID: item.form.id, fingerprint: item.fingerprint, title: text(item.form.title),
      fields: item.form.fields.slice(0, 20).map((field) => ({
        key: field.key, type: field.type,
        ...(field.title === undefined ? {} : { title: text(field.title, 200) }),
        ...("required" in field && field.required !== undefined ? { required: field.required } : {}),
        ...("options" in field && field.options !== undefined ? { options: field.options.slice(0, 20).map((option) => text(typeof option === "string" ? option : option.value, 200)) } : {}),
      })),
      delegation: explicit ?? "routine", ...escalation(item.form.coordinationEscalation),
    }
  }
  const request = item.request
  const routine = CoordinationDecisions.coordinatorRoutine({ kind: item.kind, action: request.action, resources: request.resources })
  if (item.kind === "permission") {
    const explicit = CoordinationDecisions.coordinatorDecisionReason({ kind: "permission", action: request.action, resources: request.resources, metadata: request.metadata })
    return {
      kind: "permission", requestID: request.id, fingerprint: item.fingerprint, action: request.action,
      resources: boundedResources(request.resources), delegation: explicit ?? (routine ? "routine" : "decline-only"),
      ...escalation(request.coordinationEscalation),
    }
  }
  const review = item.request
  const explicit = CoordinationDecisions.coordinatorDecisionReason({ kind: "review", action: review.action, resources: review.resources, metadata: review.metadata, hardReview: review.hardReview, ruleIDs: review.ruleIDs, standard: review.standard })
  return {
    kind: "review", requestID: review.id, fingerprint: item.fingerprint, action: review.action,
    resources: boundedResources(review.resources), ruleIDs: review.ruleIDs.slice(0, 20), reason: text(review.reason),
    hardReview: review.hardReview === true, standard: review.standard,
    delegation: explicit ?? (routine ? "routine" : "decline-only"),
    ...escalation(review.coordinationEscalation),
  }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationRuntime") {}

const layer: Layer.Layer<
  Service,
  never,
  | CoordinationService.Service
  | CoordinationDecisions.Service
  | Database.Service
  | EventRuntime.Service
  | SessionExecution.Service
  | Session.Service
  | SessionOrchestration.Service
  | SessionStore.Service
  | LocationServiceMap.Service
  | Job.Service
  | Project.Service
  | SessionStepBoundary.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const coordination = yield* CoordinationService.Service
    const database = yield* Database.Service
    const decisions = yield* CoordinationDecisions.Service
    const events = yield* EventRuntime.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* Session.Service
    const orchestration = yield* SessionOrchestration.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const { recordOpened } = yield* Project.Service
    const boundary = yield* SessionStepBoundary.Service
    const validateModel = Effect.fn("CoordinationRuntime.validateModel")(function* (sessionID: SessionSchema.ID, model: Model.Ref) {
      const session = yield* store.get(sessionID)
      if (session === undefined) return yield* refuse(`Session ${sessionID} does not exist`)
      yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        yield* models.resolve({ ...session, model }, { rebind: model.profile !== undefined })
      }).pipe(
        Effect.provide(locations.get(session.location, [LocationServiceMap.full])),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.fail(refuse(`Model ${model.providerID}/${model.id} is not available for Session ${sessionID}`)),
        ),
      )
    })
    const jobs = yield* Job.Service
    const runtime = make({ db: database.db, events, coordination, decisions, execution, sessions, orchestration, recordOpened, validateModel, jobs })
    const setModel: Interface["setModel"] = (caller, input) => boundary.withSelection(input.sessionID,
      execution.withTransition(input.sessionID, Effect.gen(function* () {
        const switchable = Effect.gen(function* () {
          const scope = yield* authorizeMember(coordination, caller, input.sessionID)
          const source = yield* sessions.get(caller)
          const session = yield* sessions.get(input.sessionID)
          if (source.time.archived !== undefined || session.time.archived !== undefined) return yield* refuse("Archived Sessions cannot change a member model")
          if (yield* CoordinationModel.override(database.db, session.id)) return yield* refuse("The member has an active coordination model override")
          const task = yield* database.db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, session.id)).get().pipe(Effect.orDie)
          if (task !== undefined) return yield* refuse("A managed child cannot be a Project member")
          return { scope, session }
        })
        const { session } = yield* switchable
        const binding = (yield* database.db.select({ value: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie))?.value
        const models = yield* SessionRunnerModel.Service.pipe(Effect.provide(locations.get(session.location, [LocationServiceMap.full])))
        const resolved = yield* models.resolve({ ...session, model: input.model }, { rebind: true, refresh: false })
        return yield* boundary.atBoundary(session.id, Effect.gen(function* () {
          const current = yield* switchable
          yield* coordination.withOwnership(current.scope.groupID, Effect.gen(function* () {
            yield* switchable
            const selected = yield* sessions.selectModelAtBoundary({ sessionID: session.id, expectedModel: input.expectedModel,
              model: input.model, connectionIdentityDigest: resolved.connectionIdentityDigest,
              targetBinding: resolved.profileBinding, expectedBinding: binding,
              guard: switchable.pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false))),
            })
            if (selected.status === "conflict") return yield* refuse("The member or expected model changed before selection; read the member and retry")
            if (selected.status === "blocked") return yield* refuse(`Target model is blocked: ${selected.reason}`)
            return undefined
          }))
          return yield* runtime.member(caller, input)
        }))
      }))).pipe(Effect.mapError(error => refuse(error.message)))
    yield* events.subscribe(boardEvents).pipe(Stream.runForEach(runtime.handle), Effect.forkScoped({ startImmediately: true }))
    yield* runtime.recover().pipe(
      Effect.catchTags({
        "Session.ScopeUnavailableError": (error) => Effect.logError("Coordination recovery could not wake Session", { error }),
        "SessionOrchestration.ServiceUnavailableError": (error) => Effect.logError("Coordination recovery could not access managed task ownership", { error }),
        "EventRuntime.TaskOwnerUnavailable": (error) => Effect.logError("Coordination recovery has no managed task owner", { error }),
      }),
    )
    return Service.of({ ...runtime, setModel })
  }),
)

export const node: Node.GlobalNode<Service> = makeGlobalNode({
  service: Service,
  layer,
  deps: [CoordinationService.node, CoordinationDecisionRuntime.node, Database.node, EventRuntime.node, SessionExecution.node, Session.node, SessionOrchestration.node, SessionStore.node, LocationServiceMap.node, Job.node, Project.node, SessionStepBoundary.node],
})
