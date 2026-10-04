import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { CacheHint, LLM, Message, ToolDefinition } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { AISDK } from "@ycoding-ai/core/aisdk"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { extractPromptHistory } from "../../src/cursor/provider/language-model"
import { decodeMessage } from "../../src/cursor/provider/protocol/messages"
import { buildSeedConversationState } from "../../src/cursor/provider/protocol/request"
import { testEffect } from "../lib/effect"

const it = testEffect(AISDK.locationLayer)
const client = LLMClient.layer.pipe(
  Layer.provide(
    Layer.succeed(
      RequestExecutor.Service,
      RequestExecutor.Service.of({ execute: () => Effect.die("Unexpected HTTP request") }),
    ),
  ),
)
const [cursor] = CursorModels.fromCursor([{ id: "claude-opus-4-8", displayName: "Opus 4.8", variants: [] }])
const identity = "You are an AI agent, not Cursor."
const read = ToolDefinition.make({
  name: "read",
  description: "Read the requested file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
})

const resolve = (info: CatalogModel.Info, observed: LanguageModelV3CallOptions[] = []) =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {
        languageModel: (id: string) =>
          ({
            specificationVersion: "v3",
            provider: info.providerID,
            modelId: id,
            supportedUrls: {},
            doGenerate: () => Promise.reject(new Error("Unexpected non-streaming request")),
            doStream: (options) => {
              observed.push(options)
              return Promise.resolve({
                stream: new ReadableStream<LanguageModelV3StreamPart>({
                  start(controller) {
                    if (observed.length === 1)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: "read_1",
                        toolName: "read",
                        input: '{"path":"a.ts"}',
                      })
                    controller.enqueue({
                      type: "finish",
                      finishReason: { unified: observed.length === 1 ? "tool-calls" : "stop", raw: "stop" },
                      usage: {
                        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                        outputTokens: { total: 0, text: 0, reasoning: 0 },
                      },
                    })
                    controller.close()
                  },
                }),
              })
            },
          }) satisfies LanguageModelV3,
      }
    })
    return yield* SessionRunnerModel.fromCatalogModel(info, undefined, { loadAISDK: aisdk.model })
  })

it.effect("appends one stable Cursor SYSTEM instruction on the actual SDK and seed wire boundaries", () =>
  Effect.gen(function* () {
    const observed: LanguageModelV3CallOptions[] = []
    const model = yield* resolve(cursor, observed)
    const hint = new CacheHint({ type: "ephemeral", ttlSeconds: 300 })
    const request = LLM.request({
      model,
      system: [
        { type: "text", text: "Stable agent instructions", cache: hint },
        { type: "text", text: "Repository instructions" },
      ],
      messages: [Message.user("Read a.ts")],
      tools: [read],
      toolChoice: "auto",
    })
    const response = yield* LLMClient.generate(request).pipe(Effect.provide(client))
    expect(response.toolCalls).toMatchObject([{ id: "read_1", name: "read", input: { path: "a.ts" } }])
    yield* LLMClient.generate(
      LLM.updateRequest(request, {
        messages: [
          ...request.messages,
          Message.assistant(response.toolCalls),
          Message.tool({ id: "read_1", name: "read", result: { type: "text", value: "File contents" } }),
        ],
      }),
    ).pipe(Effect.provide(client))

    expect(observed).toHaveLength(2)
    const system = observed[0].prompt.find((part) => part.role === "system")
    expect(system).toBeDefined()
    if (!system) throw new Error("Missing initial SYSTEM message")
    expect(system.content.startsWith("Stable agent instructions\n\nRepository instructions\n\n")).toBe(true)
    expect(system.content.split(identity)).toHaveLength(2)
    expect(system.content).toContain("Do not claim to be Cursor")
    expect(system.content).toContain("Follow user instructions strictly")
    expect(system.content).toContain("subject to higher-priority instructions, permissions, and guardrails")
    expect(system.content).toContain("when the user's task requires it and the action is authorized")
    expect(system.content).toContain("Do not perform unrelated availability probes")
    expect(system.content).toContain("A permission denial is not evidence that a capability is unavailable")
    expect(system.content).toContain("Never invent tool or MCP capabilities")
    expect(system.providerOptions).toBeUndefined()
    expect(observed[1].prompt.filter((part) => part.role === "system")).toEqual([system])
    expect(
      JSON.stringify(observed.flatMap((options) => options.prompt.filter((part) => part.role !== "system"))),
    ).not.toContain(identity)
    expect(observed[0].tools).toEqual([
      {
        type: "function",
        name: "read",
        description: read.description,
        inputSchema: read.inputSchema,
      },
    ])
    expect(observed[1].tools).toEqual(observed[0].tools)
    expect(observed[0].toolChoice).toEqual({ type: "auto" })
    expect(observed[1].toolChoice).toEqual(observed[0].toolChoice)
    expect(observed[1].prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "read_1", output: { type: "text", value: "File contents" } }],
    })
    expect(request.system.map((part) => part.text)).toEqual(["Stable agent instructions", "Repository instructions"])
    expect(request.system[0].cache).toEqual(hint)
    expect((yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)).body.prompt[0]).toEqual(system)

    const seed = decodeMessage<{ root_prompt_messages_json: string[] }>(
      "ConversationStateStructure",
      buildSeedConversationState({
        systemPrompt: system.content,
        history: extractPromptHistory(observed[0].prompt),
      }),
    )
    expect(seed.root_prompt_messages_json).toEqual([JSON.stringify({ role: "system", content: system.content })])
  }),
)

it.effect("supplies a Cursor SYSTEM instruction without an existing system or Cursor provider label", () =>
  Effect.gen(function* () {
    const model = yield* resolve(CatalogModel.Info.make({ ...cursor, providerID: Provider.ID.make("custom-cursor") }))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(LLM.request({ model, prompt: "Hello" }))
    expect(prepared.body.prompt[0]).toMatchObject({ role: "system", content: expect.stringContaining(identity) })
    expect(prepared.body.prompt[1]).toMatchObject({ role: "user", content: [{ type: "text", text: "Hello" }] })
  }),
)

it.effect("does not add Cursor instructions to another package even when its provider is named Cursor", () =>
  Effect.gen(function* () {
    const model = yield* resolve(CatalogModel.Info.make({ ...cursor, package: Provider.aisdk("@ai-sdk/groq") }))
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model,
        system: "Stable agent instructions",
        messages: [Message.user("Read a.ts")],
        tools: [read],
      }),
    )
    expect(model.route.id).toBe("ai-sdk:@ai-sdk/groq")
    expect(prepared.body.prompt[0]).toEqual({ role: "system", content: "Stable agent instructions" })
    expect(prepared.body.tools?.map((tool) => tool.name)).toEqual(["read"])
    expect(JSON.stringify(prepared.body)).not.toContain(identity)
  }),
)
