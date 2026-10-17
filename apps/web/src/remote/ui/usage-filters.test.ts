import { expect, test } from "bun:test"
import { customUsageRange } from "./usage-filter-model"

test("custom usage bounds are inclusive/exclusive UTC dates and reject invalid or empty ranges", () => {
  expect(customUsageRange("2026-10-01", "2026-10-15")).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 15) })
  for (const [from, to] of [["2026-02-30", "2026-03-02"], ["", "2026-10-15"], ["2026-10-15", "2026-10-15"], ["2026-10-16", "2026-10-15"]]) expect(customUsageRange(from!, to!)).toBeUndefined()
})
