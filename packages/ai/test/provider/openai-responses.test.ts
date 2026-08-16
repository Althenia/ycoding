import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Stream } from "effect"
import { Headers, HttpClientRequest } from "effect/unstable/http"
import { CacheHint, LLM, LLMError, LLMEvent, Message, Model, ToolCallPart, ToolResultPart, Usage } from "../../src"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../../src/route"
import * as Azure from "../../src/providers/azure"
import * as GitHubCopilot from "../../src/providers/github-copilot"
import * as OpenAI from "../../src/providers/openai"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import * as ProviderShared from "../../src/protocols/shared"
import {
  continuationRequest,
  continuationTool,
  nativeOpenAIResponsesContinuation,
} from "../continuation-scenarios"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const configEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))

type OpenAIToolOutput = Extract<
  OpenAIResponses.OpenAIResponsesBody["input"][number],
  { readonly type: "function_call_output" }
>

const expectToolOutput = (body: OpenAIResponses.OpenAIResponsesBody): OpenAIToolOutput => {
  const output = body.input.find(
    (item): item is OpenAIToolOutput => "type" in item && item.type === "function_call_output",
  )
  expect(output).toBeDefined()
  return output!
}

describe("OpenAI Responses route", () => {
  it.effect("prepares OpenAI Responses target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
        ],
        store: false,
        stream: true,
        max_output_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers a stored continuation to the prior response and new message suffix", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          system: "Use the current tool contract.",
          messages: [
            Message.user("Check Paris."),
            Message.assistant([ToolCallPart.make({ id: "call_weather_1", name: "get_weather", input: { city: "Paris" } })]),
            Message.tool(
              ToolResultPart.make({ id: "call_weather_1", name: "get_weather", result: { temperature: 22 } }),
            ),
          ],
          tools: [continuationTool],
          providerOptions: {
            openai: {
              store: true,
              previousResponseId: "resp_previous_1",
              continuationInputStart: 2,
            },
          },
        }),
      )

      expect(prepared.body.previous_response_id).toBe("resp_previous_1")
      expect(prepared.body.input).toEqual([
        { role: "system", content: "Use the current tool contract." },
        { type: "function_call_output", call_id: "call_weather_1", output: "{\"temperature\":22}" },
      ])
      expect(prepared.body.tools).toHaveLength(1)
      expect(prepared.body.tools?.[0]).toMatchObject({ type: "function", name: "get_weather" })
    }),
  )

  it.effect("omits continuation fields when they are absent", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)
      expect(prepared.body).not.toHaveProperty("previous_response_id")
    }),
  )

  it.effect("lowers the hosted OpenAI image generation tool", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "Show me a rooftop garden.",
          tools: [OpenAI.imageGeneration({ action: "generate", quality: "high", size: "1024x1024" })],
          toolChoice: "image_generation",
        }),
      )

      expect(prepared.body.tools).toEqual([
        { type: "image_generation", action: "generate", quality: "high", size: "1024x1024" },
      ])
      expect(prepared.body.tool_choice).toEqual({ type: "image_generation" })
    }),
  )

  it.effect("lowers the hosted OpenAI web search tool", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "Find the latest Effect release notes.",
          tools: [
            OpenAI.webSearch({
              allowedDomains: ["effect.website"],
              blockedDomains: ["example.com"],
              searchContextSize: "high",
              externalWebAccess: false,
              returnTokenBudget: "unlimited",
              userLocation: {
                country: "US",
                city: "New York",
                region: "New York",
                timezone: "America/New_York",
              },
            }),
          ],
          toolChoice: "web_search",
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "web_search",
          filters: { allowed_domains: ["effect.website"], blocked_domains: ["example.com"] },
          search_context_size: "high",
          external_web_access: false,
          return_token_budget: "unlimited",
          user_location: {
            type: "approximate",
            country: "US",
            city: "New York",
            region: "New York",
            timezone: "America/New_York",
          },
        },
      ])
      expect(prepared.body.tool_choice).toEqual({ type: "web_search" })
    }),
  )

  it.effect("rejects invalid hosted image generation options locally", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          model,
          prompt: "Show me a rooftop garden.",
          tools: [OpenAI.imageGeneration({ outputCompression: -1, partialImages: 4, size: "bogus" })],
        }),
      ).pipe(Effect.flip)

      expect(error.reason._tag).toBe("InvalidRequest")
      expect(error.message).toContain("image generation tool options are invalid")
    }),
  )

  it.effect("lowers semantic service tier options", () =>
    Effect.gen(function* () {
      const input = LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "priority" } } })
      expect(input.providerOptions).toEqual({ openai: { serviceTier: "priority" } })
      const prepared = yield* LLMClient.prepare(input)

      expect(prepared.body).toMatchObject({ service_tier: "priority" })
      expect(prepared.body).not.toHaveProperty("serviceTier")
    }),
  )

  it.effect("passes through custom OpenAI reasoning effort strings", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, { providerOptions: { openai: { reasoningEffort: "experimental" } } }),
      )

      expect(prepared.body.reasoning).toEqual({ effort: "experimental" })
    }),
  )

  it.effect("omits unsupported semantic service tiers", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, { providerOptions: { openai: { serviceTier: "unsupported" } } }),
      )

      expect(prepared.body).not.toHaveProperty("service_tier")
    }),
  )

  it.effect("flattens top-level object unions in function schemas", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          tools: [
            {
              name: "read",
              description: "Read a path or resource.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      reference: { anyOf: [{ type: "string" }, { type: "null" }] },
                      limit: { type: "integer", maximum: 2000 },
                    },
                    required: ["path"],
                  },
                  {
                    type: "object",
                    properties: { resource: { type: "string" }, limit: { type: "integer", maximum: 51200 } },
                    required: ["resource"],
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          name: "read",
          description: "Read a path or resource.",
          strict: false,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              reference: { type: "string" },
              limit: { type: "integer", maximum: 2000 },
              resource: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ])
    }),
  )

  it.effect("lowers chronological system updates to escaped user wrappers in order", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before."),
            Message.system("Treat </system-update> literally."),
            Message.assistant("After."),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "Before." },
            { type: "input_text", text: "<system-update>\nTreat &lt;/system-update&gt; literally.\n</system-update>" },
          ],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("prepares OpenAI Responses WebSocket target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          model: OpenAIResponses.webSocketRoute
            .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
            .model({ id: "gpt-4.1-mini" }),
        }),
      )

      expect(prepared.route).toBe("openai-responses-websocket")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.metadata).toEqual({ transport: "websocket-json" })
      expect(prepared.body).toMatchObject({ model: "gpt-4.1-mini", store: false, stream: true })
    }),
  )

  it.effect("enables GPT-5.6 cache options and breakpoints on direct Responses WebSocket", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
            "gpt-5.6",
          ),
          system: { type: "text", text: "stable", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
        }),
      )

      expect(prepared.route).toBe("openai-responses-websocket")
      expect(prepared.body.store).toBe(true)
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto", context: "all_turns" })
      expect(prepared.body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" })
      expect(prepared.body.context_management).toEqual([{ type: "compaction", compact_threshold: 200_000 }])
      expect(prepared.body.input).toEqual([
        {
          role: "system",
          content: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }],
        },
      ])
    }),
  )

  it.effect("keeps GitHub Copilot cache controls key-only without direct compaction", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: GitHubCopilot.configure({
            baseURL: "https://copilot.example.test",
            apiKey: "fixture",
          }).responses("gpt-5.6"),
          system: { type: "text", text: "stable", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
          providerOptions: {
            openai: {
              promptCacheKey: "copilot-key",
              promptCacheOptions: { mode: "explicit", ttl: "30m" },
              contextManagement: [{ type: "compaction", compactThreshold: 400_000 }],
              reasoningContext: "all_turns",
            },
          },
        }),
      )

      expect(prepared.route).toBe("github-copilot-responses")
      expect(prepared.body.store).toBe(false)
      expect(prepared.body.prompt_cache_key).toBe("copilot-key")
      expect(prepared.body.prompt_cache_options).toBeUndefined()
      expect(prepared.body.reasoning?.context).toBeUndefined()
      expect(prepared.body.context_management).toBeUndefined()
      expect(prepared.body.input).toEqual([
        { role: "system", content: "stable" },
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
      ])
    }),
  )

  it.effect("keeps Azure Responses stateless without direct retained reasoning or compaction", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: Azure.configure({
            baseURL: "https://ycoding-test.openai.azure.com/openai/v1/",
            apiKey: "azure-key",
            providerOptions: {
              openai: {
                reasoningContext: "all_turns",
                contextManagement: [{ type: "compaction", compactThreshold: 400_000 }],
              },
            },
          }).responses("gpt-5.6"),
          prompt: "Keep this request stateless.",
        }),
      )

      expect(prepared.route).toBe("azure-openai-responses")
      expect(prepared.body.store).toBe(false)
      expect(prepared.body.reasoning?.context).toBeUndefined()
      expect(prepared.body.context_management).toBeUndefined()
    }),
  )

  it.effect("streams OpenAI Responses over WebSocket", () =>
    Effect.gen(function* () {
      const sent: string[] = []
      const opened: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
      let closed = false
      const deps = Layer.mergeAll(
        Layer.succeed(
          RequestExecutor.Service,
          RequestExecutor.Service.of({
            execute: () => Effect.die("unexpected HTTP request"),
          }),
        ),
        Layer.succeed(
          WebSocketExecutor.Service,
          WebSocketExecutor.Service.of({
            open: (input) =>
              Effect.succeed({
                sendText: (message) =>
                  Effect.sync(() => {
                    opened.push({ url: input.url, authorization: input.headers.authorization })
                    sent.push(message)
                  }),
                messages: Stream.fromArray([
                  ProviderShared.encodeJson({ type: "response.output_text.delta", item_id: "msg_1", delta: "Hi" }),
                  ProviderShared.encodeJson({ type: "response.completed", response: { id: "resp_ws" } }),
                ]),
                close: Effect.sync(() => {
                  closed = true
                }),
              }),
          }),
        ),
      )
      const response = yield* LLMClient.generate(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responsesWebSocket(
            "gpt-4.1-mini",
          ),
          messages: [Message.user("Earlier."), Message.user("Say hello.")],
          providerOptions: {
            openai: {
              store: true,
              previousResponseId: "resp_ws_previous",
              continuationInputStart: 1,
            },
          },
        }),
      ).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(deps))))

      expect(response.text).toBe("Hi")
      expect(opened).toEqual([{ url: "wss://api.openai.test/v1/responses", authorization: "Bearer test" }])
      expect(closed).toBe(true)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0])).toEqual({
        type: "response.create",
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        previous_response_id: "resp_ws_previous",
        store: true,
      })
    }),
  )

  it.effect("fails immediately when WebSocket is already closed", () =>
    Effect.gen(function* () {
      const error = yield* WebSocketExecutor.fromWebSocket(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- fromWebSocket reads readyState before touching WebSocket methods on this branch.
        { readyState: globalThis.WebSocket.CLOSED } as globalThis.WebSocket,
        { url: "wss://api.openai.test/v1/responses", headers: Headers.empty },
      ).pipe(Effect.flip)

      expect(error.message).toContain("closed before opening")
    }),
  )

  it.effect("adds native query params to the Responses URL", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Model.update(model, { route: model.route.with({ endpoint: { query: { "api-version": "v1" } } }) }),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.openai.test/v1/responses?api-version=v1")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("uses Azure api-key header for static OpenAI Responses keys", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: Azure.configure({
            baseURL: "https://ycoding-test.openai.azure.com/openai/v1/",
            apiKey: "azure-key",
            headers: { authorization: "Bearer stale" },
          }).responses("gpt-4.1-mini"),
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://ycoding-test.openai.azure.com/openai/v1/responses?api-version=v1")
              expect(web.headers.get("api-key")).toBe("azure-key")
              expect(web.headers.get("authorization")).toBeNull()
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("loads OpenAI default auth from Effect Config", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/" }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      configEnv({ OPENAI_API_KEY: "env-key" }),
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer env-key")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("lets explicit auth override OpenAI default API key auth", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAI.configure({
          baseURL: "https://api.openai.test/v1/",
          auth: Auth.bearer("oauth-token"),
        }).responses("gpt-4.1-mini"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
            return input.respond(sseEvents({ type: "response.completed", response: {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    ),
  )

  it.effect("prepares function call and function output input items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body).toEqual({
        model: "gpt-4.1-mini",
        input: [
          { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
          { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
        ],
        store: false,
        stream: true,
        max_output_tokens: undefined,
        temperature: undefined,
        tool_choice: undefined,
        tools: undefined,
        top_p: undefined,
      })
    }),
  )

  it.effect("preserves structured tool errors for the model", () =>
    Effect.gen(function* () {
      const error = {
        error: { type: "unknown", message: "Tool execution interrupted" },
        content: [],
        structured: {},
      }
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: { command: "sleep 10" } })]),
            Message.tool({
              id: "call_1",
              name: "bash",
              resultType: "error",
              result: error,
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe(ProviderShared.encodeJson(error))
    }),
  )

  it.effect("keeps primitive tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: 503 }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("503")
    }),
  )

  it.effect("keeps non-JSON tool errors as plain text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "bash", input: {} })]),
            Message.tool({ id: "call_1", name: "bash", resultType: "error", result: new Error("boom") }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toBe("Error: boom")
    }),
  )

  // Regression: screenshot/read tool results must stay structured so base64
  // image data is not JSON-stringified into `function_call_output.output`.
  it.effect("lowers image tool-result content as structured input_image items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image",
          model,
          messages: [
            Message.user("Show me the screenshot."),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: { filePath: "shot.png" } })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
              ],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_text", text: "Image read successfully" },
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("lowers configured image detail on local tool-result images", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image_detail",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "read", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "read",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
          providerOptions: { openai: { imageDetail: "high" } },
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==", detail: "high" },
      ])
    }),
  )

  it.effect("lowers single-image tool-result content as structured input_image array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_tool_result_image_only",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "screenshot", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "screenshot",
              resultType: "content",
              result: [{ type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" }],
            }),
          ],
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("rejects non-image media in tool-result content with a clear error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_tool_result_unsupported_media",
          model,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "fetch", input: {} })]),
            Message.tool({
              id: "call_1",
              name: "fetch",
              resultType: "content",
              result: [{ type: "file", uri: "data:audio/mpeg;base64,AAECAw==", mime: "audio/mpeg" }],
            }),
          ],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses")
      expect(error.message).toContain("audio/mpeg")
    }),
  )

  it.effect("prepares the composed native continuation request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        continuationRequest({
          id: "req_native_continuation_openai",
          model,
          features: nativeOpenAIResponsesContinuation,
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "system", content: "You are concise. Continue from the provided history." },
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is shown here?" },
              { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
            ],
          },
          {
            type: "reasoning",
            encrypted_content: "encrypted-continuation-state",
            summary: [{ type: "summary_text", text: "I inspected the previous turn." }],
          },
          { role: "assistant", content: [{ type: "output_text", text: "It shows a small test image." }] },
          { role: "user", content: [{ type: "input_text", text: "Check the weather in Paris before continuing." }] },
          { type: "function_call", call_id: "call_weather_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call_output", call_id: "call_weather_1", output: '{"temperature":22}' },
          { role: "assistant", content: [{ type: "output_text", text: "Paris is 22 degrees." }] },
          {
            role: "user",
            content: [{ type: "input_text", text: "Continue from this conversation in one short sentence." }],
          },
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      })
      expect(prepared.body.tools).toEqual([expect.objectContaining({ type: "function", name: "get_weather" })])
    }),
  )

  it.effect("maps OpenAI provider options to Responses options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.2"),
          prompt: "think",
          providerOptions: {
            openai: {
              promptCacheKey: "session_123",
              reasoningEffort: "high",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(true)
      expect(prepared.body.prompt_cache_key).toBe("session_123")
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "high", summary: "auto" })
      expect(prepared.body.text).toEqual({ verbosity: "low" })
    }),
  )

  describe("prompt_cache_retention / prompt_cache_options family gating", () => {
    // GPT-5.6+ uses cache_options. Earlier models only receive retention when
    // OpenAI lists that exact family as supporting it; unsupported fields return
    // a 400 upstream, so both controls are gated independently.
    const table = [
      { id: "gpt-5.5", retentionSent: true, optionsSent: false },
      { id: "gpt-5", retentionSent: true, optionsSent: false },
      { id: "gpt-4.1", retentionSent: true, optionsSent: false },
      { id: "gpt-4o-mini", retentionSent: false, optionsSent: false },
      { id: "gpt-5.6", retentionSent: false, optionsSent: true },
      { id: "gpt-5.6-mini", retentionSent: false, optionsSent: true },
      { id: "gpt-6", retentionSent: false, optionsSent: true },
      // Aggregators and gateways prefix the vendor onto the model id.
      { id: "openai/gpt-5.6", retentionSent: false, optionsSent: true },
      { id: "openai/gpt-5.5", retentionSent: true, optionsSent: false },
    ] as const

    for (const row of table) {
      it.effect(`${row.id}: retention sent=${row.retentionSent}, cache_options sent=${row.optionsSent}`, () =>
        Effect.gen(function* () {
          const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
            LLM.request({
              model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model(row.id),
              prompt: "hi",
              providerOptions: {
                openai: {
                  promptCacheRetention: "24h",
                  promptCacheOptions: { mode: "explicit", ttl: "30m" },
                },
              },
            }),
          )

          expect(prepared.body.prompt_cache_retention).toBe(row.retentionSent ? "24h" : undefined)
          expect(prepared.body.prompt_cache_options).toEqual(
            row.optionsSent ? { mode: "explicit", ttl: "30m" } : undefined,
          )
        }),
      )
    }
  })

  it.effect("keeps compatible GPT-5.6 routes key-only when route defaults contain public cache controls", () =>
    Effect.gen(function* () {
      const publicModel = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6")
      const compatibleModel = Model.update(publicModel, {
        route: publicModel.route.with({
          id: "openai-compatible-responses",
          defaults: {
            providerOptions: {
              openai: {
                promptCacheKey: "route-key",
                promptCacheRetention: "24h",
                promptCacheOptions: { mode: "explicit", ttl: "30m" },
              },
            },
          },
        }),
      })
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: compatibleModel,
          system: { type: "text", text: "stable", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
          providerOptions: {
            openai: {
              promptCacheKey: "request-key",
              promptCacheRetention: "24h",
              promptCacheOptions: { mode: "explicit", ttl: "30m" },
              contextManagement: [{ type: "compaction", compactThreshold: 400_000 }],
              reasoningContext: "all_turns",
            },
          },
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("request-key")
      expect(prepared.body.prompt_cache_retention).toBeUndefined()
      expect(prepared.body.prompt_cache_options).toBeUndefined()
      expect(prepared.body.reasoning?.context).toBeUndefined()
      expect(prepared.body.context_management).toBeUndefined()
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache_breakpoint")
    }),
  )

  it.effect("marks cached system/user content on direct GPT-5.6 Luna", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const preparedLegacy = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.5"),
          system: { type: "text", text: "static prefix", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
        }),
      )
      expect(preparedLegacy.body.input[0]).toEqual({ role: "system", content: "static prefix" })

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6-luna"),
          system: { type: "text", text: "static prefix", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
        }),
      )

      expect(prepared.body.input[0]).toEqual({
        role: "system",
        content: [{ type: "input_text", text: "static prefix", prompt_cache_breakpoint: { mode: "explicit" } }],
      })
      expect(prepared.body.input[1]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }],
      })
    }),
  )

  it.effect("keeps GPT-5.6 Codex caching key-only", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const direct = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6-luna")
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: Model.update(direct, { route: direct.route.with({ id: "openai-codex-responses" }) }),
          system: { type: "text", text: "static prefix", cache },
          messages: [Message.user([{ type: "text", text: "hi", cache }])],
          providerOptions: { openai: { promptCacheKey: "codex-key" } },
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("codex-key")
      expect(prepared.body.prompt_cache_options).toBeUndefined()
      expect(prepared.body.prompt_cache_retention).toBeUndefined()
      expect(prepared.body.input[0]).toEqual({
        role: "system",
        content: "static prefix",
      })
      expect(prepared.body.input[1]).toEqual({
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      })
      expect(JSON.stringify(prepared.body)).not.toContain("prompt_cache_breakpoint")
    }),
  )

  it.effect("keeps cached assistant text as output_text on every Responses route", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const direct = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6")
      const compatible = Model.update(direct, { route: direct.route.with({ id: "openai-compatible-responses" }) })
      const models = [
        direct,
        Model.update(direct, { route: direct.route.with({ id: "openai-responses-websocket" }) }),
        Model.update(direct, { route: direct.route.with({ id: "openai-codex-responses" }) }),
        OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.5"),
        compatible,
      ]

      for (const model of models) {
        const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.request({
            model,
            messages: [Message.assistant({ type: "text", text: "cached assistant", cache })],
          }),
        )
        const input = prepared.body.input[0]
        expect(input).toEqual({ role: "assistant", content: [{ type: "output_text", text: "cached assistant" }] })
        expect(JSON.stringify(input)).not.toContain("prompt_cache_breakpoint")
      }
    }),
  )

  it.effect("marks cached local tool-result text on direct GPT-5.6 Responses routes", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const direct = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6")
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: direct,
          messages: [
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: {} })]),
            Message.tool(
              ToolResultPart.make({
                id: "call_1",
                name: "lookup",
                result: "rolling result",
                resultType: "text",
                cache,
              }),
            ),
          ],
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        {
          type: "input_text",
          text: "rolling result",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ])

      const unsupported = [
        OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.5"),
        Model.update(direct, { route: direct.route.with({ id: "openai-compatible-responses" }) }),
      ]
      for (const unsupportedModel of unsupported) {
        const unsupportedPrepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
          LLM.request({
            model: unsupportedModel,
            messages: [
              Message.tool(
                ToolResultPart.make({
                  id: "call_1",
                  name: "lookup",
                  result: "rolling result",
                  resultType: "text",
                  cache,
                }),
              ),
            ],
            providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
          }),
        )
        expect(expectToolOutput(unsupportedPrepared.body).output).toBe("rolling result")
        expect(unsupportedPrepared.body.prompt_cache_options).toBeUndefined()
        expect(JSON.stringify(unsupportedPrepared.body)).not.toContain("prompt_cache_breakpoint")
      }
    }),
  )

  it.effect("preserves structured media when marking cached local tool-result text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6"),
          messages: [
            Message.tool(
              ToolResultPart.make({
                id: "call_1",
                name: "read",
                resultType: "content",
                result: [
                  { type: "text", text: "Image read successfully" },
                  { type: "file", uri: "data:image/png;base64,AAECAw==", mime: "image/png" },
                ],
                cache: new CacheHint({ type: "ephemeral" }),
              }),
            ),
          ],
          providerOptions: { openai: { promptCacheOptions: { mode: "explicit", ttl: "30m" } } },
        }),
      )

      expect(expectToolOutput(prepared.body).output).toEqual([
        {
          type: "input_text",
          text: "Image read successfully",
          prompt_cache_breakpoint: { mode: "explicit" },
        },
        { type: "input_image", image_url: "data:image/png;base64,AAECAw==" },
      ])
    }),
  )

  it.effect("preserves Responses assistant phase metadata when replaying model output", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "message", id: "msg_phase", phase: "commentary" },
        },
        { type: "response.output_text.delta", item_id: "msg_phase", delta: "Working" },
        {
          type: "response.output_item.done",
          item: { type: "message", id: "msg_phase", phase: "commentary" },
        },
        { type: "response.completed", response: { id: "resp_phase" } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      expect(response.message.content[0]).toMatchObject({
        type: "text",
        text: "Working",
        providerMetadata: { openai: { phase: "commentary" } },
      })

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, messages: [response.message] }),
      )
      expect(prepared.body.input).toEqual([
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "Working" }],
        },
      ])
    }),
  )

  it.effect("preserves every explicit prompt_cache_breakpoint beyond OpenAI's implicit write capacity", () =>
    Effect.gen(function* () {
      const cache = new CacheHint({ type: "ephemeral" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).model("gpt-5.6"),
          system: { type: "text", text: "s", cache },
          messages: [
            Message.user([{ type: "text", text: "a", cache }]),
            Message.assistant({ type: "text", text: "ok" }),
            Message.user([{ type: "text", text: "b", cache }]),
            Message.assistant({ type: "text", text: "ok" }),
            Message.user([{ type: "text", text: "c", cache }]),
            Message.assistant({ type: "text", text: "ok" }),
            Message.user([{ type: "text", text: "d", cache }]),
          ],
        }),
      )

      const marked = prepared.body.input.flatMap((item) =>
        "content" in item && Array.isArray(item.content)
          ? item.content.filter(
              (part): part is { type: "input_text"; text: string; prompt_cache_breakpoint: unknown } =>
                "prompt_cache_breakpoint" in part && part.prompt_cache_breakpoint !== undefined,
            )
          : [],
      )
      expect(marked.map((part) => part.text)).toEqual(["s", "a", "b", "c", "d"])
    }),
  )

  it.effect("accepts the full ResponseIncludable union", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          providerOptions: {
            openai: {
              include: ["reasoning.encrypted_content", "code_interpreter_call.outputs", "web_search_call.results"],
            },
          },
        }),
      )

      expect(prepared.body.include).toEqual([
        "reasoning.encrypted_content",
        "code_interpreter_call.outputs",
        "web_search_call.results",
      ])
    }),
  )

  it.effect("filters unknown includable values out of the include array", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "hi",
          // The user passed one invalid entry alongside a valid one. Keep the
          // valid one so the request still succeeds rather than failing on a
          // typo from upstream config.
          providerOptions: { openai: { include: ["reasoning.encrypted_content", "bogus.thing"] } },
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("treats an explicit empty include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: [] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("treats an all-invalid include as no include at all", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { include: ["bogus.thing"] } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("omits include when no include is set", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "hi", providerOptions: { openai: { store: false } } }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("stores direct GPT-5 reasoning responses and requests encrypted state by default", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
        }),
      )

      expect(prepared.body.store).toBe(true)
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto" })
    }),
  )

  it.effect("enables stored retained reasoning and server compaction for direct GPT-5.6 Responses models", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.6"),
          prompt: "Keep this task state across a long session.",
        }),
      )

      expect(prepared.body.store).toBe(true)
      expect(prepared.body.reasoning).toEqual({ effort: "medium", summary: "auto", context: "all_turns" })
      expect(prepared.body.context_management).toEqual([{ type: "compaction", compact_threshold: 200_000 }])
    }),
  )

  it.effect("lets direct OpenAI callers explicitly keep GPT-5.6 stateless", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.6"),
          prompt: "Keep this request stateless.",
          providerOptions: {
            openai: {
              store: false,
              previousResponseId: "resp_ignored",
              continuationInputStart: 1,
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.previous_response_id).toBeUndefined()
      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("strips retained reasoning and compaction from pre-GPT-5.6 direct models", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.5"),
          prompt: "Use only supported controls.",
          providerOptions: {
            openai: {
              reasoningContext: "all_turns",
              contextManagement: [{ type: "compaction", compactThreshold: 400_000 }],
            },
          },
        }),
      )

      expect(prepared.body.store).toBe(true)
      expect(prepared.body.reasoning?.context).toBeUndefined()
      expect(prepared.body.context_management).toBeUndefined()
    }),
  )

  it.effect("honors direct OpenAI compaction overrides", () =>
    Effect.gen(function* () {
      const model = OpenAI.configure({
        baseURL: "https://api.openai.test/v1/",
        apiKey: "test",
        providerOptions: {
          openai: { contextManagement: [{ type: "compaction", compactThreshold: 400_000 }] },
        },
      }).responses("gpt-5.6")
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({ model, prompt: "Use a custom compaction threshold." }),
      )
      const disabled = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          prompt: "Do not use provider compaction.",
          providerOptions: { openai: { contextManagement: [] } },
        }),
      )

      expect(prepared.body.context_management).toEqual([{ type: "compaction", compact_threshold: 400_000 }])
      expect(disabled.body.context_management).toBeUndefined()
    }),
  )

  it.effect("lets callers opt out of the GPT-5 default include", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.2"),
          prompt: "hi",
          providerOptions: { openai: { include: [] } },
        }),
      )

      expect(prepared.body.include).toBeUndefined()
    }),
  )

  it.effect("request OpenAI provider options override route defaults", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAI.configure({
            baseURL: "https://api.openai.test/v1/",
            apiKey: "test",
            providerOptions: { openai: { promptCacheKey: "model_cache" } },
          }).model("gpt-4.1-mini"),
          prompt: "no cache",
          providerOptions: { openai: { promptCacheKey: "request_cache" } },
        }),
      )

      expect(prepared.body.prompt_cache_key).toBe("request_cache")
    }),
  )

  it.effect("parses text and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "!" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            service_tier: "default",
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              total_tokens: 7,
              input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 2,
        nonCachedInputTokens: 2,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 2,
        reasoningTokens: 0,
        totalTokens: 7,
        providerMetadata: {
          openai: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      })

      expect(response.text).toBe("Hello!")
      expect(
        (response.usage?.nonCachedInputTokens ?? 0) +
          (response.usage?.cacheReadInputTokens ?? 0) +
          (response.usage?.cacheWriteInputTokens ?? 0),
      ).toBe(response.usage?.inputTokens)
      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "text-delta", id: "msg_1", text: "!" },
        { type: "text-end", id: "msg_1" },
        {
          type: "step-finish",
          index: 0,
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
        {
          type: "finish",
          reason: "stop",
          providerMetadata: { openai: { responseId: "resp_1", serviceTier: "default" } },
          usage,
        },
      ])
    }),
  )

  it.effect("appends URL citations to canonical assistant text", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_text.delta", item_id: "msg_1", delta: "Read the documentation." },
              {
                type: "response.output_text.annotation.added",
                item_id: "msg_1",
                annotation: {
                  type: "url_citation",
                  title: "Effect Documentation",
                  url: "https://effect.website/docs",
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.text).toBe("Read the documentation.\n\nSource: Effect Documentation\nhttps://effect.website/docs")
      expect(response.message.content).toEqual([
        {
          type: "text",
          text: "Read the documentation.\n\nSource: Effect Documentation\nhttps://effect.website/docs",
        },
      ])
    }),
  )

  // OpenAI's documented stream orders output text within one message item; no
  // provider-valid same-kind overlap is evidenced, so done boundaries close it.
  it.effect("closes sequential output messages before starting the next", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_text.delta", item_id: "msg_1", delta: "First" },
              { type: "response.output_text.done", item_id: "msg_1" },
              { type: "response.output_text.delta", item_id: "msg_2", delta: "Second" },
              { type: "response.output_item.done", item: { type: "message", id: "msg_2" } },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type.startsWith("text-"))).toEqual([
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "First" },
        { type: "text-end", id: "msg_1" },
        { type: "text-start", id: "msg_2" },
        { type: "text-delta", id: "msg_2", text: "Second" },
        { type: "text-end", id: "msg_2" },
      ])
    }),
  )

  it.effect("parses reasoning summary stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
        { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
        { type: "response.reasoning_summary_text.done", item_id: "rs_1" },
        { type: "response.completed", response: { id: "resp_1" } },
      )

      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        { type: "reasoning-start", id: "rs_1" },
        { type: "reasoning-delta", id: "rs_1", text: "thinking" },
        { type: "text-start", id: "msg_1" },
        { type: "text-delta", id: "msg_1", text: "Hello" },
        { type: "reasoning-end", id: "rs_1" },
        { type: "text-end", id: "msg_1" },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
      expect(response.events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(response.message.content).toEqual([
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "Hello" },
      ])
    }),
  )

  it.effect("preserves encrypted reasoning metadata for continuation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
              {
                type: "response.output_item.done",
                item: {
                  type: "reasoning",
                  id: "rs_1",
                  encrypted_content: "encrypted-state",
                  summary: [{ type: "summary_text", text: "thinking" }],
                },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events).toContainEqual(
        expect.objectContaining({
          type: "reasoning-end",
          id: "rs_1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
      )
    }),
  )

  it.effect("streams each reasoning summary part as a separate block", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, { providerOptions: { openai: { store: false } } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.reasoning).toBe("FirstSecond")
      expect(response.events).toMatchObject([
        { type: "step-start", index: 0 },
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:0", text: "First" },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        {
          type: "reasoning-start",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        { type: "reasoning-delta", id: "rs_1:1", text: "Second" },
        {
          type: "reasoning-end",
          id: "rs_1:1",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        { type: "step-finish", index: 0, reason: "stop" },
        { type: "finish", reason: "stop" },
      ])
    }),
  )

  it.effect("closes reasoning summary parts when storage is not disabled", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, { providerOptions: { openai: { store: true } } }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.added",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "First" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: "Second" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: null },
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      expect(response.events.filter((event) => event.type === "reasoning-end")).toEqual([
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
        { type: "reasoning-end", id: "rs_1:1", providerMetadata: { openai: { itemId: "rs_1" } } },
      ])
    }),
  )

  it.effect("continues a stateless reasoning conversation", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_reasoning_continue",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = yield* Effect.promise(() => web.json())
              expect(body).toMatchObject({
                input: [
                  { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
                  {
                    type: "reasoning",
                    encrypted_content: "encrypted-state",
                    summary: [{ type: "summary_text", text: "Checked the previous diff." }],
                  },
                  { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
                  { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
                ],
              })
              expect(body.input[1]).not.toHaveProperty("id")
              return input.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Parser now round-trips reasoning." },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Parser now round-trips reasoning.")
    }),
  )

  it.effect("replays a server compaction item and drops prior stateless history", () =>
    Effect.gen(function* () {
      const opaque = {
        type: "compaction" as const,
        id: "cmp_provider_1",
        encrypted_content: "encrypted-compaction-state",
        future_field: { version: 2 },
      }
      const response = yield* LLMClient.generate(
        LLM.request({
          model,
          prompt: "Before compaction.",
          providerOptions: { openai: { store: false } },
        }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: opaque,
              },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [Message.user("Before compaction."), response.message, Message.user("After compaction.")],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "",
          providerMetadata: { openai: { opaqueCompactionItem: opaque } },
        },
      ])
      expect(prepared.body.input).toEqual([
        opaque,
        { role: "user", content: [{ type: "input_text", text: "After compaction." }] },
      ])
    }),
  )

  it.effect("preserves opaque compaction state across a stored GPT-5.6 continuation", () =>
    Effect.gen(function* () {
      const opaque = {
        type: "compaction" as const,
        id: "cmp_provider_stored_1",
        encrypted_content: "encrypted-compaction-state",
        future_field: { version: 2 },
      }
      const stored = OpenAI.configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).responses("gpt-5.6")
      const response = yield* LLMClient.generate(
        LLM.request({ model: stored, prompt: "Before compaction." }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item: opaque },
              { type: "response.completed", response: { id: "resp_stored_1" } },
            ),
          ),
        ),
      )

      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: stored,
          messages: [Message.user("Before compaction."), response.message, Message.user("After compaction.")],
          providerOptions: { openai: { previousResponseId: "resp_stored_1", continuationInputStart: 2 } },
        }),
      )

      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "",
          providerMetadata: { openai: { opaqueCompactionItem: opaque } },
        },
      ])
      expect(prepared.body.store).toBe(true)
      expect(prepared.body.previous_response_id).toBe("resp_stored_1")
      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "After compaction." }] },
      ])
    }),
  )

  it.effect("reconstructs legacy stateless compaction metadata when no opaque item exists", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Before compaction."),
            Message.assistant([
              {
                type: "reasoning",
                text: "",
                providerMetadata: {
                  openai: { itemId: "cmp_legacy", compactionEncryptedContent: "encrypted-legacy-state" },
                },
              },
            ]),
            Message.user("After compaction."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "compaction", id: "cmp_legacy", encrypted_content: "encrypted-legacy-state" },
        { role: "user", content: [{ type: "input_text", text: "After compaction." }] },
      ])
    }),
  )

  it.effect("preserves assistant content order around reasoning items", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_reasoning_order",
          model,
          messages: [
            Message.assistant([
              { type: "text", text: "Before." },
              {
                type: "reasoning",
                text: "Checked order.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: "encrypted-state",
                  },
                },
              },
              { type: "text", text: "After." },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "assistant", content: [{ type: "output_text", text: "Before." }] },
        {
          type: "reasoning",
          encrypted_content: "encrypted-state",
          summary: [{ type: "summary_text", text: "Checked order." }],
        },
        { role: "assistant", content: [{ type: "output_text", text: "After." }] },
      ])
    }),
  )

  it.effect("references stored reasoning items by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([{ type: "item_reference", id: "rs_1" }])
    }),
  )

  it.effect("references stored provider-executed hosted tool results by id", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: { query: "effect 4" },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              {
                type: "tool-result",
                id: "ws_1",
                name: "web_search",
                result: { type: "json", value: { type: "web_search_call", id: "ws_1", status: "completed" } },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              },
            ]),
            Message.user("Continue."),
          ],
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { type: "item_reference", id: "ws_1" },
        { role: "user", content: [{ type: "input_text", text: "Continue." }] },
      ])
    }),
  )

  it.effect("replays stateless hosted web search results", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "Effect release notes" },
      }
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Find the latest Effect release notes."),
            Message.assistant([
              ToolCallPart.make({
                id: "ws_1",
                name: "web_search",
                input: item.action,
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
              ToolResultPart.make({
                id: "ws_1",
                name: "web_search",
                result: item,
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ws_1" } },
              }),
            ]),
            Message.user("Summarize the relevant change."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Find the latest Effect release notes." }] },
        item,
        { role: "user", content: [{ type: "input_text", text: "Summarize the relevant change." }] },
      ])
    }),
  )

  it.effect("continues stateless hosted image generation with the generated image", () =>
    Effect.gen(function* () {
      const imageTool = OpenAI.imageGeneration({ action: "edit" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("Generate a black triangle."),
            Message.assistant([
              ToolCallPart.make({
                id: "ig_1",
                name: "image_generation",
                input: {},
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
              ToolResultPart.make({
                id: "ig_1",
                name: "image_generation",
                result: {
                  type: "content",
                  value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
                },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
            ]),
            Message.user("Make it blue."),
          ],
          tools: [imageTool],
        }),
      )

      expect(prepared.body.store).toBe(false)
      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Generate a black triangle." }] },
        { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AQID" }] },
        { role: "user", content: [{ type: "input_text", text: "Make it blue." }] },
      ])
    }),
  )

  it.effect("lowers configured image detail on stateless hosted image-generation continuation", () =>
    Effect.gen(function* () {
      const imageTool = OpenAI.imageGeneration({ action: "edit" })
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant([
              ToolResultPart.make({
                id: "ig_1",
                name: "image_generation",
                result: {
                  type: "content",
                  value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
                },
                providerExecuted: true,
                providerMetadata: { openai: { itemId: "ig_1" } },
              }),
            ]),
          ],
          tools: [imageTool],
          providerOptions: { openai: { imageDetail: "low" } },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AQID", detail: "low" }],
        },
      ])
    }),
  )

  it.effect("joins streamed summary blocks into one continuation reasoning item", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_multi_summary_continuation",
          model,
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "First",
                providerMetadata: { openai: { itemId: "rs_1" } },
              },
              {
                type: "reasoning",
                text: "Second",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
            ]),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          encrypted_content: "encrypted-state",
          summary: [
            { type: "summary_text", text: "First" },
            { type: "summary_text", text: "Second" },
          ],
        },
      ])
    }),
  )

  it.effect("skips non-persisted reasoning ids without encrypted state", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          id: "req_reasoning_without_encrypted_state",
          model,
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: {
                  openai: {
                    itemId: "rs_1",
                    reasoningEncryptedContent: null,
                  },
                },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
          providerOptions: { openai: { store: false } },
        }),
      )

      expect(prepared.body).toMatchObject({
        input: [
          { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
          { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
          { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
        ],
        store: false,
      })
    }),
  )

  it.effect("assembles streamed function call input", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query"' },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"weather"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"weather"}',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))
      const usage = new Usage({
        inputTokens: 5,
        outputTokens: 1,
        nonCachedInputTokens: 5,
        cacheReadInputTokens: undefined,
        reasoningTokens: undefined,
        totalTokens: 6,
        providerMetadata: { openai: { input_tokens: 5, output_tokens: 1 } },
      })

      expect(response.events).toEqual([
        { type: "step-start", index: 0 },
        {
          type: "tool-input-start",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: '{"query"',
        },
        {
          type: "tool-input-delta",
          id: "call_1",
          name: "lookup",
          text: ':"weather"}',
        },
        {
          type: "tool-input-end",
          id: "call_1",
          name: "lookup",
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { query: "weather" },
          providerExecuted: undefined,
          providerMetadata: { openai: { itemId: "item_1" } },
        },
        { type: "step-finish", index: 0, reason: "tool-calls", usage, providerMetadata: undefined },
        {
          type: "finish",
          reason: "tool-calls",
          providerMetadata: undefined,
          usage,
        },
      ])
    }),
  )

  it.effect("emits malformed final function arguments as an unexecuted tool error", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query":"streamed"}' },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"partial',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolInputError)).toEqual({
        type: "tool-input-error",
        id: "call_1",
        name: "lookup",
        raw: '{"query":"partial',
      })
      expect(response.finishReason).toBe("tool-calls")
      expect(response.events.some(LLMEvent.is.toolCall)).toBeFalse()
    }),
  )

  it.effect("settles malformed function arguments when output_item.added is absent", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"partial',
          },
        },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.events.find(LLMEvent.is.toolInputError)).toMatchObject({
        id: "call_1",
        name: "lookup",
        raw: '{"query":"partial',
      })
      expect(response.finishReason).toBe("tool-calls")
    }),
  )

  it.effect("decodes web_search_call as provider-executed tool-call + tool-result", () =>
    Effect.gen(function* () {
      const item = {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "effect 4" },
      }
      const body = sseEvents(
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const callsAndResults = response.events.filter(
        (event) => event.type === "tool-call" || event.type === "tool-result",
      )
      expect(callsAndResults).toEqual([
        {
          type: "tool-call",
          id: "ws_1",
          name: "web_search",
          input: { type: "search", query: "effect 4" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
        {
          type: "tool-result",
          id: "ws_1",
          name: "web_search",
          result: { type: "json", value: item },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "ws_1" } },
        },
      ])
    }),
  )

  it.effect("decodes image generation output as image content", () =>
    Effect.gen(function* () {
      const item = {
        type: "image_generation_call",
        id: "ig_1",
        status: "completed",
        result: "AQID",
      }
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.output_item.done", item },
              { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
            ),
          ),
        ),
      )

      expect(response.events.find(LLMEvent.is.toolResult)).toMatchObject({
        id: "ig_1",
        name: "image_generation",
        providerExecuted: true,
        result: {
          type: "content",
          value: [{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png" }],
        },
      })
    }),
  )

  it.effect("rejects malformed image generation base64", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              {
                type: "response.output_item.done",
                item: { type: "image_generation_call", id: "ig_bad", status: "completed", result: "%%%" },
              },
              { type: "response.completed", response: {} },
            ),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason._tag).toBe("InvalidProviderOutput")
      expect(error.message).toContain("invalid image base64")
    }),
  )

  it.effect("decodes code_interpreter_call as provider-executed events with code input", () =>
    Effect.gen(function* () {
      const item = {
        type: "code_interpreter_call",
        id: "ci_1",
        status: "completed",
        code: "print(1+1)",
        container_id: "cnt_xyz",
        outputs: [{ type: "logs", logs: "2\n" }],
      }
      const body = sseEvents(
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1 } } },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      const toolCall = response.events.find((event) => event.type === "tool-call")
      expect(toolCall).toEqual({
        type: "tool-call",
        id: "ci_1",
        name: "code_interpreter",
        input: { code: "print(1+1)", container_id: "cnt_xyz" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
      const toolResult = response.events.find((event) => event.type === "tool-result")
      expect(toolResult).toEqual({
        type: "tool-result",
        id: "ci_1",
        name: "code_interpreter",
        result: { type: "json", value: item },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "ci_1" } },
      })
    }),
  )

  it.effect("lowers user image content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==" }],
        },
      ])
    }),
  )

  it.effect("lowers configured image detail on user image content", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_media_detail",
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "high" } },
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==", detail: "high" }],
        },
      ])
    }),
  )

  it.effect("retains image detail through OpenAI provider option normalization", () =>
    Effect.gen(function* () {
      const configuredModel = OpenAI.configure({
        apiKey: "test",
        providerOptions: { openai: { imageDetail: "low" } },
      }).responses("gpt-4.1-mini")
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          id: "req_normalized_media_detail",
          model: configuredModel,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
        }),
      )

      expect(prepared.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==", detail: "low" }],
        },
      ])
    }),
  )

  it.effect("rejects unsupported image details and original on unsupported models", () =>
    Effect.gen(function* () {
      const invalidDetail = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "maximum" } },
        }),
      ).pipe(Effect.flip)
      expect(invalidDetail.reason).toMatchObject({ _tag: "InvalidRequest" })

      const unsupportedOriginal = yield* LLMClient.prepare(
        LLM.request({
          model,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "original" } },
        }),
      ).pipe(Effect.flip)
      expect(unsupportedOriginal.reason).toMatchObject({ _tag: "InvalidRequest" })

      const mini = OpenAIResponses.route.model({ id: "gpt-5.4-mini" })
      const unsupportedMiniOriginal = yield* LLMClient.prepare(
        LLM.request({
          model: mini,
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "original" } },
        }),
      ).pipe(Effect.flip)
      expect(unsupportedMiniOriginal.reason).toMatchObject({ _tag: "InvalidRequest" })

      const originalGpt54 = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAIResponses.route.model({ id: "gpt-5.4" }),
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "original" } },
        }),
      )
      expect(originalGpt54.body.input).toEqual([
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AAECAw==", detail: "original" }],
        },
      ])

      const prefixedGpt56 = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model: OpenAIResponses.route.model({ id: "openai/gpt-5.6" }),
          messages: [Message.user({ type: "media", mediaType: "image/png", data: "AAECAw==" })],
          providerOptions: { openai: { imageDetail: "original" } },
        }),
      )
      expect(prefixedGpt56.body.input).toEqual(originalGpt54.body.input)
    }),
  )

  it.effect("rejects unsupported user media content", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({
          id: "req_media",
          model,
          messages: [Message.user({ type: "media", mediaType: "application/pdf", data: "AAECAw==" })],
        }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("OpenAI Responses does not support media type application/pdf")
    }),
  )

  it.effect("fails with a typed rate limit for provider error frames", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "rate_limit_exceeded", message: "Slow down" }))),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "RateLimit", message: "rate_limit_exceeded: Slow down" })
    }),
  )

  it.effect("falls back to error code when no message is present", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error" }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "ProviderInternal", message: "internal_error" })
    }),
  )

  it.effect("falls back to error code when message is empty", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "internal_error", message: "" }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "ProviderInternal", message: "internal_error" })
    }),
  )

  // Regression: `response.failed` carries the failure details under
  // `response.error`, not at the top level. The previous handler only
  // checked top-level `message`/`code` and so always emitted the bare
  // "OpenAI Responses response failed" string, hiding the real cause.
  it.effect("surfaces response.failed details from response.error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: {
                id: "resp_failed_1",
                error: { code: "server_error", message: "Upstream model unavailable" },
              },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({
        _tag: "ProviderInternal",
        message: "server_error: Upstream model unavailable",
      })
    }),
  )

  it.effect("surfaces response.failed code when no nested message is present", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "response.failed",
              response: { id: "resp_failed_2", error: { code: "invalid_prompt" } },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", message: "invalid_prompt" })
    }),
  )

  it.effect("surfaces error event details nested under response.error", () =>
    Effect.gen(function* () {
      // Some OpenAI-compatible proxies and older SDK versions wrap the
      // top-level error fields into a nested `response.error` payload
      // when they bubble up an HTTP error as an SSE `error` event. Honour
      // both shapes so the user still sees the underlying cause instead
      // of the catch-all string.
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              response: { error: { code: "context_length_exceeded", message: "prompt too long" } },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "context_length_exceeded: prompt too long",
        classification: "context-overflow",
      })
    }),
  )

  it.effect("surfaces error event details nested under error", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              sequence_number: 2,
              error: {
                type: "invalid_request_error",
                code: "context_length_exceeded",
                message: "prompt too long",
                param: "input",
              },
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({
        _tag: "InvalidRequest",
        message: "context_length_exceeded: prompt too long",
        classification: "context-overflow",
      })
    }),
  )

  it.effect("accepts nullable fields in spec-compliant error events", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents({
              type: "error",
              code: null,
              message: "Something went wrong",
              param: null,
              sequence_number: 1,
            }),
          ),
        ),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider", message: "Something went wrong" })
    }),
  )

  it.effect("falls back to a stable default when error is null", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", error: null }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider", message: "OpenAI Responses stream error" })
    }),
  )

  it.effect("falls back to a stable default when both error and response are absent", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error" }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider", message: "OpenAI Responses stream error" })
    }),
  )

  it.effect("falls back to a stable default when response.failed has no error payload", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "response.failed", response: { id: "resp_failed_3" } }))),
        Effect.flip,
      )

      expect(error.reason).toMatchObject({ _tag: "UnknownProvider", message: "OpenAI Responses response failed" })
    }),
  )

  it.effect("fails HTTP provider errors before stream parsing", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          fixedResponse('{"error":{"type":"invalid_request_error","message":"Bad request"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect(error.message).toContain("HTTP 400")
    }),
  )
})
