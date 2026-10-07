import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Result } from "effect"
import { OpenAIDecisions } from "../src/openai-decisions"
import { RequestExecutor } from "../src/route/executor"
import { it, testEffect } from "./lib/effect"
import { dynamicResponse } from "./lib/http"

const request = {
  model: "gpt-6-luna",
  input: "Route this request",
  questions: [{ type: "choice", name: "route", instructions: "Choose", choices: [{ value: true }] }],
} satisfies typeof OpenAIDecisions.Request.Type

testEffect(
  dynamicResponse((input) =>
    Effect.succeed(
      input.respond(
        JSON.stringify({
          model: "gpt-6-luna",
          answers: [
            {
              type: "choice",
              name: "route",
              choice: "true",
              confidence: 0.8,
              probabilities: [{ value: "true", probability: 1 }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
        }),
      ),
    ),
  ),
).effect(
  "rejects a string choice when only the boolean value was requested",
  Effect.gen(function* () {
    const result = yield* OpenAIDecisions.evaluate(request, { apiKey: "test-key" }).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
  }),
)

const usage = { input_tokens: 42, output_tokens: 0, total_tokens: 42 }
const questions = [
  { type: "predicate", name: "risk", instructions: "Is this risky?" },
  { type: "choice", name: "route", instructions: "Route", choices: [{ value: true }, { value: "true" }] },
  { type: "score", name: "severity", instructions: "Rate", levels: [{ label: "low" }, { label: "high" }] },
  { type: "predicate", instructions: "Evaluate sensitive content" },
] satisfies typeof OpenAIDecisions.Request.Type.questions
const answers = [
  { type: "predicate", name: "risk", probability: 0.7 },
  {
    type: "choice",
    name: "route",
    choice: true,
    confidence: 1.5,
    probabilities: [
      { value: true, probability: 0.8 },
      { value: "true", probability: 0.2 },
    ],
  },
  {
    type: "score",
    name: "severity",
    score: 0.3,
    confidence: -0.2,
    probabilities: [
      { value: 0, label: "low", probability: 0.7 },
      { value: 1, label: "high", probability: 0.3 },
    ],
  },
  { type: "refusal", name: null },
] satisfies typeof OpenAIDecisions.Response.Type.answers

testEffect(
  dynamicResponse((input) =>
    Effect.sync(() => {
      expect(input.request.method).toBe("POST")
      expect(input.request.url).toBe("https://api.openai.com/v1/decisions")
      expect(input.request.headers.authorization).toBe("Bearer test-key")
      expect(input.request.headers["content-type"]).toBe("application/json")
      expect(JSON.parse(input.text)).toEqual({ ...request, questions, safety_identifier: "opaque" })
      return input.respond(JSON.stringify({ model: request.model, answers, usage }))
    }),
  ),
).effect(
  "sends only native fields and preserves probability, confidence, refusal and absent cache usage",
  Effect.gen(function* () {
    const output = yield* OpenAIDecisions.evaluate(
      { ...request, questions, safety_identifier: "opaque" },
      { apiKey: "test-key" },
    )
    expect(output).toEqual({ model: request.model, answers, usage })
    expect(output.usage.input_tokens_details).toBeUndefined()
  }),
)

testEffect(
  dynamicResponse((input) =>
    Effect.sync(() => {
      expect(input.request.url).toBe("https://example.test/custom/decisions")
      expect(JSON.parse(input.text).input).toEqual([
        {
          role: "user",
          type: "message",
          content: [
            { type: "input_text", text: "Inspect" },
            { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "original" },
          ],
        },
      ])
      return input.respond(
        JSON.stringify({
          model: request.model,
          answers: [{ type: "refusal", name: "route" }],
          usage: {
            ...usage,
            input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      )
    }),
  ),
).effect(
  "accepts inline images and custom endpoint, retaining native cache details",
  Effect.gen(function* () {
    const output = yield* OpenAIDecisions.evaluate(
      {
        ...request,
        input: [
          {
            role: "user",
            type: "message",
            content: [
              { type: "input_text", text: "Inspect" },
              { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "original" },
            ],
          },
        ],
      },
      { apiKey: "test-key", baseURL: "https://example.test/custom/" },
    )
    expect(output.usage.input_tokens_details).toEqual({ cached_tokens: 4, cache_write_tokens: 2 })
    expect(output.answers).toEqual([{ type: "refusal", name: "route" }])
  }),
)

const invalidAnswers = [
  ["count", answers.slice(1)],
  [
    "type",
    [{ type: "refusal", name: "risk" }, { type: "predicate", name: "route", probability: 0.2 }, ...answers.slice(2)],
  ],
  ["name", [{ ...answers[0], name: "wrong" }, ...answers.slice(1)]],
  ["probability bounds", [{ ...answers[0], probability: 1.1 }, ...answers.slice(1)]],
  ["choice membership", [answers[0], { ...answers[1], choice: false }, ...answers.slice(2)]],
  [
    "choice distribution membership",
    [
      answers[0],
      {
        ...answers[1],
        probabilities: [
          { value: false, probability: 1 },
          { value: true, probability: 0 },
        ],
      },
      ...answers.slice(2),
    ],
  ],
  [
    "choice distribution duplicates",
    [
      answers[0],
      {
        ...answers[1],
        probabilities: [
          { value: true, probability: 0.5 },
          { value: true, probability: 0.5 },
        ],
      },
      ...answers.slice(2),
    ],
  ],
  ["choice distribution count", [answers[0], { ...answers[1], probabilities: [] }, ...answers.slice(2)]],
  [
    "distribution probability bounds",
    [
      answers[0],
      {
        ...answers[1],
        probabilities: [
          { value: true, probability: -0.1 },
          { value: "true", probability: 1.1 },
        ],
      },
      ...answers.slice(2),
    ],
  ],
  ["score bounds", [...answers.slice(0, 2), { ...answers[2], score: 2 }, answers[3]]],
  ["negative score", [...answers.slice(0, 2), { ...answers[2], score: -0.1 }, answers[3]]],
  ["non-finite confidence", [answers[0], { ...answers[1], confidence: Infinity }, ...answers.slice(2)]],
  [
    "score labels",
    [
      ...answers.slice(0, 2),
      {
        ...answers[2],
        probabilities: [
          { value: 0, label: "wrong", probability: 1 },
          { value: 1, label: "high", probability: 0 },
        ],
      },
      answers[3],
    ],
  ],
  [
    "score indices",
    [
      ...answers.slice(0, 2),
      {
        ...answers[2],
        probabilities: [
          { value: -1, label: "low", probability: 1 },
          { value: 1, label: "high", probability: 0 },
        ],
      },
      answers[3],
    ],
  ],
  ["refusal name", [...answers.slice(0, 3), { type: "refusal", name: "wrong" }]],
] as const

for (const [name, malformed] of invalidAnswers) {
  testEffect(
    dynamicResponse((input) =>
      Effect.succeed(input.respond(JSON.stringify({ model: request.model, answers: malformed, usage }))),
    ),
  ).effect(
    `rejects malformed answer ${name}`,
    Effect.gen(function* () {
      const result = yield* OpenAIDecisions.evaluate({ ...request, questions }, { apiKey: "test-key" }).pipe(
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
    }),
  )
}

for (const [name, body] of [
  ["invalid JSON", "{"],
  [
    "non-finite probability",
    '{"model":"gpt-6-luna","answers":[{"type":"predicate","name":null,"probability":1e999}],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}',
  ],
  ["missing usage", JSON.stringify({ model: request.model, answers })],
  ["negative token count", JSON.stringify({ model: request.model, answers, usage: { ...usage, input_tokens: -1 } })],
] as const) {
  testEffect(dynamicResponse((input) => Effect.succeed(input.respond(body)))).effect(
    `rejects ${name}`,
    Effect.gen(function* () {
      const result = yield* OpenAIDecisions.evaluate({ ...request, questions }, { apiKey: "test-key" }).pipe(
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
    }),
  )
}

for (const [name, options, reason] of [
  ["missing key", { apiKey: " " }, "Authentication"],
  ["header injection", { apiKey: "key\r\nInjected: value" }, "InvalidRequest"],
  ["invalid base URL", { apiKey: "test-key", baseURL: "not a URL" }, "InvalidRequest"],
  ["non-HTTP base URL", { apiKey: "test-key", baseURL: "file:///tmp" }, "InvalidRequest"],
] as const) {
  testEffect(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Transport must not be called") }),
    ),
  ).effect(
    `rejects options ${name} before transport`,
    Effect.gen(function* () {
      const result = yield* OpenAIDecisions.evaluate(request, options).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe(reason)
    }),
  )
}

testEffect(
  dynamicResponse((input) =>
    Effect.succeed(
      input.respond(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("response body failed"))
          },
        }),
      ),
    ),
  ),
).effect(
  "maps a response-body read failure to InvalidProviderOutput",
  Effect.gen(function* () {
    const result = yield* OpenAIDecisions.evaluate(request, { apiKey: "test-key" }).pipe(Effect.result)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidProviderOutput")
  }),
)

for (const [name, invalid] of [
  ["unsupported model", { ...request, model: "gpt-5" }],
  ["chat options", { ...request, temperature: 1 }],
  ["empty questions", { ...request, questions: [] }],
  ["duplicate names", { ...request, questions: [questions[0], questions[0]] }],
  ["empty choices", { ...request, questions: [{ ...questions[1], choices: [] }] }],
  ["duplicate choices", { ...request, questions: [{ ...questions[1], choices: [{ value: true }, { value: true }] }] }],
  ["empty levels", { ...request, questions: [{ ...questions[2], levels: [] }] }],
  ["non-user role", { ...request, input: [{ role: "system", content: "Do this" }] }],
  [
    "external image",
    {
      ...request,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/image.png" }] }],
    },
  ],
  [
    "invalid base64",
    {
      ...request,
      input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,not-base64" }] }],
    },
  ],
  [
    "too many images",
    {
      ...request,
      input: [
        {
          role: "user",
          content: Array.from({ length: 129 }, () => ({
            type: "input_image",
            image_url: "data:image/png;base64,YQ==",
          })),
        },
      ],
    },
  ],
  ["long safety identifier", { ...request, safety_identifier: "x".repeat(129) }],
] as const) {
  testEffect(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Transport must not be called") }),
    ),
  ).effect(
    `rejects request ${name} before transport`,
    Effect.gen(function* () {
      const result = yield* OpenAIDecisions.evaluate(Object.assign({ ...request }, invalid), {
        apiKey: "test-key",
      }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe("InvalidRequest")
    }),
  )
}

for (const [status, reason] of [
  [401, "Authentication"],
  [429, "RateLimit"],
  [500, "ProviderInternal"],
] as const) {
  testEffect(
    dynamicResponse((input) => Effect.succeed(input.respond('{"error":{"message":"failed"}}', { status }))),
  ).effect(
    `propagates executor HTTP ${status} classification`,
    Effect.gen(function* () {
      const result = yield* OpenAIDecisions.evaluate(request, { apiKey: "test-key" }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.reason._tag).toBe(reason)
    }),
  )
}

it.effect(
  "interrupts the executor without retrying or fabricating a result",
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const calls: string[] = []
    const fiber = yield* OpenAIDecisions.evaluate(request, { apiKey: "test-key" }).pipe(
      Effect.provideService(
        RequestExecutor.Service,
        RequestExecutor.Service.of({
          execute: (input) =>
            Effect.gen(function* () {
              calls.push(input.url)
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        }),
      ),
      Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    yield* Deferred.await(interrupted)
    expect(calls).toEqual(["https://api.openai.com/v1/decisions"])
  }),
)
