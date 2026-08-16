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
      SessionContextBudget.resolveCapabilities(registry, ProviderV2.ID.make("anthropic"), ModelV2.ID.make("claude-sonnet-4-5")),
    ).toEqual({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      contextSafetyMarginTokens: 0,
    })
  })

  test("returns undefined when the provider has no such model", () => {
    expect(
      SessionContextBudget.resolveCapabilities(registry, ProviderV2.ID.make("anthropic"), ModelV2.ID.make("no-such-model")),
    ).toBeUndefined()
  })

  test("returns undefined when the provider is not in the registry", () => {
    expect(
      SessionContextBudget.resolveCapabilities(registry, ProviderV2.ID.make("no-such-provider"), ModelV2.ID.make("gpt-4o")),
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

  test("reserves output tokens and the safety margin by default", () => {
    expect(SessionContextBudget.safeInputBudget(capabilities)).toBe(128_000 - 16_384 - 1_024)
  })

  test("honors an explicit reserved output reservation", () => {
    expect(SessionContextBudget.safeInputBudget(capabilities, 32_000)).toBe(128_000 - 32_000 - 1_024)
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

describe("classifyPressure", () => {
  test("is normal below the informational threshold", () => {
    expect(SessionContextBudget.classifyPressure(24, 100)).toBe("normal")
  })

  test("is informational at exactly 0.25", () => {
    expect(SessionContextBudget.classifyPressure(25, 100)).toBe("informational")
  })

  test("is advisory at exactly 0.50", () => {
    expect(SessionContextBudget.classifyPressure(50, 100)).toBe("advisory")
  })

  test("is high at exactly 0.75", () => {
    expect(SessionContextBudget.classifyPressure(75, 100)).toBe("high")
  })

  test("is critical at exactly 0.90", () => {
    expect(SessionContextBudget.classifyPressure(90, 100)).toBe("critical")
  })

  test("is terminal at and above the safe input budget", () => {
    expect(SessionContextBudget.classifyPressure(100, 100)).toBe("terminal")
    expect(SessionContextBudget.classifyPressure(120, 100)).toBe("terminal")
  })

  test("classifies values between each milestone", () => {
    expect(SessionContextBudget.classifyPressure(49, 100)).toBe("informational")
    expect(SessionContextBudget.classifyPressure(74, 100)).toBe("advisory")
    expect(SessionContextBudget.classifyPressure(89, 100)).toBe("high")
  })

  test("is terminal when the safe limit is not positive", () => {
    expect(SessionContextBudget.classifyPressure(1, 0)).toBe("terminal")
    expect(SessionContextBudget.classifyPressure(1, -5)).toBe("terminal")
  })

  test("honors custom thresholds", () => {
    expect(
      SessionContextBudget.classifyPressure(10, 100, {
        informational: 0.05,
        advisory: 0.1,
        high: 0.2,
        critical: 0.4,
        terminal: 0.8,
      }),
    ).toBe("advisory")
  })
})

describe("changed", () => {
  test("is true only when the pressure level changes", () => {
    expect(SessionContextBudget.changed("normal", "advisory")).toBe(true)
    expect(SessionContextBudget.changed("informational", "advisory")).toBe(true)
    expect(SessionContextBudget.changed("high", "critical")).toBe(true)
    expect(SessionContextBudget.changed("advisory", "normal")).toBe(true)
    expect(SessionContextBudget.changed("normal", "normal")).toBe(false)
  })

  test("is false when the ratio changes within the same level", () => {
    const before = SessionContextBudget.classifyPressure(30, 100)
    const after = SessionContextBudget.classifyPressure(40, 100)
    expect(before).toBe("informational")
    expect(SessionContextBudget.changed(before, after)).toBe(false)
  })
})
