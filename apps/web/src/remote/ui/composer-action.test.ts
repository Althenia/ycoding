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
