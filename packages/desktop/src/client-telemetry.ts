import type { TelemetryBatch } from "./contract"

type ClientSample = Extract<TelemetryBatch["samples"][number], { kind: "client" }>

export function createClientTelemetry(input: { enabled: () => boolean; append: (batch: TelemetryBatch) => Promise<unknown>; error: (cause: unknown) => void }) {
  let samples: ClientSample[] = []
  let flushing = false
  let generation = 0
  return {
    record(metric: ClientSample["metric"], durationMs: number, at = Date.now()) {
      if (!input.enabled() || !Number.isFinite(durationMs) || !Number.isFinite(at) || at < 0 || at > 253_402_300_799_999) return
      samples.push({ kind: "client", surface: "web", metric, at: new Date(at).toISOString(), durationMs: Math.min(600_000, Math.max(0, Math.round(durationMs))) })
      if (samples.length > 20) samples.shift()
    },
    reset() { generation++; samples = []; flushing = false },
    async flush() {
      if (flushing || !input.enabled() || !samples.length) return
      const owner = generation
      const batch = samples
      samples = []; flushing = true
      try { await input.append({ samples: batch }) }
      catch (cause) { if (generation === owner) input.error(cause) }
      finally { if (generation === owner) flushing = false }
    },
  }
}
