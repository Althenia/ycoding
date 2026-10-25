export * as CoordinationRuntime from "./coordination-runtime"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Form } from "@ycoding-ai/schema/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import type { Model } from "@ycoding-ai/schema/model"
import { Permission } from "@ycoding-ai/schema/permission"
import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { CoordinationDecisionRuntime } from "../coordination/decisions"
import { CoordinationService } from "../coordination/index"
import { CoordinationMemberTable } from "../coordination/sql"
import { Database } from "../database/database"
import { makeGlobalNode, type Node } from "../effect/app-node"
import { Job } from "../job"
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
import { SessionPending } from "./pending"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { Session } from "../session"
import { SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"
import { SessionStore } from "./store"

export class RefusedError extends Schema.TaggedErrorClass<RefusedError>()("Coordination.RefusedError", {
  message: Schema.String,
}) {}

export const notice = "project_notification"
export const maxExcerpt = 500
export const inactiveMessage = "Project is inactive; send a message in the master chat to resume"
export const limitMessage = (limit: number) => `Project concurrency limit ${limit} reached`

export interface SendInput {
  readonly sessionID: SessionSchema.ID
  readonly text: string
  readonly delivery?: SessionPending.Delivery
  readonly messageID?: SessionMessage.ID
  readonly model?: Model.Ref
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
  readonly messageID?: SessionMessage.ID
  readonly delivered: boolean
  readonly decision: CoordinationDecisions.EscalateResult
}

export type Delegation = "routine" | "decline-only" | "escalate" | `human-only:${string}`

export type RequestDetail =
  | { readonly kind: "permission"; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }
  | { readonly kind: "review"; readonly requestID: string; readonly fingerprint: string; readonly action: string; readonly resources: ReadonlyArray<string>; readonly ruleIDs: ReadonlyArray<string>; readonly reason: string; readonly hardReview: boolean; readonly standard: boolean; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }
  | { readonly kind: "question"; readonly requestID: string; readonly fingerprint: string; readonly title: string; readonly fields: ReadonlyArray<{ readonly key: string; readonly type: string; readonly title?: string; readonly required?: boolean; readonly options?: ReadonlyArray<string> }>; readonly delegation: Delegation; readonly coordinationEscalation?: Coordination.Escalation }

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
] as const
type HandledEvent = EventRuntime.SubscribePayload<typeof handledEvents>

export interface Interface {
  readonly get: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Info, CoordinationService.NotFoundError>
  readonly summaries: () => Effect.Effect<ReadonlyArray<Coordination.GroupSummary>>
  readonly roster: (caller: SessionSchema.ID) => Effect.Effect<Roster, RefusedError>
  readonly send: (caller: SessionSchema.ID, input: SendInput) => Effect.Effect<SendResult, RefusedError>
  readonly answer: (caller: SessionSchema.ID, input: AnswerInput) => Effect.Effect<CoordinationDecisions.Result, RefusedError>
  readonly interrupt: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly state: Coordination.MemberState }, RefusedError>
  readonly inspect: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID; readonly requestID: string }) => Effect.Effect<RequestDetail, RefusedError>
  readonly escalate: (caller: SessionSchema.ID, input: EscalateInput) => Effect.Effect<EscalateResult, RefusedError>
  readonly assign: (caller: SessionSchema.ID, input: AssignInput) => Effect.Effect<OwnershipResult, RefusedError>
  readonly release: (caller: SessionSchema.ID, input: ReleaseInput) => Effect.Effect<OwnershipResult, RefusedError>
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly coordination: Pick<CoordinationService.Interface, "get" | "list" | "scopeOf" | "memberOf" | "accessOf" | "withOwnership" | "activate" | "pause" | "setOwner">
  readonly decisions: Pick<CoordinationDecisions.Interface, "pending" | "evaluate" | "escalate">
  readonly execution: Pick<SessionExecution.Interface, "active" | "wake" | "interrupt">
  readonly sessions: Pick<Session.Interface, "synthetic">
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

const clip = (text: string) => (text.length > maxExcerpt ? `${text.slice(0, maxExcerpt - 1)}…` : text)

export function make(options: Options): Interface & { readonly handle: (event: HandledEvent) => Effect.Effect<void>; readonly recover: () => Effect.Effect<void> } {
  const { db, events, coordination, decisions, execution, sessions, jobs } = options
  const senders = new Map<SessionSchema.ID, SessionSchema.ID>()
  const sendLock = KeyedMutex.makeUnsafe<Coordination.GroupID>()

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

  const memberScope = Effect.fnUntraced(function* (caller: SessionSchema.ID, sessionID: SessionSchema.ID) {
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

  const assign: Interface["assign"] = Effect.fn("CoordinationRuntime.assign")(function* (caller, input) {
    const scope = yield* scopeFor(caller)
    if (caller !== scope.masterSessionID) return yield* refuse("Only the Project's Master assigns member ownership")
    if (!scope.memberSessionIDs.includes(input.sessionID)) return yield* refuse(`Session ${input.sessionID} is not a member of this Project`)
    const managed = yield* db.select({ id: SessionTaskTable.session_id }).from(SessionTaskTable)
      .where(and(eq(SessionTaskTable.session_id, input.ownerSessionID), eq(SessionTaskTable.parent_id, scope.masterSessionID)))
      .get().pipe(Effect.orDie)
    if (input.ownerSessionID !== scope.masterSessionID && !managed) return yield* refuse(`Session ${input.ownerSessionID} is not a subagent the Master launched`)
    yield* coordination.setOwner(scope.groupID, { sessionID: input.sessionID, ownerSessionID: input.ownerSessionID }).pipe(Effect.orDie)
    return { sessionID: input.sessionID, ...ownership(yield* ownerOf(scope.groupID, input.sessionID)) }
  })

  const release: Interface["release"] = Effect.fn("CoordinationRuntime.release")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const owner = yield* ownerOf(scope.groupID, input.sessionID)
    if (owner === undefined) return yield* refuse(`Session ${input.sessionID} has no owner to release`)
    if (caller !== scope.masterSessionID && caller !== owner.sessionID)
      return yield* refuse("Only the Project's Master or the member's owner releases its ownership")
    yield* coordination.setOwner(scope.groupID, { sessionID: input.sessionID, reason: input.reason }).pipe(Effect.orDie)
    return { sessionID: input.sessionID }
  })

  const summarize = (item: CoordinationDecisions.PendingSnapshot): Coordination.PendingRequest => {
    if (item.kind === "permission")
      return { kind: "permission", requestID: item.request.id, fingerprint: item.fingerprint, summary: clip([item.request.action, ...item.request.resources].join(" ")) }
    if (item.kind === "review")
      return { kind: "review", requestID: item.request.id, fingerprint: item.fingerprint, summary: clip(`${item.request.action} ${item.request.resources.join(" ")}: ${item.request.reason}`) }
    return { kind: "question", requestID: item.form.id, fingerprint: item.fingerprint, summary: clip(item.form.title) }
  }

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
    const pending = (yield* decisions.pending({ groupID: scope.groupID, coordinatorSessionID: scope.masterSessionID, targetSessionID: sessionID, limit: Coordination.maxPending })).map(summarize)
    const state: Coordination.MemberState =
      pending.length > 0 ? "waiting" : running.has(sessionID) ? "running" : (yield* lastFailed(sessionID)) ? "failed" : "idle"
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
    execution.active.pipe(Effect.flatMap((running) => participant(scope, sessionID, running)), Effect.map((value) => value.state))

  const get: Interface["get"] = Effect.fn("CoordinationRuntime.get")(function* (groupID) {
    const group = yield* coordination.get(groupID)
    const scope: CoordinationService.Scope = {
      groupID: group.id, masterSessionID: group.masterSessionID, memberSessionIDs: group.memberSessionIDs, settings: group.settings, active: group.active,
    }
    const running = yield* execution.active
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
    const running = yield* execution.active
    return {
      project: { id: scope.groupID, name: group.name, active: scope.active, concurrency: scope.settings.concurrency, ...(group.pausedReason === undefined ? {} : { pausedReason: group.pausedReason }) },
      members: yield* Effect.forEach(scope.memberSessionIDs, (sessionID) => participant(scope, sessionID, running)),
    }
  })

  const send: Interface["send"] = Effect.fn("CoordinationRuntime.send")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const messageID = input.messageID ?? SessionMessage.ID.create()
    const delivery = input.delivery ?? "queue"
    return yield* sendLock.withLock(scope.groupID)(
      SessionPending.withInboxLock(input.sessionID)(
        Effect.gen(function* () {
          const existing = yield* SessionPending.lookup(db, input.sessionID, messageID).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof SessionPending.LifecycleConflict ? Effect.fail(refuse(`Message ${messageID} is already used`)) : Effect.die(defect),
            ),
          )
          if (existing !== undefined) {
            const metadata = existing.type === "user" ? existing.data.metadata : undefined
            const provenance = metadata?.coordination as { groupID?: unknown } | undefined
            if (existing.type !== "user" || existing.sessionID !== input.sessionID || metadata?.inputOrigin !== "coordination" || provenance?.groupID !== scope.groupID || existing.data.text !== input.text)
              return yield* refuse(`Message ${messageID} is already used with different content`)
            return { sessionID: input.sessionID, messageID, state: yield* stateOf(scope, input.sessionID), reconciled: true }
          }
          const current = yield* memberScope(caller, input.sessionID)
          if (current?.groupID !== scope.groupID || !current.memberSessionIDs.includes(input.sessionID)) return yield* refuse(`Session ${input.sessionID} is not a member of this Project`)
          if (current === undefined || !current.active) return yield* refuse(inactiveMessage)
          const running = yield* execution.active
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
          })
          senders.set(input.sessionID, caller)
          yield* execution.wake(input.sessionID)
          return { sessionID: input.sessionID, messageID, state: yield* stateOf(scope, input.sessionID), reconciled: false }
        }),
      ),
    )
  })

  const answer: Interface["answer"] = Effect.fn("CoordinationRuntime.answer")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    return yield* decisions.evaluate({
      groupID: scope.groupID,
      coordinatorSessionID: caller,
      targetSessionID: input.sessionID,
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

  const excerptOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const assistant = yield* SessionHistory.latest(db, sessionID, "assistant")
    if (assistant === undefined || assistant.type !== "assistant") return undefined
    const text = assistant.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
    return text.length > 0 ? clip(text) : undefined
  })

  const titleOf = (sessionID: SessionSchema.ID) =>
    db.select({ title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie, Effect.map((row) => row?.title ?? ""))

  const deliver = Effect.fnUntraced(function* (input: {
    readonly scope: CoordinationService.Scope
    readonly member: SessionSchema.ID
    readonly event: NotificationEvent
    readonly identity: string
    readonly receiver: SessionSchema.ID
    readonly resume: boolean
    readonly detail: Record<string, unknown>
  }) {
    const data = {
      source: notice,
      groupID: input.scope.groupID,
      memberSessionID: input.member,
      title: yield* titleOf(input.member),
      event: input.event,
      ...input.detail,
    }
    const id = SessionMessage.ID.make(`msg_project_notice_${Hash.sha256(`${input.scope.groupID}\0${input.member}\0${input.event}\0${input.identity}`).slice(0, 24)}`)
    const delivered = yield* SessionPending.lookup(db, input.receiver, id).pipe(Effect.catchDefect((defect) =>
      defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(true as const) : Effect.die(defect),
    ))
    if (delivered !== undefined) return id
    yield* sessions
      .synthetic({
        id,
        sessionID: input.receiver,
        text: `Project notification:\n${JSON.stringify(data)}`,
        description: "Project notification",
        metadata: data,
        delivery: "steer",
        resume: input.resume,
      })
      .pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.catchTag("Session.SyntheticConflictError", () => Effect.void),
      )
    return id
  })

  const notify = Effect.fnUntraced(function* (
    scope: CoordinationService.Scope,
    member: SessionSchema.ID,
    event: NotificationEvent,
    identity: string,
    detail: { readonly requestID?: string; readonly excerpt?: string },
    wake = true,
  ) {
    const routed = scope.active || urgentEvents.has(event)
    const access = yield* coordination.accessOf(member)
    yield* deliver({ scope, member, event, identity, receiver: access?.ownerSessionID ?? scope.masterSessionID, resume: wake && routed, detail })
  })

  const escalate: Interface["escalate"] = Effect.fn("CoordinationRuntime.escalate")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const decision = yield* decisions.escalate({
      groupID: scope.groupID,
      coordinatorSessionID: caller,
      targetSessionID: input.sessionID,
      requestID: input.requestID,
      kind: input.kind,
      fingerprint: input.fingerprint,
      reason: input.reason,
    })
    if (decision.to !== "master") return { sessionID: input.sessionID, requestID: input.requestID, delivered: false, decision }
    const messageID = yield* deliver({
      scope,
      member: input.sessionID,
      event: "escalated",
      identity: `${input.requestID}\0${caller}`,
      receiver: scope.masterSessionID,
      resume: true,
      detail: { requestID: input.requestID, kind: input.kind, excerpt: clip(input.reason), escalatedBy: { sessionID: caller, title: yield* titleOf(caller) } },
    })
    return { sessionID: input.sessionID, requestID: input.requestID, messageID, delivered: true, decision }
  })

  const inspect: Interface["inspect"] = Effect.fn("CoordinationRuntime.inspect")(function* (caller, input) {
    const scope = yield* memberScope(caller, input.sessionID)
    const item = (yield* decisions.pending({ groupID: scope.groupID, coordinatorSessionID: caller, targetSessionID: input.sessionID, limit: Coordination.maxPending }))
      .find((pending) => (pending.kind === "question" ? pending.form.id : pending.request.id) === input.requestID)
    if (item === undefined) return yield* refuse(`Request ${input.requestID} is not pending for Session ${input.sessionID}`)
    return requestDetail(item)
  })

  const memberEvent = Effect.fnUntraced(function* (
    sessionID: string,
    event: NotificationEvent,
    identity: string,
    detail: (() => Effect.Effect<{ readonly requestID?: string; readonly excerpt?: string }, unknown>) | { readonly requestID?: string; readonly excerpt?: string },
  ) {
    if (!Schema.is(SessionSchema.ID)(sessionID)) return
    const scope = yield* coordination.memberOf(sessionID)
    if (scope === undefined) return
    yield* notify(scope, sessionID, event, identity, typeof detail === "function" ? yield* detail() : detail)
  })

  const masterOf = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const scope = yield* coordination.scopeOf(sessionID)
    return scope !== undefined && scope.masterSessionID === sessionID ? scope : undefined
  })

  const handle = Effect.fnUntraced(function* (event: HandledEvent) {
    if (event.type === SessionEvent.Execution.Started.type || event.type === SessionEvent.Step.Ended.type) {
      yield* memberEvent(event.data.sessionID, event.type === SessionEvent.Execution.Started.type ? "started" : "progress", event.id, {})
      return
    }
    if (event.type === Coordination.Event.OwnerChanged.type) {
      const scope = yield* coordination.memberOf(event.data.sessionID)
      if (scope === undefined || scope.groupID !== event.data.groupID) return
      const access = yield* coordination.accessOf(event.data.sessionID)
      const receiver = access?.ownerSessionID ?? scope.masterSessionID
      if (receiver !== (event.data.ownerSessionID ?? scope.masterSessionID)) return
      const pending = yield* decisions.pending({ groupID: scope.groupID, coordinatorSessionID: receiver, targetSessionID: event.data.sessionID, limit: Coordination.maxPending })
      for (const item of pending) {
        const request = summarize(item)
        yield* deliver({ scope, member: event.data.sessionID, event: item.kind, identity: `handoff\0${receiver}\0${request.requestID}\0${request.fingerprint}`, receiver, resume: true,
          detail: { requestID: request.requestID, excerpt: request.summary } })
      }
      return
    }
    if (event.type === SessionEvent.InputAdmitted.type) {
      const data = event.data
      if (data.input.type !== "user" || data.input.data.metadata?.inputOrigin !== "human") return
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
      if (yield* SessionCompletion.backgroundWork(db, jobs, sessionID, yield* execution.active)) return
      yield* memberEvent(sessionID, "completed", event.id, () => excerptOf(sessionID).pipe(Effect.map((excerpt) => (excerpt === undefined ? {} : { excerpt }))))
      return
    }
    if (event.type === SessionEvent.Execution.Failed.type) {
      yield* memberEvent(event.data.sessionID, "failed", event.id, { excerpt: clip(event.data.error.message) })
      return
    }
    if (event.type === Form.Event.Created.type) {
      const form = event.data.form
      yield* memberEvent(form.sessionID, "question", form.id, { requestID: form.id, excerpt: clip(form.title) })
      return
    }
    if (event.type === Permission.Event.Asked.type) {
      const data = event.data
      yield* memberEvent(data.sessionID, "permission", data.id, { requestID: data.id, excerpt: clip([data.action, ...data.resources].join(" ")) })
      return
    }
    const data = event.data
    yield* memberEvent(data.sessionID, "review", data.id, { requestID: data.id, excerpt: clip(`${data.action} ${data.resources.join(" ")}: ${data.reason}`) })
  })

  const recover = Effect.fn("CoordinationRuntime.recover")(function* () {
    const types = [SessionEvent.Execution.Started, SessionEvent.Step.Ended, SessionEvent.Execution.Succeeded,
      SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted].map((definition) => versionedType(definition.type, definition.durable.version))
    for (const group of yield* coordination.list()) {
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
              if (kind === "completed" && (yield* SessionCompletion.backgroundWork(db, jobs, member, yield* execution.active))) return
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
    summaries,
    roster,
    send: (caller, input) => underOwnership(caller, send(caller, input)),
    answer: (caller, input) => underOwnership(caller, answer(caller, input)),
    interrupt: (caller, input) => underOwnership(caller, interrupt(caller, input)),
    escalate: (caller, input) => underOwnership(caller, escalate(caller, input)),
    inspect: (caller, input) => underOwnership(caller, inspect(caller, input)),
    assign: (caller, input) => underOwnership(caller, assign(caller, input)),
    release: (caller, input) => underOwnership(caller, release(caller, input)),
    handle: (event) =>
      Effect.gen(function* () {
        const sessionID = event.type === Form.Event.Created.type ? event.data.form.sessionID : event.data.sessionID
        if (!Schema.is(SessionSchema.ID)(sessionID)) return
        const access = yield* coordination.accessOf(sessionID)
        return yield* (access === undefined ? handle(event) : coordination.withOwnership(access.scope.groupID, handle(event)))
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning("Project event handling failed", { type: event.type, cause: Cause.pretty(cause) }),
        ),
      ),
  }
}

const text = (value: string, limit = 500) => DecisionChoice.redactText(value).slice(0, limit)
const boundedResources = (resources: ReadonlyArray<string>) => resources.slice(0, 20).map((resource) => text(resource))

function requestDetail(item: CoordinationDecisions.PendingSnapshot): RequestDetail {
  const escalation = (value: Coordination.Escalation | undefined) => CoordinationEscalation.redacted(value)
  if (item.kind === "question") {
    const human = CoordinationDecisions.humanOnlyReason({ kind: "question", action: "question", resources: [item.form.title] })
    return {
      kind: "question", requestID: item.form.id, fingerprint: item.fingerprint, title: text(item.form.title),
      fields: item.form.fields.slice(0, 20).map((field) => ({
        key: field.key, type: field.type,
        ...(field.title === undefined ? {} : { title: text(field.title, 200) }),
        ...("required" in field && field.required !== undefined ? { required: field.required } : {}),
        ...("options" in field && field.options !== undefined ? { options: field.options.slice(0, 20).map((option) => text(typeof option === "string" ? option : option.value, 200)) } : {}),
      })),
      delegation: human ?? "routine", ...escalation(item.form.coordinationEscalation),
    }
  }
  const request = item.request
  const routine = CoordinationDecisions.routineEligible({ kind: item.kind, action: request.action, resources: request.resources })
  if (item.kind === "permission") {
    const human = CoordinationDecisions.humanOnlyReason({ kind: "permission", action: request.action, resources: request.resources, metadata: request.metadata })
    return {
      kind: "permission", requestID: request.id, fingerprint: item.fingerprint, action: request.action,
      resources: boundedResources(request.resources), delegation: human ?? (routine ? "routine" : "decline-only"),
      ...escalation(request.coordinationEscalation),
    }
  }
  const review = item.request
  const human = CoordinationDecisions.humanOnlyReason({ kind: "review", action: review.action, resources: review.resources, metadata: review.metadata, hardReview: review.hardReview, ruleIDs: review.ruleIDs })
  return {
    kind: "review", requestID: review.id, fingerprint: item.fingerprint, action: review.action,
    resources: boundedResources(review.resources), ruleIDs: review.ruleIDs.slice(0, 20), reason: text(review.reason),
    hardReview: review.hardReview === true, standard: review.standard,
    delegation: human ?? (routine ? "routine" : review.standard ? "decline-only" : "escalate"),
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
  | SessionStore.Service
  | LocationServiceMap.Service
  | Job.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const coordination = yield* CoordinationService.Service
    const database = yield* Database.Service
    const decisions = yield* CoordinationDecisions.Service
    const events = yield* EventRuntime.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* Session.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const validateModel = Effect.fn("CoordinationRuntime.validateModel")(function* (sessionID: SessionSchema.ID, model: Model.Ref) {
      const session = yield* store.get(sessionID)
      if (session === undefined) return yield* refuse(`Session ${sessionID} does not exist`)
      yield* Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        yield* models.resolve({ ...session, model }, { rebind: model.profile !== undefined })
      }).pipe(
        Effect.provide(locations.get(session.location)),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.fail(refuse(`Model ${model.providerID}/${model.id} is not available for Session ${sessionID}`)),
        ),
      )
    })
    const jobs = yield* Job.Service
    const runtime = make({ db: database.db, events, coordination, decisions, execution, sessions, validateModel, jobs })
    yield* events.subscribe(handledEvents).pipe(Stream.runForEach(runtime.handle), Effect.forkScoped({ startImmediately: true }))
    yield* runtime.recover()
    return Service.of(runtime)
  }),
)

export const node: Node.GlobalNode<Service> = makeGlobalNode({
  service: Service,
  layer,
  deps: [CoordinationService.node, CoordinationDecisionRuntime.node, Database.node, EventRuntime.node, SessionExecution.node, Session.node, SessionStore.node, LocationServiceMap.node, Job.node],
})
