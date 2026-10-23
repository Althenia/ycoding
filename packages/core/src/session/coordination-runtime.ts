export * as CoordinationRuntime from "./coordination-runtime"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Form } from "@ycoding-ai/schema/form"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import type { Model } from "@ycoding-ai/schema/model"
import { Permission } from "@ycoding-ai/schema/permission"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import { CoordinationDecisionRuntime } from "../coordination/decisions"
import { CoordinationService } from "../coordination/index"
import { Database } from "../database/database"
import { makeGlobalNode, type Node } from "../effect/app-node"
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
import { SessionPendingTable, SessionTable } from "./sql"
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
}

export interface Roster {
  readonly project: { readonly id: Coordination.GroupID; readonly name: string; readonly active: boolean; readonly pausedReason?: Coordination.PausedReason; readonly concurrency: number | null }
  readonly members: ReadonlyArray<Coordination.Participant>
}

export type NotificationEvent = "completed" | "failed" | "interrupted" | "question" | "permission" | "review"

export interface Interface {
  readonly get: (groupID: Coordination.GroupID) => Effect.Effect<Coordination.Info, CoordinationService.NotFoundError>
  readonly summaries: () => Effect.Effect<ReadonlyArray<Coordination.GroupSummary>>
  readonly roster: (caller: SessionSchema.ID) => Effect.Effect<Roster, RefusedError>
  readonly send: (caller: SessionSchema.ID, input: SendInput) => Effect.Effect<SendResult, RefusedError>
  readonly answer: (caller: SessionSchema.ID, input: AnswerInput) => Effect.Effect<CoordinationDecisions.Result, RefusedError>
  readonly interrupt: (caller: SessionSchema.ID, input: { readonly sessionID: SessionSchema.ID }) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly state: Coordination.MemberState }, RefusedError>
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly coordination: Pick<CoordinationService.Interface, "get" | "list" | "scopeOf" | "memberOf" | "activate" | "pause">
  readonly decisions: Pick<CoordinationDecisions.Interface, "pending" | "evaluate">
  readonly execution: Pick<SessionExecution.Interface, "active" | "wake" | "interrupt">
  readonly sessions: Pick<Session.Interface, "synthetic">
  readonly validateModel: (sessionID: SessionSchema.ID, model: Model.Ref) => Effect.Effect<void, RefusedError>
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

export function make(options: Options): Interface & { readonly handle: (event: EventRuntime.Payload) => Effect.Effect<void> } {
  const { db, events, coordination, decisions, execution, sessions } = options
  const senders = new Map<SessionSchema.ID, SessionSchema.ID>()
  const sendLock = KeyedMutex.makeUnsafe<Coordination.GroupID>()

  const scopeFor = Effect.fnUntraced(function* (caller: SessionSchema.ID) {
    const scope = yield* coordination.scopeOf(caller)
    if (scope === undefined) return yield* refuse("The project tool is only available to a Project's Master and its subagents")
    return scope
  })

  const memberScope = Effect.fnUntraced(function* (caller: SessionSchema.ID, sessionID: SessionSchema.ID) {
    const scope = yield* scopeFor(caller)
    if (!scope.memberSessionIDs.includes(sessionID)) return yield* refuse(`Session ${sessionID} is not a member of this Project`)
    return scope
  })

  const runningSender = Effect.fnUntraced(function* (scope: CoordinationService.Scope, member: SessionSchema.ID, running: ReadonlySet<SessionSchema.ID>) {
    const sender = senders.get(member)
    if (sender === undefined || sender === scope.masterSessionID || !running.has(sender)) return undefined
    const current = yield* coordination.scopeOf(sender)
    return current?.groupID === scope.groupID ? sender : undefined
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
    return {
      sessionID,
      title: row?.title ?? "",
      location: { directory: AbsolutePath.make(row?.directory ?? "/"), ...(row?.workspaceID ? { workspaceID: row.workspaceID } : {}) },
      state,
      lastActivity: row?.updated ?? 0,
      pending,
      ...(driver === undefined ? {} : { drivenBy: driver }),
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
          const current = yield* coordination.scopeOf(caller)
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

  const notify = Effect.fnUntraced(function* (
    scope: CoordinationService.Scope,
    member: SessionSchema.ID,
    event: NotificationEvent,
    identity: string,
    detail: { readonly requestID?: string; readonly excerpt?: string },
  ) {
    const running = yield* execution.active
    const sender = scope.active ? yield* runningSender(scope, member, running) : undefined
    const toSender = sender !== undefined
    const receiver = toSender ? sender : scope.masterSessionID
    const row = yield* db.select({ title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, member)).get().pipe(Effect.orDie)
    const data = {
      source: notice,
      groupID: scope.groupID,
      memberSessionID: member,
      title: row?.title ?? "",
      event,
      ...(detail.requestID === undefined ? {} : { requestID: detail.requestID }),
      ...(detail.excerpt === undefined ? {} : { excerpt: detail.excerpt }),
    }
    const id = SessionMessage.ID.make(`msg_project_notice_${Hash.sha256(`${scope.groupID}\0${member}\0${event}\0${identity}`).slice(0, 24)}`)
    const delivered = yield* SessionPending.lookup(db, receiver, id).pipe(Effect.catchDefect((defect) =>
      defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(true as const) : Effect.die(defect),
    ))
    if (delivered !== undefined) return
    yield* sessions
      .synthetic({
        id,
        sessionID: receiver,
        text: `Project notification:\n${JSON.stringify(data)}`,
        description: "Project notification",
        metadata: data,
        delivery: "steer",
        resume: toSender || scope.active,
      })
      .pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.void),
        Effect.catchTag("Session.SyntheticConflictError", () => Effect.void),
      )
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

  const handle = Effect.fnUntraced(function* (event: EventRuntime.Payload) {
    if (event.type === SessionEvent.InputAdmitted.type) {
      const data = Schema.decodeUnknownSync(SessionEvent.InputAdmitted.data)(event.data)
      if (data.input.type !== "user" || data.input.data.metadata?.inputOrigin !== "human") return
      const scope = yield* masterOf(data.sessionID)
      if (scope !== undefined) yield* coordination.activate(scope.groupID)
      return
    }
    if (event.type === SessionEvent.Execution.Interrupted.type) {
      const data = Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)(event.data)
      const scope = yield* masterOf(data.sessionID)
      if (scope !== undefined && data.reason === "user") yield* coordination.pause(scope.groupID)
      yield* memberEvent(data.sessionID, "interrupted", event.id, { excerpt: `Interrupted (${data.reason})` })
      return
    }
    if (event.type === SessionEvent.Execution.Succeeded.type) {
      const data = Schema.decodeUnknownSync(SessionEvent.Execution.Succeeded.data)(event.data)
      yield* memberEvent(data.sessionID, "completed", event.id, () => excerptOf(data.sessionID).pipe(Effect.map((excerpt) => (excerpt === undefined ? {} : { excerpt }))))
      return
    }
    if (event.type === SessionEvent.Execution.Failed.type) {
      const data = Schema.decodeUnknownSync(SessionEvent.Execution.Failed.data)(event.data)
      yield* memberEvent(data.sessionID, "failed", event.id, { excerpt: clip(data.error.message) })
      return
    }
    if (event.type === Form.Event.Created.type) {
      const data = Schema.decodeUnknownSync(Form.Event.Created.data)(event.data)
      yield* memberEvent(data.form.sessionID, "question", data.form.id, { requestID: data.form.id, excerpt: clip(data.form.title) })
      return
    }
    if (event.type === Permission.Event.Asked.type) {
      const data = Schema.decodeUnknownSync(Permission.Event.Asked.data)(event.data)
      yield* memberEvent(data.sessionID, "permission", data.id, { requestID: data.id, excerpt: clip([data.action, ...data.resources].join(" ")) })
      return
    }
    if (event.type === Guardrail.Event.Asked.type) {
      const data = Schema.decodeUnknownSync(Guardrail.Event.Asked.data)(event.data)
      yield* memberEvent(data.sessionID, "review", data.id, { requestID: data.id, excerpt: clip(`${data.action} ${data.resources.join(" ")}: ${data.reason}`) })
    }
  })

  return {
    get,
    summaries,
    roster,
    send,
    answer,
    interrupt,
    handle: (event) =>
      handle(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning("Project event handling failed", { type: event.type, cause: Cause.pretty(cause) }),
        ),
      ),
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
    const runtime = make({ db: database.db, events, coordination, decisions, execution, sessions, validateModel })
    yield* events.subscribe().pipe(Stream.runForEach(runtime.handle), Effect.forkScoped({ startImmediately: true }))
    return Service.of(runtime)
  }),
)

export const node: Node.GlobalNode<Service> = makeGlobalNode({
  service: Service,
  layer,
  deps: [CoordinationService.node, CoordinationDecisionRuntime.node, Database.node, EventRuntime.node, SessionExecution.node, Session.node, SessionStore.node, LocationServiceMap.node],
})
