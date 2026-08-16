import { describe, expect, test } from "bun:test"
import {
  collapseSection,
  defaultExpanded,
  expandSection,
  MAX_EXPANDED,
  railPlacement,
  railWidth,
  resolveExpanded,
  type RailSectionKey,
} from "../src/routes/session/rail"

describe("rail default expansion", () => {
  test("expands the sections that carry no header summary", () => {
    expect(defaultExpanded({})).toEqual(["session", "context", "todo"])
  })

  test("adds goal and autonomy while they are active", () => {
    expect(defaultExpanded({ goal: true, autonomy: true })).toEqual(["context", "goal", "autonomy", "todo"])
  })

  test("never exceeds the expansion cap", () => {
    expect(defaultExpanded({ goal: true, autonomy: true }).length).toBeLessThanOrEqual(MAX_EXPANDED)
  })
})

describe("rail expansion capacity", () => {
  test("collapses the least recently expanded section when a fifth opens", () => {
    const order: RailSectionKey[] = ["session", "context", "todo", "goal"]
    expect(expandSection(order, "mcp")).toEqual(["context", "todo", "goal", "mcp"])
  })

  test("re-expanding a section refreshes its recency instead of duplicating it", () => {
    const order: RailSectionKey[] = ["session", "context", "todo", "goal"]
    expect(expandSection(order, "session")).toEqual(["context", "todo", "goal", "session"])
  })

  test("collapsing removes the section and frees capacity", () => {
    const order: RailSectionKey[] = ["session", "context", "todo", "goal"]
    expect(collapseSection(order, "todo")).toEqual(["session", "context", "goal"])
  })

  test("collapsing a section that is already collapsed changes nothing", () => {
    const order: RailSectionKey[] = ["session", "context"]
    expect(collapseSection(order, "mcp")).toEqual(order)
  })
})

describe("rail attention", () => {
  test("forces an attention section open within the cap", () => {
    const order: RailSectionKey[] = ["session", "context", "todo", "goal"]
    expect(resolveExpanded({ order, attention: ["subagents"] })).toEqual([
      "context",
      "todo",
      "goal",
      "subagents",
    ])
  })

  test("leaves the order untouched when nothing needs attention", () => {
    const order: RailSectionKey[] = ["session", "context", "todo"]
    expect(resolveExpanded({ order, attention: [] })).toEqual(order)
  })
})

describe("rail placement", () => {
  test("hides the rail below 100 columns", () => {
    expect(railPlacement(80)).toBe("hidden")
    expect(railPlacement(99)).toBe("hidden")
  })

  test("overlays the rail between 100 and 119 columns", () => {
    expect(railPlacement(100)).toBe("overlay")
    expect(railPlacement(119)).toBe("overlay")
  })

  test("docks the rail from 120 columns", () => {
    expect(railPlacement(120)).toBe("docked")
    expect(railPlacement(160)).toBe("docked")
  })

  test("keeps the docked rail within 32 to 36 columns", () => {
    expect(railWidth(120)).toBe(32)
    expect(railWidth(140)).toBe(34)
    expect(railWidth(159)).toBe(35)
    expect(railWidth(160)).toBe(36)
    expect(railWidth(240)).toBe(36)
  })
})
