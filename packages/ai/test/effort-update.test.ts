import { expect, test } from "bun:test"
import { LLM } from "../src"
import { Anthropic, OpenAI, OpenRouter } from "../src/providers"
import { anthropicEffortModel, defaultEffort, mechanism } from "../src/protocols/utils/effort-update"

test("effort updates require an explicitly supported public endpoint and model configuration", () => {
  for (const id of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-sol-2026-10-01"]) {
    expect(
      mechanism(LLM.request({ model: OpenAI.configure({ apiKey: "fixture" }).responses(id), prompt: "Input" })),
    ).toBe("openai")
  }
  for (const id of ["gpt-5.6", "gpt-6-unknown", "gpt-7-sol", "gpt-6.2-sol"]) {
    expect(
      mechanism(LLM.request({ model: OpenAI.configure({ apiKey: "fixture" }).responses(id), prompt: "Input" })),
    ).toBeUndefined()
  }
  for (const options of [
    { http: { body: { reasoning: { mode: "pro" } } } },
    { providerOptions: { openai: { reasoningMode: "pro" } } },
    { providerOptions: { openai: { contextManagement: [{ type: "compaction", compactThreshold: 200_000 }] } } },
    { http: { body: { context_management: [{ type: "compaction" }] } } },
    { http: { body: { truncation: "auto" } } },
    { http: { body: { multi_agent: { enabled: true } } } },
  ])
    expect(
      mechanism(
        LLM.request({
          model: OpenAI.configure({ apiKey: "fixture" }).responses("gpt-6.1-sol"),
          prompt: "Input",
          ...options,
        }),
      ),
    ).toBeUndefined()
})

test("Anthropic per-message effort uses the documented allow-list, adaptive thinking and model defaults", () => {
  for (const id of [
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]) {
    expect(anthropicEffortModel(id)).toBe(true)
    expect(
      mechanism(LLM.request({ model: Anthropic.configure({ apiKey: "fixture" }).model(id), prompt: "Input" })),
    ).toBe("anthropic")
    expect(
      mechanism(
        LLM.request({
          model: Anthropic.configure({ apiKey: "fixture" }).model(id),
          prompt: "Input",
          providerOptions: { anthropic: { thinking: { type: "disabled" } } },
        }),
      ),
    ).toBeUndefined()
  }
  for (const id of ["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5", "claude-opus-5-6", "claude-fable-6"])
    expect(anthropicEffortModel(id)).toBe(false)
  expect(defaultEffort("claude-opus-5-5")).toBe("medium")
  expect(defaultEffort("claude-haiku-5-5")).toBe("medium")
  expect(defaultEffort("claude-sonnet-5-5")).toBe("high")
  expect(defaultEffort("gpt-6.1-sol")).toBe("medium")
  expect(defaultEffort("gpt-6-astra")).toBeUndefined()
  expect(defaultEffort("claude-opus-5-5@20260915")).toBe("medium")
})

test("OpenRouter updates require its documented model profiles and exclude pro, budget and thinking toggles", () => {
  for (const id of [
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-6-astra",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5",
  ]) {
    expect(
      mechanism(LLM.request({ model: OpenRouter.configure({ apiKey: "fixture" }).model(id), prompt: "Input" })),
    ).toBe("openrouter")
  }
  for (const id of ["openai/gpt-6-sol-pro", "openai/gpt-5.6", "anthropic/claude-opus-4.8"]) {
    expect(
      mechanism(LLM.request({ model: OpenRouter.configure({ apiKey: "fixture" }).model(id), prompt: "Input" })),
    ).toBeUndefined()
  }
  for (const reasoning of [{ mode: "pro" }, { max_tokens: 4096 }, { enabled: true }, { enabled: false }]) {
    expect(
      mechanism(
        LLM.request({
          model: OpenRouter.configure({ apiKey: "fixture" }).model("openai/gpt-6-sol"),
          prompt: "Input",
          providerOptions: { openrouter: { reasoning } },
        }),
      ),
    ).toBeUndefined()
  }
})
