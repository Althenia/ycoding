import { describe, expect, test } from "bun:test"
import type { ModelInfo } from "../../src/cursor/provider/models"
import { CursorModels } from "@ycoding-ai/core/cursor/models"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Money } from "@ycoding-ai/schema/money"

const opus: ModelInfo = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  supportsThinking: true,
  supportsImages: true,
  maxContext: 300_000,
  maxContextForMaxMode: 1_000_000,
  variants: [
    {
      key: "high",
      displayName: "Opus 4.8 <span>High</span>",
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "context", value: "300k" },
      ],
      isDefaultNonMax: true,
      isDefaultMax: false,
    },
    {
      key: "high-fast",
      displayName: "Opus 4.8 High Fast",
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
        { id: "context", value: "300k" },
      ],
      isDefaultNonMax: false,
      isDefaultMax: false,
    },
    {
      key: "1m-high",
      displayName: "Opus 4.8 1M High",
      parameterValues: [
        { id: "effort", value: "high" },
        { id: "context", value: "1m" },
      ],
      isDefaultNonMax: false,
      isDefaultMax: true,
    },
  ],
}

const composer: ModelInfo = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  variants: [
    {
      key: "standard",
      displayName: "Composer 2.5",
      parameterValues: [{ id: "fast", value: "false" }],
      isDefaultNonMax: true,
      isDefaultMax: false,
    },
    {
      key: "fast",
      displayName: "Composer 2.5 Fast",
      parameterValues: [{ id: "fast", value: "true" }],
      isDefaultNonMax: false,
      isDefaultMax: false,
    },
  ],
}

const rate = (input: number, output: number, read: number) => ({
  input: Money.USDPerMillionTokens.make(input),
  output: Money.USDPerMillionTokens.make(output),
  cache: { read: Money.USDPerMillionTokens.make(read), write: Money.USDPerMillionTokens.zero },
})

const byID = (models: ReturnType<typeof CursorModels.fromCursor>) =>
  new Map(models.map((model) => [String(model.id), model]))

describe("CursorModels.fromCursor", () => {
  test("presents Grok context sizes as models with four effort choices each", () => {
    const efforts = ["low", "medium", "high", "xhigh"] as const
    const models = byID(CursorModels.fromCursor([{
      id: "grok-4.7", displayName: "Grok 4.7", maxContext: 256_000, maxContextForMaxMode: 500_000,
      variants: efforts.flatMap((effort) => [
        { key: effort, displayName: `Grok 4.7 ${effort === "xhigh" ? "Extra High" : effort}`,
          parameterValues: [{ id: "effort", value: effort }, { id: "context", value: "256k" }],
          isDefaultNonMax: effort === "high", isDefaultMax: false },
        { key: `${effort}-500k`, displayName: `Grok 4.7 ${effort} 500k`,
          parameterValues: [{ id: "effort", value: effort }, { id: "context", value: "500k" }],
          isDefaultNonMax: false, isDefaultMax: effort === "high" },
      ]),
    }]))

    expect([...models.keys()]).toEqual(["grok-4.7", "grok-4.7-500k"])
    expect(models.get("grok-4.7")).toMatchObject({ name: "Grok 4.7", limit: { context: 256_000 }, modelID: "grok-4.7" })
    expect(models.get("grok-4.7-500k")).toMatchObject({ name: "Grok 4.7 500k", limit: { context: 500_000 }, modelID: "grok-4.7",
      settings: { cursorVariantParameters: [{ id: "effort", value: "high" }, { id: "context", value: "500k" }] } })
    expect(models.get("grok-4.7-500k")?.cost.length).toBeGreaterThan(0)
    for (const [id, context] of [["grok-4.7", "256k"], ["grok-4.7-500k", "500k"]] as const)
      expect(models.get(id)?.variants).toEqual(efforts.map((effort) => ({ id: CatalogModel.VariantID.make(effort),
        settings: { cursorVariantParameters: [{ id: "effort", value: effort }, { id: "context", value: context }] } })))
  })

  test("keeps an advertised 500k model identity when a generated context entry collides", () => {
    const models = CursorModels.fromCursor([
      { id: "grok-4.7-500k", variants: [] },
      { id: "grok-4.7", maxContext: 256_000, variants: [
        { key: "high", displayName: "Grok 4.7 High", parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "256k" }], isDefaultNonMax: true, isDefaultMax: false },
        { key: "high-500k", displayName: "Grok 4.7 High 500k", parameterValues: [{ id: "effort", value: "high" }, { id: "context", value: "500k" }], isDefaultNonMax: false, isDefaultMax: true },
      ] },
    ])
    expect(models.map((model) => model.id)).toEqual(["grok-4.7-500k", "grok-4.7", "grok-4.7-500k-2"].map((id) => CatalogModel.ID.make(id)))
    expect(models[2]?.modelID).toBe(CatalogModel.ID.make("grok-4.7"))
  })

  test("splits long-context variants into a -1m entry with exact parameter tuples", () => {
    const models = byID(CursorModels.fromCursor([opus]))

    expect([...models.keys()]).toEqual(["claude-opus-4-8", "claude-opus-4-8-fast", "claude-opus-4-8-1m"])
    const base = models.get("claude-opus-4-8")
    expect(base).toMatchObject({
      modelID: "claude-opus-4-8",
      providerID: "cursor",
      name: "Opus 4.8",
      package: "aisdk:cursor-opencode-provider",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 300_000, output: 32_000 },
      enabled: true,
      status: "active",
    })
    expect(base?.settings).toBeUndefined()
    expect(base?.variants).toEqual([
      {
        id: CatalogModel.VariantID.make("high"),
        settings: {
          cursorVariantParameters: [
            { id: "effort", value: "high" },
            { id: "context", value: "300k" },
          ],
        },
      },
    ])
    expect(base?.cost.length).toBeGreaterThan(0)

    expect(models.get("claude-opus-4-8-fast")).toMatchObject({
      name: "Opus 4.8 Fast", modelID: "claude-opus-4-8", cost: [],
      variants: [{ id: "high", settings: { cursorVariantParameters: [
        { id: "effort", value: "high" }, { id: "fast", value: "true" }, { id: "context", value: "300k" },
      ] } }],
    })

    expect(models.get("claude-opus-4-8-1m")).toMatchObject({
      modelID: "claude-opus-4-8",
      name: "Opus 4.8 1M",
      limit: { context: 1_000_000, output: 128_000 },
      settings: {
        cursorVariantParameters: [
          { id: "effort", value: "high" },
          { id: "context", value: "1m" },
        ],
      },
      variants: [
        {
          id: "high",
          settings: {
            cursorVariantParameters: [
              { id: "effort", value: "high" },
              { id: "context", value: "1m" },
            ],
          },
        },
      ],
    })
  })

  test("splits separately priced Fast variants into a -fast entry with its own cost", () => {
    const models = byID(CursorModels.fromCursor([composer]))

    expect([...models.keys()]).toEqual(["composer-2.5", "composer-2.5-fast"])
    expect(models.get("composer-2.5")?.variants).toEqual([])
    expect(models.get("composer-2.5")?.settings).toEqual({ cursorVariantParameters: [{ id: "fast", value: "false" }] })
    expect(models.get("composer-2.5-fast")).toMatchObject({
      modelID: "composer-2.5",
      name: "Composer 2.5 Fast",
      settings: { cursorVariantParameters: [{ id: "fast", value: "true" }] },
      variants: [],
    })
    expect(models.get("composer-2.5-fast")?.cost).toEqual([rate(3, 15, 0.5)])
    expect(models.get("composer-2.5")?.cost).toEqual([rate(0.5, 2.5, 0.2)])
  })

  test("keeps models without variants variant-free with conservative limits", () => {
    const models = byID(
      CursorModels.fromCursor([
        { id: "default", displayName: "Auto", variants: [] },
        { id: "unpriced-model", variants: [] },
      ]),
    )

    expect(models.get("default")).toMatchObject({
      name: "Auto",
      variants: [],
      capabilities: { input: ["text"] },
      limit: { context: 256_000, output: 32_000 },
    })
    expect(models.get("unpriced-model")).toMatchObject({
      name: "unpriced-model",
      variants: [],
      cost: [],
      limit: { context: 200_000, output: 32_000 },
    })
  })

  test("tags thinking models whose display name collides with a non-thinking twin", () => {
    const models = byID(
      CursorModels.fromCursor([
        { id: "sonnet-5", displayName: "Sonnet 5", variants: [] },
        { id: "sonnet-5-thinking", displayName: "Sonnet 5", supportsThinking: true, variants: [] },
      ]),
    )

    expect(models.get("sonnet-5")?.name).toBe("Sonnet 5")
    expect(models.get("sonnet-5-thinking")?.name).toBe("Sonnet 5 Thinking")
  })
})
