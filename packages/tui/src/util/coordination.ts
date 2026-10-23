export type CoordinationRole = "coordinator" | "worker" | "observer"
export type CoordinationStatus = "disarmed" | "armed" | "waiting" | "stopped" | "completed" | "needs-rearm"

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

export type CoordinationMemberView = {
  readonly sessionID: string
  readonly title: string
  readonly role: CoordinationRole
  readonly allowedTools?: ReadonlyArray<string>
  readonly resourceScopes?: ReadonlyArray<string>
}

export type CoordinationCapacityView = {
  readonly active: number
  readonly hardLimit: number | null
}

export type CoordinationPolicyView = {
  readonly concurrency: number | null
  readonly queueCapacity: number
  readonly budget?: number
  readonly delegatedDecisions?: DelegatedDecisionsView
}

export type DispatchSelectionView = {
  readonly agent: string
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly profile?: string
    readonly variant?: string
  }
  readonly reason: string
}

export type CoordinationQueueItemView = {
  readonly id: string
  readonly title: string
  readonly reason: string
  readonly selection?: DispatchSelectionView
}
export type CoordinationLeaseView = {
  readonly id: string
  readonly holder: string
  readonly resource: string
  readonly expiresAt?: number
}
export type CoordinationReceiptView = {
  readonly id: string
  readonly worker: string
  readonly outcome: string
  readonly reason?: string
  readonly time: number
  readonly selection?: DispatchSelectionView
}

export type CoordinationGroupView = {
  readonly id: string
  readonly name: string
  readonly status: CoordinationStatus
  readonly revision: number
  readonly roster: ReadonlyArray<CoordinationMemberView>
  readonly capacity: CoordinationCapacityView
  readonly policy: CoordinationPolicyView
  readonly queue: ReadonlyArray<CoordinationQueueItemView>
  readonly leases: ReadonlyArray<CoordinationLeaseView>
  readonly receipts: ReadonlyArray<CoordinationReceiptView>
}

export type CoordinationSessionChoice = { readonly sessionID: string; readonly title: string }
export type CoordinationMemberInput = {
  readonly sessionID: string
  readonly role: CoordinationRole
  readonly allowedTools?: ReadonlyArray<string>
  readonly resourceScopes?: ReadonlyArray<string>
}
export type MemberAccessPatch = {
  readonly allowedTools?: ReadonlyArray<string>
  readonly resourceScopes?: ReadonlyArray<string>
}
export type CoordinationPolicyPatch = {
  readonly concurrency?: number | null
  readonly queueCapacity?: number
  readonly budget?: number | null
  readonly delegatedDecisions?: DelegatedDecisionsView | null
}

export type CoordinationService = {
  create(input: { name: string; roster: ReadonlyArray<CoordinationMemberInput> }): Promise<void>
  rename(groupID: string, name: string): Promise<void>
  addMember(groupID: string, sessionID: string, role: CoordinationRole): Promise<void>
  setMemberRole(groupID: string, sessionID: string, role: CoordinationRole): Promise<void>
  setMemberAccess(groupID: string, sessionID: string, patch: MemberAccessPatch): Promise<void>
  removeMember(groupID: string, sessionID: string): Promise<void>
  updatePolicy(groupID: string, patch: CoordinationPolicyPatch): Promise<void>
  arm(groupID: string): Promise<void>
  stop(groupID: string): Promise<void>
  complete(groupID: string): Promise<void>
}

export const externalNotificationKinds = ["question", "permission", "review", "failure", "completion"] as const
export type ExternalNotificationKind = (typeof externalNotificationKinds)[number]

export type NotificationFilter = {
  readonly scope: "all" | "coordinators" | "selected"
  readonly sessionIDs?: ReadonlyArray<string>
  readonly categories?: ReadonlyArray<ExternalNotificationKind>
}

export const maxSelectedCoordinators = 128

const coordinatorRule = "A group needs exactly one coordinator"

export function effectiveLimit(capacity: CoordinationCapacityView, policy: CoordinationPolicyView) {
  if (capacity.hardLimit === null) return null
  return Math.min(policy.concurrency ?? capacity.hardLimit, capacity.hardLimit)
}

export function capacitySummary(capacity: CoordinationCapacityView, policy: CoordinationPolicyView) {
  if (capacity.hardLimit === null)
    return `${capacity.active} workers · ${policy.concurrency === null ? "uncapped policy" : `policy ${policy.concurrency}`} · hard limit unreported`
  const base = `${capacity.active}/${effectiveLimit(capacity, policy)} workers`
  if (policy.concurrency === null) return `${base} · uncapped policy · hard limit ${capacity.hardLimit}`
  const capped = policy.concurrency > capacity.hardLimit ? ` · policy ${policy.concurrency} capped` : ""
  return `${base} · hard limit ${capacity.hardLimit}${capped}`
}

export function statusLabel(status: CoordinationStatus) {
  if (status === "stopped") return "stopped · workers keep running"
  if (status === "needs-rearm") return "needs re-arm"
  return status
}

const arm = { id: "arm", title: "Arm group" } as const
const stop = { id: "stop", title: "Stop dispatch · workers keep running" } as const
const rearm = { id: "rearm", title: "Re-arm group" } as const
const complete = { id: "complete", title: "Complete project" } as const

export function lifecycleActions(status: CoordinationStatus) {
  if (status === "disarmed") return [arm]
  if (status === "armed" || status === "waiting") return [stop, complete]
  if (status === "completed") return []
  return [rearm, complete]
}

const concurrencyRule = "Concurrency must be a whole number of at least 1, or uncapped"
const queueRule = "Queue capacity must be a whole number from 1 to 1000"
const budgetRule = "Budget must be a positive USD amount with up to two decimals, or none"
const expiryRule = "Expiry must be never or a duration such as 30m, 2h, or 1d"

export function parseConcurrency(text: string) {
  const trimmed = text.trim()
  if (trimmed.toLowerCase() === "uncapped") return { value: null }
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return { error: concurrencyRule }
  return { value: Number(trimmed) }
}

export function parseQueueCapacity(text: string) {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > 1000) return { error: queueRule }
  return { value: Number(trimmed) }
}

export function parseBudget(text: string) {
  const trimmed = text.trim().replace(/^\$/, "")
  if (trimmed === "" || trimmed.toLowerCase() === "none") return { value: undefined }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed) || Number(trimmed) <= 0) return { error: budgetRule }
  return { value: Number(trimmed) }
}

export function formatBudget(amount: number) {
  return `$${amount.toFixed(2)}`
}

const listLimits = {
  tools: { singular: "tool name", plural: "tools", items: 64, length: 128 },
  scopes: { singular: "scope", plural: "scopes", items: 32, length: 512 },
  actions: { singular: "action", plural: "actions", items: 32, length: 512 },
  resources: { singular: "resource", plural: "resources", items: 32, length: 512 },
} as const

export function parseList(text: string, kind: keyof typeof listLimits) {
  const limit = listLimits[kind]
  const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "")
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
  if (!match) return { error: expiryRule }
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

export function delegationSummary(project: DelegatedDecisionsView | undefined, global: GlobalDelegationView | undefined) {
  if (global === undefined) return "global policy unavailable"
  if (!global.enabled) return "globally disabled"
  if (project === undefined) return `inherit global (${global.categories.join(", ")})`
  if (project.categories.length === 0) return "custom · delegation disabled"
  return `custom narrowing (${project.categories.join(", ")})`
}

const queueReasons: Record<string, string> = {
  capacity: "waiting for a free worker slot",
  "hard-limit": "at the hard limit",
  dependency: "waiting for a dependency to finish",
  budget: "at the budget limit",
}

export function queueReasonLabel(reason: string) {
  return queueReasons[reason] ?? `reason ${reason.slice(0, 40)}`
}

function span(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export function relativeAge(elapsed: number) {
  return `${span(Math.max(0, elapsed))} ago`
}

export function relativeFuture(remaining: number) {
  return `in ${span(Math.max(0, remaining))}`
}

export function leaseLine(lease: CoordinationLeaseView, now: number) {
  const base = `${lease.resource} · held by ${lease.holder}`
  if (lease.expiresAt === undefined) return base
  return lease.expiresAt > now ? `${base} · expires in ${span(lease.expiresAt - now)}` : `${base} · expired`
}

export function receiptLine(receipt: CoordinationReceiptView) {
  const base = `${receipt.outcome} → ${receipt.worker}`
  return receipt.reason === undefined ? base : `${base} · ${queueReasonLabel(receipt.reason)}`
}

export function selectionLine(selection: DispatchSelectionView) {
  const model = `${selection.model.providerID}/${selection.model.id}${selection.model.profile === undefined ? "" : ` (${selection.model.profile})`}`
  const reason = selection.reason.replace(/\s+/g, " ").trim()
  return `agent ${selection.agent} · ${model} · variant ${selection.model.variant ?? "unavailable"}${reason === "" ? "" : ` · ${reason}`}`
}

export function rosterError(roster: ReadonlyArray<{ readonly sessionID: string; readonly role: CoordinationRole }>) {
  if (new Set(roster.map((member) => member.sessionID)).size !== roster.length)
    return "A session can appear once in a roster"
  if (roster.filter((member) => member.role === "coordinator").length !== 1) return coordinatorRule
}

export function assignRole(
  roster: ReadonlyArray<CoordinationMemberView>,
  session: { readonly sessionID: string; readonly title: string },
  role: CoordinationRole,
): CoordinationMemberView[] {
  const demoted = roster.map((member) =>
    role === "coordinator" && member.role === "coordinator" ? { ...member, role: "worker" as const } : member,
  )
  if (!demoted.some((member) => member.sessionID === session.sessionID))
    return [...demoted, { sessionID: session.sessionID, title: session.title, role }]
  return demoted.map((member) => (member.sessionID === session.sessionID ? { ...member, role } : member))
}

export function removeMember(roster: ReadonlyArray<CoordinationMemberView>, sessionID: string) {
  const next = roster.filter((member) => member.sessionID !== sessionID)
  const error = rosterError(next)
  return error === undefined ? { roster: next } : { error }
}

export function coordinatorChoices(groups: ReadonlyArray<CoordinationGroupView> | undefined) {
  if (groups === undefined) return undefined
  const seen = new Set<string>()
  return groups
    .flatMap((group) => group.roster)
    .filter((member) => member.role === "coordinator" && !seen.has(member.sessionID) && seen.add(member.sessionID))
    .map((member) => ({ sessionID: member.sessionID, title: member.title }))
}

export function externalNotificationAllowed(
  filter: NotificationFilter,
  groups: ReadonlyArray<CoordinationGroupView> | undefined,
  sessionID: string,
  kind: ExternalNotificationKind,
) {
  if (filter.categories && !filter.categories.includes(kind)) return false
  if (filter.scope === "all") return true
  if (!coordinatorChoices(groups)?.some((choice) => choice.sessionID === sessionID)) return false
  return filter.scope === "coordinators" || (filter.sessionIDs?.includes(sessionID) ?? false)
}

function withCategories(filter: NotificationFilter) {
  return filter.categories === undefined ? {} : { categories: filter.categories }
}

export function toggleCoordinator(filter: NotificationFilter, sessionID: string): NotificationFilter {
  const current = filter.scope === "selected" ? (filter.sessionIDs ?? []) : []
  if (!current.includes(sessionID) && current.length >= maxSelectedCoordinators) return filter
  const next = current.includes(sessionID) ? current.filter((id) => id !== sessionID) : [...current, sessionID]
  return { scope: "selected", sessionIDs: next, ...withCategories(filter) }
}

export function toggleCategory(filter: NotificationFilter, kind: ExternalNotificationKind): NotificationFilter {
  const current = filter.categories ?? externalNotificationKinds
  const next = externalNotificationKinds.filter((item) => (item === kind ? !current.includes(item) : current.includes(item)))
  const scope = filter.scope === "selected" ? { scope: filter.scope, sessionIDs: filter.sessionIDs ?? [] } : { scope: filter.scope }
  if (next.length === externalNotificationKinds.length) return scope
  return { ...scope, categories: next }
}

export function notificationFilterLabel(
  filter: NotificationFilter,
  coordinators: ReadonlyArray<{ readonly sessionID: string; readonly title: string }> | undefined,
) {
  const categories =
    filter.categories === undefined ? "" : filter.categories.length === 0 ? " · no categories" : ` · ${filter.categories.join(", ")}`
  if (filter.scope === "all") return `all sessions${categories}`
  if (filter.scope === "coordinators")
    return `all coordinators${coordinators === undefined ? " · list unavailable" : ""}${categories}`
  const ids = filter.sessionIDs ?? []
  if (ids.length === 0) return `no coordinators selected${categories}`
  if (coordinators === undefined)
    return `${ids.length} selected coordinator${ids.length === 1 ? "" : "s"} · list unavailable${categories}`
  const names = ids.map((id) => coordinators.find((coordinator) => coordinator.sessionID === id)?.title ?? "unknown session")
  const extra = names.length > 2 ? ` +${names.length - 2}` : ""
  return `coordinators: ${names.slice(0, 2).join(", ")}${extra}${categories}`
}
