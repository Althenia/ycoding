import { modelLabel, type SessionView } from "../projection"
import type { SessionInfoView } from "../store"
import type { RemoteTransportStatus } from "../transport"
import {
  connectionBanner,
  sessionStateChips,
  summarizeConnection,
  type ConnectionTone,
  type RemoteConnectionState,
  type RemoteSessionStatus,
  type RemoteSessionSummary,
  type SessionChip,
} from "../view-model"

export const views = ["/remote", "/remote/sessions", "/remote/session", "/remote/usage", "/remote/settings"] as const

export type RemoteView = (typeof views)[number]

/** The rail and composer belong only to an active conversation, never every remote screen. */
export function remoteSurfaceComposition(path: RemoteView, hasSession: boolean) {
  const selectedConversation = path === "/remote/session" && hasSession
  return { showSessionRail: selectedConversation, showComposer: selectedConversation }
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
export function summarizeSession(session: SessionInfoView, view: SessionView | undefined): RemoteSessionSummary {
  const active = view !== undefined && view.id === session.id ? view : undefined
  const autonomy = active?.autonomy
  const model = modelLabel(active?.model) ?? session.modelLabel
  return {
    id: session.id,
    title: session.title,
    status: sessionStatus(session, active),
    ...(session.pinnedAt === undefined ? {} : { pinned: true }),
    agent: active?.agent ?? session.agent,
    model,
    autonomy: autonomy?.mode,
    yoloLevel: autonomy?.yolo,
    guardrailsEnforced: autonomy === undefined ? undefined : autonomy.mode !== "yolo" || autonomy.yolo < 3,
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
  if (session.attention === true) return true
  return view !== undefined && view.id === session.id && view.requests.length > 0
}

/**
 * The chips one session row and the selected session's header row show: the status the
 * device reported, plus the fact that the loaded view is holding an unanswered approval.
 */
export function sessionChips(session: SessionInfoView, view: SessionView | undefined): readonly SessionChip[] {
  const chips = sessionStateChips(summarizeSession(session, view))
  if (awaitsApproval(view, session.id)) return [{ label: "Waiting for approval", tone: "attention" }, ...chips]
  if (sessionNeedsAttention(session, view)) return [{ label: "Waiting for you", tone: "attention" }, ...chips]
  return chips
}

/**
 * The client-side session filter. It reads the sessions the workspace already holds and
 * issues no request, so an empty result means the filter matched nothing rather than that
 * the device advertises nothing. Pinned sessions come first, in pin order.
 */
export type SessionFilter = "all" | "running" | "idle"

export function filterSessions(
  sessions: readonly SessionInfoView[],
  query: string,
  filter: SessionFilter = "all",
): readonly SessionInfoView[] {
  const needle = query.trim().toLowerCase()
  const pinned = sessions
    .filter((session) => session.pinnedAt !== undefined)
    .toSorted((left, right) => left.pinnedAt! - right.pinnedAt!)
  return [...pinned, ...sessions.filter((session) => session.pinnedAt === undefined)].filter((session) => {
    if (filter === "running" && session.running !== true) return false
    if (filter === "idle" && (session.running === true || session.archived)) return false
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
