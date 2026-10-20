import { expect } from "bun:test"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const sessionID = SessionSchema.ID.make("ses_decision_preflight")
const input: Decision.Input = {
  provider: "agent",
  request: { state: {}, questions: [{ type: "predicate", name: "ok", instructions: "Is it ok?" }] },
}
const answered = (request: Decision.Input["request"]) => ({
  model: CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("judge") }),
  semantics: "model-estimate" as const,
  version: 1 as const,
  answers: request.questions.map((question) => ({
    name: question.name, type: "predicate" as const, answer: false, choice: null, score: null, confidence: 0.9,
  })),
})
const keyed = { sessionID, purpose: "answer" as const, authority: "yolo" as const, invocationKey: "que_pre:0" }

const harness = (keys: (call: number) => Effect.Effect<string>) => {
  const seen: Array<{ startedAt: number | undefined; now: number }> = []
  let evaluations = 0
  let keyCalls = 0
  const fake = DecisionAgent.Service.of({
    modelKey: () => Effect.sync(() => ++keyCalls).pipe(Effect.flatMap(keys)),
    evaluate: (request, context) =>
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Effect.sync(() => {
          evaluations++
          seen.push({ startedAt: context.startedAt, now })
        })),
        Effect.as(answered(request)),
      ),
  })
  const layer = Decision.layer.pipe(Layer.provide(Layer.succeed(DecisionAgent.Service, fake)))
  return { layer, seen, evaluations: () => evaluations, keyCalls: () => keyCalls }
}

it.effect("a slow key preflight counts against the single decision deadline shared with the evaluation", () => Effect.gen(function* () {
  const { layer, seen } = harness((call) => (call === 1 ? Effect.sleep("50 seconds") : Effect.void).pipe(Effect.as("model-a")))
  const fiber = yield* Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input, keyed)
  }).pipe(Effect.provide(layer), Effect.forkChild)
  yield* TestClock.adjust("50 seconds")
  yield* Fiber.join(fiber)
  expect(seen).toEqual([{ startedAt: 0, now: 50_000 }])
}))

it.effect("a key preflight that exhausts the deadline fails with a timeout and starts no evaluation", () => Effect.gen(function* () {
  const { layer, evaluations } = harness(() => Effect.sleep("90 seconds").pipe(Effect.as("model-a")))
  const fiber = yield* Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input, keyed)
  }).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild)
  yield* TestClock.adjust("61 seconds")
  const exit = yield* Fiber.join(fiber)
  expect(Exit.isFailure(exit) && (Cause.squash(exit.cause) as { reason?: string }).reason).toBe("timeout")
  expect(evaluations()).toBe(0)
}))

it.effect("unkeyed calls run no key preflight but still carry their start time", () => Effect.gen(function* () {
  const { layer, seen, keyCalls } = harness(() => Effect.succeed("model-a"))
  yield* TestClock.adjust("5 seconds")
  yield* Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input, { sessionID })
  }).pipe(Effect.provide(layer))
  expect(keyCalls()).toBe(0)
  expect(seen).toEqual([{ startedAt: 5_000, now: 5_000 }])
}))

it.effect("a judgment settled while the chain identity changed is never cached under the old key", () => Effect.gen(function* () {
  const sequence = ["model-a", "model-b", "model-b", "model-b", "model-b", "model-a", "model-a"]
  const { layer, evaluations } = harness(() => Effect.sync(() => sequence.shift() ?? "model-z"))
  yield* Effect.gen(function* () {
    const decision = yield* Decision.Service
    yield* decision.evaluate(input, keyed)
    expect(evaluations()).toBe(1)
    yield* decision.evaluate(input, keyed)
    expect(evaluations()).toBe(2)
    yield* decision.evaluate(input, keyed)
    expect(evaluations()).toBe(2)
    yield* decision.evaluate(input, keyed)
    expect(evaluations()).toBe(3)
  }).pipe(Effect.provide(layer))
}))

it.effect("concurrent callers retain one evaluation while its successful result is rechecked", () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const { layer, evaluations } = harness((call) => call === 2
    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("model-a"))
    : Effect.succeed("model-a"))
  yield* Effect.gen(function* () {
    const decision = yield* Decision.Service
    const first = yield* decision.evaluate(input, keyed).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const second = yield* decision.evaluate(input, keyed).pipe(Effect.forkChild)
    yield* TestClock.adjust("1 second")
    const beforeRelease = evaluations()
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first))
    expect(beforeRelease).toBe(1)
    expect(evaluations()).toBe(1)
  }).pipe(Effect.provide(layer))
}))

const hangingHarness = () => {
  let evaluations = 0
  const fake = DecisionAgent.Service.of({
    modelKey: () => Effect.succeed("model-a"),
    evaluate: () => Effect.sync(() => { evaluations++ }).pipe(Effect.andThen(Effect.never)),
  })
  return { layer: Decision.layer.pipe(Layer.provide(Layer.succeed(DecisionAgent.Service, fake))), evaluations: () => evaluations }
}

it.effect("the decision deadline settles even while the successful-result identity recheck is held", () => Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const { layer } = harness((call) => call === 2
    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("model-a"))
    : Effect.succeed("model-a"))
  const fiber = yield* Effect.gen(function* () {
    const decision = yield* Decision.Service
    return yield* decision.evaluate(input, keyed)
  }).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild)
  yield* Deferred.await(entered)
  yield* TestClock.adjust("61 seconds")
  const settledAtDeadline = fiber.pollUnsafe()
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(fiber)
  expect(settledAtDeadline).toBeDefined()
}))

const timeoutReason = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { _tag?: string; reason?: string }) : undefined

for (const context of [keyed, { sessionID }]) it.effect(`a ${context === keyed ? "keyed" : "unkeyed"} evaluation that never settles times out at the single sixty second deadline`, () => Effect.gen(function* () {
  const { layer, evaluations } = hangingHarness()
  const fiber = yield* Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input, context)
  }).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild)
  yield* TestClock.adjust("59 seconds")
  expect(fiber.pollUnsafe()).toBeUndefined()
  yield* TestClock.adjust("1 second")
  const exit = fiber.pollUnsafe()
  expect(exit).toBeDefined()
  expect(timeoutReason(yield* Fiber.join(fiber))).toMatchObject({ _tag: "Decision.Error", reason: "timeout" })
  expect(evaluations()).toBe(1)
}))

it.effect("a call joined to a stalled evaluation is bounded by its own deadline rather than waiting indefinitely", () => Effect.gen(function* () {
  const { layer, evaluations } = hangingHarness()
  const run = Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input, keyed)
  }).pipe(Effect.provide(layer), Effect.exit)
  const leader = yield* run.pipe(Effect.forkChild)
  yield* TestClock.adjust("10 seconds")
  const joiner = yield* run.pipe(Effect.forkChild)
  yield* TestClock.adjust("50 seconds")
  expect(leader.pollUnsafe()).toBeDefined()
  expect(timeoutReason(yield* Fiber.join(leader))).toMatchObject({ reason: "timeout" })
  expect(joiner.pollUnsafe()).toBeUndefined()
  yield* TestClock.adjust("10 seconds")
  expect(joiner.pollUnsafe()).toBeDefined()
  expect(timeoutReason(yield* Fiber.join(joiner))).toMatchObject({ _tag: "Decision.Error", reason: "timeout" })
  expect(evaluations()).toBe(2)
}))
