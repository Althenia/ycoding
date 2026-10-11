import { expect, test } from "bun:test"
import { parse } from "../../src/util/model"
import { recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parse("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("retains profile and variant when parsing CLI model selections", () => {
  expect(parse("Work#provider/family/model#high")).toEqual({
    providerID: "provider",
    modelID: "family/model",
    profile: "Work",
    variant: "high",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})
