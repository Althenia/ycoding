import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenRouter from "../../src/providers/openrouter"
import { it } from "../lib/effect"

describe("OpenRouter", () => {
  it.effect("prepares OpenRouter models through the Responses route", () =>
    Effect.gen(function* () {
      const model = OpenRouter.configure({ apiKey: "test-key" }).model("openai/gpt-4o-mini")

      expect(model).toMatchObject({
        id: "openai/gpt-4o-mini",
        provider: "openrouter",
        route: { id: "openrouter-responses" },
      })
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
