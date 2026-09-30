import { expect, test } from "bun:test"
import { canCancelSubagent, teamActiveCount, teamActivityLabel, formatCacheHit, formatElapsed, isManagedSubagent, shellRows, siblingTargets, taskRows, usageSlots, type TeamSubagent } from "./team-model"

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
  const data = { status: "ready" as const, shellStatus: "ready" as const, shells: [], tasks }
  expect(teamActiveCount({ ...data, activeTotal: 7 })).toBe(7)
  expect(teamActiveCount(data)).toBe(2)
  expect(teamActiveCount({ ...data, tasks: [] })).toBe(0)
})

test("Team activity includes only live shells, distinguishes unreported and truncated counts, and retains counts on background refresh", () => {
  const data = { status: "ready" as const, activeTotal: 0, tasks: [], shellStatus: "ready" as const, shells: [{ id: "sh_1", ownerID: "ses_root", command: "fixture", status: "running" as const, startedAt: 1 }] }
  expect(teamActiveCount(data)).toBe(1)
  expect(teamActivityLabel(data)).toBe("1 active")
  expect(teamActivityLabel({ ...data, shellTruncated: true })).toBe("At least 1 active")
  expect(teamActivityLabel({ ...data, shellStatus: "loading", shells: [] })).toBe("Activity unreported")
  expect(teamActivityLabel({ ...data, activeTotal: undefined, next: "next" })).toBe("At least 1 active")
  expect(teamActiveCount({ ...data, shellStatus: "loading", shells: [] })).toBeUndefined()
  expect(teamActiveCount({ ...data, shellStatus: "error" })).toBeUndefined()
  for (const status of ["exited", "timeout", "memory-limit", "killed"] as const) expect(teamActiveCount({ ...data, shells: [{ ...data.shells[0]!, status }] })).toBe(0)
})

test("progress on a running task never reshuffles its section, while a state change still moves it", () => {
  const launched = (id: string, startedAt: number, updatedAt: number, state: TeamSubagent["state"] = "running"): TeamSubagent => ({ ...task(id, state, updatedAt), startedAt })
  const before = [launched("ses_a", 1_000, 3_000), launched("ses_b", 2_000, 2_500), launched("ses_c", 3_000, 2_000)]
  expect(taskRows(before)).toEqual(["section:active", "ses_c", "ses_b", "ses_a"])
  const progressed = [launched("ses_a", 1_000, 9_000), launched("ses_b", 2_000, 2_500), launched("ses_c", 3_000, 2_000)]
  expect(taskRows(progressed)).toEqual(taskRows(before))
  expect(taskRows([launched("ses_a", 1_000, 9_000, "waiting"), launched("ses_b", 2_000, 2_500), launched("ses_c", 3_000, 2_000)])).toEqual(["section:active", "ses_a", "ses_c", "ses_b"])
})

test("finished tasks list the most recently finished first and keep that order", () => {
  const finished = [task("ses_a", "completed", 2_000), task("ses_b", "failed", 4_000), task("ses_c", "completed", 3_000)]
  expect(taskRows(finished)).toEqual(["section:inactive", "ses_c", "ses_a", "ses_b"])
})

test("usage always yields the same four slots and never turns an unreported value into zero", () => {
  const base = task("ses_a", "running", 3_000)
  const keys = (slots: ReturnType<typeof usageSlots>) => slots.map((slot) => slot.key)
  expect(keys(usageSlots(base, {}))).toEqual(["tokens", "cost", "context", "cache"])
  expect(usageSlots(base, {}).map((slot) => [slot.state, slot.value])).toEqual([["unreported", "—"], ["unreported", "—"], ["unreported", "—"], ["unreported", "—"]])
  expect(usageSlots(base, { loading: true }).map((slot) => slot.state)).toEqual(["loading", "loading", "loading", "loading"])
  const reported = { ...base, tokens: 20, cost: 0.25, contextTotal: 800, contextLimit: 2_000, cacheHitRatio: 0.75 }
  expect(usageSlots(reported, { loading: true }).map((slot) => [slot.state, slot.value])).toEqual([["value", "20"], ["value", "$0.25"], ["value", "800 / 2,000"], ["value", "75% hit"]])
  expect(usageSlots(reported, {})[2]?.meter).toBeCloseTo(0.4)
  const noLimit = usageSlots({ ...reported, contextLimit: undefined }, {})[2]
  expect(noLimit?.value).toBe("800 / unreported")
  expect(noLimit?.meter).toBeUndefined()
  expect(usageSlots({ ...reported, cost: 0, tokens: 0 }, {}).slice(0, 2).map((slot) => slot.value)).toEqual(["0", "$0.00"])
  expect(usageSlots({ ...reported, contextTotal: 5_000, contextLimit: 2_000 }, {})[2]?.meter).toBe(1)
})
