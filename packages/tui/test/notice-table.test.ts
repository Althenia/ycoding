import { expect, test } from "bun:test"
import { noticeMarkdown } from "../src/routes/session/notice-table"

test("formats recognized Session state JSON as escaped Markdown tables", () => {
  expect(
    noticeMarkdown(
      "session-state",
      'Authoritative current Session state (JSON):\n{"autonomy":{"mode":"normal"},"todos":[{"content":"A | B\\nnext","status":"pending"}]}',
    ),
  ).toEqual({
    structured: true,
    summary: "Session state · normal · YOLO 0 · 1 task",
    content:
      "## Session state\n\n### autonomy\n\n| Field | Value |\n| --- | --- |\n| mode | normal |\n\n### todos\n\n| content | status |\n| --- | --- |\n| A \\| B<br>next | pending |",
  })
})

test("only parses recognized source framing and preserves malformed content", () => {
  expect(noticeMarkdown("team-view", "not JSON")).toEqual({ structured: false, content: "not JSON", summary: "" })
  expect(noticeMarkdown("other", 'Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{"children":[]}')).toEqual({
    structured: false,
    summary: "",
    content:
      'Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{"children":[]}',
  })
})

test("summarizes TeamView states while retaining its table details", () => {
  expect(
    noticeMarkdown(
      "team-view",
      'Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n{"children":[{"state":"running","description":"Inspect | report"},{"state":"completed","description":"Done"}],"omitted":0}',
    ),
  ).toMatchObject({
    structured: true,
    summary: "TeamView · 1 running · 1 completed",
    content: expect.stringContaining("Inspect \\| report"),
  })
})

test("keeps malformed framed JSON available as collapsed raw detail", () => {
  const text = "Authoritative current Session state (JSON):\n{broken"
  expect(noticeMarkdown("session-state", text)).toEqual({
    structured: true,
    summary: "Session state · unavailable",
    content: text,
  })
})

test("keeps active and ended goal reminders after Session state JSON in expanded detail", () => {
  const prefix = "Authoritative current Session state (JSON):\n"
  const active = noticeMarkdown(
    "session-state",
    `${prefix}{"autonomy":{"mode":"goal","yolo":0},"todos":[]}\n\nActive autonomous goal (iteration 2, noProgress 0/3): Validate output`,
  )
  const ended = noticeMarkdown(
    "session-state",
    `${prefix}{"autonomy":{"mode":"normal","yolo":0},"todos":[]}\n\nAutonomous goal is completed: Validate output`,
  )
  expect(active).toMatchObject({ structured: true, summary: "Session state · goal · YOLO 0 · 0 tasks" })
  expect(active.content).toContain("Active autonomous goal")
  expect(ended.content).toContain("Autonomous goal is completed")
})
