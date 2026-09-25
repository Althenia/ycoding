import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenRouter from "../../src/providers/openrouter"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"
import { applyCachePolicy } from "../../src/cache-policy"

describe("OpenRouter", () => {
  it.effect("prepares OpenRouter models through the Responses route", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-4o-mini")

      expect(model).toMatchObject({
        id: "openai/gpt-4o-mini",
        provider: "openrouter",
        route: { id: "openrouter-responses" },
      })
      expect(model.route.providerMetadataKey).toBe("openai")
      expect(model.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))

      expect(prepared.route).toBe("openrouter-responses")
      expect(prepared.body).toMatchObject({
        model: "openai/gpt-4o-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        stream: true,
      })
    }),
  )

  it.effect("applies OpenRouter payload options from the model helper", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({
            apiKey: "test-key",
            providerOptions: {
              openrouter: {
                usage: true,
                reasoning: { effort: "high" },
                promptCacheKey: "session_123",
                sessionID: "cache_namespace_123",
              },
            },
          }).model("anthropic/claude-3.7-sonnet:thinking"),
          prompt: "Think briefly.",
        }),
      )

      expect(prepared.body).toMatchObject({
        usage: { include: true },
        reasoning: { effort: "high" },
        prompt_cache_key: "session_123",
        session_id: "cache_namespace_123",
      })
    }),
  )

  it.effect("enables OpenRouter's automatic Anthropic prompt cache on Responses", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("anthropic/claude-sonnet-4.6"),
          cache: { tools: true, system: true, messages: { tail: 2 }, ttlSeconds: 3600 },
          system: "Stable instructions.",
          prompt: "Continue.",
        }),
      )

      expect(prepared.body).toMatchObject({
        cache_control: { type: "ephemeral", ttl: "1h" },
      })
    }),
  )

  it.effect("omits automatic cache fields for GPT-5.6 while preserving explicit cache options", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-5.6-sol")
      const implicit = yield* LLMClient.prepare(
        LLM.request({
          model,
          prompt: "Stable prompt.",
          providerOptions: {
            openai: { promptCacheKey: "session-key", promptCacheOptions: { mode: "implicit", ttl: "30m" } },
          },
        }),
      )
      const explicit = yield* LLMClient.prepare(
        applyCachePolicy(
          LLM.request({
            model,
            system: "Stable instructions.",
            messages: [
              Message.user("Stable prompt."),
              new Message({ role: "user", content: [{ type: "text", text: "Volatile suffix." }], volatile: true }),
            ],
            cache: "auto",
            providerOptions: {
              openai: { promptCacheKey: "session-key", promptCacheOptions: { mode: "implicit", ttl: "30m" } },
            },
          }),
        ),
      )

      expect(implicit.body.prompt_cache_options).toBeUndefined()
      expect(implicit.body.cache_control).toBeUndefined()
      expect(explicit.body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" })
    }),
  )

  it.effect("limits top-level cache_control to Anthropic models", () =>
    Effect.gen(function* () {
      const prepare = (modelID: string) =>
        LLMClient.prepare(
          LLM.request({
            model: OpenRouter.configure({ apiKey: "test-key" }).model(modelID),
            cache: { tools: true, system: true, messages: { tail: 1 }, ttlSeconds: 3600 },
            prompt: "Continue.",
          }),
        )
      const anthropic = yield* prepare("~anthropic/claude-sonnet-4.6")
      const deepseek = yield* prepare("deepseek/deepseek-v4-pro")

      expect(anthropic.body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
      expect(deepseek.body.cache_control).toBeUndefined()
    }),
  )

  it.effect("defaults GPT-5.6 retained reasoning and merges OpenRouter reasoning options", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-5.6-sol"),
          prompt: "Think.",
          providerOptions: { openrouter: { reasoning: { effort: "high", summary: "detailed" } } },
        }),
      )

      expect(prepared.body.include).toContain("reasoning.encrypted_content")
      expect(prepared.body.reasoning).toEqual({ effort: "high", summary: "detailed", context: "all_turns" })
      expect(prepared.body.context_management).toBeUndefined()
    }),
  )

  it.effect("retains encrypted reasoning after summary completion and replays it on the next step", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-5.6-sol")
      const response = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Think through this." }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(
              { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
              { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Reasoning" },
              { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
              {
                type: "response.output_item.done",
                item: { type: "reasoning", id: "rs_1", encrypted_content: "encrypted-state" },
              },
              { type: "response.output_text.delta", item_id: "msg_1", delta: "Answer" },
              { type: "response.completed", response: { id: "resp_1" } },
            ),
          ),
        ),
      )
      const reasoningEnd = response.events.find((event) => event.type === "reasoning-end")
      expect(reasoningEnd).toMatchObject({
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
      })

      const followUp = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model,
          messages: [
            Message.assistant({
              type: "reasoning",
              text: "Reasoning",
              providerMetadata: reasoningEnd?.providerMetadata,
            }),
            Message.user("Continue."),
          ],
        }),
      )
      expect(followUp.body.input).toContainEqual(
        expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted-state" }),
      )
    }),
  )

  it.effect("preserves manually supplied reasoning details", () =>
    Effect.gen(function* () {
      const details = [
        { type: "reasoning.text", text: "Think", format: "anthropic-claude-v1", index: 0 },
        { type: "reasoning.text", text: "ing", format: "anthropic-claude-v1", index: 0 },
        { type: "reasoning.text", signature: "signed", format: "anthropic-claude-v1", index: 0 },
        { type: "reasoning.encrypted", data: "opaque", format: "openai-responses-v1", index: 1 },
      ]
      const prepared = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("anthropic/claude-sonnet-4.6"),
          messages: [
            Message.assistant([
              {
                type: "reasoning",
                text: "Thinking",
                providerMetadata: { openai: { reasoningField: "reasoning", reasoningDetails: details } },
              },
            ]),
          ],
        }),
      )

      expect(prepared.body.input).toBeDefined()
    }),
  )

  it.effect("preserves opaque and duplicate continuation details", () =>
    Effect.gen(function* () {
      const details = [
        { type: "reasoning.future", format: "provider-v2", state: { opaque: true } },
        { type: "reasoning.encrypted", id: "state", data: "opaque" },
        { type: "reasoning.encrypted", id: "state", data: "opaque" },
      ]
      const prepared = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("anthropic/claude-sonnet-4.6"),
          messages: [
            Message.assistant({
              type: "reasoning",
              text: "Thinking",
              providerMetadata: { openai: { reasoningField: "reasoning", reasoningDetails: details } },
            }),
          ],
        }),
      )

      expect(prepared.body.input).toBeDefined()
    }),
  )

  it.effect("does not merge distinct adjacent reasoning text blocks", () =>
    Effect.gen(function* () {
      const details = [
        { type: "reasoning.text", id: "first", index: 0, text: "A", opaque: "first" },
        { type: "reasoning.text", id: "second", index: 1, text: "B", opaque: "second" },
      ]
      const prepared = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("anthropic/claude-sonnet-4.6"),
          messages: [
            Message.assistant({
              type: "reasoning",
              text: "AB",
              providerMetadata: { openai: { reasoningField: "reasoning", reasoningDetails: details } },
            }),
          ],
        }),
      )

      expect(prepared.body.input).toBeDefined()
    }),
  )

  it.effect("omits scalar reasoning without continuation details", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("anthropic/claude-sonnet-4.6"),
          messages: [Message.assistant({ type: "reasoning", text: "Thinking" })],
        }),
      )

      expect(prepared.body.input).toBeDefined()
    }),
  )

  it.effect("replays stored reasoning as stateless input instead of item_reference", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenRouter.OpenRouterBody>(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "test-key" }).model("meta/muse-spark-1.3-contributor"),
          system: "Stable instructions.",
          messages: [
            Message.user("What changed?"),
            Message.assistant([
              {
                type: "reasoning",
                text: "Checked the previous diff.",
                providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
              },
              { type: "text", text: "The parser changed." },
            ]),
            Message.user("Summarize it."),
          ],
        }),
      )

      // OpenRouter Responses is stateless and rejects `item_reference`; the
      // shared Responses lowerer must see store:false so it replays the full
      // reasoning item instead of emitting a stored id reference.
      expect(prepared.body.input).toEqual([
        { role: "system", content: "Stable instructions." },
        { role: "user", content: [{ type: "input_text", text: "What changed?" }] },
        {
          type: "reasoning",
          encrypted_content: "encrypted-state",
          summary: [{ type: "summary_text", text: "Checked the previous diff." }],
        },
        { role: "assistant", content: [{ type: "output_text", text: "The parser changed." }] },
        { role: "user", content: [{ type: "input_text", text: "Summarize it." }] },
      ])
      expect(prepared.body.store).toBeUndefined()
      expect(prepared.body.previous_response_id).toBeUndefined()
    }),
  )
})
