export * as Question from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { Database } from "./database/database"
import { Question } from "@ycoding-ai/schema/question"
import { Decision } from "./decision"
import { DecisionChoice } from "./decision-choice"
import { EventRuntime } from "./event"
import { SessionSchema } from "./session/schema"
import { SessionAutonomy } from "./session/autonomy"
import { SessionReviewFold } from "./session/review-fold"

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
    return "The user dismissed this question"
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
}

const RECOMMENDED = / \(Recommended\)$/

export function recommendedLabels(question: Info): string[] | undefined {
  const marked = question.options.map((option) => option.label).filter((label) => RECOMMENDED.test(label))
  if (marked.length === 0 || (question.multiple !== true && marked.length > 1)) return
  return marked
}

export interface AskInput {
  readonly sessionID: SessionSchema.ID
  readonly questions: ReadonlyArray<Info>
  readonly tool?: Tool
}

export interface ReplyInput {
  readonly requestID: ID
  readonly answers: ReadonlyArray<Answer>
}

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<Outcome, RejectedError | SessionReviewFold.FullError>
  readonly deferPending: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | InvalidAnswerError>
  readonly reject: (requestID: ID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Question") {}

interface Pending {
  readonly request: Request
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
    const settle = Semaphore.makeUnsafe(1)
    const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => settle.withPermit(Effect.uninterruptible(effect))

    yield* Effect.addFinalizer(() =>
      Effect.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
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
    ): Effect.Effect<AutoOutcome> =>
      Effect.gen(function* () {
        const answers: Answer[] = []
        let confidence: number | undefined
        for (const [index, question] of input.questions.entries()) {
          const labels = question.options.map((option) => option.label)
          if (new Set(labels).size !== labels.length)
            return { type: "unsettled", reason: "invalid-request" } as AutoOutcome
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
            if (outcome.type === "unsettled") return outcome as AutoOutcome
            answers.push([outcome.value])
            confidence = Math.min(confidence ?? 1, outcome.confidence)
            continue
          }
          if (question.multiple === true) {
            const outcome = yield* DecisionChoice.grade(decision, {
              ...call,
              instructions:
                "The user cannot answer right now. Grade every option independently for whether it should be selected for the stated question with the evidence given. Refuse when the evidence does not support grading; refusal asks the user instead.",
              state,
              choices,
            })
            if (outcome.type === "unsettled") return outcome as AutoOutcome
            const selected = outcome.grades.filter(
              (grade) => typeof grade.choice === "string" && grade.confidence >= DecisionChoice.ConfidenceThreshold,
            )
            if (selected.length === 0) return { type: "unsettled", reason: "low_confidence" } as AutoOutcome
            answers.push(selected.map((grade) => String(grade.choice)))
            confidence = Math.min(confidence ?? 1, ...selected.map((grade) => grade.confidence))
            continue
          }
          const outcome = yield* DecisionChoice.chooseDetailed(decision, {
            ...call,
            instructions:
              "The user cannot answer right now. Choose the option that best serves the stated question with the evidence given. Refuse when the evidence does not support a choice; refusal asks the user instead.",
            state,
            choices,
          })
          if (outcome.type === "judgment") {
            answers.push([outcome.value])
            confidence = Math.min(confidence ?? 1, outcome.confidence)
            continue
          }
          if (question.custom !== false) {
            const text = yield* DecisionChoice.answerText(decision, {
              ...call,
              invocationKey: `${requestID}:${index}:custom`,
              instructions:
                "The user cannot answer right now and no listed option was settled. Give a bounded custom free-text answer only when the evidence clearly supports one. Refuse otherwise; refusal asks the user instead.",
              state,
            })
            if (text.type === "text") {
              answers.push([text.value])
              confidence = Math.min(confidence ?? 1, text.confidence)
              continue
            }
          }
          return outcome as AutoOutcome
        }
        if (validateAnswers(input.questions, answers)) return { type: "unsettled", reason: "error" } as AutoOutcome
        return { type: "answered", answers, ...(confidence === undefined ? {} : { confidence }) } as AutoOutcome
      })

    const ask = Effect.fn("Question.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const snapshot = yield* autonomy
            .snapshot(input.sessionID, { inherited: true })
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(undefined)))
          const autoAnswer = snapshot ? SessionAutonomy.canAutoAnswer(snapshot.state) : false
          const asleep = yield* autonomy
            .isAsleep(input.sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
          const yolo = yield* DecisionChoice.yoloEnabled(autonomy, input.sessionID)
          const auto = autoAnswer || yolo
          if (asleep && !auto) {
            const item = yield* openReview(input, ID.ascending(), { reason: "disabled" })
            return { status: "deferred", itemID: item.itemID } as const
          }
          const id = ID.ascending()
          const deferred = yield* Deferred.make<Outcome, RejectedError>()
          const request: Request = { id, ...input }
          const entry: Pending = { request, deferred }
          pending.set(id, entry)
          const cancelPending = Effect.sync(() => {
            if (pending.get(id) === entry) pending.delete(id)
          })
          if (auto && snapshot) {
            const outcome = yield* restore(evaluateAuto(input, id, { autoAnswer, yolo })).pipe(
              Effect.onInterrupt(() => cancelPending),
            )
            if (outcome.type === "answered") {
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
                } as const
              if (unchanged) return yield* Deferred.await(deferred)
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
              const item = yield* openReview(input, id, outcome.type === "unsettled" ? outcome : { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as const
            }
          }
          return yield* Effect.suspend(() => pending.get(id) === entry ? events.publish(Event.Asked, request) : Effect.void).pipe(
            Effect.andThen(restore(Deferred.await(deferred))),
            Effect.ensuring(cancelPending),
          )
        }),
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

    const list = Effect.fn("Question.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    return Service.of({ ask, deferPending, reply, reject, list })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node],
})
