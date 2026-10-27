export * as Form from "./form"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Form } from "@ycoding-ai/schema/form"
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { Database } from "./database/database"
import { Decision } from "./decision"
import { DecisionChoice } from "./decision-choice"
import { makeLocationNode } from "./effect/app-node"
import { EventRuntime } from "./event"
import { SessionAutonomy } from "./session/autonomy"
import { SessionEvent } from "./session/event"
import { CoordinationEscalation } from "./session/coordination-escalation"
import { SessionMessage } from "./session/message"
import { SessionReviewFold } from "./session/review-fold"
import { SessionSchema } from "./session/schema"
import { Hash } from "./util/hash"

const RETENTION = Duration.minutes(10)

export const ID = Form.ID
export type ID = typeof ID.Type

export const Info = Form.Info
export type Info = typeof Info.Type

export const Field = Form.Field
export type Field = Form.Field

export const Fields = Form.Fields
export type Fields = Form.Fields

export const When = Form.When
export type When = Form.When

export const State = Form.State
export type State = typeof State.Type
export type TerminalState = Exclude<State, { readonly status: "pending" }>
export type AskResult = TerminalState & { readonly automatic?: true; readonly via?: "auto-answer" | "yolo"; readonly confidence?: number; readonly assessment?: Form.Assessment; readonly source?: ReplySource }

export const Answer = Form.Answer
export type Answer = typeof Answer.Type

export const Reply = Form.Reply
export type Reply = typeof Reply.Type

export const ReplySource = Form.ReplySource
export type ReplySource = typeof ReplySource.Type

export const DelegatedReplySource = Form.DelegatedReplySource
export type DelegatedReplySource = typeof DelegatedReplySource.Type

export const DotsClientReplySource = Form.DotsClientReplySource
export type DotsClientReplySource = Form.DotsClientReplySource
export const NativeReplySource = Form.NativeReplySource
export type NativeReplySource = Form.NativeReplySource
export const ClientReplySource = Form.ClientReplySource
export type ClientReplySource = Form.ClientReplySource
export const ExternalReplySource = Form.ExternalReplySource
export type ExternalReplySource = Form.ExternalReplySource

export function fingerprint(form: Pick<Info, "sessionID" | "title" | "fields">) {
  return Hash.json({ sessionID: form.sessionID, title: form.title, fields: form.fields })
}

export interface Snapshot {
  readonly form: Info
  readonly fingerprint: string
  readonly state: State
}

export interface ReconsiderInput {
  readonly id: ID
  readonly fingerprint: string
  readonly actor: "coordinator"
  readonly source: { readonly coordinatorSessionID: string; readonly groupID: string; readonly rationale: string }
  readonly answer?: Answer
  readonly confidence?: number
  readonly validate: (snapshot: Info) => Effect.Effect<boolean>
}

export interface EscalateInput extends CoordinationEscalation.Input {
  readonly id: ID
}

export type EscalateResult = CoordinationEscalation.Result<ID>

export interface ReconsiderResult {
  readonly outcome: "allowed" | "denied" | "escalated" | "stale"
  readonly requestID: ID
  readonly fingerprint: string
  readonly settled: boolean
  readonly via?: "auto-answer" | "yolo" | "coordination"
  readonly confidence?: number
  readonly source?: ReplySource
  readonly reason?: string
}

export const Event = Form.Event
export const Assessment = Form.Assessment
export type Assessment = Form.Assessment

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Form.NotFoundError", {
  id: ID,
}) {
  override get message() {
    return `Form not found: ${this.id}`
  }
}

export class AlreadySettledError extends Schema.TaggedErrorClass<AlreadySettledError>()("Form.AlreadySettledError", {
  id: ID,
}) {
  override get message() {
    return `Form already settled: ${this.id}`
  }
}

export class AlreadyExistsError extends Schema.TaggedErrorClass<AlreadyExistsError>()("Form.AlreadyExistsError", {
  id: ID,
}) {
  override get message() {
    return `Form already exists: ${this.id}`
  }
}

export class InvalidAnswerError extends Schema.TaggedErrorClass<InvalidAnswerError>()("Form.InvalidAnswerError", {
  id: ID,
  message: Schema.String,
}) {}

export class InvalidFormError extends Schema.TaggedErrorClass<InvalidFormError>()("Form.InvalidFormError", {
  message: Schema.String,
}) {}

export type CreateInput = Omit<Form.Info, "id" | "assessment"> & { readonly id?: ID }

export interface ReplyInput {
  readonly id: ID
  readonly answer: Answer
}

export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
}

export interface DelegatedReplyInput {
  readonly explicitDecision?: true
  readonly id: ID
  readonly answer: Answer
  readonly fingerprint: string
  readonly source: ExternalReplySource
  readonly validate: (form: Info) => Effect.Effect<boolean>
}

export interface Interface {
  readonly cancelDelegated: (input: Omit<DelegatedReplyInput, "answer" | "source"> & { readonly source: ClientReplySource }) => Effect.Effect<void, AlreadySettledError | NotFoundError>
  readonly replyDelegated: (input: DelegatedReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  readonly ask: (
    input: CreateInput,
  ) => Effect.Effect<AskResult, AlreadyExistsError | InvalidFormError | SessionReviewFold.FullError>
  readonly deferPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  readonly snapshot: (id: ID) => Effect.Effect<Snapshot | undefined>
  readonly snapshots: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Snapshot>>
  readonly reconsider: (input: ReconsiderInput) => Effect.Effect<ReconsiderResult>
  readonly escalate: (input: EscalateInput) => Effect.Effect<EscalateResult>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly cancel: (id: ID) => Effect.Effect<void, AlreadySettledError | NotFoundError>
  readonly cancelPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Form") {}

interface Entry {
  readonly form: Info
  readonly state: State
  readonly deferred: Deferred.Deferred<TerminalState>
  readonly epoch: number | undefined
  readonly source?: ReplySource
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const decision = yield* Decision.Service
    const settle = Semaphore.makeUnsafe(1)
    const reconsidering = new Set<ID>()
    const asks = new Map<string, { epoch: number; count: number }>()
    const enter = (sessionID: string) => {
      const state = asks.get(sessionID) ?? { epoch: 0, count: 0 }
      state.count++
      asks.set(sessionID, state)
      const epoch = state.epoch
      return {
        epoch,
        superseded: () => state.epoch !== epoch,
        release: () => {
          state.count--
          if (state.count === 0 && asks.get(sessionID) === state) asks.delete(sessionID)
        },
      }
    }
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => settle.withPermit(Effect.uninterruptible(effect))
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    const find = Effect.fn("Form.find")(function* (id: ID) {
      return yield* Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) =>
          Option.match(entry, {
            onNone: () => Effect.fail(new NotFoundError({ id })),
            onSome: Effect.succeed,
          }),
        ),
      )
    })

    const complete = Effect.fn("Form.complete")(function* (
      entry: Entry,
      state: Exclude<TerminalState, { readonly status: "timed_out" }>,
      source?: ReplySource,
      receiptCommitted = false,
    ) {
      const id = entry.form.id
      const sessionID = entry.form.sessionID
      const notification = state.status === "answered"
        ? events.publish(Event.Replied, { id, sessionID, answer: state.answer, ...(source === undefined ? {} : { source }) }).pipe(Effect.asVoid)
        : state.status === "cancelled"
          ? events.publish(Event.Cancelled, { id, sessionID }).pipe(Effect.asVoid)
          : events.publish(Event.Deferred, { id, sessionID, itemID: state.itemID }).pipe(Effect.asVoid)
      const form = entry.form.assessment === undefined ? entry.form : { ...entry.form, assessment: {
        ...entry.form.assessment,
        fields: entry.form.assessment.fields.map((field) => field.status !== "pending" ? field : {
          key: field.key, status: "not_assessed" as const,
          reason: state.status === "answered" ? "Answered before assessment settled." : "Request closed before assessment settled.",
        }),
      } }
      const settle = Cache.set(forms, id, { form, deferred: entry.deferred, epoch: entry.epoch, state, ...(source === undefined ? {} : { source }) }).pipe(
        Effect.andThen(Deferred.succeed(entry.deferred, state)),
      )
      yield* receiptCommitted ? notification.pipe(Effect.ensuring(settle)) : notification.pipe(Effect.andThen(settle))
    })

    const createPending = Effect.fn("Form.createPending")((input: CreateInput, epoch?: number, assessment?: Form.Assessment) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const id = input.id ?? ID.create()
          const existing = yield* Cache.getSuccess(forms, id)
          if (Option.isSome(existing)) return yield* new AlreadyExistsError({ id })
          const invalid = validateFields(input.fields)
          if (invalid) return yield* new InvalidFormError({ message: invalid })
          const form: Info = {
            id,
            sessionID: input.sessionID,
            title: input.title,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            fields: input.fields,
            ...(assessment === undefined ? {} : { assessment }),
          }
          const entry: Entry = {
            form,
            state: { status: "pending" },
            deferred: yield* Deferred.make<TerminalState>(),
            epoch,
          }
          yield* Cache.set(forms, id, entry)
          yield* events.publish(Event.Created, { form }).pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          return form
        }),
      ),
    )

    const reviewLimit = Effect.fnUntraced(function* () {
      return Config.latest(yield* config.entries(), "guardrails")?.max_pending_reviews ?? 16
    })

    const openReview = Effect.fnUntraced(function* (
      form: Info,
      sessionID: SessionSchema.ID,
      outcome: { readonly reason: "disabled" | "free_text" | "error" | "sleep_entry" | DecisionChoice.UnsettledReason; readonly choice?: string; readonly confidence?: number },
      conversion = false,
    ) {
      const tool = form.metadata?.tool
      const origin = tool && typeof tool === "object" && !Array.isArray(tool) &&
        typeof (tool as Record<string, unknown>).messageID === "string" && typeof (tool as Record<string, unknown>).callID === "string"
        ? { messageID: SessionMessage.ID.make((tool as Record<string, string>).messageID), callID: (tool as Record<string, string>).callID }
        : { requestID: form.id }
      return yield* SessionReviewFold.open(database.db, events, {
        sessionID,
        kind: "question",
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        origin,
        payload: {
          type: "form",
          title: form.title,
          fields: form.fields,
          ...(form.metadata?.kind === "question" ? { questionTool: true as const } : {}),
          ...CoordinationEscalation.redacted(form.coordinationEscalation),
        },
        limit: yield* reviewLimit(),
        conversion,
      })
    })

    const deferPending = Effect.fn("Form.deferPending")(function* (sessionID: SessionSchema.ID) {
      const entries = Array.from(yield* Cache.values(forms)).filter(
        (entry) => entry.state.status === "pending" && entry.epoch !== undefined && entry.form.sessionID === sessionID,
      )
      yield* Effect.forEach(entries, (entry) =>
        exclusive(Effect.gen(function* () {
          const current = yield* find(entry.form.id).pipe(Effect.orDie)
          if (current.state.status !== "pending") return
          const item = yield* openReview(current.form, sessionID, { reason: "sleep_entry" }, true).pipe(Effect.orDie)
          yield* complete(current, { status: "deferred", itemID: item.itemID })
        })), { discard: true })
    })

    const cancelPending = Effect.fn("Form.cancelPending")(function* (sessionID: SessionSchema.ID) {
      const state = asks.get(sessionID)
      if (state === undefined) return
      const advanced = ++state.epoch
      const obsolete = Array.from(yield* Cache.values(forms)).filter(
        (entry) =>
          entry.state.status === "pending" &&
          entry.epoch !== undefined &&
          entry.epoch < advanced &&
          entry.form.sessionID === sessionID,
      )
      yield* Effect.forEach(obsolete, (entry) => cancelObsolete(entry.form.id), { discard: true })
    })

    const cancelObsolete = (id: ID) =>
      cancel(id).pipe(
        Effect.catchTags({
          "Form.AlreadySettledError": () => Effect.void,
          "Form.NotFoundError": () => Effect.void,
        }),
      )

    const create = Effect.fn("Form.create")((input: CreateInput) => createPending(input))

    const updateAssessment = (entry: Entry, assessment: Form.Assessment) => Effect.gen(function* () {
      const updated = { ...entry, form: { ...entry.form, assessment } }
      yield* Cache.set(forms, entry.form.id, updated)
      yield* events.publish(Event.Assessed, { id: entry.form.id, sessionID: entry.form.sessionID, assessment })
      return updated
    })

    const assessed = (id: ID, fields: ReadonlyArray<Form.FieldAssessment>) => exclusive(Effect.gen(function* () {
      const entry = yield* find(id).pipe(Effect.orDie)
      if (entry.state.status !== "pending" || entry.form.assessment === undefined) return
      yield* updateAssessment(entry, { ...entry.form.assessment, fields })
    }))

    const withSettlement = (id: ID, result: AskResult) => Effect.gen(function* () {
      const final = yield* find(id).pipe(Effect.orDie)
      return { ...result, ...(final.form.assessment === undefined ? {} : { assessment: final.form.assessment }), ...(final.source === undefined ? {} : { source: final.source }) }
    })

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.acquireUseRelease(
        Effect.sync(() => enter(input.sessionID)),
        (ticket) => Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const sessionID = Schema.is(SessionSchema.ID)(input.sessionID) ? input.sessionID : undefined
          const snapshot = sessionID
            ? yield* autonomy
                .snapshot(sessionID, { inherited: true })
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
            : undefined
          const mode = sessionID && snapshot ? yield* DecisionChoice.decisionMode(autonomy, sessionID, "answers") : "manual"
          const autoAnswer = mode === "auto"
          const yolo = mode === "yolo"
          const explicit = input.metadata?.requireExplicitDecision === true
          const effective = input.metadata?.kind === "question" && sessionID && snapshot
            ? yield* autonomy.effectiveDecisions(sessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
            : undefined
          const assessment: Form.Assessment | undefined = input.metadata?.kind === "question" && input.fields.some((field) => (field.type === "string" || field.type === "multiselect") && (field.options?.length ?? 0) > 0) ? {
            mode, sourceSessionID: effective?.inherited.answers ?? input.sessionID,
            fields: input.fields.flatMap((field): Form.FieldAssessment[] =>
              (field.type === "string" || field.type === "multiselect") && (field.options?.length ?? 0) > 0
                ? [{ key: field.key, status: yolo && !explicit ? "pending" : "not_assessed", reason: explicit ? "This request requires an explicit decision; no model assessment." : yolo ? "Answers evaluator is assessing the options." : mode === "auto" ? "Auto uses only explicit defaults or a unique Recommended option; no model assessment." : "Manual answers require your decision; no model assessment." }]
                : []),
          } : undefined
          const createWaiting = (waiting: CreateInput, value = assessment) =>
            createPending(waiting, ticket.epoch, value).pipe(
              Effect.tap((created) => (ticket.superseded() ? cancelObsolete(created.id) : Effect.void)),
            )
          const asleep = sessionID
            ? yield* autonomy
                .isAsleep(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            : false
          const auto = !explicit && (autoAnswer || yolo)
          if (asleep && sessionID) {
            const form: Info = {
              id: input.id ?? ID.create(),
              sessionID: input.sessionID,
              title: input.title,
              ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
              fields: input.fields,
            }
            if (!auto || !snapshot) {
              const item = yield* openReview(form, sessionID, { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID, ...(assessment === undefined ? {} : { assessment }) } as AskResult
            }
            const outcome = yield* restore(decisionAnswer(decision, sessionID, form, { autoAnswer, yolo }))
            const unchanged = outcome.type === "answer" && (yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot))
            if (outcome.type === "defer" || !unchanged) {
              const asleepNow = yield* autonomy
                .isAsleep(sessionID)
                .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
              if (asleepNow) {
                const item = yield* openReview(form, sessionID, outcome.type === "defer" ? outcome : { reason: "disabled" })
                return { status: "deferred", itemID: item.itemID, ...(assessment === undefined ? {} : { assessment: { ...assessment, fields: outcome.assessments ?? assessment.fields } }) } as AskResult
              }
              if (ticket.superseded()) return { status: "cancelled" } as TerminalState
              const created = yield* createWaiting({ ...input, id: form.id }, assessment === undefined ? undefined : { ...assessment, fields: outcome.assessments ?? assessment.fields })
              const entry = yield* find(created.id).pipe(Effect.orDie)
              return yield* restore(Deferred.await(entry.deferred)).pipe(
                Effect.flatMap((result) => withSettlement(created.id, result)),
                Effect.onInterrupt(() => Effect.ignore(cancel(created.id))),
              )
            }
            const created = yield* createWaiting({ ...input, id: form.id }, assessment === undefined ? undefined : { ...assessment, fields: outcome.assessments ?? assessment.fields })
            const entry = yield* find(created.id).pipe(Effect.orDie)
            const automatic = yield* reply({ id: created.id, answer: outcome.answer }).pipe(
              Effect.as(true),
              Effect.catchTag("Form.AlreadySettledError", () => Effect.succeed(false)),
              Effect.orDie,
            )
            const result = yield* Deferred.await(entry.deferred)
            return yield* withSettlement(created.id, { ...result, ...(automatic ? { automatic: true as const, via: outcome.via, ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) } : {}) })
          }
          if (ticket.superseded()) return { status: "cancelled" } as TerminalState
          const form = yield* createWaiting(input)
          const entry = yield* find(form.id).pipe(Effect.orDie)
          return yield* restore(Effect.gen(function* () {
            const outcome = auto && sessionID && snapshot
              ? yield* decisionAnswer(decision, sessionID, form, { autoAnswer, yolo }).pipe(
                  Effect.raceFirst(Deferred.await(entry.deferred).pipe(Effect.as(undefined))),
                )
              : undefined
            const unchanged = outcome?.type === "answer" && sessionID && snapshot
              ? yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot)
              : false
            if (outcome?.assessments && assessment) yield* assessed(form.id,
              outcome.type === "answer" && !unchanged
                ? outcome.assessments.map((field) => ({ ...field, status: "unavailable" as const, recommendation: undefined, reason: "Answers mode changed; assessment not applied." }))
                : outcome.assessments,
            )
            const automatic = outcome?.type === "answer" && unchanged
              ? yield* reply({ id: form.id, answer: outcome.answer }).pipe(
                  Effect.as(true),
                  Effect.catchTag("Form.AlreadySettledError", () => Effect.succeed(false)),
                  Effect.orDie,
                )
              : false
            const result = yield* Deferred.await(entry.deferred)
            const value = automatic && outcome?.type === "answer"
              ? { ...result, automatic: true as const, via: outcome.via, ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }) }
              : result
            return yield* withSettlement(form.id, value)
          })).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
        ),
        (ticket) => Effect.sync(ticket.release),
      ),
    )

    const get = Effect.fn("Form.get")(function* (id: ID) {
      return (yield* find(id)).form
    })

    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        .filter((entry) => entry.state.status === "pending")
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        .map((entry) => entry.form)
    })

    const state = Effect.fn("Form.state")(function* (id: ID) {
      return (yield* find(id)).state
    })

    const snapshot = Effect.fn("Form.snapshot")((id: ID) =>
      find(id).pipe(
        Effect.map((entry) => ({ form: entry.form, fingerprint: fingerprint(entry.form), state: entry.state })),
        Effect.catchTag("Form.NotFoundError", () => Effect.succeed(undefined)),
      ),
    )

    const snapshots = Effect.fn("Form.snapshots")(function* (sessionID: SessionSchema.ID) {
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        .filter((entry) => entry.state.status === "pending" && entry.form.sessionID === sessionID)
        .slice(0, 50)
        .map((entry) => ({ form: entry.form, fingerprint: fingerprint(entry.form), state: entry.state }))
    })

    const reconsider = Effect.fn("Form.reconsider")((input: ReconsiderInput) =>
      Effect.acquireUseRelease(
        exclusive(
          Effect.gen(function* (): Effect.fn.Return<{ readonly entry?: Entry; readonly result?: ReconsiderResult }> {
            const entry = yield* find(input.id).pipe(Effect.catchTag("Form.NotFoundError", () => Effect.succeed(undefined)))
            if (entry === undefined || entry.state.status !== "pending" || fingerprint(entry.form) !== input.fingerprint)
              return { result: { outcome: "stale", requestID: input.id, fingerprint: input.fingerprint, settled: false } }
            if (reconsidering.has(input.id))
              return {
                result: {
                  outcome: "escalated",
                  requestID: input.id,
                  fingerprint: input.fingerprint,
                  settled: false,
                  reason: "native-assessment-in-progress",
                },
              }
            reconsidering.add(input.id)
            return { entry }
          }),
        ),
        (acquired) =>
          acquired.entry === undefined
            ? Effect.succeed(acquired.result!)
            : Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const entry = acquired.entry!
                  const base = { requestID: input.id, fingerprint: input.fingerprint }
                  if (!(yield* input.validate(entry.form)))
                    return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                  if (entry.form.metadata?.requireExplicitDecision === true)
                    return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:request" }
                  if (
                    input.answer !== undefined &&
                    input.confidence !== undefined &&
                    (!Number.isFinite(input.confidence) || input.confidence < 0.8)
                  )
                    return { ...base, outcome: "escalated" as const, settled: false, reason: "low-confidence" }
                  const sessionID = Schema.is(SessionSchema.ID)(entry.form.sessionID) ? entry.form.sessionID : undefined
                  if (sessionID === undefined) return { ...base, outcome: "stale" as const, settled: false }
                  const authorization = yield* autonomy
                    .snapshot(sessionID, { inherited: true })
                    .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
                  if (authorization === undefined) return { ...base, outcome: "stale" as const, settled: false }
                  const mode = yield* DecisionChoice.decisionMode(autonomy, sessionID, "answers")
                  if (mode === "manual")
                    return { ...base, outcome: "escalated" as const, settled: false, reason: "explicit-decision:manual-answers" }
                  const native =
                    input.answer === undefined || mode === "auto"
                      ? yield* restore(
                          decisionAnswer(decision, sessionID, entry.form, { autoAnswer: mode === "auto", yolo: mode === "yolo" }),
                        )
                      : undefined
                  if (native?.type === "answer" && input.answer !== undefined && Hash.json(input.answer) !== Hash.json(native.answer))
                    return { ...base, outcome: "escalated" as const, settled: false, reason: "answer-not-deterministic" }
                  const outcome: SleepOutcome =
                    native?.type === "defer"
                      ? native
                      : input.answer !== undefined
                      ? {
                          type: "answer",
                          answer: input.answer,
                          via: mode === "auto" ? "auto-answer" : "yolo",
                          ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
                        }
                      : native!
                  const effective = native?.assessments === undefined ? undefined : yield* autonomy.effectiveDecisions(sessionID).pipe(
                    Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)),
                  )
                  return yield* exclusive(
                    Effect.gen(function* () {
                      const current = yield* find(input.id).pipe(
                        Effect.catchTag("Form.NotFoundError", () => Effect.succeed(undefined)),
                      )
                      if (current === undefined || current.state.status !== "pending" || fingerprint(current.form) !== input.fingerprint)
                        return { ...base, outcome: "stale" as const, settled: false }
                      if (!(yield* input.validate(current.form)))
                        return { ...base, outcome: "escalated" as const, settled: false, reason: "delegation-invalid" }
                      if (!(yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, authorization)))
                        return { ...base, outcome: "escalated" as const, settled: false, reason: "stale-assessment" }
                      if (outcome.type === "answer") {
                        const invalid = validateAnswer(current.form, outcome.answer)
                        if (invalid) return { ...base, outcome: "escalated" as const, settled: false, reason: "invalid-answer" }
                      }
                      const updated = native?.assessments === undefined ? current : yield* updateAssessment(current, {
                        mode, sourceSessionID: effective?.inherited.answers ?? sessionID, fields: native.assessments,
                      })
                      if (outcome.type === "defer")
                        return { ...base, outcome: "escalated" as const, settled: false, reason: outcome.reason }
                      const via = input.answer !== undefined ? ("coordination" as const) : outcome.via
                      const source: ReplySource = {
                        kind: "coordinator",
                        coordinatorSessionID: input.source.coordinatorSessionID,
                        groupID: input.source.groupID,
                        via,
                        rationale: input.source.rationale,
                        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                      }
                      yield* complete(updated, { status: "answered", answer: outcome.answer }, source)
                      return {
                        ...base,
                        outcome: "allowed" as const,
                        settled: true,
                        via,
                        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                        source,
                      }
                    }),
                  )
                }),
              ),
        (acquired) =>
          Effect.sync(() => {
            if (acquired.entry !== undefined) reconsidering.delete(input.id)
          }),
      ),
    )

    const escalate = Effect.fn("Form.escalate")((input: EscalateInput) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(input.id).pipe(Effect.catchTag("Form.NotFoundError", () => Effect.succeed(undefined)))
          const sessionID = entry?.form.sessionID
          if (entry === undefined || fingerprint(entry.form) !== input.fingerprint || !Schema.is(SessionSchema.ID)(sessionID))
            return CoordinationEscalation.result(input.id, input)
          if (entry.state.status === "deferred")
            return CoordinationEscalation.deferred(input.id, input, {
              itemID: entry.state.itemID,
              ...(entry.form.coordinationEscalation === undefined ? {} : { coordinationEscalation: entry.form.coordinationEscalation }),
            })
          if (entry.state.status !== "pending") return CoordinationEscalation.result(input.id, input)
          const appended = CoordinationEscalation.append(entry.form.coordinationEscalation, input.source)
          if (appended.type !== "appended") return CoordinationEscalation.result(input.id, input, appended)
          yield* Cache.set(forms, input.id, { ...entry, form: { ...entry.form, coordinationEscalation: appended.value } })
          yield* events.publish(Coordination.Event.RequestEscalated, {
            sessionID,
            kind: "question",
            requestID: input.id,
            coordinationEscalation: appended.value,
          })
          return CoordinationEscalation.result(input.id, input, appended)
        }),
      ),
    )

    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(input.id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          const invalid = validateAnswer(entry.form, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          yield* complete(entry, { status: "answered", answer: input.answer })
        }),
      ),
    )

    const replyDelegated = Effect.fn("Form.replyDelegated")((input: DelegatedReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(input.id)
          if (entry.state.status !== "pending" || fingerprint(entry.form) !== input.fingerprint ||
            (!input.explicitDecision && (entry.form.metadata?.requireExplicitDecision === true || entry.form.fields.some((field) => field.type === "external"))) ||
            !(yield* input.validate(entry.form)))
            return yield* new NotFoundError({ id: input.id })
          const invalid = validateAnswer(entry.form, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          const committed = yield* events.publishBatch([{ definition: SessionEvent.DotsDecisionSettled, data: {
            sessionID: SessionSchema.ID.make(entry.form.sessionID),
            source: input.source,
            target: { kind: "form", formID: entry.form.id, fingerprint: input.fingerprint },
          } }], { when: input.validate(entry.form) })
          if (committed.length === 0) return yield* new NotFoundError({ id: input.id })
          yield* complete(entry, { status: "answered", answer: input.answer }, input.source, true)
        }),
      ),
    )

    const cancelDelegated: Interface["cancelDelegated"] = (input) => exclusive(Effect.gen(function* () {
      const entry = yield* find(input.id)
      if (!input.explicitDecision || entry.state.status !== "pending" || fingerprint(entry.form) !== input.fingerprint || !(yield* input.validate(entry.form)))
        return yield* new NotFoundError({ id: input.id })
      const committed = yield* events.publishBatch([{ definition: SessionEvent.DotsDecisionSettled, data: {
        sessionID: SessionSchema.ID.make(entry.form.sessionID), source: input.source,
        target: { kind: "form", formID: entry.form.id, fingerprint: input.fingerprint },
      } }], { when: input.validate(entry.form) })
      if (committed.length === 0) return yield* new NotFoundError({ id: input.id })
      return yield* complete(entry, { status: "cancelled" }, input.source, true)
    }))

    const cancel = Effect.fn("Form.cancel")((id: ID) =>
      exclusive(
        Effect.gen(function* () {
          const entry = yield* find(id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          yield* complete(entry, { status: "cancelled" })
        }),
      ),
    )

    yield* Effect.addFinalizer(() =>
      Cache.values(forms).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            Array.from(entries).filter((entry) => entry.state.status === "pending"),
            (entry) => cancel(entry.form.id).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      ),
    )

    return Service.of({ create, ask, deferPending, get, list, state, snapshot, snapshots, reconsider, escalate, reply, replyDelegated, cancelDelegated, cancel, cancelPending })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node],
})

interface AutoMode {
  readonly autoAnswer: boolean
  readonly yolo: boolean
}

type SleepOutcome =
  | { readonly type: "answer"; readonly answer: Answer; readonly via: "auto-answer" | "yolo"; readonly confidence?: number; readonly assessments?: ReadonlyArray<Form.FieldAssessment> }
  | {
      readonly type: "defer"
      readonly reason: "disabled" | "free_text" | "error" | DecisionChoice.UnsettledReason
      readonly choice?: string
      readonly confidence?: number
      readonly assessments?: ReadonlyArray<Form.FieldAssessment>
    }

function decisionAnswer(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
  mode: AutoMode,
): Effect.Effect<SleepOutcome> {
  return Effect.gen(function* () {
    let consultations = 0
    const consulted: Decision.Interface = {
      evaluate: (input, context) => {
        consultations++
        return decision.evaluate(input, context)
      },
    }
    const answer: Record<string, Form.Value> = {}
    const assessments: Form.FieldAssessment[] = []
    let deferred: Extract<SleepOutcome, { readonly type: "defer" }> | undefined
    let confidence: number | undefined
    for (const field of form.fields) {
      if (field.type === "external") return { type: "defer", reason: "error" } as SleepOutcome
      if (!isActive(field, answer)) {
        if (form.metadata?.kind === "question") assessments.push({ key: field.key, status: "not_assessed", reason: "Conditional field is inactive." })
        continue
      }
      const outcome = yield* decisionValue(consulted, sessionID, form, field, mode)
      if (outcome.assessment !== undefined) assessments.push(outcome.assessment)
      if (outcome.type === "defer") {
        if (form.metadata?.kind !== "question") return outcome
        deferred ??= outcome
        continue
      }
      if (outcome.confidence !== undefined) confidence = Math.min(confidence ?? 1, outcome.confidence)
      if (outcome.value === undefined) continue
      answer[field.key] = outcome.value
    }
    if (deferred) return { ...deferred, ...(assessments.length === 0 ? {} : { assessments }) }
    if (Object.keys(answer).length === 0)
      return {
        type: "defer",
        reason: consultations > 0 ? "low_confidence" : form.fields.some(isTextField) ? "free_text" : "disabled",
      } as SleepOutcome
    return validateAnswer(form, answer)
      ? ({ type: "defer", reason: "error" } as SleepOutcome)
      : ({
          type: "answer",
          answer,
          via: consultations > 0 ? "yolo" : "auto-answer",
          ...(confidence === undefined ? {} : { confidence }),
          ...(assessments.length === 0 ? {} : { assessments }),
        } as SleepOutcome)
  })
}

function isTextField(field: Form.Field) {
  return field.type === "number" || field.type === "integer" || (field.type === "string" && (field.options?.length ?? 0) === 0)
}

type FieldOutcome =
  | { readonly type: "value"; readonly value: Form.Value | undefined; readonly confidence?: number; readonly assessment?: Form.FieldAssessment }
  | (Extract<SleepOutcome, { readonly type: "defer" }> & { readonly assessment?: Form.FieldAssessment })

const fieldInstructions =
  "The user cannot answer this form right now. Answer only this field from the evidence given and the form's stated purpose. Refuse when the evidence does not support an answer; refusal asks the user instead. Never invent facts, names, addresses, or identifiers the evidence does not supply."

const RECOMMENDED = / \(Recommended\)$/

function mustAnswer(form: Info, field: InputField) {
  return field.required === true || form.metadata?.kind === "question"
}

function fieldState(form: Info, field: InputField) {
  return {
    form: form.title,
    field: field.key,
    title: field.title ?? null,
    description: field.description ?? null,
    required: mustAnswer(form, field),
  }
}

function modelDefer(outcome: {
  readonly reason: DecisionChoice.UnsettledReason
  readonly choice?: string
  readonly confidence?: number
}): FieldOutcome {
  return {
    type: "defer",
    reason: outcome.reason,
    ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
    ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
  }
}

function decisionValue(
  decision: Decision.Interface,
  sessionID: SessionSchema.ID,
  form: Info,
  field: InputField,
  mode: AutoMode,
): Effect.Effect<FieldOutcome> {
  const required = mustAnswer(form, field)
  const unanswered: FieldOutcome = required
    ? { type: "defer", reason: isTextField(field) ? "free_text" : "disabled" }
    : { type: "value", value: undefined }
  const call = {
    sessionID,
    name: field.key,
    purpose: "answer" as const,
    authority: "yolo" as const,
    invocationKey: `${form.id}:${field.key}`,
  }
  if (mode.autoAnswer && field.default !== undefined && !validateField(field, field.default))
    return Effect.succeed<FieldOutcome>({ type: "value", value: field.default })
  if (form.metadata?.kind === "question" && mode.yolo && (field.type === "string" || field.type === "multiselect") && field.options && field.options.length > 0) {
    return DecisionChoice.recommend(decision, {
      ...call,
      instructions: fieldInstructions,
      state: { ...fieldState(form, field), options: field.options.map((option) => ({ value: option.value, label: option.label, description: option.description ?? null })) },
      choices: field.options.map((option) => ({ value: option.value, description: option.description ?? option.label })),
      multiple: field.type === "multiselect",
    }).pipe(Effect.map((outcome): FieldOutcome => {
      const assessment: Form.FieldAssessment = { key: field.key, ...outcome, reason: DecisionChoice.recommendationReason(outcome.reason) }
      const value = field.type === "multiselect" ? outcome.recommendation : outcome.recommendation?.[0]
      if (value === undefined) return { type: "defer", reason: outcome.status === "assessed" ? "low_confidence" : Schema.is(DecisionFailure.Reason)(outcome.reason) ? outcome.reason : "error", assessment }
      if (validateField(field, value)) return { type: "defer", reason: "error", assessment: { ...assessment, recommendation: undefined, status: "unavailable", reason: "Recommendation does not satisfy the field constraints." } }
      return { type: "value", value, confidence: outcome.confidence, assessment }
    }))
  }
  if (field.type === "boolean") {
    if (!mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerBoolean(decision, {
      ...call,
      instructions: `${fieldInstructions} Answer yes (true) or no (false) for this field; false is a real answer, distinct from refusing.`,
      state: fieldState(form, field),
    }).pipe(
      Effect.map((outcome): FieldOutcome =>
        outcome.type === "unsettled" ? modelDefer(outcome) : { type: "value", value: outcome.value, confidence: outcome.confidence },
      ),
    )
  }
  if (field.type === "number" || field.type === "integer") {
    if (!required || !mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerText(decision, {
      ...call,
      instructions: `${fieldInstructions} Respond with only the numeric value for this ${field.type} field, with no units or words.`,
      state: {
        ...fieldState(form, field),
        minimum: field.minimum ?? null,
        maximum: field.maximum ?? null,
      },
      maxLength: 64,
    }).pipe(
      Effect.map((outcome): FieldOutcome => {
        if (outcome.type === "unsettled") return modelDefer(outcome)
        const value = Number(outcome.value.trim())
        return !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)) || validateField(field, value)
          ? { type: "defer", reason: "error", confidence: outcome.confidence }
          : { type: "value", value, confidence: outcome.confidence }
      }),
    )
  }
  if (field.type === "multiselect") {
    const marked = field.options.filter((option) => RECOMMENDED.test(option.label)).map((option) => option.value)
    if (mode.autoAnswer && marked.length === 1 && !validateField(field, marked))
      return Effect.succeed<FieldOutcome>({ type: "value", value: marked })
    if (!mode.yolo || field.options.length === 0) return Effect.succeed(unanswered)
    return DecisionChoice.grade(decision, {
      ...call,
      instructions: `${fieldInstructions} Grade every option independently for whether it should be selected.`,
      state: {
        ...fieldState(form, field),
        options: field.options.map((option) => ({ value: option.value, label: option.label, description: option.description ?? null })),
      },
      choices: field.options.map((option) => ({ value: option.value, description: option.description ?? option.label })),
    }).pipe(
      Effect.map((outcome): FieldOutcome => {
        if (outcome.type === "unsettled") return { type: "defer", reason: outcome.reason }
        const selected = outcome.grades.filter(
          (grade) => typeof grade.choice === "string" && grade.confidence >= DecisionChoice.ConfidenceThreshold,
        )
        if (selected.length === 0) return required || (field.minItems ?? 0) > 0 ? { type: "defer", reason: "low_confidence" } : { type: "value", value: undefined }
        const value = selected.map((grade) => String(grade.choice))
        return validateField(field, value)
          ? { type: "defer", reason: "error" }
          : { type: "value", value, confidence: Math.min(...selected.map((grade) => grade.confidence)) }
      }),
    )
  }
  const options = field.options
  if (!options || options.length === 0) {
    if (!required || !mode.yolo) return Effect.succeed(unanswered)
    return DecisionChoice.answerText(decision, {
      ...call,
      instructions: fieldInstructions,
      state: fieldState(form, field),
      maxLength: Math.min(field.maxLength ?? 8192, 8192),
    }).pipe(
      Effect.map((outcome): FieldOutcome =>
        outcome.type === "unsettled"
          ? modelDefer(outcome)
          : validateField(field, outcome.value)
            ? { type: "defer", reason: "error", confidence: outcome.confidence }
            : { type: "value", value: outcome.value, confidence: outcome.confidence },
      ),
    )
  }
  const marked = options.filter((option) => RECOMMENDED.test(option.label))
  if (mode.autoAnswer && marked.length === 1 && marked[0] && !validateField(field, marked[0].value))
    return Effect.succeed<FieldOutcome>({ type: "value", value: marked[0].value })
  if (!mode.yolo) return Effect.succeed(unanswered)
  return DecisionChoice.chooseDetailed(decision, {
    ...call,
    instructions: fieldInstructions,
    state: {
      ...fieldState(form, field),
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description ?? null,
      })),
    },
    choices: options.map((option) => ({
      value: option.value,
      description: option.description ?? option.label,
    })),
  }).pipe(
    Effect.flatMap((outcome): Effect.Effect<FieldOutcome> => {
      if (outcome.type === "judgment")
        return Effect.succeed<FieldOutcome>(
          validateField(field, outcome.value)
            ? { type: "defer", reason: "error", choice: outcome.value, confidence: outcome.confidence }
            : { type: "value", value: outcome.value, confidence: outcome.confidence },
        )
      if (field.custom !== true) return Effect.succeed(modelDefer(outcome))
      return DecisionChoice.answerText(decision, {
        ...call,
        invocationKey: `${call.invocationKey}:custom`,
        instructions: `${fieldInstructions} No listed option was settled; give a custom answer only when the evidence clearly supports one.`,
        state: fieldState(form, field),
        maxLength: Math.min(field.maxLength ?? 8192, 8192),
      }).pipe(
        Effect.map((text): FieldOutcome =>
          text.type === "text" && !validateField(field, text.value)
            ? { type: "value", value: text.value, confidence: text.confidence }
            : modelDefer(outcome),
        ),
      )
    }),
  )
}

export function validateAnswer(form: Pick<Info, "fields">, answer: Answer) {
  const fields = new Map(form.fields.map((field) => [field.key, field] as const))
  for (const key of Object.keys(answer)) {
    if (!fields.has(key)) return `Unknown form field: ${key}`
  }
  for (const field of form.fields) {
    const value = answer[field.key]
    if (field.type === "external") {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`
      continue
    }
    const active = isActive(field, answer)
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`
      continue
    }
    if (!active) return `Form field is not active: ${field.key}`
    const invalid = validateField(field, value)
    if (invalid) return invalid
  }
}

type InputField = Exclude<Form.Field, Form.ExternalField>

export function isActive(field: InputField, answer: Answer) {
  if (!field.when) return true
  return field.when.every((when) => matches(when, answer[when.key]))
}

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: Form.When, value: Form.Value | undefined) {
  if (value === undefined) return false
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  return when.op === "eq" ? hit : !hit
}

// Create-time validation of `when` references: each condition must point at an earlier field,
// carry a value matching that field's type, and use a declared option when the field's options
// are closed. Rejecting these at creation surfaces authoring mistakes to the caller instead of
// silently never matching.
function validateFields(fields: ReadonlyArray<Form.Field>) {
  if (fields.length === 0) return "Form must have at least one field"
  const earlier = new Map<string, InputField>()
  const keys = new Set<string>()
  for (const field of fields) {
    if (keys.has(field.key)) return `Duplicate form field key: ${field.key}`
    keys.add(field.key)
    if (field.type === "external") continue
    for (const when of field.when ?? []) {
      const target = earlier.get(when.key)
      if (!target) return `Form field condition must reference an earlier field: ${field.key} -> ${when.key}`
      const invalid = validateWhen(when, target)
      if (invalid) return `${invalid}: ${field.key} -> ${when.key}`
    }
    earlier.set(field.key, field)
  }
}

function validateWhen(when: Form.When, target: InputField) {
  if (target.type === "boolean") {
    if (typeof when.value !== "boolean") return "Form field condition value must be a boolean"
    return
  }
  if (target.type === "number" || target.type === "integer") {
    if (typeof when.value !== "number") return "Form field condition value must be a number"
    return
  }
  // string and multiselect targets both compare against string values
  if (typeof when.value !== "string") return "Form field condition value must be a string"
  const closed = target.type === "multiselect" ? !target.custom : target.options !== undefined && !target.custom
  if (closed && !target.options?.some((option) => option.value === when.value)) {
    return "Form field condition value must be one of the field's options"
  }
}

export function validateField(field: InputField, value: Form.Value): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return `Expected string for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`
      } catch {
        return `Form field has invalid pattern: ${field.key}`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `Expected email for form field: ${field.key}`
    if (field.format === "uri" && !isUri(value)) return `Expected URI for form field: ${field.key}`
    if (field.format === "date" && !isDate(value)) return `Expected date for form field: ${field.key}`
    if (field.format === "date-time" && !isDateTime(value)) return `Expected date-time for form field: ${field.key}`
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) {
      return `Invalid option for form field: ${field.key}`
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`
    if (field.type === "integer" && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`
    if (field.minimum !== undefined && value < field.minimum) return `Form field is too small: ${field.key}`
    if (field.maximum !== undefined && value > field.maximum) return `Form field is too large: ${field.key}`
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `Expected boolean for form field: ${field.key}`
    return
  }
  if (field.type === "multiselect") {
    if (!isStringArray(value)) return `Expected string array for form field: ${field.key}`
    if (new Set(value).size !== value.length) return `Duplicate selections for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minItems !== undefined && value.length < field.minItems)
      return `Too few selections for form field: ${field.key}`
    if (field.maxItems !== undefined && value.length > field.maxItems)
      return `Too many selections for form field: ${field.key}`
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) {
      return `Invalid option for form field: ${field.key}`
    }
  }
}

function isStringArray(value: Form.Value): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function isUri(value: string) {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isDateTime(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}
