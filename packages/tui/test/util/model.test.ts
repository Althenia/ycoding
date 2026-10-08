import { describe, expect, test } from "bun:test"
import { formatRef, parse, switchLabel } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toBeUndefined()
  })

  test("parses profile and variant from model references", () => {
    expect(parse("Work#openrouter/openai/gpt-6-luna#high")).toEqual({
      providerID: "openrouter",
      modelID: "openai/gpt-6-luna",
      profile: "Work",
      variant: "high",
    })
  })

  test("includes the selected variant in model switch notices", () => {
    expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "thinking" })).toBe(
      "Switched model to anthropic/sonnet#thinking",
    )
    expect(switchLabel({ providerID: "anthropic", id: "sonnet" })).toBe("Switched model to anthropic/sonnet")
  })

  test("formats profile-qualified model references", () => {
    expect(formatRef({ providerID: "openai", id: "gpt-6-luna", profile: "Work", variant: "high" })).toBe(
      "Work#openai/gpt-6-luna#high",
    )
    expect(switchLabel({ providerID: "missing", id: "model", profile: "Work", variant: "high" })).toBe(
      "Switched model to Work#missing/model#high",
    )
    expect(
      switchLabel(
        { providerID: "openai", id: "gpt-5", profile: "Work", variant: "high" },
        undefined,
        { providerID: "openai", id: "gpt-5", profile: "Personal", variant: "low" },
      ),
    ).toBe("Switched profile to Work (variant high)")
    expect(
      switchLabel(
        { providerID: "openai", id: "gpt-5" },
        undefined,
        { providerID: "openai", id: "gpt-5", profile: "Work" },
      ),
    ).toBe("Switched profile to provider default")
  })

  test("uses the catalog display name in model switch notices", () => {
    const models = [
      { providerID: "openai", id: "gpt-5.5-fast", name: "GPT-5.5 Fast" },
      { providerID: "anthropic", id: "sonnet", name: "Claude Sonnet" },
    ]
    expect(switchLabel({ providerID: "openai", id: "gpt-5.5-fast", variant: "high" }, models)).toBe(
      "Switched model to GPT-5.5 Fast (high)",
    )
    expect(switchLabel({ providerID: "anthropic", id: "sonnet" }, models)).toBe("Switched model to Claude Sonnet")
    expect(switchLabel({ providerID: "removed", id: "gone", variant: "high" }, models)).toBe(
      "Switched model to removed/gone#high",
    )
  })

  test("distinguishes variant-only switches from model switches", () => {
    const previous = { providerID: "openai", id: "gpt-5.5", variant: "medium" }

    expect(switchLabel({ ...previous, variant: "high" }, undefined, previous)).toBe("Switched variant to high")
    expect(switchLabel({ providerID: "openai", id: "gpt-5.5" }, undefined, previous)).toBe("Cleared variant selection")
    expect(switchLabel({ providerID: "openai", id: "gpt-5.5", variant: "default" }, undefined, previous)).toBe(
      "Switched variant to default",
    )
    expect(switchLabel({ providerID: "anthropic", id: "sonnet", variant: "high" }, undefined, previous)).toBe(
      "Switched model to anthropic/sonnet#high",
    )
  })
})
