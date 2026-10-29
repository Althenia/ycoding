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
  ["preparing without output shows the settled rate", live("preparing"), "≈ 5,000 tok/s"],
  ["waiting without output shows the settled rate", live("waiting"), "≈ 5,000 tok/s"],
  ["waiting with first output known shows the settled rate", live("waiting", { firstOutputMs: 1_250 }), "≈ 5,000 tok/s"],
  ["preparing ignores a stray sample", live("preparing", { sample: undefined }), "≈ 5,000 tok/s"],
  ["streaming with a sample", live("streaming", { sample: speed(42) }), "≈ 42 tok/s"],
  ["streaming with a measured non-estimated sample", live("streaming", { sample: speed(42, { estimated: false }) }), "42 tok/s"],
  ["streaming without a sample shows the settled rate", live("streaming", { firstOutputMs: 300 }), "≈ 5,000 tok/s"],
  ["reasoning with a sample", live("reasoning", { sample: speed(18.4) }), "≈ 18 tok/s reasoning"],
  ["reasoning without a sample shows the settled rate", live("reasoning"), "≈ 5,000 tok/s"],
  ["tool keeps this attempt's last sample", live("tool", { sample: speed(42) }), "≈ 42 tok/s tool"],
  ["tool falls back to this attempt's final", live("tool", { final: speed(30) }), "≈ 30 tok/s tool"],
  ["tool prefers the sample over the final", live("tool", { sample: speed(42), final: speed(30) }), "≈ 42 tok/s tool"],
  ["tool with nothing measurable shows the settled rate", live("tool"), "≈ 5,000 tok/s"],
  ["completed shows the final rate", live("completed", { sample: speed(42), final: speed(37) }), "≈ 37 tok/s"],
  ["completed without a final shows the settled rate", live("completed", { sample: speed(42) }), "≈ 5,000 tok/s"],
  ["failed shows the last valid value with status", live("failed", { sample: speed(42) }), "≈ 42 tok/s · failed"],
  ["failed prefers the final", live("failed", { sample: speed(42), final: speed(40) }), "≈ 40 tok/s · failed"],
  ["failed with nothing measurable shows the settled rate", live("failed"), "≈ 5,000 tok/s"],
  ["cancelled shows the last valid value with status", live("cancelled", { final: speed(12) }), "≈ 12 tok/s · cancelled"],
  ["cancelled with nothing measurable shows the settled rate", live("cancelled"), "≈ 5,000 tok/s"],
  ["sub-1 rates keep two significant digits", live("streaming", { sample: speed(0.456) }), "≈ 0.46 tok/s"],
]

const NO_RATE: Array<[string, Partial<Live> & Pick<Live, "phase">]> = [
  ["preparing", { phase: "preparing" }],
  ["waiting", { phase: "waiting", firstOutputMs: 1_250 }],
  ["reasoning", { phase: "reasoning" }],
  ["streaming", { phase: "streaming", firstOutputMs: 300 }],
  ["tool", { phase: "tool" }],
  ["completed", { phase: "completed", firstOutputMs: 120 }],
  ["failed", { phase: "failed" }],
  ["cancelled", { phase: "cancelled" }],
]
const withoutLatest = (history: History): History => {
  const { latest: _, ...rest } = history
  return rest
}

test.each(rows)("live attempt: %s", (_name, history, expected) => {
  expect(label(history)).toBe(expected)
})

test.each(NO_RATE)("a %s attempt without a rate shows the settled rate and trend", (_name, state) => {
  const recent = [speed(3_000, { estimated: false }), speed(6_000, { estimated: false })]
  const { phase, ...extra } = state
  const history = { ...live(phase, extra), latest: speed(5_000, { estimated: false }), recent }
  expect(generationSpeedDisplay(history)).toEqual({ label: "5,000 tok/s", settled: true, trend: "▄█" })
  expect(generationSpeedDisplay({ ...history, latest: speed(5_000) })).toEqual({ label: "≈ 5,000 tok/s", settled: true })
})

test.each(NO_RATE)("a %s attempt without a rate and without a settled rate hides the speed", (_name, state) => {
  const { phase, ...extra } = state
  expect(generationSpeedDisplay(withoutLatest(live(phase, extra)))).toBeUndefined()
})

test("a no-rate live attempt hides the settled rate of another model", () => {
  expect(label(live("streaming"), other)).toBeUndefined()
})

test("no live state ever renders a placeholder word", () => {
  const states: History[] = [
    ...NO_RATE.map(([, state]) => live(state.phase, state)),
    ...NO_RATE.map(([, state]) => withoutLatest(live(state.phase, state))),
    live("streaming", { sample: speed(42) }),
    live("failed", { final: speed(40) }),
  ]
  for (const history of states) expect(label(history) ?? "").not.toMatch(/Waiting|N\/A|measuring/)
})

test("a live attempt shows its own rate and never the settled history", () => {
  const history = { ...live("streaming", { sample: speed(42) }), recent: [speed(1_000, { estimated: false }), speed(2_000, { estimated: false })] }
  expect(generationSpeedDisplay(history)).toEqual({ label: "≈ 42 tok/s", settled: false })
})

test("settled latest keeps its estimate marker and shows a trend only for measured history", () => {
  const recent = [speed(3_000, { estimated: false }), speed(6_000, { estimated: false })]
  const measured: History = { model, recent, latest: speed(5_000, { estimated: false }) }
  expect(generationSpeedDisplay(measured)).toEqual({ label: "5,000 tok/s", settled: true, trend: "▄█" })
  expect(generationSpeedDisplay({ ...measured, latest: speed(5_000) })).toEqual({ label: "≈ 5,000 tok/s", settled: true })
  expect(generationSpeedDisplay({ model, recent: [speed(3_000, { estimated: false })], latest: speed(5_000, { estimated: false }) })?.trend).toBeUndefined()
})

test("insufficient settled data hides the speed", () => {
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
  expect(label(live("waiting"), other)).toBeUndefined()
  const settled: History = { model, recent: [], latest: speed(5_000) }
  expect(label(settled, other)).toBeUndefined()
})

test("a sub-1 s completed attempt shows the settled rate", () => {
  const sub = live("completed", { firstOutputMs: 120 })
  expect(label(sub)).toBe("≈ 5,000 tok/s")
  const { live: _, ...settled } = sub
  expect(label(settled)).toBe("≈ 5,000 tok/s")
})

test("after completion the whole-attempt final wins over the last rolling sample", () => {
  expect(label(live("completed", { sample: speed(90), final: speed(60) }))).toBe("≈ 60 tok/s")
  expect(label(live("cancelled", { sample: speed(90), final: speed(60) }))).toBe("≈ 60 tok/s · cancelled")
})

test("a retry attempt shows its own rate or the settled rate", () => {
  const first = live("failed", { sample: speed(42) })
  const retry: History = { ...first, live: { ...first.live!, attempt: 2, phase: "waiting" } }
  expect(label(first)).toBe("≈ 42 tok/s · failed")
  expect(label(retry)).toBe("≈ 5,000 tok/s")
})

test("rates and trends format deterministically", () => {
  expect(formatTokensPerSecond(1_234.6, true)).toBe("≈ 1,235 tok/s")
  expect(formatTokensPerSecond(1)).toBe("1 tok/s")
  expect(formatTokensPerSecond(0.05)).toBe("0.050 tok/s")
  expect(speedTrend([0, 4, 8])).toBe("▁▄█")
  expect(speedTrend([0, 0])).toBe("▁▁")
})
