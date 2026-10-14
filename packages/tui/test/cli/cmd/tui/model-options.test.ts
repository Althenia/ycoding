import { describe, expect, test } from "bun:test"
import { sortModelOptions } from "../../../../src/component/dialog-model"

describe("sortModelOptions", () => {
  test("orders every backend provider by name without a hosted-provider preference", () => {
    const sorted = sortModelOptions([
      { providerID: "openai", providerName: "OpenAI", releaseDate: 3, title: "GPT 5" },
      { providerID: "opencode", providerName: "OpenCode", releaseDate: 1, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 2, title: "Claude Opus 4" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "GPT 5", "Claude Sonnet 4"])
  })

  test("orders provider groups by provider name and models by newest release", () => {
    const sorted = sortModelOptions([
      { providerID: "cursor", providerName: "Cursor", releaseDate: 5, title: "Cursor Model" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 4, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 6, title: "Claude Opus 4" },
      { providerID: "openai", providerName: "OpenAI", releaseDate: 7, title: "GPT 5" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4", "Cursor Model", "GPT 5"])
  })

  test("falls back to title when release dates match within a provider", () => {
    const sorted = sortModelOptions([
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 5, title: "Claude Sonnet 4" },
      { providerID: "anthropic", providerName: "Anthropic", releaseDate: 5, title: "Claude Opus 4" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Claude Opus 4", "Claude Sonnet 4"])
  })
})
