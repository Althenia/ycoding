export * as ProviderUsageForecast from "./forecast"

import type { ProviderUsage } from "@ycoding-ai/schema/provider-usage"

const minute = 60_000
const hour = 60 * minute
const halfLife = 15 * minute
const freshness = 10 * minute
const binWidth = 5 * minute

export type Semantics = "fixed-reset" | "balance" | "rolling" | "unknown"

interface ObservationInput {
  readonly account: string
  readonly snapshot: ProviderUsage.Snapshot
  readonly semantics: Semantics
}

interface QuotaInput {
  readonly account?: string
  readonly snapshot: ProviderUsage.Snapshot
  readonly window: ProviderUsage.Window
  readonly now: number
  readonly semantics: Semantics
  readonly wholeWindowMean?: boolean
}

export interface Estimate {
  readonly state: "estimated" | "insufficient" | "exhausted" | "unlimited"
  readonly evidence: "low" | "medium" | "insufficient"
  readonly method?: "quota-delta-ema" | "window-mean"
  readonly reason?: string
  readonly observedFrom?: number
  readonly observedTo?: number
  readonly ratePerHour?: number
  readonly exhaustionAt?: number
  readonly projectedUsedAtReset?: number
}

interface Point {
  readonly at: number
  readonly value: number
  readonly remaining?: number
}

interface Series {
  readonly account: string
  readonly snapshot: ProviderUsage.Snapshot
  readonly window: ProviderUsage.Window
  readonly semantics: Semantics
  readonly signature: string
  readonly points: ReadonlyArray<Point>
  readonly corrected: boolean
}

const signature = (window: ProviderUsage.Window, semantics: Semantics) =>
  JSON.stringify([
    window.unit,
    window.resetAt,
    window.limit,
    window.periodSeconds,
    window.unlimited,
    window.used === undefined ? "remaining" : "used",
    semantics,
  ])

const key = (account: string, providerID: string, windowID: string, source: ProviderUsage.Source) =>
  JSON.stringify([account, providerID, windowID, source])
const amount = (window: ProviderUsage.Window) =>
  window.used ?? (window.remaining === undefined ? undefined : -window.remaining)
const insufficient = (reason: string): Estimate => ({ state: "insufficient", evidence: "insufficient", reason })

export function make(input: { readonly maxSeries?: number; readonly maxObservations?: number } = {}) {
  const history = new Map<string, Series>()
  const maxSeries = Math.max(1, Math.min(256, input.maxSeries ?? 256))
  const maxObservations = Math.max(3, Math.min(256, input.maxObservations ?? 256))

  return {
    observe(request: ObservationInput) {
      if (request.snapshot.status !== "available") return
      for (const window of request.snapshot.windows) {
        const value = amount(window)
        if (value === undefined || !Number.isFinite(value) || !Number.isFinite(request.snapshot.updatedAt)) continue
        const id = key(request.account, request.snapshot.providerID, window.id, request.snapshot.source)
        const current = history.get(id)
        const latest = current?.points.at(-1)
        if (latest && latest.at > request.snapshot.updatedAt) continue
        const nextSignature = signature(window, request.semantics)
        if (
          latest?.at === request.snapshot.updatedAt &&
          latest.value === value &&
          latest.remaining === window.remaining &&
          current?.signature === nextSignature
        )
          continue
        const corrected =
          latest !== undefined &&
          (value < latest.value ||
            latest.at === request.snapshot.updatedAt ||
            (latest.remaining !== undefined && window.remaining !== undefined && window.remaining > latest.remaining))
        const comparable = current?.signature === nextSignature && !corrected
        const points = [
          ...(comparable
            ? current.points.filter(
                (point) =>
                  point.at >= request.snapshot.updatedAt - hour &&
                  Math.floor(point.at / 15_000) !== Math.floor(request.snapshot.updatedAt / 15_000),
              )
            : []),
          { at: request.snapshot.updatedAt, value, remaining: window.remaining },
        ].slice(-maxObservations)
        history.delete(id)
        history.set(id, {
          account: request.account,
          snapshot: request.snapshot,
          window,
          semantics: request.semantics,
          signature: nextSignature,
          points,
          corrected: corrected || (comparable && current.corrected),
        })
        while (history.size > maxSeries) history.delete(history.keys().next().value!)
      }
    },

    quota(request: QuotaInput): Estimate & Pick<ProviderUsage.Snapshot, "source" | "stability" | "updatedAt"> {
      const current =
        request.account === undefined
          ? undefined
          : history.get(key(request.account, request.snapshot.providerID, request.window.id, request.snapshot.source))
      const result = calculate(request, current)
      const candidates =
        !request.account || result.state === "exhausted" || result.state === "unlimited"
          ? []
          : [...history.values()]
              .filter(
                (series) =>
                  series.account === request.account &&
                  series.snapshot.providerID === request.snapshot.providerID &&
                  series.window.id === request.window.id &&
                  series.signature === signature(request.window, request.semantics) &&
                  (request.snapshot.status === "available" || series.snapshot.source !== request.snapshot.source),
              )
              .toSorted((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt)
      const selected = candidates
        .map((series) => ({
          series,
          result: calculate(
            { ...request, snapshot: series.snapshot, window: series.window, semantics: series.semantics },
            series,
          ),
        }))
        .find((candidate) => candidate.result.state !== "insufficient")
      return {
        ...(selected?.result ?? result),
        source: selected?.series.snapshot.source ?? request.snapshot.source,
        stability: selected?.series.snapshot.stability ?? request.snapshot.stability,
        updatedAt: selected?.series.snapshot.updatedAt ?? request.snapshot.updatedAt,
      }
    },
  }
}

function calculate(request: QuotaInput, current?: Series): Estimate {
  const window = request.window
  const at = request.snapshot.updatedAt
  if (!request.account) return insufficient("Quota account is unbound")
  if (request.snapshot.status !== "available" || request.now - at > freshness || at > request.now)
    return insufficient("Quota observations are stale")
  if (window.resetAt !== undefined && window.resetAt <= request.now) return insufficient("Quota window has expired")
  if (window.unlimited === true) return { state: "unlimited", evidence: "low" }
  if (window.unit === "percent" && window.used !== undefined && window.used >= 100)
    return { state: "exhausted", evidence: "low" }
  if (request.semantics === "unknown" || request.semantics === "rolling")
    return insufficient("Quota window semantics do not support projection")
  const remaining =
    window.remaining ??
    (window.limit === undefined || window.used === undefined ? undefined : Math.max(0, window.limit - window.used))
  if (remaining === 0) return { state: "exhausted", evidence: "low" }
  if (current?.signature !== signature(window, request.semantics)) return insufficient("Collecting observations")
  const points = current.points.filter((point) => point.at >= request.now - hour && point.at <= at)
  const first = points[0]
  const last = points.at(-1)
  const resolution = window.unit === "usd" ? 0.01 : 1
  const consumption = first && last ? last.value - first.value : 0
  const deltas = points
    .slice(1)
    .map((point, index) => ({ duration: point.at - points[index].at, consumed: point.value - points[index].value }))
  const sufficient = points.length >= 3 && last!.at - first.at >= 10 * minute && consumption >= resolution
  const meanStart =
    window.resetAt === undefined || !window.periodSeconds ? undefined : window.resetAt - window.periodSeconds * 1000
  const mean =
    request.wholeWindowMean &&
    request.semantics === "fixed-reset" &&
    !current.corrected &&
    (points.length < 3 || last!.at - first.at < 10 * minute) &&
    meanStart !== undefined &&
    meanStart >= 0 &&
    at - meanStart >= 10 * minute &&
    window.used !== undefined &&
    window.used >= resolution
  if (!sufficient && !mean) {
    if (points.length < 3 || !first || !last || last.at - first.at < 10 * minute)
      return insufficient("Collecting observations")
    return insufficient(consumption === 0 ? "No increase observed" : "Consumption below reporting resolution")
  }
  const ratePerHour = sufficient
    ? deltas.reduce((rate, delta, index) => {
        const next = (delta.consumed * hour) / delta.duration
        return index === 0 ? next : rate + (next - rate) * (1 - 2 ** (-delta.duration / halfLife))
      }, 0)
    : (window.used! * hour) / (at - meanStart!)
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return insufficient("No increase observed")
  const exhaustionAt = remaining === undefined ? undefined : at + (remaining * hour) / ratePerHour
  const used =
    window.used ??
    (window.limit === undefined || window.remaining === undefined
      ? undefined
      : Math.max(0, window.limit - window.remaining))
  const projectedUsedAtReset =
    request.semantics === "fixed-reset" && window.resetAt !== undefined && used !== undefined
      ? used + (ratePerHour * (window.resetAt - at)) / hour
      : undefined
  return {
    state: "estimated",
    evidence: sufficient && deltas.filter((delta) => delta.consumed > 0).length >= 2 ? "medium" : "low",
    method: sufficient ? "quota-delta-ema" : "window-mean",
    observedFrom: sufficient ? first.at : meanStart,
    observedTo: at,
    ratePerHour,
    ...(exhaustionAt === undefined ||
    !Number.isFinite(exhaustionAt) ||
    (window.resetAt !== undefined && exhaustionAt >= window.resetAt)
      ? {}
      : { exhaustionAt: Math.trunc(exhaustionAt) }),
    ...(projectedUsedAtReset === undefined || !Number.isFinite(projectedUsedAtReset) ? {} : { projectedUsedAtReset }),
  }
}

export interface LocalBin {
  readonly start: number
  readonly tokens: number
  readonly knownUSD?: number
  readonly pricedRequests: number
  readonly unpricedRequests: number
}

export function localRates(bins: ReadonlyArray<LocalBin>, asOf: number) {
  const observedFrom = asOf - hour
  const values = Array.from({ length: 12 }, (_, index) => {
    const start = observedFrom + index * binWidth
    return bins
      .filter((bin) => bin.start >= start && bin.start < start + binWidth)
      .reduce(
        (total, bin) => ({
          tokens: total.tokens + bin.tokens,
          knownUSD: total.knownUSD + (bin.knownUSD ?? 0),
          costReported:
            total.costReported && (bin.knownUSD !== undefined || bin.pricedRequests + bin.unpricedRequests === 0),
          pricedRequests: total.pricedRequests + bin.pricedRequests,
          unpricedRequests: total.unpricedRequests + bin.unpricedRequests,
        }),
        { tokens: 0, knownUSD: 0, costReported: true, pricedRequests: 0, unpricedRequests: 0 },
      )
  })
  const coverage = values.reduce(
    (total, bin) => ({
      pricedRequests: total.pricedRequests + bin.pricedRequests,
      unpricedRequests: total.unpricedRequests + bin.unpricedRequests,
    }),
    { pricedRequests: 0, unpricedRequests: 0 },
  )
  const weights = values.map((_, index) => 2 ** ((-(11 - index) * binWidth) / halfLife))
  const weight = weights.reduce((total, value) => total + value, 0)
  return {
    observedFrom,
    observedTo: asOf,
    tokensPerMinute5: values.at(-1)!.tokens / 5,
    tokensPerMinute60: values.reduce((total, bin) => total + bin.tokens, 0) / 60,
    tokensPerMinute: values.reduce((total, bin, index) => total + (bin.tokens / 5) * weights[index], 0) / weight,
    ...(coverage.unpricedRequests > 0 || coverage.pricedRequests === 0 || values.some((bin) => !bin.costReported)
      ? {}
      : {
          estimatedUSDPerHour:
            values.reduce((total, bin, index) => total + bin.knownUSD * 12 * weights[index], 0) / weight,
        }),
    coverage,
  }
}
