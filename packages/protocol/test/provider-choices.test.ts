import { expect, test } from "bun:test"
import { providerChoices } from "../src/provider-choices.js"

test("omits retired provider IDs from built-in and custom choices", () => {
  const items = [
    { id: "openai", name: "OpenAI" },
    { id: "antigravity", name: "Antigravity" },
    { id: "MuSe", name: "Muse" },
    { id: "fixture-compatible", name: "Fixture" },
  ]
  const choices = providerChoices(items, new Set(items.map((item) => item.id)))
  expect(choices.builtIn.map((item) => item.id)).toEqual(["openai"])
  expect(choices.custom.map((item) => item.id)).toEqual(["fixture-compatible"])
})
