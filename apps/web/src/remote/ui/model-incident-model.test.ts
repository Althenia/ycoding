import { expect, test } from "bun:test"
import {
  decidedByLabel, guidanceIndicator, incidentCount, incidentKindLabel, incidentModelLabel, incidentPageSummary, incidentRecentInput, incidentReportInput,
  incidentRowKey, incidentTime, incidentTotal, incidentGuidanceInput,
} from "./model-incident-model"

const row = { providerID: "openai", modelID: "gpt-6-sol", fallbacks: 1234, escalated: 5, rejected: 0, last: Date.UTC(2026, 9, 16, 8, 9, 7, 321) }

test("report input pages 25 groups at a time and bounds each range exactly", () => {
  const now = Date.UTC(2026, 9, 16, 12)
  expect(incidentReportInput("model", "all", now, 0)).toEqual({ group: "model", offset: 0, limit: 25 })
  expect(incidentReportInput("agent", "last7", now, 25)).toEqual({ group: "agent", from: now - 7 * 86_400_000, offset: 25, limit: 25 })
  expect(incidentReportInput("model", "last30", now, 0)).toEqual({ group: "model", from: now - 30 * 86_400_000, offset: 0, limit: 25 })
  expect(incidentReportInput("model", "custom", now, 50, { from: 10, to: 20 })).toEqual({ group: "model", from: 10, to: 20, offset: 50, limit: 25 })
})

test("rows keep exact counts, one identity per provider, model, and agent, and the full total", () => {
  expect(incidentCount(1234567)).toBe("1,234,567")
  expect(incidentTotal(row)).toBe(1239)
  expect(incidentModelLabel(row)).toBe("openai/gpt-6-sol")
  expect(incidentRowKey(row)).not.toBe(incidentRowKey({ ...row, agent: "build" }))
  expect(incidentRowKey({ ...row, agent: "build" })).not.toBe(incidentRowKey({ ...row, agent: "plan" }))
})

test("timestamps are exact UTC and an absent time is empty rather than the epoch", () => {
  expect(incidentTime(row.last)).toBe("2026-10-16 08:09:07 UTC")
  expect(incidentTime(0)).toBe("")
})

test("page summary names the visible span of the exact group count", () => {
  expect(incidentPageSummary(0, 25, 60)).toBe("Showing 1–25 of 60 groups")
  expect(incidentPageSummary(50, 10, 60)).toBe("Showing 51–60 of 60 groups")
  expect(incidentPageSummary(0, 1, 1)).toBe("Showing 1–1 of 1 group")
  expect(incidentPageSummary(0, 0, 0)).toBeUndefined()
})

test("detail reads use the newest 20 incidents of the exact model and agent, and model guidance never names a Session", () => {
  expect(incidentRecentInput(row)).toEqual({ provider: "openai", model: "gpt-6-sol", limit: 20 })
  expect(incidentRecentInput({ ...row, agent: "build" })).toEqual({ provider: "openai", model: "gpt-6-sol", agent: "build", limit: 20 })
  expect(incidentGuidanceInput({ ...row, agent: "build" })).toEqual({ provider: "openai", model: "gpt-6-sol" })
})

test("guidance indicator states enabled or disabled in words and keeps cleared time exact", () => {
  expect(guidanceIndicator({ enabled: true, text: "<model-guidance>\nx\n</model-guidance>" })).toEqual({ label: "Guidance enabled", enabled: true, preview: "<model-guidance>\nx\n</model-guidance>" })
  expect(guidanceIndicator({ enabled: false })).toEqual({ label: "Guidance disabled", enabled: false })
  expect(guidanceIndicator({ enabled: true, clearedAt: 0 })).toEqual({ label: "Guidance enabled", enabled: true })
  expect(guidanceIndicator({ enabled: true, clearedAt: row.last })).toEqual({ label: "Guidance enabled", enabled: true, cleared: "Cleared 2026-10-16 08:09:07 UTC" })
})

test("kind and decider labels cover every incident source", () => {
  expect(incidentKindLabel).toEqual({ fallback: "Fallback", "guardrail-escalated": "Guardrail escalated", "guardrail-rejected": "Guardrail rejected" })
  expect(decidedByLabel).toEqual({ "decision-model": "Decision model", client: "Client" })
})
