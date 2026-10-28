import { dailySpend, modelIdentity, reportCostText, type UsageDashboardReady, type UsageReport, type UsageReportRow } from "./usage-model"

export type UsageLive = UsageDashboardReady["live"]

const grouped = new Intl.NumberFormat("en-US")
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

export function rateLabel(value: number | undefined, estimated = false) {
  if (value === undefined) return "N/A"
  return `${estimated ? "≈ " : ""}${value >= 100 ? grouped.format(Math.round(value)) : oneDecimal.format(value)} tok/s`
}

export function latencyLabel(milliseconds: number | undefined) {
  if (milliseconds === undefined) return "N/A"
  return milliseconds < 1000 ? `${grouped.format(milliseconds)} ms` : `${oneDecimal.format(milliseconds / 1000)} s`
}

export function liveRate(live: Pick<UsageLive, "active" | "streaming" | "outputTokensPerSecond">) {
  if (live.active === 0) return "Idle"
  if (live.outputTokensPerSecond !== undefined) return rateLabel(live.outputTokensPerSecond, true)
  return live.streaming > 0 ? "Measuring" : "Waiting"
}

export function agoLabel(seconds: number) {
  if (seconds <= 0) return "now"
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`
}

export function liveHistory(live: UsageLive) {
  return live.history.map((point) => ({
    at: point.at, active: point.active, rate: point.outputTokensPerSecond,
    label: agoLabel(Math.max(0, Math.round((live.asOf - point.at) / 1000))),
  }))
}

export function liveModels(live: UsageLive) {
  return live.models.filter((entry) => entry.active > 0).map((entry) => {
    const identity = modelIdentity("", [], entry.model)!
    return {
      key: `${entry.model.providerID}/${entry.model.id}/${entry.model.variant ?? ""}/${entry.model.profile ?? ""}`,
      provider: identity.provider, model: identity.model, active: entry.active, streaming: entry.streaming,
      rate: liveRate({ active: entry.active, streaming: entry.streaming, outputTokensPerSecond: entry.outputTokensPerSecond }),
    }
  }).sort((a, b) => b.active - a.active || a.key.localeCompare(b.key))
}

export function dailyScopeLabel(provider: string, model: string, providerLabel?: string) {
  const parts = [provider === "" ? undefined : `Provider ${providerLabel ?? provider}`, model === "" ? undefined : `Model ${model}`].filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(" · ")
}

export type GenerationFigure = { readonly id: string; readonly label: string; readonly value: string; readonly note: string }
export const generationFigureIDs = ["active", "live", "average", "ttft", "requests", "tokens", "cache", "cost", "outcomes"] as const

export function generationFigures(live: UsageLive, monthly: UsageReport | undefined): readonly GenerationFigure[] {
  const total = monthly?.total
  const speed = monthly?.speed
  const samples = speed?.generationSamples ?? 0
  const average = samples > 0 ? speed?.meanTokensPerSecond : undefined
  const firstOutput = speed?.firstOutputP50Ms !== undefined || speed?.firstOutputP95Ms !== undefined
  const outcomes = total?.outcomes
  const finished = outcomes === undefined ? 0 : outcomes.completed + outcomes.failed + outcomes.cancelled
  const unreported = "unreported"
  return [
    { id: "active", label: "Active generations", value: grouped.format(live.active), note: `${grouped.format(live.streaming)} streaming now` },
    { id: "live", label: "Live output", value: liveRate(live), note: "Aggregate of the last 5 s · estimated from received text" },
    { id: "average", label: "Average generation speed", value: rateLabel(average),
      note: average === undefined ? "No measurable requests this month" : `Mean of ${grouped.format(samples)} per-request rates this month` },
    { id: "ttft", label: "Time to first output", value: firstOutput ? `p50 ${latencyLabel(speed?.firstOutputP50Ms)} · p95 ${latencyLabel(speed?.firstOutputP95Ms)}` : "N/A",
      note: firstOutput ? "Percentiles of this month's requests" : "No first-output samples this month" },
    { id: "requests", label: "Requests", value: total === undefined ? unreported : grouped.format(total.physical), note: "Provider requests this month" },
    { id: "tokens", label: "Input and output tokens", value: total === undefined ? unreported : `${grouped.format(total.tokens.input)} in · ${grouped.format(total.tokens.output)} out`,
      note: total === undefined ? "Tokens unreported" : `${grouped.format(total.tokens.reasoning)} reasoning tokens` },
    { id: "cache", label: "Cache usage", value: total === undefined ? unreported : total.tokens.cache.read === 0 && total.cacheReadReported !== true ? `${unreported} read` : `${grouped.format(total.tokens.cache.read)} read`,
      note: total === undefined ? "Cache unreported" : `${grouped.format(total.tokens.cache.write)} written` },
    { id: "cost", label: "Estimated cost", value: total === undefined ? unreported : reportCostText(total),
      note: total?.costProvenance === "current_catalog" ? "Estimate at current catalog prices" : total?.costProvenance === "recorded" ? "Recorded provider cost" : "An estimate, not a bill" },
    { id: "outcomes", label: "Request outcomes", value: outcomes === undefined ? unreported : `${grouped.format(outcomes.completed)} completed · ${grouped.format(outcomes.failed)} failed · ${grouped.format(outcomes.cancelled)} cancelled`,
      note: outcomes === undefined ? "No outcome data recorded" : finished === 0 ? "No finished requests" : `${oneDecimal.format(outcomes.failed / finished * 100)}% failed` },
  ]
}

export type TrendDay = {
  readonly key: string
  readonly label: string
  readonly requests: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly errorRate?: number
  readonly ttftP50?: number
  readonly ttftP95?: number
  readonly totalP50?: number
  readonly totalP95?: number
  readonly rate?: number
  readonly concurrency?: number
}

export function trendDays(report: UsageReport | undefined, now: number, timeZone?: string): TrendDay[] {
  const rows = new Map(report?.rows.map((row) => [row.key, row]) ?? [])
  return dailySpend(report, now, timeZone).map((day) => {
    const row = rows.get(day.key)
    const outcomes = row?.outcomes
    const finished = outcomes === undefined ? 0 : outcomes.completed + outcomes.failed + outcomes.cancelled
    return {
      key: day.key, label: day.label, requests: row?.physical ?? 0,
      input: row?.tokens.input ?? 0, output: row?.tokens.output ?? 0, reasoning: row?.tokens.reasoning ?? 0,
      cacheRead: row?.tokens.cache.read ?? 0, cacheWrite: row?.tokens.cache.write ?? 0,
      ...(outcomes === undefined || finished === 0 ? {} : { errorRate: outcomes.failed / finished * 100 }),
      ...(row?.speed?.firstOutputP50Ms === undefined ? {} : { ttftP50: row.speed.firstOutputP50Ms }),
      ...(row?.speed?.firstOutputP95Ms === undefined ? {} : { ttftP95: row.speed.firstOutputP95Ms }),
      ...(row?.speed?.totalP50Ms === undefined ? {} : { totalP50: row.speed.totalP50Ms }),
      ...(row?.speed?.totalP95Ms === undefined ? {} : { totalP95: row.speed.totalP95Ms }),
      ...(row?.speed?.outputTokensPerSecond === undefined ? {} : { rate: row.speed.outputTokensPerSecond }),
      ...(row?.concurrency === undefined ? {} : { concurrency: row.concurrency }),
    }
  })
}

export type ChartPoint = { readonly x: number; readonly y: number }

export const chartWidth = 900
export const chartHeight = 140

export function chartMax(series: readonly (readonly (number | undefined)[])[], stacked: boolean) {
  const length = Math.max(0, ...series.map((values) => values.length))
  const peak = stacked
    ? Math.max(0, ...Array.from({ length }, (_, index) => series.reduce((sum, values) => sum + (values[index] ?? 0), 0)))
    : Math.max(0, ...series.flatMap((values) => values.flatMap((value) => value === undefined ? [] : [value])))
  return peak > 0 ? peak : 1
}

export function lineSegments(values: readonly (number | undefined)[], max: number): ChartPoint[][] {
  const segments: ChartPoint[][] = []
  let current: ChartPoint[] = []
  values.forEach((value, index) => {
    if (value === undefined) {
      if (current.length > 0) segments.push(current)
      current = []
      return
    }
    current.push({ x: values.length === 1 ? chartWidth / 2 : index / (values.length - 1) * chartWidth, y: chartHeight - Math.min(1, value / max) * chartHeight })
  })
  if (current.length > 0) segments.push(current)
  return segments
}

export type ChartBar = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export function stackedBars(series: readonly (readonly (number | undefined)[])[], max: number): ChartBar[][] {
  const length = Math.max(0, ...series.map((values) => values.length))
  const slot = chartWidth / Math.max(1, length)
  const floor = new Array<number>(length).fill(0)
  return series.map((values) => values.map((value, index) => {
    const height = Math.min(chartHeight, (value ?? 0) / max * chartHeight)
    const bar = { x: index * slot + slot * 0.22, y: chartHeight - floor[index]! - height, width: slot * 0.56, height }
    floor[index]! += height
    return bar
  }))
}

export type ModelSpeedRow = {
  readonly key: string
  readonly provider: string
  readonly model: string
  readonly requests: number
  readonly mean?: number
  readonly aggregate?: number
  readonly ttftP95?: number
  readonly output: number
  readonly cost: string
}

export function modelSpeedRows(report: UsageReport | undefined, providers: readonly { readonly providerID: string; readonly label: string }[]): ModelSpeedRow[] {
  return (report?.rows ?? []).flatMap((row) => {
    const identity = modelIdentity(row.key, providers, row.model)
    if (identity === undefined) return []
    return [{
      key: row.key, provider: identity.provider, model: identity.model, requests: row.physical, output: row.tokens.output, cost: reportCostText(row),
      ...(row.speed?.meanTokensPerSecond === undefined ? {} : { mean: row.speed.meanTokensPerSecond }),
      ...(row.speed?.outputTokensPerSecond === undefined ? {} : { aggregate: row.speed.outputTokensPerSecond }),
      ...(row.speed?.firstOutputP95Ms === undefined ? {} : { ttftP95: row.speed.firstOutputP95Ms }),
    }]
  })
}

export function fastestModels(rows: readonly ModelSpeedRow[], limit = 8) {
  return rows.filter((row) => row.mean !== undefined).sort((a, b) => b.mean! - a.mean! || a.key.localeCompare(b.key)).slice(0, limit)
}

export function speedCells(speed: UsageReportRow["speed"]) {
  return {
    average: rateLabel(speed?.meanTokensPerSecond),
    aggregate: rateLabel(speed?.outputTokensPerSecond),
    ttft: latencyLabel(speed?.firstOutputP95Ms),
  }
}

export function dashboardBusy(
  view: { readonly kind: string; readonly refreshing?: boolean; readonly stale?: boolean; readonly info?: Pick<UsageDashboardReady, "live"> },
  manualRefresh: boolean,
) {
  if (view.kind === "loading" || view.kind === "preparing") return true
  if (view.kind !== "ready" || view.refreshing !== true) return false
  return view.stale === true || manualRefresh || (view.info?.live.active ?? 0) === 0
}
