import { expect, test } from "bun:test"
import { applyMention, optionsForTrigger, submission } from "./composer-logic"
import type { CatalogView } from "../catalog"

const catalog: CatalogView = {
  status: "ready", models: [], defaultModel: undefined,
  agents: [
    { id: "reviewer", name: "Reviewer", mode: "subagent", hidden: false },
    { id: "lead", name: "Lead", mode: "primary", hidden: false },
  ],
  commands: [{ name: "plan", description: "Plan the task" }, { name: "editor", description: "Conflicts with TUI editor action" }],
  skills: [{ id: "audit", name: "Audit", slash: false }, { id: "research", name: "Research", slash: true }],
  references: [{ name: "guide", uri: "file:///work/guide" }], resources: [],
}

test("slash goal and YOLO use autonomy actions, server commands run, slash skills load, and unsupported local actions are refused", () => {
  expect(optionsForTrigger("/", "go", catalog, []).map((option) => option.label)).toContain("/goal")
  expect(optionsForTrigger("/", "yo", catalog, []).map((option) => option.label)).toContain("/yolo")
  expect(submission("/goal keep progress. Ship this safely", [], catalog, "steer")).toEqual({ kind: "goal", input: { goal: "keep progress. Ship this safely" } })
  expect(submission("/yolo 3", [], catalog, "steer")).toEqual({ kind: "yolo", input: { level: 3 } })
  expect(submission("/plan now", [], catalog, "queue")).toEqual({ kind: "command", input: { command: "plan", arguments: "now", delivery: "queue" } })
  expect(submission("/research", [], catalog, "steer")).toEqual({ kind: "skill", input: { skill: "research" } })
  expect(optionsForTrigger("/", "editor", catalog, [])).toEqual([])
  expect(submission("/editor", [], catalog, "steer")).toMatchObject({ kind: "invalid" })
})

test("unmatched slash heads, including paths, remain complete ordinary prompts", () => {
  for (const text of ["/Users/me/file.ts explain", "/notacommand hi", "/"])
    expect(submission(text, [], catalog, "steer")).toEqual({ kind: "prompt", input: { text, delivery: "steer" } })
})

test("manual compact is an available Session action, not a provider prompt or configured command", () => {
  expect(optionsForTrigger("/", "compact", catalog, [])[0]?.label).toBe("/compact")
  expect(optionsForTrigger("/", "compact", catalog, [], false)).toEqual([])
  expect(submission("/compact", [], catalog, "steer")).toEqual({ kind: "compact" })
  expect(submission("/compact extra", [], catalog, "queue")).toMatchObject({ kind: "invalid" })
  expect(submission("/compact", [], { ...catalog, commands: [{ name: "compact" }] }, "steer")).toEqual({ kind: "compact" })
})

test("suggest is a Session slash action and keeps an optional hint", () => {
  const listed = optionsForTrigger("/", "suggest", catalog, [])
  expect(listed[0]).toEqual({ label: "/suggest", description: "Suggest your next message", kind: "command", value: "suggest" })
  expect(optionsForTrigger("/", "suggest", catalog, [], false)).toEqual([])
  expect(submission("/suggest", [], catalog, "steer")).toEqual({ kind: "suggest", input: {} })
  expect(submission("/suggest   ", [], catalog, "queue")).toEqual({ kind: "suggest", input: {} })
  expect(submission("/suggest focus the tests", [], catalog, "steer")).toEqual({ kind: "suggest", input: { hint: "focus the tests" } })
  expect(submission("/suggest  keep the hint spacing ", [], { ...catalog, commands: [{ name: "suggest", description: "Configured suggest" }] }, "queue")).toEqual({ kind: "suggest", input: { hint: "keep the hint spacing" } })
})

test("prompt is a slash action and keeps a required intent", () => {
  const listed = optionsForTrigger("/", "prompt", catalog, [])
  expect(listed[0]).toEqual({ label: "/prompt", description: "Generate a prompt from a rough intent", kind: "command", value: "prompt" })
  expect(optionsForTrigger("/", "prompt", catalog, [], false)[0]).toEqual({ label: "/prompt", description: "Generate a prompt from a rough intent", kind: "command", value: "prompt" })
  expect(submission("/prompt", [], catalog, "steer")).toEqual({ kind: "promptGenerate", input: {} })
  expect(submission("/prompt   ", [], catalog, "queue")).toEqual({ kind: "promptGenerate", input: {} })
  expect(submission("/prompt focus the tests", [], catalog, "steer")).toEqual({ kind: "promptGenerate", input: { intent: "focus the tests" } })
  expect(submission("/prompt  keep the intent spacing ", [], { ...catalog, commands: [{ name: "prompt", description: "Configured prompt" }] }, "queue")).toEqual({ kind: "promptGenerate", input: { intent: "keep the intent spacing" } })
})

test("dollar activation, at mentions, and hash alias produce the TUI prompt parts and skill requests", () => {
  const skill = optionsForTrigger("$", "aud", catalog, [])[0]!
  const dollar = applyMention("$aud", 0, 4, skill, [])
  expect(submission(dollar.text, dollar.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { text: "$audit", skills: ["audit"] } })
  expect(submission("Use $audit, then report", [], catalog, "steer")).toMatchObject({ kind: "prompt", input: { skills: ["audit"] } })

  const agent = optionsForTrigger("@", "rev", catalog, [])[0]!
  const at = applyMention("Ask @rev", 4, 8, agent, [])
  expect(submission(at.text, at.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { agents: [{ name: "reviewer", mention: { start: 4, end: 13, text: "@reviewer" } }] } })
  const file = optionsForTrigger("@", "guide", catalog, [])[0]!
  const reference = applyMention("See @guide", 4, 10, file, [])
  expect(submission(reference.text, reference.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { files: [{ uri: "file:///work/guide", mention: { start: 4, end: 10, text: "@guide" } }] } })

  const hashAgent = optionsForTrigger("#", "review", catalog, []).find((option) => option.kind === "agent")!
  const hashSkill = optionsForTrigger("#", "audit", catalog, []).find((option) => option.kind === "skill")!
  const agentMention = applyMention("#review", 0, 7, hashAgent, [])
  const skillMention = applyMention("#audit", 0, 6, hashSkill, [])
  expect(agentMention.text).toBe("@reviewer ")
  expect(skillMention.text).toBe("$audit ")
  expect(submission(agentMention.text, agentMention.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { agents: [{ name: "reviewer" }] } })
  expect(submission(skillMention.text, skillMention.parts, catalog, "steer")).toMatchObject({ kind: "prompt", input: { skills: ["audit"] } })
})
