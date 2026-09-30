import type {
  OfficeActor,
  OfficeActivity,
  OfficeCue,
  OfficeInput,
  OfficePreferences,
  OfficeRoomID,
  OfficeSnapshot,
  OfficeStatus,
  SelectedSession,
  SessionSummary,
  TeamMember,
} from "./types"

export const maxOfficeActors = 16

export function officeInputsSettled(snapshot: OfficeSnapshot): boolean {
  if (snapshot.connection !== "ready") return true
  if (snapshot.team.status === "loading") return false
  return snapshot.team.status !== "ready" || snapshot.activityStatus !== "loading"
}

export function officeHydrating(snapshot: OfficeSnapshot, placedActors: number): boolean {
  return placedActors === 0 && !officeInputsSettled(snapshot)
}

export function officeLocationLabel(room: OfficeRoomID | undefined): string {
  const labels: Record<OfficeRoomID, string> = {
    block: "Agent block", lounge: "Relax area", hall: "Open floor",
  }
  return room ? labels[room] : "Entrance"
}

export function shortText(text: string, limit: number): string {
  const normalized = text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
  const points = Array.from(normalized)
  return points.length <= limit ? normalized : `${points.slice(0, Math.max(0, limit - 1)).join("")}…`
}

export function projectOffice(input: OfficeInput, preferences: OfficePreferences): OfficeSnapshot {
  if (!input.ownerID || !input.deviceID || !input.activeSessionID) {
    return { scope: "", connection: "unavailable", actors: [], totalSessions: 0, overflow: 0, activityStatus: "loading", team: { status: "none", total: 0, shown: 0, more: false }, cues: [] }
  }
  const deviceID = input.deviceID
  const team = input.team
  const rootID = team?.rootID ?? input.activeSessionID
  const members = team?.status === "ready"
    ? [...new Map(team.members.filter((member) => member.parentID === rootID).map((member) => [member.sessionID, member])).values()]
      .sort((a, b) => a.sessionID.localeCompare(b.sessionID))
    : []
  const session = input.sessions.find((item) => item.id === rootID && !item.archived)
    ?? { id: rootID, title: rootID === input.activeSessionID ? "Current session" : "Parent session", agent: input.selected?.id === rootID ? input.selected.agent : undefined, archived: false }
  const actorID = (sessionID: string) => JSON.stringify([deviceID, sessionID])
  const selected = [
    sessionActor(input, preferences, session, actorID(rootID)),
    ...members.map((member) => taskActor(input, preferences, member, actorID(member.sessionID))),
  ]
    .sort((a, b) => Number(b.selected) - Number(a.selected))
    .slice(0, maxOfficeActors)
  const used = new Set<string>()
  const names = new Map(selected.map((actor) => [actor.id, actor] as const).sort((a, b) => a[0].localeCompare(b[0])).map(([id, actor]) => {
    const hash = Array.from(actor.sessionID).reduce((value, character) => (value * 31 + character.codePointAt(0)!) >>> 0, 7)
    const first = ["Ari", "Mira", "Noah", "Lena", "Theo", "Iris", "Juno", "Ezra", "Nia", "Owen", "Sage", "Ravi", "Zara", "Milo", "Ada", "Leah"][hash % 16]!
    const last = ["Vale", "Rowan", "Ellis", "Hale", "Briar", "Stone", "River", "Wells", "Cedar", "Reed", "Bloom", "Wren", "Mason", "Dove", "Klein", "Frost"][Math.floor(hash / 16) % 16]!
    const base = `${first} ${last}`
    const suffix = Array.from({ length: maxOfficeActors }, (_, index) => index + 1).find((value) => !used.has(value === 1 ? base : `${base} ${value}`))!
    const name = suffix === 1 ? base : `${base} ${suffix}`
    used.add(name)
    return [id, name] as const
  }))
  const actors = selected.map((actor) => ({ ...actor, name: names.get(actor.id)! }))
  const root = actors.find((actor) => actor.kind === "session" && actor.sessionID === rootID)
  const total = 1 + members.length
  return {
    scope: JSON.stringify([input.ownerID, deviceID, rootID]),
    connection: input.connection,
    actors,
    totalSessions: total,
    overflow: total - actors.length,
    activityStatus: input.familyActivity?.status ?? "loading",
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
  const member = familyMember(input, session.id)
  const status = statusFor(input.connection, member, detail)
  const source = sourceFor(input, member)
  const activity = roomActivity(member, status)
  const label = memberLabel(member, status)
  return {
    id,
    sessionID: session.id,
    kind: "session",
    name: "",
    role: shortText(detail?.agent ?? session.agent ?? "Agent", 28),
    title: shortText(session.title, 70),
    selected: session.id === input.activeSessionID,
    status,
    statusText: label,
    source,
    bubble: bubbleFor(preferences, status, label),
    unknownOutcome: detail?.unknownOutcome ?? false,
    activity,
  }
}

function taskActor(input: OfficeInput, preferences: OfficePreferences, member: TeamMember, id: string): OfficeActor {
  const detail = liveDetail(input, member.sessionID)
  const current = familyMember(input, member.sessionID)
  const status = ["completed", "cancelled", "lost"].includes(member.state) ? "idle" : statusFor(input.connection, current, detail, member.state === "waiting", member.state === "failed")
  const source = sourceFor(input, current)
  const activity = roomActivity(current, status)
  const statusText = memberLabel(current, status)
  return {
    id,
    sessionID: member.sessionID,
    kind: "task",
    name: "",
    role: shortText(detail?.agent ?? member.agent ?? "Subagent", 28),
    title: shortText(member.description || "Subagent task", 70),
    selected: member.sessionID === input.activeSessionID,
    status,
    statusText,
    source,
    bubble: bubbleFor(preferences, status, statusText),
    unknownOutcome: detail?.unknownOutcome ?? false,
    activity,
    teamRootSessionID: member.parentID,
    taskState: member.state,
  }
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

function familyMember(input: OfficeInput, sessionID: string) {
  return input.familyActivity?.status === "ready" ? input.familyActivity.members.find((member) => member.sessionID === sessionID) : undefined
}

function sourceFor(input: OfficeInput, member: ReturnType<typeof familyMember>): OfficeActor["source"] {
  if (input.connection !== "ready") return "unavailable"
  return member ? "projection" : "summary"
}

function bubbleFor(preferences: OfficePreferences, status: OfficeStatus, label: string) {
  return preferences.bubbles !== "off" && status !== "idle" && status !== "unknown" && label ? label : undefined
}

function statusFor(connection: OfficeInput["connection"], member: ReturnType<typeof familyMember>, detail?: SelectedSession, waiting = false, failed = false): OfficeStatus {
  if (connection === "offline") return "offline"
  if (connection === "reconnecting") return "reconnecting"
  if (connection !== "ready") return "unknown"
  if ((detail?.requestCount ?? 0) > 0 || waiting) return "attention"
  if (failed || detail?.status === "failed") return "failed"
  if (detail?.status === "interrupted") return "interrupted"
  if (!member) return "unknown"
  if (!member.executing) return "idle"
  if (detail?.compacting) return "compacting"
  return member.activity?.kind === "thinking" ? "thinking" : member.activity?.kind === "tool" ? "tool" : "working"
}

function roomActivity(member: ReturnType<typeof familyMember>, status: OfficeStatus): OfficeActivity | undefined {
  if (status === "idle" || status === "unknown") return undefined
  if (status === "attention" || status === "compacting" || member?.activity?.kind === "thinking") return "hold"
  const rooms = { research: "research", qa: "verify", meeting: "coordinate", developer: "implement", hold: "hold" } as const
  return member?.activity ? rooms[member.activity.room] : undefined
}

function memberLabel(member: ReturnType<typeof familyMember>, status: OfficeStatus): string {
  if (status === "idle" || status === "unknown") return ""
  if (status === "attention") return "Needs your decision"
  if (status === "failed") return "Session failed"
  if (status === "interrupted") return "Interrupted"
  if (status === "compacting") return "Compacting context"
  if (status === "offline") return "Machine offline"
  if (status === "reconnecting") return "Reconnecting"
  return member?.activity?.text ?? "Preparing next step"
}
