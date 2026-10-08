import { describe, expect, test } from "bun:test"
import { catalogKey, modelDisplayLabel, readCatalog, readFileFind } from "./catalog"

describe("catalogKey", () => {
  test("keeps Session and workspace targets apart", () => {
    expect(catalogKey({ sessionID: "ses_1" })).toBe("session:ses_1")
    expect(catalogKey({ workspaceID: "ses_1" })).toBe("workspace:ses_1")
  })
})

describe("modelDisplayLabel", () => {
  test("names the model the way the TUI header does", () => {
    const models = [{ providerID: "openai", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "high"] }]
    expect(modelDisplayLabel({ providerID: "openai", id: "gpt-6-sol", variant: "high" }, models)).toBe("openai/GPT-6 Sol")
    expect(modelDisplayLabel({ providerID: "anthropic", id: "claude-opus-5-5" })).toBe("anthropic/Claude Opus 5 5")
  })
})

test("reads the device catalog while rejecting malformed entries", () => {
  expect(readCatalog({
    agents: [{ id: "god", name: "God", mode: "primary", hidden: false }, { id: "bad", mode: "primary" }],
    models: [{ providerID: "openai", id: "gpt-6", name: "GPT-6", variants: ["low", "high"], enabled: false, profiles: [
      { name: "work", active: true, variants: ["high"], credentialID: "private", daybreak: ["daybreak_blue"] },
      { name: "private", active: false, variants: ["low"], credentialID: "secret" },
    ] }],
    defaultModel: { providerID: "openai", id: "gpt-6" },
    commands: [{ name: "test" }], skills: [{ id: "review", name: "Review", slash: true }],
    references: [{ name: "guide", uri: "https://example.test/guide" }], resources: [],
  })).toEqual({ status: "ready", agents: [{ id: "god", name: "God", mode: "primary", hidden: false }],
    models: [{ providerID: "openai", id: "gpt-6", name: "GPT-6", variants: ["low", "high"], enabled: false, profiles: [
      { name: "work", active: true, variants: ["high"] }, { name: "private", active: false, variants: ["low"] },
    ] }],
    defaultModel: { providerID: "openai", id: "gpt-6" }, commands: [{ name: "test" }],
    skills: [{ id: "review", name: "Review", slash: true }], references: [{ name: "guide", uri: "https://example.test/guide" }], resources: [] })
  expect(readCatalog({})).toBeUndefined()
})

test("reads file-finder entries without inventing unsafe missing fields", () => {
  expect(readFileFind({ files: [{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }, { path: "bad" }] }))
    .toEqual([{ path: "src/a.ts", uri: "file:///work/src/a.ts", kind: "file" }])
  expect(readFileFind({ files: "wrong" })).toBeUndefined()
})

test("labels an unavailable profile honestly without exposing profile metadata", () => {
  expect(modelDisplayLabel({ providerID: "openai", id: "gpt-6", profile: "deleted" }, [
    { providerID: "openai", id: "gpt-6", name: "GPT-6", variants: [], profiles: [{ name: "work", active: true }] },
  ])).toBe("openai/GPT-6 · profile unavailable: deleted")
})
