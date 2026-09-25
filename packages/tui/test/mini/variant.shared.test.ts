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
  test("prefers cli then session then saved variants", () => {
    expect(resolveVariant("max", "high", "low", ["low", "high"])).toBe("max")
    expect(resolveVariant("default", "high", "low", ["low", "high"])).toBeUndefined()
    expect(resolveVariant(undefined, "high", "low", ["low", "high"])).toBe("high")
    expect(resolveVariant(undefined, "missing", "low", ["low", "high"])).toBe("low")
  })

  test("drops a stored variant when the model offers no variants at all", () => {
    expect(resolveVariant(undefined, "high", "low", [])).toBeUndefined()
    expect(resolveVariant(undefined, "high", undefined, [] as string[])).toBeUndefined()
  })

  test("keeps stored variants while the catalog has not resolved the model yet", () => {
    expect(resolveVariant(undefined, "high", "low", undefined)).toBe("high")
    expect(resolveVariant(undefined, undefined, "low", undefined)).toBe("low")
  })

  test("keeps an explicit cli variant even when the catalog has not resolved variants", () => {
    expect(resolveVariant("max", undefined, undefined, undefined)).toBe("max")
    expect(resolveVariant("max", undefined, undefined, [])).toBe("max")
  })

  test("cycles through variants and back to default", () => {
    expect(cycleVariant(undefined, ["low", "high"])).toBe("low")
    expect(cycleVariant("default", ["low", "high"])).toBe("low")
    expect(cycleVariant("low", ["low", "high"])).toBe("high")
    expect(cycleVariant("high", ["low", "high"])).toBeUndefined()
    expect(cycleVariant(undefined, [])).toBeUndefined()
  })

  test("cycles through an offered none variant and keeps default as the base model", () => {
    expect(cycleVariant(undefined, ["none", "low", "high"])).toBe("none")
    expect(cycleVariant("none", ["none", "low", "high"])).toBe("low")
    expect(cycleVariant("low", ["none", "low", "high"])).toBe("high")
    expect(cycleVariant("high", ["none", "low", "high"])).toBeUndefined()
    expect(cycleVariant(undefined, ["default", "low", "high"])).toBe("low")
    expect(resolveVariant("none", undefined, undefined, ["none", "low", "high"])).toBe("none")
    expect(resolveVariant("default", "none", "low", ["none", "low", "high"])).toBeUndefined()
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
