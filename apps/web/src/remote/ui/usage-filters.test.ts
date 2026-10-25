import { expect, test } from "bun:test"
import { commitUsageFilterDraft, customUsageRange, defaultUsageFilters, usageFilterCount, usageFilterDraft, usageFilterSummary } from "./usage-filter-model"

test("custom usage bounds are inclusive/exclusive UTC dates and reject invalid or empty ranges", () => {
  expect(customUsageRange("2026-10-01", "2026-10-15")).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 15) })
  for (const [from, to] of [["2026-02-30", "2026-03-02"], ["", "2026-10-15"], ["2026-10-15", "2026-10-15"], ["2026-10-16", "2026-10-15"]]) expect(customUsageRange(from!, to!)).toBeUndefined()
})

const custom = { ...defaultUsageFilters, range: "custom", from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 8) } as const

test("the phone filter summary names the group, the range and only the active filters", () => {
  expect(usageFilterSummary("model", defaultUsageFilters)).toEqual(["Model (recorded selection)", "Last 30 days"])
  expect(usageFilterSummary("provider-model", { ...defaultUsageFilters, provider: "openai", profile: "Work", model: "gpt-6-sol", effort: "high", range: "all" }, "Codex"))
    .toEqual(["Provider / model", "All retained history", "Provider Codex", "Profile Work", "Model gpt-6-sol", "Effort high"])
  expect(usageFilterSummary("model", { ...defaultUsageFilters, provider: "openai" })).toContain("Provider openai")
  expect(usageFilterSummary("model", custom)[1]).toBe("UTC 2026-10-01 to 2026-10-08 (exclusive)")
  expect(usageFilterSummary("model", { ...defaultUsageFilters, range: "custom" })[1]).toBe("Custom UTC range")
})

test("the active filter count follows departures from the defaults", () => {
  expect(usageFilterCount("model", defaultUsageFilters)).toBe(0)
  expect(usageFilterCount("session", { ...defaultUsageFilters, range: "last7", model: "gpt-6-sol" })).toBe(3)
})

test("applying a filter draft preserves selections, validates custom UTC dates and trims free text", () => {
  expect(usageFilterDraft("agent", custom)).toMatchObject({ group: "agent", range: "custom", fromText: "2026-10-01", toText: "2026-10-08" })
  expect(usageFilterDraft("agent", { ...custom, range: "all" })).toMatchObject({ fromText: "", toText: "" })
  expect(commitUsageFilterDraft(usageFilterDraft("agent", custom))).toEqual({ group: "agent", filters: custom })
  expect(commitUsageFilterDraft({ ...usageFilterDraft("model", defaultUsageFilters), model: " gpt-6-sol ", effort: " ", range: "all" })).toEqual({ group: "model", filters: { ...defaultUsageFilters, model: "gpt-6-sol", range: "all" } })
  expect(commitUsageFilterDraft({ ...usageFilterDraft("model", defaultUsageFilters), range: "custom", fromText: "2026-10-08", toText: "2026-10-01" })).toBeUndefined()
  expect(commitUsageFilterDraft({ ...usageFilterDraft("model", defaultUsageFilters), range: "custom" })).toBeUndefined()
})
