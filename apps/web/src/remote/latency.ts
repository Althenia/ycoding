import type { RemoteRequestTiming } from "./transport"

export type LatencySample =
  | {
      readonly kind: "request"
      readonly at: string
      readonly operation: RemoteRequestTiming["operation"] | "account.read"
      readonly outcome: RemoteRequestTiming["outcome"]
      readonly reason?: RemoteRequestTiming["reason"]
      readonly queueMs: number
      readonly settlementMs?: number
      readonly totalMs: number
    }
  | { readonly kind: "long-task"; readonly at: string; readonly durationMs: number }
  | { readonly kind: "client"; readonly at: string; readonly surface: "web"; readonly metric: "prompt.admit" | "stream.delay" | "transcript.load"; readonly durationMs: number }

const maxSamples = 60

export function createLatencyDiagnostics(now = () => Date.now()) {
  const samples: LatencySample[] = []
  const listeners = new Set<(sample?: LatencySample) => void>()
  const longTasksSupported =
    typeof window !== "undefined" &&
    typeof PerformanceObserver !== "undefined" &&
    (PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false)
  let disposed = false
  const record = (sample: LatencySample) => {
    if (disposed) return
    samples.push(sample)
    if (samples.length > maxSamples) samples.shift()
    listeners.forEach((listener) => listener(sample))
  }
  const observer = longTasksSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (Number.isFinite(entry.duration))
            record({ kind: "long-task", at: new Date(now()).toISOString(), durationMs: Math.round(entry.duration) })
        }
      })
    : undefined
  observer?.observe({ entryTypes: ["longtask"] })
  return {
    snapshot: () => ({ longTasksSupported, samples: [...samples] }),
    subscribe: (listener: (sample?: LatencySample) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    recordRequest: (
      timing: RemoteRequestTiming | (Omit<RemoteRequestTiming, "operation"> & { readonly operation: "account.read" }),
    ) =>
      record({
        kind: "request",
        at: new Date(now()).toISOString(),
        operation: timing.operation,
        outcome: timing.outcome,
        ...(timing.reason === undefined ? {} : { reason: timing.reason }),
        queueMs: timing.queueMs,
        ...(timing.settlementMs === undefined ? {} : { settlementMs: timing.settlementMs }),
        totalMs: timing.totalMs,
      }),
    recordClient: (metric: "prompt.admit" | "stream.delay" | "transcript.load", durationMs: number) =>
      record({ kind: "client", at: new Date(now()).toISOString(), surface: "web", metric, durationMs: Math.max(0, Math.min(600_000, Math.round(durationMs))) }),
    clear: () => {
      if (samples.length === 0) return
      samples.length = 0
      listeners.forEach((listener) => listener())
    },
    dispose: () => {
      observer?.disconnect()
      samples.length = 0
      listeners.clear()
      disposed = true
    },
  }
}
