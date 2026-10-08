export * as TypeSafeDecisions from "./typesafe-decisions"

import { Effect, Schema } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "./route/auth"
import { Endpoint } from "./route/endpoint"
import { RequestExecutor } from "./route/executor"
import { InvalidProviderOutputReason, InvalidRequestReason, LLMError } from "./schema"

const Content = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json), Schema.Array(Schema.Json)])
const Model = Schema.String.check(Schema.isMinLength(1))
const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Distribution = Schema.Record(Schema.String, Probability)

export const Question = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("noul"),
    instructions: Content,
    criteria: Schema.optional(Schema.Struct({ true: Schema.optional(Content), false: Schema.optional(Content) })),
  }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: Content,
    criteria: Schema.Record(Schema.String, Schema.NullOr(Content)).check(
      Schema.makeFilter((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 255),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: Content,
    criteria: Schema.Array(Content).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  }),
])

export const Request = Schema.Struct({
  state: Content,
  model: Model,
  questions: Schema.Record(Schema.String, Question).check(
    Schema.makeFilter((questions) => Object.keys(questions).length > 0, { expected: "at least one question" }),
  ),
})

export const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Distribution,
    confidence: Probability,
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    legend: Schema.Record(Schema.String, Schema.String),
    probabilities: Distribution,
    confidence: Probability,
  }),
])

export const Response = Schema.Struct({
  model: Model,
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.Struct({
    input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})

const invalidOutput = (message: string) =>
  new LLMError({
    module: "TypeSafeDecisions",
    method: "evaluate",
    reason: new InvalidProviderOutputReason({ message, route: "typesafe-decisions" }),
  })

export const evaluate = Effect.fn("TypeSafeDecisions.evaluate")(function* (
  request: typeof Request.Type,
  options: { apiKey: string; baseURL?: string },
) {
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(Request))(request).pipe(
    Effect.mapError(
      () =>
        new LLMError({
          module: "TypeSafeDecisions",
          method: "evaluate",
          reason: new InvalidRequestReason({ message: "Invalid TypeSafe Decisions request" }),
        }),
    ),
  )
  const endpoint = {
    baseURL: options.baseURL ?? "https://api.typesafe.ai/v1",
    path: "/systemone",
  } satisfies Endpoint.Definition<typeof Request.Type>
  const url = `${endpoint.baseURL.replace(/\/+$/, "")}${endpoint.path}`
  const headers = yield* Auth.toEffect(Auth.bearer(options.apiKey))({
    request: {},
    method: "POST",
    url,
    body: text,
    headers: Headers.empty,
  })
  const executor = yield* RequestExecutor.Service
  const response = yield* executor.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyText(text, "application/json"),
    ),
  )
  const payload = yield* response.json.pipe(
    Effect.mapError(() => invalidOutput("Failed to read TypeSafe Decisions response")),
  )
  const decoded = yield* Schema.decodeUnknownEffect(Response)(payload).pipe(
    Effect.mapError(() => invalidOutput("Invalid TypeSafe Decisions response")),
  )
  if (!sameKeys(Object.keys(request.questions), decoded.answers))
    return yield* invalidOutput("TypeSafe Decisions answer IDs do not match question IDs")
  yield* Effect.forEach(Object.entries(request.questions), ([id, question]) =>
    Effect.gen(function* () {
      const answer = decoded.answers[id]
      if (!answer || answer.type !== question.type)
        return yield* invalidOutput("TypeSafe Decisions answer type does not match question type")
      if (question.type === "choice" && answer.type === "choice") {
        if (!validDistribution(Object.keys(question.criteria), answer.probabilities))
          return yield* invalidOutput("TypeSafe Decisions choice distribution is invalid")
        if (
          !Object.hasOwn(question.criteria, answer.choice) ||
          Object.values(answer.probabilities).some((probability) => probability > answer.probabilities[answer.choice])
        )
          return yield* invalidOutput("TypeSafe Decisions returned an invalid choice")
      }
      if (question.type === "score" && answer.type === "score") {
        const levels = question.criteria.map((_, index) => String(index))
        if (!validDistribution(levels, answer.probabilities) || !sameKeys(levels, answer.legend))
          return yield* invalidOutput("TypeSafe Decisions score levels are invalid")
        if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1)
          return yield* invalidOutput("TypeSafe Decisions score is outside its rubric")
      }
      return yield* Effect.void
    }),
  )
  return decoded
})

const sameKeys = (keys: ReadonlyArray<string>, record: Readonly<Record<string, unknown>>) =>
  keys.length === Object.keys(record).length && keys.every((key) => Object.hasOwn(record, key))

const validDistribution = (keys: ReadonlyArray<string>, probabilities: Readonly<Record<string, number>>) =>
  sameKeys(keys, probabilities) &&
  Object.values(probabilities).every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
  Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) <= 1e-6
