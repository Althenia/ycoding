import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"

const decode = Schema.decodeUnknownSync(ProviderRequest.Record)
const decodeSpend = Schema.decodeUnknownSync(ProviderRequest.ModelSpend)

const record = {
  id: "prq_123",
  sessionID: "ses_123",
  inputID: "msg_123",
  source: "step",
  agent: "build",
  model: { providerID: "openai", id: "gpt-5.6", variant: "high" },
  routeID: "openai-responses",
  promptCacheKey: "cache-key",
  systemDigest: "system-digest",
  toolDigest: "tool-digest",
  request: 1,
  attempts: 2,
  invalidation: "stable-hit",
  continuation: "full",
  cost: 0.01,
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 50 } },
  time: 1,
}

test("decodes content-free provider request records", () => {
  const decoded = decode(record)
  expect(decoded.source).toBe("step")
  expect(decoded.attempts).toBe(2)
  expect(decoded.tokens.cache.read).toBe(900)
  expect(decoded).not.toHaveProperty("prompt")
  expect(decoded).not.toHaveProperty("body")
})

test("rejects unknown sources and non-positive counters", () => {
  expect(() => decode({ ...record, source: "background" })).toThrow()
  expect(() => decode({ ...record, request: 0 })).toThrow()
  expect(() => decode({ ...record, attempts: 0 })).toThrow()
})

test("decodes cache reset invalidation reasons", () => {
  for (const invalidation of ["compaction-reset", "model-switched", "model-variant-switched"] as const)
    expect(decode({ ...record, invalidation }).invalidation).toBe(invalidation)
})

test("requires cost provenance for priced model spend", () => {
  const spend = {
    model: record.model,
    requests: 1,
    tokens: record.tokens,
    cost: record.cost,
  }
  expect(() => decodeSpend(spend)).toThrow()
  expect(() => decodeSpend({ ...spend, cost: undefined, costProvenance: "recorded" })).toThrow()
  expect(decodeSpend({ ...spend, costProvenance: "recorded" }).costProvenance).toBe("recorded")
  expect(decodeSpend({ ...spend, costProvenance: "current_catalog" }).costProvenance).toBe("current_catalog")
  expect(decodeSpend({ model: record.model, requests: 1, tokens: record.tokens })).not.toHaveProperty("costProvenance")
})
