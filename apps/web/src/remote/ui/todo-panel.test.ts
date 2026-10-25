import { expect, test } from "bun:test"
import { declarationsWhere, readStylesheet } from "../../styles/css-rules"
import { todoInitiallyExpanded, todoLabel, todoSummary } from "./todo-panel"

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

test("a phone always starts as the compact summary while wider widths restore the stored preference", () => {
  expect(todoInitiallyExpanded("true", true)).toBe(false)
  expect(todoInitiallyExpanded(null, true)).toBe(false)
  expect(todoInitiallyExpanded("true", false)).toBe(true)
  expect(todoInitiallyExpanded("false", false)).toBe(false)
  expect(todoInitiallyExpanded(null, false)).toBe(false)
})

test("the summary control is named with progress and the current task", () => {
  expect(todoLabel(todoSummary([
    { content: "Done", status: "completed", priority: "low" },
    { content: "Working", status: "in_progress", priority: "high" },
    { content: "Later", status: "pending", priority: "medium" },
  ]))).toBe("Todo list: 1/3 done, current: Working")
  expect(todoLabel(todoSummary([{ content: "Next", status: "pending", priority: "low" }]))).toBe("Todo list: 0/1 done")
})

test("below 768px the summary keeps a 44px target and the expanded list stays short", async () => {
  const sheet = await readStylesheet("../remote/ui/todo-panel.css")
  const phone = (header: string) => declarationsWhere(sheet, (rule) => rule.header === header && rule.conditions.includes("@media (max-width: 767px)"))
  expect(phone(".todo-panel:not(.todo-panel--closing)")["max-block-size"]).toBe("calc(min(176px, 24dvh) + 80px)")
  expect(phone(".todo-panel__toggle")["min-block-size"]).toBe("var(--yc-hit-min)")
  expect(phone(".todo-panel__list")["max-block-size"]).toBe("min(176px, 24dvh)")
  expect(phone(".todo-panel__active")).toMatchObject({ flex: "1 1 0" })
})
