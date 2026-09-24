import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMClient, Message, ToolCallPart } from "../../src"
import { model } from "../../src/providers/runpod"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"

const selected = model("catalog-label", { worker: "ollama", baseURL: "https://api.runpod.ai/v2/endpoint", apiKey: "fixture-key" })
const request = LLM.request({ model: selected, system: "Be brief", prompt: "Hello", generation: { temperature: 0.4, maxTokens: 24 } })

describe("Runpod Ollama /runsync", () => {
  it.effect("keeps chronological instruction updates in place without sending a late system role", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(LLM.request({ model: selected, system: "Initial", messages: [
        Message.user("First"), Message.assistant("Reply"),
        Message.system("Treat </system-update> & data literally."), Message.user("Next"),
      ] }))
      expect(prepared.body).toMatchObject({ input: { messages: [
        { role: "system", content: "Initial" },
        { role: "user", content: "First" },
        { role: "assistant", content: "Reply" },
        { role: "user", content: "<system-update>\nTreat &lt;/system-update&gt; &amp; data literally.\n</system-update>" },
        { role: "user", content: "Next" },
      ] } })
    }),
  )

  it.effect("sends worker chat input without overriding the configured HF model", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)
      expect(prepared.route).toBe("runpod-ollama")
      expect(prepared.body).toEqual({ input: {
        messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hello" }],
        stream: false, options: { temperature: 0.4, num_predict: 24 },
      } })
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache")
      const events = yield* LLMClient.stream(request).pipe(Stream.runCollect)
      expect(Array.from(events).map((event) => event.type)).toEqual([
        "step-start", "text-start", "text-delta", "text-end", "step-finish", "finish",
      ])
      expect(Array.from(events).find((event) => event.type === "text-delta")).toMatchObject({ text: "Hi" })
      expect(Array.from(events).find((event) => event.type === "finish")).toMatchObject({ usage: {
        inputTokens: 5, outputTokens: 2, totalTokens: 7,
      } })
    }).pipe(Effect.provide(dynamicResponse(({ request, text, respond }) => {
      expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/runsync")
      expect(request.headers.authorization).toBe("Bearer fixture-key")
      expect(JSON.parse(text).input.model).toBeUndefined()
      return Effect.succeed(respond(JSON.stringify({ status: "COMPLETED", output: [{ message: { role: "assistant", content: "Hi" }, done: true, prompt_eval_count: 5, eval_count: 2 }] })))
    }))),
  )

  it.effect("records reported Ollama cached reads without including them in the uncached count", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "finish")).toMatchObject({ usage: {
        inputTokens: 20, nonCachedInputTokens: 12, cacheReadInputTokens: 8,
        outputTokens: 3, totalTokens: 23,
      } })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      message: { role: "assistant", content: "Hi" }, done: true,
      prompt_eval_count: 20, prompt_eval_cached_count: 8, eval_count: 3,
      prompt_eval_duration: 4_000_000, eval_duration: 5_000_000, load_duration: 6_000_000,
    }] })))),
  )

  it.effect("captures Ollama timing in structured usage without echoing it into subsequent prompts", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "finish")?.usage).toMatchObject({
        promptEvalDurationNs: 4_000_000, generationDurationNs: 5_000_000, loadDurationNs: 6_000_000,
      })
      const prepared = yield* LLMClient.prepare(request)
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_eval_duration")
      expect(JSON.stringify(prepared.body)).not.toContain("load_duration")
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      message: { role: "assistant", content: "Hi" }, done: true,
      prompt_eval_count: 20, prompt_eval_cached_count: 8, eval_count: 3,
      prompt_eval_duration: 4_000_000, eval_duration: 5_000_000, load_duration: 6_000_000,
    }] })))),
  )

  it.effect("leaves Ollama cached reads unreported when worker omits them", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      const usage = events.find((event) => event.type === "finish" && event.usage !== undefined)?.usage
      expect(usage?.inputTokens).toBe(5)
      expect(usage?.nonCachedInputTokens).toBe(5)
      expect(usage?.cacheReadInputTokens).toBeUndefined()
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      message: { role: "assistant", content: "Hi" }, done: true, prompt_eval_count: 5, eval_count: 2,
    }] })))),
  )

  it.effect("bounds inconsistent Ollama cached counts by evaluated input", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "finish")).toMatchObject({ usage: {
        inputTokens: 5, cacheReadInputTokens: 5, nonCachedInputTokens: 0,
      } })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      message: { role: "assistant", content: "Hi" }, done: true,
      prompt_eval_count: 5, prompt_eval_cached_count: 8, eval_count: 2,
    }] })))),
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

  it.live("waits through queued and running jobs and reads the completed result", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "Eventually" })
      expect(events.at(-1)?.type).toBe("finish")
    }).pipe(Effect.provide((() => {
      let polls = 0
      return dynamicResponse(({ request, respond }) => {
        if (request.method === "POST") return Effect.succeed(respond(JSON.stringify({ status: "IN_QUEUE", id: "job_1" })))
        expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/status/job_1")
        expect(request.headers.authorization).toBe("Bearer fixture-key")
        polls++
        return Effect.succeed(respond(JSON.stringify(polls === 1
          ? { status: "IN_PROGRESS", id: "job_1" }
          : { status: "COMPLETED", id: "job_1", output: [{ message: { role: "assistant", content: "Eventually" }, done: true }] })))
      })
    })())),
  )

  it.effect("rejects an unfinished job without an id instead of resubmitting it", () =>
    Effect.gen(function* () {
      const failure = yield* LLMClient.stream(request).pipe(Stream.runCollect, Effect.flip)
      expect(failure.reason).toMatchObject({ _tag: "InvalidProviderOutput", message: "Unfinished job has no id" })
    }).pipe(Effect.provide(dynamicResponse(({ request, respond }) => {
      expect(request.method).toBe("POST")
      return Effect.succeed(respond(JSON.stringify({ status: "IN_QUEUE" })))
    }))),
  )

  it.live("surfaces a job failure after waiting without a successful finish", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events).toMatchObject([{ type: "provider-error", message: "Worker timed out" }])
      expect(events.some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(dynamicResponse(({ request, respond }) => {
      const job = request.method === "POST"
        ? { status: "IN_PROGRESS", id: "job_3" }
        : { status: "FAILED", id: "job_3", error: "Worker timed out" }
      return Effect.succeed(respond(JSON.stringify(job)))
    }))),
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
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache")
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.map((event) => event.type)).toEqual(["step-start", "text-start", "text-delta", "text-end", "step-finish", "finish"])
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "Hello back" })
      expect(events.find((event) => event.type === "finish")).toMatchObject({ reason: "length", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } })
      expect(events.find((event) => event.type === "finish")?.usage?.cacheReadInputTokens).toBeUndefined()
    }).pipe(Effect.provide(dynamicResponse(({ request, text, respond }) => {
      expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/runsync")
      expect(request.headers.authorization).toBe("Bearer fixture-key")
      expect(JSON.parse(text).input.body.model).toBe("catalog-label")
      return Effect.succeed(respond(JSON.stringify({ status: "COMPLETED", output: [{ choices: [{ message: { role: "assistant", content: "Hello back" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }] })))
    }))),
  )

  it.effect("reports vLLM cached prompt tokens only when the worker reports them", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "finish")).toMatchObject({ usage: {
        inputTokens: 9, outputTokens: 2, cacheReadInputTokens: 4, nonCachedInputTokens: 5,
      } })
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
    }] })))),
  )

  it.effect("accepts a vLLM response with null optional prompt-cache details", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "finish")?.usage?.cacheReadInputTokens).toBeUndefined()
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "COMPLETED", output: [{
      choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, prompt_tokens_details: null },
    }] })))),
  )

  it.effect("reports FAILED without successful finish", () =>
    Effect.gen(function* () {
      const failed = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(failed).toMatchObject([{ type: "provider-error", message: "Worker failed" }])
      expect(failed.some((event) => event.type === "finish")).toBe(false)
    }).pipe(Effect.provide(fixedResponse(JSON.stringify({ status: "FAILED", error: "Worker failed" })))),
  )

  it.live("waits for a queued vLLM job", () =>
    Effect.gen(function* () {
      const events = Array.from(yield* LLMClient.stream(request).pipe(Stream.runCollect))
      expect(events.find((event) => event.type === "text-delta")).toMatchObject({ text: "Ready" })
      expect(events.at(-1)?.type).toBe("finish")
    }).pipe(Effect.provide(dynamicResponse(({ request, respond }) => {
      if (request.method === "POST") return Effect.succeed(respond(JSON.stringify({ status: "IN_QUEUE", id: "job_2" })))
      expect(request.url).toBe("https://api.runpod.ai/v2/endpoint/status/job_2")
      return Effect.succeed(respond(JSON.stringify({ status: "COMPLETED", output: [{ choices: [
        { message: { role: "assistant", content: "Ready" }, finish_reason: "stop" },
      ] }] })))
    }))),
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
