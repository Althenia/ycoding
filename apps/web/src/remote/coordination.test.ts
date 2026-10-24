import { describe, expect, test } from "bun:test"
import {
  activityBuckets,
  addMemberInput,
  ageLabel,
  centralPolicyNote,
  changeMasterInput,
  concurrencyMeter,
  createProjectInput,
  delegationDraftIssue,
  effectiveDelegation,
  expiryAt,
  expiryChoices,
  externalDelivery,
  externalKind,
  filterLabel,
  filterSummary,
  freshnessLabel,
  isDefaultFilter,
  liveCounts,
  liveLabel,
  maxMasterSelection,
  memberCounts,
  normalizeFilter,
  parseConcurrency,
  parseList,
  parseProjectName,
  projectOf,
  pushFilterWire,
  readCentralPolicy,
  readFilter,
  readProject,
  readProjects,
  readSessionCandidates,
  relativeAge,
  removeMemberInput,
  renameInput,
  sessionsLabel,
  sessionTitle,
  setScope,
  settingsInput,
  statusLabel,
  summaryLine,
  toggleCategory,
  toggleMaster,
  writeFilter,
  type NotificationFilter,
  type ProjectDetail,
} from "./coordination"

const ses = (suffix: string) => `ses_${suffix}`
const now = 1_000_000_000
const participant = (suffix: string, extra: Record<string, unknown> = {}) => ({
  sessionID: ses(suffix), title: `Title ${suffix}`, location: { directory: `/work/${suffix}` }, state: "idle", lastActivity: now - 60_000, pending: [], ...extra,
})
const summary = {
  id: "cgrp_1", name: "Billing migration", revision: 4, active: true, masterSessionID: ses("lead"), memberCount: 3,
  settings: { concurrency: 3 }, time: { created: 1, updated: 9 },
}
const info = {
  id: "cgrp_1", name: "Billing migration", revision: 4, active: true, settings: { concurrency: 3 }, time: { created: 1, updated: 9 },
  master: participant("lead", { state: "running", lastActivity: now - 1_000 }),
  members: [
    participant("a", { state: "running", lastActivity: now - 12_000, drivenBy: { sessionID: "ses_driver", title: "invoices lead" } }),
    participant("b", { state: "waiting", lastActivity: now - 240_000, pending: [{ kind: "question", requestID: "q1", fingerprint: "f1", summary: "Which column should checkout read?" }] }),
    participant("c", { state: "failed", lastActivity: now - 26 * 60_000 }),
  ],
}
const detail = () => readProject({ data: info }) as ProjectDetail

describe("readers", () => {
  test("reads the project list with master, member count, settings and times, and rejects malformed rows", () => {
    expect(readProjects({ data: [summary] })).toEqual([{ id: "cgrp_1", name: "Billing migration", revision: 4, active: true, masterSessionID: ses("lead"), memberCount: 3, settings: { concurrency: 3 }, created: 1, updated: 9 }])
    expect(readProjects({ data: [] })).toEqual([])
    expect(readProjects({ data: [{ ...summary, settings: { concurrency: null } }] })?.[0]?.settings).toEqual({ concurrency: null })
    expect(readProjects({ data: [{ ...summary, active: "yes" }] })).toBeUndefined()
    expect(readProjects({ data: [{ ...summary, id: "grp_1" }] })).toBeUndefined()
    expect(readProjects({ data: [{ ...summary, masterSessionID: "x" }] })).toBeUndefined()
    expect(readProjects({ data: [{ ...summary, settings: { concurrency: 0 } }] })).toBeUndefined()
    expect(readProjects({ data: [{ ...summary, revision: -1 }] })).toBeUndefined()
    expect(readProjects({ data: "none" })).toBeUndefined()
    expect(readProjects([summary])).toBeUndefined()
    expect(readProjects(null)).toBeUndefined()
  })

  test("reads a project with its master, members in roster order, live state, pending requests and optional driver", () => {
    const project = detail()
    expect(project).toMatchObject({ id: "cgrp_1", name: "Billing migration", revision: 4, active: true, settings: { concurrency: 3 }, created: 1, updated: 9 })
    expect(project.master).toMatchObject({ sessionID: ses("lead"), title: "Title lead", directory: "/work/lead", state: "running" })
    expect(project.members.map((entry) => entry.sessionID)).toEqual([ses("a"), ses("b"), ses("c")])
    expect(project.members[0]?.drivenBy).toEqual({ sessionID: "ses_driver", title: "invoices lead" })
    expect(project.members[1]).not.toHaveProperty("drivenBy")
    expect(project.members[1]?.pending).toEqual([{ kind: "question", requestID: "q1", summary: "Which column should checkout read?" }])
  })

  test("keeps the delegated narrowing and refuses an unknown state or request kind", () => {
    const delegated = { categories: ["question", "review"] as const, actions: ["shell"], resources: ["src/**"], expiresAt: 5000 }
    expect(readProject({ data: { ...info, settings: { concurrency: null, delegatedDecisions: delegated } } })?.settings).toEqual({ concurrency: null, delegatedDecisions: delegated })
    expect(readProject({ data: { ...info, settings: { concurrency: 1, delegatedDecisions: { categories: ["deploy"] } } } })).toBeUndefined()
    expect(readProject({ data: { ...info, master: participant("lead", { state: "busy" }) } })).toBeUndefined()
    expect(readProject({ data: { ...info, members: [participant("a", { pending: [{ kind: "chat", requestID: "q", fingerprint: "f", summary: "" }] })] } })).toBeUndefined()
    expect(readProject({ data: { ...info, members: "none" } })).toBeUndefined()
    expect(readProject({})).toBeUndefined()
  })

  test("reads the central delegation policy and keeps an off policy distinct from an unreadable one", () => {
    expect(readCentralPolicy({ data: { enabled: true, categories: ["question", "permission", "review"] } })).toEqual({ enabled: true, categories: ["question", "permission", "review"] })
    expect(readCentralPolicy({ data: { enabled: false, categories: [] } })).toEqual({ enabled: false, categories: [] })
    expect(readCentralPolicy({ data: { enabled: true, categories: ["review"], actions: ["shell"], resources: ["src/**"], expiresAt: 9 } }))
      .toEqual({ enabled: true, categories: ["review"], actions: ["shell"], resources: ["src/**"], expiresAt: 9 })
    expect(readCentralPolicy({ data: { enabled: "yes", categories: [] } })).toBeUndefined()
    expect(readCentralPolicy({ data: { enabled: true, categories: ["deploy"] } })).toBeUndefined()
    expect(readCentralPolicy({})).toBeUndefined()
  })

  test("reads root Session candidates with their directory and drops rows without an id", () => {
    expect(readSessionCandidates({ data: [{ id: ses("x"), title: "Triage", location: { directory: "/work/web" }, time: { updated: 5, active: 7 } }, { title: "no id" }, { id: ses("y"), location: {}, time: {} }] })).toEqual([
      { id: ses("x"), title: "Triage", directory: "/work/web", active: 7 },
      { id: ses("y"), title: ses("y"), directory: "", active: 0 },
    ])
    expect(readSessionCandidates({})).toEqual([])
    expect(readSessionCandidates({ data: [{ id: "ses_child", parentID: "ses_root" }, { id: "ses_archived", time: { archived: 4 } }] })).toEqual([])
  })
})

describe("project wording", () => {
  test("status reads Active or Paused in words", () => {
    expect(statusLabel(true)).toBe("Active")
    expect(statusLabel(false)).toBe("Paused")
    expect(statusLabel(false, "interrupted")).toBe("Paused · interrupted")
    expect(statusLabel(false, "restart")).toBe("Paused · after restart")
  })

  test("live state names the word and a waiting member names its request kind", () => {
    const project = detail()
    expect(liveLabel(project.master)).toBe("Running")
    expect(liveLabel(project.members[1]!)).toBe("Waiting · question")
    expect(liveLabel(project.members[2]!)).toBe("Failed")
    expect(liveLabel({ ...project.members[2]!, state: "idle" })).toBe("Idle")
    expect(liveLabel({ ...project.members[1]!, pending: [] })).toBe("Waiting")
  })

  test("age reads in the state's own verb and a just-active Session reads as now", () => {
    const project = detail()
    expect(ageLabel(project.master, now)).toBe("active now")
    expect(ageLabel(project.members[0]!, now)).toBe("active 12s ago")
    expect(ageLabel(project.members[1]!, now)).toBe("asked 4m ago")
    expect(ageLabel(project.members[2]!, now)).toBe("failed 26m ago")
    expect(ageLabel({ ...project.members[0]!, state: "idle", lastActivity: now - 18 * 60_000 }, now)).toBe("finished 18m ago")
    expect(ageLabel({ ...project.members[0]!, lastActivity: now + 5_000 }, now)).toBe("active now")
  })

  test("live counts and the summary line cover the Master and every member, and omit zero waiting and failed", () => {
    const project = detail()
    const counts = liveCounts(project)
    expect(counts).toEqual({ running: 2, waiting: 1, idle: 0, failed: 1 })
    expect(counts.running + counts.waiting + counts.idle + counts.failed).toBe(project.members.length + 1)
    expect(summaryLine(counts)).toBe("2 running · 1 waiting · 1 failed")
    expect(liveCounts({ master: project.master, members: [] })).toEqual({ running: 1, waiting: 0, idle: 0, failed: 0 })
    expect(summaryLine({ running: 0, waiting: 0, idle: 2, failed: 0 })).toBe("0 running")
  })

  test("member counts exclude the Master so the concurrency meter counts members only", () => {
    const project = detail()
    expect(memberCounts(project.members)).toEqual({ running: 1, waiting: 1, idle: 0, failed: 1 })
    expect(concurrencyMeter(3, memberCounts(project.members).running)).toMatchObject({ running: 1, text: "1 of 3 running" })
  })

  test("the Session total counts the Master beside the members and agrees with the live counts", () => {
    const project = detail()
    expect(sessionsLabel(project)).toBe("4 Sessions")
    expect(sessionsLabel({ master: project.master, members: [] })).toBe("1 Session")
  })

  test("the meter shows discrete cells against a limit, saturates, and states no limit in words", () => {
    expect(concurrencyMeter(3, 2)).toEqual({ kind: "limit", limit: 3, running: 2, text: "2 of 3 running", cells: [true, true, false] })
    expect(concurrencyMeter(2, 5)).toMatchObject({ running: 2, text: "5 of 2 running", cells: [true, true] })
    expect(concurrencyMeter(null, 4)).toEqual({ kind: "unlimited", running: 4, text: "4 · no limit" })
    const large = concurrencyMeter(40, 1)
    expect(large.kind === "limit" ? large.cells : []).toHaveLength(12)
  })

  test("the activity sparkline counts members last active in each of twelve 5 minute buckets, oldest first", () => {
    const members = [{ lastActivity: now - 1_000 }, { lastActivity: now - 299_000 }, { lastActivity: now - 300_000 }, { lastActivity: now - 59 * 60_000 }, { lastActivity: now - 61 * 60_000 }, { lastActivity: now + 9_000 }]
    const buckets = activityBuckets(members, now)
    expect(buckets).toHaveLength(12)
    expect(buckets[11]).toBe(3)
    expect(buckets[10]).toBe(1)
    expect(buckets[0]).toBe(1)
    expect(buckets.reduce((sum, value) => sum + value, 0)).toBe(5)
  })

  test("freshness reads Updated N s ago and states a failed refresh while showing the earlier data", () => {
    expect(freshnessLabel({ updatedAt: now - 4_000, failedAt: undefined }, now)).toEqual({ stale: false, text: "Updated 4 s ago" })
    expect(freshnessLabel({ updatedAt: now - 130_000, failedAt: undefined }, now).text).toBe("Updated 2 min ago")
    expect(freshnessLabel({ updatedAt: now - 70_000, failedAt: now - 40_000 }, now)).toEqual({ stale: true, text: "Update failed 40 s ago · showing earlier data" })
    expect(freshnessLabel({ updatedAt: 0, failedAt: undefined }, now)).toEqual({ stale: false, text: "Updating…" })
    expect(relativeAge(125_000)).toBe("2m ago")
    expect(relativeAge(-5)).toBe("0s ago")
  })

})

describe("membership lookup", () => {
  test("finds the project and role for a master, a member and an outsider", () => {
    const groups = [{ summary: readProjects({ data: [summary] })![0]!, detail: detail() }]
    expect(projectOf(groups, ses("lead"))).toMatchObject({ role: "master", detail: { id: "cgrp_1" } })
    expect(projectOf(groups, ses("b"))).toMatchObject({ role: "member", detail: { id: "cgrp_1" } })
    expect(projectOf(groups, ses("other"))).toBeUndefined()
    expect(projectOf(undefined, ses("lead"))).toBeUndefined()
  })
})

describe("project input", () => {
  test("names are trimmed and limited to 120 characters", () => {
    expect(parseProjectName("  Billing migration  ")).toEqual({ value: "Billing migration" })
    expect(parseProjectName("   ")).toEqual({ error: "Project name is required" })
    expect(parseProjectName("x".repeat(121))).toEqual({ error: "Project name is 1 to 120 characters" })
  })

  test("a new Session title is optional, trimmed, falls back to the given default and is bounded", () => {
    expect(sessionTitle("  Release lead  ", "Billing migration")).toEqual({ value: "Release lead" })
    expect(sessionTitle("   ", "Billing migration")).toEqual({ value: "Billing migration" })
    expect(sessionTitle("")).toEqual({ value: undefined })
    expect(sessionTitle("x".repeat(120))).toEqual({ value: "x".repeat(120) })
    expect(sessionTitle("x".repeat(121))).toEqual({ error: "Session title is 1 to 120 characters" })
    expect(sessionTitle("😀".repeat(120))).toEqual({ value: "😀".repeat(120) })
    expect(sessionTitle("😀".repeat(121))).toEqual({ error: "Session title is 1 to 120 characters" })
    expect(sessionTitle("", "x".repeat(121))).toEqual({ error: "Session title is 1 to 120 characters" })
    for (const unsafe of ["a\tb", "a\u0085b", "a\u202eb", "a\u2067b", "a\u007fb"]) expect(sessionTitle(unsafe)).toEqual({ error: "Session title cannot contain control or direction-override characters" })
  })

  test("concurrency is a whole number of at least 1", () => {
    expect(parseConcurrency("3")).toEqual({ value: 3 })
    expect(parseConcurrency("0")).toEqual({ error: "Concurrency must be a whole number of at least 1" })
    expect(parseConcurrency("1.5")).toEqual({ error: "Concurrency must be a whole number of at least 1" })
    expect(parseConcurrency("999999999999999999999999")).toEqual({ error: "Concurrency must be a whole number of at least 1" })
  })

  test("parses comma and line separated lists, drops blanks and duplicates, and reports the bound", () => {
    expect(parseList("shell, edit\nshell,  ", { limit: 32, length: 512, noun: "action" })).toEqual({ value: ["shell", "edit"] })
    expect(parseList(Array.from({ length: 33 }, (_, index) => `t${index}`).join(","), { limit: 32, length: 512, noun: "action" })).toEqual({ error: "Use at most 32 actions" })
    expect(parseList("x".repeat(513), { limit: 32, length: 512, noun: "action" })).toEqual({ error: "Each action is 1 to 512 characters" })
  })

  test("creating names the master and starts with no members", () => {
    expect(createProjectInput("Billing", ses("lead"))).toEqual({ name: "Billing", masterSessionID: ses("lead"), memberSessionIDs: [] })
  })

  test("every update carries the revision it was opened with and only the changed field", () => {
    const project = detail()
    expect(renameInput(project, "Renamed")).toEqual({ groupID: "cgrp_1", revision: 4, name: "Renamed" })
    expect(addMemberInput(project, ses("d"))).toEqual({ groupID: "cgrp_1", revision: 4, memberSessionIDs: [ses("a"), ses("b"), ses("c"), ses("d")] })
    expect(removeMemberInput(project, ses("b"))).toEqual({ groupID: "cgrp_1", revision: 4, memberSessionIDs: [ses("a"), ses("c")] })
    expect(settingsInput(project, { concurrency: null })).toEqual({ groupID: "cgrp_1", revision: 4, settings: { concurrency: null } })
    expect(settingsInput(project, { concurrency: 2, delegatedDecisions: { categories: ["review"] } }).settings).toEqual({ concurrency: 2, delegatedDecisions: { categories: ["review"] } })
  })

  test("adding refuses duplicates, the master and more than 64 members before any call", () => {
    const project = detail()
    expect(() => addMemberInput(project, ses("a"))).toThrow("already in this Project")
    expect(() => addMemberInput(project, ses("lead"))).toThrow("already in this Project")
    const full = { ...project, members: Array.from({ length: 64 }, (_, index) => ({ ...project.members[0]!, sessionID: ses(`m${index}`) })) }
    expect(() => addMemberInput(full, ses("extra"))).toThrow("at most 64")
  })

  test("changing the master keeps the old master as an ordinary member, first in the member list", () => {
    const project = detail()
    expect(changeMasterInput(project, ses("b"))).toEqual({ groupID: "cgrp_1", revision: 4, masterSessionID: ses("b"), memberSessionIDs: [ses("lead"), ses("a"), ses("c")] })
    expect(() => changeMasterInput(project, ses("lead"))).toThrow("already the Master")
  })

})

describe("delegated decisions", () => {
  const central = { enabled: true, categories: ["question", "permission", "review"] as const }

  test("a group inherits central policy when it narrows nothing", () => {
    expect(effectiveDelegation(central, undefined)).toEqual({ state: "inherited", categories: ["question", "permission", "review"] })
  })

  test("a group can only narrow: categories intersect and actions, resources and expiry add", () => {
    const delegated = { categories: ["question", "review"] as const, actions: ["shell"], resources: ["src/**"], expiresAt: 5000 }
    expect(effectiveDelegation({ ...central, categories: ["review", "permission"], expiresAt: 4000 }, delegated)).toEqual({
      state: "narrowed", categories: ["review"], actions: ["shell"], resources: ["src/**"], expiresAt: 4000,
    })
    expect(effectiveDelegation(central, { categories: [] })).toEqual({ state: "narrowed", categories: [] })
  })

  test("an off central policy revokes every group and an unreadable one is reported unavailable", () => {
    expect(effectiveDelegation({ enabled: false, categories: ["question"] }, { categories: ["question"] })).toEqual({ state: "revoked", categories: [] })
    expect(effectiveDelegation(undefined, { categories: ["question"] })).toEqual({ state: "unavailable", categories: [] })
    expect(centralPolicyNote(undefined)).toBe("Central delegation policy is unavailable, so Project narrowing cannot be checked or changed here.")
    expect(centralPolicyNote({ enabled: false, categories: [] })).toBe("Central delegation policy is off: delegated decisions are revoked for every Project.")
    expect(centralPolicyNote(central)).toBe("Central delegation policy is on. A Project can only narrow it; the narrowest setting applies.")
  })

  test("a draft may not widen the central categories or leave a stale expiry", () => {
    expect(delegationDraftIssue(central, { categories: ["question"] }, 1000)).toBeUndefined()
    expect(delegationDraftIssue({ ...central, categories: ["review"] }, { categories: ["question"] }, 1000)).toBe("The central policy does not delegate question decisions, so a Project cannot")
    expect(delegationDraftIssue(central, { categories: ["review"], expiresAt: 999 }, 1000)).toBe("The expiry has already passed")
    expect(delegationDraftIssue(central, { categories: ["review"], actions: Array.from({ length: 33 }, (_, index) => `a${index}`) }, 1000)).toBe("Use at most 32 actions")
    expect(delegationDraftIssue({ enabled: false, categories: [] }, { categories: [] }, 1000)).toBe("Central delegation policy is off")
    expect(delegationDraftIssue(undefined, { categories: [] }, 1000)).toBe("Central delegation policy is unavailable")
  })
})

describe("external notification filter", () => {
  const all: NotificationFilter = { scope: "all" }

  test("normalization drops anything it cannot prove and keeps the contract bounds", () => {
    expect(normalizeFilter(undefined)).toEqual(all)
    expect(normalizeFilter("selected")).toEqual(all)
    expect(normalizeFilter({ scope: "nobody" })).toEqual(all)
    expect(normalizeFilter({ scope: "coordinators", sessionIDs: [ses("a")], categories: ["question", "bogus", "question"] })).toEqual({ scope: "coordinators", categories: ["question"] })
    expect(normalizeFilter({ scope: "selected", sessionIDs: [ses("a"), "x", ses("a"), ses("b")] })).toEqual({ scope: "selected", sessionIDs: [ses("a"), ses("b")] })
    expect(normalizeFilter({ scope: "selected" })).toEqual({ scope: "selected", sessionIDs: [] })
    expect(normalizeFilter({ scope: "all", categories: [] })).toEqual({ scope: "all", categories: [] })
    expect(normalizeFilter({ scope: "all", categories: ["question", "permission", "review", "failure", "completion"] })).toEqual(all)
    expect(normalizeFilter({ scope: "selected", sessionIDs: Array.from({ length: 200 }, (_, index) => ses(`s${index}`)) }).sessionIDs).toHaveLength(maxMasterSelection)
    expect(isDefaultFilter(all)).toBe(true)
    expect(isDefaultFilter({ scope: "all", categories: [] })).toBe(false)
    expect(isDefaultFilter({ scope: "selected", sessionIDs: [] })).toBe(false)
  })

  test("selecting masters switches to the selected scope and an empty selection notifies nobody", () => {
    const one = toggleMaster(all, ses("a"))
    expect(one).toEqual({ scope: "selected", sessionIDs: [ses("a")] })
    expect(toggleMaster(one, ses("b"))).toEqual({ scope: "selected", sessionIDs: [ses("a"), ses("b")] })
    expect(toggleMaster(one, ses("a"))).toEqual({ scope: "selected", sessionIDs: [] })
    const full = { scope: "selected" as const, sessionIDs: Array.from({ length: maxMasterSelection }, (_, index) => ses(`s${index}`)) }
    expect(toggleMaster(full, ses("extra"))).toBe(full)
    expect(toggleMaster({ scope: "coordinators", categories: ["failure"] }, ses("a"))).toEqual({ scope: "selected", sessionIDs: [ses("a")], categories: ["failure"] })
  })

  test("choosing a scope keeps the categories and drops a retained selection", () => {
    expect(setScope({ scope: "selected", sessionIDs: [ses("a")], categories: ["question"] }, "coordinators")).toEqual({ scope: "coordinators", categories: ["question"] })
    expect(setScope({ scope: "coordinators" }, "selected")).toEqual({ scope: "selected", sessionIDs: [] })
    expect(setScope({ scope: "selected", sessionIDs: [ses("a")] }, "all")).toEqual(all)
  })

  test("category toggles treat absent as all, allow muting everything and collapse back to all", () => {
    const withoutReview = toggleCategory(all, "review")
    expect(withoutReview).toEqual({ scope: "all", categories: ["question", "permission", "failure", "completion"] })
    expect(toggleCategory(withoutReview, "review")).toEqual(all)
    const muted = ["question", "permission", "failure", "completion"].reduce<NotificationFilter>((current, kind) => toggleCategory(current, kind as never), withoutReview)
    expect(muted).toEqual({ scope: "all", categories: [] })
    expect(toggleCategory(muted, "question")).toEqual({ scope: "all", categories: ["question"] })
    expect(toggleCategory({ scope: "selected", sessionIDs: [ses("a")] }, "failure")).toEqual({ scope: "selected", sessionIDs: [ses("a")], categories: ["question", "permission", "review", "completion"] })
  })

  test("external delivery is decided by one session and kind check and never gates session-less alerts", () => {
    const masters = new Set([ses("lead")])
    expect(externalDelivery(all, masters, ses("w1"), "question")).toBe(true)
    expect(externalDelivery(all, undefined, undefined, undefined)).toBe(true)
    expect(externalDelivery({ scope: "all", categories: [] }, masters, ses("w1"), "question")).toBe(false)
    expect(externalDelivery({ scope: "all", categories: [] }, masters, undefined, undefined)).toBe(true)
    expect(externalDelivery({ scope: "all", categories: ["question"] }, masters, ses("w1"), "completion")).toBe(false)
    expect(externalDelivery({ scope: "all", categories: ["question"] }, masters, ses("w1"), undefined)).toBe(false)
    expect(externalDelivery({ scope: "coordinators" }, masters, ses("lead"), "failure")).toBe(true)
    expect(externalDelivery({ scope: "coordinators" }, masters, ses("w1"), "failure")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("w1")] }, masters, ses("w1"), "review")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("lead")] }, masters, ses("lead"), "review")).toBe(true)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("w1")] }, masters, ses("lead"), "review")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [] }, masters, ses("w1"), "review")).toBe(false)
  })

  test("an unreadable master list withholds the masters scope instead of reading as all sessions", () => {
    expect(externalDelivery({ scope: "coordinators" }, undefined, ses("lead"), "question")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("lead")] }, undefined, ses("lead"), "question")).toBe(false)
    expect(externalDelivery(all, undefined, ses("lead"), "question")).toBe(true)
  })

  test("alert kinds map to the filter categories and an unmapped need is not guessed", () => {
    expect(externalKind("agent-completed", undefined)).toBe("completion")
    expect(externalKind("approval-requested", "permission")).toBe("permission")
    expect(externalKind("approval-requested", "question")).toBe("question")
    expect(externalKind("approval-requested", "review")).toBe("review")
    expect(externalKind("approval-requested", "blocked")).toBe("review")
    expect(externalKind("approval-requested", "failed")).toBe("failure")
    expect(externalKind("approval-requested", "lost")).toBe("failure")
    expect(externalKind("approval-requested", undefined)).toBeUndefined()
  })

  test("the wire form is absent for the default and carries only what the scope uses", () => {
    expect(pushFilterWire(all)).toBeUndefined()
    expect(pushFilterWire({ scope: "coordinators", categories: ["failure"] })).toEqual({ scope: "coordinators", categories: ["failure"] })
    expect(pushFilterWire({ scope: "selected", sessionIDs: [ses("a")] })).toEqual({ scope: "selected", sessionIDs: [ses("a")] })
    expect(pushFilterWire({ scope: "selected", sessionIDs: [] })).toEqual({ scope: "selected", sessionIDs: [] })
    expect(pushFilterWire({ scope: "all", categories: [] })).toEqual({ scope: "all", categories: [] })
    expect(pushFilterWire({ scope: "coordinators", sessionIDs: [ses("stale")] } as NotificationFilter)).toEqual({ scope: "coordinators" })
  })

  test("labels state the scope, the categories and an unavailable list without reading as all sessions", () => {
    const names = [{ sessionID: ses("lead"), title: "Lead" }, { sessionID: ses("two"), title: "Two" }, { sessionID: ses("three"), title: "Three" }]
    expect(filterLabel(all, names)).toBe("all sessions")
    expect(filterLabel({ scope: "all", categories: ["question", "review"] }, names)).toBe("all sessions · question, review")
    expect(filterLabel({ scope: "all", categories: [] }, names)).toBe("all sessions · no categories (muted)")
    expect(filterLabel({ scope: "coordinators" }, names)).toBe("all masters")
    expect(filterLabel({ scope: "coordinators" }, undefined)).toBe("all masters · list unavailable, withheld until it loads")
    expect(filterLabel({ scope: "selected", sessionIDs: [] }, names)).toBe("no sessions selected · nothing notifies externally")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead"), ses("two"), ses("three")] }, names)).toBe("masters: Lead, Two +1")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead"), ses("gone")] }, names)).toBe("masters: Lead, unknown session")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead")] }, undefined)).toBe("1 selected master · list unavailable")
  })

  test("the settings summary names the scope and categories without needing the master list", () => {
    expect(filterSummary(all)).toBe("all sessions")
    expect(filterSummary({ scope: "coordinators", categories: ["failure"] })).toBe("all masters · failure")
    expect(filterSummary({ scope: "selected", sessionIDs: [ses("a"), ses("b")] })).toBe("2 selected masters")
    expect(filterSummary({ scope: "selected", sessionIDs: [] })).toBe("no sessions selected · nothing notifies externally")
    expect(filterSummary({ scope: "all", categories: [] })).toBe("all sessions · no categories (muted)")
  })

  test("the filter is stored per browser and a malformed value reads as the default", () => {
    const data = new Map<string, string>()
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) }
    expect(readFilter(storage)).toEqual(all)
    expect(writeFilter(storage, { scope: "selected", sessionIDs: [ses("a")], categories: ["failure"] })).toBe(true)
    expect(readFilter(storage)).toEqual({ scope: "selected", sessionIDs: [ses("a")], categories: ["failure"] })
    data.set("ycoding.remote.notification-filter", "{not json")
    expect(readFilter(storage)).toEqual(all)
    expect(writeFilter({ getItem: () => null, setItem: () => { throw new Error("blocked") } }, all)).toBe(false)
    expect(readFilter(undefined)).toEqual(all)
  })
})
