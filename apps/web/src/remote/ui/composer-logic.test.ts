import { describe, expect, test } from "bun:test"
import { autocompleteBound, optionsForTrigger, applyMention, reconcileMentions, submission, suggestionTrigger, tokenKey, triggerAt, orderedVariants, visibleModels, pairedFastModel, switchFastModel, effortLevel } from "./composer-logic"
import type { CatalogView, ModelOption } from "../catalog"

const models: ModelOption[] = [
  { providerID: "openai", id: "gpt-6-sol", name: "GPT-6 Sol", variants: ["low", "medium", "high"], defaultVariant: "high" },
  { providerID: "openai", id: "gpt-6-sol-fast", name: "GPT-6 Sol Fast", variants: ["low", "high"], defaultVariant: "low" },
  { providerID: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", variants: ["high", "max"], defaultVariant: "high" },
  { providerID: "anthropic", id: "claude-opus-5-5-fast", name: "Claude Opus 5.5 Fast", variants: ["medium", "high"], defaultVariant: "medium" },
  { providerID: "openai", id: "gpt-6-lite", name: "GPT-6 Lite", variants: [] },
  { providerID: "zai", id: "glm-fast-latest", name: "GLM Fast Latest", variants: [] },
  { providerID: "openai", id: "quant-fp8-fast", name: "Quant FP8 Fast", variants: [] },
]

test("paired fast models hide from the picker and switch model identity without changing an offered effort", () => {
  expect(visibleModels(models).map((item) => item.id)).toEqual(["gpt-6-sol", "claude-opus-5-5", "gpt-6-lite", "glm-fast-latest", "quant-fp8-fast"])
  const normal = { providerID: "openai", id: "gpt-6-sol", variant: "high" }
  const fast = { providerID: "openai", id: "gpt-6-sol-fast", variant: "high" }
  expect(pairedFastModel(models, normal)).toMatchObject({ base: models[0], fast: models[1], active: false })
  expect(switchFastModel(models, normal)).toEqual(fast)
  expect(pairedFastModel(models, fast)).toMatchObject({ base: models[0], fast: models[1], active: true })
  expect(switchFastModel(models, fast)).toEqual(normal)
  expect(switchFastModel(models, { ...normal, variant: "medium" })).toEqual({ providerID: "openai", id: "gpt-6-sol-fast", variant: "low" })
  expect(switchFastModel(models, { providerID: "anthropic", id: "claude-opus-5-5-fast", variant: "medium" })).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" })
  expect(pairedFastModel(models, { providerID: "zai", id: "glm-fast-latest" })).toBeUndefined()
  expect(switchFastModel(models, { providerID: "openai", id: "gpt-6-lite" })).toBeUndefined()
})

test("effort levels map known variants exactly and unknown variants to one deterministic fallback", () => {
  expect(["none", "minimal", "low", "medium", "high", "xhigh", "max", "CUSTOM"].map(effortLevel)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "fallback"])
})

const catalog: CatalogView = {
  status: "ready", agents: [
    { id: "gsd", name: "GSD", mode: "primary", hidden: false },
    { id: "reviewer", name: "Reviewer", mode: "subagent", hidden: false },
    { id: "btw", name: "BTW", mode: "subagent", hidden: false },
    { id: "secret", name: "Secret", mode: "subagent", hidden: true },
  ], models: [], commands: [{ name: "plan", description: "Plan work" }],
  skills: [{ id: "research", name: "Research", slash: true }, { id: "audit", name: "Audit", slash: false }],
  references: [{ name: "guide", uri: "file:///guide" }], resources: [{ name: "docs", uri: "mcp://docs" }],
}

describe("composer input semantics", () => {
  test("orders reasoning stops by intensity while retaining unknown catalog order", () => {
    expect(orderedVariants(["max", "custom-b", "low", "xhigh", "none", "custom-a", "medium", "minimal", "high"])).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "custom-b", "custom-a"])
  })
  test("returns the full ranked catalog for bare skill and command triggers", () => {
    const large = { ...catalog, skills: Array.from({ length: 63 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}`, slash: true })), commands: Array.from({ length: 24 }, (_, index) => ({ name: `command-${index}` })) }
    expect(optionsForTrigger("$", "", large, [])).toHaveLength(63)
    expect(optionsForTrigger("/", "", large, [])).toHaveLength(89)
  })
  test("detects a trigger adjacent to the caret without matching prose or later text", () => {
    expect(triggerAt("/pla", 4)).toEqual({ trigger: "/", start: 0, query: "pla" })
    expect(triggerAt("hello @rev later", 10)).toEqual({ trigger: "@", start: 6, query: "rev" })
    expect(triggerAt("word/plan", 9)).toBeUndefined()
    expect(triggerAt("$audit #rev", 11)).toEqual({ trigger: "#", start: 7, query: "rev" })
  })

  test("sources slash commands and skills, references/agents/resources/files, and name-filtered #", () => {
    expect(optionsForTrigger("/", "pla", catalog, []).map((item) => item.label)).toEqual(["/plan"])
    expect(optionsForTrigger("/", "res", catalog, []).map((item) => item.label)).toEqual(["/research"])
    expect(optionsForTrigger("@", "", catalog, [{ path: "src/main.ts", uri: "file:///main", kind: "file" }]).map((item) => item.label)).toEqual(["@docs", "@guide", "@reviewer", "@src/main.ts"])
    expect(optionsForTrigger("$", "audit", catalog, []).map((item) => item.label)).toEqual(["$audit"])
    expect(optionsForTrigger("#", "review", catalog, []).map((item) => item.label)).toEqual(["Reviewer"])
    expect(optionsForTrigger("@", "secret", catalog, [])).toEqual([])
  })

  test("tracks mention ranges across edits and drops edited mention text", () => {
    const option = optionsForTrigger("@", "rev", catalog, []).find((item) => item.label === "@reviewer")!
    const inserted = applyMention("hi @rev done", 3, 7, option, [])
    expect(inserted.text).toBe("hi @reviewer done")
    expect(inserted.parts[0]?.mention).toEqual({ start: 3, end: 12, text: "@reviewer" })
    expect(reconcileMentions(inserted.text, "hey hi @reviewer done", inserted.parts)[0]?.mention?.start).toBe(7)
    expect(reconcileMentions(inserted.text, "hi @reviewed done", inserted.parts)).toEqual([])
    const file = optionsForTrigger("@", "main", catalog, [{ path: "src/main.ts", uri: "file:///main", kind: "file" }])[0]!
    const attachment = applyMention("look @main", 5, 10, file, [])
    expect(submission(attachment.text, attachment.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { files: [{ uri: "file:///main", name: "src/main.ts", mention: { start: 5, end: 17, text: "@src/main.ts" } }] } })
    expect(reconcileMentions(attachment.text, "look @src/main.tx", attachment.parts)).toEqual([])
  })

  test("routes known commands, retains attachments and typed skill mentions, and passes pending identity", () => {
    const parts = [{ kind: "agent" as const, name: "reviewer", mention: { start: 6, end: 15, text: "@reviewer" } }]
    expect(submission("/plan now", [], catalog, "queue", "gsd", { providerID: "openai", id: "gpt", variant: "high" })).toEqual({ kind: "command", input: { command: "plan", arguments: "now", delivery: "queue", agent: "gsd", model: { providerID: "openai", id: "gpt", variant: "high" } } })
    expect(submission("hello @reviewer $audit", parts, catalog, "steer", "gsd", undefined)).toEqual({ kind: "prompt", input: { text: "hello @reviewer $audit", delivery: "steer", agents: [{ name: "reviewer", mention: { start: 6, end: 15, text: "@reviewer" } }], skills: ["audit"], agent: "gsd" } })
    expect(submission("/research context", [], catalog, "steer")).toEqual({ kind: "skill", input: { skill: "research" } })
    expect(submission("/unknown", [], catalog, "steer")).toEqual({ kind: "prompt", input: { text: "/unknown", delivery: "steer" } })
  })

})

test("suggestions never exceed the space above the composer or the viewport share, and keep a header tall enough to hold Close", () => {
  expect(autocompleteBound(700, 844)).toBe(337)
  expect(autocompleteBound(300, 400)).toBe(160)
  expect(autocompleteBound(220, 900)).toBe(212)
  expect(autocompleteBound(900, 1400)).toBe(360)
  expect(autocompleteBound(90, 200)).toBe(80)
  expect(autocompleteBound(60, 300)).toBe(54)
  expect(autocompleteBound(30, 300)).toBe(54)
})

test("a dismissed suggestion token stays closed until the token changes or another token is chosen", () => {
  const text = "hello @rev"
  const dismissed = tokenKey(triggerAt(text, text.length)!)
  expect(suggestionTrigger(text, text.length, dismissed)).toBeUndefined()
  expect(suggestionTrigger(text, text.length, undefined)).toEqual({ trigger: "@", start: 6, query: "rev" })
  expect(suggestionTrigger("hello @revi", 11, dismissed)).toEqual({ trigger: "@", start: 6, query: "revi" })
  expect(suggestionTrigger("hello @re", 9, dismissed)).toEqual({ trigger: "@", start: 6, query: "re" })
  expect(suggestionTrigger("@a hello @rev", 2, dismissed)).toEqual({ trigger: "@", start: 0, query: "a" })
  expect(suggestionTrigger("no token", 8, dismissed)).toBeUndefined()
})
