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

test("controller guidance separates orchestration from member execution and native approval", async () => {
  for (const role of ["master", "supervisor"] as const) {
    const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role)))
    expect(entries[0]?.value).toContain("Do not execute a member's task, take over its tools, or control its subagents.")
    expect(entries[0]?.value).toContain("Verify assignments and completion evidence against the user's current direction.")
    expect(entries[0]?.value).toContain("Decide escalations only within recorded authority and the native decision policy.")
    expect(entries[0]?.value).toContain("Manual-mode requests remain human-only.")
    expect(entries[0]?.value).not.toContain("keep authoring and reviewing on separate files")
  }
})

test("executor guidance keeps delivery and subagent ownership local without controller authority", async () => {
  const entries = await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor")))
  expect(entries[0]?.value).toContain("Own execution and verification of your assigned scope.")
  expect(entries[0]?.value).toContain("Manage only your own direct subagents when delegation is permitted.")
  expect(entries[0]?.value).toContain("Escalate unresolved decisions to the recorded owner with evidence and a recommendation.")
  expect(entries[0]?.value).toContain("Project membership or controller ancestry grants no Project control authority.")
  expect(entries[0]?.value).not.toContain(CoordinationInstructions.content)
})

test("controller and executor guidance share one consolidated-verification practice with role-specific wording", async () => {
  for (const role of ["master", "supervisor"] as const) {
    const value = (await Effect.runPromise(Instructions.read(CoordinationInstructions.make(role))))[0]?.value
    for (const text of [
      "Require each assignment to plan and complete its coherent bounded work, including code, tests, contracts, docs and consumers, before one consolidated build and verification pass, with no repetitive micro-edit/build/test loops",
      "Reuse valid evidence for unchanged relevant sources, contracts and environment, including at integration and merge",
      "A rerun needs a concrete relevant source change, failed check, invalidated evidence or explicit acceptance requirement; state the trigger, run only affected checks, and batch corrections first",
    ]) expect(value?.split(text)).toHaveLength(2)
    expect(value).not.toContain("Reuse valid check results and rerun only the scope whose inputs changed")
  }
  const executor = (await Effect.runPromise(Instructions.read(CoordinationInstructions.make("executor"))))[0]?.value
  for (const text of [
    "Plan and finish your coherent bounded scope, including code, tests, contracts, docs and consumers, before one consolidated build and verification pass; avoid repetitive micro-edit/build/test loops.",
    "Reuse evidence still valid for unchanged relevant sources, contracts and environment; rerun only affected checks after a stated trigger: a relevant source change, failed check, invalidated evidence or explicit acceptance requirement.",
  ]) expect(executor?.split(text)).toHaveLength(2)
  expect(executor).not.toContain("Require each assignment to plan")
})
