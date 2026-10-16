import { describe, expect, test } from "bun:test"
import { Config } from "@ycoding-ai/core/config"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Schema } from "effect"

const decode = (model_fallbacks: unknown) => Schema.decodeUnknownSync(Config.Info)({ model_fallbacks }).model_fallbacks

describe("model_fallbacks configuration", () => {
  test("decodes short and explicit selections keyed by provider and model", () => {
    expect(
      decode({
        "anthropic/claude-opus-5": [
          "openai/gpt-6-sol#high",
          "Work#anthropic/claude-opus-5",
          { providerID: "openrouter", model: "openai/gpt-5" },
        ],
      }),
    ).toEqual({
      "anthropic/claude-opus-5": [
        { providerID: Provider.ID.make("openai"), model: Model.ID.make("gpt-6-sol"), variant: Model.VariantID.make("high") },
        { providerID: Provider.ID.make("anthropic"), model: Model.ID.make("claude-opus-5"), profile: "Work" },
        { providerID: Provider.ID.make("openrouter"), model: Model.ID.make("openai/gpt-5") },
      ],
    })
  })

  test("accepts a model ID that contains a slash", () => {
    expect(decode({ "openrouter/openai/gpt-5": ["openai/gpt-6-sol"] })).toHaveProperty(["openrouter/openai/gpt-5"])
  })

  test("rejects more than three entries, duplicates, a bare self reference, and malformed keys or entries", () => {
    for (const invalid of [
      { "anthropic/claude-opus-5": ["fake/a", "fake/b", "fake/c", "fake/d"] },
      { "anthropic/claude-opus-5": ["fake/a", "fake/a"] },
      { "anthropic/claude-opus-5": ["anthropic/claude-opus-5"] },
      { "claude-opus-5": ["fake/a"] },
      { "anthropic/claude-opus-5#high": ["fake/a"] },
      { "anthropic/claude-opus-5": ["gpt-5"] },
    ])
      expect(() => decode(invalid)).toThrow()
  })

  test("accepts the same model with another variant or profile as a fallback", () => {
    expect(
      decode({ "anthropic/claude-opus-5": ["anthropic/claude-opus-5#low", "Work#anthropic/claude-opus-5"] }),
    ).toHaveProperty(["anthropic/claude-opus-5", "length"], 2)
  })
})
