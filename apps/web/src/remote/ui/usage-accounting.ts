import type { RemoteUsagePromptCost, RemoteUsageTaskCost } from "@ycoding-ai/remote"

export type CostPresentation = {
  readonly total?: number
  readonly known?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
  readonly provenance?: "recorded" | "current_catalog"
}

export type PromptCostLine = { readonly kind: "unit" } | { readonly kind: "loading" | "unreported" }

/** A prompt that is not yet promoted (queued, sending, or failed to send) has no cost line. */
export function promptCostLine(state: "pending" | "promoted" | "consumed" | undefined, hasUnit: boolean, readState: "loading" | "ready" | "unavailable" | undefined): PromptCostLine | undefined {
  if (state === undefined || state === "pending") return undefined
  if (hasUnit) return { kind: "unit" }
  return { kind: readState === "loading" ? "loading" : "unreported" }
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
  return [
    `Measured generation median ${rate(speed?.generationP50TokensPerSecond)} · p90 ${rate(speed?.generationP90TokensPerSecond)}`,
    speed === undefined ? "Generation sample coverage unreported" : `${count(speed.generationSamples)} measured requests · ${count(speed.providerTimedSamples)} provider-timed · ${count(speed.observedSamples)} observed`,
    `Weighted throughput ${rate(speed?.outputTokensPerSecond)} · ${speed === undefined ? "unreported" : count(speed.samples)} first-output latency samples`,
  ]
}

export function forecastLines(forecast: ForecastPresentation, now: number, asOf = now) {
  const amount = (value: number) => forecast.unit === "usd" ? currency(value) : `${count(value)} ${forecast.unit === "percent" ? "percentage points" : forecast.unit}`
  const state = forecast.state === "unlimited" ? "Unlimited" : forecast.state === "exhausted" ? "Exhausted" : forecast.state === "insufficient" ? "Forecast unavailable" : "Estimated forecast"
  return [
    state,
    ...(forecast.ratePerHour === undefined ? [] : [`Quota burn ${amount(forecast.ratePerHour)}/hour`]),
    ...(forecast.exhaustionAt === undefined ? [] : [`Estimated exhaustion ${forecast.exhaustionAt <= asOf ? "now" : new Date(forecast.exhaustionAt).toISOString()}`]),
    ...(forecast.projectedUsedAtReset === undefined ? [] : [`Projected at reset ${amount(forecast.projectedUsedAtReset)}`]),
    `${forecast.method === "quota-delta-ema" ? "Recent quota deltas · 15m half-life · 1h horizon" : forecast.method === "window-mean" ? "Window mean" : "No supported method"} · ${forecast.evidence} evidence`,
    ...(forecast.observedFrom === undefined || forecast.observedTo === undefined ? [] : [`Observed ${new Date(forecast.observedFrom).toISOString()} – ${new Date(forecast.observedTo).toISOString()}`]),
    `Updated ${Math.floor(Math.max(0, now - forecast.updatedAt) / 60_000)}m ago`,
    ...(forecast.reason ? [forecast.reason] : []),
  ]
}
