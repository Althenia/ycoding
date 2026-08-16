import { describe, expect, test } from "bun:test"
import { AnthropicModel } from "../src/anthropic-model"

describe("AnthropicModel", () => {
  test("classifies Claude Opus 5 across direct and gateway IDs", () => {
    for (const id of ["claude-opus-5", "anthropic/claude-opus-5", "anthropic.claude-opus-5"]) {
      expect(AnthropicModel.capabilities(id)).toEqual({
        family: "opus",
        generation: 5,
        adaptiveThinking: "default",
        manualThinking: false,
        disableThinkingMaxEffort: "high",
        effort: ["low", "medium", "high", "xhigh", "max"],
        sampling: "default-only",
        midConversationSystem: true,
        cacheMinimumTokens: 512,
        maxContextTokens: 1_000_000,
        maxOutputTokens: 128_000,
      })
    }
  })

  test("classifies Claude Fable 5 and preserves conservative unknowns", () => {
    for (const id of ["claude-fable-5", "anthropic/claude-fable-5", "anthropic.claude-fable-5"]) {
      expect(AnthropicModel.capabilities(id)).toMatchObject({
        family: "fable",
        generation: 5,
        adaptiveThinking: "required",
        manualThinking: false,
        effort: ["low", "medium", "high", "xhigh", "max"],
        sampling: "default-only",
        midConversationSystem: true,
        cacheMinimumTokens: 512,
        maxContextTokens: 1_000_000,
        maxOutputTokens: 128_000,
      })
    }

    expect(AnthropicModel.capabilities("not-claude-opus-5-preview")).toEqual({
      family: "unknown",
      adaptiveThinking: "unsupported",
      manualThinking: false,
      effort: [],
      sampling: "configurable",
      midConversationSystem: false,
    })

    const future = AnthropicModel.capabilities("claude-opus-5-preview")
    expect(future).toMatchObject({
      family: "opus",
      generation: 5,
      adaptiveThinking: "default",
      sampling: "default-only",
    })
    expect(future.cacheMinimumTokens).toBeUndefined()
    expect(future.maxContextTokens).toBeUndefined()
    expect(future.maxOutputTokens).toBeUndefined()
  })

  test("pins approved fourth-generation capability boundaries", () => {
    expect(AnthropicModel.capabilities("claude-opus-4-8")).toMatchObject({
      family: "opus",
      generation: 4,
      minor: 8,
      midConversationSystem: true,
    })
    expect(AnthropicModel.capabilities("claude-opus-4-7")).toMatchObject({
      family: "opus",
      generation: 4,
      minor: 7,
      sampling: "default-only",
      midConversationSystem: false,
    })
  })
})
