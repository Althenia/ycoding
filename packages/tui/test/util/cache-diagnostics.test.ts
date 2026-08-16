import { expect, test } from "bun:test"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import {
  formatCacheDiagnostics,
  formatDiagnosticsModel,
  formatProviderRequestDiagnostics,
  type ProviderRequestDiagnostics,
} from "../../src/util/cache-diagnostics"

const diagnostics: SessionCacheDiagnostics = {
  model: { id: "model", providerID: "openai" },
  context: { total: 1_030, limit: 2_000, remaining: 970, percent: 52 },
  tokens: { uncachedInput: 100, output: 20, reasoning: 10, cacheRead: 900, cacheWrite: 0 },
  cache: {
    eligible: 1_000,
    hitRatio: 0.9,
    mechanism: "openai-prefix-cache",
    readReported: true,
    writeReported: true,
  },
  estimatedCost: 0.0123,
}

test("formats provider context and prompt cache diagnostics", () => {
  expect(formatCacheDiagnostics(diagnostics)).toEqual({
    model: "openai/model",
    context: "Context 1.0k/2.0k (52%; includes cached)",
    cache: "Prompt 90% · 900 read · 0 write · 100 uncached",
  })
})

test("distinguishes missing provider telemetry from a confirmed zero", () => {
  expect(
    formatCacheDiagnostics({
      ...diagnostics,
      context: { total: 105 },
      tokens: { ...diagnostics.tokens, cacheRead: 0, cacheWrite: 0 },
      cache: {
        eligible: 100,
        mechanism: "anthropic-cache-control",
        readReported: true,
        writeReported: false,
        hitRatio: 0,
      },
    }),
  ).toEqual({
    model: "openai/model",
    context: "Context 105 (includes cached)",
    cache: "Prompt 0% · 0 read · not reported write · 100 uncached",
  })
})

test("handles missing limits and cache categories safely", () => {
  expect(
    formatCacheDiagnostics({
      ...diagnostics,
      context: { total: 5 },
      tokens: { ...diagnostics.tokens, cacheRead: 0, cacheWrite: 0 },
      cache: {
        eligible: 0,
        mechanism: "none",
        readReported: false,
        writeReported: false,
      },
    }),
  ).toEqual({
    model: "openai/model",
    context: "Context 5 (includes cached)",
    cache: "Prompt n/a · not reported read · not reported write · 100 uncached",
  })
})

test("formats bounded local provider request diagnostics", () => {
  expect(
    formatProviderRequestDiagnostics({
      logical: 6,
      physical: 7,
      helpers: 1,
      continued: 3,
      fallback: 1,
      cost: 0.0421,
      tokens: { input: 12_000, output: 900, reasoning: 300, cache: { read: 18_200, write: 1_200 } },
      latestInvalidation: "tool-prefix-changed",
      latestNamespace: "a1b2c3d4",
    } as never),
  ).toEqual({
    logical: "6",
    physical: "7",
    helpers: "1",
    continued: "3",
    fallback: "1",
    uncachedInput: "12.0k tokens",
    cacheRead: "18.2k tokens",
    cacheWrite: "1.2k tokens",
    output: "900 tokens",
    reasoning: "300 tokens",
    estimatedCost: "$0.0421",
    latestInvalidation: "Tool prefix changed",
    latestNamespace: "a1b2c3d4",
  })
})

test("keeps unavailable request pricing distinct from a confirmed free request", () => {
  const base = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  expect(formatProviderRequestDiagnostics(base as never).estimatedCost).toBe("unavailable")
  expect(formatProviderRequestDiagnostics({ ...base, cost: 0 } as never).estimatedCost).toBe("$0.0000")
})

test("labels cache reset diagnostics", () => {
  const base: ProviderRequestDiagnostics = {
    logical: 1,
    physical: 1,
    helpers: 0,
    continued: 0,
    fallback: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }

  expect(formatProviderRequestDiagnostics({ ...base, latestInvalidation: "compaction-reset" }).latestInvalidation).toBe(
    "Compaction reset",
  )
  expect(formatProviderRequestDiagnostics({ ...base, latestInvalidation: "model-switched" }).latestInvalidation).toBe(
    "Model switched",
  )
  expect(
    formatProviderRequestDiagnostics({ ...base, latestInvalidation: "model-variant-switched" }).latestInvalidation,
  ).toBe("Model variant switched")
})

test("omits an unavailable diagnostics model without inventing a variant", () => {
  expect(formatDiagnosticsModel(undefined)).toBeUndefined()
})

test("formats provider, model, and variant identity exactly", () => {
  expect(formatDiagnosticsModel({ providerID: "anthropic", id: "claude-sonnet-4", variant: "thinking" })).toBe(
    "anthropic/claude-sonnet-4#thinking",
  )
})
