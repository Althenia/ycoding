import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMClient, Message, ToolCallPart } from "../../src"
import { model } from "../../src/providers/runpod"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"

const selected = model("catalog-label", { worker: "ollama", baseURL: "https://api.runpod.ai/v2/endpoint", apiKey: "fixture-key" })
const request = LLM.request({ model: selected, system: "Be brief", prompt: "Hello", generation: { temperature: 0.4, maxTokens: 24 } })

describe("Runpod Ollama /runsync", () => {
  it.effect("sends worker chat input without overriding the configured HF model", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)
      expect(prepared.route).toBe("runpod-ollama")
      expect(prepared.body).toEqual({ input: {
        messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hello" }],
        stream: false, options: { temperature: 0.4, num_predict: 24 },
      } })
      const events = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      expect(Array.from(events).map((event) => event.type)).toEqual([
        "step-start", "text-start", "text-delta", "text-end", "step-finish", "finish",
      ])
      expect(Array.from(events).find((event) => event.type === "text-delta")).toMatchObject({ text: "Hi" })
    }).pipe(Effect.provide(dynamicResponse(({ request, text, respond }) => {
      expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/runsync")
      expect(request.headers.authorization).toBe("Bearer fixture-key")
      expect(JSON.parse(text).input.model).toBeUndefined()
      return Effect.succeed(respond(JSON.stringify({ status: "COMPLETED", output: [{ message: { role: "assistant", content: "Hi" }, done: true, prompt_eval_count: 5, eval_count: 2 }] })))
    }))),
  )

  it.effect("round-trips Ollama tool calls and tool results", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(LLM.request({ model: selected, messages: [
        Message.user("Find it"), Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { q: "x" } })]),
        Message.tool({ id: "call_1", name: "lookup", result: { found: true } }),
      ], tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] }))
      expect(prepared.body).toMatchObject({ input: {
        messages: [
          { role: "user", content: "Find it" },
          { role: "assistant", content: "", tool_calls: [{ function: { name: "lookup", arguments: { q: "x" } } }] },
          { role: "tool", content: '{"found":true}' },
        ],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      } })
      const events = yield* LLMClient.stream(LLM.request({ id: "req_tool", model: selected, prompt: "Find it" })).pipe(Stream.runCollect)
      expect(Array.from(events).find((event) => event.type === "tool-call")).toMatchObject({ id: "req_tool-ollama-tool-0", name: "lookup", input: { q: "x" } })
      expect(Array.from(events).find((event) => event.type === "finish")).toMatchObject({ reason: "tool-calls" })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "lookup", arguments: { q: "x" } } }] }, done: true }] })))),
  )

  it.effect("surfaces FAILED and unfinished jobs without a successful finish", () =>
    Effect.gen(function* () {
      const failed = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      expect(Array.from(failed).map((event) => event.type)).toEqual(["provider-error"])
      expect(Array.from(failed)[0]).toMatchObject({ message: "Worker failed" })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "FAILED", error: "Worker failed" })))),
  )

  it.effect("reports nonterminal jobs without a successful finish", () =>
    Effect.gen(function* () {
      const pending = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      expect(Array.from(pending)).toMatchObject([{ type: "provider-error", message: "Runpod job IN_QUEUE" }])
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "IN_QUEUE", id: "job_1" })))),
  )

  it.effect("reports a completed job containing the worker's error output", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      expect(Array.from(events)).toMatchObject([{ type: "provider-error", message: "Ollama request failed" }])
      expect(Array.from(events).some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{ error: "Ollama request failed" }] })))),
  )

  it.effect("rejects completed jobs with missing output", () =>
    Effect.gen(function* () {
      const missing = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.flip)
      expect(missing.reason).toMatchObject({ _tag: "InvalidProviderOutput", message: "Missing worker response" })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED" })))),
  )

  it.effect("rejects a malformed Ollama response", () =>
    Effect.gen(function* () {
      const malformed = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.flip)
      expect(malformed.reason).toMatchObject({ _tag: "InvalidProviderOutput", message: "Invalid Ollama response" })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{ done: true }] })))),
  )

  it.effect("rejects unsupported named tool choice before transport", () =>
    Effect.gen(function* () {
      const result = yield* LLMClient.prepare(LLM.request({ model: selected, prompt: "Hi", toolChoice: "lookup" })).pipe(Effect.flip)
      expect(result.reason._tag).toBe("InvalidRequest")
    }),
  )

  it.effect("maps Ollama generation controls and rejects unsupported penalties", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(LLM.request({ model: selected, prompt: "Hi", generation: {
        topK: 4, seed: 9, stop: ["END"],
      } }))
      expect(prepared.body).toMatchObject({ input: { options: { top_k: 4, seed: 9, stop: ["END"] } } })
      const invalid = yield* LLMClient.prepare(LLM.request({ model: selected, prompt: "Hi", generation: {
        frequencyPenalty: 0.2,
      } })).pipe(Effect.flip)
      expect(invalid.reason._tag).toBe("InvalidRequest")
    }),
  )
})

describe("Runpod vLLM /runsync", () => {
  const selected = model("catalog-label", { worker: "vllm", baseURL: "https://api.runpod.ai/v2/endpoint", apiKey: "fixture-key" })
  const request = LLM.request({ model: selected, system: "Be brief", prompt: "Hello", generation: {
    temperature: 0.3, topP: 0.8, topK: 4, maxTokens: 24, seed: 7, stop: ["END"],
    frequencyPenalty: 0.2, presencePenalty: 0.1,
  } })

  it.effect("sends vLLM chat proxy body and parses completion text, finish, and usage", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)
      expect(prepared.route).toBe("runpod-vllm")
      expect(prepared.body).toEqual({ input: {
        route: "/v1/chat/completions", method: "POST",
        body: { model: "catalog-label", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hello" }],
          stream: false, temperature: 0.3, top_p: 0.8, top_k: 4, max_tokens: 24, seed: 7, stop: ["END"], frequency_penalty: 0.2, presence_penalty: 0.1 },
      } })
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.map((event) => event.type)).toEqual(["step-start", "text-start", "text-delta", "text-end", "step-finish", "finish"])
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "Hello back" })
      expect(events.find((event) => event.type === "finish")).toMatchObject({ reason: "length", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })
    }).pipe(Effect.provide(dynamicResponse(({ request, text, respond }) => {
      expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/runsync")
      expect(request.headers.authorization).toBe("Bearer fixture-key")
      expect(JSON.parse(text).input.body.model).toBe("catalog-label")
      return Effect.succeed(respond(JSON.stringify({ status: "COMPLETED", output: [{ choices: [{ message: { role: "assistant", content: "Hello back" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }] })))
    }))),
  )

  it.effect("reports FAILED without successful finish", () =>
    Effect.gen(function* () {
      const failed = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(failed).toMatchObject([{ type: "provider-error", message: "Worker failed" }])
      expect(failed.some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "FAILED", error: "Worker failed" })))),
  )

  it.effect("reports unfinished vLLM jobs and structured worker errors", () =>
    Effect.gen(function* () {
      const pending = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(pending).toMatchObject([{ type: "provider-error", message: "Runpod job IN_QUEUE" }])
      expect(pending.some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "IN_QUEUE" })))),
  )

  it.effect("reports the worker's structured output error without a finish", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events).toMatchObject([{ type: "provider-error", message: "vLLM failed to start" }])
      expect(events.some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{ error: { message: "vLLM failed to start", type: "startup_error", code: null } }] })))),
  )

  it.effect("rejects malformed vLLM completion rather than interpreting it as Ollama", () =>
    Effect.gen(function* () {
      const failure = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.flip)
      expect(failure.reason).toMatchObject({ _tag: "InvalidProviderOutput", message: "Invalid vLLM response" })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{ message: { role: "assistant", content: "wrong protocol" }, done: true }] })))),
  )

  it.effect("passes tools through generic proxy, parses calls, and replays tool results", () =>
    Effect.gen(function* () {
      const tool = { name: "lookup", description: "Lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }
      const prepared = yield* LLMClient.prepare(LLM.request({ model: selected, prompt: "Find", tools: [tool] }))
      expect(prepared.body).toMatchObject({ input: { route: "/v1/chat/completions", method: "POST", body: {
        model: "catalog-label", messages: [{ role: "user", content: "Find" }], stream: false,
        tools: [{ type: "function", function: { name: "lookup", parameters: tool.inputSchema } }],
      } } })
      const events = Array.from(yield* LLMClient.stream(LLM.request({ model: selected, prompt: "Find", tools: [tool] })).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "tool-call")).toMatchObject({ id: "call_42", name: "lookup", input: { q: "x" } })
      expect(events.find((event) => event.type === "finish")).toMatchObject({ reason: "tool-calls" })
      const replay = yield* LLMClient.prepare(LLM.request({ model: selected, messages: [
        Message.user("Find"), Message.assistant([ToolCallPart.make({ id: "call_42", name: "lookup", input: { q: "x" } })]),
        Message.tool({ id: "call_42", name: "lookup", result: { found: true } }),
      ], tools: [tool] }))
      expect(replay.body).toMatchObject({ input: { body: { messages: [
        { role: "user", content: "Find" },
        { role: "assistant", tool_calls: [{ id: "call_42", function: { name: "lookup", arguments: '{"q":"x"}' } }] },
        { role: "tool", tool_call_id: "call_42", content: '{"found":true}' },
      ] } } })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_42", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
    }] })))),
  )
})

describe("Runpod Serverless worker selection", () => {
  test("requires an explicit known worker type", () => {
    expect(() => Reflect.apply(model, null, ["catalog-label", { baseURL: "https://api.runpod.ai/v2/endpoint" }])).toThrow("settings.worker: ollama or vllm")
    expect(() => Reflect.apply(model, null, ["catalog-label", { worker: "unknown", baseURL: "https://api.runpod.ai/v2/endpoint" }])).toThrow("settings.worker: ollama or vllm")
  })
})
