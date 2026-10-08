import { describe, expect, test } from "bun:test"
import { ConfigModel } from "@ycoding-ai/core/config/model"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(ConfigModel.Selection)

describe("ConfigModel.Selection", () => {
  test("preserves explicit profile names and keeps unprofiled shorthand unchanged", () => {
    expect(decode({ providerID: "openai", model: "gpt-6.1-sol", variant: "high", profile: "Work" })).toEqual({
      providerID: Provider.ID.make("openai"),
      model: Model.ID.make("gpt-6.1-sol"),
      variant: Model.VariantID.make("high"),
      profile: "Work",
    })
    expect(decode("openai/gpt-6.1-sol")).not.toHaveProperty("profile")
    expect(() => decode({ providerID: "openai", model: "gpt-6.1-sol", profile: "" })).toThrow()
  })

  test("normalizes short and explicit model selections", () => {
    expect(decode("openrouter/openai/gpt-5#high")).toEqual({
      providerID: Provider.ID.make("openrouter"),
      model: Model.ID.make("openai/gpt-5"),
      variant: Model.VariantID.make("high"),
    })
    expect(decode({ providerID: "anthropic", model: "claude-sonnet", variant: "high" })).toEqual({
      providerID: Provider.ID.make("anthropic"),
      model: Model.ID.make("claude-sonnet"),
      variant: Model.VariantID.make("high"),
    })
  })

  test("rejects malformed selections and reserved fragments", () => {
    expect(() => decode("gpt-5")).toThrow()
    expect(() => decode("openai/gpt-5#")).toThrow()
    expect(() => decode({ providerID: "openai", model: "gpt-5#high" })).toThrow()
  })
})
