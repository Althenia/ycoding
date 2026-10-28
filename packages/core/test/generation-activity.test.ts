import { expect, test } from "bun:test"
import { LLMEvent } from "@ycoding-ai/ai"
import { Effect, Exit, Layer } from "effect"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { GenerationActivity } from "../src/generation-activity"
import { GenerationMeter } from "../src/session/generation-meter"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"

const ref = (id: string) => CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make(id) })
const fast = ref("fast")
const slow = ref("slow")
const s = (seconds: number) => BigInt(Math.round(seconds * 1_000_000_000))
const text = (characters: number) => LLMEvent.textDelta({ id: "text", text: "x".repeat(characters) })

const setup = () => {
  const registry = GenerationActivity.registry({ wallMs: 1_000_000, ns: 0n })
  const start = (model: CatalogModel.Ref, at = 0n, id = "prq_activity") => {
    const meter = GenerationMeter.make({
      requestID: ProviderRequest.ID.make(id), attempt: 1, model, startedNs: at, onChange: registry.update,
    })
    registry.update(meter, at)
    return meter
  }
  return { registry, start }
}

test("aggregates concurrent throughput as wall-clock output rather than a mean of attempt rates", () => {
  const { registry, start } = setup()
  const first = start(fast)
  const second = start(slow)
  for (let tick = 1; tick <= 20; tick++) {
    first.observe(text(100), s(tick * 0.25))
    second.observe(text(100), s(tick * 0.25))
  }
  const snapshot = registry.snapshot(s(5))
  expect(snapshot).toMatchObject({ asOf: 1_005_000, active: 2, streaming: 2, outputTokensPerSecond: 200 })
  expect(snapshot.models).toEqual([
    { model: fast, active: 1, streaming: 1, outputTokensPerSecond: 100 },
    { model: slow, active: 1, streaming: 1, outputTokensPerSecond: 100 },
  ])
  expect(first.live().sample?.tokensPerSecond).toBe(100)
})

test("counts a short burst over the whole trailing window and keeps idle active attempts measured at zero", () => {
  const { registry, start } = setup()
  const bursty = start(fast)
  start(slow)
  bursty.observe(text(2_000), s(4.9))
  const snapshot = registry.snapshot(s(5))
  expect(snapshot).toMatchObject({ active: 2, streaming: 1, outputTokensPerSecond: 100 })
  expect(snapshot.models).toEqual([
    { model: fast, active: 1, streaming: 1, outputTokensPerSecond: 100 },
    { model: slow, active: 1, streaming: 0, outputTokensPerSecond: 0 },
  ])
  expect(bursty.live().sample).toBeUndefined()
})

test("removes settled attempts while their received output still ages out of the window", () => {
  const { registry, start } = setup()
  const meter = start(fast)
  meter.waiting(s(0.5))
  meter.observe(text(400), s(1))
  meter.observe(text(400), s(2))
  meter.settle("completed", s(2))
  meter.observe(text(4_000), s(3))
  expect(registry.snapshot(s(3))).toMatchObject({
    active: 0, streaming: 0, outputTokensPerSecond: 40, models: [{ model: fast, active: 0, streaming: 0, outputTokensPerSecond: 40 }],
  })
  const idle = registry.snapshot(s(7.5))
  expect(idle).toMatchObject({ active: 0, streaming: 0, models: [] })
  expect(idle.outputTokensPerSecond).toBeUndefined()
})

test("records five-second history points with peak activity and bounded length", () => {
  const { registry, start } = setup()
  const meter = start(fast, s(1))
  meter.observe(text(400), s(2))
  meter.observe(text(400), s(4))
  meter.settle("completed", s(6))
  const recent = registry.snapshot(s(12))
  expect(recent.history).toEqual([
    { at: 1_005_000, active: 1, outputTokensPerSecond: 40 },
    { at: 1_010_000, active: 1, outputTokensPerSecond: 0 },
  ])
  const later = registry.snapshot(s(3_600))
  expect(later.history).toHaveLength(120)
  expect(later.history.at(-1)).toEqual({ at: 4_600_000, active: 0 })
  expect(later.history[0]).toEqual({ at: 4_005_000, active: 0 })
})

test("bounds models to fifty and ignores updates from removed meters", () => {
  const { registry, start } = setup()
  const meters = Array.from({ length: 60 }, (_, index) => start(ref(`model-${index}`)))
  meters.forEach((meter, index) => meter.observe(text(4 * (index + 1)), s(1)))
  const snapshot = registry.snapshot(s(1))
  expect(snapshot.active).toBe(60)
  expect(snapshot.models).toHaveLength(50)
  expect(snapshot.models[0]).toMatchObject({ model: ref("model-59"), outputTokensPerSecond: 12 })
  meters.forEach((meter) => meter.settle("cancelled", s(2)))
  registry.update(meters[0]!, s(2))
  expect(registry.snapshot(s(2)).active).toBe(0)
})

test("removes an attempt and settles it as cancelled when its scope is interrupted", async () => {
  const exit = await Effect.runPromiseExit(Effect.gen(function* () {
    const activity = yield* GenerationActivity.Service
    const captured: GenerationMeter.Meter[] = []
    const run = yield* Effect.scoped(Effect.gen(function* () {
      const meter = yield* activity.start({ requestID: ProviderRequest.ID.make("prq_scoped"), attempt: 1, model: fast })
      captured.push(meter)
      expect((yield* activity.snapshot()).active).toBe(1)
      return yield* Effect.interrupt
    })).pipe(Effect.exit)
    expect(Exit.isFailure(run)).toBe(true)
    expect(captured[0]!.phase()).toBe("cancelled")
    expect((yield* activity.snapshot()).active).toBe(0)
  }).pipe(Effect.provide(GenerationActivity.layer)))
  expect(Exit.isSuccess(exit)).toBe(true)
})
