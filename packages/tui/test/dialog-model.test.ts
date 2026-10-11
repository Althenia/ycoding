import { expect, test } from "bun:test"

const dialogModel = await import("../src/component/dialog-model")

test("completes an explicit selection of the already-current model and variant", () => {
  expect(
    dialogModel.completeModelSelection({
      providerID: "openai",
      modelID: "gpt-5.6",
      variants: ["low", "high"],
      currentVariant: "high",
    }),
  ).toEqual({ providerID: "openai", modelID: "gpt-5.6", variant: "high" })
})

test("retains an explicit profile when completing model and variant selection", () => {
  expect(
    dialogModel.completeModelSelection({
      providerID: "openai",
      modelID: "gpt-5.6",
      variants: ["low", "high"],
      currentVariant: "high",
      profile: "Work",
    }),
  ).toEqual({ providerID: "openai", modelID: "gpt-5.6", variant: "high", profile: "Work" })
})

test("withholds completion until a required variant is explicitly selected", () => {
  const input = {
    providerID: "anthropic",
    modelID: "claude-sonnet",
    variants: ["default", "extended"],
  }

  expect(dialogModel.completeModelSelection(input)).toBeUndefined()
  expect(dialogModel.completeModelSelection({ ...input, variant: "extended" })).toEqual({
    providerID: "anthropic",
    modelID: "claude-sonnet",
    variant: "extended",
  })
})
