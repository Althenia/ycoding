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

test("model and variant cancellation have no completion result", () => {
  expect(
    dialogModel.completeModelSelection({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      variants: ["default", "extended"],
    }),
  ).toBeUndefined()
})

test("reports explicit cancellation from both model and variant dialogs", async () => {
  const model = await Bun.file(new URL("../src/component/dialog-model.tsx", import.meta.url)).text()
  const variant = await Bun.file(new URL("../src/component/dialog-variant.tsx", import.meta.url)).text()

  expect(model).toContain('props.onComplete?.({ type: "cancelled" })')
  expect(model).toContain("onCancel={() => props.onComplete?.({ type: \"cancelled\" })}")
  expect(variant).toContain("if (!selected) props.onCancel?.()")
})
