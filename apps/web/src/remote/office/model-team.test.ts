import { describe, expect, test } from "bun:test"
import { maxOfficeActors, projectOffice } from "./model"
import { defaultOfficePreferences } from "./preferences"
import type { OfficeInput, TeamInput, TeamMember } from "./types"

const member = (sessionID: string, state: TeamMember["state"], parentID = "ses_root"): TeamMember => ({
  sessionID,
  parentID,
  description: `Task ${sessionID}`,
  agent: "worker",
  state,
})

const ready = (members: readonly TeamMember[], cues: TeamInput["cues"] = [], total?: number): TeamInput => ({
  rootID: "ses_root",
  status: "ready",
  members,
  cues,
  more: false,
  ...(total === undefined ? {} : { total }),
})

function office(team: TeamInput | undefined, patch: Partial<OfficeInput> = {}) {
  return projectOffice({
    ownerID: "user_1",
    deviceID: "dev_1",
    connection: "ready",
    activeSessionID: "ses_root",
    sessions: [
      { id: "ses_root", title: "Root task", agent: "lead", archived: false, running: true },
      { id: "ses_child", title: "Child row", archived: false, running: true },
      { id: "ses_other", title: "Unrelated", archived: false, running: false },
    ],
    selected: { id: "ses_root", status: "running", requestCount: 0, compacting: false, thinking: false, unknownOutcome: false },
    team,
    familyActivity: { status: "ready", members: [
      { sessionID: "ses_root", executing: true, activity: { kind: "tool", room: "developer", text: "Editing app.ts" } },
      ...(team?.members ?? []).map((item) => ({ sessionID: item.sessionID, executing: ["starting", "running", "cancelling"].includes(item.state),
        ...(["starting", "running", "cancelling"].includes(item.state) ? { activity: { kind: "tool" as const, room: "developer" as const, text: "Editing app.ts" } } : {}) })),
    ] },
    ...patch,
  }, defaultOfficePreferences)
}

const actorID = (sessionID: string) => JSON.stringify(["dev_1", sessionID])

describe("office team projection", () => {
  test("an idle root stays in the Lounge while only its child executes a named action", () => {
    const snapshot = office(ready([member("ses_child", "running")]), { familyActivity: {
      status: "ready", members: [
        { sessionID: "ses_root", executing: false },
        { sessionID: "ses_child", executing: true, activity: { kind: "tool", room: "qa", text: "Running bun test ./src" } },
      ],
    } })
    expect(snapshot.actors.find((actor) => actor.kind === "session")).toMatchObject({ status: "idle", bubble: undefined, activity: undefined })
    expect(snapshot.actors.find((actor) => actor.kind === "task")).toMatchObject({ status: "tool", statusText: "Running bun test ./src", bubble: "Running bun test ./src", activity: "verify" })
  })
  test("retains the same member ids across ready refresh inputs", () => {
    const members = [member("ses_child", "running"), member("ses_new", "running")]
    const first = office(ready(members))
    const refreshed = office(ready(members.map((item) => ({ ...item }))))
    expect(refreshed.actors.map((actor) => actor.id)).toEqual(first.actors.map((actor) => actor.id))
    expect(refreshed.actors.filter((actor) => actor.kind === "task").map((actor) => actor.sessionID)).toEqual(["ses_child", "ses_new"])
  })
  test("shows each real child task of the team root once, with its reported state", () => {
    const snapshot = office(ready([member("ses_child", "running"), member("ses_done", "completed"), member("ses_foreign", "failed", "ses_other")], [], 2))
    expect(snapshot.actors.map((actor) => [actor.sessionID, actor.kind, actor.status, actor.statusText, actor.teamRootSessionID])).toEqual([
      ["ses_root", "session", "tool", "Editing app.ts", undefined],
      ["ses_child", "task", "tool", "Editing app.ts", "ses_root"],
      ["ses_done", "task", "idle", "", "ses_root"],
    ])
    expect(snapshot.team).toEqual({ status: "ready", rootActorID: actorID("ses_root"), total: 2, shown: 2, more: false })
    expect(snapshot.overflow).toBe(0)
  })

  test("labels every task state without inferring success and freezes it while offline", () => {
    const states = ["starting", "running", "waiting", "cancelling", "cancelled", "completed", "failed", "lost"] as const
    const snapshot = office(ready(states.map((state, index) => member(`ses_${index}`, state))))
    expect(snapshot.actors.filter((actor) => actor.kind === "task").map((actor) => [actor.taskState, actor.status, actor.statusText, actor.source])).toEqual([
      ["starting", "tool", "Editing app.ts", "projection"],
      ["running", "tool", "Editing app.ts", "projection"],
      ["waiting", "attention", "Needs your decision", "projection"],
      ["cancelling", "tool", "Editing app.ts", "projection"],
      ["cancelled", "idle", "", "projection"],
      ["completed", "idle", "", "projection"],
      ["failed", "failed", "Session failed", "projection"],
      ["lost", "idle", "", "projection"],
    ])
    const offline = office(ready([member("ses_child", "running")]), { connection: "offline" })
    expect(offline.actors.find((actor) => actor.kind === "task")).toMatchObject({ status: "offline", statusText: "Machine offline", source: "unavailable" })
  })

  test("animates only cues whose child is a resident task of the shown root", () => {
    const cues: TeamInput["cues"] = [
      { id: "cue_1", kind: "delegated", childID: "ses_child" },
      { id: "cue_2", kind: "reported", childID: "ses_done", outcome: "completed" },
      { id: "cue_3", kind: "delegated", childID: "ses_unknown" },
    ]
    expect(office(ready([member("ses_child", "running"), member("ses_done", "completed")], cues)).cues).toEqual([
      { id: "cue_1", kind: "delegate", fromActorID: actorID("ses_root"), toActorID: actorID("ses_child") },
      { id: "cue_2", kind: "report", fromActorID: actorID("ses_done"), toActorID: actorID("ses_root"), outcome: "completed" },
    ])
    expect(office(ready([member("ses_child", "running")], cues), { connection: "offline" }).cues).toEqual([])

    const unsupported = office({ rootID: "ses_root", status: "unsupported", members: [], cues, more: false })
    expect(unsupported.team).toEqual({ status: "unsupported", rootActorID: actorID("ses_root"), total: 0, shown: 0, more: false })
    expect(unsupported.cues).toEqual([])
    expect(unsupported.actors.map((actor) => actor.sessionID)).toEqual(["ses_root"])
    expect(office(undefined).team).toEqual({ status: "none", rootActorID: actorID("ses_root"), total: 0, shown: 0, more: false })
  })

  test("keeps a selected child live and anchors it to its parent when the page window lists neither", () => {
    const snapshot = office(ready([member("ses_child", "running")]), {
      activeSessionID: "ses_child",
      sessions: [{ id: "ses_child", title: "Child row", archived: false }],
      selected: { id: "ses_child", status: "running", requestCount: 1, compacting: false, thinking: false, unknownOutcome: false },
    })
    expect(snapshot.actors.map((actor) => [actor.sessionID, actor.kind, actor.selected, actor.statusText, actor.title])).toEqual([
      ["ses_child", "task", true, "Needs your decision", "Task ses_child"],
      ["ses_root", "session", false, "Editing app.ts", "Parent session"],
    ])
    expect(snapshot.team.rootActorID).toBe(actorID("ses_root"))
  })

  test("counts task actors toward the canvas cap after the selection and its root", () => {
    const sessions = Array.from({ length: 20 }, (_, index) => ({ id: `ses_s${String(index).padStart(2, "0")}`, title: `Session ${index}`, archived: false }))
    const members = Array.from({ length: 20 }, (_, index) => member(`ses_t${String(index).padStart(2, "0")}`, "running"))
    const snapshot = office(ready(members, [], 5), { sessions: [{ id: "ses_root", title: "Root", archived: false }, ...sessions] })
    expect(snapshot.actors).toHaveLength(maxOfficeActors)
    expect(snapshot.actors.map((actor) => actor.sessionID)).toEqual(["ses_root", ...Array.from({ length: maxOfficeActors - 1 }, (_, index) => `ses_t${String(index).padStart(2, "0")}`)])
    expect(snapshot.overflow).toBe(21 - maxOfficeActors)
    expect(snapshot.team.shown).toBe(maxOfficeActors - 1)
  })

  test("each member's own activity outranks family coordination, while thinking holds its current room", () => {
    const members = [member("ses_child", "running")]
    const coordinating = office(ready(members))
    expect(coordinating.actors.find((actor) => actor.kind === "session")?.activity).toBe("implement")
    const researching = office(ready(members), { familyActivity: { status: "ready", members: [
      { sessionID: "ses_root", executing: true, activity: { kind: "tool", room: "research", text: "Reading store.ts" } },
      { sessionID: "ses_child", executing: true, activity: { kind: "tool", room: "qa", text: "Running bun test" } },
    ] } })
    expect(researching.actors.find((actor) => actor.kind === "session")?.activity).toBe("research")
    expect(researching.actors.find((actor) => actor.kind === "task")?.activity).toBe("verify")
    const thinking = office(ready(members), { familyActivity: { status: "ready", members: [
      { sessionID: "ses_root", executing: true, activity: { kind: "thinking", room: "hold", text: "Thinking" } },
      { sessionID: "ses_child", executing: false },
    ] } })
    expect(thinking.actors.find((actor) => actor.kind === "session")?.activity).toBe("hold")
    expect(thinking.actors.find((actor) => actor.kind === "task")?.bubble).toBeUndefined()
  })
})
