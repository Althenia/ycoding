import type {
  RemoteIncidentGuidance, RemoteIncidentGuidanceInput, RemoteIncidentRecent, RemoteIncidentRecentInput, RemoteIncidentReport, RemoteIncidentReportInput,
} from "@ycoding-ai/remote"

export type IncidentGroup = RemoteIncidentReportInput["group"]
export type IncidentRange = "last7" | "last30" | "all" | "custom"
export type IncidentReport = RemoteIncidentReport["data"]
export type IncidentRow = IncidentReport["rows"][number]
export type IncidentItem = RemoteIncidentRecent["data"]["items"][number]
export type IncidentGuidance = RemoteIncidentGuidance["data"]
export type IncidentReportInput = RemoteIncidentReportInput
export type IncidentRecentInput = RemoteIncidentRecentInput
export type IncidentGuidanceInput = RemoteIncidentGuidanceInput

export const incidentPageSize = 25
export const incidentRecentLimit = 20

const day = 86_400_000
const rangeDays = { last7: 7, last30: 30 } as const

export function incidentReportInput(group: IncidentGroup, range: IncidentRange, now: number, offset: number, custom?: { readonly from: number; readonly to: number }): IncidentReportInput {
  const bounds = range === "custom" ? custom : range === "all" ? undefined : { from: now - rangeDays[range] * day }
  return { group, ...bounds, offset, limit: incidentPageSize }
}

export const incidentCount = (value: number) => new Intl.NumberFormat("en-US").format(value)
export const incidentTotal = (row: Pick<IncidentRow, "fallbacks" | "escalated" | "rejected">) => row.fallbacks + row.escalated + row.rejected
export const incidentModelLabel = (row: Pick<IncidentRow, "providerID" | "modelID">) => `${row.providerID}/${row.modelID}`
export const incidentRowKey = (row: Pick<IncidentRow, "providerID" | "modelID" | "agent">) => JSON.stringify([row.providerID, row.modelID, row.agent ?? null])

export const incidentTime = (time: number) => time > 0 ? new Date(time).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "unreported"

export function incidentPageSummary(offset: number, shown: number, groups: number) {
  if (shown === 0) return undefined
  return `Showing ${incidentCount(offset + 1)}–${incidentCount(offset + shown)} of ${incidentCount(groups)} ${groups === 1 ? "group" : "groups"}`
}

export const incidentRecentInput = (row: IncidentRow): IncidentRecentInput =>
  ({ provider: row.providerID, model: row.modelID, ...(row.agent === undefined ? {} : { agent: row.agent }), limit: incidentRecentLimit })

/** Guidance belongs to the model, so the agent never narrows it and the page names no Session. */
export const incidentGuidanceInput = (row: IncidentRow): IncidentGuidanceInput => ({ provider: row.providerID, model: row.modelID })

export function guidanceIndicator(guidance: IncidentGuidance) {
  return {
    label: guidance.enabled ? "Guidance enabled" : "Guidance disabled",
    enabled: guidance.enabled,
    ...(guidance.text === undefined ? {} : { preview: guidance.text }),
    ...(guidance.clearedAt === undefined ? {} : { cleared: `Cleared ${incidentTime(guidance.clearedAt)}` }),
  }
}

export const incidentKindLabel = { fallback: "Fallback", "guardrail-escalated": "Guardrail escalated", "guardrail-rejected": "Guardrail rejected" } as const
export const decidedByLabel = { "decision-model": "Decision model", human: "Human" } as const
