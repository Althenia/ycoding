import type { OfficeActor, OfficeSnapshot } from "./types"

export function actor(id: string, options: Partial<OfficeActor> = {}): OfficeActor {
  return {
    id, sessionID: id, kind: "session", name: id, role: "Developer", title: id,
    selected: false, status: "working", statusText: "Working", source: "projection",
    unknownOutcome: false, ...options,
  }
}

export function snapshot(actors: readonly OfficeActor[], options: Partial<OfficeSnapshot> = {}): OfficeSnapshot {
  return {
    scope: "scope-a", connection: "ready", actors, totalSessions: actors.length,
    activityStatus: "ready", overflow: 0,
    team: { status: "none", total: 0, shown: 0, more: false }, cues: [], ...options,
  }
}
