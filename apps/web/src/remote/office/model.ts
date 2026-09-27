import type {
  OfficeActor,
  OfficeCue,
  OfficeHomeRoom,
  OfficeInput,
  OfficePreferences,
  OfficeSnapshot,
  OfficeStatus,
  SelectedSession,
  SessionSummary,
  TaskState,
  TeamMember,
} from "./types"

export const maxOfficeActors = 16

export const homeRoomLabel: Record<OfficeHomeRoom, string> = {
  ceo: "CEO office",
  developer: "Developer room",
  research: "Research lab",
  qa: "QA lab",
}

export function shortText(text: string, limit: number): string {
  const normalized = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  const points = Array.from(normalized)
  return points.length <= limit ? normalized : `${points.slice(0, Math.max(0, limit - 1)).join("")}…`
}

export function projectOffice(input: OfficeInput, preferences: OfficePreferences): OfficeSnapshot {
  if (!input.ownerID || !input.deviceID) {
    return { scope: "", connection: "unavailable", actors: [], totalSessions: 0, overflow: 0, team: { status: "none", total: 0, shown: 0, more: false }, cues: [] }
  }
  const deviceID = input.deviceID
  const team = input.team
  const members = team?.status === "ready"
    ? [...new Map(team.members.filter((member) => member.parentID === team.rootID).map((member) => [member.sessionID, member])).values()]
      .sort((a, b) => a.sessionID.localeCompare(b.sessionID))
    : []
  const memberIDs = new Set(members.map((member) => member.sessionID))
  const unique = new Map(input.sessions.filter((item) => !item.archived && !memberIDs.has(item.id)).map((item) => [item.id, item]))
  if (team && members.length > 0 && !unique.has(team.rootID)) unique.set(team.rootID, { id: team.rootID, title: "Parent session", archived: false })
  const sessions = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
  const actorID = (sessionID: string) => JSON.stringify([deviceID, sessionID])
  const rank = (actor: OfficeActor) =>
    actor.selected ? 0 : actor.sessionID === team?.rootID && members.length > 0 ? 1 : actor.kind === "task" ? 2 : 3
  const actors = [
    ...sessions.map((session) => sessionActor(input, preferences, session, actorID(session.id))),
    ...members.map((member) => taskActor(input, preferences, member, actorID(member.sessionID))),
  ]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, maxOfficeActors)
  const root = team && members.length > 0 ? actors.find((actor) => actor.kind === "session" && actor.sessionID === team.rootID) : undefined
  const total = sessions.length + members.length
  return {
    scope: JSON.stringify([input.ownerID, deviceID]),
    connection: input.connection,
    actors,
    totalSessions: total,
    overflow: total - actors.length,
    team: {
      status: team?.status ?? "none",
      rootActorID: root?.id,
      total: team?.status === "ready" ? team.total ?? members.length : 0,
      shown: actors.filter((actor) => actor.kind === "task").length,
      more: team?.status === "ready" && team.more,
    },
    cues: input.connection === "ready" && root ? corroboratedCues(input, actors, root) : [],
  }
}

function sessionActor(input: OfficeInput, preferences: OfficePreferences, session: SessionSummary, id: string): OfficeActor {
  const detail = liveDetail(input, session.id)
  const status = statusFor(input.connection, detail, session.running)
  const source = sourceFor(input, detail)
  return {
    id,
    sessionID: session.id,
    kind: "session",
    name: shortText(detail?.agent ?? session.agent ?? "Agent", 28),
    title: shortText(session.title, 70),
    selected: session.id === input.activeSessionID,
    status,
    statusText: statusLabel(status, source),
    source,
    bubble: bubbleFor(input, preferences, detail, status, statusLabel(status, source)),
    unknownOutcome: detail?.unknownOutcome ?? false,
    homeRoom: session.parentID === undefined ? "ceo" : responsibilityRoom(detail?.agent ?? session.agent, session.title),
  }
}

function taskActor(input: OfficeInput, preferences: OfficePreferences, member: TeamMember, id: string): OfficeActor {
  const detail = liveDetail(input, member.sessionID)
  const status = detail || input.connection !== "ready" ? statusFor(input.connection, detail, undefined) : taskStatus[member.state]
  const source = sourceFor(input, detail)
  const statusText = detail || input.connection !== "ready" ? statusLabel(status, source) : taskStateLabel[member.state]
  return {
    id,
    sessionID: member.sessionID,
    kind: "task",
    name: shortText(detail?.agent ?? member.agent ?? "Subagent", 28),
    title: shortText(member.description || "Subagent task", 70),
    selected: member.sessionID === input.activeSessionID,
    status,
    statusText,
    source,
    bubble: bubbleFor(input, preferences, detail, status, statusText),
    unknownOutcome: detail?.unknownOutcome ?? false,
    homeRoom: responsibilityRoom(detail?.agent ?? member.agent, member.description),
    teamRootSessionID: member.parentID,
    taskState: member.state,
  }
}

const qaWords = /\b(qa|test|tests|tester|testing|review|reviews|reviewer|reviewing|verify|verifier|verification|audit|auditor|auditing|validate|validator|validation)\b/i
const researchWords = /\b(research|researcher|researching|explore|explorer|exploring|exploration|investigate|investigator|investigating|investigation|analyze|analyse|analyzing|analysis|analyst|scout|survey|study|inspect|inspection|diagnose|diagnosis)\b/i

function responsibilityRoom(agent: string | undefined, task: string): OfficeHomeRoom {
  return responsibility(agent ?? "") ?? responsibility(task.trim().split(/\s+/).slice(0, 3).join(" ")) ?? "developer"
}

function responsibility(text: string): OfficeHomeRoom | undefined {
  const qa = text.search(qaWords)
  const research = text.search(researchWords)
  if (qa < 0 && research < 0) return undefined
  return research < 0 || (qa >= 0 && qa < research) ? "qa" : "research"
}

function corroboratedCues(input: OfficeInput, actors: readonly OfficeActor[], root: OfficeActor): readonly OfficeCue[] {
  const tasks = new Map(actors.filter((actor) => actor.kind === "task").map((actor) => [actor.sessionID, actor]))
  return (input.team?.cues ?? []).flatMap((cue): readonly OfficeCue[] => {
    const child = tasks.get(cue.childID)
    if (!child) return []
    return cue.kind === "delegated"
      ? [{ id: cue.id, kind: "delegate", fromActorID: root.id, toActorID: child.id }]
      : [{ id: cue.id, kind: "report", fromActorID: child.id, toActorID: root.id, outcome: cue.outcome }]
  })
}

function liveDetail(input: OfficeInput, sessionID: string): SelectedSession | undefined {
  return input.selected?.id === sessionID && input.activeSessionID === sessionID ? input.selected : undefined
}

function sourceFor(input: OfficeInput, detail: SelectedSession | undefined): OfficeActor["source"] {
  if (input.connection !== "ready") return "unavailable"
  return detail ? "projection" : "summary"
}

function bubbleFor(input: OfficeInput, preferences: OfficePreferences, detail: SelectedSession | undefined, status: OfficeStatus, label: string) {
  if (preferences.bubbles === "off") return undefined
  if (preferences.bubbles === "excerpt" && detail?.assistantExcerpt && input.connection === "ready" && status === "idle") return shortText(detail.assistantExcerpt, 90)
  return label
}

function statusFor(connection: OfficeInput["connection"], selected: SelectedSession | undefined, running: boolean | undefined): OfficeStatus {
  if (connection === "offline") return "offline"
  if (connection === "reconnecting") return "reconnecting"
  if (connection !== "ready") return "unknown"
  if (!selected) return running === undefined ? "unknown" : running ? "working" : "idle"
  if (selected.requestCount > 0) return "attention"
  if (selected.status === "failed") return "failed"
  if (selected.status === "interrupted") return "interrupted"
  if (selected.status === "idle") return "idle"
  if (selected.compacting) return "compacting"
  if (selected.activeTool) return "tool"
  if (selected.thinking) return "thinking"
  return "working"
}

const taskStatus: Record<TaskState, OfficeStatus> = {
  starting: "working",
  running: "working",
  waiting: "attention",
  cancelling: "working",
  cancelled: "idle",
  completed: "idle",
  failed: "failed",
  lost: "idle",
}

const taskStateLabel: Record<TaskState, string> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting for a reply",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
  completed: "Completed",
  failed: "Failed",
  lost: "Lost",
}

export function statusLabel(status: OfficeStatus, source: OfficeActor["source"]): string {
  if (source === "summary" && status === "working") return "Last reported: running"
  if (source === "summary" && status === "idle") return "Last reported: idle"
  const labels: Record<OfficeStatus, string> = {
    unknown: "Activity not reported", idle: "Idle", working: "Working", thinking: "Thinking",
    tool: "Running a tool", attention: "Needs your reply", compacting: "Compacting context",
    interrupted: "Interrupted", failed: "Session failed", offline: "Machine offline", reconnecting: "Reconnecting",
  }
  return labels[status]
}
