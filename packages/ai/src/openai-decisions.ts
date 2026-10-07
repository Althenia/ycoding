export * as OpenAIDecisions from "./openai-decisions"

import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { Endpoint } from "./route/endpoint"
import { RequestExecutor } from "./route/executor"
import { AuthenticationReason, InvalidProviderOutputReason, InvalidRequestReason, LLMError } from "./schema"

const Text = Schema.String.check(Schema.isMaxLength(1_048_576))
const Evidence = Schema.String.check(Schema.isMaxLength(10_485_760))
const Value = Schema.Union([Schema.String, Schema.Boolean])
const Finite = Schema.Number.check(Schema.makeFilter(Number.isFinite))
const Probability = Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Request = Schema.Struct({
  model: Schema.Literal("gpt-6-luna"),
  input: Schema.Union([
    Evidence,
    Schema.Array(
      Schema.Struct({
        role: Schema.Literal("user"),
        type: Schema.optional(Schema.Literal("message")),
        content: Schema.Union([
          Evidence,
          Schema.Array(
            Schema.Union([
              Schema.Struct({ type: Schema.Literal("input_text"), text: Evidence }),
              Schema.Struct({
                type: Schema.Literal("input_image"),
                image_url: Schema.String.check(
                  Schema.isMaxLength(1_073_741_824),
                  Schema.makeFilter(
                    (value) =>
                      /^data:image\/[a-zA-Z0-9.+-]+;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                        value,
                      ) && !value.endsWith(","),
                  ),
                ),
                detail: Schema.optional(Schema.NullOr(Schema.Literals(["low", "high", "auto", "original"]))),
              }),
            ]),
          ),
        ]),
      }),
    ),
  ]),
  questions: Schema.Array(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("predicate"), instructions: Text, name: Schema.optional(Text) }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        instructions: Text,
        name: Schema.optional(Text),
        choices: Schema.Array(Schema.Struct({ value: Value, description: Schema.optional(Text) })).check(
          Schema.isMinLength(1),
          Schema.makeFilter((choices) => new Set(choices.map((choice) => choice.value)).size === choices.length),
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        instructions: Text,
        name: Schema.optional(Text),
        levels: Schema.Array(Schema.Struct({ label: Text, description: Schema.optional(Text) })).check(
          Schema.isMinLength(1),
        ),
      }),
    ]),
  ).check(
    Schema.isMinLength(1),
    Schema.makeFilter((questions) => {
      const names = questions.flatMap((question) => (question.name === undefined ? [] : [question.name]))
      return new Set(names).size === names.length
    }),
  ),
  safety_identifier: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
})

export const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("predicate"),
        name: Schema.NullOr(Schema.String),
        probability: Probability,
      }),
      Schema.Struct({
        type: Schema.Literal("choice"),
        name: Schema.NullOr(Schema.String),
        choice: Value,
        confidence: Finite,
        probabilities: Schema.Array(Schema.Struct({ value: Value, probability: Probability })),
      }),
      Schema.Struct({
        type: Schema.Literal("score"),
        name: Schema.NullOr(Schema.String),
        score: Finite,
        confidence: Finite,
        probabilities: Schema.Array(
          Schema.Struct({ value: Schema.Int, label: Schema.String, probability: Probability }),
        ),
      }),
      Schema.Struct({ type: Schema.Literal("refusal"), name: Schema.NullOr(Schema.String) }),
    ]),
  ),
  usage: Schema.Struct({
    input_tokens: Tokens,
    output_tokens: Tokens,
    total_tokens: Tokens,
    input_tokens_details: Schema.optional(
      Schema.Struct({
        cached_tokens: Schema.optional(Tokens),
        cache_write_tokens: Schema.optional(Tokens),
      }),
    ),
    output_tokens_details: Schema.optional(Schema.Struct({ reasoning_tokens: Schema.optional(Tokens) })),
  }),
})

const invalidRequest = (message: string) =>
  new LLMError({
    module: "OpenAIDecisions",
    method: "evaluate",
    reason: new InvalidRequestReason({ message }),
  })
const invalidOutput = (message: string) =>
  new LLMError({
    module: "OpenAIDecisions",
    method: "evaluate",
    reason: new InvalidProviderOutputReason({ message, route: "openai-decisions" }),
  })

export const evaluate = Effect.fn("OpenAIDecisions.evaluate")(function* (
  request: typeof Request.Type,
  options: { apiKey: string; baseURL?: string },
) {
  const input = yield* Schema.decodeUnknownEffect(Request)(request, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => invalidRequest("Invalid OpenAI Decisions request")),
  )
  if (
    typeof input.input !== "string" &&
    input.input.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "input_image"),
    ).length > 128
  )
    return yield* invalidRequest("OpenAI Decisions supports at most 128 images")
  if (!options.apiKey.trim())
    return yield* new LLMError({
      module: "OpenAIDecisions",
      method: "evaluate",
      reason: new AuthenticationReason({ message: "OpenAI Decisions requires an API key", kind: "missing" }),
    })
  if (/[\r\n]/.test(options.apiKey)) return yield* invalidRequest("Invalid OpenAI Decisions API key")
  const endpoint = Endpoint.path("/decisions", { baseURL: options.baseURL ?? "https://api.openai.com/v1" })
  const url = `${endpoint.baseURL?.replace(/\/+$/, "")}${String(endpoint.path)}`
  if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol))
    return yield* invalidRequest("OpenAI Decisions requires an HTTP(S) base URL")
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Request))(input).pipe(
    Effect.mapError(() => invalidRequest("Could not encode OpenAI Decisions request")),
  )
  const executor = yield* RequestExecutor.Service
  const response = yield* executor.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${options.apiKey}`),
      HttpClientRequest.bodyText(body, "application/json"),
    ),
  )
  const text = yield* response.text.pipe(
    Effect.mapError(() => invalidOutput("Could not read OpenAI Decisions response")),
  )
  const output = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Response))(text).pipe(
    Effect.mapError(() => invalidOutput("Invalid OpenAI Decisions response")),
  )
  if (output.answers.length !== input.questions.length)
    return yield* invalidOutput("OpenAI Decisions answer count does not match the questions")
  const mismatch = output.answers.findIndex((answer, index) => !matchesQuestion(answer, input.questions[index]))
  if (mismatch !== -1) return yield* invalidOutput(`OpenAI Decisions answer ${mismatch} does not match its question`)
  return output
})

function matchesQuestion(
  answer: (typeof Response.Type.answers)[number],
  question: (typeof Request.Type.questions)[number],
) {
  if (answer.name !== (question.name ?? null)) return false
  if (answer.type === "refusal") return true
  if (answer.type !== question.type) return false
  if (answer.type === "predicate") return true
  if (answer.type === "choice" && question.type === "choice") {
    return (
      question.choices.some((choice) => choice.value === answer.choice) &&
      answer.probabilities.length === question.choices.length &&
      new Set(answer.probabilities.map((item) => item.value)).size === question.choices.length &&
      answer.probabilities.every((item) => question.choices.some((choice) => choice.value === item.value))
    )
  }
  if (answer.type === "score" && question.type === "score") {
    return (
      answer.score >= 0 &&
      answer.score <= question.levels.length - 1 &&
      answer.probabilities.length === question.levels.length &&
      new Set(answer.probabilities.map((item) => item.value)).size === question.levels.length &&
      answer.probabilities.every((item) => question.levels[item.value]?.label === item.label)
    )
  }
  return false
}
