import { expect, test } from "bun:test"
import { stringWidth } from "../../src/util/string-width"
import {
  ageLabel,
  concurrencyMeter,
  delegationSummary,
  externalNotificationAllowed,
  filterSessions,
  liveSummary,
  masterChoices,
  narrowingError,
  notificationFilterLabel,
  parseConcurrency,
  parseExpiry,
  parseList,
  projectListHeader,
  projectListLine,
  projectNarrowHeader,
  projectNarrowLine,
  projectContextOf,
  projectOfSession,
  projectNotification,
  projectStatusLabel,
  roster,
  runningMembers,
  stateGlyph,
  toggleCategory,
  toggleMaster,
  updatedLabel,
  type NotificationFilter,
  type ProjectMemberView,
  type ProjectSessionChoice,
  type ProjectListColumns,
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

test("Project context: the persisted Master, a supervisor only while it owns a recorded member, members otherwise", () => {
  const owned = project("owned", lead, [
    participant("docs", "Docs worker", "member", "idle", { owner: { sessionID: "supervisor", title: "Docs supervisor" } }),
    api,
  ])
  expect(projectContextOf([owned], "lead")).toEqual({ project: owned, role: "master" })
  expect(projectContextOf([owned], "supervisor")).toEqual({ project: owned, role: "supervisor" })
  expect(projectContextOf([owned], "docs")).toEqual({ project: owned, role: "member" })
  expect(projectContextOf([owned], "api")).toEqual({ project: owned, role: "member" })
  expect(projectContextOf([release], "supervisor")).toBeUndefined()
  expect(projectContextOf([owned], "stranger")).toBeUndefined()
  expect(projectContextOf(undefined, "lead")).toBeUndefined()
  expect(projectOfSession([owned], "supervisor")).toBeUndefined()
})

test("state glyphs follow the registry", () => {
  expect(stateGlyph("running", false)).toBe("●")
  expect(stateGlyph("idle", false)).toBe("○")
  expect(stateGlyph("waiting", false)).toBe("?")
  expect(stateGlyph("failed", false)).toBe("✗")
  expect(stateGlyph("running", true)).toBe("⠋")
})

test("the concurrency meter counts running members except the master and says so", () => {
  expect(runningMembers(release)).toBe(2)
  expect(concurrencyMeter(release)).toBe("██ 2/2 members running · at limit")
  expect(concurrencyMeter({ ...release, concurrency: 4 })).toBe("██░░ 2/4 members running")
  expect(concurrencyMeter({ ...release, concurrency: null })).toBe("2 members running · no limit")
  expect(concurrencyMeter(project("x", lead, [docs]))).toBe("0 members running · no limit")
  expect(concurrencyMeter(project("y", lead, [api]))).toBe("1 member running · no limit")
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

test("project status words read from active state", () => {
  expect(projectStatusLabel(true)).toBe("● active")
  expect(projectStatusLabel(false)).toBe("○ paused")
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

const columnOf = (text: string, needle: string) => stringWidth(text.slice(0, text.indexOf(needle)))

const listText = (value: ProjectView, columns?: ProjectListColumns) =>
  projectListLine(value, false, columns)
    .map((segment) => segment.text)
    .join("")

test("list row segments carry the state or status each colored cell reports", () => {
  const segments = projectListLine(release, false)
  expect(segments.filter((segment) => segment.kind === "status")).toEqual([
    { kind: "status", text: expect.stringContaining("● active"), active: true },
  ])
  expect(segments.flatMap((segment) => (segment.kind === "state" ? [[segment.state, segment.text.trim()]] : []))).toEqual([
    ["running", "●3"],
    ["waiting", "?1"],
    ["idle", "○1"],
  ])
  expect(segments.at(-1)).toEqual({ kind: "marker", text: " ›" })
  expect(listText(release, { status: false, master: false })).not.toContain("● active")
})

test("the list header and every row start each column at one offset", () => {
  const header = projectListHeader()
  const line = listText(release)
  expect(columnOf(header, "STATUS")).toBe(columnOf(line, "● active"))
  expect(columnOf(header, "MASTER")).toBe(columnOf(line, "Lead"))
  expect(columnOf(header, "MEMBERS")).toBe(columnOf(line, "4 "))
  expect(columnOf(header, "LIVE")).toBe(columnOf(line, "●3"))
  const wide = project("w", lead, [docs], { name: "项目发布计划名称很长很长很长很长很长" })
  const wideLine = listText(wide)
  expect(columnOf(header, "STATUS")).toBe(columnOf(wideLine, "● active"))
  expect(columnOf(header, "LIVE")).toBe(columnOf(wideLine, "●1"))
})

test("the narrow list keeps the member count under its header and inside the pane", () => {
  const header = projectNarrowHeader()
  const line = projectNarrowLine(release)
  expect(columnOf(header, "MEMBERS")).toBe(columnOf(line, "4"))
  expect(header).not.toContain("…")
  expect(stringWidth(header)).toBeLessThanOrEqual(26)
  expect(stringWidth(line)).toBeLessThanOrEqual(26)
})

test("Session search matches every word against the title and the directory", () => {
  const sessions: ProjectSessionChoice[] = [
    { sessionID: "a", title: "Refactor auth", directory: "/home/dev/Workspace/ycoding", updated: 3 },
    { sessionID: "b", title: "Refactor auth", directory: "/home/dev/Workspace/other", updated: 2 },
    { sessionID: "c", title: "Docs", directory: "/home/dev/Workspace/ycoding", updated: 1 },
  ]
  const ids = (query: string) => filterSessions(sessions, query).map((session) => session.sessionID)
  expect(ids("")).toEqual(["a", "b", "c"])
  expect(ids("  ")).toEqual(["a", "b", "c"])
  expect(ids("YCODING")).toEqual(["a", "c"])
  expect(ids("refactor ycoding")).toEqual(["a"])
  expect(ids("auth other")).toEqual(["b"])
  expect(ids("missing")).toEqual([])
})

test("an escalated notification keeps its request kind, excerpt and escalating Session", () => {
  const base = {
    source: "project_notification",
    memberSessionID: "ses_infra",
    title: "Infra worker",
    event: "escalated",
    requestID: "perm_one",
    kind: "permission",
    excerpt: "Needs approval to install the toolchain.",
    escalatedBy: { sessionID: "ses_owner", title: "Infra owner" },
  }
  expect(projectNotification(base)).toEqual({
    sessionID: "ses_infra",
    title: "Infra worker",
    event: "escalated",
    excerpt: "Needs approval to install the toolchain.",
    kind: "permission",
    escalatedBy: { sessionID: "ses_owner", title: "Infra owner" },
  })
  expect(projectNotification({ ...base, kind: "shell", escalatedBy: { sessionID: "owner", title: "x" } })).toEqual({
    sessionID: "ses_infra",
    title: "Infra worker",
    event: "escalated",
    excerpt: "Needs approval to install the toolchain.",
  })
  expect(projectNotification({ ...base, excerpt: "x".repeat(900), escalatedBy: { sessionID: "ses_o", title: "t".repeat(300) } })).toMatchObject({
    excerpt: "x".repeat(500),
    escalatedBy: { sessionID: "ses_o", title: "t".repeat(120) },
  })
})
