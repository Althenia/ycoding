import { expect, test } from "bun:test"
import { todoSummary } from "./todo-panel"

test("summarizes completed progress and the first active task", () => {
  expect(todoSummary([
    { content: "Done", status: "completed", priority: "low" },
    { content: "Working", status: "in_progress", priority: "high" },
    { content: "Later", status: "pending", priority: "medium" },
  ])).toEqual({ progress: "1/3", active: "Working" })
  expect(todoSummary([{ content: "Done", status: "completed", priority: "low" }])).toEqual({ progress: "1/1", active: "" })
})
