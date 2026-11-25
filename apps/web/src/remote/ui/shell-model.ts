import { contextWindowDisplay, dotSteerDisplay, modelLabel, type ModelRefView, type RemoteMessageView, type SessionView } from "../projection"
import { autonomySummary } from "../autonomy"
import type { SessionInfoView } from "../store"
import type { RemoteTransportStatus } from "../transport"
import type { IconName } from "../../ui/icon"
import { WORKSPACE_DESTINATIONS } from "./shared-workspace"
import {
  connectionBanner,
  lostResultLabel,
  sessionActivityGroup,
  sessionStateChips,
  summarizeConnection,
  type ConnectionTone,
  type RemoteConnectionState,
  type RemoteSessionStatus,
  type RemoteSessionSummary,
  type SessionChip,
} from "../view-model"

export const views = ["/remote", "/remote/sessions", "/remote/session", "/remote/projects", "/remote/workspaces", "/remote/usage", "/remote/settings"] as const

export type RemoteView = (typeof views)[number]

export type RemoteActivityDestination = {
  readonly id: "chat" | "sessions" | "projects" | "workspaces" | "usage" | "settings"
  readonly label: string
  readonly icon: IconName
  readonly route: RemoteView
  readonly current: boolean
  readonly ariaLabel: string
  readonly placement?: "end"
  readonly badge?: { readonly count: number; readonly hue: "amber"; readonly label: string }
}

export function remoteActivityDestinations(input: { readonly view: RemoteView; readonly sessionID?: string; readonly requests: number; readonly waiting: number }): readonly RemoteActivityDestination[] {
  const waiting = Math.max(input.waiting, input.requests > 0 ? 1 : 0)
  const chat: RemoteActivityDestination = {
    id: "chat",
    label: "Chat",
    icon: "chat",
    route: input.sessionID === undefined ? "/remote" : "/remote/session",
    current: input.view === "/remote" || input.view === "/remote/session",
    ariaLabel: input.requests > 0 ? "Chat, waiting for your decision" : "Chat",
    ...(input.requests > 0 ? { badge: { count: input.requests, hue: "amber" as const, label: input.requests === 1 ? "1 request waiting" : `${input.requests} requests waiting` } } : {}),
  }
  const destinations = [...WORKSPACE_DESTINATIONS.filter((item) => item.id === "sessions"), ...WORKSPACE_DESTINATIONS.filter((item) => item.id !== "sessions")].map((item): RemoteActivityDestination => {
    const flagged = item.id === "sessions" && waiting > 0
    return {
      id: item.id,
      label: item.label,
      icon: item.icon,
      route: item.route,
      current: input.view === item.route,
      ariaLabel: flagged ? `${item.label}, waiting for your decision` : item.label,
      ...(item.id === "settings" ? { placement: "end" as const } : {}),
      ...(flagged ? { badge: { count: waiting, hue: "amber" as const, label: waiting === 1 ? "1 Session waiting" : `${waiting} Sessions waiting` } } : {}),
    }
  })
  return [chat, ...destinations]
}

export function remoteSurfaceComposition(path: RemoteView, hasSession: boolean) {
  const selectedConversation = path === "/remote/session" && hasSession
  return { showComposer: selectedConversation }
}

export type ConnectionStripView = {
  readonly tone: ConnectionTone
  readonly body: string
  readonly showReconnect: boolean
  readonly showSettings: boolean
}

/**
 * What the connection strip states, and which controls it offers. A healthy connection
 * says nothing the header's connection label does not, so the strip appears only for a
 * state that carries a message or a recovery action.
 */
export function connectionStripView(input: {
  readonly connection: RemoteConnectionState
  readonly transportKind: RemoteTransportStatus["kind"]
  readonly activeDeviceID?: string
  readonly advertised: number
  readonly lastRelayDrop?: { readonly code: number; readonly reason: string }
}): ConnectionStripView | undefined {
  if (input.connection.kind === "connected" && input.transportKind === "open") return undefined
  const summary = summarizeConnection(input.connection)
  const banner = connectionBanner(input.connection)
  const body = banner === undefined ? `${summary.label} — ${summary.detail}` : `${banner.title} — ${banner.body}`
  const drop = input.activeDeviceID !== undefined && input.lastRelayDrop !== undefined &&
    (input.connection.kind === "connected" || input.connection.kind === "connecting" || input.connection.kind === "error")
    ? `Last browser relay drop (${input.lastRelayDrop.code})${input.connection.kind === "error" && summary.detail === input.lastRelayDrop.reason ? "" : `: ${input.lastRelayDrop.reason}`}` : undefined
  return {
    tone: summary.tone,
    body: drop === undefined ? body : `${body} · ${drop}`,
    showReconnect:
      input.activeDeviceID !== undefined &&
      input.transportKind !== "open" &&
      ((banner?.showReconnect ?? false) || input.advertised > 0),
    showSettings: banner?.showSettings ?? false,
  }
}

/** One advertised session as the header chips and the session rows describe it. */
export function summarizeSession(session: SessionInfoView, view: SessionView | undefined, project?: { readonly role: "master" | "member"; readonly name: string }): RemoteSessionSummary {
  const active = view !== undefined && view.id === session.id ? view : undefined
  const autonomy = active?.autonomy
  const model = modelLabel(active?.model) ?? session.modelLabel
  return {
    id: session.id,
    title: session.title,
    status: sessionStatus(session, active),
    ...(session.pinnedAt === undefined ? {} : { pinned: true }),
    ...(project === undefined ? {} : { projectRole: project.role, projectName: project.name }),
    agent: active?.agent ?? session.agent,
    model,
    autonomy: autonomy?.mode,
    permissions: autonomy === undefined ? undefined : (autonomy.effective ?? autonomy).permissions,
    guardrails: autonomy === undefined ? undefined : (autonomy.effective ?? autonomy).guardrails,
    answers: autonomy === undefined ? undefined : (autonomy.effective ?? autonomy).answers,
    goalActive: autonomy?.goal?.status === "active",
    deferred: autonomy?.effective?.deferred ?? (autonomy === undefined ? undefined : autonomy.defer !== undefined),
    updatedAt: session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : undefined,
  }
}

/**
 * Whether the loaded session view reports an unanswered approval. Only the selected
 * session has a loaded view, so a session this client has not loaded keeps the status the
 * device reported for it instead of being described as waiting.
 */
export function awaitsApproval(view: SessionView | undefined, sessionID: string): boolean {
  if (view === undefined || view.id !== sessionID) return false
  return view.requests.some((request) => request.kind === "permission" || request.kind === "guardrail")
}

export function sessionNeedsAttention(session: SessionInfoView, view: SessionView | undefined): boolean {
  if (session.attention === true && session.lost !== true) return true
  return view !== undefined && view.id === session.id && view.requests.length > 0
}

export function prioritizePanelSessions(sessions: readonly SessionInfoView[], view: SessionView | undefined): readonly SessionInfoView[] {
  const priority = (session: SessionInfoView) => sessionNeedsAttention(session, view) ? 0 : session.running === true ? 1 : session.pinnedAt !== undefined ? 2 : 3
  return [...sessions].sort((left, right) => priority(left) - priority(right))
}

export function sessionCompanionSummary(view: SessionView | undefined, sessionModel?: ModelRefView) {
  if (!view) return undefined
  const context = contextWindowDisplay(view, view.model ?? sessionModel)
  const autonomy = view.autonomy
  const goal = autonomy?.goal?.status === "active" ? autonomy.goal : undefined
  return {
    ...(context ? { contextLabel: `${context.usedPercent}% used`, contextTokens: context.tokens, contextUsed: context.usedTokens, contextCapacity: context.capacityTokens, contextFraction: context.fraction } : {}),
    ...(autonomy ? { autonomyLabel: autonomySummary(autonomy.effective ?? autonomy).label } : {}),
    ...(goal ? { goalText: goal.text, goalIteration: goal.iteration } : {}),
  }
}

export type SessionRowSignal = { readonly kind: "running" | "waiting" | "failed" | "idle"; readonly label?: string }

export function sessionRowSignal(session: SessionInfoView, view: SessionView | undefined): SessionRowSignal {
  if (awaitsApproval(view, session.id)) return { kind: "waiting", label: "Waiting for approval" }
  if (sessionNeedsAttention(session, view)) return { kind: "waiting", label: "Waiting for you" }
  if (session.running === true || (view?.id === session.id && view.status === "running")) return { kind: "running", label: "Running" }
  if (session.failed === true) return { kind: "failed", label: "Failed" }
  return { kind: "idle" }
}

export type SessionFilter = "all" | "waiting" | "running" | "idle"

export const sessionFilters: readonly SessionFilter[] = ["all", "waiting", "running", "idle"]

export function sessionFilterCounts(sessions: readonly SessionInfoView[], view: SessionView | undefined, active: SessionFilter): Partial<Record<SessionFilter, number>> {
  if (active !== "all") return { [active]: sessions.length }
  const waiting = sessions.filter((session) => sessionNeedsAttention(session, view)).length
  const running = sessions.filter((session) => !sessionNeedsAttention(session, view) && session.running === true).length
  return { all: sessions.length, waiting, running, idle: sessions.length - waiting - running }
}

export function groupRailSessions(sessions: readonly SessionInfoView[], view?: SessionView, projectOf?: (id: string) => { readonly id: string; readonly name: string } | undefined, deviceID?: string): readonly { readonly key: string; readonly label: string; readonly sessions: readonly SessionInfoView[] }[] {
  const groups = new Map<string, { label: string; sessions: SessionInfoView[] }>()
  for (const session of sessions) {
    const project = projectOf?.(session.id)
    const signal = sessionRowSignal(session, view).kind
    const status = session.archived ? "Archived" : signal === "idle" && session.running === undefined && view?.id !== session.id ? "Status unreported" : signal[0]!.toUpperCase() + signal.slice(1)
    const environment = session.scope === "standalone" ? "Standalone" : session.scope === "bound" ? "Bound" : "Environment unreported"
    const key = JSON.stringify([deviceID ?? null, project?.id ?? null, status, session.scope ?? null, session.workspaceID ?? null, session.directory ?? null])
    const label = `${project ? `${project.name} (${project.id})` : "Project unreported"} · ${status} · ${environment}${session.directory ? ` · ${session.directory}` : ""}`
    const group = groups.get(key)
    if (group) group.sessions.push(session)
    else groups.set(key, { label, sessions: [session] })
  }
  return [...groups].map(([key, group]) => ({ key, ...group }))
}

export function transcriptContextMessages(messages: readonly RemoteMessageView[]): readonly { readonly id: string; readonly role: string; readonly summary: string }[] {
  const excerpt = (text: string) => {
    const line = text.replace(/\s+/g, " ").trim()
    return line.length === 0 ? "No text" : line.length > 96 ? `${line.slice(0, 95)}…` : line
  }
  return messages.flatMap((message) => {
    if (message.kind === "user") return [{ id: message.id, role: "User", summary: excerpt(message.text) }]
    const steer = dotSteerDisplay(message)
    if (steer !== undefined) return [{ id: message.id, role: "Dot steer", summary: excerpt(steer.text) }]
    if (message.kind === "assistant") return [{ id: message.id, role: message.agent ?? "Assistant", summary: excerpt(message.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join(" ")) }]
    return []
  })
}

export type PresenceEntry<T> = { readonly key: string; readonly item: T; readonly open: boolean }

export function reconcilePresence<T>(entries: readonly PresenceEntry<T>[], items: readonly T[], keyOf: (item: T) => string): readonly PresenceEntry<T>[] {
  const current = new Map(items.map((item) => [keyOf(item), item]))
  const kept = entries.map((entry) => {
    const item = current.get(entry.key)
    return item === undefined ? { ...entry, open: false } : { key: entry.key, item, open: true }
  })
  const known = new Set(entries.map((entry) => entry.key))
  return [...kept, ...items.filter((item) => !known.has(keyOf(item))).map((item) => ({ key: keyOf(item), item, open: true }))]
}

export function settlePresence<T>(entries: readonly PresenceEntry<T>[], key: string): readonly PresenceEntry<T>[] {
  return entries.filter((entry) => entry.open || entry.key !== key)
}

/**
 * The chips one session row and the selected session's header row show: the status the
 * device reported, plus the fact that the loaded view is holding an unanswered approval.
 */
export function sessionChips(session: SessionInfoView, view: SessionView | undefined, project?: { readonly role: "master" | "member"; readonly name: string }): readonly SessionChip[] {
  const review = view?.review?.items.filter((item) => item.rootSessionID === session.id || item.sessionID === session.id).length ?? 0
  const chips = [
    ...(review > 0 ? [{ label: `review ${review}`, tone: "attention" as const }] : []),
    ...(session.lost === true ? [{ label: lostResultLabel, tone: "attention" as const }] : []),
    ...sessionStateChips(summarizeSession(session, view, project)),
  ]
  if (awaitsApproval(view, session.id)) return [{ label: "Waiting for approval", tone: "attention" }, ...chips]
  if (sessionNeedsAttention(session, view)) return [{ label: "Waiting for you", tone: "attention" }, ...chips]
  return chips
}

export function filterSessions(
  sessions: readonly SessionInfoView[],
  query: string,
  filter: SessionFilter = "all",
): readonly SessionInfoView[] {
  const needle = query.trim().toLowerCase()
  return sessions.filter((session) => {
    if (filter !== "all" && sessionActivityGroup(session) !== filter) return false
    if (filter === "idle" && session.archived) return false
    if (needle.length === 0) return true
    return [session.title, session.agent ?? "", session.modelLabel ?? ""].some((value) => value.toLowerCase().includes(needle))
  })
}

function sessionStatus(
  session: SessionInfoView,
  active: SessionView | undefined,
): RemoteSessionStatus {
  if (session.archived) return "archived"
  if (session.running === true) return "running"
  if (active !== undefined && active.status === "running") return "running"
  if (session.failed === true) return "failed"
  return "idle"
}
