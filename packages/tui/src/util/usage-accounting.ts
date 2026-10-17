import type { ProviderUsageForecastOutput, ProviderUsageListOutput, UsageReportOutput, SessionPromptCostsOutput, SessionTaskCostsOutput } from "@ycoding-ai/client"

export function matchingQuotaForecast(provider: ProviderUsageListOutput["data"][number], window: ProviderUsageListOutput["data"][number]["windows"][number], forecasts: ProviderUsageForecastOutput["data"]["quotas"] | undefined) {
  return forecasts?.find((quota) => quota.providerID === provider.providerID && quota.profile === provider.profile && quota.windowID === window.id && quota.unit === window.unit && quota.updatedAt === provider.updatedAt)
}

export function reportLabel(row: UsageReportOutput["rows"][number], group?: UsageReportOutput["group"]) {
  if (group === "task") return `${row.label} (inclusive)`
  if (group === "session" && (!row.label.trim() || row.label === row.key)) return `Session ${row.key} · title unreported`
  if (row.model) return `${row.model.providerID}/${row.model.id}${row.model.variant ? ` · selected effort ${row.model.variant}` : ""}${row.model.profile ? ` · profile ${row.model.profile}` : ""}`
  return row.label
}

export function accountingPresentation(unit: SessionPromptCostsOutput["units"][number] | SessionTaskCostsOutput["tasks"][number], unavailable = false): UnitCostPresentation {
  return {
    inputID: "anchor" in unit ? unit.anchor.inputID : unit.sessionID,
    settled: unit.status === "settled", complete: !unavailable && unit.attribution === "complete" && unit.history === "retained" && unit.total.cost.total !== undefined && unit.total.cost.unpricedRequests === 0,
    cost: unit.total.cost, main: unit.main.cost, children: unit.children.cost,
    helpers: unit.helpers.map((helper) => ({ label: helper.source === "prompt" ? "Prompt generator" : helper.source[0]!.toUpperCase() + helper.source.slice(1), cost: helper.cost })),
    reason: [unit.attribution === "complete" ? undefined : `${unit.attribution} attribution`, unit.history === "partial" ? "Incomplete retained history" : undefined, unavailable ? "Latest lookup unavailable; showing previous result" : undefined].filter(Boolean).join(" · ") || undefined,
  }
}

export type CostPresentation = {
  readonly total?: number
  readonly known?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
  readonly provenance?: "recorded" | "current_catalog"
}

export type UnitCostPresentation = {
  readonly inputID: string
  readonly settled: boolean
  readonly complete: boolean
  readonly cost: CostPresentation
  readonly main: CostPresentation
  readonly children: CostPresentation
  readonly helpers: readonly { readonly label: string; readonly cost: CostPresentation }[]
  readonly reason?: string
}

export function costText(cost: CostPresentation | undefined) {
  if (cost === undefined) return "unreported"
  if (cost.total !== undefined && cost.unpricedRequests === 0) return usd(cost.total)
  return cost.known === undefined ? "unreported" : `Known ${usd(cost.known)} + unreported`
}

export function usd(value: number, grouping = true) {
  const magnitude = Math.abs(value)
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    useGrouping: grouping,
    maximumFractionDigits: magnitude > 0 && magnitude < 0.01 ? 4 : 2,
  }).format(magnitude)
  return value < 0 && /[1-9]/.test(text) ? `-${text}` : text
}

export function unitCostLines(unit: Omit<UnitCostPresentation, "inputID">, label = "Prompt cost") {
  return [
    `${label} ${costText(unit.cost)}${unit.settled ? "" : " · so far"}${unit.complete ? "" : " · incomplete"}`,
    `Main ${costText(unit.main)} · Children ${costText(unit.children)}`,
    ...unit.helpers.map((helper) => `${helper.label} ${costText(helper.cost)}`),
    `${unit.cost.pricedRequests} priced · ${unit.cost.unpricedRequests} unpriced${unit.cost.provenance === "current_catalog" ? " · current-catalog estimate" : ""}`,
    ...(unit.reason ? [unit.reason] : []),
  ]
}

export type SpeedPresentation = {
  readonly generationSamples: number
  readonly generationP50TokensPerSecond?: number
  readonly generationP90TokensPerSecond?: number
  readonly providerTimedSamples: number
  readonly observedSamples: number
  readonly outputTokensPerSecond?: number
  readonly samples: number
}

export function measuredSpeedLines(speed: SpeedPresentation | undefined) {
  const rate = (value: number | undefined) => value === undefined ? "unreported" : `${value.toFixed(1)} tok/s`
  return [
    `Measured generation median ${rate(speed?.generationP50TokensPerSecond)} · p90 ${rate(speed?.generationP90TokensPerSecond)}`,
    speed === undefined ? "Generation sample coverage unreported" : `${speed.generationSamples} measured requests · ${speed.providerTimedSamples} provider-timed · ${speed.observedSamples} observed`,
    `Weighted throughput ${rate(speed?.outputTokensPerSecond)} · ${speed === undefined ? "unreported" : speed.samples} first-output latency samples`,
  ]
}

export type ForecastPresentation = {
  readonly state: "estimated" | "insufficient" | "exhausted" | "unlimited"
  readonly unit: string
  readonly method?: "quota-delta-ema" | "window-mean"
  readonly evidence: "low" | "medium" | "insufficient"
  readonly updatedAt: number
  readonly observedFrom?: number
  readonly observedTo?: number
  readonly reason?: string
  readonly ratePerHour?: number
  readonly exhaustionAt?: number
  readonly projectedUsedAtReset?: number
}

export function forecastLines(forecast: ForecastPresentation, now: number, asOf = now) {
  const amount = (value: number) => `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${forecast.unit === "percent" ? "percentage points" : forecast.unit === "usd" ? "USD" : forecast.unit}`
  return [
    forecast.state === "unlimited" ? "Unlimited" : forecast.state === "exhausted" ? "Exhausted" : forecast.state === "insufficient" ? "Forecast unavailable" : "Estimated forecast",
    ...(forecast.ratePerHour === undefined ? [] : [`Quota burn ${amount(forecast.ratePerHour)}/hour`]),
    ...(forecast.exhaustionAt === undefined ? [] : [`Estimated exhaustion ${forecast.exhaustionAt <= Math.max(now, asOf) ? "now" : new Date(forecast.exhaustionAt).toISOString()}`]),
    ...(forecast.projectedUsedAtReset === undefined ? [] : [`Projected at reset ${amount(forecast.projectedUsedAtReset)}`]),
    `${forecast.method === "quota-delta-ema" ? "Recent quota deltas · 15m half-life · 1h horizon" : forecast.method === "window-mean" ? "Window mean" : "No supported method"} · ${forecast.evidence} evidence`,
    ...(forecast.observedFrom === undefined || forecast.observedTo === undefined ? [] : [`Observed ${new Date(forecast.observedFrom).toISOString()} – ${new Date(forecast.observedTo).toISOString()}`]),
    `Updated ${Math.floor(Math.max(0, now - forecast.updatedAt) / 60_000)}m ago`,
    ...(forecast.reason ? [forecast.reason] : []),
  ]
}
