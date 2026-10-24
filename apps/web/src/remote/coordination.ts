import type { RemoteAlertDetail, RemoteNoticeCategory } from "@ycoding-ai/remote"
import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"

export const delegatedCategories = ["question", "permission", "review"] as const
export type DelegatedCategory = (typeof delegatedCategories)[number]
export const externalKinds = ["question", "permission", "review", "failure", "completion"] as const
export type ExternalKind = (typeof externalKinds)[number]
export const memberStates = ["idle", "running", "waiting", "failed"] as const
export type MemberState = (typeof memberStates)[number]

export const maxMembers = 64
export const maxMasterSelection = 128
export const sparkBuckets = 12
export const sparkBucketMs = 300_000
const maxMeterCells = 12

export type DelegationView = {
  readonly categories: readonly DelegatedCategory[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly expiresAt?: number
}
export type SettingsView = {
  readonly concurrency: number | null
  readonly delegatedDecisions?: DelegationView
}
export type PendingView = { readonly kind: DelegatedCategory; readonly requestID: string; readonly summary: string }
export type ParticipantView = {
  readonly sessionID: string
  readonly title: string
  readonly directory: string
  readonly state: MemberState
  readonly lastActivity: number
  readonly pending: readonly PendingView[]
  readonly drivenBy?: { readonly sessionID: string; readonly title: string }
}
export type ProjectSummary = {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly active: boolean
  readonly pausedReason?: "interrupted" | "restart"
  readonly masterSessionID: string
  readonly memberCount: number
  readonly settings: SettingsView
  readonly created: number
  readonly updated: number
}
export type ProjectDetail = {
  readonly id: string
  readonly name: string
  readonly revision: number
  readonly active: boolean
  readonly pausedReason?: "interrupted" | "restart"
  readonly master: ParticipantView
  readonly members: readonly ParticipantView[]
  readonly settings: SettingsView
  readonly created: number
  readonly updated: number
}
export type ProjectBundle = { readonly summary: ProjectSummary; readonly detail: ProjectDetail }
export type CentralPolicy = {
  readonly enabled: boolean
  readonly categories: readonly DelegatedCategory[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly expiresAt?: number
}
export type SessionCandidate = { readonly id: string; readonly title: string; readonly directory: string; readonly active: number }

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const prefixed = (prefix: string) => (value: unknown): value is string => typeof value === "string" && value.startsWith(prefix) && value.length > prefix.length && value.length <= 96
const groupID = prefixed("cgrp_")
const sessionID = prefixed("ses_")
const member = <Value extends string>(values: readonly Value[], value: unknown): value is Value => typeof value === "string" && (values as readonly string[]).includes(value)
const strings = (value: unknown, limit: number, length: number): readonly string[] | undefined =>
  Array.isArray(value) && value.length <= limit && value.every((item) => text(item, length)) ? value as readonly string[] : undefined
const payload = (value: unknown) => record(value) ? value.data : undefined

function readDelegation(value: unknown): DelegationView | undefined {
  if (!record(value) || !Array.isArray(value.categories) || value.categories.length > 3 || !value.categories.every((item) => member(delegatedCategories, item))) return undefined
  const actions = value.actions === undefined ? undefined : strings(value.actions, 32, 512)
  const resources = value.resources === undefined ? undefined : strings(value.resources, 32, 512)
  if ((value.actions !== undefined && actions === undefined) || (value.resources !== undefined && resources === undefined)) return undefined
  if (value.expiresAt !== undefined && !count(value.expiresAt)) return undefined
  return { categories: value.categories as readonly DelegatedCategory[], ...(actions === undefined ? {} : { actions }), ...(resources === undefined ? {} : { resources }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number }) }
}

function readSettings(value: unknown): SettingsView | undefined {
  if (!record(value)) return undefined
  const concurrency = value.concurrency
  if (concurrency !== null && !(count(concurrency) && concurrency >= 1)) return undefined
  const delegated = value.delegatedDecisions === undefined ? undefined : readDelegation(value.delegatedDecisions)
  if (value.delegatedDecisions !== undefined && delegated === undefined) return undefined
  return { concurrency, ...(delegated === undefined ? {} : { delegatedDecisions: delegated }) }
}

function readPending(value: unknown): PendingView | undefined {
  if (!record(value) || !member(delegatedCategories, value.kind) || !text(value.requestID, 256) || typeof value.summary !== "string" || value.summary.length > 500) return undefined
  return { kind: value.kind, requestID: value.requestID, summary: value.summary }
}

function readParticipant(value: unknown): ParticipantView | undefined {
  if (!record(value) || !sessionID(value.sessionID) || typeof value.title !== "string" || !member(memberStates, value.state) || !count(value.lastActivity) || !Array.isArray(value.pending) || value.pending.length > 50) return undefined
  const pending = value.pending.map(readPending)
  if (!pending.every((item) => item !== undefined)) return undefined
  const directory = record(value.location) && typeof value.location.directory === "string" ? value.location.directory : ""
  if (value.drivenBy !== undefined && (!record(value.drivenBy) || !sessionID(value.drivenBy.sessionID) || !text(value.drivenBy.title, 256))) return undefined
  return { sessionID: value.sessionID, title: value.title, directory, state: value.state, lastActivity: value.lastActivity, pending,
    ...(value.drivenBy === undefined ? {} : { drivenBy: value.drivenBy as { sessionID: string; title: string } }) }
}

function readTime(value: unknown) {
  return record(value) && count(value.created) && count(value.updated) ? { created: value.created, updated: value.updated } : undefined
}

function readSummary(value: unknown): ProjectSummary | undefined {
  if (!record(value) || !groupID(value.id) || typeof value.name !== "string" || typeof value.active !== "boolean" || !count(value.revision) || !sessionID(value.masterSessionID) || !count(value.memberCount)) return undefined
  const settings = readSettings(value.settings)
  const time = readTime(value.time)
  if (settings === undefined || time === undefined) return undefined
  return { id: value.id, name: value.name, revision: value.revision, active: value.active, masterSessionID: value.masterSessionID, memberCount: value.memberCount, settings, ...time, ...(value.pausedReason === "interrupted" || value.pausedReason === "restart" ? { pausedReason: value.pausedReason } : {}) }
}

export function readProjects(value: unknown): readonly ProjectSummary[] | undefined {
  const data = payload(value)
  if (!Array.isArray(data)) return undefined
  const projects = data.map(readSummary)
  return projects.every((project) => project !== undefined) ? projects : undefined
}

export function readProject(value: unknown): ProjectDetail | undefined {
  const data = payload(value)
  if (!record(data) || !groupID(data.id) || typeof data.name !== "string" || typeof data.active !== "boolean" || !count(data.revision) || !Array.isArray(data.members)) return undefined
  const settings = readSettings(data.settings)
  const time = readTime(data.time)
  const master = readParticipant(data.master)
  const members = data.members.map(readParticipant)
  if (settings === undefined || time === undefined || master === undefined || !members.every((entry) => entry !== undefined)) return undefined
  return { id: data.id, name: data.name, revision: data.revision, active: data.active, master, members, settings, ...time, ...(data.pausedReason === "interrupted" || data.pausedReason === "restart" ? { pausedReason: data.pausedReason } : {}) }
}

export function readCentralPolicy(value: unknown): CentralPolicy | undefined {
  const data = payload(value)
  if (!record(data) || typeof data.enabled !== "boolean") return undefined
  const delegation = readDelegation({ categories: data.categories, actions: data.actions, resources: data.resources, expiresAt: data.expiresAt })
  if (delegation === undefined) return undefined
  return { enabled: data.enabled, ...delegation }
}

export function readSessionCandidates(value: unknown): readonly SessionCandidate[] {
  const data = payload(value)
  if (!Array.isArray(data)) return []
  return data.flatMap((entry): SessionCandidate[] => {
    if (!record(entry) || !text(entry.id, 96)) return []
    const time = record(entry.time) ? entry.time : {}
    if (entry.parentID !== undefined || time.archived !== undefined) return []
    const active = typeof time.active === "number" ? time.active : typeof time.updated === "number" ? time.updated : 0
    const directory = record(entry.location) && typeof entry.location.directory === "string" ? entry.location.directory : ""
    return [{ id: entry.id, title: typeof entry.title === "string" && entry.title.length > 0 ? entry.title : entry.id, directory, active }]
  })
}

export function statusLabel(active: boolean, reason?: "interrupted" | "restart") {
  return active ? "Active" : reason === "interrupted" ? "Paused · interrupted" : reason === "restart" ? "Paused · after restart" : "Paused"
}

export function liveLabel(participant: Pick<ParticipantView, "state" | "pending">) {
  if (participant.state === "running") return "Running"
  if (participant.state === "failed") return "Failed"
  if (participant.state === "waiting") return participant.pending[0] === undefined ? "Waiting" : `Waiting · ${participant.pending[0].kind}`
  return "Idle"
}

function span(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export function relativeAge(elapsed: number) {
  return `${span(Math.max(0, elapsed))} ago`
}

export function ageLabel(participant: Pick<ParticipantView, "state" | "lastActivity">, now: number) {
  const elapsed = now - participant.lastActivity
  if (participant.state === "running") return elapsed < 5_000 ? "active now" : `active ${relativeAge(elapsed)}`
  const verb = participant.state === "waiting" ? "asked" : participant.state === "failed" ? "failed" : "finished"
  return `${verb} ${relativeAge(elapsed)}`
}

export type MemberCounts = { readonly running: number; readonly waiting: number; readonly idle: number; readonly failed: number }

export function memberCounts(members: readonly Pick<ParticipantView, "state">[]): MemberCounts {
  const of = (state: MemberState) => members.filter((entry) => entry.state === state).length
  return { running: of("running"), waiting: of("waiting"), idle: of("idle"), failed: of("failed") }
}

export function liveCounts(project: Pick<ProjectDetail, "master" | "members">): MemberCounts {
  return memberCounts([project.master, ...project.members])
}

export function sessionsLabel(project: Pick<ProjectDetail, "master" | "members">) {
  const total = project.members.length + 1
  return `${total} ${total === 1 ? "Session" : "Sessions"}`
}

export function summaryLine(counts: MemberCounts) {
  return `${counts.running} running${counts.waiting > 0 ? ` · ${counts.waiting} waiting` : ""}${counts.failed > 0 ? ` · ${counts.failed} failed` : ""}`
}

export type ConcurrencyMeter =
  | { readonly kind: "limit"; readonly limit: number; readonly running: number; readonly text: string; readonly cells: readonly boolean[] }
  | { readonly kind: "unlimited"; readonly running: number; readonly text: string }

export function concurrencyMeter(limit: number | null, running: number): ConcurrencyMeter {
  if (limit === null) return { kind: "unlimited", running, text: `${running} · no limit` }
  const shown = Math.min(running, limit)
  const length = Math.min(limit, maxMeterCells)
  const on = limit <= maxMeterCells ? shown : Math.round((shown / limit) * maxMeterCells)
  return { kind: "limit", limit, running: shown, text: `${running} of ${limit} running`, cells: Array.from({ length }, (_, index) => index < on) }
}

export function activityBuckets(members: readonly Pick<ParticipantView, "lastActivity">[], now: number): number[] {
  const buckets = Array.from({ length: sparkBuckets }, () => 0)
  for (const entry of members) {
    const slot = sparkBuckets - 1 - Math.floor(Math.max(0, now - entry.lastActivity) / sparkBucketMs)
    if (slot >= 0) buckets[slot] = (buckets[slot] ?? 0) + 1
  }
  return buckets
}

export function freshnessLabel(read: { readonly updatedAt: number; readonly failedAt: number | undefined }, now: number): { readonly stale: boolean; readonly text: string } {
  if (read.updatedAt === 0) return { stale: false, text: "Updating…" }
  if (read.failedAt !== undefined && read.failedAt >= read.updatedAt) return { stale: true, text: `Update failed ${Math.max(0, Math.floor((now - read.failedAt) / 1_000))} s ago · showing earlier data` }
  const seconds = Math.max(0, Math.floor((now - read.updatedAt) / 1_000))
  if (seconds < 60) return { stale: false, text: `Updated ${seconds} s ago` }
  const minutes = Math.floor(seconds / 60)
  return { stale: false, text: minutes < 60 ? `Updated ${minutes} min ago` : `Updated ${Math.floor(minutes / 60)} h ago` }
}

export function projectOf(groups: readonly ProjectBundle[] | undefined, id: string): { readonly detail: ProjectDetail; readonly role: "master" | "member" } | undefined {
  for (const group of groups ?? []) {
    if (group.detail.master.sessionID === id) return { detail: group.detail, role: "master" }
    if (group.detail.members.some((entry) => entry.sessionID === id)) return { detail: group.detail, role: "member" }
  }
  return undefined
}

export function parseProjectName(input: string) {
  const name = input.trim()
  if (name.length === 0) return { error: "Project name is required" }
  return name.length <= 120 ? { value: name } : { error: "Project name is 1 to 120 characters" }
}

export function sessionTitle(input: string, fallback?: string): { readonly value: string | undefined } | { readonly error: string } {
  const title = input.trim() || fallback
  if (title === undefined) return { value: undefined }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(title)) return { error: "Session title cannot contain control or direction-override characters" }
  return [...title].length <= 120 ? { value: title } : { error: "Session title is 1 to 120 characters" }
}

export function parseConcurrency(input: string) {
  const trimmed = input.trim()
  return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) && Number(trimmed) >= 1 ? { value: Number(trimmed) } : { error: "Concurrency must be a whole number of at least 1" }
}

export function parseList(input: string, bound: { readonly limit: number; readonly length: number; readonly noun: string }): { readonly value: string[] } | { readonly error: string } {
  const items = [...new Set(input.split(/[\n,]/).map((item) => item.trim()).filter((item) => item.length > 0))]
  if (items.some((item) => item.length > bound.length)) return { error: `Each ${bound.noun} is 1 to ${bound.length} characters` }
  if (items.length > bound.limit) return { error: `Use at most ${bound.limit} ${bound.noun}s` }
  return { value: items }
}

export function createProjectInput(name: string, masterSessionID: string) {
  return { name, masterSessionID, memberSessionIDs: [] as string[] }
}

const update = (detail: ProjectDetail) => ({ groupID: detail.id, revision: detail.revision })
const memberIDs = (detail: ProjectDetail) => detail.members.map((entry) => entry.sessionID)

export function renameInput(detail: ProjectDetail, name: string) {
  return { ...update(detail), name }
}

export function addMemberInput(detail: ProjectDetail, id: string) {
  if (id === detail.master.sessionID || memberIDs(detail).includes(id)) throw new Error("That Session is already in this Project")
  if (detail.members.length >= maxMembers) throw new Error(`A Project holds at most ${maxMembers} member Sessions`)
  return { ...update(detail), memberSessionIDs: [...memberIDs(detail), id] }
}

export function removeMemberInput(detail: ProjectDetail, id: string) {
  return { ...update(detail), memberSessionIDs: memberIDs(detail).filter((entry) => entry !== id) }
}

export function changeMasterInput(detail: ProjectDetail, id: string) {
  if (id === detail.master.sessionID) throw new Error("That Session is already the Master")
  const members = [detail.master.sessionID, ...memberIDs(detail).filter((entry) => entry !== id)]
  if (members.length > maxMembers) throw new Error(`A Project holds at most ${maxMembers} member Sessions`)
  return { ...update(detail), masterSessionID: id, memberSessionIDs: members }
}

export function settingsInput(detail: ProjectDetail, settings: SettingsView) {
  return { ...update(detail), settings }
}

export type EffectiveDelegation = {
  readonly state: "inherited" | "narrowed" | "revoked" | "unavailable"
  readonly categories: readonly DelegatedCategory[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly centralActions?: readonly string[]
  readonly centralResources?: readonly string[]
  readonly expiresAt?: number
}

export function effectiveDelegation(central: CentralPolicy | undefined, group: DelegationView | undefined): EffectiveDelegation {
  if (central === undefined) return { state: "unavailable", categories: [] }
  if (!central.enabled) return { state: "revoked", categories: [] }
  const centralExtra = { ...(central.actions === undefined ? {} : { centralActions: central.actions }), ...(central.resources === undefined ? {} : { centralResources: central.resources }) }
  if (group === undefined) return { state: "inherited", categories: central.categories, ...centralExtra, ...(central.expiresAt === undefined ? {} : { expiresAt: central.expiresAt }) }
  const expiries = [central.expiresAt, group.expiresAt].filter((value) => value !== undefined)
  return {
    state: "narrowed", categories: group.categories.filter((category) => central.categories.includes(category)),
    ...(group.actions === undefined ? {} : { actions: group.actions }), ...(group.resources === undefined ? {} : { resources: group.resources }), ...centralExtra,
    ...(expiries.length === 0 ? {} : { expiresAt: Math.min(...expiries) }),
  }
}

export function centralPolicyNote(central: CentralPolicy | undefined) {
  if (central === undefined) return "Central delegation policy is unavailable, so Project narrowing cannot be checked or changed here."
  if (!central.enabled) return "Central delegation policy is off: delegated decisions are revoked for every Project."
  return "Central delegation policy is on. A Project can only narrow it; the narrowest setting applies."
}

export function delegationDraftIssue(central: CentralPolicy | undefined, draft: DelegationView, now: number): string | undefined {
  if (central === undefined) return "Central delegation policy is unavailable"
  if (!central.enabled) return "Central delegation policy is off"
  const widened = draft.categories.find((category) => !central.categories.includes(category))
  if (widened !== undefined) return `The central policy does not delegate ${widened} decisions, so a Project cannot`
  if (draft.expiresAt !== undefined && draft.expiresAt <= now) return "The expiry has already passed"
  if ((draft.actions?.length ?? 0) > 32) return "Use at most 32 actions"
  if ((draft.resources?.length ?? 0) > 32) return "Use at most 32 resources"
  if (draft.actions?.some((action) => !text(action, 512)) || draft.resources?.some((resource) => !text(resource, 512))) return "Each pattern is 1 to 512 characters"
  return undefined
}

export const expiryChoices = [
  { id: "none", label: "No expiry", ms: 0 },
  { id: "1h", label: "1 hour", ms: 3_600_000 },
  { id: "8h", label: "8 hours", ms: 8 * 3_600_000 },
  { id: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { id: "7d", label: "7 days", ms: 7 * 24 * 3_600_000 },
] as const
export type ExpiryChoice = (typeof expiryChoices)[number]["id"]

export function expiryAt(choice: ExpiryChoice, now: number): number | undefined {
  const entry = expiryChoices.find((item) => item.id === choice)
  return entry === undefined || entry.ms === 0 ? undefined : now + entry.ms
}

export type NotificationScope = "all" | "coordinators" | "selected"
export type NotificationFilter = {
  readonly scope: NotificationScope
  readonly sessionIDs?: readonly string[]
  readonly categories?: readonly ExternalKind[]
}
export type PushCoordinationFilter = NotificationFilter

const defaultFilter: NotificationFilter = { scope: "all" }

export function normalizeFilter(value: unknown): NotificationFilter {
  if (!record(value) || !member(["all", "coordinators", "selected"] as const, value.scope)) return defaultFilter
  const rawCategories = Array.isArray(value.categories) ? value.categories : undefined
  const known = rawCategories === undefined ? [] : externalKinds.filter((kind) => rawCategories.includes(kind))
  const categories = rawCategories === undefined || (rawCategories.length > 0 && known.length === 0) || known.length === externalKinds.length ? undefined : known
  const ids = value.scope === "selected"
    ? [...new Set(Array.isArray(value.sessionIDs) ? value.sessionIDs.filter(sessionID) : [])].slice(0, maxMasterSelection)
    : undefined
  return { scope: value.scope, ...(ids === undefined ? {} : { sessionIDs: ids }), ...(categories === undefined ? {} : { categories }) }
}

export function isDefaultFilter(filter: NotificationFilter) {
  return filter.scope === "all" && filter.categories === undefined
}

const withCategories = (filter: NotificationFilter) => filter.categories === undefined ? {} : { categories: filter.categories }

export function setScope(filter: NotificationFilter, scope: NotificationScope): NotificationFilter {
  if (scope === "selected") return { scope, sessionIDs: filter.scope === "selected" ? filter.sessionIDs ?? [] : [], ...withCategories(filter) }
  return { scope, ...withCategories(filter) }
}

export function toggleMaster(filter: NotificationFilter, id: string): NotificationFilter {
  const current = filter.scope === "selected" ? filter.sessionIDs ?? [] : []
  if (!current.includes(id) && current.length >= maxMasterSelection) return filter
  return { scope: "selected", sessionIDs: current.includes(id) ? current.filter((item) => item !== id) : [...current, id], ...withCategories(filter) }
}

export function toggleCategory(filter: NotificationFilter, kind: ExternalKind): NotificationFilter {
  const current = filter.categories ?? externalKinds
  const next = externalKinds.filter((item) => item === kind ? !current.includes(item) : current.includes(item))
  const base = filter.scope === "selected" ? { scope: filter.scope, sessionIDs: filter.sessionIDs ?? [] } : { scope: filter.scope }
  return next.length === externalKinds.length ? base : { ...base, categories: next }
}

export function externalDelivery(filter: NotificationFilter, masters: ReadonlySet<string> | undefined, id: string | undefined, kind: ExternalKind | undefined) {
  if (id === undefined) return true
  if (filter.categories !== undefined && (kind === undefined || !filter.categories.includes(kind))) return false
  if (filter.scope === "all") return true
  if (!masters?.has(id)) return false
  return filter.scope === "coordinators" || (filter.sessionIDs?.includes(id) ?? false)
}

export function externalKind(category: RemoteNoticeCategory, need: RemoteAlertDetail["need"]): ExternalKind | undefined {
  if (category === "agent-completed") return "completion"
  if (need === "permission" || need === "question" || need === "review") return need
  if (need === "blocked") return "review"
  if (need === "failed" || need === "lost") return "failure"
  return undefined
}

export function pushFilterWire(filter: NotificationFilter): PushCoordinationFilter | undefined {
  if (isDefaultFilter(filter)) return undefined
  return { scope: filter.scope, ...(filter.scope === "selected" ? { sessionIDs: [...(filter.sessionIDs ?? [])] } : {}), ...(filter.categories === undefined ? {} : { categories: [...filter.categories] }) }
}

export function filterLabel(filter: NotificationFilter, masters: readonly { readonly sessionID: string; readonly title: string }[] | undefined) {
  const categories = filter.categories === undefined ? "" : filter.categories.length === 0 ? " · no categories (muted)" : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all sessions${categories}`
  if (filter.scope === "coordinators") return `all masters${masters === undefined ? " · list unavailable, withheld until it loads" : ""}${categories}`
  const ids = filter.sessionIDs ?? []
  if (ids.length === 0) return `no sessions selected · nothing notifies externally${categories}`
  if (masters === undefined) return `${ids.length} selected master${ids.length === 1 ? "" : "s"} · list unavailable${categories}`
  const names = ids.map((id) => masters.find((entry) => entry.sessionID === id)?.title ?? "unknown session")
  return `masters: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}${categories}`
}

export function filterSummary(filter: NotificationFilter) {
  const categories = filter.categories === undefined ? "" : filter.categories.length === 0 ? " · no categories (muted)" : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all sessions${categories}`
  if (filter.scope === "coordinators") return `all masters${categories}`
  const total = filter.sessionIDs?.length ?? 0
  return total === 0 ? `no sessions selected · nothing notifies externally${categories}` : `${total} selected master${total === 1 ? "" : "s"}${categories}`
}

export const FILTER_STORAGE_KEY = "ycoding.remote.notification-filter"

export function readFilter(storage: StorageLike | null | undefined = browserStorage()): NotificationFilter {
  return readStored(storage, FILTER_STORAGE_KEY, (raw) => {
    try { return normalizeFilter(JSON.parse(raw)) } catch { return undefined }
  }) ?? defaultFilter
}

export function writeFilter(storage: StorageLike | null | undefined, filter: NotificationFilter): boolean {
  return writeStored(storage, FILTER_STORAGE_KEY, JSON.stringify(normalizeFilter(filter)))
}
