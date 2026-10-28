import { expect, test } from "bun:test"
import type { SessionCacheDiagnostics } from "@ycoding-ai/client"
import { formatTokensPerSecond, generationSpeedDisplay, speedTrend } from "../src/util/generation-speed"

type History = NonNullable<SessionCacheDiagnostics["generationSpeed"]>
type Live = NonNullable<History["live"]>

const model = { providerID: "openai", id: "gpt-5.6", variant: "high" }
const other = { providerID: "anthropic", id: "claude-opus-5" }
const speed = (tokensPerSecond: number, extra: { estimated?: boolean; model?: typeof model } = {}) => ({
  model: extra.model ?? model,
  tokens: 100,
  durationNs: 2_000_000_000,
  tokensPerSecond,
  estimated: extra.estimated ?? true,
})
const live = (phase: Live["phase"], extra: Partial<Live> = {}): History => ({
  model,
  recent: [],
  latest: speed(5_000),
  live: { requestID: "prq_live" as Live["requestID"], attempt: 1, phase, ...extra },
})
const label = (history: History, selected?: typeof model | typeof other) => generationSpeedDisplay(history, selected)?.label

const rows: Array<[string, History, string | undefined]> = [
  ["preparing without output", live("preparing"), "Waiting"],
  ["waiting without output", live("waiting"), "Waiting"],
  ["waiting with first output known", live("waiting", { firstOutputMs: 1_250 }), "Waiting · TTFT 1,250 ms"],
  ["preparing never shows the settled rate", live("preparing", { sample: undefined }), "Waiting"],
  ["streaming with a sample", live("streaming", { sample: speed(42) }), "≈ 42 tok/s"],
  ["streaming with a measured non-estimated sample", live("streaming", { sample: speed(42, { estimated: false }) }), "42 tok/s"],
  ["streaming without a sample", live("streaming", { firstOutputMs: 300 }), "measuring"],
  ["reasoning with a sample", live("reasoning", { sample: speed(18.4) }), "≈ 18 tok/s reasoning"],
  ["reasoning without a sample", live("reasoning"), "reasoning · measuring"],
  ["tool keeps this attempt's last sample", live("tool", { sample: speed(42) }), "≈ 42 tok/s tool"],
  ["tool falls back to this attempt's final", live("tool", { final: speed(30) }), "≈ 30 tok/s tool"],
  ["tool prefers the sample over the final", live("tool", { sample: speed(42), final: speed(30) }), "≈ 42 tok/s tool"],
  ["tool with nothing measurable never borrows the settled rate", live("tool"), "N/A"],
  ["completed shows the final rate", live("completed", { sample: speed(42), final: speed(37) }), "≈ 37 tok/s"],
  ["completed without a final is insufficient data", live("completed", { sample: speed(42) }), "N/A"],
  ["failed shows the last valid value with status", live("failed", { sample: speed(42) }), "≈ 42 tok/s · failed"],
  ["failed prefers the final", live("failed", { sample: speed(42), final: speed(40) }), "≈ 40 tok/s · failed"],
  ["failed with nothing measurable", live("failed"), "N/A · failed"],
  ["cancelled shows the last valid value with status", live("cancelled", { final: speed(12) }), "≈ 12 tok/s · cancelled"],
  ["cancelled with nothing measurable", live("cancelled"), "N/A · cancelled"],
  ["sub-1 rates keep two significant digits", live("streaming", { sample: speed(0.456) }), "≈ 0.46 tok/s"],
]

test.each(rows)("live attempt: %s", (_name, history, expected) => {
  expect(label(history)).toBe(expected)
  expect(generationSpeedDisplay(history)?.settled).toBe(false)
  expect(generationSpeedDisplay(history)?.trend).toBeUndefined()
})

test("a live attempt never displays the settled latest rate or history", () => {
  const history = { ...live("streaming"), recent: [speed(1_000, { estimated: false }), speed(2_000, { estimated: false })] }
  expect(label(history)).toBe("measuring")
  expect(label(history)).not.toContain("5,000")
})

test("settled latest keeps its estimate marker and shows a trend only for measured history", () => {
  const recent = [speed(3_000, { estimated: false }), speed(6_000, { estimated: false })]
  const measured: History = { model, recent, latest: speed(5_000, { estimated: false }) }
  expect(generationSpeedDisplay(measured)).toEqual({ label: "5,000 tok/s", settled: true, trend: "▄█" })
  expect(generationSpeedDisplay({ ...measured, latest: speed(5_000) })).toEqual({ label: "≈ 5,000 tok/s", settled: true })
  expect(generationSpeedDisplay({ model, recent: [speed(3_000, { estimated: false })], latest: speed(5_000, { estimated: false }) })?.trend).toBeUndefined()
})

test("insufficient settled data hides the speed instead of showing N/A", () => {
  expect(generationSpeedDisplay({ model, recent: [] })).toBeUndefined()
  expect(generationSpeedDisplay(undefined)).toBeUndefined()
  expect(generationSpeedDisplay(null)).toBeUndefined()
})

test("a model switch hides settled values of another model", () => {
  expect(label({ model, recent: [], latest: speed(5_000) }, other)).toBeUndefined()
  expect(label({ model, recent: [], latest: speed(5_000) }, { ...model, variant: "low" })).toBe("≈ 5,000 tok/s")
})

test("a live attempt keeps its own effective model's values when a fallback reroutes it away from the session selection", () => {
  const rerouted = speed(42, { model: other as typeof model })
  expect(label(live("streaming", { sample: rerouted }), model)).toBe("≈ 42 tok/s")
  expect(label(live("reasoning", { sample: rerouted }), model)).toBe("≈ 42 tok/s reasoning")
  expect(label(live("completed", { final: rerouted }), model)).toBe("≈ 42 tok/s")
  expect(label(live("failed", { final: rerouted }), model)).toBe("≈ 42 tok/s · failed")
  expect(label(live("waiting"), other)).toBe("Waiting")
  const settled: History = { model, recent: [], latest: speed(5_000) }
  expect(label(settled, other)).toBeUndefined()
})

test("a sub-1 s completed attempt reports N/A for that attempt while the settled rate returns once live clears", () => {
  const sub = live("completed", { firstOutputMs: 120 })
  expect(label(sub)).toBe("N/A")
  expect(label(sub)).not.toContain("5,000")
  const { live: _, ...settled } = sub
  expect(label(settled)).toBe("≈ 5,000 tok/s")
})

test("after completion the whole-attempt final wins over the last rolling sample", () => {
  expect(label(live("completed", { sample: speed(90), final: speed(60) }))).toBe("≈ 60 tok/s")
  expect(label(live("cancelled", { sample: speed(90), final: speed(60) }))).toBe("≈ 60 tok/s · cancelled")
})

test("a retry attempt shows only its own state", () => {
  const first = live("failed", { sample: speed(42) })
  const retry: History = { ...first, live: { ...first.live!, attempt: 2, phase: "waiting" } }
  expect(label(first)).toBe("≈ 42 tok/s · failed")
  expect(label(retry)).toBe("Waiting")
})

test("rates and trends format deterministically", () => {
  expect(formatTokensPerSecond(1_234.6, true)).toBe("≈ 1,235 tok/s")
  expect(formatTokensPerSecond(1)).toBe("1 tok/s")
  expect(formatTokensPerSecond(0.05)).toBe("0.050 tok/s")
  expect(speedTrend([0, 4, 8])).toBe("▁▄█")
  expect(speedTrend([0, 0])).toBe("▁▁")
})
