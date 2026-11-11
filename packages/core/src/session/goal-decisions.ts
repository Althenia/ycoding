export * as SessionGoalDecisions from "./goal-decisions"

import type { Category } from "@ycoding-ai/schema/session-autonomy"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Cause, Context, Deferred, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { ConfigCoordination } from "../config/coordination"
import { CoordinationSettings } from "../coordination-settings"
import { Database } from "../database/database"
import { DecisionChoice } from "../decision-choice"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { Form } from "../form"
import { LocationServiceMap } from "../location-service-map"
import { Permission } from "../permission"
import { Question } from "../question"
import { Shell } from "../shell"
import { Hash } from "../util/hash"
import { CoordinationDecisions } from "./coordination-decisions"
import { SessionDecisionContext } from "./decision-context"
import { SessionAutonomy } from "./autonomy"
import { SessionEvent } from "./event"
import { SessionExecution } from "./execution"
import { SessionGuardrail } from "./guardrail"
import { SessionMessage } from "./message"
import { SessionOrchestration } from "./orchestration"
import { SessionPending } from "./pending"
import { SessionReviewFold } from "./review-fold"
import { SessionSchema } from "./schema"
import { SessionTable, SessionTaskTable } from "./sql"
import { SessionGoal } from "./goal"
import { SessionStore } from "./store"

const receiptPrefix = "msg_goaldec_"
const receiptBound = "msg_goaldec`"
const receiptScanLimit = 200
const familyLimit = 512
const textLimit = 1000
const maxRounds = 2

export type Kind = "permission" | "guardrail" | "form" | "question" | "child_question"
export type Outcome = "settled" | "waiting" | "resumed"

const kinds = ["permission", "guardrail", "form", "question", "child_question"] as const
const activeTaskStates = ["starting", "running", "waiting", "supervising", "cancelling"] as const
const inputsChanged: ReadonlySet<string> = new Set(["delegation-invalid", "stale-assessment"])

export const Receipt = Schema.Struct({
  outcome: Schema.Literals(["settled", "waiting", "resumed"]),
  via: Schema.String.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
  rationale: Schema.String,
  requirement: Schema.Struct({ goalDigest: Schema.String, iteration: Schema.Number, revision: Schema.Number }),
  candidate: Schema.Struct({
    kind: Schema.Literals(kinds),
    sessionID: SessionSchema.ID,
    requestID: Schema.String,
    fingerprint: Schema.String,
  }),
  source: Schema.Struct({ messageID: SessionMessage.ID, callID: Schema.String }).pipe(Schema.optional),
})
export type Receipt = typeof Receipt.Type
const decodeReceipt = Schema.decodeUnknownOption(Receipt)
const decodeAdmitted = Schema.decodeUnknownOption(SessionEvent.InputAdmitted.data)
const admittedType = EventRuntime.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version)

export interface Located {
  readonly permission?: Pick<Permission.Interface, "snapshots" | "reconsider">
  readonly guardrail?: Pick<SessionGuardrail.Interface, "requestSnapshots" | "reconsider">
  readonly form?: Pick<Form.Interface, "snapshots" | "reconsider">
  readonly question?: Pick<Question.Interface, "list" | "reconsider">
  readonly shell?: Pick<Shell.Interface, "list">
  readonly goal?: Pick<SessionGoal.Interface, "synthesize">
  readonly session?: SessionSchema.Info
}

export interface GoalSynthesis {
  readonly text: string
}

export interface Options {
  readonly db: Database.Interface["db"]
  readonly events: EventRuntime.Interface
  readonly autonomy: SessionAutonomy.Interface
  readonly execution: Pick<SessionExecution.Interface, "active" | "wake">
  readonly orchestration: Pick<SessionOrchestration.Interface, "questionSnapshots" | "reconsiderQuestion">
  readonly policy: () => Effect.Effect<ConfigCoordination.Resolved>
  readonly locate: (sessionID: SessionSchema.ID) => Effect.Effect<Located | undefined, never, Scope.Scope>
  readonly synthesizeGoal?: (owner: SessionSchema.ID, prompt: string) => Effect.Effect<GoalSynthesis, { readonly reason: string }, Scope.Scope>
  readonly now?: Effect.Effect<number>
}

export interface Interface {
  readonly handle: (event: HandledEvent) => Effect.Effect<void>
  readonly reconcile: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly inspect: (owner: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionGoalDecisions") {}

export const handledEvents = [
  Permission.Event.Asked,
  Permission.Event.Replied,
  Permission.Event.Deferred,
  Guardrail.Event.Asked,
  Guardrail.Event.Replied,
  Guardrail.Event.Deferred,
  SessionEvent.GuardrailDecided,
  Form.Event.Created,
  Form.Event.Replied,
  Form.Event.Cancelled,
  Form.Event.TimedOut,
  Form.Event.Deferred,
  Question.Event.Asked,
  Question.Event.Replied,
  Question.Event.Rejected,
  Question.Event.TimedOut,
  Question.Event.Deferred,
  SessionEvent.Review.Deferred,
  SessionEvent.Review.Decided,
  SessionEvent.Review.Withdrawn,
  SessionEvent.Task.Updated,
] as const
export type HandledEvent = EventRuntime.SubscribePayload<typeof handledEvents>

interface Row {
  readonly id: SessionSchema.ID
  readonly parentID: SessionSchema.ID | undefined
  readonly archived: boolean
  readonly goal: boolean
}

interface Requirement {
  readonly goalDigest: string
  readonly iteration: number
  readonly revision: number
}

type Subject =
  | { readonly kind: "permission"; readonly action: string; readonly resources: ReadonlyArray<string>; readonly metadata: Record<string, unknown> | undefined }
  | {
      readonly kind: "guardrail"
      readonly action: string
      readonly resources: ReadonlyArray<string>
      readonly metadata: Record<string, unknown> | undefined
      readonly ruleIDs: ReadonlyArray<string>
      readonly standard: boolean
      readonly hardReview: boolean | undefined
    }
  | { readonly kind: "form"; readonly title: string; readonly fields: ReadonlyArray<string>; readonly metadata: Record<string, unknown> | undefined }

interface Settlement {
  readonly outcome: "allowed" | "denied" | "escalated" | "stale"
  readonly settled: boolean
  readonly via?: string
  readonly reason?: string
}

interface ReconsiderCall {
  readonly source: { readonly coordinatorSessionID: SessionSchema.ID; readonly rationale: string }
  readonly validate: (sessionID: string, subject: Subject) => Effect.Effect<boolean>
}

interface Reference {
  readonly kind: Kind
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
  readonly fingerprint: string
  readonly action: string
  readonly source?: { readonly messageID: SessionMessage.ID; readonly callID: string }
}

interface GoalAnswer {
  readonly form?: Form.Answer
  readonly question?: ReadonlyArray<Question.Answer>
  readonly child?: { readonly text?: string; readonly data?: Schema.Json }
  readonly confidence?: number
}

interface Candidate extends Reference {
  readonly subject: Subject
  readonly assessedByYolo: boolean
  readonly rawForm?: Form.Info
  readonly rawQuestion?: Question.Request
  readonly rawChild?: ChildTask
  readonly reconsider: (call: ReconsiderCall, goalAnswer?: GoalAnswer) => Effect.Effect<Settlement>
}

type ChildTask = Effect.Success<ReturnType<SessionOrchestration.Interface["questionSnapshots"]>>[number]["task"]

interface Answered {
  readonly kind: Kind
  readonly sessionID: SessionSchema.ID
  readonly requestID: string
}

interface Trigger {
  readonly sessionID: SessionSchema.ID
  readonly answered?: Answered
}

const stale: Settlement = { outcome: "stale", settled: false }
const isSessionID = Schema.is(SessionSchema.ID)
const isMessageID = Schema.is(SessionMessage.ID)

const conflictAsExisting = (defect: unknown) =>
  defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(true as const) : Effect.die(defect)

const conflictAsVoid = (defect: unknown) =>
  defect instanceof SessionPending.LifecycleConflict ? Effect.void : Effect.die(defect)

const sourceOf = (source: unknown) => {
  if (typeof source !== "object" || source === null || !("messageID" in source) || !("callID" in source)) return {}
  return typeof source.messageID === "string" && isMessageID(source.messageID) && typeof source.callID === "string"
    ? { source: { messageID: source.messageID, callID: source.callID } }
    : {}
}

const permissionSubject = (request: Permission.Request): Subject => ({
  kind: "permission",
  action: request.action,
  resources: request.resources,
  metadata: request.metadata,
})

const guardrailSubject = (request: Guardrail.Request): Subject => ({
  kind: "guardrail",
  action: request.action,
  resources: request.resources,
  metadata: request.metadata,
  ruleIDs: request.ruleIDs,
  standard: request.standard,
  hardReview: request.hardReview,
})

const questionSubject = (request: Question.Request): Subject => ({
  kind: "form",
  title: request.questions.map((question) => `${question.header} ${question.question}`).join("\n"),
  fields: request.questions.flatMap((question) => question.options.map((option) => option.label)),
  metadata: undefined,
})

const childSubject = (task: ChildTask): Subject => ({
  kind: "form",
  title: task.question?.text ?? "",
  fields: SessionOrchestration.questionOptions(task.question?.data),
  metadata: undefined,
})

const formSubject = (form: Form.Info): Subject => ({
  kind: "form",
  title: form.title,
  fields: form.fields.flatMap((field) => [
    field.title ?? field.key,
    ...(field.description === undefined ? [] : [field.description]),
    ...("options" in field && field.options !== undefined ? field.options.map((option) => option.label) : []),
  ]),
  metadata: form.metadata,
})

const categoryOf = (kind: Kind): Category => (kind === "permission" ? "permissions" : kind === "guardrail" ? "guardrails" : "answers")

const delegationCategoryOf = (subject: Subject): ConfigCoordination.Category =>
  subject.kind === "permission" ? "permission" : subject.kind === "guardrail" ? "review" : "question"

const requiresExplicitDecision = (metadata: Record<string, unknown> | undefined) => metadata?.requireExplicitDecision === true

const explicitReasonOf = (subject: Subject) =>
  subject.kind === "form"
    ? CoordinationDecisions.explicitDecisionReason({
        kind: "question",
        action: "question",
        resources: [],
        metadata: { requireExplicitDecision: subject.metadata?.requireExplicitDecision, title: subject.title, fields: subject.fields, metadata: subject.metadata },
      })
    : CoordinationDecisions.explicitDecisionReason({
        kind: subject.kind === "permission" ? "permission" : "review",
        action: subject.action,
        resources: subject.resources,
        metadata: subject.metadata,
        ...(subject.kind === "guardrail" ? { hardReview: subject.hardReview, ruleIDs: subject.ruleIDs } : {}),
      })

const label = (candidate: Reference) => {
  const name = candidate.kind === "guardrail" ? "guardrail review" : candidate.kind === "child_question" ? "child question" : candidate.kind
  const action = candidate.kind === "permission" || candidate.kind === "guardrail" ? ` (${DecisionChoice.redactText(candidate.action)})` : ""
  return `${name} ${candidate.requestID}${action}`
}

export function make(options: Options): Interface {
  const db = options.db
  const events = options.events
  const autonomy = options.autonomy
  const execution = options.execution
  const orchestration = options.orchestration
  const locate = options.locate
  const clock = options.now ?? Effect.sync(() => Date.now())
  const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
  const attempts = new Map<SessionSchema.ID, Map<string, Set<string>>>()

  const toRow = (value: { id: SessionSchema.ID; parentID: SessionSchema.ID | null; archived: number | null; autonomy: SessionAutonomy.State | null }): Row => ({
    id: value.id,
    parentID: value.parentID ?? undefined,
    archived: value.archived !== null,
    goal: SessionAutonomy.read(value.autonomy).goal?.status === "active",
  })

  const columns = {
    id: SessionTable.id,
    parentID: SessionTable.parent_id,
    archived: SessionTable.time_archived,
    autonomy: SessionTable.autonomy,
  }

  const row = (sessionID: SessionSchema.ID) =>
    db.select(columns).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(
      Effect.orDie,
      Effect.map((value) => (value === undefined ? undefined : toRow(value))),
    )

  const eligible = (value: Row | undefined) => value !== undefined && !value.archived && value.goal

  const ownerOf = (sessionID: SessionSchema.ID, depth = 0): Effect.Effect<SessionSchema.ID | undefined> =>
    depth >= 64
      ? Effect.succeed(undefined)
      : row(sessionID).pipe(
          Effect.flatMap((found) =>
            found === undefined
              ? Effect.succeed(undefined)
              : eligible(found)
                ? Effect.succeed(found.id)
                : found.parentID === undefined
                  ? Effect.succeed(undefined)
                  : ownerOf(found.parentID, depth + 1),
          ),
        )

  const expand = (rows: ReadonlyArray<Row>, frontier: ReadonlyArray<SessionSchema.ID>, prune: boolean): Effect.Effect<Row[]> =>
    frontier.length === 0 || rows.length >= familyLimit
      ? Effect.succeed([...rows])
      : db.select(columns).from(SessionTable).where(inArray(SessionTable.parent_id, [...frontier])).all().pipe(
          Effect.orDie,
          Effect.flatMap((found) => {
            const next = found.map(toRow).filter((child) => !(prune && eligible(child)))
            return expand([...rows, ...next], next.map((child) => child.id), prune)
          }),
        )

  const subtree = (root: SessionSchema.ID, prune: boolean) =>
    row(root).pipe(Effect.flatMap((start) => (start === undefined ? Effect.succeed([]) : expand([start], [root], prune))))

  const capture = Effect.fnUntraced(function* (owner: SessionSchema.ID) {
    if (!eligible(yield* row(owner))) return undefined
    const snapshot = yield* autonomy.snapshot(owner).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
    const goal = snapshot?.state.goal
    if (snapshot === undefined || goal === undefined || goal.status !== "active") return undefined
    return { goalDigest: Hash.sha256(goal.text), iteration: goal.iteration, revision: snapshot.sequence } satisfies Requirement
  })

  const ownerCurrent = Effect.fnUntraced(function* (owner: SessionSchema.ID, requirement: Requirement) {
    const now = yield* capture(owner)
    return now !== undefined && now.goalDigest === requirement.goalDigest && now.iteration === requirement.iteration && now.revision === requirement.revision
  })

  const delegation = Effect.fnUntraced(function* (subject: Subject) {
    const policy = yield* options.policy()
    if (!policy.enabled) return "delegation-revoked"
    const now = yield* clock
    if (policy.expiresAt !== undefined && policy.expiresAt <= now) return "delegation-expired"
    const permitted = ConfigCoordination.permits(policy, undefined, {
      category: delegationCategoryOf(subject),
      action: subject.kind === "form" ? "question" : subject.action,
      resources: subject.kind === "form" ? [] : subject.resources,
      now,
    })
    return permitted ? undefined : "delegation-out-of-scope"
  })

  const humanOnly = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, subject: Subject) {
    if (subject.kind === "guardrail") {
      if (subject.hardReview === true || subject.ruleIDs.includes("configuration.invalid")) return "explicit-decision:hard-review"
      if (!subject.standard || subject.ruleIDs.some((id) => !id.startsWith("standard."))) return "explicit-decision:custom-review"
    }
    if (requiresExplicitDecision(subject.metadata)) return "explicit-decision:request"
    const explicit = explicitReasonOf(subject)
    if (explicit !== undefined) return explicit
    if (subject.kind !== "form" && !CoordinationDecisions.routineEligible({ kind: subject.kind === "permission" ? "permission" : "review", action: subject.action, resources: subject.resources }))
      return "unknown-semantics"
    const category = categoryOf(subject.kind)
    const mode = yield* DecisionChoice.decisionMode(autonomy, sessionID, category)
    if (mode === "manual" && subject.kind !== "form") return `human-only:manual-${category}`
    return yield* delegation(subject)
  })

  const receiptID = (owner: SessionSchema.ID, candidate: Pick<Candidate, "kind" | "requestID" | "fingerprint">, outcome: Outcome, discriminator: string) =>
    SessionMessage.ID.make(
      `${receiptPrefix}${Hash.sha256([owner, candidate.kind, candidate.requestID, candidate.fingerprint, outcome, discriminator].join("\0")).slice(0, 24)}`,
    )

  const receiptExists = (owner: SessionSchema.ID, candidate: Reference, outcome: Outcome, discriminator: string) =>
    SessionPending.lookup(db, owner, receiptID(owner, candidate, outcome, discriminator)).pipe(
      Effect.catchDefect(conflictAsExisting),
      Effect.map((found) => found !== undefined),
    )

  const textOf = (candidate: Reference, outcome: Outcome, detail: { readonly via?: string; readonly reason?: string }) => {
    const subject = label(candidate)
    const settledBy = detail.via === "goal"
      ? "by the Goal agent under the active goal from bounded task context; this automatic answer is never a human reply"
      : `by the native ${detail.via ?? "coordination"} path`
    const text =
      outcome === "waiting"
        ? `Pending ${subject} is waiting for a human decision (${detail.reason ?? "unspecified"}); the goal loop did not settle it. This record authorizes nothing.`
        : outcome === "settled"
          ? `Pending ${subject} was settled (${detail.reason ?? "unspecified"}) ${settledBy}; the waiting call received that result. This record authorizes nothing.`
          : `Pending ${subject} was settled or answered natively. This record authorizes nothing.`
    return DecisionChoice.redactText(text).slice(0, textLimit)
  }

  const record = Effect.fnUntraced(function* (input: {
    readonly owner: SessionSchema.ID
    readonly requirement: Requirement
    readonly candidate: Reference
    readonly outcome: Outcome
    readonly discriminator: string
    readonly rationale: string
    readonly via?: string
    readonly reason?: string
  }) {
    if (yield* receiptExists(input.owner, input.candidate, input.outcome, input.discriminator)) return false
    const candidate = input.candidate
    const goalDecision: Receipt = {
      outcome: input.outcome,
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      rationale: input.rationale,
      requirement: input.requirement,
      candidate: { kind: candidate.kind, sessionID: candidate.sessionID, requestID: candidate.requestID, fingerprint: candidate.fingerprint },
      ...(candidate.source === undefined ? {} : { source: candidate.source }),
    }
    yield* SessionPending.admit(db, events, {
      id: receiptID(input.owner, candidate, input.outcome, input.discriminator),
      sessionID: input.owner,
      input: SessionPending.Message.make({
        type: "synthetic",
        delivery: "steer",
        data: {
          text: textOf(candidate, input.outcome, { via: input.via, reason: input.reason }),
          description: "Goal · decision",
          metadata: { goalDecision },
        },
      }),
    }).pipe(Effect.catchDefect(conflictAsVoid))
    return true
  })

  const collect = Effect.fnUntraced(function* (owner: SessionSchema.ID, family: ReadonlyArray<Row>) {
    const members = family.filter((member) => !member.archived)
    const ids = new Set(members.map((member) => member.id))
    const found: Candidate[] = []
    for (const member of members) {
      const located = yield* locate(member.id)
      if (located?.permission !== undefined) {
        const permission = located.permission
        for (const snapshot of yield* permission.snapshots(member.id))
          found.push({
            kind: "permission",
            sessionID: member.id,
            requestID: snapshot.request.id,
            fingerprint: snapshot.fingerprint,
            action: snapshot.request.action,
            ...sourceOf(snapshot.request.source),
            subject: permissionSubject(snapshot.request),
            assessedByYolo: snapshot.request.escalation?.authority === "yolo",
            reconsider: (call) =>
              permission.reconsider({
                requestID: snapshot.request.id,
                fingerprint: snapshot.fingerprint,
                actor: "coordinator",
                source: call.source,
                validate: (request) => call.validate(request.sessionID, permissionSubject(request)),
              }),
          })
      }
      if (located?.guardrail !== undefined) {
        const guardrail = located.guardrail
        const snapshots = yield* guardrail.requestSnapshots(member.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed([])))
        for (const snapshot of snapshots)
          found.push({
            kind: "guardrail",
            sessionID: member.id,
            requestID: snapshot.request.id,
            fingerprint: snapshot.fingerprint,
            action: snapshot.request.action,
            ...sourceOf(snapshot.request.source),
            subject: guardrailSubject(snapshot.request),
            assessedByYolo: snapshot.request.escalation?.authority === "yolo",
            reconsider: (call) =>
              guardrail
                .reconsider({
                  sessionID: member.id,
                  requestID: snapshot.request.id,
                  fingerprint: snapshot.fingerprint,
                  actor: "coordinator",
                  source: call.source,
                  validate: (request) => call.validate(request.sessionID, guardrailSubject(request)),
                })
                .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(stale))),
          })
      }
      if (located?.form !== undefined) {
        const forms = located.form
        for (const snapshot of yield* forms.snapshots(member.id)) {
          if (snapshot.state.status !== "pending") continue
          found.push({
            kind: "form",
            sessionID: member.id,
            requestID: snapshot.form.id,
            fingerprint: snapshot.fingerprint,
            action: "form",
            subject: formSubject(snapshot.form),
            assessedByYolo: snapshot.form.assessment?.mode === "yolo",
            rawForm: snapshot.form,
            reconsider: (call, goalAnswer) =>
              forms.reconsider({
                id: snapshot.form.id,
                fingerprint: snapshot.fingerprint,
                actor: "coordinator",
                source: call.source,
                goal: { owner },
                ...(goalAnswer?.form === undefined ? {} : { answer: goalAnswer.form }),
                ...(goalAnswer?.confidence === undefined ? {} : { confidence: goalAnswer.confidence }),
                validate: (form) => call.validate(form.sessionID, formSubject(form)),
              }),
          })
        }
      }
      if (located?.question !== undefined) {
        const questions = located.question
        for (const request of yield* questions.list())
          if (request.sessionID === member.id)
            found.push({
              kind: "question",
              sessionID: member.id,
              requestID: request.id,
              fingerprint: Question.fingerprint(request),
              action: "question",
              subject: questionSubject(request),
              assessedByYolo: request.assessment?.mode === "yolo",
              rawQuestion: request,
              reconsider: (call, goalAnswer) =>
                questions.reconsider({
                  requestID: request.id,
                  fingerprint: Question.fingerprint(request),
                  actor: "coordinator",
                  source: call.source,
                  goal: { owner },
                  ...(goalAnswer?.question === undefined ? {} : { answer: goalAnswer.question }),
                  ...(goalAnswer?.confidence === undefined ? {} : { confidence: goalAnswer.confidence }),
                  validate: (current) => call.validate(current.sessionID, questionSubject(current)),
                }),
            })
      }
      const children = yield* orchestration.questionSnapshots(member.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed([])))
      for (const child of children) {
        const question = child.task.question
        if (ids.has(child.task.sessionID) && question !== undefined)
          found.push({
            kind: "child_question",
            sessionID: child.task.sessionID,
            requestID: question.id,
            fingerprint: child.fingerprint,
            action: "child_question",
            subject: childSubject(child.task),
            assessedByYolo: false,
            rawChild: child.task,
            reconsider: (call, goalAnswer) =>
              orchestration.reconsiderQuestion({
                parentID: child.task.parentID,
                childID: child.task.sessionID,
                questionID: question.id,
                fingerprint: child.fingerprint,
                actor: "coordinator",
                source: call.source,
                goal: { owner },
                ...(goalAnswer?.child === undefined ? {} : { answer: goalAnswer.child }),
                ...(goalAnswer?.confidence === undefined ? {} : { confidence: goalAnswer.confidence }),
                validate: (task) => call.validate(task.sessionID, childSubject(task)),
              }),
          })
      }
    }
    return found
  })

  const attemptsFor = (owner: SessionSchema.ID, candidate: Candidate) => {
    const forOwner = attempts.get(owner) ?? new Map<string, Set<string>>()
    attempts.set(owner, forOwner)
    const id = `${candidate.kind}\0${candidate.sessionID}\0${candidate.requestID}\0${candidate.fingerprint}`
    const known = forOwner.get(id) ?? new Set<string>()
    forOwner.set(id, known)
    return { id, known }
  }

  const rationaleFor = (candidate: Candidate) =>
    candidate.subject.kind === "form"
      ? `The Goal agent settled a routine ${candidate.kind} request from bounded task context; an automatic answer is never a human reply.`
      : `The goal loop re-applied the requesting Session's current ${categoryOf(candidate.kind)} policy to a routine ${candidate.kind} request.`

  const goalTextOf = Effect.fnUntraced(function* (owner: SessionSchema.ID) {
    const snapshot = yield* autonomy.snapshot(owner).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
    return snapshot?.state.goal?.status === "active" ? snapshot.state.goal.text : undefined
  })

  const hasDeterministicAnswer = (candidate: Candidate): boolean => {
    if (candidate.kind === "question" && candidate.rawQuestion !== undefined) {
      return Question.deterministicQuestionAnswers(candidate.rawQuestion.questions) !== undefined
    }
    if (candidate.kind === "form" && candidate.rawForm !== undefined) {
      return Form.deterministicFormAnswer(candidate.rawForm) !== undefined
    }
    if (candidate.kind === "child_question" && candidate.rawChild?.question !== undefined) {
      const options = SessionOrchestration.questionOptions(candidate.rawChild.question.data)
      return options.filter((option) => /\s\(Recommended\)$/.test(option)).length === 1
    }
    return false
  }

  const goalPromptFor = (candidate: Candidate, goalText: string): string => {
    const subject = candidate.subject
    const title = subject.kind === "form" ? subject.title : `${subject.kind} ${candidate.requestID}`
    const fields = subject.kind === "form" ? subject.fields.join("\n") : `${(subject as { readonly action: string }).action}`
    return [
      `Active goal: ${goalText}`,
      `Pending routine ${candidate.kind} request: ${title}`,
      `Context: ${fields}`.slice(0, 2000),
      "Provide only the concise answer text that best serves this request from bounded task context. Do not invent facts, credentials, or identifiers the evidence does not supply. If the evidence does not support an answer, reply with an empty response.",
    ].join("\n")
  }

  const goalToAnswer = (candidate: Candidate, text: string): GoalAnswer | undefined => {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    if (candidate.kind === "question" && candidate.rawQuestion !== undefined) {
      const request = candidate.rawQuestion
      if (request.questions.length === 1) {
        const q = request.questions[0]!
        const labels = q.options.map((option) => option.label)
        if (labels.length === 0) return { question: [[trimmed]] }
        const exact = labels.find((label) => label === trimmed)
        if (exact !== undefined) return { question: [[exact]] }
        if (q.custom !== false) return { question: [[trimmed]] }
        return undefined
      }
      if (request.questions.every((q) => q.options.length === 0)) return { question: request.questions.map(() => [trimmed]) }
      return undefined
    }
    if (candidate.kind === "form" && candidate.rawForm !== undefined) {
      const form = candidate.rawForm
      if (form.fields.length === 1) {
        const field = form.fields[0] as Form.Field & { readonly key: string; readonly options?: ReadonlyArray<{ readonly value: Schema.Json; readonly label: string }>; readonly custom?: boolean }
        const options = field.options ?? []
        if (options.length === 0) return { form: { [field.key]: trimmed } as Form.Answer }
        const exact = options.find((option) => option.label === trimmed)
        if (exact !== undefined) return { form: { [field.key]: exact.value as Form.Answer[string] } as Form.Answer }
        if (field.custom !== false) return { form: { [field.key]: trimmed } as Form.Answer }
        return undefined
      }
      return undefined
    }
    if (candidate.kind === "child_question") return { child: { text: trimmed } }
    return undefined
  }

  const synthesizeText = (owner: SessionSchema.ID, prompt: string): Effect.Effect<string, { readonly reason: string }, Scope.Scope> => {
    if (options.synthesizeGoal !== undefined) return options.synthesizeGoal(owner, prompt).pipe(Effect.map((result) => result.text)) as Effect.Effect<string, { readonly reason: string }, Scope.Scope>
    return Effect.gen(function* () {
      const located = yield* locate(owner)
      const goal = located?.goal
      const session = located?.session
      if (goal === undefined || session === undefined) return yield* Effect.fail({ reason: "provider-failed" } as const)
      return yield* goal.synthesize({ session, text: prompt }).pipe(
        Effect.mapError((error) => ({
          reason: error.code === "goal.model_unavailable" ? "provider-failed" : error.code === "goal.stale_calculation" ? "stale-assessment" : "refused",
        })),
      )
    })
  }

  const runReconsider = Effect.fnUntraced(function* (
    owner: SessionSchema.ID,
    requirement: Requirement,
    candidate: Candidate,
    key: string,
    rationale: string,
    validate: (sessionID: string, current: Subject) => Effect.Effect<boolean>,
    goalAnswer?: GoalAnswer,
  ) {
    const reconsider = candidate.reconsider
    const exit = yield* reconsider({ source: { coordinatorSessionID: owner, rationale }, validate }, goalAnswer).pipe(Effect.exit)
    if (Exit.isFailure(exit)) {
      yield* Effect.uninterruptible(
        record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: "reconsider-failed", rationale }),
      )
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
      yield* Effect.logWarning("Goal decision reconsideration failed", { cause: Cause.pretty(exit.cause) })
      return { settled: false as const, repeat: false as const }
    }
    const result = exit.value
    if (result.outcome === "stale") return { settled: false as const, repeat: false as const }
    if (result.settled) {
      yield* record({ owner, requirement, candidate, outcome: "settled", discriminator: key, via: result.via, reason: result.outcome, rationale })
      return { settled: true as const, repeat: false as const }
    }
    if (result.reason === "native-assessment-in-progress") return { settled: false as const, repeat: false as const, unmark: true as const }
    if (result.reason !== undefined && inputsChanged.has(result.reason)) {
      if ((yield* capture(owner)) !== undefined)
        yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: result.reason, rationale })
      return { settled: false as const, repeat: true as const }
    }
    yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: result.reason ?? "escalated", rationale })
    return { settled: false as const, repeat: false as const }
  })

  const settle = Effect.fnUntraced(function* (owner: SessionSchema.ID, requirement: Requirement, candidate: Candidate) {
    const authority = yield* autonomy.snapshot(candidate.sessionID, { inherited: true }).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
    if (authority === undefined) return false
    const context = SessionDecisionContext.authorityDigest(yield* SessionDecisionContext.read(db, candidate.sessionID))
    const key = Hash.sha256([candidate.kind, candidate.requestID, candidate.fingerprint, authority.sequence, authority.digest, context].join("\0"))
    const known = attemptsFor(owner, candidate).known
    if (known.has(key)) return false
    if ((yield* receiptExists(owner, candidate, "waiting", key)) || (yield* receiptExists(owner, candidate, "settled", key))) {
      known.add(key)
      return false
    }
    const mode = yield* DecisionChoice.decisionMode(autonomy, candidate.sessionID, categoryOf(candidate.kind))
    if (candidate.assessedByYolo && mode === "yolo" && known.size === 0) {
      known.add(key)
      yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: "yolo-assessed", rationale: "The native YOLO evaluator already assessed this request under the current authority; the goal loop did not run it again." })
      return false
    }
    known.add(key)
    const rationale = rationaleFor(candidate)
    const validate = (sessionID: string, current: Subject) =>
      Effect.gen(function* () {
        if (sessionID !== candidate.sessionID) return false
        if (!(yield* ownerCurrent(owner, requirement))) return false
        const member = yield* row(candidate.sessionID)
        if (member === undefined || member.archived || (yield* ownerOf(candidate.sessionID)) !== owner) return false
        if (!(yield* DecisionChoice.autonomyUnchanged(autonomy, candidate.sessionID, authority))) return false
        if (candidate.kind === "guardrail" && (yield* autonomy.isAsleep(candidate.sessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(true))))) return false
        return (yield* humanOnly(candidate.sessionID, current)) === undefined
      })
    const isQuestionLike = candidate.kind === "form" || candidate.kind === "question" || candidate.kind === "child_question"
    if (!isQuestionLike) {
      const result = yield* runReconsider(owner, requirement, candidate, key, rationale, validate)
      if ("unmark" in result && result.unmark === true) known.delete(key)
      return result.repeat
    }
    if (hasDeterministicAnswer(candidate)) {
      const result = yield* runReconsider(owner, requirement, candidate, key, rationale, validate)
      if ("unmark" in result && result.unmark === true) known.delete(key)
      return result.repeat
    }
    const goalText = yield* goalTextOf(owner)
    if (goalText === undefined) {
      yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: "refused", rationale })
      return false
    }
    const prompt = goalPromptFor(candidate, goalText)
    const synthesized = yield* synthesizeText(owner, prompt).pipe(
      Effect.map((text) => ({ _tag: "ok" as const, text })),
      Effect.catchIf(
        (error): error is { readonly reason: string } => true,
        (failure) => Effect.succeed({ _tag: "fail" as const, reason: failure.reason }),
      ),
    )
    if (synthesized._tag === "fail") {
      const reason = synthesized.reason ?? "refused"
      yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason, rationale })
      if (inputsChanged.has(reason)) {
        if ((yield* capture(owner)) !== undefined) return true
      }
      return false
    }
    const goalAnswer = goalToAnswer(candidate, synthesized.text)
    if (goalAnswer === undefined) {
      yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: key, reason: "refused", rationale })
      return false
    }
    const result = yield* runReconsider(owner, requirement, candidate, key, rationale, validate, goalAnswer)
    if ("unmark" in result && result.unmark === true) known.delete(key)
    return result.repeat
  })

  const handleCandidate = Effect.fnUntraced(function* (owner: SessionSchema.ID, requirement: Requirement, candidate: Candidate) {
    const reason = yield* humanOnly(candidate.sessionID, candidate.subject)
    if (reason !== undefined) {
      yield* record({ owner, requirement, candidate, outcome: "waiting", discriminator: reason, reason, rationale: "A human-only boundary applies; the goal loop does not settle this request." })
      return false
    }
    return yield* settle(owner, requirement, candidate)
  })

  const pass = Effect.fnUntraced(function* (owner: SessionSchema.ID) {
    const requirement = yield* capture(owner)
    if (requirement === undefined) {
      attempts.delete(owner)
      return false
    }
    const family = yield* subtree(owner, true)
    const candidates = yield* collect(owner, family)
    const repeats = yield* Effect.forEach(candidates, (candidate) =>
      handleCandidate(owner, requirement, candidate).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("Goal decision pass failed", { cause: Cause.pretty(cause) }).pipe(Effect.as(false)),
        ),
      ),
    )
    const live = new Set(candidates.map((candidate) => attemptsFor(owner, candidate).id))
    const known = attempts.get(owner)
    if (known !== undefined) for (const id of known.keys()) if (!live.has(id)) known.delete(id)
    return repeats.some((repeat) => repeat)
  })

  const rounds = (owner: SessionSchema.ID, remaining: number): Effect.Effect<void> =>
    remaining === 0
      ? Effect.void
      : Effect.scoped(pass(owner)).pipe(Effect.flatMap((again) => (again ? rounds(owner, remaining - 1) : Effect.void)))

  const inspectLocked = (owner: SessionSchema.ID) => rounds(owner, maxRounds)

  const queuedPasses = new Map<SessionSchema.ID, Deferred.Deferred<void>>()

  const inspect = (owner: SessionSchema.ID): Effect.Effect<void> =>
    Effect.suspend(() => {
      const queued = queuedPasses.get(owner)
      if (queued !== undefined) return Deferred.await(queued)
      return Deferred.make<void>().pipe(
        Effect.flatMap((done) => {
          queuedPasses.set(owner, done)
          return locks.withLock(owner)(Effect.sync(() => void queuedPasses.delete(owner)).pipe(Effect.andThen(inspectLocked(owner)))).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (queuedPasses.get(owner) === done) queuedPasses.delete(owner)
              }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
            ),
          )
        }),
      )
    })

  const waitingMatch = (answered: Answered) => {
    const receipt = (path: string) => sql`json_extract(${EventTable.data}, ${`$.input.data.metadata.goalDecision.${path}`})`
    return sql`${receipt("outcome")} = 'waiting' AND ${receipt("candidate.kind")} = ${answered.kind} AND ${receipt("candidate.sessionID")} = ${answered.sessionID} AND ${receipt("candidate.requestID")} = ${answered.requestID}`
  }

  const waitingFor = Effect.fnUntraced(function* (owner: SessionSchema.ID, answered: Answered) {
    const admitted = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, owner),
          eq(EventTable.type, admittedType),
          sql`json_extract(${EventTable.data}, '$.inputID') >= ${receiptPrefix} AND json_extract(${EventTable.data}, '$.inputID') < ${receiptBound}`,
          waitingMatch(answered),
        ),
      )
      .orderBy(desc(EventTable.seq))
      .limit(receiptScanLimit)
      .all()
      .pipe(Effect.orDie)
    const records = yield* Effect.forEach(
      admitted.flatMap((item) => {
        const decoded = decodeAdmitted(item.data)
        return decoded._tag === "Some" ? [decoded.value.inputID] : []
      }),
      (inputID) =>
        SessionPending.lookup(db, owner, inputID).pipe(
          Effect.catchDefect((defect) => (defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(undefined) : Effect.die(defect))),
        ),
    )
    return records.flatMap((record) => {
      const goalDecision: unknown = record?.type === "synthetic" ? record.data.metadata?.goalDecision : undefined
      const decoded = decodeReceipt(goalDecision)
      return decoded._tag === "Some" ? [decoded.value] : []
    })
  })

  const resumable = Effect.fnUntraced(function* (owner: SessionSchema.ID) {
    if ((yield* execution.active).has(owner)) return false
    const own = yield* db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, owner)).get().pipe(Effect.orDie)
    if (own !== undefined && own.state !== "running") return false
    const child = yield* db
      .select({ sessionID: SessionTaskTable.session_id })
      .from(SessionTaskTable)
      .where(and(eq(SessionTaskTable.parent_id, owner), inArray(SessionTaskTable.state, [...activeTaskStates])))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (child !== undefined) return false
    if ((yield* SessionReviewFold.openCount(db, owner)) > 0) return false
    const session = yield* db.select({ revert: SessionTable.revert }).from(SessionTable).where(eq(SessionTable.id, owner)).get().pipe(Effect.orDie)
    if (session === undefined || (session.revert !== null && session.revert !== undefined)) return false
    const located = yield* locate(owner)
    if (located?.shell === undefined) return true
    return !(yield* located.shell.list()).some((info) => info.metadata.sessionID === owner)
  })

  const resume = Effect.fnUntraced(function* (owner: SessionSchema.ID, answered: Answered) {
    const requirement = yield* capture(owner)
    if (requirement === undefined) return
    const waiting = [...new Map((yield* waitingFor(owner, answered)).map((receipt) => [receipt.candidate.fingerprint, receipt] as const)).values()]
    const fresh = yield* Effect.forEach(waiting, (receipt) =>
      record({
        owner,
        requirement,
        candidate: { ...receipt.candidate, action: receipt.candidate.kind, ...(receipt.source === undefined ? {} : { source: receipt.source }) },
        outcome: "resumed",
        discriminator: "",
        rationale: "A native settlement or answer resolved the request this receipt was waiting on.",
      }),
    )
    if (fresh.some((value) => value) && (yield* Effect.scoped(resumable(owner)))) yield* execution.wake(owner)
  })

  const sessionIDOf = (value: string) => (isSessionID(value) ? value : undefined)

  const triggerOf = Effect.fnUntraced(function* (event: HandledEvent): Effect.fn.Return<Trigger | undefined> {
    const answer = (kind: Kind, sessionID: string, requestID: string, answered: boolean): Trigger | undefined => {
      const id = sessionIDOf(sessionID)
      return id === undefined ? undefined : { sessionID: id, ...(answered ? { answered: { kind, sessionID: id, requestID } } : {}) }
    }
    switch (event.type) {
      case Permission.Event.Asked.type:
        return answer("permission", event.data.sessionID, event.data.id, false)
      case Permission.Event.Replied.type:
        return answer("permission", event.data.sessionID, event.data.requestID, event.data.reply !== "reject")
      case Permission.Event.Deferred.type:
        return answer("permission", event.data.sessionID, event.data.requestID, false)
      case Guardrail.Event.Asked.type:
        return answer("guardrail", event.data.sessionID, event.data.id, false)
      case Guardrail.Event.Replied.type:
        return answer("guardrail", event.data.sessionID, event.data.requestID, event.data.reply !== "reject")
      case Guardrail.Event.Deferred.type:
        return answer("guardrail", event.data.sessionID, event.data.requestID, false)
      case SessionEvent.GuardrailDecided.type:
        return answer("guardrail", event.data.reviewSessionID, event.data.requestID, event.data.reply !== "reject")
      case Form.Event.Created.type:
        return answer("form", event.data.form.sessionID, event.data.form.id, false)
      case Form.Event.Replied.type:
        return answer("form", event.data.sessionID, event.data.id, true)
      case Form.Event.Cancelled.type:
      case Form.Event.TimedOut.type:
      case Form.Event.Deferred.type:
        return answer("form", event.data.sessionID, event.data.id, false)
      case Question.Event.Asked.type:
        return answer("question", event.data.sessionID, event.data.id, false)
      case Question.Event.Replied.type:
        return answer("question", event.data.sessionID, event.data.requestID, true)
      case Question.Event.Rejected.type:
      case Question.Event.TimedOut.type:
      case Question.Event.Deferred.type:
        return answer("question", event.data.sessionID, event.data.requestID, false)
      case SessionEvent.Review.Deferred.type:
      case SessionEvent.Review.Withdrawn.type:
        return { sessionID: event.data.sessionID }
      case SessionEvent.Review.Decided.type: {
        const decision = event.data.decision
        const item = (yield* SessionReviewFold.fold(db, [event.data.sessionID])).find((found) => found.itemID === event.data.itemID)
        if (item === undefined) return { sessionID: event.data.sessionID }
        const payload = item.payload
        const answered =
          "dismissed" in decision || decision.kind === "recovery"
            ? undefined
            : payload.type === "permission"
              ? { kind: "permission" as const, requestID: payload.requestID }
              : payload.type === "guardrail"
                ? { kind: "guardrail" as const, requestID: payload.requestID }
                : payload.type === "form" && "requestID" in item.origin
                  ? { kind: "form" as const, requestID: item.origin.requestID }
                  : payload.type === "question" && "requestID" in item.origin
                    ? { kind: "question" as const, requestID: item.origin.requestID }
                    : payload.type === "subagent_question" && "questionID" in item.origin
                      ? { kind: "child_question" as const, requestID: item.origin.questionID }
                      : undefined
        return answered === undefined
          ? { sessionID: event.data.sessionID }
          : { sessionID: event.data.sessionID, answered: { ...answered, sessionID: item.sessionID } }
      }
      default: {
        const change = event.data.change
        if (change.type === "question_answered") return answer("child_question", event.data.sessionID, change.answer.questionID, true)
        if (change.type === "question_asked" || change.type === "question_timed_out")
          return answer("child_question", event.data.sessionID, change.type === "question_asked" ? change.question.id : change.questionID, false)
        return undefined
      }
    }
  })

  const guarded = (message: string) =>
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logWarning(message, { cause: Cause.pretty(cause) }),
    )

  const handle: Interface["handle"] = (event) =>
    Effect.gen(function* () {
      const trigger = yield* triggerOf(event)
      if (trigger === undefined) return
      const owner = yield* ownerOf(trigger.sessionID)
      if (owner === undefined) return
      const answered = trigger.answered
      if (answered !== undefined) yield* locks.withLock(owner)(Effect.scoped(resume(owner, answered)))
      yield* inspect(owner)
    }).pipe(guarded("Goal decision event handling failed"))

  const reconcile: Interface["reconcile"] = (sessionID) =>
    Effect.gen(function* () {
      const nearest = yield* ownerOf(sessionID)
      const below = (yield* subtree(sessionID, false)).filter(eligible).map((member) => member.id)
      yield* Effect.forEach(new Set(nearest === undefined ? below : [nearest, ...below]), inspect, { discard: true })
    }).pipe(guarded("Goal decision reconciliation failed"))

  return { handle, reconcile, inspect }
}

export const start = Effect.fnUntraced(function* (input: {
  readonly events: Pick<EventRuntime.Interface, "subscribe">
  readonly autonomy: Pick<SessionAutonomy.Interface, "changes">
  readonly loop: Pick<Interface, "handle" | "reconcile">
}) {
  const scope = yield* Scope.Scope
  yield* input.events.subscribe(handledEvents).pipe(
    Stream.runForEach((event) => input.loop.handle(event).pipe(Effect.forkIn(scope), Effect.asVoid)),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* input.autonomy.changes.pipe(
    Stream.runForEach((sessionID) => input.loop.reconcile(sessionID).pipe(Effect.forkIn(scope), Effect.asVoid)),
    Effect.forkScoped({ startImmediately: true }),
  )
})

export const locate =
  (store: Pick<SessionStore.Interface, "get">, locations: LocationServiceMap.Interface): Options["locate"] =>
  Effect.fnUntraced(function* (sessionID) {
    const session = yield* store.get(sessionID)
    if (session === undefined) return undefined
    const loaded = (yield* locations.loaded()).find(
      (entry) => entry.ref.directory === session.location.directory && entry.ref.workspaceID === session.location.workspaceID,
    )
    if (loaded === undefined) return undefined
    const permission = loaded.built.includes(Permission.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [Permission.node]).pipe(Effect.orDie), Permission.Service)
      : undefined
    const guardrail = loaded.built.includes(SessionGuardrail.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [SessionGuardrail.node]).pipe(Effect.orDie), SessionGuardrail.Service)
      : undefined
    const form = loaded.built.includes(Form.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [Form.node]).pipe(Effect.orDie), Form.Service)
      : undefined
    const question = loaded.built.includes(Question.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [Question.node]).pipe(Effect.orDie), Question.Service)
      : undefined
    const shell = loaded.built.includes(Shell.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [Shell.node]).pipe(Effect.orDie), Shell.Service)
      : undefined
    const goal = loaded.built.includes(SessionGoal.node.name)
      ? Context.get(yield* locations.contextEffect(loaded.ref, [SessionGoal.node]).pipe(Effect.orDie), SessionGoal.Service)
      : undefined
    return { permission, guardrail, form, question, shell, goal, session } satisfies Located
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const execution = yield* SessionExecution.Service
    const orchestration = yield* SessionOrchestration.Service
    const settings = yield* CoordinationSettings.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const loop = make({ db: database.db, events, autonomy, execution, orchestration, policy: settings.read, locate: locate(store, locations) })
    yield* start({ events, autonomy, loop })
    return Service.of(loop)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventRuntime.node,
    SessionAutonomy.node,
    SessionExecution.node,
    SessionOrchestration.node,
    CoordinationSettings.node,
    SessionStore.node,
    LocationServiceMap.node,
  ],
})
