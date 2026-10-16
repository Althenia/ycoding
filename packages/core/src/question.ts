export * as Question from "./question"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { ConfigQuestionTimeout } from "./config/question-timeout"
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

export type Outcome =
  | { readonly status: "answered"; readonly answers: ReadonlyArray<Answer> }
  | { readonly status: "timed_out"; readonly seconds: number }
  | { readonly status: "deferred"; readonly itemID: SessionReviewFold.ID }

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
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
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
      outcome: { readonly reason: "disabled" | "free_text" | "refused" | "low_confidence" | "error" | "timeout" | "sleep_entry"; readonly choice?: string; readonly confidence?: number },
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

    const ask = Effect.fn("Question.ask")((input: AskInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const autoAnswer = Config.latest(yield* config.entries(), "auto_answer") === true
          const asleep = yield* autonomy
            .isAsleep(input.sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
          if (asleep) {
            if (!autoAnswer) {
              const item = yield* openReview(input, ID.ascending(), { reason: "disabled" })
              return { status: "deferred", itemID: item.itemID } as const
            }
            const answers: Answer[] = []
            for (const [index, question] of input.questions.entries()) {
              if (question.options.length === 0) {
                const item = yield* openReview(input, ID.ascending(), { reason: "free_text" })
                return { status: "deferred", itemID: item.itemID } as const
              }
              const outcome = yield* restore(DecisionChoice.chooseDetailed(decision, {
                sessionID: input.sessionID,
                name: `question_${index}`,
                instructions:
                  "The user is asleep and cannot answer. Choose the option that best serves the stated question with the evidence given. Refuse when the evidence does not support a choice; refusal defers the question to the user's review box.",
                state: {
                  question: question.question,
                  header: question.header,
                  options: question.options.map((option) => ({
                    label: option.label,
                    description: option.description ?? null,
                  })),
                },
                choices: question.options.map((option) => ({
                  value: option.label,
                  ...(option.description === undefined ? {} : { description: option.description }),
                })),
              }))
              if (outcome.type === "unsettled") {
                const item = yield* openReview(input, ID.ascending(), outcome)
                return { status: "deferred", itemID: item.itemID } as const
              }
              answers.push([outcome.value])
            }
            return { status: "answered", answers } as const
          }
          const autonomous = yield* autonomy
            .canAutoAnswer(input.sessionID)
            .pipe(Effect.catchTag("SessionAutonomy.NotFound", () => Effect.succeed(false)))
          if (autoAnswer && autonomous) {
            return {
              status: "answered",
              answers: input.questions.map((question) => {
                const selected = question.options[0]?.label
                return selected ? [selected] : [SessionAutonomy.AutomaticAnswer]
              }),
            } as const
          }
          const id = ID.ascending()
          const deferred = yield* Deferred.make<Outcome, RejectedError>()
          const request: Request = { id, ...input }
          pending.set(id, { request, deferred })
          const configured = Config.latest(yield* config.entries(), "question_timeout_seconds")
          const timeout = ConfigQuestionTimeout.duration(configured)
          const wait = Deferred.await(deferred)
          const expired = timeout
            ? Effect.sleep(timeout).pipe(
                Effect.andThen(expire(id, ConfigQuestionTimeout.seconds(configured))),
                Effect.andThen(wait),
              )
            : undefined
          return yield* events.publish(Event.Asked, request).pipe(
            Effect.andThen(restore(expired ? Effect.raceFirst(wait, expired) : wait)),
            Effect.ensuring(
              Effect.sync(() => {
                pending.delete(id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = Effect.fn("Question.reply")((input: ReplyInput) =>
      exclusive(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
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

    const expire = Effect.fn("Question.expire")((requestID: ID, seconds: number) =>
      exclusive(
        Effect.gen(function* () {
          const existing = pending.get(requestID)
          if (!existing) return
          yield* events.publish(Event.TimedOut, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
          })
          yield* Deferred.succeed(existing.deferred, { status: "timed_out", seconds })
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
