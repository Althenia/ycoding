import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema } from "effect"
import { RequestExecutor } from "../src/route/executor"
import { TypeSafeDecisions } from "../src/typesafe-decisions"
import { testEffect } from "./lib/effect"
import { dynamicResponse } from "./lib/http"

const it = testEffect(Layer.empty)

const request = {
  state: { messages: [{ role: "user", content: "Review a payment" }], amount: 12 },
  model: "jev-1.13.0",
  questions: {
    "caller/risk": { type: "noul", instructions: { question: "Risk?" }, criteria: { true: ["Unsafe"], false: "Safe" } },
    routing: { type: "choice", instructions: ["Pick"], criteria: { careful: { budget: 2 }, fast: null } },
    continuation: { type: "score", instructions: "Progress?", criteria: ["Blocked", "Complete"] },
  },
} satisfies typeof TypeSafeDecisions.Request.Type

const response = {
  model: "jev-1.13.0",
  answers: {
    "caller/risk": { type: "noul", noul: 0.2 },
    routing: { type: "choice", choice: "careful", probabilities: { careful: 0.8, fast: 0.2 }, confidence: 0.6 },
    continuation: {
      type: "score",
      score: 0.7,
      legend: { "0": "Blocked", "1": "Complete" },
      probabilities: { "0": 0.3, "1": 0.7 },
      confidence: 0.4,
    },
  },
  usage: { input_tokens: 123, output_tokens: 45 },
} satisfies typeof TypeSafeDecisions.Response.Type

describe("TypeSafe Decisions", () => {
  it.effect("sends native JSON and preserves all native answers and usage", () =>
    Effect.gen(function* () {
      const actual = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" })
      expect(actual).toEqual(response)
    }).pipe(
      Effect.provide(
        dynamicResponse((input) => {
          expect(input.request.url).toBe("https://api.typesafe.ai/v1/systemone")
          expect(input.request.method).toBe("POST")
          expect(input.request.headers.authorization).toBe("Bearer test")
          expect(input.request.headers["content-type"]).toBe("application/json")
          expect(JSON.parse(input.text)).toEqual(request)
          return Effect.succeed(input.respond(JSON.stringify(response)))
        }),
      ),
    ),
  )

  it.effect("rejects answers for different question IDs", () =>
    Effect.gen(function* () {
      const result = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
    }).pipe(
      Effect.provide(
        dynamicResponse((input) => Effect.succeed(input.respond(JSON.stringify({ ...response, answers: {} })))),
      ),
    ),
  )

  const malformed = [
    { ...response, answers: { ...response.answers, extra: { type: "noul", noul: 0.5 } } },
    {
      ...response,
      answers: {
        ...response.answers,
        "caller/risk": { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 },
      },
    },
    { ...response, answers: { ...response.answers, "caller/risk": { type: "noul", noul: 1.1 } } },
    ...[
      { choice: "unknown" },
      { choice: "fast" },
      { probabilities: { careful: 1 } },
      { probabilities: { careful: 0.8, fast: 0.2, extra: 0 } },
      { probabilities: { careful: -0.1, fast: 1.1 } },
      { probabilities: { careful: Number.NaN, fast: 1 } },
      { probabilities: { careful: 0.8, fast: 0.3 } },
      { confidence: 1.1 },
    ].map((routing) => ({
      ...response,
      answers: { ...response.answers, routing: { ...response.answers.routing, ...routing } },
    })),
    ...[
      { score: -0.1 },
      { score: 1.1 },
      { probabilities: { "1": 0.3, "2": 0.7 } },
      { probabilities: { "0": 0.3, "1": 0.8 } },
      { legend: { "0": "Blocked" } },
      { legend: { "00": "Blocked", "1": "Complete" } },
    ].map((continuation) => ({
      ...response,
      answers: { ...response.answers, continuation: { ...response.answers.continuation, ...continuation } },
    })),
    { ...response, usage: { input_tokens: 1.5, output_tokens: 2 } },
    { ...response, usage: { input_tokens: 1, output_tokens: -2 } },
    { ...response, usage: undefined },
    { ...response, model: "" },
  ]
  malformed.forEach((payload, index) => {
    it.effect(`rejects malformed native response ${index}`, () =>
      Effect.gen(function* () {
        const result = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" }).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
      }).pipe(Effect.provide(dynamicResponse((input) => Effect.succeed(input.respond(JSON.stringify(payload)))))),
    )
  })

  const invalidRequests = [
    { ...request, model: "" },
    { ...request, questions: { test: { type: "score", instructions: "Rate", criteria: ["One"] } } },
    {
      ...request,
      questions: { test: { type: "score", instructions: "Rate", criteria: Array.from({ length: 11 }, () => "Level") } },
    },
    { ...request, questions: { test: { type: "choice", instructions: "Choose", criteria: {} } } },
    {
      ...request,
      questions: {
        test: {
          type: "choice",
          instructions: "Choose",
          criteria: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [String(index), null])),
        },
      },
    },
  ] satisfies Array<typeof TypeSafeDecisions.Request.Type>
  invalidRequests.forEach((input, index) => {
    it.effect(`rejects invalid input before transport ${index}`, () =>
      Effect.gen(function* () {
        const result = yield* TypeSafeDecisions.evaluate(input, { apiKey: "test" }).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidRequest")
      }).pipe(Effect.provide(dynamicResponse(() => Effect.die("Invalid input reached transport")))),
    )
  })

  it.effect("accepts future models, array state and rounded distributions at a custom endpoint", () =>
    Effect.gen(function* () {
      const input = { ...request, state: ["text", { nested: true }], model: "future-model" }
      const payload = {
        ...response,
        answers: {
          ...response.answers,
          routing: { ...response.answers.routing, probabilities: { careful: 0.8000001, fast: 0.2 } },
        },
      }
      expect(
        yield* TypeSafeDecisions.evaluate(input, { apiKey: "test", baseURL: "https://decisions.test/custom/" }),
      ).toEqual(payload)
    }).pipe(
      Effect.provide(
        dynamicResponse((input) => {
          expect(input.request.url).toBe("https://decisions.test/custom/systemone")
          expect(JSON.parse(input.text).state).toEqual(["text", { nested: true }])
          return Effect.succeed(
            input.respond(
              JSON.stringify({
                ...response,
                answers: {
                  ...response.answers,
                  routing: { ...response.answers.routing, probabilities: { careful: 0.8000001, fast: 0.2 } },
                },
              }),
            ),
          )
        }),
      ),
    ),
  )

  it.effect("rejects non-JSON output", () =>
    Effect.gen(function* () {
      const result = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
    }).pipe(Effect.provide(dynamicResponse((input) => Effect.succeed(input.respond("not json"))))),
  )
  ;[429, 529].forEach((status) => {
    it.effect(`propagates HTTP ${status} without retry`, () =>
      Effect.gen(function* () {
        const calls = yield* Deferred.make<void>()
        const result = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" }).pipe(
          Effect.result,
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                expect(yield* Deferred.succeed(calls, undefined)).toBe(true)
                return input.respond("overloaded", { status })
              }),
            ),
          ),
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.module).toBe("RequestExecutor")
          expect("http" in result.failure.reason && result.failure.reason.http?.response?.status).toBe(status)
        }
        yield* Deferred.await(calls)
      }),
    )
  })

  it.effect("propagates interruption into executor work", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<void>()
      const fiber = yield* TypeSafeDecisions.evaluate(request, { apiKey: "test" }).pipe(
        Effect.provide(
          Layer.succeed(RequestExecutor.Service, {
            execute: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              ),
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Deferred.await(cancelled)
    }),
  )

  it.effect("exports structural schemas and rejects non-text JSON inputs", () =>
    Effect.sync(() => {
      expect(TypeSafeDecisions.Request.fields.questions).toBeDefined()
      expect(TypeSafeDecisions.Response.fields.answers).toBeDefined()
      expect(Schema.is(TypeSafeDecisions.Request)({ ...request, state: 42 })).toBe(false)
      expect(Schema.is(TypeSafeDecisions.Request)({ ...request, state: { file: new Uint8Array([1]) } })).toBe(false)
      expect(Schema.is(TypeSafeDecisions.Request)({ ...request, state: "plain text" })).toBe(true)
    }),
  )
})
