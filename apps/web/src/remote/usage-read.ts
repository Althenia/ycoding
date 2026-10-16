import type { RemoteUsageBreakdown, RemoteUsageCost, RemoteUsageForecast, RemoteUsagePromptCostsValue, RemoteUsageTaskCostsValue } from "@ycoding-ai/remote"

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0

export function readUsageCost(value: unknown): RemoteUsageCost | undefined {
  if (!record(value) || !count(value.pricedRequests) || !count(value.unpricedRequests) ||
    value.known !== undefined && !amount(value.known) || value.total !== undefined && !amount(value.total) ||
    (value.known === undefined) !== (value.pricedRequests === 0) ||
    (value.known === undefined) !== (value.provenance === undefined) ||
    value.provenance !== undefined && value.provenance !== "recorded" && value.provenance !== "current_catalog" ||
    value.total !== undefined && (value.unpricedRequests !== 0 || value.total !== value.known)) return undefined
  return value as RemoteUsageCost
}

function breakdown(value: unknown): value is RemoteUsageBreakdown {
  return record(value) && count(value.requests) && record(value.tokens) && [value.tokens.input, value.tokens.output, value.tokens.reasoning].every(count) &&
    record(value.tokens.cache) && [value.tokens.cache.read, value.tokens.cache.write].every(count) && readUsageCost(value.cost) !== undefined
}

function unit(value: unknown) {
  return record(value) && (value.status === "settled" || value.status === "so-far") &&
    (value.attribution === "complete" || value.attribution === "partial" || value.attribution === "unattributed") &&
    (value.history === "retained" || value.history === "partial") && breakdown(value.total) && breakdown(value.main) && breakdown(value.children) &&
    Array.isArray(value.helpers) && value.helpers.every((helper) => record(helper) && ["step", "title", "goal", "compaction", "decision", "prediction", "prompt"].includes(String(helper.source)) && breakdown(helper))
}

export function readPromptCosts(value: unknown): RemoteUsagePromptCostsValue["data"] | undefined {
  if (!record(value) || !Array.isArray(value.units) || value.units.length > 100 || !breakdown(value.unattributed) ||
    value.history !== "retained" && value.history !== "partial" || !value.units.every((item) => unit(item) && record(item) && record(item.anchor) && typeof item.anchor.sessionID === "string" && typeof item.anchor.inputID === "string")) return undefined
  return value as RemoteUsagePromptCostsValue["data"]
}

export function readTaskCosts(value: unknown): RemoteUsageTaskCostsValue["data"] | undefined {
  if (!record(value) || !Array.isArray(value.tasks) || value.tasks.length > 100 || !breakdown(value.total) ||
    value.history !== "retained" && value.history !== "partial" || !value.tasks.every((item) => unit(item) && record(item) && typeof item.sessionID === "string")) return undefined
  return value as RemoteUsageTaskCostsValue["data"]
}

export function readUsageForecast(value: unknown): RemoteUsageForecast | undefined {
  if (!record(value) || !count(value.asOf) || value.localScope !== "backend" && value.localScope !== "location" || value.localRates !== undefined && !Array.isArray(value.localRates) || value.quotas !== undefined && !Array.isArray(value.quotas)) return undefined
  if (!(value.localRates ?? []).every((rate) => record(rate) && typeof rate.providerID === "string" && (rate.profile === undefined || typeof rate.profile === "string") &&
    count(rate.observedFrom) && count(rate.observedTo) && amount(rate.tokensPerMinute) && [rate.tokensPerMinute5, rate.tokensPerMinute60, rate.estimatedUSDPerHour].every((item) => item === undefined || amount(item)) &&
    record(rate.coverage) && count(rate.coverage.pricedRequests) && count(rate.coverage.unpricedRequests))) return undefined
  if (!(value.quotas ?? []).every((quota) => record(quota) && typeof quota.providerID === "string" && typeof quota.windowID === "string" &&
    (quota.profile === undefined || typeof quota.profile === "string") && ["percent", "usd", "requests", "tokens", "count"].includes(String(quota.unit)) &&
    ["estimated", "insufficient", "exhausted", "unlimited"].includes(String(quota.state)) && ["low", "medium", "insufficient"].includes(String(quota.evidence)) &&
    ["provider_api", "local_client_rpc", "response_headers", "response_stream", "provider_internal_api", "local_session"].includes(String(quota.source)) &&
    ["stable", "client_contract", "observed", "best_effort"].includes(String(quota.stability)) && count(quota.updatedAt) &&
    (quota.method === undefined || quota.method === "quota-delta-ema" || quota.method === "window-mean") && (quota.reason === undefined || typeof quota.reason === "string") &&
    [quota.observedFrom, quota.observedTo, quota.exhaustionAt].every((item) => item === undefined || count(item)) && [quota.ratePerHour, quota.projectedUsedAtReset].every((item) => item === undefined || amount(item)))) return undefined
  return value as RemoteUsageForecast
}
