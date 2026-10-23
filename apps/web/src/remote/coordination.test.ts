import { describe, expect, test } from "bun:test"
import {
  assignRole,
  selectionLines,
  filterSummary,
  expiryAt,
  expiryChoices,
  leaseLine,
  queueItems,
  queueReasonLabel,
  receiptLine,
  relativeAge,
  sessionLabel,
  capacitySummary,
  centralPolicyNote,
  createGroupInput,
  delegationDraftIssue,
  effectiveDelegation,
  externalDelivery,
  externalKind,
  filterLabel,
  isDefaultFilter,
  lifecycleActions,
  maxCoordinatorSelection,
  membersInput,
  normalizeFilter,
  parseBudget,
  parseConcurrency,
  parseGroupName,
  parseList,
  parseQueueCapacity,
  pushFilterWire,
  readCapacity,
  readCentralPolicy,
  readDetail,
  readFilter,
  readGroups,
  readReceipts,
  removeMember,
  rosterIssue,
  setScope,
  statusLabel,
  toggleCategory,
  toggleCoordinator,
  writeFilter,
  type GroupDetail,
  type MemberView,
  type NotificationFilter,
} from "./coordination"

const ses = (suffix: string) => `ses_${suffix}`
const member = (suffix: string, role: MemberView["role"] = "worker"): MemberView => ({ sessionID: ses(suffix), role })
const policy = { concurrency: 1, queueCapacity: 64 }
const info = {
  id: "cgrp_1", name: "Release", status: "armed", revision: 4, policy, fencingGeneration: 2,
  members: [{ sessionID: ses("lead"), role: "coordinator", location: { directory: "/repo" } }, { sessionID: ses("w1"), role: "worker", allowedTools: ["read"], resourceScopes: ["src/**"], location: { directory: "/repo" } }],
  time: { created: 1, updated: 9 },
}

describe("readers", () => {
  test("reads the group list and rejects malformed rows without dropping the whole answer silently", () => {
    const summary = { id: "cgrp_1", name: "Release", status: "armed", revision: 4, policy, fencingGeneration: 2, memberCount: 2, time: { created: 1, updated: 9 } }
    expect(readGroups({ data: [summary] })).toEqual([{ id: "cgrp_1", name: "Release", status: "armed", revision: 4, policy, memberCount: 2, created: 1, updated: 9 }])
    expect(readGroups({ data: [] })).toEqual([])
    expect(readGroups({ data: [{ ...summary, status: "running" }] })).toBeUndefined()
    expect(readGroups({ data: [{ ...summary, revision: -1 }] })).toBeUndefined()
    expect(readGroups({ data: [{ ...summary, policy: { concurrency: 0, queueCapacity: 64 } }] })).toBeUndefined()
    expect(readGroups({ data: [{ ...summary, id: "grp_1" }] })).toBeUndefined()
    expect(readGroups({ data: "none" })).toBeUndefined()
    expect(readGroups(null)).toBeUndefined()
    expect(readGroups([summary])).toBeUndefined()
  })

  test("reads a group detail with roster, claims and dispatches and keeps the delegated policy", () => {
    const delegated = { categories: ["question", "review"], actions: ["shell"], resources: ["src/**"], expiresAt: 5000 }
    const detail = readDetail({ data: { ...info, policy: { ...policy, budget: 12.5, delegatedDecisions: delegated },
      claims: [{ groupID: "cgrp_1", targetSessionID: ses("w1"), holderSessionID: ses("lead"), generation: 2, status: "active", leaseExpiresAt: 9000 }],
      dispatches: [{ id: "cdsp_1", groupID: "cgrp_1", targetSessionID: ses("w1"), coordinatorSessionID: ses("lead"), generation: 2, status: "queued", reason: "capacity", text: "Run tests", time: { created: 2, updated: 3 } }] } })
    expect(detail).toMatchObject({
      id: "cgrp_1", name: "Release", status: "armed", revision: 4,
      policy: { concurrency: 1, queueCapacity: 64, budget: 12.5, delegatedDecisions: delegated },
      members: [{ sessionID: ses("lead"), role: "coordinator" }, { sessionID: ses("w1"), role: "worker", allowedTools: ["read"], resourceScopes: ["src/**"] }],
      claims: [{ targetSessionID: ses("w1"), holderSessionID: ses("lead"), generation: 2, status: "active", leaseExpiresAt: 9000 }],
      dispatches: [{ id: "cdsp_1", status: "queued", reason: "capacity", text: "Run tests", targetSessionID: ses("w1") }],
    })
    expect(detail?.members[0]).not.toHaveProperty("location")
    expect(readDetail({ data: { ...info, claims: [], dispatches: [] } })?.policy).toEqual(policy)
    expect(readDetail({ data: { ...info, members: [{ sessionID: "x", role: "worker" }], claims: [], dispatches: [] } })).toBeUndefined()
    expect(readDetail({ data: { ...info, members: [{ sessionID: ses("a"), role: "owner" }], claims: [], dispatches: [] } })).toBeUndefined()
    expect(readDetail({ data: { ...info, claims: "none", dispatches: [] } })).toBeUndefined()
    expect(readDetail({ data: { ...info, policy: { ...policy, delegatedDecisions: { categories: ["deploy"] } }, claims: [], dispatches: [] } })).toBeUndefined()
  })

  test("reads capacity with an absent hard limit as unreported and never as zero", () => {
    const capacity = { groupID: "cgrp_1", concurrency: 2, hardLimit: null, effectiveLimit: null, active: 3, waiting: 0, queued: 1, queueCapacity: 64, available: null, spent: 1.5 }
    expect(readCapacity({ data: capacity })).toMatchObject({ active: 3, hardLimit: null, effectiveLimit: null, available: null, queued: 1, queueCapacity: 64, spent: 1.5 })
    expect(readCapacity({ data: { ...capacity, hardLimit: 4, effectiveLimit: 2 } })).toMatchObject({ hardLimit: 4, effectiveLimit: 2 })
    expect(readCapacity({ data: { ...capacity, active: "3" } })).toBeUndefined()
    expect(readCapacity({ data: { ...capacity, hardLimit: undefined } })).toBeUndefined()
  })

  test("reads receipts in reported order and rejects an unknown kind", () => {
    const receipt = { id: "crcpt_1", groupID: "cgrp_1", dispatchID: "cdsp_1", kind: "admitted", sessionID: ses("w1"), time: 7, detail: "ok" }
    expect(readReceipts({ data: [receipt] })).toEqual([{ id: "crcpt_1", kind: "admitted", sessionID: ses("w1"), dispatchID: "cdsp_1", detail: "ok", time: 7 }])
    expect(readReceipts({ data: [{ ...receipt, kind: "rejected" }] })).toBeUndefined()
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
})

describe("lifecycle and capacity wording", () => {
  test("status labels follow the reported status without lossy mapping", () => {
    expect(statusLabel("stopped")).toBe("stopped · workers keep running")
    expect(statusLabel("needs-rearm")).toBe("needs re-arm")
    expect(["disarmed", "armed", "waiting", "completed"].map((status) => statusLabel(status as never))).toEqual(["disarmed", "armed", "waiting", "completed"])
  })

  test("actions follow the status and never claim to cancel workers", () => {
    expect(lifecycleActions("disarmed").map((action) => action.id)).toEqual(["arm"])
    expect(lifecycleActions("armed").map((action) => action.id)).toEqual(["stop", "complete"])
    expect(lifecycleActions("waiting").map((action) => action.id)).toEqual(["stop", "complete"])
    expect(lifecycleActions("stopped").map((action) => action.id)).toEqual(["rearm", "complete"])
    expect(lifecycleActions("needs-rearm").map((action) => action.id)).toEqual(["rearm", "complete"])
    expect(lifecycleActions("completed")).toEqual([])
    expect(lifecycleActions("armed")[0]?.title).toBe("Stop dispatch · workers keep running")
  })

  test("capacity never hides the hard limit and reports an absent one honestly", () => {
    expect(capacitySummary({ active: 1, hardLimit: 4, concurrency: 2 })).toBe("1/2 workers · hard limit 4")
    expect(capacitySummary({ active: 1, hardLimit: 4, concurrency: null })).toBe("1/4 workers · uncapped policy · hard limit 4")
    expect(capacitySummary({ active: 1, hardLimit: 4, concurrency: 9 })).toBe("1/4 workers · hard limit 4 · policy 9 capped")
    expect(capacitySummary({ active: 3, hardLimit: null, concurrency: 2 })).toBe("3 workers · policy 2 · hard limit unreported")
    expect(capacitySummary({ active: 3, hardLimit: null, concurrency: null })).toBe("3 workers · uncapped policy · hard limit unreported")
    expect(capacitySummary(undefined)).toBe("capacity unreported")
  })
})

describe("roster rules", () => {
  test("requires exactly one coordinator, unique sessions and at most 64 members", () => {
    expect(rosterIssue([member("a", "coordinator"), member("b")])).toBeUndefined()
    expect(rosterIssue([])).toBe("A group needs exactly one coordinator")
    expect(rosterIssue([member("a"), member("b")])).toBe("A group needs exactly one coordinator")
    expect(rosterIssue([member("a", "coordinator"), member("b", "coordinator")])).toBe("A group needs exactly one coordinator")
    expect(rosterIssue([member("a", "coordinator"), member("a")])).toBe("A session can appear once in a roster")
    expect(rosterIssue([member("c", "coordinator"), ...Array.from({ length: 64 }, (_, index) => member(`w${index}`))])).toBe("A roster holds at most 64 sessions")
  })

  test("limits each member to 64 tools and 32 scopes of bounded length", () => {
    expect(rosterIssue([{ ...member("a", "coordinator"), allowedTools: Array.from({ length: 65 }, (_, index) => `t${index}`) }])).toBe("A session allows at most 64 tools")
    expect(rosterIssue([{ ...member("a", "coordinator"), allowedTools: ["x".repeat(129)] }])).toBe("A tool name is 1 to 128 characters")
    expect(rosterIssue([{ ...member("a", "coordinator"), resourceScopes: Array.from({ length: 33 }, (_, index) => `s${index}`) }])).toBe("A session allows at most 32 scopes")
    expect(rosterIssue([{ ...member("a", "coordinator"), resourceScopes: ["x".repeat(513)] }])).toBe("A scope is 1 to 512 characters")
  })

  test("assigning the coordinator demotes the previous one and keeps the other members' tools and scopes", () => {
    const roster: MemberView[] = [{ ...member("lead", "coordinator"), allowedTools: ["read"] }, { ...member("w1"), resourceScopes: ["src/**"] }]
    expect(assignRole(roster, { sessionID: ses("w1") }, "coordinator")).toEqual([{ ...member("lead", "worker"), allowedTools: ["read"] }, { ...member("w1", "coordinator"), resourceScopes: ["src/**"] }])
    expect(assignRole(roster, { sessionID: ses("new") }, "observer")).toEqual([...roster, member("new", "observer")])
    expect(assignRole(roster, { sessionID: ses("new") }, "coordinator").filter((entry) => entry.role === "coordinator").map((entry) => entry.sessionID)).toEqual([ses("new")])
  })

  test("removing the only coordinator is refused before any call", () => {
    const roster = [member("lead", "coordinator"), member("w1")]
    expect(removeMember(roster, ses("lead"))).toEqual({ error: "A group needs exactly one coordinator" })
    expect(removeMember(roster, ses("w1"))).toEqual({ roster: [member("lead", "coordinator")] })
  })

  test("parses comma and line separated lists, drops blanks and duplicates, and reports the bound", () => {
    expect(parseList("read, edit\nshell,read,  ", { limit: 64, length: 128, noun: "tool" })).toEqual({ value: ["read", "edit", "shell"] })
    expect(parseList("   ", { limit: 64, length: 128, noun: "tool" })).toEqual({ value: [] })
    expect(parseList(Array.from({ length: 65 }, (_, index) => `t${index}`).join(","), { limit: 64, length: 128, noun: "tool" })).toEqual({ error: "Use at most 64 tools" })
    expect(parseList("x".repeat(129), { limit: 64, length: 128, noun: "tool" })).toEqual({ error: "Each tool is 1 to 128 characters" })
  })
})

describe("group and policy input", () => {
  test("names are trimmed and limited to 120 characters", () => {
    expect(parseGroupName("  Release train  ")).toEqual({ value: "Release train" })
    expect(parseGroupName("   ")).toEqual({ error: "Name the group in 1 to 120 characters" })
    expect(parseGroupName("x".repeat(121))).toEqual({ error: "Name the group in 1 to 120 characters" })
  })

  test("concurrency, queue capacity and budget follow the shared rules", () => {
    expect(parseConcurrency("3")).toEqual({ value: 3 })
    expect(parseConcurrency("0")).toEqual({ error: "Concurrency must be a whole number of at least 1" })
    expect(parseConcurrency("1.5")).toEqual({ error: "Concurrency must be a whole number of at least 1" })
    expect(parseQueueCapacity("1000")).toEqual({ value: 1000 })
    expect(parseQueueCapacity("1001")).toEqual({ error: "Queue capacity must be a whole number from 1 to 1000" })
    expect(parseBudget("$12.50")).toEqual({ value: 12.5 })
    expect(parseBudget("none")).toEqual({ value: undefined })
    expect(parseBudget("")).toEqual({ value: undefined })
    expect(parseBudget("0")).toEqual({ error: "Budget must be a positive USD amount with up to two decimals, or none" })
    expect(parseBudget("1.234")).toEqual({ error: "Budget must be a positive USD amount with up to two decimals, or none" })
  })

  test("a new group starts with the shared default policy and its roster in the sent order", () => {
    expect(createGroupInput("Release", [member("lead", "coordinator"), { ...member("w1"), allowedTools: ["read"], resourceScopes: ["src/**"] }])).toEqual({
      name: "Release", policy: { concurrency: 1, queueCapacity: 64 },
      members: [{ sessionID: ses("lead"), role: "coordinator" }, { sessionID: ses("w1"), role: "worker", allowedTools: ["read"], resourceScopes: ["src/**"] }],
    })
  })

  test("a members update carries the revision, preserves the policy and renames only when the name changes", () => {
    const detail = readDetail({ data: { ...info, policy: { ...policy, budget: 3, delegatedDecisions: { categories: ["review"] } }, claims: [], dispatches: [] } }) as GroupDetail
    expect(membersInput(detail, { members: detail.members })).toEqual({
      revision: 4, members: [{ sessionID: ses("lead"), role: "coordinator" }, { sessionID: ses("w1"), role: "worker", allowedTools: ["read"], resourceScopes: ["src/**"] }],
      policy: { concurrency: 1, queueCapacity: 64, budget: 3, delegatedDecisions: { categories: ["review"] } },
    })
    expect(membersInput(detail, { name: "Renamed", members: detail.members })).toMatchObject({ name: "Renamed", revision: 4 })
    expect(membersInput(detail, { name: "Release", members: detail.members })).not.toHaveProperty("name")
    expect(membersInput(detail, { members: detail.members, policy: { concurrency: null, queueCapacity: 5 } }).policy).toEqual({ concurrency: null, queueCapacity: 5 })
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
    expect(centralPolicyNote(undefined)).toBe("Central delegation policy is unavailable, so group narrowing cannot be checked or changed here.")
    expect(centralPolicyNote({ enabled: false, categories: [] })).toBe("Central delegation policy is off: delegated decisions are revoked for every group, whatever a group sets.")
    expect(centralPolicyNote(central)).toBe("Central delegation policy is on. A group can only narrow it; the narrowest setting applies.")
  })

  test("a draft may not widen the central categories or leave a stale expiry", () => {
    expect(delegationDraftIssue(central, { categories: ["question"] }, 1000)).toBeUndefined()
    expect(delegationDraftIssue({ ...central, categories: ["review"] }, { categories: ["question"] }, 1000)).toBe("The central policy does not delegate question decisions, so a group cannot")
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
    expect(normalizeFilter({ scope: "selected", sessionIDs: Array.from({ length: 200 }, (_, index) => ses(`s${index}`)) }).sessionIDs).toHaveLength(maxCoordinatorSelection)
    expect(isDefaultFilter(all)).toBe(true)
    expect(isDefaultFilter({ scope: "all", categories: [] })).toBe(false)
    expect(isDefaultFilter({ scope: "selected", sessionIDs: [] })).toBe(false)
  })

  test("selecting coordinators switches to the selected scope and an empty selection notifies nobody", () => {
    const one = toggleCoordinator(all, ses("a"))
    expect(one).toEqual({ scope: "selected", sessionIDs: [ses("a")] })
    expect(toggleCoordinator(one, ses("b"))).toEqual({ scope: "selected", sessionIDs: [ses("a"), ses("b")] })
    expect(toggleCoordinator(one, ses("a"))).toEqual({ scope: "selected", sessionIDs: [] })
    const full = { scope: "selected" as const, sessionIDs: Array.from({ length: maxCoordinatorSelection }, (_, index) => ses(`s${index}`)) }
    expect(toggleCoordinator(full, ses("extra"))).toBe(full)
    expect(toggleCoordinator({ scope: "coordinators", categories: ["failure"] }, ses("a"))).toEqual({ scope: "selected", sessionIDs: [ses("a")], categories: ["failure"] })
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
    const coordinators = new Set([ses("lead")])
    expect(externalDelivery(all, coordinators, ses("w1"), "question")).toBe(true)
    expect(externalDelivery(all, undefined, undefined, undefined)).toBe(true)
    expect(externalDelivery({ scope: "all", categories: [] }, coordinators, ses("w1"), "question")).toBe(false)
    expect(externalDelivery({ scope: "all", categories: [] }, coordinators, undefined, undefined)).toBe(true)
    expect(externalDelivery({ scope: "all", categories: ["question"] }, coordinators, ses("w1"), "completion")).toBe(false)
    expect(externalDelivery({ scope: "all", categories: ["question"] }, coordinators, ses("w1"), undefined)).toBe(false)
    expect(externalDelivery({ scope: "coordinators" }, coordinators, ses("lead"), "failure")).toBe(true)
    expect(externalDelivery({ scope: "coordinators" }, coordinators, ses("w1"), "failure")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("w1")] }, coordinators, ses("w1"), "review")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("lead")] }, coordinators, ses("lead"), "review")).toBe(true)
    expect(externalDelivery({ scope: "selected", sessionIDs: [ses("w1")] }, coordinators, ses("lead"), "review")).toBe(false)
    expect(externalDelivery({ scope: "selected", sessionIDs: [] }, coordinators, ses("w1"), "review")).toBe(false)
  })

  test("an unreadable coordinator list withholds the coordinators scope instead of reading as all sessions", () => {
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
    expect(filterLabel({ scope: "coordinators" }, names)).toBe("all coordinators")
    expect(filterLabel({ scope: "coordinators" }, undefined)).toBe("all coordinators · list unavailable, withheld until it loads")
    expect(filterLabel({ scope: "selected", sessionIDs: [] }, names)).toBe("no sessions selected · nothing notifies externally")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead"), ses("two"), ses("three")] }, names)).toBe("coordinators: Lead, Two +1")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead"), ses("gone")] }, names)).toBe("coordinators: Lead, unknown session")
    expect(filterLabel({ scope: "selected", sessionIDs: [ses("lead")] }, undefined)).toBe("1 selected coordinator · list unavailable")
  })

  test("the settings summary names the scope and categories without needing the coordinator list", () => {
    expect(filterSummary(all)).toBe("all sessions")
    expect(filterSummary({ scope: "coordinators", categories: ["failure"] })).toBe("all coordinators · failure")
    expect(filterSummary({ scope: "selected", sessionIDs: [ses("a"), ses("b")] })).toBe("2 selected coordinators")
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

describe("detail lines", () => {
  const titles = new Map([[ses("lead"), "Lead"], [ses("w1"), "Worker one"]])
  const title = (id: string) => sessionLabel(id, titles)

  test("an unknown session reads by id and never as a blank", () => {
    expect(title(ses("lead"))).toBe("Lead")
    expect(title(ses("gone"))).toBe("Session ses_gone")
  })

  test("queue reasons read as sentences and an unrecognised reason is bounded", () => {
    expect(queueReasonLabel("capacity")).toBe("waiting for a free worker slot")
    expect(queueReasonLabel("hard-limit")).toBe("at the hard limit")
    expect(queueReasonLabel("dependency")).toBe("waiting for a dependency to finish")
    expect(queueReasonLabel("budget")).toBe("at the budget limit")
    expect(queueReasonLabel("x".repeat(80))).toBe(`reason ${"x".repeat(40)}`)
  })

  test("the queue lists only queued and pending dispatches with their reason or status", () => {
    const detail = readDetail({ data: { ...info, claims: [], dispatches: [
      { id: "cdsp_1", groupID: "cgrp_1", targetSessionID: ses("w1"), coordinatorSessionID: ses("lead"), generation: 2, status: "queued", reason: "capacity", text: "a", time: { created: 1, updated: 2 } },
      { id: "cdsp_2", groupID: "cgrp_1", targetSessionID: ses("w1"), coordinatorSessionID: ses("lead"), generation: 2, status: "pending", text: "b", time: { created: 1, updated: 2 } },
      { id: "cdsp_3", groupID: "cgrp_1", targetSessionID: ses("w1"), coordinatorSessionID: ses("lead"), generation: 2, status: "completed", text: "c", time: { created: 1, updated: 2 } },
    ] } }) as GroupDetail
    expect(queueItems(detail, title)).toEqual([{ id: "cdsp_1", target: "Worker one", reason: "waiting for a free worker slot" }, { id: "cdsp_2", target: "Worker one", reason: "pending" }])
  })

  test("leases show the held session, the holder and the remaining time or expiry", () => {
    const claim = { targetSessionID: ses("w1"), holderSessionID: ses("lead"), generation: 2, status: "active" as const, leaseExpiresAt: 10_000 + 90_000 }
    expect(leaseLine(claim, title, 10_000)).toBe("Worker one · held by Lead · expires in 1m")
    expect(leaseLine({ ...claim, leaseExpiresAt: 9_000 }, title, 10_000)).toBe("Worker one · held by Lead · expired")
  })

  test("receipts read as outcome, worker, optional reason and age", () => {
    const receipt = { id: "crcpt_1", kind: "dispatched" as const, sessionID: ses("w1"), time: 10_000 }
    expect(receiptLine(receipt, title, 10_000 + 5_000)).toBe("dispatched → Worker one · 5s ago")
    expect(receiptLine({ ...receipt, kind: "failed", detail: "Session is busy" }, title, 10_000 + 3_600_000)).toBe("failed → Worker one · Session is busy · 1h ago")
    expect(relativeAge(-5)).toBe("0s ago")
    expect(relativeAge(125_000)).toBe("2m ago")
  })

  test("expiry choices compute an absolute time from now and none leaves the grant open-ended", () => {
    expect(expiryChoices.map((choice) => choice.id)).toEqual(["none", "1h", "8h", "24h", "7d"])
    expect(expiryAt("none", 1_000)).toBeUndefined()
    expect(expiryAt("1h", 1_000)).toBe(1_000 + 3_600_000)
    expect(expiryAt("7d", 0)).toBe(7 * 24 * 3_600_000)
  })
})

describe("per-task selection", () => {
  const model = { providerID: "anthropic", id: "claude-sonnet-5-5", profile: "work", variant: "high" }
  const selection = { agent: "build", model, reason: "Needs deep refactor reasoning across three packages." }
  const receipt = { id: "crcpt_1", groupID: "cgrp_1", dispatchID: "cdsp_1", kind: "dispatched", sessionID: ses("w1"), time: 7 }
  const dispatch = { id: "cdsp_1", groupID: "cgrp_1", targetSessionID: ses("w1"), coordinatorSessionID: ses("lead"), generation: 2, status: "queued", reason: "capacity", text: "Run tests", time: { created: 2, updated: 3 } }

  test("receipts and dispatches carry the reported selection exactly and an absent one stays absent", () => {
    expect(readReceipts({ data: [{ ...receipt, selection }, receipt] })).toEqual([
      { id: "crcpt_1", kind: "dispatched", sessionID: ses("w1"), dispatchID: "cdsp_1", time: 7, selection },
      { id: "crcpt_1", kind: "dispatched", sessionID: ses("w1"), dispatchID: "cdsp_1", time: 7 },
    ])
    const detail = readDetail({ data: { ...info, claims: [], dispatches: [{ ...dispatch, selection }, dispatch] } })
    expect(detail?.dispatches[0]?.selection).toEqual(selection)
    expect(detail?.dispatches[1]).not.toHaveProperty("selection")
  })

  test("a model without a variant or profile keeps them absent rather than defaulting", () => {
    const bare = { agent: "plan", model: { providerID: "openai", id: "gpt-6-sol" }, reason: "Planning only." }
    expect(readReceipts({ data: [{ ...receipt, selection: bare }] })?.[0]?.selection).toEqual(bare)
    expect(readReceipts({ data: [{ ...receipt, selection: bare }] })?.[0]?.selection?.model).not.toHaveProperty("variant")
  })

  test("a malformed selection makes the whole answer unreadable instead of showing a guess", () => {
    for (const bad of [
      { ...selection, reason: "line one\nline two" },
      { ...selection, reason: "carriage\rreturn" },
      { ...selection, reason: "x".repeat(501) },
      { ...selection, reason: "" },
      { ...selection, agent: "" },
      { ...selection, model: { providerID: "anthropic" } },
      { ...selection, model: { ...model, variant: 3 } },
      { agent: "build", reason: "no model" },
      "build",
    ]) {
      expect(readReceipts({ data: [{ ...receipt, selection: bad }] })).toBeUndefined()
      expect(readDetail({ data: { ...info, claims: [], dispatches: [{ ...dispatch, selection: bad }] } })).toBeUndefined()
    }
    expect(readReceipts({ data: [{ ...receipt, selection: { ...selection, reason: "x".repeat(500) } }] })?.[0]?.selection?.reason).toHaveLength(500)
  })

  test("the display states the actual agent, model, profile and variant and says so when the variant is unavailable", () => {
    expect(selectionLines(selection)).toEqual({ choice: "Agent build · anthropic/claude-sonnet-5-5 · profile work · variant high", reason: "Needs deep refactor reasoning across three packages." })
    expect(selectionLines({ agent: "plan", model: { providerID: "openai", id: "gpt-6-sol" }, reason: "Planning only." })).toEqual({ choice: "Agent plan · openai/gpt-6-sol · variant unavailable", reason: "Planning only." })
    expect(selectionLines(undefined)).toEqual({ choice: "Selection not reported" })
  })
})
