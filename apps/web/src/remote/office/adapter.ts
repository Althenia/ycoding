import type { AssistantPart, RemoteMessageView } from "../projection"
import type { RemoteStoreState } from "../store"
import type { OfficeActivity, OfficeInput, SessionSummary } from "./types"

type AssistantMessage = Extract<RemoteMessageView, { kind: "assistant" }>

export function officeInputFromRemote(state: RemoteStoreState): OfficeInput {
  const view = state.view?.id === state.activeSessionID ? state.view : undefined
  const assistants = view?.messages.filter((message): message is AssistantMessage => message.kind === "assistant") ?? []
  const unfinished = assistants.findLast((message) => message.completed === undefined)
  const runningTool = unfinished?.parts.findLast(isActiveTool)
  const excerpt = assistants
    .findLast((message) => message.completed !== undefined)
    ?.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join(" ")
    .trim()
  return {
    ownerID: state.owner?.id,
    deviceID: state.activeDeviceID,
    connection: officeConnection(state),
    activeSessionID: state.activeSessionID,
    sessions: officeSessions(state),
    team: state.team && {
      rootID: state.team.rootID,
      status: state.team.status,
      members: state.team.tasks.map((task) => ({
        sessionID: task.sessionID,
        parentID: task.parentID,
        description: task.description,
        agent: task.agent,
        state: task.state,
      })),
      total: state.team.total,
      more: state.team.next !== undefined,
      cues: state.teamCues,
    },
    selected: view && {
      id: view.id,
      status: view.status,
      agent: view.agent,
      requestCount: view.requests.length,
      activeTool: runningTool?.name,
      activity: runningTool ? toolActivity(runningTool) : undefined,
      compacting: view.messages.some((message) => message.kind === "compaction" && (message.status === "pending" || message.status === "running")),
      thinking: unfinished?.parts.at(-1)?.kind === "reasoning",
      assistantExcerpt: excerpt || undefined,
      unknownOutcome: state.mutations.some((mutation) => mutation.sessionID === view.id && mutation.state === "unknown"),
    },
  }
}

function officeConnection(state: RemoteStoreState): OfficeInput["connection"] {
  if (state.connection.kind === "offline") return "offline"
  if (state.transport.kind === "reconnecting") return "reconnecting"
  if (state.connection.kind === "connected" && state.transport.kind === "open") return "ready"
  return "unavailable"
}

function officeSessions(state: RemoteStoreState): readonly SessionSummary[] {
  const active = state.selectedSessionInfo
  const listed = active === undefined || state.sessions.some((session) => session.id === active.id)
    ? state.sessions
    : [active, ...state.sessions]
  return listed.map((session) => ({
    id: session.id,
    parentID: session.parentID,
    title: session.title,
    agent: session.agent,
    archived: session.archived,
    running: session.running,
  }))
}

function isActiveTool(part: AssistantPart): part is Extract<AssistantPart, { kind: "tool" }> {
  return part.kind === "tool" && (part.status === "streaming" || part.status === "running")
}

function toolActivity(part: Extract<AssistantPart, { kind: "tool" }>): OfficeActivity {
  if (["read", "grep", "glob", "webfetch", "websearch"].includes(part.name)) return "research"
  if (["subagent", "subagent_control", "subagent_report", "todowrite"].includes(part.name)) return "coordinate"
  if (part.name !== "shell") return "implement"
  const command = typeof part.input?.command === "string" ? part.input.command : ""
  if (/\b(?:test|typecheck|lint|pytest|vitest|jest|tsc|eslint|oxlint)\b/i.test(command)) return "verify"
  if (/\b(?:rg|grep|find|ls|cat|git\s+status)\b/i.test(command)) return "research"
  return "implement"
}
