import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionContextBudget } from "@ycoding-ai/core/session/context-budget"

// Real registry values from the bundled models.dev snapshot: claude-sonnet-4-5 and gpt-4o.
const registry = [
  {
    ...ModelV2.Info.empty(ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-sonnet-4-5")),
    limit: { context: 1_000_000, output: 64_000 },
  },
  {
    ...ModelV2.Info.empty(ProviderV2.ID.make("openai"), ModelV2.ID.make("gpt-4o")),
    limit: { context: 128_000, output: 16_384 },
  },
] satisfies readonly ModelV2.Info[]

describe("resolveCapabilities", () => {
  test("derives capabilities from registry limits for a known model", () => {
    expect(
      SessionContextBudget.resolveCapabilities(
        registry,
        ProviderV2.ID.make("anthropic"),
        ModelV2.ID.make("claude-sonnet-4-5"),
      ),
    ).toEqual({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      contextSafetyMarginTokens: 4_096,
    })
  })

  test("returns undefined when the provider has no such model", () => {
    expect(
      SessionContextBudget.resolveCapabilities(
        registry,
        ProviderV2.ID.make("anthropic"),
        ModelV2.ID.make("no-such-model"),
      ),
    ).toBeUndefined()
  })

  test("returns undefined when the provider is not in the registry", () => {
    expect(
      SessionContextBudget.resolveCapabilities(
        registry,
        ProviderV2.ID.make("no-such-provider"),
        ModelV2.ID.make("gpt-4o"),
      ),
    ).toBeUndefined()
  })

  test("applies an explicit safety margin override", () => {
    const result = SessionContextBudget.resolveCapabilities(
      registry,
      ProviderV2.ID.make("openai"),
      ModelV2.ID.make("gpt-4o"),
      { safetyMarginTokens: 4_096 },
    )
    expect(result?.contextSafetyMarginTokens).toBe(4_096)
  })
})

describe("safeInputBudget", () => {
  const capabilities = { contextWindowTokens: 128_000, maxOutputTokens: 16_384, contextSafetyMarginTokens: 1_024 }

  test("subtracts the model output limit and safety margin from the context window", () => {
    expect(SessionContextBudget.safeInputBudget(capabilities)).toBe(128_000 - 16_384 - 1_024)
  })

  test("exposes zero and negative hard input caps without clamping", () => {
    expect(
      SessionContextBudget.safeInputBudget({
        contextWindowTokens: 100,
        maxOutputTokens: 80,
        contextSafetyMarginTokens: 20,
      }),
    ).toBe(0)
    expect(
      SessionContextBudget.safeInputBudget({
        contextWindowTokens: 100,
        maxOutputTokens: 80,
        contextSafetyMarginTokens: 21,
      }),
    ).toBe(-1)
  })
})

describe("sumInputTokens", () => {
  test("sums every provided component and treats missing ones as zero", () => {
    const budget = SessionContextBudget.sumInputTokens({
      systemInstructions: 2_000,
      toolDefinitions: 1_500,
      workspaceInstructions: 3_000,
      rollingSummary: 4_000,
      recentMessages: 5_500,
      attachments: 800,
      retrievedContext: 2_200,
      providerOverhead: 300,
    })
    expect(budget).toBe(2_000 + 1_500 + 3_000 + 4_000 + 5_500 + 800 + 2_200 + 300)
  })

  test("returns zero when no components are provided", () => {
    expect(SessionContextBudget.sumInputTokens({})).toBe(0)
  })
})

describe("countTokens", () => {
  test("delegates to the shared character-based estimate", () => {
    expect(SessionContextBudget.countTokens("a".repeat(40))).toBe(10)
    expect(SessionContextBudget.countTokens("")).toBe(0)
  })
})
