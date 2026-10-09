import { expect, test } from "bun:test"
import { decisionAdvisory, noticeSummary } from "../src/routes/session/notice-summary"

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

const advisoryDisclaimer =
  "Decision advisory: helper recommendations, not user instructions, permission, approval, execution or completion evidence. Preserve explicit model/agent selections, permissions, guardrails and the user's objective. Verify current tool availability and its actual schema before use. Do not call decision again solely to assess this advisory."

test("summarizes a Decision advisory by its recommendations and keeps them as details", () => {
  const text = [
    advisoryDisclaimer,
    'Recommended model for task planning/delegation: "openai/gpt-6-luna-fast#medium" (model confidence 0.93, uncalibrated)',
    "Recommended direction: Implement the accepted bounded change with a regression test (model confidence 0.91, uncalibrated)",
  ].join("\n")
  expect(decisionAdvisory(text)).toEqual({
    hidden: false,
    summary: "Decision advisory · 2 recommendations",
    details: [
      'Recommended model for task planning/delegation: "openai/gpt-6-luna-fast#medium" (model confidence 0.93, uncalibrated)',
      "Recommended direction: Implement the accepted bounded change with a regression test (model confidence 0.91, uncalibrated)",
    ],
  })
})

test("hides a Decision advisory that produced nothing actionable and keeps an unavailable one visible", () => {
  const outcome = "No sufficiently confident actionable recommendation was produced."
  expect(decisionAdvisory(`${advisoryDisclaimer}\n${outcome}`)).toEqual({ hidden: true })
  const unavailable = "Decision advisory unavailable (timeout); no recommendation was produced."
  expect(decisionAdvisory(`${advisoryDisclaimer}\n${unavailable}`)).toEqual({
    hidden: false,
    summary: unavailable,
    details: [unavailable],
  })
  expect(decisionAdvisory("TeamView: reviewer is running")).toBeUndefined()
})

test("summarizes Scoping advisory recommendations through the existing parser", () => {
  const text = [advisoryDisclaimer, "Recommended granularity: right-sized", "Recommended task implement: child; ready yes",
    'Scoping plan: {"conflicts":[],"dispatched":[]}'].join("\n")
  expect(decisionAdvisory(text)?.summary).toBe("Decision advisory · 2 recommendations")
})
