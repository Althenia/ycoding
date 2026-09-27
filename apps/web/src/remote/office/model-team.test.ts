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
    ...patch,
  }, defaultOfficePreferences)
}

const actorID = (sessionID: string) => JSON.stringify(["dev_1", sessionID])

describe("office team projection", () => {
  test("shows each real child task of the team root once, with its reported state", () => {
    const snapshot = office(ready([member("ses_child", "running"), member("ses_done", "completed"), member("ses_foreign", "failed", "ses_other")], [], 2))
    expect(snapshot.actors.map((actor) => [actor.sessionID, actor.kind, actor.status, actor.statusText, actor.teamRootSessionID])).toEqual([
      ["ses_root", "session", "working", "Working", undefined],
      ["ses_child", "task", "working", "Running", "ses_root"],
      ["ses_done", "task", "idle", "Completed", "ses_root"],
      ["ses_other", "session", "idle", "Last reported: idle", undefined],
    ])
    expect(snapshot.team).toEqual({ status: "ready", rootActorID: actorID("ses_root"), total: 2, shown: 2, more: false })
    expect(snapshot.overflow).toBe(0)
  })

  test("labels every task state without inferring success and freezes it while offline", () => {
    const states = ["starting", "running", "waiting", "cancelling", "cancelled", "completed", "failed", "lost"] as const
    const snapshot = office(ready(states.map((state, index) => member(`ses_${index}`, state))))
    expect(snapshot.actors.filter((actor) => actor.kind === "task").map((actor) => [actor.taskState, actor.status, actor.statusText, actor.source])).toEqual([
      ["starting", "working", "Starting", "summary"],
      ["running", "working", "Running", "summary"],
      ["waiting", "attention", "Waiting for a reply", "summary"],
      ["cancelling", "working", "Cancelling", "summary"],
      ["cancelled", "idle", "Cancelled", "summary"],
      ["completed", "idle", "Completed", "summary"],
      ["failed", "failed", "Failed", "summary"],
      ["lost", "idle", "Lost", "summary"],
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
    expect(unsupported.team).toEqual({ status: "unsupported", rootActorID: undefined, total: 0, shown: 0, more: false })
    expect(unsupported.cues).toEqual([])
    expect(unsupported.actors.find((actor) => actor.sessionID === "ses_child")).toMatchObject({ kind: "session", statusText: "Last reported: running" })
    expect(office(undefined).team).toEqual({ status: "none", rootActorID: undefined, total: 0, shown: 0, more: false })
  })

  test("keeps a selected child live and anchors it to its parent when the page window lists neither", () => {
    const snapshot = office(ready([member("ses_child", "running")]), {
      activeSessionID: "ses_child",
      sessions: [{ id: "ses_child", title: "Child row", archived: false }],
      selected: { id: "ses_child", status: "running", requestCount: 1, compacting: false, thinking: false, unknownOutcome: false },
    })
    expect(snapshot.actors.map((actor) => [actor.sessionID, actor.kind, actor.selected, actor.statusText, actor.title])).toEqual([
      ["ses_child", "task", true, "Needs your reply", "Task ses_child"],
      ["ses_root", "session", false, "Activity not reported", "Parent session"],
    ])
    expect(snapshot.team.rootActorID).toBe(actorID("ses_root"))
  })

  test("counts task actors toward the canvas cap after the selection and its root", () => {
    const sessions = Array.from({ length: 20 }, (_, index) => ({ id: `ses_s${String(index).padStart(2, "0")}`, title: `Session ${index}`, archived: false }))
    const members = Array.from({ length: 5 }, (_, index) => member(`ses_t${index}`, "running"))
    const snapshot = office(ready(members, [], 5), { sessions: [{ id: "ses_root", title: "Root", archived: false }, ...sessions] })
    expect(snapshot.actors).toHaveLength(maxOfficeActors)
    expect(snapshot.actors.slice(0, 6).map((actor) => actor.sessionID)).toEqual(["ses_root", "ses_t0", "ses_t1", "ses_t2", "ses_t3", "ses_t4"])
    expect(snapshot.overflow).toBe(21 + 5 - maxOfficeActors)
    expect(snapshot.team.shown).toBe(5)
  })
})
