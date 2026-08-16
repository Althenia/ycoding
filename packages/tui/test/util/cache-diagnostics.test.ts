import { expect, test } from "bun:test"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { formatCacheDiagnostics, formatDiagnosticsModel } from "../../src/util/cache-diagnostics"

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
    context: "Context 1.0K/2.0K (52%; includes cached)",
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

test("omits an unavailable diagnostics model without inventing a variant", () => {
  expect(formatDiagnosticsModel(undefined)).toBeUndefined()
})

test("formats provider, model, and variant identity exactly", () => {
  expect(formatDiagnosticsModel({ providerID: "anthropic", id: "claude-sonnet-4", variant: "thinking" })).toBe(
    "anthropic/claude-sonnet-4#thinking",
  )
})
