import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMError, ToolDefinition } from "../src"
import * as AnthropicMessages from "../src/protocols/anthropic-messages"
import * as Gemini from "../src/protocols/gemini"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { deltaChunk, usageChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

const providerSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["answer", "refusal"] },
    confidence: { type: "number", minimum: 0, maximum: 1, multipleOf: 0.01 },
    evidence: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
    grades: { type: "array", minItems: 2, maxItems: 3, items: { $ref: "#/$defs/grade" } },
    picks: { type: "array", minItems: 1, items: { type: "string", const: "option_a" } },
    maximum: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 },
  },
  required: ["kind", "confidence", "evidence", "grades", "picks", "maximum"],
  additionalProperties: false,
  $defs: {
    grade: {
      type: "object",
      properties: { minimum: { type: "string", maxLength: 4 } },
      required: ["minimum"],
      additionalProperties: false,
    },
  },
}

const loweredSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["answer", "refusal"] },
    confidence: { type: "number" },
    evidence: { type: "string", pattern: "\\S" },
    grades: { type: "array", items: { $ref: "#/$defs/grade" } },
    picks: { type: "array", minItems: 1, items: { type: "string", const: "option_a" } },
    maximum: { type: "integer" },
  },
  required: ["kind", "confidence", "evidence", "grades", "picks", "maximum"],
  additionalProperties: false,
  $defs: {
    grade: {
      type: "object",
      properties: { minimum: { type: "string" } },
      required: ["minimum"],
      additionalProperties: false,
    },
  },
}

const responseFormat = { type: "json" as const, schema: providerSchema }

const capture = (respond: string) => {
  const bodies: unknown[] = []
  const layer = dynamicResponse((input) =>
    Effect.sync(() => {
      bodies.push(decodeJson(input.text))
      return input.respond(respond, { headers: { "content-type": "text/event-stream" } })
    }),
  )
  return { bodies, layer }
}

const responsesModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const chatModel = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4o-mini" })

const anthropicModel = AnthropicMessages.route
  .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
  .model({ id: "claude-opus-5" })

const geminiModel = Gemini.route
  .with({ endpoint: { baseURL: "https://generativelanguage.test/v1beta/" }, auth: Auth.header("x-goog-api-key", "test") })
  .model({ id: "gemini-2.5-flash" })

const responsesCompleted = (output: unknown[]) => ({
  type: "response.completed",
  response: { id: "resp_1", usage: { input_tokens: 7, output_tokens: 3 }, output },
})

describe("provider-enforced structured output", () => {
  it.effect("sends strict OpenAI Responses text.format merged with verbosity", () =>
    Effect.gen(function* () {
      const wire = capture(
        sseEvents(
          { type: "response.output_text.delta", item_id: "msg_1", delta: '{"kind":"answer"}' },
          responsesCompleted([]),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: responsesModel,
          prompt: "Judge.",
          responseFormat,
          providerOptions: { openai: { textVerbosity: "low" } },
        }),
      ).pipe(Effect.provide(wire.layer))

      expect(wire.bodies).toHaveLength(1)
      expect(wire.bodies[0]).toMatchObject({
        text: {
          verbosity: "low",
          format: { type: "json_schema", name: "response", schema: loweredSchema, strict: true },
        },
      })
      expect(response.text).toBe('{"kind":"answer"}')
      expect(response.finishReason).toBe("stop")
    }),
  )

  it.effect("surfaces an OpenAI Responses refusal as content-filter with usage", () =>
    Effect.gen(function* () {
      const wire = capture(
        sseEvents(
          { type: "response.refusal.delta", item_id: "msg_1", delta: "I can't help." },
          { type: "response.refusal.done", item_id: "msg_1", refusal: "I can't help." },
          responsesCompleted([
            { type: "message", id: "msg_1", content: [{ type: "refusal", refusal: "I can't help." }] },
          ]),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({ model: responsesModel, prompt: "Judge.", responseFormat }),
      ).pipe(Effect.provide(wire.layer))

      expect(response.finishReason).toBe("content-filter")
      expect(response.text).toBe("")
      expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 })
    }),
  )

  it.effect("detects a refusal reported only in the completed Responses output", () =>
    Effect.gen(function* () {
      const wire = capture(
        sseEvents(
          responsesCompleted([
            { type: "message", id: "msg_1", content: [{ type: "refusal", refusal: "No." }] },
          ]),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({ model: responsesModel, prompt: "Judge.", responseFormat }),
      ).pipe(Effect.provide(wire.layer))

      expect(response.finishReason).toBe("content-filter")
    }),
  )

  it.effect("sends strict OpenAI Chat response_format and maps refusal to content-filter with usage", () =>
    Effect.gen(function* () {
      const wire = capture(
        sseEvents(
          deltaChunk({ refusal: "I can't help." }),
          deltaChunk({}, "stop"),
          usageChunk({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({ model: chatModel, prompt: "Judge.", responseFormat, generation: { maxTokens: 64 } }),
      ).pipe(Effect.provide(wire.layer))

      expect(wire.bodies[0]).toMatchObject({
        max_tokens: 64,
        stream_options: { include_usage: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: "response", schema: loweredSchema, strict: true },
        },
      })
      expect(response.finishReason).toBe("content-filter")
      expect(response.text).toBe("")
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 })
    }),
  )

  it.effect("keeps an OpenAI Chat answer without a refusal as a normal stop", () =>
    Effect.gen(function* () {
      const wire = capture(sseEvents(deltaChunk({ content: '{"kind":"answer"}' }), deltaChunk({}, "stop")))
      const response = yield* LLMClient.generate(
        LLM.request({ model: chatModel, prompt: "Judge.", responseFormat }),
      ).pipe(Effect.provide(wire.layer))

      expect(response.text).toBe('{"kind":"answer"}')
      expect(response.finishReason).toBe("stop")
    }),
  )

  it.effect("sends Anthropic output_config.format merged with effort", () =>
    Effect.gen(function* () {
      const wire = capture(
        sseEvents(
          { type: "message_start", message: { usage: { input_tokens: 5 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"kind":"answer"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: anthropicModel,
          prompt: "Judge.",
          responseFormat,
          providerOptions: { anthropic: { effort: "high" } },
        }),
      ).pipe(Effect.provide(wire.layer))

      expect(wire.bodies[0]).toMatchObject({
        output_config: { effort: "high", format: { type: "json_schema", schema: loweredSchema } },
      })
      expect(response.text).toBe('{"kind":"answer"}')
    }),
  )

  it.effect("omits format fields for text and unset response formats", () =>
    Effect.gen(function* () {
      const responses = yield* LLMClient.prepare(
        LLM.request({ model: responsesModel, prompt: "Hi.", responseFormat: { type: "text" } }),
      )
      const chat = yield* LLMClient.prepare(LLM.request({ model: chatModel, prompt: "Hi." }))
      const anthropic = yield* LLMClient.prepare(LLM.request({ model: anthropicModel, prompt: "Hi." }))

      expect(JSON.stringify(responses.body)).not.toContain('"format"')
      expect(JSON.stringify(chat.body)).not.toContain('"response_format"')
      expect(JSON.stringify(anthropic.body)).not.toContain('"output_config"')
    }),
  )

  it.effect("rejects JSON output on a protocol without native support before any request", () =>
    Effect.gen(function* () {
      const wire = capture(sseEvents())
      const error = yield* LLMClient.generate(
        LLM.request({ model: geminiModel, prompt: "Judge.", responseFormat }),
      ).pipe(Effect.provide(wire.layer), Effect.flip)

      expect(wire.bodies).toHaveLength(0)
      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", parameter: "responseFormat" })
    }),
  )

  it.effect("rejects a tool response format on every protocol", () =>
    Effect.gen(function* () {
      const wire = capture(sseEvents())
      const error = yield* LLMClient.generate(
        LLM.request({
          model: responsesModel,
          prompt: "Judge.",
          responseFormat: {
            type: "tool",
            tool: ToolDefinition.make({ name: "answer", description: "Answer.", inputSchema: { type: "object" } }),
          },
        }),
      ).pipe(Effect.provide(wire.layer), Effect.flip)

      expect(wire.bodies).toHaveLength(0)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", parameter: "responseFormat" })
    }),
  )
})
