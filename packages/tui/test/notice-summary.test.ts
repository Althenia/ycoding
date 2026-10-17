import { expect, test } from "bun:test"
import { noticeSummary } from "../src/routes/session/notice-summary"

const sessionPrefix = "Authoritative current Session state (JSON):\n"
const teamViewPrefix =
  "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"

test("summarizes Session state", () => {
  expect(
    noticeSummary(
      "session-state",
      `${sessionPrefix}{"autonomy":{"mode":"normal","yolo":0},"todos":[{"content":"Task","status":"pending"}]}`,
    ),
  ).toBe("Session state · Ask first · 1 task")
})

test("summarizes active autonomy modes", () => {
  const autonomy = { mode: "normal", yolo: 1, sleep: {}, autoAnswer: true, goal: { status: "active" } }
  expect(noticeSummary("session-state", `${sessionPrefix}${JSON.stringify({ autonomy, todos: [] })}`)).toBe(
    "Session state · Allow tools · goal · asleep · answers auto · 0 tasks",
  )
})

test("summarizes missing or unsupported autonomy without inventing a level", () => {
  expect(noticeSummary("session-state", `${sessionPrefix}{"todos":[]}`)).toBe("Session state · autonomy unreported · 0 tasks")
  expect(noticeSummary("session-state", `${sessionPrefix}{"autonomy":{"mode":"normal","yolo":3},"todos":[]}`)).toBe(
    "Session state · unknown · 0 tasks",
  )
})

test("summarizes TeamView states", () => {
  expect(
    noticeSummary("team-view", `${teamViewPrefix}{"children":[{"state":"running"},{"state":"completed"}],"omitted":1}`),
  ).toBe("TeamView · 1 running · 1 completed · 1 omitted")
})

test("summarizes malformed framed JSON without details", () => {
  expect(noticeSummary("session-state", `${sessionPrefix}{broken`)).toBe("Session state · unavailable")
})

test("ignores unrecognized source framing", () => {
  expect(noticeSummary("other", `${teamViewPrefix}{"children":[]}`)).toBeUndefined()
  expect(noticeSummary("team-view", "not JSON")).toBeUndefined()
})
