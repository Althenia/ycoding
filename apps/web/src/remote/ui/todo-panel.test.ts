import { expect, test } from "bun:test"
import { todoSummary } from "./todo-panel"

test("summarizes completed progress and the first active task", () => {
  expect(todoSummary([
    { content: "Done", status: "completed", priority: "low" },
    { content: "Working", status: "in_progress", priority: "high" },
    { content: "Later", status: "pending", priority: "medium" },
  ])).toEqual({ progress: "1/3", active: "Working", visible: true })
  expect(todoSummary([{ content: "Done", status: "completed", priority: "low" }])).toEqual({ progress: "1/1", active: "", visible: false })
})

test("stays visible only while a task is not completed, matching the TUI todo rail", () => {
  expect(todoSummary([]).visible).toBe(false)
  expect(todoSummary([
    { content: "Done", status: "completed", priority: "low" },
    { content: "Also done", status: "completed", priority: "high" },
  ]).visible).toBe(false)
  expect(todoSummary([
    { content: "Done", status: "completed", priority: "low" },
    { content: "Dropped", status: "cancelled", priority: "low" },
  ]).visible).toBe(true)
  expect(todoSummary([{ content: "Next", status: "pending", priority: "low" }]).visible).toBe(true)
})
