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
  ).toBe("Session state · normal · YOLO 0 · 1 task")
})

test("summarizes TeamView states", () => {
  expect(
    noticeSummary(
      "team-view",
      `${teamViewPrefix}{"children":[{"state":"running"},{"state":"completed"}],"omitted":1}`,
    ),
  ).toBe("TeamView · 1 running · 1 completed · 1 omitted")
})

test("summarizes malformed framed JSON without details", () => {
  expect(noticeSummary("session-state", `${sessionPrefix}{broken`)).toBe("Session state · unavailable")
})

test("ignores unrecognized source framing", () => {
  expect(noticeSummary("other", `${teamViewPrefix}{"children":[]}`)).toBeUndefined()
  expect(noticeSummary("team-view", "not JSON")).toBeUndefined()
})
