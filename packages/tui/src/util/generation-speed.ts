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

export function formatFirstOutput(ms: number) {
  return `TTFT ${ms.toLocaleString("en-US")} ms`
}

export function speedTrend(values: readonly number[]) {
  const peak = Math.max(0, ...values)
  return values.map((value) => (peak <= 0 ? LEVELS[0] : LEVELS[Math.min(7, Math.floor((value / peak) * 7))])).join("")
}

const sameModel = (left: ModelIdentity, right: ModelIdentity) => left.providerID === right.providerID && left.id === right.id

const rate = (speed: Speed) => formatTokensPerSecond(speed.tokensPerSecond, speed.estimated)

function liveLabel(live: Live) {
  if (live.phase === "preparing" || live.phase === "waiting")
    return live.firstOutputMs === undefined ? "Waiting" : `Waiting · ${formatFirstOutput(live.firstOutputMs)}`
  if (live.phase === "reasoning") return live.sample ? `${rate(live.sample)} reasoning` : "reasoning · measuring"
  if (live.phase === "streaming") return live.sample ? rate(live.sample) : "measuring"
  if (live.phase === "tool") {
    const value = live.sample ?? live.final
    return value ? `${rate(value)} tool` : "N/A"
  }
  if (live.phase === "completed") return live.final ? rate(live.final) : "N/A"
  const value = live.final ?? live.sample
  return `${value ? rate(value) : "N/A"} · ${live.phase}`
}

export function generationSpeedDisplay(
  history: History | null | undefined,
  selected?: ModelIdentity,
): GenerationSpeedDisplay | undefined {
  if (!history) return undefined
  if (history.live) return { label: liveLabel(history.live), settled: false }
  const latest = history.latest
  if (!latest) return undefined
  if (selected && !sameModel(latest.model, selected)) return undefined
  const trend = !latest.estimated && history.recent.length >= 2
    ? speedTrend(history.recent.map((sample) => sample.tokensPerSecond))
    : undefined
  return { label: rate(latest), settled: true, ...(trend ? { trend } : {}) }
}
