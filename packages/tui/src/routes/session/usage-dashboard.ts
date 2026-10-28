import type { UsageDashboardInput, UsageDashboardOutput, UsageReportOutput } from "@ycoding-ai/client"
import type { ProviderUsageReportInput, UsagePreparing, UsageReportRead, UsageStatsRead } from "./provider-usage-reports"

export type DashboardLoader = (input: UsageDashboardInput) => Promise<UsageDashboardOutput>

const preparing: UsagePreparing = { status: "preparing" }

function ready(info: UsageDashboardOutput) {
  if (info.status === "error") throw new Error(info.message)
  return info.status === "ready" ? info : undefined
}

function required<A>(value: A | undefined, slot: string): A {
  if (value === undefined) throw new Error(`The usage dashboard omitted the requested ${slot} report.`)
  return value
}

export async function readBreakdown(load: DashboardLoader, query: ProviderUsageReportInput): Promise<UsageReportRead> {
  const info = ready(await load({ breakdown: query }))
  return info === undefined ? preparing : required(info.breakdown, "breakdown")
}

export async function readStats(load: DashboardLoader, query: ProviderUsageReportInput): Promise<UsageStatsRead> {
  const first = ready(
    await load({
      daily: query,
      monthly: { ...query, group: "model", offset: 0, limit: 1, sort: "tokens", order: "desc" },
      breakdown: { ...query, group: "session", offset: 0, limit: 1 },
    }),
  )
  if (first === undefined) return preparing
  const head = required(first.daily, "daily")
  const rows = [...head.rows]
  let next = head.nextOffset
  while (next !== undefined) {
    const page = ready(await load({ daily: { ...query, offset: next } }))
    if (page === undefined) return preparing
    if (page.revision !== first.revision) return preparing
    const daily = required(page.daily, "daily")
    rows.push(...daily.rows)
    next = daily.nextOffset
  }
  const report: UsageReportOutput = { ...head, rows, nextOffset: undefined }
  return {
    report,
    stats: { favoriteModel: required(first.monthly, "monthly").rows[0]?.label, sessions: required(first.breakdown, "breakdown").rowCount },
  }
}
