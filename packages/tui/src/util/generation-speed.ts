import type { SessionCacheDiagnostics } from "@ycoding-ai/client"

type History = NonNullable<SessionCacheDiagnostics["generationSpeed"]>
type Speed = NonNullable<History["latest"]>
type Live = NonNullable<History["live"]>
type ModelIdentity = { readonly providerID: string; readonly id: string }

export type GenerationSpeedDisplay = {
  readonly label: string
  readonly settled: boolean
  readonly trend?: string
}

const LEVELS = "▁▂▃▄▅▆▇█"

export function formatTokensPerSecond(rate: number, estimated?: boolean) {
  const value = rate >= 1 ? Math.round(rate).toLocaleString("en-US") : rate.toPrecision(2)
  return `${estimated ? "≈ " : ""}${value} tok/s`
}

export function speedTrend(values: readonly number[]) {
  const peak = Math.max(0, ...values)
  return values.map((value) => (peak <= 0 ? LEVELS[0] : LEVELS[Math.min(7, Math.floor((value / peak) * 7))])).join("")
}

const sameModel = (left: ModelIdentity, right: ModelIdentity) => left.providerID === right.providerID && left.id === right.id

const rate = (speed: Speed) => formatTokensPerSecond(speed.tokensPerSecond, speed.estimated)

function liveLabel(live: Live) {
  if (live.phase === "reasoning") return live.sample ? `${rate(live.sample)} reasoning` : undefined
  if (live.phase === "streaming") return live.sample ? rate(live.sample) : undefined
  if (live.phase === "tool") {
    const value = live.sample ?? live.final
    return value ? `${rate(value)} tool` : undefined
  }
  if (live.phase === "completed") return live.final ? rate(live.final) : undefined
  if (live.phase === "failed" || live.phase === "cancelled") {
    const value = live.final ?? live.sample
    return value ? `${rate(value)} · ${live.phase}` : undefined
  }
  return undefined
}

export function generationSpeedDisplay(
  history: History | null | undefined,
  selected?: ModelIdentity,
): GenerationSpeedDisplay | undefined {
  if (!history) return undefined
  const live = history.live ? liveLabel(history.live) : undefined
  if (live !== undefined) return { label: live, settled: false }
  const latest = history.latest
  if (!latest) return undefined
  if (selected && !sameModel(latest.model, selected)) return undefined
  const trend = !latest.estimated && history.recent.length >= 2
    ? speedTrend(history.recent.map((sample) => sample.tokensPerSecond))
    : undefined
  return { label: rate(latest), settled: true, ...(trend ? { trend } : {}) }
}
