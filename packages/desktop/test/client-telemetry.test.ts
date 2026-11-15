import { expect, test } from "bun:test"
import { createClientTelemetry } from "../src/client-telemetry"
import type { TelemetryBatch } from "../src/contract"

test("client timing stays off before consent and batches only the latest twenty synthetic samples", async () => {
  let enabled = false
  const batches: TelemetryBatch[] = []
  const errors: unknown[] = []
  const telemetry = createClientTelemetry({ enabled: () => enabled, append: async (batch) => { batches.push(batch) }, error: (cause) => errors.push(cause) })
  telemetry.record("prompt.admit", 12, 0)
  await telemetry.flush()
  expect(batches).toEqual([])
  enabled = true
  for (let duration = 0; duration < 25; duration++) telemetry.record("transcript.load", duration, 0)
  await telemetry.flush()
  expect(batches).toHaveLength(1)
  expect(batches[0]!.samples).toEqual(Array.from({ length: 20 }, (_, index) => ({ kind: "client", surface: "web", metric: "transcript.load", durationMs: index + 5, at: "1970-01-01T00:00:00.000Z" })))
  await telemetry.flush()
  expect(batches).toHaveLength(1)
  expect(errors).toEqual([])
})

test("client durations are finite, bounded integers and contain no prompt or location fields", async () => {
  const batches: TelemetryBatch[] = []
  const telemetry = createClientTelemetry({ enabled: () => true, append: async (batch) => { batches.push(batch) }, error: () => { throw new Error("Unexpected telemetry error") } })
  telemetry.record("stream.delay", Number.NaN, 0)
  telemetry.record("stream.delay", 10, Number.POSITIVE_INFINITY)
  telemetry.record("stream.delay", 10, Number.MAX_VALUE)
  telemetry.record("prompt.admit", -5.1, 0)
  telemetry.record("transcript.load", 700_000, 0)
  telemetry.record("stream.delay", 5.6, 0)
  await telemetry.flush()
  const metrics = ["prompt.admit", "transcript.load", "stream.delay"] as const
  expect(batches[0]!.samples).toEqual([0, 600_000, 6].map((durationMs, index) => ({ kind: "client", surface: "web", metric: metrics[index]!, durationMs, at: "1970-01-01T00:00:00.000Z" })))
})

test("scope replacement discards queued samples and ignores an old append failure", async () => {
  let reject!: (cause: unknown) => void
  const batches: TelemetryBatch[] = []
  const errors: unknown[] = []
  const telemetry = createClientTelemetry({ enabled: () => true, append: (batch) => { batches.push(batch); return batches.length === 1 ? new Promise((_, fail) => { reject = fail }) : Promise.resolve() }, error: (cause) => errors.push(cause) })
  telemetry.record("prompt.admit", 1, 0)
  const retired = telemetry.flush()
  telemetry.record("stream.delay", 2, 0)
  telemetry.reset()
  telemetry.record("transcript.load", 3, 0)
  await telemetry.flush()
  reject(new Error("Synthetic retired connection"))
  await retired
  expect(batches.map((batch) => batch.samples.map((sample) => sample.kind === "client" ? sample.durationMs : undefined))).toEqual([[1], [3]])
  expect(errors).toEqual([])
})

test("append failures are reported without replaying an uncertain batch", async () => {
  let calls = 0
  const errors: unknown[] = []
  const cause = new Error("Synthetic uncertain append")
  const telemetry = createClientTelemetry({ enabled: () => true, append: async () => { calls++; throw cause }, error: (cause) => errors.push(cause) })
  telemetry.record("prompt.admit", 1, 0)
  await telemetry.flush()
  await telemetry.flush()
  expect(calls).toBe(1)
  expect(errors).toEqual([cause])
})

test("a pending flush cannot send another batch and revoked consent prevents a send", async () => {
  let enabled = true
  let settle!: () => void
  const batches: TelemetryBatch[] = []
  const telemetry = createClientTelemetry({ enabled: () => enabled, append: (batch) => { batches.push(batch); return new Promise<void>((resolve) => { settle = resolve }) }, error: () => { throw new Error("Unexpected telemetry error") } })
  telemetry.record("prompt.admit", 1, 0)
  const pending = telemetry.flush()
  telemetry.record("transcript.load", 2, 0)
  await telemetry.flush()
  expect(batches).toHaveLength(1)
  settle(); await pending
  enabled = false
  telemetry.reset()
  await telemetry.flush()
  expect(batches).toHaveLength(1)
})
