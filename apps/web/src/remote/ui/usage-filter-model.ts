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
