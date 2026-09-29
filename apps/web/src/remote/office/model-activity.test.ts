import { expect, test } from "bun:test"
import { projectOffice } from "./model"
import { defaultOfficePreferences } from "./preferences"
import type { OfficeInput } from "./types"

test("reported task categories map to each agent's own block object independent of role", () => {
  const input: OfficeInput = {
    ownerID: "owner", deviceID: "device", connection: "ready", activeSessionID: "root",
    sessions: [{ id: "root", title: "Task", agent: "Researcher", archived: false }],
    team: { rootID: "root", status: "ready", more: false, cues: [], members: [
      { sessionID: "child", parentID: "root", description: "Review", agent: "Developer", state: "running" },
    ] },
    familyActivity: { status: "ready", members: [
      { sessionID: "root", executing: true, activity: { kind: "tool", room: "developer", text: "Editing file" } },
      { sessionID: "child", executing: true, activity: { kind: "tool", room: "qa", text: "Running tests" } },
    ] },
  }
  expect(projectOffice(input, defaultOfficePreferences).actors.map((actor) => [actor.sessionID, actor.activity])).toEqual([["root", "implement"], ["child", "verify"]])
  const changed = { ...input, familyActivity: { status: "ready" as const, members: [
    { sessionID: "root", executing: true, activity: { kind: "tool" as const, room: "research" as const, text: "Reading" } },
    { sessionID: "child", executing: true, activity: { kind: "tool" as const, room: "meeting" as const, text: "Coordinating" } },
  ] } }
  expect(projectOffice(changed, defaultOfficePreferences).actors.map((actor) => [actor.sessionID, actor.activity])).toEqual([["root", "research"], ["child", "coordinate"]])
})
