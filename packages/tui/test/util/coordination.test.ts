import { expect, test } from "bun:test"
import {
  assignRole,
  capacitySummary,
  coordinatorChoices,
  effectiveLimit,
  externalNotificationAllowed,
  formatBudget,
  leaseLine,
  lifecycleActions,
  notificationFilterLabel,
  delegationSummary,
  narrowingError,
  parseBudget,
  parseConcurrency,
  parseExpiry,
  parseList,
  parseQueueCapacity,
  queueReasonLabel,
  receiptLine,
  relativeAge,
  selectionLine,
  removeMember,
  rosterError,
  statusLabel,
  toggleCategory,
  toggleCoordinator,
  type CoordinationGroupView,
  type CoordinationMemberView,
  type NotificationFilter,
} from "../../src/util/coordination"

const member = (sessionID: string, role: CoordinationMemberView["role"]): CoordinationMemberView => ({
  sessionID,
  title: `Title ${sessionID}`,
  role,
})

const group = (id: string, roster: CoordinationMemberView[]): CoordinationGroupView => ({
  id,
  name: `Group ${id}`,
  status: "armed",
  revision: 1,
  roster,
  capacity: { active: 0, hardLimit: 5 },
  policy: { concurrency: null, queueCapacity: 50 },
  queue: [],
  leases: [],
  receipts: [],
})

test("an unreported runtime bound never displays zero or claims unlimited execution", () => {
  const policy = { concurrency: null, queueCapacity: 50 }
  expect(capacitySummary({ active: 2, hardLimit: null }, policy)).toBe("2 workers · uncapped policy · hard limit unreported")
  expect(effectiveLimit({ active: 2, hardLimit: null }, policy)).toBeNull()
})

test("capacity keeps the hard limit in force for every policy", () => {
  expect(capacitySummary({ active: 2, hardLimit: 5 }, { concurrency: 3, queueCapacity: 50 })).toBe("2/3 workers · hard limit 5")
  expect(capacitySummary({ active: 2, hardLimit: 5 }, { concurrency: null, queueCapacity: 50 })).toBe(
    "2/5 workers · uncapped policy · hard limit 5",
  )
  expect(capacitySummary({ active: 2, hardLimit: 5 }, { concurrency: 9, queueCapacity: 50 })).toBe(
    "2/5 workers · hard limit 5 · policy 9 capped",
  )
  expect(effectiveLimit({ active: 0, hardLimit: 5 }, { concurrency: null, queueCapacity: 1 })).toBe(5)
  expect(effectiveLimit({ active: 0, hardLimit: 5 }, { concurrency: 9, queueCapacity: 1 })).toBe(5)
  expect(effectiveLimit({ active: 0, hardLimit: 5 }, { concurrency: 2, queueCapacity: 1 })).toBe(2)
})

test("every reported lifecycle status keeps its own word and stop never claims to cancel workers", () => {
  expect(statusLabel("disarmed")).toBe("disarmed")
  expect(statusLabel("armed")).toBe("armed")
  expect(statusLabel("waiting")).toBe("waiting")
  expect(statusLabel("stopped")).toBe("stopped · workers keep running")
  expect(statusLabel("completed")).toBe("completed")
  expect(statusLabel("needs-rearm")).toBe("needs re-arm")
  const arm = { id: "arm", title: "Arm group" } as const
  const stop = { id: "stop", title: "Stop dispatch · workers keep running" } as const
  const rearm = { id: "rearm", title: "Re-arm group" } as const
  const complete = { id: "complete", title: "Complete project" } as const
  expect(lifecycleActions("disarmed")).toEqual([arm])
  expect(lifecycleActions("armed")).toEqual([stop, complete])
  expect(lifecycleActions("waiting")).toEqual([stop, complete])
  expect(lifecycleActions("stopped")).toEqual([rearm, complete])
  expect(lifecycleActions("needs-rearm")).toEqual([rearm, complete])
  expect(lifecycleActions("completed")).toEqual([])
})

test("policy fields validate to the backend bounds", () => {
  expect(parseConcurrency("3")).toEqual({ value: 3 })
  expect(parseConcurrency(" 12 ")).toEqual({ value: 12 })
  expect(parseConcurrency("uncapped")).toEqual({ value: null })
  expect(parseConcurrency(" Uncapped ")).toEqual({ value: null })
  for (const bad of ["", "0", "-1", "1.5", "abc", "1e3"])
    expect(parseConcurrency(bad)).toEqual({ error: "Concurrency must be a whole number of at least 1, or uncapped" })
  expect(parseQueueCapacity("1")).toEqual({ value: 1 })
  expect(parseQueueCapacity("1000")).toEqual({ value: 1000 })
  for (const bad of ["", "0", "1001", "2.5", "x"])
    expect(parseQueueCapacity(bad)).toEqual({ error: "Queue capacity must be a whole number from 1 to 1000" })
  expect(parseBudget("")).toEqual({ value: undefined })
  expect(parseBudget("none")).toEqual({ value: undefined })
  expect(parseBudget("12.5")).toEqual({ value: 12.5 })
  expect(parseBudget("$3")).toEqual({ value: 3 })
  for (const bad of ["0", "-2", "abc", "1.234"])
    expect(parseBudget(bad)).toEqual({ error: "Budget must be a positive USD amount with up to two decimals, or none" })
  expect(formatBudget(12.5)).toBe("$12.50")
})

test("queue reasons, leases and receipts read as sentences with a bounded unknown fallback", () => {
  expect(queueReasonLabel("capacity")).toBe("waiting for a free worker slot")
  expect(queueReasonLabel("hard-limit")).toBe("at the hard limit")
  expect(queueReasonLabel("dependency")).toBe("waiting for a dependency to finish")
  expect(queueReasonLabel("budget")).toBe("at the budget limit")
  expect(queueReasonLabel("x".repeat(80))).toBe(`reason ${"x".repeat(40)}`)
  expect(relativeAge(5_000)).toBe("5s ago")
  expect(relativeAge(125_000)).toBe("2m ago")
  expect(relativeAge(7_300_000)).toBe("2h ago")
  expect(leaseLine({ id: "l1", holder: "Worker A", resource: "src/a.ts", expiresAt: 130_000 }, 100_000)).toBe(
    "src/a.ts · held by Worker A · expires in 30s",
  )
  expect(leaseLine({ id: "l1", holder: "Worker A", resource: "src/a.ts", expiresAt: 90_000 }, 100_000)).toBe(
    "src/a.ts · held by Worker A · expired",
  )
  expect(leaseLine({ id: "l2", holder: "Worker B", resource: "src/b.ts" }, 100_000)).toBe("src/b.ts · held by Worker B")
  expect(receiptLine({ id: "r1", worker: "Worker A", outcome: "dispatched", time: 0 })).toBe("dispatched → Worker A")
  expect(receiptLine({ id: "r2", worker: "Worker B", outcome: "queued", reason: "capacity", time: 0 })).toBe(
    "queued → Worker B · waiting for a free worker slot",
  )
  expect(receiptLine({ id: "r3", worker: "Worker C", outcome: "rejected", reason: "hard-limit", time: 0 })).toBe(
    "rejected → Worker C · at the hard limit",
  )
})

test("a roster has exactly one coordinator and unique sessions", () => {
  expect(rosterError([member("a", "coordinator"), member("b", "worker"), member("c", "observer")])).toBeUndefined()
  expect(rosterError([member("b", "worker")])).toBe("A group needs exactly one coordinator")
  expect(rosterError([member("a", "coordinator"), member("b", "coordinator")])).toBe("A group needs exactly one coordinator")
  expect(rosterError([member("a", "coordinator"), member("a", "worker")])).toBe("A session can appear once in a roster")
})

test("assigning the coordinator role demotes the previous coordinator and adds new members", () => {
  const roster = [member("a", "coordinator"), member("b", "worker")]
  expect(assignRole(roster, { sessionID: "b", title: "Title b" }, "coordinator")).toEqual([
    member("a", "worker"),
    member("b", "coordinator"),
  ])
  expect(assignRole(roster, { sessionID: "c", title: "Title c" }, "observer")).toEqual([...roster, member("c", "observer")])
  expect(assignRole(roster, { sessionID: "b", title: "Title b" }, "observer")).toEqual([
    member("a", "coordinator"),
    member("b", "observer"),
  ])
  expect(roster).toEqual([member("a", "coordinator"), member("b", "worker")])
})

test("removing a member keeps a coordinator and reports the rule it would break", () => {
  const roster = [member("a", "coordinator"), member("b", "worker")]
  expect(removeMember(roster, "b")).toEqual({ roster: [member("a", "coordinator")] })
  expect(removeMember(roster, "a")).toEqual({ error: "A group needs exactly one coordinator" })
})

test("coordinator choices list each coordinator session once and never a worker", () => {
  const groups = [
    group("g1", [member("a", "coordinator"), member("b", "worker")]),
    group("g2", [member("a", "coordinator"), member("c", "coordinator"), member("d", "observer")]),
  ]
  expect(coordinatorChoices(groups)).toEqual([
    { sessionID: "a", title: "Title a" },
    { sessionID: "c", title: "Title c" },
  ])
  expect(coordinatorChoices(undefined)).toBeUndefined()
})

test("external notifications default to every Session and category", () => {
  const all: NotificationFilter = { scope: "all" }
  for (const kind of ["question", "permission", "review", "failure", "completion"] as const)
    expect(externalNotificationAllowed(all, undefined, "z", kind)).toBe(true)
})

test("a selected scope matches only the chosen coordinator Session IDs", () => {
  const filter: NotificationFilter = { scope: "selected", sessionIDs: ["lead"] }
  const groups = [group("g1", [member("lead", "coordinator"), member("worker", "worker")])]
  expect(externalNotificationAllowed(filter, groups, "lead", "permission")).toBe(true)
  expect(externalNotificationAllowed(filter, undefined, "lead", "permission")).toBe(false)
  expect(externalNotificationAllowed({ scope: "selected", sessionIDs: ["worker"] }, groups, "worker", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, undefined, "worker", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, undefined, "other", "failure")).toBe(false)
})

test("the coordinators scope matches coordinator roots only and never falls back to group members", () => {
  const groups = [
    group("g1", [member("a", "coordinator"), member("b", "worker")]),
    group("g2", [member("c", "coordinator"), member("d", "observer")]),
  ]
  const filter: NotificationFilter = { scope: "coordinators" }
  expect(externalNotificationAllowed(filter, groups, "a", "permission")).toBe(true)
  expect(externalNotificationAllowed(filter, groups, "c", "failure")).toBe(true)
  expect(externalNotificationAllowed(filter, groups, "b", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, groups, "d", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, groups, "z", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, undefined, "a", "permission")).toBe(false)
})

test("a selected scope without identifiers and an empty category list deliver nothing", () => {
  expect(externalNotificationAllowed({ scope: "selected" }, undefined, "z", "failure")).toBe(false)
  expect(externalNotificationAllowed({ scope: "selected", sessionIDs: [] }, undefined, "z", "failure")).toBe(false)
  expect(externalNotificationAllowed({ scope: "all", categories: [] }, undefined, "z", "failure")).toBe(false)
})

test("a category list restricts the event kinds at delivery and omits nothing when absent", () => {
  const filter: NotificationFilter = { scope: "all", categories: ["failure", "completion"] }
  expect(externalNotificationAllowed(filter, undefined, "a", "failure")).toBe(true)
  expect(externalNotificationAllowed(filter, undefined, "a", "completion")).toBe(true)
  expect(externalNotificationAllowed(filter, undefined, "a", "question")).toBe(false)
  expect(externalNotificationAllowed(filter, undefined, "a", "permission")).toBe(false)
  expect(externalNotificationAllowed(filter, undefined, "a", "review")).toBe(false)
  const both: NotificationFilter = { scope: "selected", sessionIDs: ["lead"], categories: ["review"] }
  const groups = [group("g1", [member("lead", "coordinator")])]
  expect(externalNotificationAllowed(both, groups, "lead", "review")).toBe(true)
  expect(externalNotificationAllowed(both, undefined, "lead", "failure")).toBe(false)
  expect(externalNotificationAllowed(both, undefined, "other", "review")).toBe(false)
})

test("toggling coordinators and categories stays bounded and keeps an explicit empty choice", () => {
  const start: NotificationFilter = { scope: "all" }
  const one = toggleCoordinator(start, "a")
  expect(one).toEqual({ scope: "selected", sessionIDs: ["a"] })
  expect(toggleCoordinator(one, "b")).toEqual({ scope: "selected", sessionIDs: ["a", "b"] })
  expect(toggleCoordinator(toggleCoordinator(one, "b"), "a")).toEqual({ scope: "selected", sessionIDs: ["b"] })
  expect(toggleCoordinator(one, "a")).toEqual({ scope: "selected", sessionIDs: [] })
  const full = Array.from({ length: 128 }, (_, index) => `s${index}`)
  expect(toggleCoordinator({ scope: "selected", sessionIDs: full }, "extra")).toEqual({ scope: "selected", sessionIDs: full })
  expect(toggleCoordinator({ scope: "all", categories: ["failure"] }, "a")).toEqual({
    scope: "selected",
    sessionIDs: ["a"],
    categories: ["failure"],
  })
  expect(toggleCategory({ scope: "all" }, "failure")).toEqual({ scope: "all", categories: ["question", "permission", "review", "completion"] })
  expect(toggleCategory({ scope: "all", categories: ["failure"] }, "failure")).toEqual({ scope: "all", categories: [] })
  expect(toggleCategory({ scope: "all", categories: ["failure"] }, "completion")).toEqual({
    scope: "all",
    categories: ["failure", "completion"],
  })
  expect(toggleCategory({ scope: "all", categories: ["question", "permission", "review", "failure"] }, "completion")).toEqual({ scope: "all" })
})

test("list fields split on commas, drop blanks and enforce the backend bounds", () => {
  expect(parseList("read, grep ,, edit", "tools")).toEqual({ value: ["read", "grep", "edit"] })
  expect(parseList("   ", "tools")).toEqual({ value: undefined })
  expect(parseList("x".repeat(129), "tools")).toEqual({ error: "Each tool name must be 1 to 128 characters" })
  expect(parseList(Array.from({ length: 65 }, (_, index) => `t${index}`).join(","), "tools")).toEqual({
    error: "At most 64 tools are allowed",
  })
  expect(parseList("/repo/**", "scopes")).toEqual({ value: ["/repo/**"] })
  expect(parseList("s".repeat(513), "scopes")).toEqual({ error: "Each scope must be 1 to 512 characters" })
  expect(parseList(Array.from({ length: 33 }, (_, index) => `/r${index}`).join(","), "scopes")).toEqual({
    error: "At most 32 scopes are allowed",
  })
  expect(parseList("shell:ls", "actions")).toEqual({ value: ["shell:ls"] })
  expect(parseList(Array.from({ length: 33 }, (_, index) => `a${index}`).join(","), "actions")).toEqual({
    error: "At most 32 actions are allowed",
  })
})

test("an expiry is never, or a duration from now in minutes, hours or days", () => {
  expect(parseExpiry("", 1_000)).toEqual({ value: undefined })
  expect(parseExpiry("never", 1_000)).toEqual({ value: undefined })
  expect(parseExpiry("none", 1_000)).toEqual({ value: undefined })
  expect(parseExpiry("30m", 1_000)).toEqual({ value: 1_000 + 30 * 60_000 })
  expect(parseExpiry("2h", 1_000)).toEqual({ value: 1_000 + 2 * 3_600_000 })
  expect(parseExpiry("1d", 1_000)).toEqual({ value: 1_000 + 86_400_000 })
  for (const bad of ["0m", "-1h", "soon", "3w", "1.5h"])
    expect(parseExpiry(bad, 1_000)).toEqual({ error: "Expiry must be never or a duration such as 30m, 2h, or 1d" })
})

test("a project's delegated decisions may only narrow what the global policy allows", () => {
  const global = { enabled: true, categories: ["question", "permission"] as const, actions: ["shell:ls", "shell:git status"], resources: ["/repo/**"], expiresAt: 10_000 }
  expect(narrowingError({ categories: ["permission"] }, global)).toBeUndefined()
  expect(narrowingError({ categories: [] }, global)).toBeUndefined()
  expect(narrowingError({ categories: ["permission", "review"] }, global)).toBe(
    "review is not allowed by the global policy (question, permission)",
  )
  expect(narrowingError({ categories: ["question"], actions: ["shell:ls"] }, global)).toBeUndefined()
  expect(narrowingError({ categories: ["question"], actions: ["shell:rm"] }, global)).toBe(
    "Actions must stay within the global policy: shell:ls, shell:git status",
  )
  expect(narrowingError({ categories: ["question"], resources: ["/etc/**"] }, global)).toBe(
    "Resources must stay within the global policy: /repo/**",
  )
  expect(narrowingError({ categories: ["question"], expiresAt: 9_000 }, global)).toBeUndefined()
  expect(narrowingError({ categories: ["question"], expiresAt: 11_000 }, global)).toBe(
    "Expiry cannot be later than the global policy allows",
  )
  expect(narrowingError({ categories: ["question"], actions: ["anything"] }, { enabled: true, categories: ["question"] })).toBeUndefined()
  expect(narrowingError({ categories: ["question"] }, { enabled: false, categories: [] })).toBe(
    "Delegated decisions are disabled by the global policy",
  )
})

test("the delegation summary names the global state, inheritance, narrowing and disabling", () => {
  const global = { enabled: true, categories: ["question", "permission", "review"] as const }
  expect(delegationSummary(undefined, global)).toBe("inherit global (question, permission, review)")
  expect(delegationSummary({ categories: ["permission"] }, global)).toBe("custom narrowing (permission)")
  expect(delegationSummary({ categories: [] }, global)).toBe("custom · delegation disabled")
  expect(delegationSummary(undefined, { enabled: false, categories: [] })).toBe("globally disabled")
  expect(delegationSummary({ categories: ["permission"] }, { enabled: false, categories: [] })).toBe("globally disabled")
  expect(delegationSummary(undefined, undefined)).toBe("global policy unavailable")
})

test("the filter label names the selection honestly, including an unavailable coordinator source", () => {
  const choices = [
    { sessionID: "a", title: "Lead A" },
    { sessionID: "b", title: "Lead B" },
    { sessionID: "c", title: "Lead C" },
  ]
  expect(notificationFilterLabel({ scope: "all" }, choices)).toBe("all sessions")
  expect(notificationFilterLabel({ scope: "all" }, undefined)).toBe("all sessions")
  expect(notificationFilterLabel({ scope: "coordinators" }, choices)).toBe("all coordinators")
  expect(notificationFilterLabel({ scope: "coordinators" }, undefined)).toBe("all coordinators · list unavailable")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a"] }, choices)).toBe("coordinators: Lead A")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "b", "c"] }, choices)).toBe("coordinators: Lead A, Lead B +1")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "zzz"] }, choices)).toBe("coordinators: Lead A, unknown session")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "b"] }, undefined)).toBe(
    "2 selected coordinators · list unavailable",
  )
  expect(notificationFilterLabel({ scope: "all", categories: ["failure", "completion"] }, choices)).toBe(
    "all sessions · failure, completion",
  )
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: [] }, choices)).toBe("no coordinators selected")
  expect(notificationFilterLabel({ scope: "all", categories: [] }, choices)).toBe("all sessions · no categories")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["b"], categories: ["review"] }, choices)).toBe(
    "coordinators: Lead B · review",
  )
})

test("a dispatch selection reads as the chosen agent, model, honest variant and a single-line reason", () => {
  expect(
    selectionLine({ agent: "omoikane", model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" }, reason: "Needs deep reasoning" }),
  ).toBe("agent omoikane · anthropic/claude-sonnet-5-5 · variant high · Needs deep reasoning")
  expect(
    selectionLine({ agent: "build", model: { providerID: "openai", id: "gpt-6", profile: "work" }, reason: "Quick   lease\ncheck\t today " }),
  ).toBe("agent build · openai/gpt-6 (work) · variant unavailable · Quick lease check today")
  expect(selectionLine({ agent: "build", model: { providerID: "openai", id: "gpt-6" }, reason: "" })).toBe(
    "agent build · openai/gpt-6 · variant unavailable",
  )
})
