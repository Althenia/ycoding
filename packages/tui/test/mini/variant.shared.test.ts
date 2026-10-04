import { describe, expect, test } from "bun:test"
import { cycleVariant, formatModelLabel, pickVariant, resolveVariant } from "../../src/mini/variant.shared"
import { decodeModelPreference } from "../../src/model-preference"
import type { RunSession } from "../../src/mini/session.shared"
import type { RunProvider } from "../../src/mini/types"

const model = {
  providerID: "openai",
  modelID: "gpt-5",
}

const providers: RunProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5": {
        name: "GPT-5",
      },
    },
  },
]

describe("run variant shared", () => {
  test("prefers explicit cli then session then saved variants without replacing unavailable ids", () => {
    expect(resolveVariant("max", "high", "low")).toBe("max")
    expect(resolveVariant(undefined, "high", "low")).toBe("high")
    expect(resolveVariant(undefined, "missing", "low")).toBe("missing")
    expect(resolveVariant(undefined, undefined, "missing")).toBe("missing")
  })

  test("retains a stored explicit variant when the model offers no variants", () => {
    expect(resolveVariant(undefined, "high", "low")).toBe("high")
    expect(resolveVariant(undefined, undefined, "high")).toBe("high")
  })

  test("keeps stored variants while the catalog has not resolved the model yet", () => {
    expect(resolveVariant(undefined, "high", "low")).toBe("high")
    expect(resolveVariant(undefined, undefined, "low")).toBe("low")
  })

  test("keeps an explicit cli variant even when the catalog has not resolved variants", () => {
    expect(resolveVariant("max", undefined, undefined)).toBe("max")
  })

  test("cycles through offered variants without clearing the optional selection", () => {
    expect(cycleVariant(undefined, ["low", "high"])).toBe("low")
    expect(cycleVariant("low", ["low", "high"])).toBe("high")
    expect(cycleVariant("high", ["low", "high"])).toBe("low")
    expect(cycleVariant("missing", ["low", "high"])).toBe("low")
    expect(cycleVariant(undefined, [])).toBeUndefined()
  })

  test("cycles through an offered none variant and treats a catalog variant named default as an ordinary id", () => {
    expect(cycleVariant(undefined, ["none", "low", "high"])).toBe("none")
    expect(cycleVariant("none", ["none", "low", "high"])).toBe("low")
    expect(cycleVariant("low", ["none", "low", "high"])).toBe("high")
    expect(cycleVariant("high", ["none", "low", "high"])).toBe("none")
    expect(cycleVariant(undefined, ["default", "low", "high"])).toBe("default")
    expect(cycleVariant("default", ["default", "low", "high"])).toBe("low")
    expect(resolveVariant("none", undefined, undefined)).toBe("none")
    expect(resolveVariant(undefined, "default", "low")).toBe("default")
    expect(decodeModelPreference({ variant: { "openai/gpt-6-luna": "none" } }).variant).toEqual({
      "openai/gpt-6-luna": "none",
    })
  })

  test("formats model labels", () => {
    expect(formatModelLabel(model, undefined)).toBe("gpt-5 · openai")
    expect(formatModelLabel(model, "high")).toBe("gpt-5 · openai · high")
    expect(formatModelLabel(model, undefined, providers)).toBe("GPT-5 · OpenAI")
    expect(formatModelLabel(model, "high", providers)).toBe("GPT-5 · OpenAI · high")
  })

  test("picks the latest matching variant from session history", () => {
    const session: RunSession = {
      first: false,
      turns: [
        { prompt: { text: "one", parts: [] }, provider: "openai", model: "gpt-5", variant: "high" },
        { prompt: { text: "two", parts: [] }, provider: "anthropic", model: "sonnet", variant: "max" },
        { prompt: { text: "three", parts: [] }, provider: "openai", model: "gpt-5", variant: "minimal" },
      ],
    }

    expect(pickVariant(model, session)).toBe("minimal")
  })
})
