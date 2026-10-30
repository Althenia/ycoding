export * as Question from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { Database } from "./database/database"
import { Question } from "@ycoding-ai/schema/question"
import { Form } from "@ycoding-ai/schema/form"
import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Decision } from "./decision"
import { DecisionChoice } from "./decision-choice"
import { EventRuntime } from "./event"
import { SessionSchema } from "./session/schema"
import { SessionAutonomy } from "./session/autonomy"
import { SessionReviewFold } from "./session/review-fold"
import { Hash } from "./util/hash"
import { SessionEvent } from "./session/event"

export const ID = Question.ID
export type ID = typeof ID.Type

export const Option = Question.Option
export type Option = typeof Option.Type

export const Info = Question.Info
export type Info = typeof Info.Type

export const Prompt = Question.Prompt
export type Prompt = typeof Prompt.Type

export const Tool = Question.Tool
export type Tool = typeof Tool.Type

export const Request = Question.Request
export type Request = typeof Request.Type

export const Answer = Question.Answer
export type Answer = typeof Answer.Type

export const Reply = Question.Reply
export type Reply = typeof Reply.Type

export const Event = Question.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("Question.RejectedError", {}) {
  override get message() {
    return "This question was dismissed or superseded without an answer"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: ID,
}) {}

export class InvalidAnswerError extends Schema.TaggedErrorClass<InvalidAnswerError>()("Question.InvalidAnswerError", {
  requestID: ID,
  message: Schema.String,
}) {}

export type Outcome =
  | {
      readonly status: "answered"
      readonly answers: ReadonlyArray<Answer>
      readonly automatic?: true
      readonly via?: "auto-answer" | "yolo"
      readonly confidence?: number
      readonly assessment?: Form.Assessment
      readonly source?: Form.ReplySource
    }
  | { readonly status: "timed_out"; readonly seconds: number }
  | { readonly status: "deferred"; readonly itemID: SessionReviewFold.ID }

export function validateAnswers(
  questions: ReadonlyArray<Info>,
  answers: ReadonlyArray<Answer>,
): string | undefined {
  if (answers.length !== questions.length) return "Question answers do not cover every question"
  for (const [index, question] of questions.entries()) {
    const answer = answers[index] ?? []
    const labels = question.options.map((option) => option.label)
    if (new Set(labels).size !== labels.length) return `Duplicate option label in question: ${question.header}`
    if (new Set(answer).size !== answer.length) return `Duplicate answer for question: ${question.header}`
    if (question.multiple !== true && answer.length > 1) return `Multiple answers for a single-choice question: ${question.header}`
    for (const entry of answer) {
      if (entry.trim().length === 0) return `Empty answer for question: ${question.header}`
      if (labels.includes(entry)) continue
      if (question.custom === false) return `Answer is not one of the options for question: ${question.header}`
    }
  }
  return undefined
}

const RECOMMENDED = / \(Recommended\)$/

export function recommendedLabels(question: Info): string[] | undefined {
  const marked = question.options.map((option) => option.label).filter((label) => RECOMMENDED.test(label))
  if (marked.length !== 1) return
  return marked
}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export function fingerprint(request: Pick<Request, "sessionID" | "questions">) {
  return Hash.json({ sessionID: request.sessionID, questions: request.questions })
}

export interface DelegatedReplyInput {
  readonly explicitDecision?: true
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
  readonly fingerprint: string
  readonly source: Form.ExternalReplySource
  readonly validate: (request: Request) => Effect.Effect<boolean>
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface ReconsiderInput {
  readonly requestID: ID
  readonly fingerprint: string
  readonly actor: "coordinator"
  readonly source: { readonly coordinatorSessionID: string; readonly groupID?: string; readonly rationale: string }
  readonly validate: (request: Request) => Effect.Effect<boolean>
}

export interface ReconsiderResult {
  readonly outcome: "allowed" | "escalated" | "stale"
  readonly requestID: ID
  readonly fingerprint: string
  readonly settled: boolean
  readonly via?: "auto-answer" | "yolo"
  readonly confidence?: number
  readonly reason?: string
}

export interface Interface {
  readonly rejectDelegated: (input: Omit<DelegatedReplyInput, "answers" | "source"> & { readonly source: Form.ClientReplySource }) => Effect.Effect<void, NotFoundError>
  readonly ask: (input: AskInput) => Effect.Effect<Outcome, RejectedError | SessionReviewFold.FullError>
  readonly deferPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | InvalidAnswerError>
  readonly replyDelegated: (input: DelegatedReplyInput) => Effect.Effect<void, NotFoundError | InvalidAnswerError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly reconsider: (input: ReconsiderInput) => Effect.Effect<ReconsiderResult>
  readonly cancelPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Question") {}

interface Pending {
  readonly request: Request
  readonly epoch: number
  readonly deferred: Deferred.Deferred<Outcome, RejectedError>
}

/**
 * Location-owned pending prompts. The Location layer map must materialize this
 * layer once per embedded Location so replies cannot settle another Location's
 * deferred request.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const autonomy = yield* SessionAutonomy.Service
    const decision = yield* Decision.Service
    const pending = new Map<ID, Pending>()
    const evaluating = new Set<ID>()
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
    const settle = Semaphore.makeUnsafe(1)
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => settle.withPermit(Effect.uninterruptible(effect))

    const end = (entry: Pending) =>
      exclusive(
        Effect.gen(function* () {
          if (pending.get(entry.request.id) !== entry) return
          yield* events
            .publish(Event.Rejected, { sessionID: entry.request.sessionID, requestID: entry.request.id })
            .pipe(Effect.ensuring(Effect.sync(() => pending.delete(entry.request.id))))
        }),
      )

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        Array.from(pending.values()),
        (item) => end(item).pipe(Effect.ensuring(Deferred.fail(item.deferred, new RejectedError()))),
        { discard: true },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const openReview = Effect.fnUntraced(function* (
      input: AskInput,
      requestID: ID,
      outcome: { readonly reason: "disabled" | "free_text" | "error" | "sleep_entry" | DecisionChoice.UnsettledReason; readonly choice?: string; readonly confidence?: number },
      conversion = false,
    ) {
      return yield* SessionReviewFold.open(database.db, events, {
        sessionID: input.sessionID,
        kind: "question",
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        origin: { requestID },
        payload: { type: "question", questions: [...input.questions] },
        limit: Config.latest(yield* config.entries(), "guardrails")?.max_pending_reviews ?? 16,
        conversion,
      })
    })

    const deferPending = Effect.fn("Question.deferPending")(function* (sessionID: SessionSchema.ID) {
      const entries = Array.from(pending.values()).filter((item) => item.request.sessionID === sessionID)
      yield* Effect.forEach(entries, (item) =>
        exclusive(Effect.gen(function* () {
          if (!pending.has(item.request.id)) return
          const review = yield* openReview(item.request, item.request.id, { reason: "sleep_entry" }, true).pipe(Effect.orDie)
          yield* events.publish(Event.Deferred, { sessionID, requestID: item.request.id, itemID: review.itemID })
          yield* Deferred.succeed(item.deferred, { status: "deferred", itemID: review.itemID })
          pending.delete(item.request.id)
        })), { discard: true })
    })

    type AutoOutcome =
      | { readonly type: "answered"; readonly answers: Answer[]; readonly confidence?: number }
      | {
          readonly type: "unsettled"
          readonly reason: "disabled" | "free_text" | "error" | DecisionChoice.UnsettledReason
          readonly choice?: string
          readonly confidence?: number
        }

    const evaluateAuto = (
      input: AskInput,
      requestID: ID,
      mode: { readonly autoAnswer: boolean; readonly yolo: boolean },
      assessments: Form.FieldAssessment[],
    ): Effect.Effect<AutoOutcome> =>
      Effect.gen(function* () {
        const answers: Answer[] = []
        let confidence: number | undefined
        let unsettled: Extract<AutoOutcome, { readonly type: "unsettled" }> | undefined
        for (const [index, question] of input.questions.entries()) {
          const labels = question.options.map((option) => option.label)
          if (new Set(labels).size !== labels.length) {
            const field = assessments.findIndex(field => field.key === `question_${index}`)
            if (field !== -1) assessments.splice(field, 1, { key: `question_${index}`, status: "unavailable", reason: "Option IDs are duplicated; dismiss and recreate this question." })
            unsettled ??= { type: "unsettled", reason: "invalid-request" }
            answers.push([])
            continue
          }
          if (mode.autoAnswer) {
            const recommended = recommendedLabels(question)
            if (recommended) {
              answers.push(recommended)
              continue
            }
          }
          if (!mode.yolo)
            return { type: "unsettled", reason: question.options.length === 0 ? "free_text" : "disabled" } as AutoOutcome
          const call = {
            sessionID: input.sessionID,
            name: `question_${index}`,
            purpose: "answer" as const,
            authority: "yolo" as const,
            invocationKey: `${requestID}:${index}`,
          }
          const state = {
            question: question.question,
            header: question.header,
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description ?? null,
            })),
          }
          const choices = question.options.map((option) => ({
            value: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          }))
          if (question.options.length === 0) {
            const outcome = yield* DecisionChoice.answerText(decision, {
              ...call,
              instructions:
                "The user cannot answer right now. Give the bounded free-text answer that best serves the stated question with the evidence given. Refuse when the evidence does not support an answer; refusal asks the user instead.",
              state,
            })
            if (outcome.type === "unsettled") {
              unsettled ??= outcome
              answers.push([])
              continue
            }
            answers.push([outcome.value])
            confidence = Math.min(confidence ?? 1, outcome.confidence)
            continue
          }
          const outcome = yield* DecisionChoice.recommend(decision, {
              ...call,
              instructions:
                "Answer the stated question from the supplied evidence. Refuse when the evidence does not support an answer; refusal asks the user instead.",
              state,
              choices,
              multiple: question.multiple === true,
          })
          const field = assessments.findIndex((field) => field.key === call.name)
          if (field !== -1) assessments.splice(field, 1, { key: call.name, ...outcome, reason: DecisionChoice.recommendationReason(outcome.reason) })
          if (outcome.recommendation === undefined) {
            unsettled ??= { type: "unsettled", reason: outcome.status === "assessed" ? "low_confidence" : Schema.is(DecisionFailure.Reason)(outcome.reason) ? outcome.reason : "error" }
            answers.push([])
            continue
          }
          answers.push(Array.from(outcome.recommendation))
          confidence = Math.min(confidence ?? 1, outcome.confidence ?? 1)
        }
        if (unsettled) return unsettled
        if (validateAnswers(input.questions, answers)) return { type: "unsettled", reason: "error" } as AutoOutcome
        return { type: "answered", answers, ...(confidence === undefined ? {} : { confidence }) } as AutoOutcome
      })

    const ask = Effect.fn("Question.ask")((input: AskInput) =>
      Effect.acquireUseRelease(
        Effect.sync(() => enter(input.sessionID)),
        (ticket) => Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const snapshot = yield* autonomy
            .snapshot(input.sessionID, { inherited: true })
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
          const mode = snapshot ? yield* DecisionChoice.decisionMode(autonomy, input.sessionID, "answers") : "manual"
          const autoAnswer = mode === "auto"
          const yolo = mode === "yolo"
          const asleep = yield* autonomy
            .isAsleep(input.sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
          const auto = autoAnswer || yolo
          if (asleep && !auto) {
            const item = yield* openReview(input, ID.ascending(), { reason: "disabled" })
            return { status: "deferred", itemID: item.itemID } as const
          }
          const id = ID.ascending()
          const deferred = yield* Deferred.make<Outcome, RejectedError>()
          if (ticket.superseded()) return yield* new RejectedError()
          const effective = snapshot ? yield* autonomy.effectiveDecisions(input.sessionID).pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined))) : undefined
          const assessments: Form.FieldAssessment[] = input.questions.flatMap((question, index) => question.options.length === 0 ? [] : [{
            key: `question_${index}`, status: yolo ? "pending" : "not_assessed",
            reason: yolo ? "Answers evaluator is assessing the options." : mode === "auto" ? "Auto uses only a unique Recommended option; no model assessment." : "Manual answers require your decision; no model assessment.",
          }])
          const assessment: Form.Assessment | undefined = assessments.length === 0 ? undefined : { mode, sourceSessionID: effective?.inherited.answers ?? input.sessionID, fields: assessments }
          const request: Request = { id, ...input, ...(assessment === undefined ? {} : { assessment }) }
          const entry: Pending = { request, epoch: ticket.epoch, deferred }
          pending.set(id, entry)
          const cancelPending = Effect.sync(() => {
            if (pending.get(id) === entry) pending.delete(id)
          })
          if (auto && snapshot) {
            evaluating.add(id)
            const outcome = yield* restore(
              evaluateAuto(input, id, { autoAnswer, yolo }, assessments).pipe(
                Effect.raceFirst(Deferred.await(deferred).pipe(Effect.as(undefined))),
              ),
            ).pipe(Effect.onInterrupt(() => cancelPending), Effect.ensuring(Effect.sync(() => void evaluating.delete(id))))
            if (outcome?.type === "answered") {
              const unchanged = yield* DecisionChoice.autonomyUnchanged(autonomy, input.sessionID, snapshot)
              const claimed = unchanged && (yield* exclusive(Effect.sync(() => {
                if (pending.get(id) !== entry) return false
                pending.delete(id)
                return true
              })))
              if (claimed)
                return {
                  status: "answered",
                  answers: outcome.answers,
                  automatic: true,
                  via: outcome.confidence === undefined ? "auto-answer" : "yolo",
                  ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                  ...(assessment === undefined || !yolo ? {} : { assessment }),
                } as const
              if (unchanged) return yield* Deferred.await(deferred)
              assessments.splice(0, assessments.length, ...assessments.map((field) => ({ ...field, status: "unavailable" as const, recommendation: undefined, reason: "Answers mode changed; assessment not applied." })))
            }
            if (pending.get(id) !== entry) return yield* restore(Deferred.await(deferred))
            const asleepNow = yield* autonomy
              .isAsleep(input.sessionID)
              .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
            const claimed = asleepNow && (yield* exclusive(Effect.sync(() => {
              if (pending.get(id) !== entry) return false
              pending.delete(id)
              return true
            })))
            if (claimed) {
              const item = yield* openReview(input, id, outcome?.type === "unsettled" ? outcome : { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as const
            }
          }
          return yield* Effect.suspend(() => pending.get(id) === entry ? events.publish(Event.Asked, request) : Effect.void).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.onInterrupt(() => end(entry)),
            Effect.ensuring(cancelPending),
          )
        }),
        ),
        (ticket) => Effect.sync(ticket.release),
      ),
    )

    const reply = Effect.fn("Question.reply")((input: ReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          const invalid = validateAnswers(existing.request.questions, input.answers)
          if (invalid) return yield* new InvalidAnswerError({ requestID: input.requestID, message: invalid })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            answers: input.answers.map((answer) => [...answer]),
          })
          yield* Deferred.succeed(existing.deferred, { status: "answered", answers: input.answers })
          pending.delete(input.requestID)
        }),
      ),
    )

    const replyDelegated = Effect.fn("Question.replyDelegated")((input: DelegatedReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing || fingerprint(existing.request) !== input.fingerprint || !(yield* input.validate(existing.request)))
            return yield* new NotFoundError({ requestID: input.requestID })
          const invalid = validateAnswers(existing.request.questions, input.answers)
          if (invalid) return yield* new InvalidAnswerError({ requestID: input.requestID, message: invalid })
          const committed = yield* events.publishBatch([{ definition: SessionEvent.DotsDecisionSettled, data: {
            sessionID: existing.request.sessionID,
            source: input.source,
            target: { kind: "question", requestID: existing.request.id, fingerprint: input.fingerprint },
          } }], { when: input.validate(existing.request) })
          if (committed.length === 0) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, { sessionID: existing.request.sessionID, requestID: existing.request.id, answers: input.answers.map((answer) => [...answer]) }).pipe(Effect.ensuring(Effect.gen(function* () {
            pending.delete(input.requestID)
            yield* Deferred.succeed(existing.deferred, { status: "answered", answers: input.answers, source: input.source })
          })))
        }),
      ),
    )

    const rejectDelegated: Interface["rejectDelegated"] = (input) => exclusive(Effect.gen(function* () {
      const existing = pending.get(input.requestID)
      if (!input.explicitDecision || !existing || fingerprint(existing.request) !== input.fingerprint || !(yield* input.validate(existing.request)))
        return yield* new NotFoundError({ requestID: input.requestID })
      const committed = yield* events.publishBatch([{ definition: SessionEvent.DotsDecisionSettled, data: {
        sessionID: existing.request.sessionID, source: input.source,
        target: { kind: "question", requestID: existing.request.id, fingerprint: input.fingerprint },
      } }], { when: input.validate(existing.request) })
      if (committed.length === 0) return yield* new NotFoundError({ requestID: input.requestID })
      return yield* events.publish(Event.Rejected, { sessionID: existing.request.sessionID, requestID: existing.request.id }).pipe(Effect.ensuring(Effect.gen(function* () {
        pending.delete(input.requestID)
        yield* Deferred.fail(existing.deferred, new RejectedError())
      })), Effect.asVoid)
    }))

    const reconsider = Effect.fn("Question.reconsider")((input: ReconsiderInput) =>
      Effect.acquireUseRelease(
        exclusive(
          Effect.sync((): { readonly entry?: Pending; readonly result?: ReconsiderResult } => {
            const entry = pending.get(input.requestID)
            const base = { requestID: input.requestID, fingerprint: input.fingerprint, settled: false }
            if (entry === undefined || fingerprint(entry.request) !== input.fingerprint) return { result: { ...base, outcome: "stale" } }
            if (evaluating.has(input.requestID) || reconsidering.has(input.requestID))
              return { result: { ...base, outcome: "escalated", reason: "native-assessment-in-progress" } }
            reconsidering.add(input.requestID)
            return { entry }
          }),
        ),
        (acquired) =>
          acquired.entry === undefined
            ? Effect.succeed(acquired.result!)
            : Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const entry = acquired.entry!
                  const sessionID = entry.request.sessionID
                  const base = { requestID: input.requestID, fingerprint: input.fingerprint }
                  const escalated = (reason: string): ReconsiderResult => ({ ...base, outcome: "escalated", settled: false, reason })
                  const stale: ReconsiderResult = { ...base, outcome: "stale", settled: false }
                  if (!(yield* input.validate(entry.request))) return escalated("delegation-invalid")
                  const snapshot = yield* autonomy
                    .snapshot(sessionID, { inherited: true })
                    .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
                  if (snapshot === undefined) return stale
                  const mode = yield* DecisionChoice.decisionMode(autonomy, sessionID, "answers")
                  if (mode === "manual") return escalated("explicit-decision:manual-answers")
                  const yolo = mode === "yolo"
                  const assessments: Form.FieldAssessment[] = entry.request.questions.flatMap((question, index) =>
                    question.options.length === 0
                      ? []
                      : [{
                          key: `question_${index}`,
                          status: yolo ? ("pending" as const) : ("not_assessed" as const),
                          reason: yolo ? "Answers evaluator is assessing the options." : "Auto uses only a unique Recommended option; no model assessment.",
                        }],
                  )
                  const outcome = yield* restore(
                    evaluateAuto({ sessionID, questions: entry.request.questions }, input.requestID, { autoAnswer: mode === "auto", yolo }, assessments),
                  )
                  if (outcome.type === "unsettled") return escalated(outcome.reason)
                  const effective = yield* autonomy
                    .effectiveDecisions(sessionID)
                    .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
                  return yield* exclusive(
                    Effect.gen(function* () {
                      if (pending.get(input.requestID) !== entry) return stale
                      if (!(yield* input.validate(entry.request))) return escalated("delegation-invalid")
                      if (!(yield* DecisionChoice.autonomyUnchanged(autonomy, sessionID, snapshot))) return escalated("stale-assessment")
                      if (validateAnswers(entry.request.questions, outcome.answers)) return escalated("invalid-answer")
                      const via = outcome.confidence === undefined ? ("auto-answer" as const) : ("yolo" as const)
                      const assessment: Form.Assessment | undefined =
                        assessments.length === 0 ? undefined : { mode, sourceSessionID: effective?.inherited.answers ?? sessionID, fields: assessments }
                      yield* events.publish(Event.Replied, {
                        sessionID,
                        requestID: input.requestID,
                        answers: outcome.answers.map((answer) => [...answer]),
                      })
                      yield* Deferred.succeed(entry.deferred, {
                        status: "answered",
                        answers: outcome.answers,
                        automatic: true,
                        via,
                        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                        ...(assessment === undefined || !yolo ? {} : { assessment }),
                        source: {
                          kind: "coordinator",
                          coordinatorSessionID: input.source.coordinatorSessionID,
                          ...(input.source.groupID === undefined ? {} : { groupID: input.source.groupID }),
                          via,
                          rationale: input.source.rationale,
                          ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                        },
                      })
                      pending.delete(input.requestID)
                      return {
                        ...base,
                        outcome: "allowed",
                        settled: true,
                        via,
                        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
                      } satisfies ReconsiderResult
                    }),
                  )
                }),
              ),
        (acquired) =>
          Effect.sync(() => {
            if (acquired.entry !== undefined) reconsidering.delete(input.requestID)
          }),
      ),
    )

    const reject = Effect.fn("Question.reject")((requestID: ID) =>
      exclusive(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) return yield* new NotFoundError({ requestID })
          yield* events.publish(Event.Rejected, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.fail(existing.deferred, new RejectedError())
          pending.delete(requestID)
        }),
      ),
    )

    const cancelPending = Effect.fn("Question.cancelPending")(function* (sessionID: SessionSchema.ID) {
      const state = asks.get(sessionID)
      if (state === undefined) return
      const advanced = ++state.epoch
      const obsolete = Array.from(pending.values()).filter(
        (item) => item.request.sessionID === sessionID && item.epoch < advanced,
      )
      yield* Effect.forEach(
        obsolete,
        (item) => reject(item.request.id).pipe(Effect.catchTag("Question.NotFoundError", () => Effect.void)),
        { discard: true },
      )
    })

    const list = Effect.fn("Question.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, deferPending, reply, replyDelegated, rejectDelegated, reject, reconsider, cancelPending, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node],
})
