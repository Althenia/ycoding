import { expect, test } from "bun:test"
import { accountedTask } from "../../../test/usage-fixture"
import { canCancelSubagent, teamActiveCount, teamActivityLabel, formatCacheHit, formatElapsed, isManagedSubagent, pinAction, shellRows, shellStatusLabel, siblingTargets, taskRows, usageSlots, type TeamSubagent } from "./team-model"

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
  for (const status of ["queued", "exited", "timeout", "memory-limit", "killed"] as const) expect(teamActiveCount({ ...data, shells: [{ ...data.shells[0]!, status }] })).toBe(0)
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

test("pinned tasks lead Team under Pinned in pin-time order, followed by existing task sections", () => {
  const tasks = [
    { ...task("ses_recent_pin", "completed", 9_000), pinnedAt: 20 },
    task("ses_running", "running", 8_000),
    { ...task("ses_early_pin", "running", 1_000), pinnedAt: 10 },
    task("ses_done", "completed", 7_000),
  ]
  expect(taskRows(tasks)).toEqual(["section:pinned", "ses_early_pin", "ses_recent_pin", "section:active", "ses_running", "section:inactive", "ses_done"])
})

test("Team pin controls name the action from durable pin state", () => {
  expect(pinAction(task("ses_child", "running", 1_000))).toEqual({ pinned: false, action: "pin", label: "Pin Review ses_child", title: "Pin" })
  expect(pinAction({ ...task("ses_child", "running", 1_000), pinnedAt: 4_000 })).toEqual({ pinned: true, action: "unpin", label: "Unpin Review ses_child", title: "Unpin" })
})

test("usage always yields the same four slots and never turns an unreported value into zero", () => {
  const base = task("ses_a", "running", 3_000)
  const keys = (slots: ReturnType<typeof usageSlots>) => slots.map((slot) => slot.key)
  expect(keys(usageSlots(base, {}))).toEqual(["tokens", "cost", "context", "cache"])
  expect(usageSlots(base, {}).map((slot) => [slot.state, slot.value])).toEqual([["unreported", "—"], ["unreported", "—"], ["unreported", "—"], ["unreported", "—"]])
  expect(usageSlots(base, { loading: true }).map((slot) => slot.state)).toEqual(["loading", "loading", "loading", "loading"])
  const reported = { ...base, accounting: accountedTask(base.sessionID), contextTotal: 800, contextLimit: 2_000, cacheHitRatio: 0.75 }
  expect(usageSlots(reported, { loading: true }).map((slot) => [slot.state, slot.value])).toEqual([["value", "20"], ["value", "$0.25"], ["value", "800 / 2,000"], ["value", "75% hit"]])
  expect(usageSlots(reported, {})[2]?.meter).toBeCloseTo(0.4)
  const noLimit = usageSlots({ ...reported, contextLimit: undefined }, {})[2]
  expect(noLimit?.value).toBe("800 / unreported")
  expect(noLimit?.meter).toBeUndefined()
  expect(usageSlots({ ...reported, accounting: accountedTask(base.sessionID, 0, 0) }, {}).slice(0, 2).map((slot) => slot.value)).toEqual(["0", "$0.00"])
  const partial = accountedTask(base.sessionID)
  expect(usageSlots({ ...reported, accounting: { ...partial, status: "so-far", attribution: "partial", total: { ...partial.total, cost: { known: 0.25, pricedRequests: 1, unpricedRequests: 1, provenance: "recorded" } } } }, {})[1]?.value).toBe("Known $0.25 + unreported · so far · incomplete")
  expect(usageSlots({ ...reported, contextTotal: 5_000, contextLimit: 2_000 }, {})[2]?.meter).toBe(1)
})

test("queued shells show their queue position and other statuses show their own word", () => {
  expect(shellStatusLabel({ status: "queued", queuePosition: 2 })).toBe("queued #2")
  expect(shellStatusLabel({ status: "queued" })).toBe("queued")
  expect(shellStatusLabel({ status: "running" })).toBe("running")
  expect(shellStatusLabel({ status: "killed", queuePosition: 2 })).toBe("killed")
})

test("a connector without task costs states the update in Tokens and Cost, never a bare dash", () => {
  const base: TeamSubagent = { sessionID: "ses_child", parentID: "ses_root", description: "Task", state: "running", revision: 1, updatedAt: 1, cacheHitRatio: 0.5 }
  const slots = usageSlots(base, { accountingUnsupported: true })
  expect(slots.map((slot) => [slot.label, slot.state, slot.value])).toEqual([
    ["Tokens (inclusive)", "unsupported", "Update YCoding"], ["Cost (inclusive)", "unsupported", "Update YCoding"], ["Context", "unreported", "—"], ["Cache", "value", "50% hit"],
  ])
  expect(usageSlots(base, { accountingUnsupported: true, loading: true }).map((slot) => slot.state)).toEqual(["unsupported", "unsupported", "loading", "value"])
  expect(usageSlots(base, { loading: true }).slice(0, 2).map((slot) => slot.state)).toEqual(["loading", "loading"])
  expect(usageSlots({ ...base, accounting: accountedTask("ses_child") }, { accountingUnsupported: true }).slice(0, 2).map((slot) => slot.state)).toEqual(["value", "value"])
})
