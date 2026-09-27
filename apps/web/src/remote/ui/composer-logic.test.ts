import { describe, expect, test } from "bun:test"
import { optionsForTrigger, applyMention, reconcileMentions, submission, triggerAt, orderedVariants } from "./composer-logic"
import type { CatalogView } from "../catalog"

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
    expect(optionsForTrigger("/", "", large, [])).toHaveLength(87)
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
    expect(submission("/research context", [], catalog, "steer")).toEqual({ kind: "prompt", input: { text: "/research context", delivery: "steer", skills: ["research"] } })
    expect(submission("/unknown", [], catalog, "steer").kind).toBe("prompt")
  })

})
