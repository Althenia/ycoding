import { expect, test } from "bun:test"
import { listPage, parseListQuery, type DoubleSession } from "./session-list-double"

test("workspace filtering excludes fixtures without a Session Location", () => {
  const sessions: readonly DoubleSession[] = [
    { id: "ses_unknown", title: "Unknown", time: { created: 1, updated: 3 } },
    { id: "ses_match", title: "Match", location: { directory: "/project" }, time: { created: 1, updated: 2 } },
    { id: "ses_other", title: "Other", location: { directory: "/other" }, time: { created: 1, updated: 1 } },
  ]
  expect(listPage(sessions, parseListQuery({ workspace: "/project\u0000" })).data.map((session) => session.id)).toEqual([
    "ses_match",
  ])
  expect(listPage(sessions, parseListQuery({})).data.map((session) => session.id)).toEqual([
    "ses_unknown",
    "ses_match",
    "ses_other",
  ])
})
