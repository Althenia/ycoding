import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { CoordinationInstructions } from "../src/coordination/instructions"
import { Instructions } from "../src/instructions/index"

const read = (role: Parameters<typeof CoordinationInstructions.make>[0]) =>
  Effect.runPromise(Instructions.read(CoordinationInstructions.make(role)))

test("coordination guidance uses one durable source and can be omitted outside its scope", async () => {
  const source = CoordinationInstructions.make("root")
  const [active] = await read("root")
  expect(active?.key).toBe(Instructions.Key.make("ycoding/coordination-voice"))
  expect(active?.value).toContain("Default to Swarm")
  expect(await Effect.runPromise(Instructions.read(Instructions.when(false, source)))).toEqual([
    { key: active?.key, value: Instructions.removed },
  ])
})

test("coordinators share one set of review boundaries without sharing role-specific controls", async () => {
  const [master] = await read("master")
  const [supervisor] = await read("supervisor")
  expect(master?.value).toContain("`project create`")
  expect(master?.value).not.toContain("`project send`")
  expect(supervisor?.value).toContain("`project send`")
  expect(supervisor?.value).not.toContain("`project create`")
  for (const role of [master, supervisor]) {
    if (typeof role?.value !== "string") throw new Error("Expected coordinator guidance")
    expect(role.value.split("Coordinate and supervise only")).toHaveLength(2)
    expect(role.value.split("Use only native `answer` or `escalate` for reviews")).toHaveLength(2)
    expect(role.value).toContain("including in Manual")
    expect(role.value).toContain("Never approve a mandatory human gate or use messages as approval")
    expect(role.value).toContain("use the member's `sessionID`; `requestSessionID` identifies the source")
  }
})

test("only coordinators receive member placement instructions", async () => {
  for (const role of ["master", "supervisor", "root", "member", "subagent", "reviewer"] as const) {
    const [instruction] = await read(role)
    if (typeof instruction?.value !== "string") throw new Error(`Expected guidance for ${role}`)
    const count = role === "master" || role === "supervisor" ? 1 : 0
    for (const clause of [
      "verify that its Location is the target repository's folder: its canonical checkout or one of its managed worktrees. Never place a member at the Project's folder unless that folder is the same repository.",
      "Reserve `~/.local/share/ycoding/tasks/` for scratch files, logs, and evidence; never use it or any subdirectory of it as a Project member Location, in any case.",
    ]) expect(instruction.value.split(clause)).toHaveLength(count + 1)
  }
})

test("losing supervision revokes controller instructions without discarding history", async () => {
  const [before] = await read("supervisor")
  const [after] = await read("reviewer")
  if (typeof before?.value !== "string" || typeof after?.value !== "string") throw new Error("Expected role guidance")
  const source = CoordinationInstructions.make("reviewer")
  const previous = { [before.key]: before.value }
  const initial = Instructions.renderInitial(source, previous)
  const update = Instructions.renderUpdate(source, previous, { [after.key]: Option.some(after.value) })
  for (const text of [initial, update]) {
    expect(text).toContain("The Project coordination role above no longer applies")
    expect(text).not.toContain("`project send`")
  }
  expect(update).toContain("Work read-only in the Master's family")
})
