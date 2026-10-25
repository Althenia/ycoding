export const usageGroups = [
  { value: "model", label: "Model (recorded selection)" },
  { value: "provider", label: "Provider" },
  { value: "provider-profile-model", label: "Provider / profile / model" },
  { value: "provider-model", label: "Provider / model" },
  { value: "model-id", label: "Model ID" },
  { value: "profile", label: "Provider / profile" },
  { value: "session", label: "Sessions" },
  { value: "project", label: "Projects" },
  { value: "agent", label: "Agents" },
  { value: "prompt", label: "Prompts" },
  { value: "task", label: "Tasks (inclusive)" },
] as const
export type UsageGroupPresentation = (typeof usageGroups)[number]["value"]

export type UsageFiltersPresentation = {
  readonly provider: string
  readonly profile: string
  readonly model: string
  readonly effort: string
  readonly range: "last7" | "last30" | "all" | "custom"
  readonly from?: number
  readonly to?: number
}

export function customUsageRange(from: string, to: string) {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
    const time = Date.parse(`${value}T00:00:00.000Z`)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : undefined
  }
  const start = parse(from)
  const end = parse(to)
  return start === undefined || end === undefined || start >= end ? undefined : { from: start, to: end }
}

export const defaultUsageGroup: UsageGroupPresentation = "model"
export const defaultUsageFilters: UsageFiltersPresentation = { provider: "", profile: "", model: "", effort: "", range: "last30" }

export const usageRangeChoices = [
  { value: "last7", label: "7 days", summary: "Last 7 days" },
  { value: "last30", label: "30 days", summary: "Last 30 days" },
  { value: "all", label: "All retained", summary: "All retained history" },
  { value: "custom", label: "Custom UTC", summary: "Custom UTC range" },
] as const

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10)

export function usageFilterSummary(group: UsageGroupPresentation, filters: UsageFiltersPresentation, providerLabel?: string) {
  const range = usageRangeChoices.find((choice) => choice.value === filters.range)!
  return [
    usageGroups.find((option) => option.value === group)!.label,
    filters.range === "custom" && filters.from !== undefined && filters.to !== undefined ? `UTC ${utcDay(filters.from)} to ${utcDay(filters.to)} (exclusive)` : range.summary,
    ...(filters.provider ? [`Provider ${providerLabel ?? filters.provider}`] : []),
    ...(filters.profile ? [`Profile ${filters.profile}`] : []),
    ...(filters.model ? [`Model ${filters.model}`] : []),
    ...(filters.effort ? [`Effort ${filters.effort}`] : []),
  ]
}

export function usageFilterCount(group: UsageGroupPresentation, filters: UsageFiltersPresentation) {
  return [group !== defaultUsageGroup, filters.provider !== "", filters.profile !== "", filters.model !== "", filters.effort !== "", filters.range !== defaultUsageFilters.range].filter(Boolean).length
}

export type UsageFilterDraft = UsageFiltersPresentation & { readonly group: UsageGroupPresentation; readonly fromText: string; readonly toText: string }

export const usageFilterDraft = (group: UsageGroupPresentation, filters: UsageFiltersPresentation): UsageFilterDraft => ({
  ...filters,
  group,
  fromText: filters.range === "custom" && filters.from !== undefined ? utcDay(filters.from) : "",
  toText: filters.range === "custom" && filters.to !== undefined ? utcDay(filters.to) : "",
})

export function commitUsageFilterDraft(draft: UsageFilterDraft) {
  const bounds = draft.range === "custom" ? customUsageRange(draft.fromText, draft.toText) : undefined
  if (draft.range === "custom" && bounds === undefined) return undefined
  return {
    group: draft.group,
    filters: { provider: draft.provider, profile: draft.profile.trim(), model: draft.model.trim(), effort: draft.effort.trim(), range: draft.range, ...bounds } satisfies UsageFiltersPresentation,
  }
}
