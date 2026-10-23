import type { RemoteAlertDetail, RemoteNoticeCategory } from "@ycoding-ai/remote"
import { browserStorage, readStored, writeStored, type StorageLike } from "../lib/storage"

export const roles = ["coordinator", "worker", "observer"] as const
export type CoordinationRole = (typeof roles)[number]
const statuses = ["disarmed", "armed", "waiting", "stopped", "completed", "needs-rearm"] as const
export type CoordinationStatus = (typeof statuses)[number]
export const delegatedCategories = ["question", "permission", "review"] as const
export type DelegatedCategory = (typeof delegatedCategories)[number]
export const externalKinds = ["question", "permission", "review", "failure", "completion"] as const
export type ExternalKind = (typeof externalKinds)[number]

export const maxMembers = 64
export const maxTools = 64
export const maxScopes = 32
export const maxCoordinatorSelection = 128
const dispatchStatuses = ["queued", "pending", "admitted", "failed", "cancelled", "completed"] as const
const claimStatuses = ["active", "released", "revoked", "expired"] as const
const receiptKinds = ["dispatched", "admitted", "failed", "cancelled", "completed"] as const

export type DelegationView = {
  readonly categories: readonly DelegatedCategory[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly expiresAt?: number
}
export type PolicyView = {
  readonly concurrency: number | null
  readonly queueCapacity: number
  readonly budget?: number
  readonly delegatedDecisions?: DelegationView
}
export type MemberView = {
  readonly sessionID: string
  readonly role: CoordinationRole
  readonly allowedTools?: readonly string[]
  readonly resourceScopes?: readonly string[]
}
export type GroupSummary = {
  readonly id: string
  readonly name: string
  readonly status: CoordinationStatus
  readonly revision: number
  readonly policy: PolicyView
  readonly memberCount: number
  readonly created: number
  readonly updated: number
}
export type SelectionView = {
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly profile?: string; readonly variant?: string }
  readonly reason: string
}
export type ClaimView = {
  readonly targetSessionID: string
  readonly holderSessionID: string
  readonly generation: number
  readonly status: (typeof claimStatuses)[number]
  readonly leaseExpiresAt: number
}
export type DispatchView = {
  readonly id: string
  readonly targetSessionID: string
  readonly coordinatorSessionID: string
  readonly status: (typeof dispatchStatuses)[number]
  readonly reason?: string
  readonly text: string
  readonly updated: number
  readonly selection?: SelectionView
}
export type GroupDetail = Omit<GroupSummary, "memberCount"> & {
  readonly members: readonly MemberView[]
  readonly claims: readonly ClaimView[]
  readonly dispatches: readonly DispatchView[]
}
export type CapacityView = {
  readonly concurrency: number | null
  readonly hardLimit: number | null
  readonly effectiveLimit: number | null
  readonly active: number
  readonly waiting: number
  readonly queued: number
  readonly queueCapacity: number
  readonly available: number | null
  readonly spent: number
  readonly budget?: number
  readonly budgetRemaining?: number
}
export type ReceiptView = {
  readonly id: string
  readonly kind: (typeof receiptKinds)[number]
  readonly sessionID: string
  readonly dispatchID?: string
  readonly detail?: string
  readonly time: number
  readonly selection?: SelectionView
}
export type CentralPolicy = {
  readonly enabled: boolean
  readonly categories: readonly DelegatedCategory[]
  readonly actions?: readonly string[]
  readonly resources?: readonly string[]
  readonly expiresAt?: number
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
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

function readPolicy(value: unknown): PolicyView | undefined {
  if (!record(value)) return undefined
  const concurrency = value.concurrency
  if (concurrency !== null && !(count(concurrency) && concurrency >= 1)) return undefined
  if (!count(value.queueCapacity) || value.queueCapacity < 1 || value.queueCapacity > 1000) return undefined
  if (value.budget !== undefined && !(finite(value.budget) && value.budget > 0)) return undefined
  const delegated = value.delegatedDecisions === undefined ? undefined : readDelegation(value.delegatedDecisions)
  if (value.delegatedDecisions !== undefined && delegated === undefined) return undefined
  return { concurrency, queueCapacity: value.queueCapacity, ...(value.budget === undefined ? {} : { budget: value.budget as number }), ...(delegated === undefined ? {} : { delegatedDecisions: delegated }) }
}

function readMember(value: unknown): MemberView | undefined {
  if (!record(value) || !sessionID(value.sessionID) || !member(roles, value.role)) return undefined
  const tools = value.allowedTools === undefined ? undefined : strings(value.allowedTools, maxTools, 128)
  const scopes = value.resourceScopes === undefined ? undefined : strings(value.resourceScopes, maxScopes, 512)
  if ((value.allowedTools !== undefined && tools === undefined) || (value.resourceScopes !== undefined && scopes === undefined)) return undefined
  return { sessionID: value.sessionID, role: value.role, ...(tools === undefined ? {} : { allowedTools: tools }), ...(scopes === undefined ? {} : { resourceScopes: scopes }) }
}

function readSummary(value: unknown): GroupSummary | undefined {
  if (!record(value) || !groupID(value.id) || typeof value.name !== "string" || !member(statuses, value.status) || !count(value.revision) || !count(value.memberCount)) return undefined
  const policy = readPolicy(value.policy)
  const time = record(value.time) && count(value.time.created) && count(value.time.updated) ? value.time : undefined
  if (policy === undefined || time === undefined) return undefined
  return { id: value.id, name: value.name, status: value.status, revision: value.revision, policy, memberCount: value.memberCount, created: time.created as number, updated: time.updated as number }
}

export function readGroups(value: unknown): readonly GroupSummary[] | undefined {
  const data = payload(value)
  if (!Array.isArray(data)) return undefined
  const groups = data.map(readSummary)
  return groups.every((group) => group !== undefined) ? groups : undefined
}

function readSelection(value: unknown): SelectionView | undefined {
  if (!record(value) || !text(value.agent, 128) || !record(value.model)) return undefined
  const model = value.model
  if (!text(model.providerID, 128) || !text(model.id, 256)) return undefined
  if ((model.profile !== undefined && !text(model.profile, 128)) || (model.variant !== undefined && !text(model.variant, 128))) return undefined
  if (!text(value.reason, 500) || /[\r\n\u2028\u2029]/.test(value.reason)) return undefined
  return { agent: value.agent, reason: value.reason,
    model: { providerID: model.providerID, id: model.id, ...(model.profile === undefined ? {} : { profile: model.profile as string }), ...(model.variant === undefined ? {} : { variant: model.variant as string }) } }
}

function readClaim(value: unknown): ClaimView | undefined {
  if (!record(value) || !sessionID(value.targetSessionID) || !sessionID(value.holderSessionID) || !count(value.generation) || !member(claimStatuses, value.status) || !count(value.leaseExpiresAt)) return undefined
  return { targetSessionID: value.targetSessionID, holderSessionID: value.holderSessionID, generation: value.generation, status: value.status, leaseExpiresAt: value.leaseExpiresAt }
}

function readDispatch(value: unknown): DispatchView | undefined {
  if (!record(value) || !text(value.id, 96) || !sessionID(value.targetSessionID) || !sessionID(value.coordinatorSessionID) || !member(dispatchStatuses, value.status) || typeof value.text !== "string") return undefined
  const updated = record(value.time) && count(value.time.updated) ? value.time.updated : undefined
  if (updated === undefined || (value.reason !== undefined && typeof value.reason !== "string")) return undefined
  const selection = value.selection === undefined ? undefined : readSelection(value.selection)
  if (value.selection !== undefined && selection === undefined) return undefined
  return { id: value.id, targetSessionID: value.targetSessionID, coordinatorSessionID: value.coordinatorSessionID, status: value.status, text: value.text, updated,
    ...(value.reason === undefined ? {} : { reason: value.reason as string }), ...(selection === undefined ? {} : { selection }) }
}

export function readDetail(value: unknown): GroupDetail | undefined {
  const data = payload(value)
  if (!record(data) || !Array.isArray(data.members) || !Array.isArray(data.claims) || !Array.isArray(data.dispatches)) return undefined
  const summary = readSummary({ ...data, memberCount: data.members.length })
  const members = data.members.map(readMember)
  const claims = data.claims.map(readClaim)
  const dispatches = data.dispatches.map(readDispatch)
  if (summary === undefined || !members.every((item) => item !== undefined) || !claims.every((item) => item !== undefined) || !dispatches.every((item) => item !== undefined)) return undefined
  const { memberCount: _, ...rest } = summary
  return { ...rest, members, claims, dispatches }
}

export function readCapacity(value: unknown): CapacityView | undefined {
  const data = payload(value)
  if (!record(data)) return undefined
  const nullable = (field: unknown): field is number | null => field === null || (count(field) && field >= 1)
  const open = (field: unknown): field is number | null => field === null || count(field)
  if (!nullable(data.concurrency) || !nullable(data.hardLimit) || !nullable(data.effectiveLimit) || !open(data.available) || !count(data.active) || !count(data.waiting) || !count(data.queued) || !count(data.queueCapacity) || !finite(data.spent)) return undefined
  return { concurrency: data.concurrency, hardLimit: data.hardLimit, effectiveLimit: data.effectiveLimit, active: data.active, waiting: data.waiting, queued: data.queued, queueCapacity: data.queueCapacity,
    available: data.available, spent: data.spent, ...(finite(data.budget) ? { budget: data.budget } : {}), ...(finite(data.budgetRemaining) ? { budgetRemaining: data.budgetRemaining } : {}) }
}

export function readReceipts(value: unknown): readonly ReceiptView[] | undefined {
  const data = payload(value)
  if (!Array.isArray(data)) return undefined
  const receipts = data.map((item): ReceiptView | undefined => {
    if (!record(item) || !text(item.id, 96) || !member(receiptKinds, item.kind) || !sessionID(item.sessionID) || !count(item.time)) return undefined
    if ((item.dispatchID !== undefined && !text(item.dispatchID, 96)) || (item.detail !== undefined && typeof item.detail !== "string")) return undefined
    const selection = item.selection === undefined ? undefined : readSelection(item.selection)
    if (item.selection !== undefined && selection === undefined) return undefined
    return { id: item.id, kind: item.kind, sessionID: item.sessionID, time: item.time, ...(item.dispatchID === undefined ? {} : { dispatchID: item.dispatchID as string }),
      ...(item.detail === undefined ? {} : { detail: item.detail as string }), ...(selection === undefined ? {} : { selection }) }
  })
  return receipts.every((receipt) => receipt !== undefined) ? receipts : undefined
}

export function readCentralPolicy(value: unknown): CentralPolicy | undefined {
  const data = payload(value)
  if (!record(data) || typeof data.enabled !== "boolean") return undefined
  const delegation = readDelegation({ categories: data.categories, actions: data.actions, resources: data.resources, expiresAt: data.expiresAt })
  if (delegation === undefined) return undefined
  return { enabled: data.enabled, ...delegation }
}

export function statusLabel(status: CoordinationStatus) {
  if (status === "stopped") return "stopped · workers keep running"
  if (status === "needs-rearm") return "needs re-arm"
  return status
}

const arm = { id: "arm", title: "Arm group" } as const
const stop = { id: "stop", title: "Stop dispatch · workers keep running" } as const
const rearm = { id: "rearm", title: "Re-arm group" } as const
const complete = { id: "complete", title: "Complete group" } as const
export type LifecycleActionID = "arm" | "stop" | "rearm" | "complete"

export function lifecycleActions(status: CoordinationStatus): readonly { readonly id: LifecycleActionID; readonly title: string }[] {
  if (status === "disarmed") return [arm]
  if (status === "armed" || status === "waiting") return [stop, complete]
  if (status === "completed") return []
  return [rearm, complete]
}

export function capacitySummary(capacity: { readonly active: number; readonly hardLimit: number | null; readonly concurrency: number | null } | undefined) {
  if (capacity === undefined) return "capacity unreported"
  const policy = capacity.concurrency === null ? "uncapped policy" : `policy ${capacity.concurrency}`
  if (capacity.hardLimit === null) return `${capacity.active} workers · ${policy} · hard limit unreported`
  const effective = Math.min(capacity.concurrency ?? capacity.hardLimit, capacity.hardLimit)
  const base = `${capacity.active}/${effective} workers`
  if (capacity.concurrency === null) return `${base} · uncapped policy · hard limit ${capacity.hardLimit}`
  return `${base} · hard limit ${capacity.hardLimit}${capacity.concurrency > capacity.hardLimit ? ` · policy ${capacity.concurrency} capped` : ""}`
}

const coordinatorRule = "A group needs exactly one coordinator"

export function rosterIssue(roster: readonly MemberView[]): string | undefined {
  if (roster.length > maxMembers) return `A roster holds at most ${maxMembers} sessions`
  if (new Set(roster.map((entry) => entry.sessionID)).size !== roster.length) return "A session can appear once in a roster"
  if (roster.filter((entry) => entry.role === "coordinator").length !== 1) return coordinatorRule
  for (const entry of roster) {
    if ((entry.allowedTools?.length ?? 0) > maxTools) return `A session allows at most ${maxTools} tools`
    if (entry.allowedTools?.some((tool) => !text(tool, 128))) return "A tool name is 1 to 128 characters"
    if ((entry.resourceScopes?.length ?? 0) > maxScopes) return `A session allows at most ${maxScopes} scopes`
    if (entry.resourceScopes?.some((scope) => !text(scope, 512))) return "A scope is 1 to 512 characters"
  }
  return undefined
}

export function assignRole(roster: readonly MemberView[], session: { readonly sessionID: string }, role: CoordinationRole): MemberView[] {
  const demoted = roster.map((entry) => role === "coordinator" && entry.role === "coordinator" ? { ...entry, role: "worker" as const } : entry)
  if (!demoted.some((entry) => entry.sessionID === session.sessionID)) return [...demoted, { sessionID: session.sessionID, role }]
  return demoted.map((entry) => entry.sessionID === session.sessionID ? { ...entry, role } : entry)
}

export function removeMember(roster: readonly MemberView[], id: string): { readonly roster: MemberView[] } | { readonly error: string } {
  const next = roster.filter((entry) => entry.sessionID !== id)
  const error = rosterIssue(next)
  return error === undefined ? { roster: next } : { error }
}

export function parseList(input: string, bound: { readonly limit: number; readonly length: number; readonly noun: string }): { readonly value: string[] } | { readonly error: string } {
  const items = [...new Set(input.split(/[\n,]/).map((item) => item.trim()).filter((item) => item.length > 0))]
  if (items.some((item) => item.length > bound.length)) return { error: `Each ${bound.noun} is 1 to ${bound.length} characters` }
  if (items.length > bound.limit) return { error: `Use at most ${bound.limit} ${bound.noun}s` }
  return { value: items }
}

export function parseGroupName(input: string) {
  const name = input.trim()
  return name.length >= 1 && name.length <= 120 ? { value: name } : { error: "Name the group in 1 to 120 characters" }
}

export function parseConcurrency(input: string) {
  const trimmed = input.trim()
  return /^\d+$/.test(trimmed) && Number(trimmed) >= 1 ? { value: Number(trimmed) } : { error: "Concurrency must be a whole number of at least 1" }
}

export function parseQueueCapacity(input: string) {
  const trimmed = input.trim()
  return /^\d+$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 1000 ? { value: Number(trimmed) } : { error: "Queue capacity must be a whole number from 1 to 1000" }
}

export function parseBudget(input: string): { readonly value: number | undefined } | { readonly error: string } {
  const trimmed = input.trim().replace(/^\$/, "")
  if (trimmed === "" || trimmed.toLowerCase() === "none") return { value: undefined }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed) || Number(trimmed) <= 0) return { error: "Budget must be a positive USD amount with up to two decimals, or none" }
  return { value: Number(trimmed) }
}

export function formatBudget(amount: number) {
  return `$${amount.toFixed(2)}`
}

const memberInput = (entry: MemberView) => ({
  sessionID: entry.sessionID, role: entry.role,
  ...(entry.allowedTools === undefined ? {} : { allowedTools: [...entry.allowedTools] }),
  ...(entry.resourceScopes === undefined ? {} : { resourceScopes: [...entry.resourceScopes] }),
})

export function createGroupInput(name: string, roster: readonly MemberView[]) {
  return { name, policy: { concurrency: 1, queueCapacity: 64 }, members: roster.map(memberInput) }
}

export function membersInput(detail: GroupDetail, change: { readonly members: readonly MemberView[]; readonly name?: string; readonly policy?: PolicyView }) {
  return {
    revision: detail.revision,
    members: change.members.map(memberInput),
    policy: change.policy ?? detail.policy,
    ...(change.name === undefined || change.name === detail.name ? {} : { name: change.name }),
  }
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
  if (central === undefined) return "Central delegation policy is unavailable, so group narrowing cannot be checked or changed here."
  if (!central.enabled) return "Central delegation policy is off: delegated decisions are revoked for every group, whatever a group sets."
  return "Central delegation policy is on. A group can only narrow it; the narrowest setting applies."
}

export function delegationDraftIssue(central: CentralPolicy | undefined, draft: DelegationView, now: number): string | undefined {
  if (central === undefined) return "Central delegation policy is unavailable"
  if (!central.enabled) return "Central delegation policy is off"
  const widened = draft.categories.find((category) => !central.categories.includes(category))
  if (widened !== undefined) return `The central policy does not delegate ${widened} decisions, so a group cannot`
  if (draft.expiresAt !== undefined && draft.expiresAt <= now) return "The expiry has already passed"
  if ((draft.actions?.length ?? 0) > 32) return "Use at most 32 actions"
  if ((draft.resources?.length ?? 0) > 32) return "Use at most 32 resources"
  if (draft.actions?.some((action) => !text(action, 512)) || draft.resources?.some((resource) => !text(resource, 512))) return "Each pattern is 1 to 512 characters"
  return undefined
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
    ? [...new Set(Array.isArray(value.sessionIDs) ? value.sessionIDs.filter(sessionID) : [])].slice(0, maxCoordinatorSelection)
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

export function toggleCoordinator(filter: NotificationFilter, id: string): NotificationFilter {
  const current = filter.scope === "selected" ? filter.sessionIDs ?? [] : []
  if (!current.includes(id) && current.length >= maxCoordinatorSelection) return filter
  return { scope: "selected", sessionIDs: current.includes(id) ? current.filter((item) => item !== id) : [...current, id], ...withCategories(filter) }
}

export function toggleCategory(filter: NotificationFilter, kind: ExternalKind): NotificationFilter {
  const current = filter.categories ?? externalKinds
  const next = externalKinds.filter((item) => item === kind ? !current.includes(item) : current.includes(item))
  const base = filter.scope === "selected" ? { scope: filter.scope, sessionIDs: filter.sessionIDs ?? [] } : { scope: filter.scope }
  return next.length === externalKinds.length ? base : { ...base, categories: next }
}

export function externalDelivery(filter: NotificationFilter, coordinators: ReadonlySet<string> | undefined, id: string | undefined, kind: ExternalKind | undefined) {
  if (id === undefined) return true
  if (filter.categories !== undefined && (kind === undefined || !filter.categories.includes(kind))) return false
  if (filter.scope === "all") return true
  if (!coordinators?.has(id)) return false
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

export function filterLabel(filter: NotificationFilter, coordinators: readonly { readonly sessionID: string; readonly title: string }[] | undefined) {
  const categories = filter.categories === undefined ? "" : filter.categories.length === 0 ? " · no categories (muted)" : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all sessions${categories}`
  if (filter.scope === "coordinators") return `all coordinators${coordinators === undefined ? " · list unavailable, withheld until it loads" : ""}${categories}`
  const ids = filter.sessionIDs ?? []
  if (ids.length === 0) return `no sessions selected · nothing notifies externally${categories}`
  if (coordinators === undefined) return `${ids.length} selected coordinator${ids.length === 1 ? "" : "s"} · list unavailable${categories}`
  const names = ids.map((id) => coordinators.find((coordinator) => coordinator.sessionID === id)?.title ?? "unknown session")
  return `coordinators: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}${categories}`
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

export function sessionLabel(id: string, titles: ReadonlyMap<string, string>) {
  return titles.get(id) ?? `Session ${id}`
}

const queueReasons: Readonly<Record<string, string>> = {
  capacity: "waiting for a free worker slot",
  "hard-limit": "at the hard limit",
  dependency: "waiting for a dependency to finish",
  budget: "at the budget limit",
}

export function queueReasonLabel(reason: string) {
  return queueReasons[reason] ?? `reason ${reason.slice(0, 40)}`
}

export function queueItems(detail: GroupDetail, title: (id: string) => string) {
  return detail.dispatches.filter((dispatch) => dispatch.status === "queued" || dispatch.status === "pending")
    .map((dispatch) => ({ id: dispatch.id, target: title(dispatch.targetSessionID), reason: dispatch.reason === undefined ? dispatch.status : queueReasonLabel(dispatch.reason),
      ...(dispatch.selection === undefined ? {} : { selection: dispatch.selection }) }))
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

export function leaseLine(claim: ClaimView, title: (id: string) => string, now: number) {
  const base = `${title(claim.targetSessionID)} · held by ${title(claim.holderSessionID)}`
  return claim.leaseExpiresAt > now ? `${base} · expires in ${span(claim.leaseExpiresAt - now)}` : `${base} · expired`
}

export function receiptLine(receipt: ReceiptView, title: (id: string) => string, now: number) {
  return `${receipt.kind} → ${title(receipt.sessionID)}${receipt.detail === undefined || receipt.detail === "" ? "" : ` · ${receipt.detail}`} · ${relativeAge(now - receipt.time)}`
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

export function filterSummary(filter: NotificationFilter) {
  const categories = filter.categories === undefined ? "" : filter.categories.length === 0 ? " · no categories (muted)" : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all sessions${categories}`
  if (filter.scope === "coordinators") return `all coordinators${categories}`
  const count = filter.sessionIDs?.length ?? 0
  return count === 0 ? `no sessions selected · nothing notifies externally${categories}` : `${count} selected coordinator${count === 1 ? "" : "s"}${categories}`
}

export function selectionLines(selection: SelectionView | undefined): { readonly choice: string; readonly reason?: string } {
  if (selection === undefined) return { choice: "Selection not reported" }
  const model = selection.model
  return {
    choice: `Agent ${selection.agent} · ${model.providerID}/${model.id}${model.profile === undefined ? "" : ` · profile ${model.profile}`} · variant ${model.variant ?? "unavailable"}`,
    reason: selection.reason,
  }
}
