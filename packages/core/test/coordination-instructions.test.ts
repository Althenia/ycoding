import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CoordinationInstructions } from "../src/coordination/instructions"
import { Instructions } from "../src/instructions/index"

test("Project instructions describe member messaging and native decisions", () => {
  expect(CoordinationInstructions.content).toContain("owner's instruction channel")
  expect(CoordinationInstructions.content).toContain("recorded human instructions or current delegated authority")
  expect(CoordinationInstructions.content).toContain("Project notifications")
  expect(CoordinationInstructions.content).toContain("do not poll")
  expect(CoordinationInstructions.content).not.toContain("dispatch receipt")
})

test("Master instructions require supervision, evidence review and reasoned escalation", () => {
  for (const instruction of [
    "Coordinate and supervise only",
    "Delegate implementation to executor Sessions",
    "concrete outcome, actions and checks, exclusions, and a stop condition",
    "Verify reported evidence before accepting work",
    "owning subagent → Master → human",
    "Bring the human only decisions and approvals",
  ]) expect(CoordinationInstructions.content).toContain(instruction)
})

test("the voice source is present only for a scoped Session", async () => {
  const active = await Effect.runPromise(Instructions.read(Instructions.when(true, CoordinationInstructions.make())))
  const inactive = await Effect.runPromise(Instructions.read(Instructions.when(false, CoordinationInstructions.make())))
  expect(active).toHaveLength(1)
  expect(active[0]?.key).toBe(Instructions.Key.make("ycoding/coordination-voice"))
  expect(active[0]?.value).toContain("Project role: Master")
  expect(active[0]?.value).toContain(CoordinationInstructions.content)
  expect(inactive[0]?.value).toEqual(Instructions.removed)
})
