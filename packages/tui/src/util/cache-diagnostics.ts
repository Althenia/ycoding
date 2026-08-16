import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { Locale } from "./locale"

export function formatDiagnosticsModel(model: SessionCacheDiagnostics["model"] | undefined) {
  if (!model) return
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function cacheHitPercent(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined
}

const cacheToken = (value: number, reported: boolean, suffix: string) =>
  reported ? `${Locale.number(value)} ${suffix}` : `not reported ${suffix}`

const requestMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})

export interface ProviderRequestDiagnostics {
  readonly logical: number
  readonly physical: number
  readonly helpers: number
  readonly continued: number
  readonly fallback: number
  readonly cost?: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly latestInvalidation?:
    | "first-request"
    | "compaction-reset"
    | "model-switched"
    | "model-variant-switched"
    | "stable-hit"
    | "prefix-changed"
    | "system-prefix-changed"
    | "tool-prefix-changed"
    | "below-minimum"
    | "provider-not-reported"
    | "cache-disabled"
    | "retry-fallback"
  readonly latestNamespace?: string
}

export function cachePrefixLabel(value: ProviderRequestDiagnostics["latestInvalidation"]) {
  switch (value) {
    case "stable-hit":
      return "stable"
    case "first-request":
      return "first"
    case "prefix-changed":
      return "changed"
    case "system-prefix-changed":
      return "system changed"
    case "tool-prefix-changed":
      return "tools changed"
    case "below-minimum":
      return "below minimum"
    case "provider-not-reported":
      return "unreported"
    case "cache-disabled":
      return "disabled"
    case "retry-fallback":
      return "retry"
    default:
      return undefined
  }
}

const invalidationLabel = (value: ProviderRequestDiagnostics["latestInvalidation"]) => {
  switch (value) {
    case "first-request":
      return "First request"
    case "compaction-reset":
      return "Compaction reset"
    case "model-switched":
      return "Model switched"
    case "model-variant-switched":
      return "Model variant switched"
    case "stable-hit":
      return "Stable cache hit"
    case "prefix-changed":
      return "Prompt prefix changed"
    case "system-prefix-changed":
      return "System prefix changed"
    case "tool-prefix-changed":
      return "Tool prefix changed"
    case "below-minimum":
      return "Below cache minimum"
    case "provider-not-reported":
      return "Provider did not report cache"
    case "cache-disabled":
      return "Cache disabled"
    case "retry-fallback":
      return "Retry fallback"
  }
}

const requestTokens = (value: number) => `${Locale.number(value)} tokens`

export function formatProviderRequestDiagnostics(requests: ProviderRequestDiagnostics) {
  return {
    logical: String(requests.logical),
    physical: String(requests.physical),
    helpers: String(requests.helpers),
    continued: String(requests.continued),
    fallback: String(requests.fallback),
    uncachedInput: requestTokens(requests.tokens.input),
    cacheRead: requestTokens(requests.tokens.cache.read),
    cacheWrite: requestTokens(requests.tokens.cache.write),
    output: requestTokens(requests.tokens.output),
    reasoning: requestTokens(requests.tokens.reasoning),
    estimatedCost: requests.cost === undefined ? "unavailable" : requestMoney.format(requests.cost),
    latestInvalidation: invalidationLabel(requests.latestInvalidation),
    latestNamespace: requests.latestNamespace,
  }
}

export function formatCacheDiagnostics(diagnostics: SessionCacheDiagnostics) {
  const hitPercent = cacheHitPercent(diagnostics.cache.hitRatio)
  const cacheRead = cacheToken(diagnostics.tokens.cacheRead, diagnostics.cache.readReported, "read")
  const cacheWrite = cacheToken(diagnostics.tokens.cacheWrite, diagnostics.cache.writeReported, "write")
  return {
    model: formatDiagnosticsModel(diagnostics.model),
    context:
      diagnostics.context.limit === undefined
        ? `Context ${Locale.number(diagnostics.context.total)} (includes cached)`
        : `Context ${Locale.number(diagnostics.context.total)}/${Locale.number(diagnostics.context.limit)} (${diagnostics.context.percent}%; includes cached)`,
    cache: `Prompt ${hitPercent === undefined ? "n/a" : `${hitPercent}%`} · ${cacheRead} · ${cacheWrite} · ${Locale.number(diagnostics.tokens.uncachedInput)} uncached`,
  }
}
