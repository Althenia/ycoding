import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, type Usage } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenAI from "../../src/providers/openai"
import { LARGE_CACHEABLE_SYSTEM } from "../recorded-scenarios"
import { recordedTests } from "../recorded-test"

const model = OpenAI.configure({
  apiKey: process.env.OPENAI_API_KEY ?? "fixture",
  providerOptions: { openai: { store: false } },
}).responses("gpt-4.1-mini")

// OpenAI caches prefixes automatically once they cross the 1024-token threshold;
// `CacheHint` is a no-op for the wire body. The stable signal is the
// `prompt_cache_key` routing hint, which keeps repeated calls on the same shard
// so cache hits are observable.
const cacheRequest = LLM.request({
  id: "recorded_openai_responses_cache",
  model,
  system: LARGE_CACHEABLE_SYSTEM,
  prompt: "Say hi.",
  generation: { maxTokens: 16, temperature: 0 },
  providerOptions: { openai: { promptCacheKey: "recorded-cache-test" } },
})

const inputBreakdown = (usage: Usage | undefined) =>
  (usage?.nonCachedInputTokens ?? 0) +
  (usage?.cacheReadInputTokens ?? 0) +
  (usage?.cacheWriteInputTokens ?? 0)

const recorded = recordedTests({
  prefix: "openai-responses-cache",
  provider: "openai",
  protocol: "openai-responses",
  requires: ["OPENAI_API_KEY"],
  // Two identical requests in one cassette — replay walks the cassette in
  // recording order so the second call replays the cached-hit interaction,
  // not the cold-miss one.
})

describe("OpenAI Responses cache recorded", () => {
  recorded.effect.with("reports cached_tokens on identical second call", { tags: ["cache"] }, () =>
    Effect.gen(function* () {
      const first = yield* LLMClient.generate(cacheRequest)
      expect(first.usage?.cacheReadInputTokens ?? 0).toBeGreaterThanOrEqual(0)
      expect(inputBreakdown(first.usage)).toBe(first.usage?.inputTokens)

      const second = yield* LLMClient.generate(cacheRequest)
      expect(inputBreakdown(second.usage)).toBe(second.usage?.inputTokens)
      expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
    }),
  )
})
