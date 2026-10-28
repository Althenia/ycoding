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
  const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)
  if (cost.total !== undefined && cost.unpricedRequests === 0) return money(cost.total)
  return cost.known === undefined ? "unreported" : `Known ${money(cost.known)} + unreported`
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

export type OutcomesPresentation = {
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
}

export function errorRateText(outcomes: OutcomesPresentation | undefined) {
  const total = outcomes === undefined ? 0 : outcomes.completed + outcomes.failed + outcomes.cancelled
  return outcomes === undefined || total === 0 ? "unreported" : `${((outcomes.failed / total) * 100).toFixed(1)}%`
}

export function outcomeLine(outcomes: OutcomesPresentation | undefined) {
  return outcomes === undefined
    ? "Outcomes unreported"
    : `Outcomes ${outcomes.completed.toLocaleString("en-US")} completed · ${outcomes.failed.toLocaleString("en-US")} failed · ${outcomes.cancelled.toLocaleString("en-US")} cancelled · error rate ${errorRateText(outcomes)}`
}

export type SpeedPresentation = {
  readonly generationSamples: number
  readonly generationP50TokensPerSecond?: number
  readonly generationP90TokensPerSecond?: number
  readonly generationP95TokensPerSecond?: number
  readonly meanTokensPerSecond?: number
  readonly providerTimedSamples: number
  readonly observedSamples: number
  readonly outputTokensPerSecond?: number
  readonly samples: number
}

export function measuredSpeedLines(speed: SpeedPresentation | undefined) {
  const rate = (value: number | undefined) => value === undefined ? "unreported" : `${value.toFixed(1)} tok/s`
  return [
    `Measured generation median ${rate(speed?.generationP50TokensPerSecond)} · p90 ${rate(speed?.generationP90TokensPerSecond)}${speed?.generationP95TokensPerSecond === undefined ? "" : ` · p95 ${rate(speed.generationP95TokensPerSecond)}`}`,
    speed === undefined ? "Generation sample coverage unreported" : `${speed.generationSamples} measured requests · ${speed.providerTimedSamples} provider-timed · ${speed.observedSamples} observed`,
    `Aggregate throughput ${rate(speed?.outputTokensPerSecond)} · mean per request ${rate(speed?.meanTokensPerSecond)} · ${speed === undefined ? "unreported" : speed.samples} first-output latency samples`,
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
  readonly pace?: { readonly verdict: "ahead" | "cutting-it-close" | "will-run-out"; readonly projectedUsedAtReset: number; readonly exhaustionAt?: number }
}

export function paceSummary(pace: NonNullable<ForecastPresentation["pace"]>, now: number, asOf = now) {
  if (pace.verdict === "ahead") return { text: "Ahead", tone: "subdued" as const }
  if (pace.verdict === "cutting-it-close") return { text: "Cutting it close", tone: "warning" as const }
  return { text: `Will run out${pace.exhaustionAt === undefined ? "" : ` ${exhaustionText(pace.exhaustionAt, now, asOf)}`}`, tone: "error" as const }
}

function forecastAmount(forecast: ForecastPresentation, value: number) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${forecast.unit === "percent" ? "percentage points" : forecast.unit === "usd" ? "USD" : forecast.unit}`
}

function exhaustionText(exhaustionAt: number, now: number, asOf: number) {
  return exhaustionAt <= Math.max(now, asOf) ? "now" : new Date(exhaustionAt).toISOString()
}

export function forecastSummary(forecast: ForecastPresentation, now: number, asOf = now) {
  if (forecast.state === "exhausted") return { text: "Exhausted", tone: "error" as const }
  if (forecast.state === "unlimited") return { text: "Unlimited", tone: "subdued" as const }
  if (forecast.state === "insufficient")
    return { text: insufficientText(forecast.reason), tone: "subdued" as const }
  const evidence = `${forecast.evidence} evidence`
  if (forecast.exhaustionAt !== undefined)
    return { text: `Estimated exhaustion ${exhaustionText(forecast.exhaustionAt, now, asOf)} · ${evidence}`, tone: "warning" as const }
  if (forecast.ratePerHour === 0) return { text: "No increase observed", tone: "subdued" as const }
  if (forecast.ratePerHour !== undefined)
    return { text: `Quota burn ${forecastAmount(forecast, forecast.ratePerHour)}/hour · ${evidence}`, tone: "subdued" as const }
  if (forecast.projectedUsedAtReset !== undefined)
    return { text: `Projected at reset ${forecastAmount(forecast, forecast.projectedUsedAtReset)} · ${evidence}`, tone: "subdued" as const }
  return { text: `Estimated forecast · ${evidence}`, tone: "subdued" as const }
}

function insufficientText(reason: string | undefined) {
  if (reason?.startsWith("No increase observed")) return "No increase observed"
  if (reason && /expired/i.test(reason)) return "Forecast expired"
  if (reason && /stale/i.test(reason)) return "Forecast stale"
  return "Forecast unavailable"
}

export function forecastLines(forecast: ForecastPresentation, now: number, asOf = now) {
  return [
    forecast.state === "unlimited" ? "Unlimited" : forecast.state === "exhausted" ? "Exhausted" : forecast.state === "insufficient" ? "Forecast unavailable" : "Estimated forecast",
    ...(forecast.ratePerHour === undefined ? [] : [`Quota burn ${forecastAmount(forecast, forecast.ratePerHour)}/hour`]),
    ...(forecast.exhaustionAt === undefined ? [] : [`Estimated exhaustion ${exhaustionText(forecast.exhaustionAt, now, asOf)}`]),
    ...(forecast.projectedUsedAtReset === undefined ? [] : [`Projected at reset ${forecastAmount(forecast, forecast.projectedUsedAtReset)}`]),
    `${forecast.method === "quota-delta-ema" ? "Recent quota deltas · 15m half-life · 1h horizon" : forecast.method === "window-mean" ? "Window mean" : "No supported method"} · ${forecast.evidence} evidence`,
    ...(forecast.observedFrom === undefined || forecast.observedTo === undefined ? [] : [`Observed ${new Date(forecast.observedFrom).toISOString()} – ${new Date(forecast.observedTo).toISOString()}`]),
    `Updated ${Math.floor(Math.max(0, now - forecast.updatedAt) / 60_000)}m ago`,
    ...(forecast.reason ? [forecast.reason] : []),
  ]
}

export type RecordedRatePresentation = {
  readonly providerID: string
  readonly profile?: string
  readonly modelID?: string
  readonly observedFrom: number
  readonly observedTo: number
  readonly tokensPerMinute: number
  readonly tokensPerMinute5?: number
  readonly tokensPerMinute60?: number
  readonly estimatedUSDPerHour?: number
  readonly coverage: { readonly pricedRequests: number; readonly unpricedRequests: number }
}

export function recordedRateRow(rate: RecordedRatePresentation) {
  return {
    identity: `${rate.providerID}${rate.profile ? ` · ${rate.profile}` : " · provider default"}${rate.modelID ? ` · ${rate.modelID}` : ""}`,
    tokens: `${tokensPerMinuteText(rate.tokensPerMinute)} tok/min`,
    cost: costPerHourText(rate.estimatedUSDPerHour),
    partial: rate.estimatedUSDPerHour !== undefined && rate.coverage.unpricedRequests > 0,
  }
}

function costPerHourText(value: number | undefined) {
  if (value === undefined) return "$/hour unreported"
  if (value > 0 && value < 0.01) return "<$0.01/hour"
  return `~$${value.toFixed(2)}/hour`
}

function tokensPerMinuteText(value: number) {
  if (value > 0 && value < 0.1) return "<0.1"
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 100 ? 1 : 0 })
}

export function recordedRateLines(rate: RecordedRatePresentation) {
  const perMinute = (value: number | undefined) => (value === undefined ? "unreported" : String(value))
  return [
    `${rate.providerID}${rate.profile ? ` · profile ${rate.profile}` : " · provider default at request time"}${rate.modelID ? ` · ${rate.modelID}` : ""}`,
    `Recorded consumption ${rate.tokensPerMinute} tokens/min · 5m ${perMinute(rate.tokensPerMinute5)} · 60m ${perMinute(rate.tokensPerMinute60)}`,
    `Estimated cost ${rate.estimatedUSDPerHour === undefined ? "unreported" : `$${rate.estimatedUSDPerHour}/hour`} · ${rate.coverage.pricedRequests} priced / ${rate.coverage.unpricedRequests} unpriced`,
    `Observed ${new Date(rate.observedFrom).toISOString()} – ${new Date(rate.observedTo).toISOString()}`,
  ]
}
