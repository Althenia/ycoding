import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, type Usage } from "../../src"
import { LLMClient } from "../../src/route"
import * as Google from "../../src/providers/google"
import { LARGE_CACHEABLE_SYSTEM } from "../recorded-scenarios"
import { recordedTests } from "../recorded-test"

const model = Google.configure({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "fixture",
}).model("gemini-2.5-flash")

// Gemini does implicit prefix caching on 2.5+ models above ~1024 tokens. The
// `CacheHint` is currently a no-op for Gemini (the explicit `CachedContent`
// API is out-of-band and intentionally not wired up). This test exists to
// pin the usage-parsing path: `cachedContentTokenCount` should surface as
// `cacheReadInputTokens` on the second identical call.
const cacheRequest = LLM.request({
  id: "recorded_gemini_cache",
  model,
  system: LARGE_CACHEABLE_SYSTEM,
  prompt: "Say hi.",
  generation: { maxTokens: 16, temperature: 0 },
})

const inputBreakdown = (usage: Usage | undefined) =>
  (usage?.nonCachedInputTokens ?? 0) +
  (usage?.cacheReadInputTokens ?? 0) +
  (usage?.cacheWriteInputTokens ?? 0)

const recorded = recordedTests({
  prefix: "gemini-cache",
  provider: "google",
  protocol: "gemini",
  requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  // Two identical requests in one cassette — replay walks the cassette in
  // recording order so the second call replays the cached-hit interaction.
})

describe("Gemini cache recorded", () => {
  recorded.effect.with("reports cachedContentTokenCount on identical second call", { tags: ["cache"] }, () =>
    Effect.gen(function* () {
      const first = yield* LLMClient.generate(cacheRequest)
      expect(first.usage?.cacheReadInputTokens ?? 0).toBeGreaterThanOrEqual(0)
      expect(inputBreakdown(first.usage)).toBe(first.usage?.inputTokens)

      const second = yield* LLMClient.generate(cacheRequest)
      expect(inputBreakdown(second.usage)).toBe(second.usage?.inputTokens)
      // The recorded second response reports cachedContentTokenCount=1100.
      expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
    }),
  )
})
