import { expect, test } from "bun:test"
import path from "node:path"
import { createModelPreferenceRepository, decodeModelPreference, modelPreferenceKey } from "../src/model-preference"
import { recentModels } from "../src/context/local"
import { tmpdir } from "./fixture/fixture"

test("repairs known model preferences and preserves unrelated fields", () => {
  expect(
    decodeModelPreference({
      unrelated: { keep: true },
      recent: [{ providerID: "openai", modelID: "gpt-5", ignored: true }, null],
      favorite: "malformed",
      variant: { "openai/gpt-5": "high", empty: "", invalid: 42 },
    }),
  ).toEqual({
    unrelated: { keep: true },
    recent: [{ providerID: "openai", modelID: "gpt-5" }],
    favorite: [],
    variant: { "openai/gpt-5": "high" },
  })
})

test("preserves named none and default variants as ordinary ids", () => {
  expect(
    decodeModelPreference({
      recent: [],
      favorite: [],
      variant: {
        "local/qwopus": "none",
        "local/ornith": "default",
        "local/tiel": "fast",
      },
    }).variant,
  ).toEqual({ "local/qwopus": "none", "local/ornith": "default", "local/tiel": "fast" })
})

test("retains explicit provider profiles in recent and favorite model identities", () => {
  const profile = "Work/account"
  const value = decodeModelPreference({
    recent: [{ providerID: "openai", modelID: "gpt-5", profile }, { providerID: "openai", modelID: "gpt-5", profile: "" }],
    favorite: [{ providerID: "openai", modelID: "gpt-5", profile }],
  })
  expect(value.recent).toEqual([{ providerID: "openai", modelID: "gpt-5", profile }])
  expect(value.favorite).toEqual([{ providerID: "openai", modelID: "gpt-5", profile }])
  expect(modelPreferenceKey({ providerID: "openai", modelID: "gpt-5" }))
    .not.toBe(modelPreferenceKey({ providerID: "openai", modelID: "gpt-5", profile }))
})

test("recent model identities keep separate profile choices for the same model", () => {
  expect(recentModels(
    { providerID: "openai", modelID: "gpt-5", profile: "Work" },
    [{ providerID: "openai", modelID: "gpt-5", profile: "Personal" }, { providerID: "openai", modelID: "gpt-5" }],
  )).toEqual([
    { providerID: "openai", modelID: "gpt-5", profile: "Work" },
    { providerID: "openai", modelID: "gpt-5", profile: "Personal" },
    { providerID: "openai", modelID: "gpt-5" },
  ])
})

test("persists named profiles in recent and favorite model identities", async () => {
  await using tmp = await tmpdir()
  const repository = createModelPreferenceRepository(path.join(tmp.path, "model.json"))
  const work = { providerID: "openai", modelID: "gpt-5", profile: "Work" }
  await repository.patch({ recent: [work], favorite: [work] })
  expect(await repository.load()).toEqual({ recent: [work], favorite: [work], variant: {} })
})

test("atomically serializes patches and variant updates", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "model.json")
  await Bun.write(file, JSON.stringify({ unrelated: "keep", favorite: [], variant: {} }))
  const repository = createModelPreferenceRepository(file)
  const openai = { providerID: "openai", modelID: "org/gpt-5" }
  const anthropic = { providerID: "anthropic", modelID: "claude/sonnet" }

  await Promise.all([
    repository.patch({ recent: [openai] }),
    repository.saveVariant(openai, "high"),
    repository.saveVariant(anthropic, "low"),
  ])
  expect(await Bun.file(file).json()).toEqual({
    unrelated: "keep",
    recent: [openai],
    favorite: [],
    variant: { "openai/org/gpt-5": "high", "anthropic/claude/sonnet": "low" },
  })

  await repository.saveVariant(openai, undefined)
  expect(await repository.resolveVariant(openai)).toBeUndefined()
  expect((await Bun.file(file).json()).variant).toEqual({ "anthropic/claude/sonnet": "low" })
})
