import { expect, test } from "bun:test"
import { canCancelSubagent, teamActiveCount, formatCacheHit, formatElapsed, isManagedSubagent, shellRows, siblingTargets, taskRows, type TeamSubagent } from "./team-model"

const task = (id: string, state: TeamSubagent["state"], updatedAt: number): TeamSubagent => ({
  sessionID: id, parentID: "ses_root", agent: "omoikane", description: `Review ${id}`, state, revision: 1,
  updatedAt, startedAt: 1_000, modelLabel: "openai/gpt-6-sol#high",
})

test("only managed child Sessions hide the composer; BTW and roots keep it", () => {
  expect(isManagedSubagent({ parentID: "ses_root", agent: "omoikane" })).toBe(true)
  expect(isManagedSubagent({ parentID: "ses_root", agent: undefined })).toBe(true)
  expect(isManagedSubagent({ parentID: "ses_root", agent: "btw" })).toBe(false)
  expect(isManagedSubagent({ agent: "omoikane" })).toBe(false)
})

test("task sections keep stable ID rows across fresh objects and active-to-inactive transitions", () => {
  const first = [task("ses_a", "running", 3_000), task("ses_b", "waiting", 4_000), task("ses_c", "completed", 2_000)]
  expect(taskRows(first)).toEqual(["section:active", "ses_b", "ses_a", "section:inactive", "ses_c"])
  expect(taskRows(first.map((entry) => ({ ...entry })))).toEqual(taskRows(first))
  expect(taskRows(first.map((entry) => entry.sessionID === "ses_a" ? { ...entry, state: "cancelled" } : entry))).toEqual([
    "section:active", "ses_b", "section:inactive", "ses_c", "ses_a",
  ])
  expect(canCancelSubagent("starting")).toBe(true)
  expect(canCancelSubagent("running")).toBe(true)
  expect(canCancelSubagent("waiting")).toBe(true)
  expect(canCancelSubagent("cancelling")).toBe(false)
  expect(canCancelSubagent("completed")).toBe(false)
})

test("subagent navigation and diagnostics use reported values without inventing quota", () => {
  const tasks = [task("ses_a", "running", 3_000), task("ses_b", "waiting", 4_000), task("ses_c", "completed", 2_000)]
  expect(siblingTargets(tasks, "ses_b")).toEqual({ previous: undefined, next: "ses_a" })
  expect(siblingTargets(tasks, "ses_a")).toEqual({ previous: "ses_b", next: "ses_c" })
  expect(formatCacheHit(undefined)).toBe("—")
  expect(formatCacheHit(1)).toBe("100% hit")
  expect(formatElapsed(1_000, 37_021_000)).toBe("10h 17m")
})

test("shell groups keep owner and shell IDs stable across fresh rows", () => {
  const shells = [
    { id: "sh_1", ownerID: "ses_root", command: "bun test", status: "running" as const, startedAt: 1 },
    { id: "sh_2", ownerID: "ses_child", command: "git status", status: "running" as const, startedAt: 2 },
    { id: "sh_3", ownerID: "ses_root", command: "bun lint", status: "running" as const, startedAt: 3 },
  ]
  expect(shellRows(shells)).toEqual(["owner:ses_root", "sh_1", "sh_3", "owner:ses_child", "sh_2"])
  expect(shellRows(shells.map((entry) => ({ ...entry })))).toEqual(shellRows(shells))
})

test("the Team count is the reported active total, else the active tasks in the loaded page", () => {
  const tasks = [task("ses_a", "running", 3_000), task("ses_b", "completed", 2_000), task("ses_c", "waiting", 1_000)]
  expect(teamActiveCount({ activeTotal: 7, tasks })).toBe(7)
  expect(teamActiveCount({ tasks })).toBe(2)
  expect(teamActiveCount({ tasks: [] })).toBe(0)
})
