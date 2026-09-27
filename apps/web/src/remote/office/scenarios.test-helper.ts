import type { OfficeInput } from "./types"

export function scenario(kind: string): OfficeInput {
  const base: OfficeInput = {
    ownerID: "fixture-owner", deviceID: "fixture-device", connection: "ready", activeSessionID: "session-a",
    sessions: [
      { id: "session-a", title: "Example repository task", agent: "Developer", archived: false, running: true },
      { id: "session-b", title: "Another recorded session", agent: "Reviewer", archived: false },
      { id: "session-c", title: "Previously idle session", agent: "Planner", archived: false, running: false },
    ],
    selected: { id: "session-a", status: "running", requestCount: 0, compacting: false, thinking: false, unknownOutcome: false },
    familyActivity: { status: "ready", members: [{ sessionID: "session-a", executing: !["idle", "failed", "interrupted"].includes(kind),
      ...(["idle", "failed", "interrupted"].includes(kind) ? {} : { activity: kind === "thinking" ? { kind: "thinking", room: "hold", text: "Thinking" } as const
        : { kind: "tool", room: "developer", text: "Editing app.ts" } as const }) }] },
  }
  if (kind === "empty") return { ...base, sessions: [], activeSessionID: undefined, selected: undefined }
  if (kind === "signed-out") return { connection: "unavailable", sessions: [] }
  if (kind === "offline") return { ...base, connection: "offline" }
  if (kind === "reconnecting") return { ...base, connection: "reconnecting" }
  if (kind === "overflow") return { ...base, sessions: Array.from({ length: 40 }, (_, i) => ({ id: i === 0 ? "session-a" : `session-${i}`, title: `Synthetic session ${i}`, archived: false })) }
  const selected = base.selected!
  if (kind === "attention") return { ...base, selected: { ...selected, requestCount: 1 } }
  if (kind === "compacting") return { ...base, selected: { ...selected, compacting: true } }
  if (kind === "tool") return { ...base, selected: { ...selected, activeTool: "shell", activity: "implement" } }
  if (kind === "thinking") return { ...base, selected: { ...selected, thinking: true } }
  if (kind === "failed") return { ...base, selected: { ...selected, status: "failed" } }
  if (kind === "interrupted") return { ...base, selected: { ...selected, status: "interrupted" } }
  if (kind === "unknown-outcome") return { ...base, selected: { ...selected, unknownOutcome: true } }
  if (kind === "idle") return { ...base, sessions: base.sessions.map((session) => session.id === "session-a" ? { ...session, running: false } : session), selected: { ...selected, status: "idle", assistantExcerpt: "Example task finished. This is synthetic text, not a live agent result." } }
  return base
}
