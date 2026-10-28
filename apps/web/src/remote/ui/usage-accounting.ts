import type { RemoteUsagePromptCost, RemoteUsageTaskCost } from "@ycoding-ai/remote"

export type CostPresentation = {
  readonly total?: number
  readonly known?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
  readonly provenance?: "recorded" | "current_catalog"
}

export function accountingPresentation(unit: RemoteUsagePromptCost | RemoteUsageTaskCost, unavailable = false): UnitCostPresentation {
  return {
    inputID: "anchor" in unit ? unit.anchor.inputID : unit.sessionID,
    settled: unit.status === "settled",
    complete: !unavailable && unit.attribution === "complete" && unit.history === "retained" && unit.total.cost.total !== undefined && unit.total.cost.unpricedRequests === 0,
    cost: unit.total.cost, main: unit.main.cost, children: unit.children.cost,
    helpers: unit.helpers.map((helper) => ({ label: helper.source === "prompt" ? "Prompt generator" : helper.source[0]!.toUpperCase() + helper.source.slice(1), cost: helper.cost })),
    reason: [unit.attribution === "complete" ? undefined : `${unit.attribution} attribution`, unit.history === "partial" ? "Incomplete retained history" : undefined, unavailable ? "Latest lookup unavailable; showing previous result" : undefined].filter(Boolean).join(" · ") || undefined,
  }
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

export type SpeedPresentation = {
  readonly generationSamples: number
  readonly generationP50TokensPerSecond?: number
  readonly generationP90TokensPerSecond?: number
  readonly generationP95TokensPerSecond?: number
  readonly meanTokensPerSecond?: number
  readonly firstOutputP50Ms?: number
  readonly firstOutputP95Ms?: number
  readonly firstOutputP99Ms?: number
  readonly totalP50Ms?: number
  readonly totalP95Ms?: number
  readonly totalP99Ms?: number
  readonly providerTimedSamples: number
  readonly observedSamples: number
  readonly outputTokensPerSecond?: number
  readonly samples: number
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

export function paceStatus(pace: NonNullable<ForecastPresentation["pace"]>, asOf: number) {
  if (pace.verdict === "ahead") return "Ahead"
  if (pace.verdict === "cutting-it-close") return "Cutting it close"
  return `Will run out${pace.exhaustionAt === undefined ? "" : ` ${pace.exhaustionAt <= asOf ? "now" : `${new Date(pace.exhaustionAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}`}`
}

const currency = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)
const count = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)

export function costText(cost: CostPresentation | undefined) {
  if (cost === undefined) return "unreported"
  if (cost.total !== undefined && cost.unpricedRequests === 0) return currency(cost.total)
  return cost.known === undefined ? "unreported" : `Known ${currency(cost.known)} + unreported`
}

export function costCoverage(cost: CostPresentation) {
  return `${count(cost.pricedRequests)} priced · ${count(cost.unpricedRequests)} unpriced${cost.provenance === "current_catalog" ? " · current-catalog estimate" : ""}`
}

export function unitCostLines(unit: Omit<UnitCostPresentation, "inputID">, label = "Prompt cost") {
  return [
    `${label} ${costText(unit.cost)}${unit.settled ? "" : " · so far"}${unit.complete ? "" : " · incomplete"}`,
    `Main ${costText(unit.main)} · Children ${costText(unit.children)}`,
    ...unit.helpers.map((helper) => `${helper.label} ${costText(helper.cost)}`),
    costCoverage(unit.cost),
    ...(unit.reason ? [unit.reason] : []),
  ]
}

export function residentUnitCosts(units: readonly UnitCostPresentation[], messages: readonly { readonly id: string; readonly role: string; readonly synthetic?: boolean }[]) {
  const resident = new Set(messages.filter((message) => message.role === "user" && !message.synthetic).map((message) => message.id))
  return [...new Map(units.filter((unit) => resident.has(unit.inputID)).map((unit) => [unit.inputID, unit])).values()]
}

export function measuredSpeedLines(speed: SpeedPresentation | undefined) {
  const rate = (value: number | undefined) => value === undefined ? "unreported" : `${count(value)} tok/s`
  const duration = (value: number | undefined) => value === undefined ? "unreported" : value < 1000 ? `${count(value)} ms` : `${count(value / 1000)} s`
  return [
    `Measured generation median ${rate(speed?.generationP50TokensPerSecond)} · p90 ${rate(speed?.generationP90TokensPerSecond)}`,
    speed === undefined ? "Generation sample coverage unreported" : `${count(speed.generationSamples)} measured requests · ${count(speed.providerTimedSamples)} provider-timed · ${count(speed.observedSamples)} observed`,
    `Weighted throughput ${rate(speed?.outputTokensPerSecond)} · ${speed === undefined ? "unreported" : count(speed.samples)} first-output latency samples`,
    ...(speed === undefined || speed.meanTokensPerSecond === undefined && speed.generationP95TokensPerSecond === undefined ? [] : [`Mean of per-request rates ${rate(speed.meanTokensPerSecond)} · p95 ${rate(speed.generationP95TokensPerSecond)}`]),
    ...(speed === undefined || speed.firstOutputP50Ms === undefined && speed.firstOutputP95Ms === undefined && speed.firstOutputP99Ms === undefined ? [] : [`First output p50 ${duration(speed.firstOutputP50Ms)} · p95 ${duration(speed.firstOutputP95Ms)} · p99 ${duration(speed.firstOutputP99Ms)}`]),
    ...(speed === undefined || speed.totalP50Ms === undefined && speed.totalP95Ms === undefined && speed.totalP99Ms === undefined ? [] : [`Total request p50 ${duration(speed.totalP50Ms)} · p95 ${duration(speed.totalP95Ms)} · p99 ${duration(speed.totalP99Ms)}`]),
  ]
}

const exactNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 })
const exactCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 20 })
const compactRate = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })

const tokenRate = (value: number) => {
  if (value > 0 && value < 1) return "<1"
  return Math.round(value) < 1000 ? `${Math.round(value)}` : compactRate.format(value).toLowerCase()
}

export function forecastStatus(forecast: ForecastPresentation, asOf: number) {
  if (forecast.state === "unlimited") return "Unlimited"
  if (forecast.state === "exhausted") return "Exhausted"
  if (forecast.state === "insufficient") {
    if (forecast.reason?.startsWith("No increase observed")) return "No increase observed"
    if (forecast.reason && /expired/i.test(forecast.reason)) return "Forecast expired"
    if (forecast.reason && /stale/i.test(forecast.reason)) return "Forecast stale"
    return "Forecast unavailable"
  }
  if (forecast.exhaustionAt === undefined && forecast.ratePerHour === 0) return "No increase observed"
  const outcome = forecast.exhaustionAt !== undefined
    ? `run-out ${forecast.exhaustionAt <= asOf ? "now" : `${new Date(forecast.exhaustionAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}`
    : forecast.projectedUsedAtReset !== undefined ? `projected ${forecastAmount(forecast, forecast.projectedUsedAtReset)} at reset`
    : forecast.ratePerHour !== undefined ? `${forecastAmount(forecast, forecast.ratePerHour)}/hour burn` : undefined
  return ["Estimated", outcome, `${forecast.evidence} evidence`].filter(Boolean).join(" · ")
}

export function forecastDetails(forecast: ForecastPresentation, now: number, asOf = now) {
  return [
    ...(forecast.ratePerHour === undefined ? [] : [`Quota burn ${forecastAmount(forecast, forecast.ratePerHour, true)}/hour`]),
    ...(forecast.exhaustionAt === undefined ? [] : [`Estimated exhaustion ${forecast.exhaustionAt <= asOf ? "now" : new Date(forecast.exhaustionAt).toISOString()}`]),
    ...(forecast.projectedUsedAtReset === undefined ? [] : [`Projected at reset ${forecastAmount(forecast, forecast.projectedUsedAtReset, true)}`]),
    `${forecast.method === "quota-delta-ema" ? "Recent quota deltas · 15m half-life · 1h horizon" : forecast.method === "window-mean" ? "Window mean" : "No supported method"} · ${forecast.evidence} evidence`,
    ...(forecast.observedFrom === undefined || forecast.observedTo === undefined ? [] : [`Observed ${new Date(forecast.observedFrom).toISOString()} – ${new Date(forecast.observedTo).toISOString()}`]),
    `Updated ${new Date(forecast.updatedAt).toISOString()} (${Math.floor(Math.max(0, now - forecast.updatedAt) / 60_000)}m ago)`,
    ...(forecast.reason ? [`Reason: ${forecast.reason}`] : []),
  ]
}

function forecastAmount(forecast: ForecastPresentation, value: number, exact = false) {
  if (forecast.unit === "usd") return exact ? exactCurrency.format(value) : currency(value)
  return `${exact ? exactNumber.format(value) : count(value)} ${forecast.unit === "percent" ? "percentage points" : forecast.unit}`
}

export function providerProvenanceLines(provider: { readonly source: string; readonly stability: string; readonly updatedAt: number }) {
  const label = (value: string) => value.replaceAll("_", " ").replace("api", "API")
  return [`Source ${label(provider.source)} · stability ${label(provider.stability)}`, `Updated ${new Date(provider.updatedAt).toISOString()}`]
}

export type ConsumptionRate = {
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

export const consumptionNeedsProfile = (rates: readonly ConsumptionRate[], rate: ConsumptionRate) =>
  rates.some((other) => other !== rate && other.providerID === rate.providerID && other.modelID === rate.modelID)

export function consumptionRow(rate: ConsumptionRate) {
  const perMinute = (value: number | undefined) => value === undefined ? "unreported" : `${exactNumber.format(value)} tokens/min`
  const estimate = rate.estimatedUSDPerHour === undefined ? undefined : `${currency(rate.estimatedUSDPerHour)}/hour est.`
  const parts = { provider: rate.providerID, model: rate.modelID, profile: rate.profile ? `profile ${rate.profile}` : "default profile" }
  return {
    parts,
    identity: [parts.provider, parts.model, parts.profile].filter(Boolean).join(" · "),
    tokens: `${tokenRate(rate.tokensPerMinute)} tokens/min`,
    cost: estimate === undefined ? "cost rate unreported" : rate.coverage.unpricedRequests > 0 ? `Known ${estimate} + unreported` : estimate,
    details: [
      `Rate ${perMinute(rate.tokensPerMinute)}`,
      `5m ${perMinute(rate.tokensPerMinute5)} · 60m ${perMinute(rate.tokensPerMinute60)}`,
      `Estimated cost rate ${rate.estimatedUSDPerHour === undefined ? "unreported" : `${exactCurrency.format(rate.estimatedUSDPerHour)}/hour`}`,
      costCoverage(rate.coverage),
      `Observed ${new Date(rate.observedFrom).toISOString()} – ${new Date(rate.observedTo).toISOString()}`,
      ...(rate.profile === undefined ? ["Profile provider default at request time"] : []),
      "Recorded requests on this backend; not account quota or generation speed.",
    ],
  }
}
