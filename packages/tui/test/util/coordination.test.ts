import { expect, test } from "bun:test"
import {
  ageLabel,
  chipsRow,
  collapseLevel,
  concurrencyMeter,
  delegationSummary,
  externalNotificationAllowed,
  liveSummary,
  masterChoices,
  masterSummary,
  memberPosition,
  narrowingError,
  notificationFilterLabel,
  parseConcurrency,
  parseExpiry,
  parseList,
  projectOfSession,
  projectNotification,
  projectStatusLabel,
  roster,
  runningMembers,
  stateGlyph,
  stateWord,
  stripLine,
  toggleCategory,
  toggleMaster,
  updatedLabel,
  type NotificationFilter,
  type ProjectMemberView,
  type ProjectView,
} from "../../src/util/coordination"

const participant = (
  sessionID: string,
  title: string,
  role: ProjectMemberView["role"],
  state: ProjectMemberView["state"] = "idle",
  extra: Partial<ProjectMemberView> = {},
): ProjectMemberView => ({
  sessionID,
  title,
  role,
  state,
  directory: `/repo/${title}`,
  lastActivity: 0,
  pending: 0,
  ...extra,
})

const project = (
  id: string,
  master: ProjectMemberView,
  members: ProjectMemberView[],
  extra: Partial<ProjectView> = {},
): ProjectView => ({
  id,
  name: `Project ${id}`,
  revision: 1,
  active: true,
  concurrency: null,
  created: 0,
  master,
  members,
  ...extra,
})

const lead = participant("lead", "Lead", "master", "running")
const docs = participant("docs", "Docs worker", "member", "idle")
const api = participant("api", "Api worker", "member", "running")
const infra = participant("infra", "Infra worker", "member", "waiting", { pending: 1 })
const design = participant("design", "Design review", "member", "running")
const release = project("release", lead, [docs, api, infra, design], { name: "Release train", concurrency: 2 })

test("project notification metadata validates the target and preserves a bounded excerpt", () => {
  expect(
    projectNotification({
      source: "project_notification",
      memberSessionID: "ses_docs",
      title: "Docs worker",
      event: "completed",
      excerpt: "Drafted notes",
    }),
  ).toEqual({ sessionID: "ses_docs", title: "Docs worker", event: "completed", excerpt: "Drafted notes" })
  expect(
    projectNotification({ source: "other", memberSessionID: "ses_docs", title: "Docs worker", event: "completed" }),
  ).toBeUndefined()
  expect(projectNotification({ source: "project_notification", title: "Missing target" })).toBeUndefined()
})

test("the master is pinned first in the roster and keeps member order", () => {
  expect(roster(release).map((item) => item.sessionID)).toEqual(["lead", "docs", "api", "infra", "design"])
  expect(roster(release)[0]!.role).toBe("master")
})

test("a Session maps to its Project and role, and unrelated Sessions map to nothing", () => {
  const projects = [
    release,
    project("docs", participant("scribe", "Scribe", "master"), [participant("w", "W", "member")]),
  ]
  expect(projectOfSession(projects, "lead")).toEqual({ project: release, role: "master" })
  expect(projectOfSession(projects, "w")?.role).toBe("member")
  expect(projectOfSession(projects, "w")?.project.id).toBe("docs")
  expect(projectOfSession(projects, "stranger")).toBeUndefined()
  expect(projectOfSession(undefined, "lead")).toBeUndefined()
})

test("state glyphs and words follow the registry and always pair a glyph with its word", () => {
  expect([stateGlyph("running", false), stateWord("running")]).toEqual(["●", "running"])
  expect([stateGlyph("idle", false), stateWord("idle")]).toEqual(["○", "idle"])
  expect([stateGlyph("waiting", false), stateWord("waiting")]).toEqual(["?", "waiting"])
  expect([stateGlyph("failed", false), stateWord("failed")]).toEqual(["✗", "failed"])
  expect(stateGlyph("running", true)).toBe("⠋")
})

test("the concurrency meter counts running members except the master", () => {
  expect(runningMembers(release)).toBe(2)
  expect(concurrencyMeter(release)).toBe("██ 2/2 running · at limit")
  expect(concurrencyMeter({ ...release, concurrency: 4 })).toBe("██░░ 2/4 running")
  expect(concurrencyMeter({ ...release, concurrency: null })).toBe("2 running · no limit")
  expect(concurrencyMeter(project("x", lead, [docs]))).toBe("0 running · no limit")
})

test("the live summary lists each non-empty state with its count, master included", () => {
  expect(liveSummary(release, false)).toBe("●3 ?1 ○1")
  expect(liveSummary(release, true)).toBe("⠋3 ?1 ○1")
  expect(liveSummary(project("q", participant("p", "Planner", "master"), []), false)).toBe("○1")
  expect(
    liveSummary(
      project("i", participant("o", "Ops", "master"), [participant("f", "F", "member", "failed"), docs]),
      false,
    ),
  ).toBe("✗1 ○2")
})

test("project status words and the master summary read from active state and roster", () => {
  expect(projectStatusLabel(true)).toBe("● active")
  expect(projectStatusLabel(false)).toBe("○ paused")
  expect(masterSummary(release)).toBe("5 members · 2 running · 1 waiting")
  expect(masterSummary(project("solo", lead, []))).toBe("1 member · 0 running")
})

test("ages read as now, seconds, minutes, hours and the updated stamp", () => {
  expect(ageLabel(0)).toBe("now")
  expect(ageLabel(999)).toBe("now")
  expect(ageLabel(8_000)).toBe("8s ago")
  expect(ageLabel(61_000)).toBe("1m ago")
  expect(ageLabel(7_300_000)).toBe("2h ago")
  expect(ageLabel(-5)).toBe("now")
  expect(updatedLabel(3_000)).toBe("updated 3s ago")
  expect(updatedLabel(undefined)).toBe("")
})

test("the strip names the role, Project, status and counts, and collapses in a fixed order", () => {
  const master = { project: release, role: "master" as const, sessionID: "lead" }
  const wide = stripLine({ ...master, width: 120 })
  expect(wide).toBe(
    "Projects › Release train   ·   Master of Release train   ·   ● active   ·   5 members · 2 running · 1 waiting",
  )
  const narrow = stripLine({ ...master, width: 80 })
  expect(narrow).toBe("Master of Release train · ● active · 2/2 running · ? 1")
  const squeezed = stripLine({ ...master, width: 50 })
  expect(squeezed.length).toBeLessThanOrEqual(50)
  expect(squeezed).toContain("Master of Releas")
  expect(squeezed).toContain("…")
  expect(squeezed).toContain("2/2 running")
  expect(squeezed).toContain("● active")
  const member = stripLine({ project: release, role: "member", sessionID: "docs", width: 120 })
  expect(member).toBe(
    "Projects › Release train   ·   Member of Release train · master: Lead   ·   ↑ Lead   ←→ member 1 of 4   ·   ○ idle",
  )
  expect(stripLine({ project: release, role: "member", sessionID: "docs", width: 80 })).toBe(
    "Member of Release train · master: Lead · ↑ Lead · ○ idle",
  )
})

test("the position of a member counts members only and skips the master", () => {
  expect(memberPosition(release, "docs")).toEqual({ index: 1, total: 4 })
  expect(memberPosition(release, "design")).toEqual({ index: 4, total: 4 })
  expect(memberPosition(release, "lead")).toBeUndefined()
})

test("collapse order drops the updated stamp, then the breadcrumb, then the chips row, and keeps the tray", () => {
  expect(collapseLevel(160)).toEqual({ pane: true, updated: true, breadcrumb: true, chips: false })
  expect(collapseLevel(120)).toEqual({ pane: true, updated: true, breadcrumb: true, chips: false })
  expect(collapseLevel(110)).toEqual({ pane: true, updated: false, breadcrumb: true, chips: false })
  expect(collapseLevel(99)).toEqual({ pane: false, updated: false, breadcrumb: false, chips: true })
  expect(collapseLevel(80)).toEqual({ pane: false, updated: false, breadcrumb: false, chips: true })
  expect(collapseLevel(60)).toEqual({ pane: false, updated: false, breadcrumb: false, chips: false })
})

test("the chips row shows the master first, first words, and an overflow count", () => {
  const row = chipsRow(release, 80)
  expect(row.chips.map((chip) => chip.label)).toEqual(["MASTER Lead", "Docs", "Api", "Infra", "Design"])
  expect(row.chips.map((chip) => chip.state)).toEqual(["running", "idle", "running", "waiting", "running"])
  expect(row.overflow).toBe(0)
  const tight = chipsRow(release, 34)
  expect(tight.chips[0]!.label).toBe("MASTER Lead")
  expect(tight.overflow).toBe(5 - tight.chips.length)
  expect(tight.overflow).toBeGreaterThan(0)
})

test("concurrency accepts a positive whole number, or no limit", () => {
  expect(parseConcurrency("2")).toEqual({ value: 2 })
  expect(parseConcurrency(" 12 ")).toEqual({ value: 12 })
  for (const none of ["", "none", "no limit", "No Limit"]) expect(parseConcurrency(none)).toEqual({ value: null })
  for (const bad of ["0", "-1", "1.5", "two"])
    expect(parseConcurrency(bad)).toEqual({ error: "Concurrency must be a whole number of at least 1, or no limit" })
})

test("master choices list each master once, and external notifications default to every Session and category", () => {
  expect(masterChoices([release, project("two", participant("scribe", "Scribe", "master"), [])])).toEqual([
    { sessionID: "lead", title: "Lead" },
    { sessionID: "scribe", title: "Scribe" },
  ])
  expect(masterChoices(undefined)).toBeUndefined()
  const all: NotificationFilter = { scope: "all" }
  for (const kind of ["question", "permission", "review", "failure", "completion"] as const)
    expect(externalNotificationAllowed(all, undefined, "z", kind)).toBe(true)
})

test("selected and masters scopes match only master Sessions in the current list", () => {
  const projects = [release]
  const selected: NotificationFilter = { scope: "selected", sessionIDs: ["lead", "api"] }
  expect(externalNotificationAllowed(selected, projects, "lead", "permission")).toBe(true)
  expect(externalNotificationAllowed(selected, projects, "api", "permission")).toBe(false)
  expect(externalNotificationAllowed(selected, undefined, "lead", "permission")).toBe(false)
  const masters: NotificationFilter = { scope: "coordinators" }
  expect(externalNotificationAllowed(masters, projects, "lead", "failure")).toBe(true)
  expect(externalNotificationAllowed(masters, projects, "docs", "failure")).toBe(false)
  expect(externalNotificationAllowed(masters, undefined, "lead", "failure")).toBe(false)
  expect(externalNotificationAllowed({ scope: "selected" }, undefined, "z", "failure")).toBe(false)
  expect(externalNotificationAllowed({ scope: "all", categories: [] }, undefined, "z", "failure")).toBe(false)
  const filter: NotificationFilter = { scope: "all", categories: ["failure", "completion"] }
  expect(externalNotificationAllowed(filter, undefined, "a", "failure")).toBe(true)
  expect(externalNotificationAllowed(filter, undefined, "a", "question")).toBe(false)
})

test("toggling masters and categories stays bounded and keeps an explicit empty choice", () => {
  const one = toggleMaster({ scope: "all" }, "a")
  expect(one).toEqual({ scope: "selected", sessionIDs: ["a"] })
  expect(toggleMaster(one, "b")).toEqual({ scope: "selected", sessionIDs: ["a", "b"] })
  expect(toggleMaster(one, "a")).toEqual({ scope: "selected", sessionIDs: [] })
  const full = Array.from({ length: 128 }, (_, index) => `s${index}`)
  expect(toggleMaster({ scope: "selected", sessionIDs: full }, "extra")).toEqual({
    scope: "selected",
    sessionIDs: full,
  })
  expect(toggleMaster({ scope: "all", categories: ["failure"] }, "a")).toEqual({
    scope: "selected",
    sessionIDs: ["a"],
    categories: ["failure"],
  })
  expect(toggleCategory({ scope: "all" }, "failure")).toEqual({
    scope: "all",
    categories: ["question", "permission", "review", "completion"],
  })
  expect(toggleCategory({ scope: "all", categories: ["failure"] }, "failure")).toEqual({ scope: "all", categories: [] })
  expect(
    toggleCategory({ scope: "all", categories: ["question", "permission", "review", "failure"] }, "completion"),
  ).toEqual({ scope: "all" })
})

test("list fields split on commas, drop blanks and enforce the backend bounds", () => {
  expect(parseList("shell:ls, shell:git status ,, x", "actions")).toEqual({
    value: ["shell:ls", "shell:git status", "x"],
  })
  expect(parseList("   ", "actions")).toEqual({ value: undefined })
  expect(parseList("/r", "resources")).toEqual({ value: ["/r"] })
  expect(parseList(Array.from({ length: 33 }, (_, index) => `a${index}`).join(","), "actions")).toEqual({
    error: "At most 32 actions are allowed",
  })
  expect(parseList("s".repeat(513), "resources")).toEqual({ error: "Each resource must be 1 to 512 characters" })
})

test("an expiry is never, or a duration from now in minutes, hours or days", () => {
  expect(parseExpiry("", 1_000)).toEqual({ value: undefined })
  expect(parseExpiry("never", 1_000)).toEqual({ value: undefined })
  expect(parseExpiry("30m", 1_000)).toEqual({ value: 1_000 + 30 * 60_000 })
  expect(parseExpiry("1d", 1_000)).toEqual({ value: 1_000 + 86_400_000 })
  for (const bad of ["0m", "soon", "3w"])
    expect(parseExpiry(bad, 1_000)).toEqual({ error: "Expiry must be never or a duration such as 30m, 2h, or 1d" })
})

test("a Project's delegated decisions may only narrow what the global policy allows", () => {
  const global = {
    enabled: true,
    categories: ["question", "permission"] as const,
    actions: ["shell:ls"],
    resources: ["/repo/**"],
    expiresAt: 10_000,
  }
  expect(narrowingError({ categories: ["permission"] }, global)).toBeUndefined()
  expect(narrowingError({ categories: ["permission", "review"] }, global)).toBe(
    "review is not allowed by the global policy (question, permission)",
  )
  expect(narrowingError({ categories: ["question"], actions: ["shell:rm"] }, global)).toBe(
    "Actions must stay within the global policy: shell:ls",
  )
  expect(narrowingError({ categories: ["question"], resources: ["/etc/**"] }, global)).toBe(
    "Resources must stay within the global policy: /repo/**",
  )
  expect(narrowingError({ categories: ["question"], expiresAt: 11_000 }, global)).toBe(
    "Expiry cannot be later than the global policy allows",
  )
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
  expect(delegationSummary(undefined, undefined)).toBe("global policy unavailable")
})

test("the filter label names the selection honestly, including an unavailable master list", () => {
  const choices = [
    { sessionID: "a", title: "Lead A" },
    { sessionID: "b", title: "Lead B" },
    { sessionID: "c", title: "Lead C" },
  ]
  expect(notificationFilterLabel({ scope: "all" }, choices)).toBe("all Sessions")
  expect(notificationFilterLabel({ scope: "coordinators" }, choices)).toBe("all masters")
  expect(notificationFilterLabel({ scope: "coordinators" }, undefined)).toBe("all masters · list unavailable")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "b", "c"] }, choices)).toBe(
    "masters: Lead A, Lead B +1",
  )
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "zzz"] }, choices)).toBe(
    "masters: Lead A, unknown Session",
  )
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["a", "b"] }, undefined)).toBe(
    "2 selected masters · list unavailable",
  )
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: [] }, choices)).toBe("no masters selected")
  expect(notificationFilterLabel({ scope: "all", categories: [] }, choices)).toBe("all Sessions · no categories")
  expect(notificationFilterLabel({ scope: "selected", sessionIDs: ["b"], categories: ["review"] }, choices)).toBe(
    "masters: Lead B · review",
  )
})
