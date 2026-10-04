import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"

const decode = Schema.decodeUnknownSync(CatalogModel.Ref)

describe("CatalogModel.Ref", () => {
  test("accepts a model selection without a variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic" })).toEqual({
      id: CatalogModel.ID.make("claude-sonnet"),
      providerID: Provider.ID.make("anthropic"),
    })
  })

  test("preserves an explicit model variant", () => {
    expect(decode({ id: "claude-sonnet", providerID: "anthropic", variant: "high" })).toEqual({
      id: CatalogModel.ID.make("claude-sonnet"),
      providerID: Provider.ID.make("anthropic"),
      variant: CatalogModel.VariantID.make("high"),
    })
  })
})
