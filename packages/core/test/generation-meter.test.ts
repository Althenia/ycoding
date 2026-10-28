import { expect, test } from "bun:test"
import { LLMEvent } from "@ycoding-ai/ai"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { GenerationMeter } from "../src/session/generation-meter"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"

const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("meter") })
const requestID = ProviderRequest.ID.make("prq_meter")
const s = (seconds: number) => BigInt(Math.round(seconds * 1_000_000_000))
const text = (value: string) => LLMEvent.textDelta({ id: "text", text: value })
const reasoning = (value: string) => LLMEvent.reasoningDelta({ id: "reasoning", text: value })
const meter = (attempt = 1) => GenerationMeter.make({ requestID, attempt, model, startedNs: 0n })
const speed = (tokens: number, seconds: number) =>
  ({ model, tokens, durationNs: seconds * 1_000_000_000, tokensPerSecond: tokens / seconds, estimated: true })

test("reports waiting, first-output latency, and a rolling sample after one second of output", () => {
  const current = meter()
  expect(current.live()).toEqual({ requestID, attempt: 1, phase: "preparing" })
  current.waiting(s(0.1))
  expect(current.live()).toEqual({ requestID, attempt: 1, phase: "waiting" })
  expect(current.observe(LLMEvent.textStart({ id: "text" }), s(1))).toBeUndefined()
  expect(current.observe(text("a".repeat(4_000)), s(2))).toBe("phase")
  expect(current.live()).toEqual({ requestID, attempt: 1, phase: "streaming", firstOutputMs: 2_000 })
  expect(current.observe(text("b".repeat(160)), s(3))).toBe("output")
  expect(current.live().sample).toEqual(speed(40, 1))
  current.observe(text("c".repeat(160)), s(4))
  expect(current.live()).toEqual({ requestID, attempt: 1, phase: "streaming", firstOutputMs: 2_000, sample: speed(80, 2) })
})

test("estimates cumulative output independently of chunk boundaries", () => {
  const whole = meter()
  const split = meter()
  whole.observe(text("xxxxxxxxxxxx"), s(0))
  whole.observe(text("xxxxxxxxxxxx"), s(2))
  for (const chunk of ["xx", "xx", "xx", "xx", "xx", "xx"]) split.observe(text(chunk), s(0))
  for (const chunk of ["x", "xxx", "xxxxxxxx"]) split.observe(text(chunk), s(2))
  expect(split.outputTokens()).toBe(6)
  expect(split.outputTokens()).toBe(whole.outputTokens())
  expect(split.live().sample).toEqual(whole.live().sample)
  const rounding = meter()
  for (const [index, chunk] of ["xx", "xx", "xx", "xx", "xx", "xx"].entries()) rounding.observe(text(chunk), s(index))
  expect(rounding.outputTokens()).toBe(3)
})

test("separates reasoning, streaming, and tool phases while counting every received output kind", () => {
  const current = meter()
  expect(current.observe(reasoning("r".repeat(400)), s(1))).toBe("phase")
  expect(current.phase()).toBe("reasoning")
  expect(current.observe(reasoning("r".repeat(400)), s(2))).toBe("output")
  expect(current.live().sample).toEqual(speed(100, 1))
  expect(current.observe(text("t".repeat(400)), s(3))).toBe("phase")
  expect(current.phase()).toBe("streaming")
  expect(current.observe(LLMEvent.toolInputDelta({ id: "call", name: "write", text: "i".repeat(400) }), s(4))).toBe("output")
  expect(current.phase()).toBe("streaming")
  expect(current.observe(LLMEvent.toolCall({ id: "call", name: "write", input: { path: "x" } }), s(4.5))).toBe("phase")
  expect(current.phase()).toBe("tool")
  expect(current.outputTokens()).toBe(400)
  expect(current.live().sample).toEqual(speed(300, 3))
  current.observe(LLMEvent.toolCall({ id: "other", name: "read", input: { path: "abcdefghijklmnop" } }), s(5))
  expect(current.outputTokens()).toBe(407)
  current.observe(LLMEvent.toolCall({ id: "other", name: "read", input: { path: "abcdefghijklmnop" } }), s(5.5))
  expect(current.outputTokens()).toBe(407)
  expect(current.live().firstOutputMs).toBe(1_000)
})

test("keeps a measured baseline across a stall longer than the rolling window", () => {
  const current = meter()
  current.observe(text("a".repeat(4_000)), s(0))
  for (const second of [1, 2, 3]) current.observe(text("b".repeat(160)), s(second))
  expect(current.live().sample).toEqual(speed(120, 3))
  current.observe(text("c".repeat(160)), s(10))
  expect(current.live().sample).toEqual(speed(40, 7))
  for (const second of [11, 12, 13, 14, 15, 16]) current.observe(text("d".repeat(160)), s(second))
  expect(current.live().sample).toEqual(speed(200, 5))
})

test("keeps bursty arrivals coalesced to the same rate", () => {
  const current = meter()
  current.observe(text("a".repeat(4_000)), s(0))
  for (let index = 1; index <= 100_000; index++) current.observe(text("bbbb"), BigInt(index) * 100_000n)
  expect(current.outputTokens()).toBe(101_000)
  const sample = current.live().sample
  expect(sample?.tokensPerSecond).toBeCloseTo(10_000, 3)
  expect(sample?.durationNs).toBeGreaterThanOrEqual(5_000_000_000)
  expect(sample?.durationNs).toBeLessThanOrEqual(5_250_000_000)
})

test("settles once with a whole-attempt final rate and ignores later events", () => {
  const current = meter()
  current.observe(text("a".repeat(4_000)), s(2))
  for (const second of [3, 4, 5, 6, 7, 8, 9]) current.observe(text("b".repeat(160)), s(second))
  expect(current.live().sample).toEqual(speed(200, 5))
  expect(current.live().final).toBeUndefined()
  expect(current.settle("completed", s(10))).toBe(true)
  expect(current.live()).toEqual({
    requestID, attempt: 1, phase: "completed", firstOutputMs: 2_000, sample: speed(200, 5), final: speed(280, 7),
  })
  expect(current.settle("failed", s(11))).toBe(false)
  expect(current.observe(text("late".repeat(1_000)), s(12))).toBeUndefined()
  expect(current.outputTokens()).toBe(1_280)
  expect(current.live().phase).toBe("completed")
  expect(current.timing()?.receivedOutput).toEqual({ estimatedTokens: 280, durationNs: 7_000_000_000 })
})

test("keeps the last valid sample on interruption and reports nothing measurable for short output", () => {
  const cancelled = meter()
  cancelled.observe(text("a".repeat(400)), s(1))
  cancelled.observe(text("b".repeat(400)), s(3))
  cancelled.settle("cancelled", s(4))
  expect(cancelled.live()).toMatchObject({ phase: "cancelled", sample: speed(100, 2), final: speed(100, 2) })
  const failed = meter()
  failed.observe(text("a".repeat(400)), s(1))
  failed.observe(text("b".repeat(400)), s(1.5))
  failed.settle("failed", s(9))
  expect(failed.live()).toEqual({ requestID, attempt: 1, phase: "failed", firstOutputMs: 1_000 })
  expect(failed.timing()).toEqual({ estimatedTokens: 200, estimatedGenerationDurationNs: 8_000_000_000 })
  const silent = meter()
  silent.settle("failed", s(3))
  expect(silent.live()).toEqual({ requestID, attempt: 1, phase: "failed" })
  expect(silent.timing()).toBeUndefined()
})

test("starts each physical attempt without the previous attempt's output", () => {
  const first = meter()
  first.observe(text("a".repeat(400)), s(1))
  first.observe(text("b".repeat(400)), s(3))
  first.settle("failed", s(3))
  const retry = meter(2)
  expect(retry.live()).toEqual({ requestID, attempt: 2, phase: "preparing" })
  expect(retry.outputTokens()).toBe(0)
})

test("clamps regressing timestamps instead of producing negative or inflated intervals", () => {
  const current = meter()
  current.observe(text("a".repeat(400)), s(3))
  current.observe(text("b".repeat(400)), s(2))
  expect(current.live().sample).toBeUndefined()
  current.observe(text("c".repeat(400)), s(4))
  expect(current.live().sample).toEqual(speed(100, 1))
  const early = GenerationMeter.make({ requestID, attempt: 1, model, startedNs: s(5) })
  early.observe(text("x"), s(4))
  expect(early.live().firstOutputMs).toBe(0)
})

test("reconciles provider usage at settlement without double counting", () => {
  const current = meter()
  current.observe(reasoning("r".repeat(400)), s(1))
  current.observe(text("t".repeat(400)), s(3))
  const usage = { outputTokens: 120, reasoningTokens: 20 }
  current.observe(LLMEvent.stepFinish({ index: 0, reason: "stop", usage }), s(4))
  current.observe(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { outputTokens: 999 } }), s(5))
  current.observe(text("ignored".repeat(100)), s(6))
  expect(current.outputTokens()).toBe(200)
  current.settle("completed", s(7))
  expect(current.timing()).toEqual({
    generatedTokens: 120,
    observedGenerationDurationNs: 3_000_000_000,
    receivedOutput: { estimatedTokens: 100, durationNs: 2_000_000_000 },
  })
  const unreported = meter()
  unreported.observe(text("t".repeat(400)), s(1))
  unreported.observe(text("t".repeat(400)), s(3))
  unreported.observe(LLMEvent.stepFinish({ index: 0, reason: "stop" }), s(3.5))
  expect(unreported.timing()).toEqual({
    estimatedTokens: 200,
    estimatedGenerationDurationNs: 2_500_000_000,
    receivedOutput: { estimatedTokens: 100, durationNs: 2_000_000_000 },
  })
})

test("accepts only eligible received-output intervals", () => {
  expect(GenerationMeter.sample({ estimatedTokens: 80, durationNs: 2_000_000_000 }))
    .toEqual({ tokens: 80, durationNs: 2_000_000_000, tokensPerSecond: 40, estimated: true })
  expect(GenerationMeter.sample({ estimatedTokens: 80, durationNs: 999_999_999 })).toBeUndefined()
  expect(GenerationMeter.sample(undefined)).toBeUndefined()
})

test("notifies its observer on every live state change", () => {
  const changes: string[] = []
  const current = GenerationMeter.make({
    requestID, attempt: 1, model, startedNs: 0n,
    onChange: (changed, time) => changes.push(`${changed.phase()}@${time}:${changed.outputTokens()}`),
  })
  current.waiting(1n)
  current.observe(LLMEvent.textStart({ id: "text" }), 2n)
  current.observe(text("abcd"), 3n)
  current.settle("completed", 4n)
  current.settle("completed", 5n)
  expect(changes).toEqual(["waiting@1:0", "streaming@3:1", "completed@4:1"])
})
