import { expect, test } from "bun:test"
import { noticeSummary } from "../src/routes/session/notice-summary"

const sessionPrefix = "Authoritative current Session state (JSON):\n"
const teamViewPrefix =
  "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"

test("summarizes Session state", () => {
  expect(
    noticeSummary(
      "session-state",
      `${sessionPrefix}{"autonomy":{"mode":"normal","yolo":false},"todos":[{"content":"Task","status":"pending"}]}`,
    ),
  ).toBe("Session state · YOLO off · 1 task")
})

test("summarizes active autonomy modes", () => {
  const autonomy = { mode: "normal", yolo: true, autoPermission: true, autoGuardrail: true, sleep: {}, autoAnswer: true, goal: { status: "active" } }
  expect(noticeSummary("session-state", `${sessionPrefix}${JSON.stringify({ autonomy, todos: [] })}`)).toBe(
    "Session state · YOLO · permissions auto · guardrails auto · goal · asleep · answers auto · 0 tasks",
  )
})

test("summarizes missing or numeric autonomy as unknown without inventing a state", () => {
  expect(noticeSummary("session-state", `${sessionPrefix}{"todos":[]}`)).toBe("Session state · autonomy unreported · 0 tasks")
  expect(noticeSummary("session-state", `${sessionPrefix}{"autonomy":{"mode":"normal","yolo":2},"todos":[]}`)).toBe(
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
