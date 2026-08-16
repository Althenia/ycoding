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
