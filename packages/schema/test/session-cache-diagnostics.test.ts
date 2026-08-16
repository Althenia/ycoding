import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionCacheDiagnostics } from "@ycoding-ai/schema/session-cache-diagnostics"

const decode = Schema.decodeUnknownSync(SessionCacheDiagnostics.Info)

const diagnostics = {
  model: { providerID: "openai", id: "gpt" },
  context: { total: 1_000, limit: 2_000, remaining: 1_000, percent: 50 },
  tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 0 },
  cache: {
    eligible: 1_000,
    hitRatio: 0.9,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: false,
  },
  application: {
    overall: { hits: 4, attempts: 10, hitRatio: 0.4 },
    layers: {
      exactReplay: { hits: 3, attempts: 4, hitRatio: 0.75 },
      artifactRetrieval: { hits: 2, attempts: 5, hitRatio: 0.4 },
      artifactAdaptation: { hits: 1, attempts: 2, hitRatio: 0.5 },
    },
    retrieval: {
      queries: 12,
      candidates: 4,
      eligible: 2,
      accepted: 1,
      blockedNoCheaperModel: 1,
    },
  },
  estimatedCost: 0.01,
}

test("keeps only provider-native cache diagnostics", () => {
  const result = decode(diagnostics)
  expect(result.cache).toEqual({
    eligible: 1_000,
    hitRatio: 0.9,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: false,
  })
  expect("application" in result).toBe(false)
})

test("preserves missing provider write telemetry instead of fabricating a zero report", () => {
  const result = decode(diagnostics)
  expect(result.tokens.cacheWrite).toBe(0)
  expect(result.cache.writeReported).toBe(false)
})

test("rejects unknown provider cache mechanisms", () => {
  expect(() =>
    decode({
      ...diagnostics,
      cache: { ...diagnostics.cache, mechanism: "unknown-cache" },
    }),
  ).toThrow()
})
