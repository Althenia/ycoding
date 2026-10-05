import { describe, expect, test } from "bun:test"
import { createSessionView, type AssistantPart, type RemoteMessageView, type SessionView } from "../projection"
import type { PendingMutation, RemoteStoreState, SessionInfoView } from "../store"
import { officeInputFromRemote } from "./adapter"
import { projectOffice } from "./model"
import { defaultOfficePreferences } from "./preferences"

const session = (id: string, patch: Partial<SessionInfoView> = {}): SessionInfoView => ({
  id,
  title: `Title ${id}`,
  updatedAt: 1,
  archived: false,
  ...patch,
})

function remoteState(patch: Partial<RemoteStoreState> = {}): RemoteStoreState {
  return {
    connection: { kind: "connected", deviceName: "Studio Mac" },
    owner: { id: "user_1", expiresAt: 4_102_444_800_000 },
    devices: [],
    activeDeviceID: "dev_1",
    advertised: [],
    sessions: [session("ses_a", { agent: "build", running: true }), session("ses_b", { running: false })],
    sessionGroups: [],
    sessionQuery: "",
    sessionFilter: "all",
    sessionListStatus: "ready",
    sessionPageLoading: false,
    sessionHasNext: false,
    sessionHasPrevious: false,
    drafts: {},
    catalogs: {},
    generation: 0,
    transport: { kind: "open" },
    latencySync: "idle",
    mutations: [],
    notifications: [],
    noticeSync: { status: "idle", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: undefined },
    unhandledEvents: 0,
    teamCues: [],
    ...patch,
  }
}

const assistant = (id: string, parts: readonly AssistantPart[], completed?: number): RemoteMessageView => ({
  kind: "assistant",
  id,
  parts,
  created: 1,
  ...(completed === undefined ? {} : { completed }),
})

const tool = (name: string, status: "streaming" | "running" | "completed" | "failed"): AssistantPart => ({
  kind: "tool",
  callID: `call_${name}`,
  name,
  status,
  content: [],
})

function selectedView(id: string, messages: readonly RemoteMessageView[], patch: Partial<SessionView> = {}): SessionView {
  return { ...createSessionView(id), status: "running", messages, ...patch }
}

function selected(patch: Partial<RemoteStoreState>) {
  return officeInputFromRemote(remoteState({ activeSessionID: "ses_a", ...patch })).selected
}

const mutation = (sessionID: string, state: PendingMutation["state"]): PendingMutation => ({
  id: `mut_${sessionID}_${state}`,
  kind: "prompt",
  label: "Prompt",
  state,
  sessionID,
  operation: "session.prompt",
  input: {},
})

describe("office adapter", () => {
  test("reports live detail only for the view that belongs to the active Session", () => {
    expect(selected({ view: selectedView("ses_b", []) })).toBeUndefined()
    expect(selected({ view: selectedView("ses_a", [], { agent: "build" }) })).toMatchObject({
      id: "ses_a",
      status: "running",
      agent: "build",
      requestCount: 0,
      compacting: false,
      thinking: false,
      unknownOutcome: false,
    })
  })

  test("names the running tool, streaming reasoning, and active compaction from current state", () => {
    const running = selected({ view: selectedView("ses_a", [assistant("msg_1", [{ kind: "reasoning", ordinal: 0, text: "plan" }, tool("bash", "running")])]) })
    expect(running).toMatchObject({ activeTool: "bash", thinking: false })

    expect(selected({ view: selectedView("ses_a", [assistant("msg_1", [tool("read", "completed")])]) })?.activeTool).toBeUndefined()
    expect(selected({ view: selectedView("ses_a", [assistant("msg_1", [{ kind: "text", ordinal: 0, text: "Hi" }, { kind: "reasoning", ordinal: 1, text: "…" }])]) })?.thinking).toBe(true)
    expect(selected({ view: selectedView("ses_a", [assistant("msg_1", [{ kind: "reasoning", ordinal: 0, text: "…" }, { kind: "text", ordinal: 1, text: "Answer" }])]) })?.thinking).toBe(false)
    expect(selected({ view: selectedView("ses_a", [{ kind: "compaction", id: "cmp_1", status: "running" }]) })?.compacting).toBe(true)
    expect(selected({ view: selectedView("ses_a", [{ kind: "compaction", id: "cmp_1", status: "failed" }]) })?.compacting).toBe(false)
  })

  test("classifies the projected running tool and shell command without inferring from transcript text", () => {
    const activity = (name: string, command?: string) => selected({
      view: selectedView("ses_a", [assistant("msg_tool", [{ ...tool(name, "running"), ...(command === undefined ? {} : { input: { command } }) }])]),
    })?.activity
    expect(activity("read")).toBe("research")
    expect(activity("grep")).toBe("research")
    expect(activity("subagent_control")).toBe("coordinate")
    expect(activity("todowrite")).toBe("coordinate")
    expect(activity("patch")).toBe("implement")
    expect(activity("shell", "bun test ./src")).toBe("verify")
    expect(activity("shell", "bun run typecheck && bun run lint")).toBe("verify")
    expect(activity("shell", "rg -n foo src")).toBe("research")
    expect(activity("shell", "bun run build")).toBe("implement")
    expect(activity("shell")).toBe("implement")
  })

  test("takes the excerpt from the latest completed assistant text only", () => {
    const messages = [
      assistant("msg_1", [{ kind: "reasoning", ordinal: 0, text: "private chain" }, tool("bash", "completed"), { kind: "text", ordinal: 2, text: "Tests pass." }], 5),
      assistant("msg_2", [{ kind: "text", ordinal: 0, text: "Still streaming" }]),
    ]
    const excerpt = selected({ view: selectedView("ses_a", messages, { status: "idle" }) })?.assistantExcerpt
    expect(excerpt).toBe("Tests pass.")
    expect(selected({ view: selectedView("ses_a", [assistant("msg_1", [tool("bash", "completed")], 5)]) })?.assistantExcerpt).toBeUndefined()
  })

  test("flags an unknown mutation outcome only for the selected Session", () => {
    const view = selectedView("ses_a", [])
    expect(selected({ view, mutations: [mutation("ses_a", "unknown")] })?.unknownOutcome).toBe(true)
    expect(selected({ view, mutations: [mutation("ses_b", "unknown"), mutation("ses_a", "sending")] })?.unknownOutcome).toBe(false)
  })

  test("keeps the active Session when the grouped page window does not list it", () => {
    const outside = officeInputFromRemote(remoteState({ activeSessionID: "ses_z", selectedSessionInfo: session("ses_z", { title: "Elsewhere" }) }))
    expect(outside.sessions.map((item) => item.id)).toEqual(["ses_z", "ses_a", "ses_b"])
    const listed = officeInputFromRemote(remoteState({ activeSessionID: "ses_a", selectedSessionInfo: session("ses_a") }))
    expect(listed.sessions.map((item) => item.id)).toEqual(["ses_a", "ses_b"])
  })

  test("does not turn listed child Sessions into Office actors without a team report", () => {
    const input = officeInputFromRemote(remoteState({
      activeSessionID: "ses_a",
      sessions: [session("ses_a", { agent: "build" }), session("ses_c", { parentID: "ses_a", agent: "code-reviewer" })],
    }))
    expect(input.sessions.map((item) => [item.id, item.parentID])).toEqual([["ses_a", undefined], ["ses_c", "ses_a"]])
    expect(projectOffice(input, defaultOfficePreferences).actors.map((actor) => actor.sessionID))
      .toEqual(["ses_a"])
  })

  test("a selected Session whose team has not been read yet is loading, never an empty team", () => {
    const root = officeInputFromRemote(remoteState({ activeSessionID: "ses_a", selectedSessionInfo: session("ses_a") }))
    expect(root.team).toEqual({ rootID: "ses_a", status: "loading", members: [], more: false, cues: [] })
    expect(projectOffice(root, defaultOfficePreferences).team.status).toBe("loading")
    const child = officeInputFromRemote(remoteState({ activeSessionID: "ses_c", selectedSessionInfo: session("ses_c", { parentID: "ses_a" }) }))
    expect(child.team?.rootID).toBe("ses_a")
    expect(child.team?.status).toBe("loading")
    expect(officeInputFromRemote(remoteState()).team).toBeUndefined()
  })

  test("maps connection state without claiming readiness it does not have", () => {
    expect(officeInputFromRemote(remoteState()).connection).toBe("ready")
    expect(officeInputFromRemote(remoteState({ connection: { kind: "offline", deviceName: "Studio Mac" } })).connection).toBe("offline")
    expect(officeInputFromRemote(remoteState({ transport: { kind: "reconnecting", attempt: 1, delayMs: 500 } })).connection).toBe("reconnecting")
    expect(officeInputFromRemote(remoteState({ connection: { kind: "connecting" }, transport: { kind: "connecting", attempt: 1 } })).connection).toBe("unavailable")
    expect(officeInputFromRemote(remoteState({ connection: { kind: "error", message: "failed" } })).connection).toBe("unavailable")
  })

  test("passes the resident team page and live cues through without inferring members", () => {
    const team: NonNullable<RemoteStoreState["team"]> = {
      rootID: "ses_a",
      status: "ready",
      tasks: [{ sessionID: "ses_c", parentID: "ses_a", description: "Fix flaky suite", agent: "worker", modelLabel: "openai/gpt-6", state: "running", revision: 2, updatedAt: 5 }],
      total: 3,
      next: "cursor_2",
      pageLoading: false,
      shells: [], shellStatus: "loading", sideChats: [], sideChatStatus: "loading", sideChatLoading: false,
    }
    const input = officeInputFromRemote(remoteState({ activeSessionID: "ses_a", team, teamCues: [{ id: "cue_1", kind: "delegated", childID: "ses_c" }] }))
    expect(input.team).toEqual({
      rootID: "ses_a",
      status: "ready",
      members: [{ sessionID: "ses_c", parentID: "ses_a", description: "Fix flaky suite", agent: "worker", state: "running" }],
      total: 3,
      more: true,
      cues: [{ id: "cue_1", kind: "delegated", childID: "ses_c" }],
    })
    expect(officeInputFromRemote(remoteState({ team: { ...team, next: undefined } })).team?.more).toBe(false)
    expect(officeInputFromRemote(remoteState()).team).toBeUndefined()
  })

  test("drives only the selected family actor from current state", () => {
    const snapshot = projectOffice(
      officeInputFromRemote(remoteState({ activeSessionID: "ses_a", view: selectedView("ses_a", [assistant("msg_1", [tool("bash", "running")])]),
        familyActivity: { rootID: "ses_a", status: "ready", members: [{ sessionID: "ses_a", executing: true, activity: { kind: "tool", room: "developer", text: "Editing app.ts" } }] } })),
      defaultOfficePreferences,
    )
    expect(snapshot.actors.map((actor) => [actor.sessionID, actor.status, actor.source, actor.bubble])).toEqual([
      ["ses_a", "tool", "projection", "Editing app.ts"],
    ])
  })
})
