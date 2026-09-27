import { expect, test } from "bun:test"
import { projectOffice } from "./model"
import { defaultOfficePreferences } from "./preferences"
import { scenario } from "./scenarios.test-helper"
import type { TeamInput } from "./types"

const team = (members: TeamInput["members"]): TeamInput => ({ rootID: "session-a", status: "ready", members, cues: [], more: false })
const child = (id: string, state: "running" | "completed" | "cancelled" = "running") => ({
  sessionID: id, parentID: "session-a", description: "Review implementation", agent: "Reviewer", state,
})

test("a fresh Session shows only its main agent, never other loaded root Sessions", () => {
  const input = scenario("tool")
  expect(projectOffice(input, defaultOfficePreferences).actors.map((actor) => actor.sessionID)).toEqual(["session-a"])
  expect(projectOffice({ ...input, team: team([]) }, defaultOfficePreferences).actors.map((actor) => actor.sessionID)).toEqual(["session-a"])
  expect(projectOffice({ ...input, activeSessionID: "session-b", selected: undefined }, defaultOfficePreferences).actors.map((actor) => actor.sessionID)).toEqual(["session-b"])
  expect(projectOffice({ ...input, activeSessionID: undefined, selected: undefined }, defaultOfficePreferences).actors).toEqual([])
})

test("only the selected Session's reported family is present regardless of loaded Session rows", () => {
  const input = scenario("tool")
  const members = [child("session-b"), child("session-d")]
  const snapshot = projectOffice({ ...input, team: team(members) }, defaultOfficePreferences)
  expect(snapshot.actors.map((actor) => [actor.sessionID, actor.kind])).toEqual([
    ["session-a", "session"], ["session-b", "task"], ["session-d", "task"],
  ])
  expect(snapshot.overflow).toBe(0)
  expect(snapshot.team.rootActorID).toBe('["fixture-device","session-a"]')
  const childView = projectOffice({ ...input, activeSessionID: "session-b", sessions: [], selected: undefined, team: team(members) }, defaultOfficePreferences)
  expect(childView.actors.map((actor) => actor.sessionID).sort()).toEqual(["session-a", "session-b", "session-d"])
  expect(projectOffice({ ...input, team: { ...team(members), status: "unsupported" } }, defaultOfficePreferences).actors.map((actor) => actor.sessionID)).toEqual(["session-a"])
})

test("human names are unique, deterministic across reorder and status updates, and roles remain explicit", () => {
  const input = scenario("tool")
  const members = Array.from({ length: 15 }, (_, index) => child(`child-${index}`))
  const a = projectOffice({ ...input, team: team(members) }, defaultOfficePreferences)
  const b = projectOffice({ ...input, sessions: [...input.sessions].reverse(), team: team([...members].reverse()), selected: { ...input.selected!, thinking: true } }, defaultOfficePreferences)
  expect(new Set(a.actors.map((actor) => actor.name)).size).toBe(a.actors.length)
  expect(a.actors.map((actor) => [actor.sessionID, actor.name, actor.role])).toEqual(b.actors.map((actor) => [actor.sessionID, actor.name, actor.role]))
  expect(a.actors.every((actor) => /^[A-Z][a-z]+ [A-Z][a-z]+(?: \d+)?$/.test(actor.name))).toBe(true)
  expect(a.actors.find((actor) => actor.kind === "session")?.role).toBe("Developer")
  expect(a.actors.filter((actor) => actor.kind === "task").every((actor) => actor.role === "Reviewer")).toBe(true)
})

test("current Office location labels name rooms, hallway and entrance rather than the home room", async () => {
  const officeLocationLabel: (room?: "ceo" | "meeting" | "lounge" | "hall") => string = Reflect.get(await import("./model"), "officeLocationLabel")
  expect(typeof officeLocationLabel).toBe("function")
  expect(officeLocationLabel("ceo")).toBe("CEO office")
  expect(officeLocationLabel("meeting")).toBe("Meeting room")
  expect(officeLocationLabel("lounge")).toBe("Relax lounge")
  expect(officeLocationLabel("hall")).toBe("Hallway")
  expect(officeLocationLabel(undefined)).toBe("Entrance")
})
