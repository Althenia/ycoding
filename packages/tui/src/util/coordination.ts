import { Locale } from "./locale"
import { stringWidth } from "./string-width"
import { escapeTerminalText } from "./terminal-text"

export type MemberState = "idle" | "running" | "waiting" | "failed"
export type ProjectRole = "master" | "member"

export const delegatedCategories = ["question", "permission", "review"] as const
export type DelegatedCategory = (typeof delegatedCategories)[number]

export type DelegatedDecisionsView = {
  readonly categories: ReadonlyArray<DelegatedCategory>
  readonly actions?: ReadonlyArray<string>
  readonly resources?: ReadonlyArray<string>
  readonly expiresAt?: number
}

export type GlobalDelegationView = {
  readonly enabled: boolean
  readonly categories: ReadonlyArray<DelegatedCategory>
  readonly actions?: ReadonlyArray<string>
  readonly resources?: ReadonlyArray<string>
  readonly expiresAt?: number
}

export type ProjectMemberView = {
  readonly sessionID: string
  readonly title: string
  readonly role: ProjectRole
  readonly state: MemberState
  readonly directory: string
  readonly lastActivity: number
  readonly pending: number
  readonly drivenBy?: string
  readonly owner?: { readonly sessionID: string; readonly title: string }
}

export type ProjectView = {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly active: boolean
  readonly pausedReason?: "interrupted" | "restart"
  readonly concurrency: number | null
  readonly delegatedDecisions?: DelegatedDecisionsView
  readonly created: number
  readonly master: ProjectMemberView
  readonly members: ReadonlyArray<ProjectMemberView>
}

export type ProjectSessionChoice = {
  readonly sessionID: string
  readonly title: string
  readonly directory: string
  readonly updated: number
  readonly projectName?: string
}

export type NewMaster = { readonly sessionID: string } | { readonly directory: string; readonly title?: string }

export type ProjectService = {
  create(input: { name: string; master: NewMaster }): Promise<string>
  rename(projectID: string, name: string): Promise<void>
  setMaster(projectID: string, sessionID: string): Promise<void>
  setConcurrency(projectID: string, value: number | null): Promise<void>
  setDelegation(projectID: string, value: DelegatedDecisionsView | null): Promise<void>
  addMember(projectID: string, sessionID: string): Promise<void>
  newMember(projectID: string, directory: string, title?: string): Promise<string>
  removeMember(projectID: string, sessionID: string): Promise<void>
  deleteMember(projectID: string, sessionID: string): Promise<void>
  deleteProject(projectID: string): Promise<void>
}

export const externalNotificationKinds = ["question", "permission", "review", "failure", "completion"] as const
export type ExternalNotificationKind = (typeof externalNotificationKinds)[number]

export type NotificationFilter = {
  readonly scope: "all" | "coordinators" | "selected"
  readonly sessionIDs?: ReadonlyArray<string>
  readonly categories?: ReadonlyArray<ExternalNotificationKind>
}

export const maxSelectedMasters = 128

export function projectNotification(metadata: unknown) {
  if (metadata === null || typeof metadata !== "object") return
  if (!("source" in metadata) || metadata.source !== "project_notification") return
  if (
    !("memberSessionID" in metadata) ||
    typeof metadata.memberSessionID !== "string" ||
    !metadata.memberSessionID.startsWith("ses_")
  )
    return
  if (!("title" in metadata) || typeof metadata.title !== "string") return
  if (
    !("event" in metadata) ||
    typeof metadata.event !== "string" ||
    !["completed", "failed", "interrupted", "question", "permission", "review", "escalated"].includes(metadata.event)
  )
    return
  return {
    sessionID: metadata.memberSessionID,
    title: metadata.title.slice(0, 120),
    event: metadata.event,
    excerpt: "excerpt" in metadata && typeof metadata.excerpt === "string" ? metadata.excerpt.slice(0, 500) : "",
    ...escalationDetail(metadata),
  }
}

function escalationDetail(metadata: object): {
  kind?: DelegatedCategory
  escalatedBy?: { sessionID: string; title: string }
} {
  if (!("event" in metadata) || metadata.event !== "escalated") return {}
  const kind =
    "kind" in metadata && typeof metadata.kind === "string"
      ? delegatedCategories.find((category) => category === metadata.kind)
      : undefined
  const by = "escalatedBy" in metadata ? metadata.escalatedBy : undefined
  const escalatedBy =
    by !== null &&
    typeof by === "object" &&
    "sessionID" in by &&
    typeof by.sessionID === "string" &&
    by.sessionID.startsWith("ses_") &&
    "title" in by &&
    typeof by.title === "string"
      ? { sessionID: by.sessionID, title: by.title.slice(0, 120) }
      : undefined
  return { ...(kind === undefined ? {} : { kind }), ...(escalatedBy === undefined ? {} : { escalatedBy }) }
}

export function projectNoticeLabel(notice: NonNullable<ReturnType<typeof projectNotification>>) {
  if (notice.event === "completed") return "finished"
  if (notice.event === "question") return "asks a question"
  if (notice.event !== "escalated") return notice.event
  const via = notice.escalatedBy ? ` via ${escapeTerminalText(notice.escalatedBy.title)}` : ""
  return `escalates a ${notice.kind ?? "pending"} request${via}`
}

export function roster(project: ProjectView): ReadonlyArray<ProjectMemberView> {
  return [project.master, ...project.members]
}

export function projectOfSession(projects: ReadonlyArray<ProjectView> | undefined, sessionID: string) {
  for (const project of projects ?? []) {
    if (project.master.sessionID === sessionID) return { project, role: "master" as const }
    if (project.members.some((member) => member.sessionID === sessionID)) return { project, role: "member" as const }
  }
}

export function projectContextOf(projects: ReadonlyArray<ProjectView> | undefined, sessionID: string) {
  for (const project of projects ?? []) {
    if (project.master.sessionID === sessionID) return { project, role: "master" as const }
    if (project.members.some((member) => member.owner?.sessionID === sessionID))
      return { project, role: "supervisor" as const }
    if (project.members.some((member) => member.sessionID === sessionID)) return { project, role: "member" as const }
  }
}

export type ProjectContext = NonNullable<ReturnType<typeof projectContextOf>>

const glyphs: Record<MemberState, string> = { running: "●", idle: "○", waiting: "?", failed: "✗" }

export function stateGlyph(state: MemberState, animated: boolean) {
  return state === "running" && animated ? "⠋" : glyphs[state]
}

export function runningMembers(project: ProjectView) {
  return project.members.filter((member) => member.state === "running").length
}

export function concurrencyMeter(project: ProjectView) {
  const running = runningMembers(project)
  if (project.concurrency === null) return `${running} ${running === 1 ? "member" : "members"} running · no limit`
  const cells = Math.min(project.concurrency, 8)
  const filled = Math.min(cells, Math.round((running / project.concurrency) * cells))
  const bar = `${"█".repeat(filled)}${"░".repeat(cells - filled)}`
  return `${bar} ${running}/${project.concurrency} members running${running >= project.concurrency ? " · at limit" : ""}`
}

export function liveSummary(project: ProjectView, animated: boolean) {
  const states: MemberState[] = ["running", "waiting", "failed", "idle"]
  return states
    .flatMap((state) => {
      const count = roster(project).filter((member) => member.state === state).length
      return count === 0 ? [] : [`${stateGlyph(state, animated)}${count}`]
    })
    .join(" ")
}

export function projectStatusLabel(active: boolean) {
  return active ? "● active" : "○ paused"
}

export function ageLabel(elapsed: number) {
  if (elapsed < 1_000) return "now"
  return relativeAge(elapsed)
}

export function updatedLabel(elapsed: number | undefined) {
  return elapsed === undefined ? "" : `updated ${relativeAge(elapsed)}`
}

function span(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function relativeAge(elapsed: number) {
  return `${span(Math.max(0, elapsed))} ago`
}

export function relativeFuture(remaining: number) {
  return `in ${span(Math.max(0, remaining))}`
}

const listColumns = { name: 16, status: 9, master: 8, members: 7 }
const narrowNameColumn = 17

function cell(text: string, width: number) {
  const fitted = Locale.truncateWidth(text, width)
  return fitted + " ".repeat(Math.max(0, width - stringWidth(fitted)))
}

export type ProjectListColumns = { readonly status: boolean; readonly master: boolean }

export function projectListColumns(available: number): ProjectListColumns {
  return { status: available >= 53, master: available >= 63 }
}

export function projectListHeader(columns: ProjectListColumns = { status: true, master: true }) {
  return [
    cell("PROJECT", listColumns.name),
    ...(columns.status ? [cell("STATUS", listColumns.status)] : []),
    ...(columns.master ? [cell("MASTER", listColumns.master)] : []),
    cell("MEMBERS", listColumns.members),
    "LIVE",
  ].join(" ")
}

export function projectListLine(
  project: ProjectView,
  animated: boolean,
  columns: ProjectListColumns = { status: true, master: true },
) {
  return [
    cell(project.name, listColumns.name),
    ...(columns.status ? [cell(projectStatusLabel(project.active), listColumns.status)] : []),
    ...(columns.master ? [cell(project.master.title, listColumns.master)] : []),
    cell(String(project.members.length), listColumns.members),
    `${liveSummary(project, animated)} ›`,
  ].join(" ")
}

export function projectNarrowHeader() {
  return `${cell("PROJECT", narrowNameColumn)} MEMBERS`
}

export function projectNarrowLine(project: ProjectView) {
  return `${cell(project.name, narrowNameColumn)} ${project.members.length}`
}

export function filterSessions(sessions: ReadonlyArray<ProjectSessionChoice>, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return sessions.filter((session) => {
    const haystack = `${session.title} ${session.directory}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

const concurrencyRule = "Concurrency must be a whole number of at least 1, or no limit"

export function parseConcurrency(text: string) {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === "" || trimmed === "none" || trimmed === "no limit") return { value: null }
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return { error: concurrencyRule }
  return { value: Number(trimmed) }
}

const listLimits = {
  actions: { singular: "action", plural: "actions", items: 32, length: 512 },
  resources: { singular: "resource", plural: "resources", items: 32, length: 512 },
} as const

export function parseList(text: string, kind: keyof typeof listLimits) {
  const limit = listLimits[kind]
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
  if (items.length === 0) return { value: undefined }
  if (items.length > limit.items) return { error: `At most ${limit.items} ${limit.plural} are allowed` }
  if (items.some((item) => item.length > limit.length))
    return { error: `Each ${limit.singular} must be 1 to ${limit.length} characters` }
  return { value: items }
}

const durations = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

export function parseExpiry(text: string, now: number) {
  const trimmed = text.trim().toLowerCase()
  if (trimmed === "" || trimmed === "never" || trimmed === "none") return { value: undefined }
  const match = /^([1-9]\d*)([mhd])$/.exec(trimmed)
  if (!match) return { error: "Expiry must be never or a duration such as 30m, 2h, or 1d" }
  return { value: now + Number(match[1]) * durations[match[2] as keyof typeof durations] }
}

export function narrowingError(proposed: DelegatedDecisionsView, global: GlobalDelegationView) {
  if (!global.enabled) return "Delegated decisions are disabled by the global policy"
  const widened = proposed.categories.find((category) => !global.categories.includes(category))
  if (widened) return `${widened} is not allowed by the global policy (${global.categories.join(", ")})`
  if (global.actions && proposed.actions?.some((action) => !global.actions!.includes(action)))
    return `Actions must stay within the global policy: ${global.actions.join(", ")}`
  if (global.resources && proposed.resources?.some((resource) => !global.resources!.includes(resource)))
    return `Resources must stay within the global policy: ${global.resources.join(", ")}`
  if (global.expiresAt !== undefined && proposed.expiresAt !== undefined && proposed.expiresAt > global.expiresAt)
    return "Expiry cannot be later than the global policy allows"
}

export function delegationSummary(
  project: DelegatedDecisionsView | undefined,
  global: GlobalDelegationView | undefined,
) {
  if (global === undefined) return "global policy unavailable"
  if (!global.enabled) return "globally disabled"
  if (project === undefined) return `inherit global (${global.categories.join(", ")})`
  if (project.categories.length === 0) return "custom · delegation disabled"
  return `custom narrowing (${project.categories.join(", ")})`
}

export function masterChoices(projects: ReadonlyArray<ProjectView> | undefined) {
  if (projects === undefined) return undefined
  const seen = new Set<string>()
  return projects
    .map((project) => project.master)
    .filter((master) => !seen.has(master.sessionID) && seen.add(master.sessionID))
    .map((master) => ({ sessionID: master.sessionID, title: master.title }))
}

export function externalNotificationAllowed(
  filter: NotificationFilter,
  projects: ReadonlyArray<ProjectView> | undefined,
  sessionID: string,
  kind: ExternalNotificationKind,
) {
  if (filter.categories && !filter.categories.includes(kind)) return false
  if (filter.scope === "all") return true
  if (!masterChoices(projects)?.some((choice) => choice.sessionID === sessionID)) return false
  return filter.scope === "coordinators" || (filter.sessionIDs?.includes(sessionID) ?? false)
}

function withCategories(filter: NotificationFilter) {
  return filter.categories === undefined ? {} : { categories: filter.categories }
}

export function toggleMaster(filter: NotificationFilter, sessionID: string): NotificationFilter {
  const current = filter.scope === "selected" ? (filter.sessionIDs ?? []) : []
  if (!current.includes(sessionID) && current.length >= maxSelectedMasters) return filter
  const next = current.includes(sessionID) ? current.filter((id) => id !== sessionID) : [...current, sessionID]
  return { scope: "selected", sessionIDs: next, ...withCategories(filter) }
}

export function toggleCategory(filter: NotificationFilter, kind: ExternalNotificationKind): NotificationFilter {
  const current = filter.categories ?? externalNotificationKinds
  const next = externalNotificationKinds.filter((item) =>
    item === kind ? !current.includes(item) : current.includes(item),
  )
  const scope =
    filter.scope === "selected" ? { scope: filter.scope, sessionIDs: filter.sessionIDs ?? [] } : { scope: filter.scope }
  if (next.length === externalNotificationKinds.length) return scope
  return { ...scope, categories: next }
}

export function notificationFilterLabel(
  filter: NotificationFilter,
  masters: ReadonlyArray<{ readonly sessionID: string; readonly title: string }> | undefined,
) {
  const categories =
    filter.categories === undefined
      ? ""
      : filter.categories.length === 0
        ? " · no categories"
        : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all Sessions${categories}`
  if (filter.scope === "coordinators")
    return `all masters${masters === undefined ? " · list unavailable" : ""}${categories}`
  const ids = filter.sessionIDs ?? []
  if (ids.length === 0) return `no masters selected${categories}`
  if (masters === undefined)
    return `${ids.length} selected master${ids.length === 1 ? "" : "s"} · list unavailable${categories}`
  const names = ids.map((id) => masters.find((master) => master.sessionID === id)?.title ?? "unknown Session")
  const extra = names.length > 2 ? ` +${names.length - 2}` : ""
  return `masters: ${names.slice(0, 2).join(", ")}${extra}${categories}`
}

export function recentDirectories(sessions: ReadonlyArray<ProjectSessionChoice>) {
  const seen = new Set<string>()
  return [...sessions]
    .sort((a, b) => b.updated - a.updated)
    .map((session) => session.directory)
    .filter((directory) => directory !== "" && !seen.has(directory) && seen.add(directory))
}
