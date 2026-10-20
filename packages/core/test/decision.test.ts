import { expect, test } from "bun:test"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { DecisionTool } from "@ycoding-ai/core/tool/decision"
import { DecisionFailure } from "@ycoding-ai/schema/decision-failure"
import { Effect, Fiber, Layer, Schema } from "effect"
import { SessionSchema } from "../src/session/schema"

test("decision input accepts only the validated agent request", () => {
  const request = { provider: "agent", request: { state: { task: "review" }, questions: [
    { type: "choice", name: "decision", instructions: "Choose", choices: [{ value: "yes" }, { value: "no" }] },
  ] } } as const
  expect(Schema.decodeUnknownSync(Decision.Input)(request)).toEqual(request)
  for (const provider of [["open", "ai"].join(""), ["type", "safe"].join("")])
    expect(Schema.is(Decision.Input)({ ...request, provider })).toBe(false)
  expect(Schema.is(Decision.Input)({ provider: "agent", request: { state: {}, questions: [] } })).toBe(false)
  expect(DecisionTool.Input).toBe(Decision.Input)
})

test("decision errors share the typed failure reasons and describe JSON output failures", () => {
  for (const reason of Schema.decodeUnknownSync(Schema.Array(DecisionFailure.Reason))([
    "unavailable", "invalid-request", "provider-failed", "timeout", "input-too-large",
    "invalid-output", "refused", "truncated-output", "unsupported-output",
  ])) {
    expect(new Decision.Error({ reason }).reason).toBe(reason)
    expect(new DecisionAgent.Error({ reason }).reason).toBe(reason)
    expect(new Decision.Error({ reason }).message.length).toBeGreaterThan(0)
  }
  expect(new Decision.Error({ reason: "invalid-output" }).message).toContain("JSON")
  expect(new Decision.Error({ reason: "invalid-output" }).message).not.toContain("TOON")
  expect(new Decision.Error({ reason: "unsupported-output" }).message).toContain("strict")
  expect(new Decision.Error({ reason: "refused" }).message).toContain("refus")
  expect(new Decision.Error({ reason: "truncated-output" }).message).toContain("truncated")
})

const input = (name = "ok"): Decision.Input => ({
  provider: "agent",
  request: { state: {}, questions: [{ type: "predicate", name, instructions: "Is it ok?" }] },
})

const answered = (request: Decision.Input["request"]) => Schema.decodeUnknownSync(DecisionAgent.Response)({
  model: { providerID: "test", id: "judge" },
  semantics: "model-estimate" as const,
  version: 1 as const,
  answers: request.questions.map((question) => ({
    name: question.name, type: "predicate" as const, answer: false, choice: null, score: null, confidence: 0.9,
  })),
})

const model = { current: "model-a" }

const countingLayer = (counter: { calls: number; contexts: DecisionAgent.Invocation[] }, behavior?: Effect.Effect<never, DecisionAgent.Error>) =>
  Decision.layer.pipe(Layer.provide(Layer.succeed(DecisionAgent.Service, DecisionAgent.Service.of({
    modelKey: () => Effect.sync(() => model.current),
    evaluate: (request, context) =>
      Effect.sync(() => {
        counter.calls++
        counter.contexts.push(context)
      }).pipe(Effect.andThen(behavior ?? Effect.succeed(answered(request)))),
  }))))

const run = <A, E>(layer: ReturnType<typeof countingLayer>, program: Effect.Effect<A, E, Decision.Service>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)))

const sessionID = SessionSchema.ID.make("ses_decision_identity")

test("unkeyed calls always evaluate fresh and never join", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  await run(countingLayer(counter), Effect.gen(function* () {
    const decision = yield* Decision.Service
    yield* decision.evaluate(input(), { sessionID })
    yield* decision.evaluate(input(), { sessionID })
    yield* Effect.all([decision.evaluate(input(), { sessionID }), decision.evaluate(input(), { sessionID })], { concurrency: 2 })
  }))
  expect(counter.calls).toBe(4)
})

test("keyed identity joins only the same session, purpose, authority, evaluator, key, and request", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  const other = SessionSchema.ID.make("ses_decision_identity_other")
  const results = await run(countingLayer(counter), Effect.gen(function* () {
    const decision = yield* Decision.Service
    const base = { sessionID, purpose: "answer" as const, authority: "yolo" as const, invocationKey: "que_1:0" }
    const first = yield* decision.evaluate(input(), base)
    const repeat = yield* decision.evaluate(input(), base)
    yield* decision.evaluate(input("different"), base)
    yield* decision.evaluate(input(), { ...base, invocationKey: "que_1:1" })
    yield* decision.evaluate(input(), { ...base, sessionID: other })
    yield* decision.evaluate(input(), { ...base, purpose: "guardrail" })
    yield* decision.evaluate(input(), { ...base, authority: "baseline", purpose: "guardrail" })
    yield* decision.evaluate(input(), { sessionID, invocationKey: "que_1:0" })
    return { first, repeat }
  }))
  expect(results.repeat).toEqual(results.first)
  expect(counter.calls).toBe(7)
})

test("concurrent identical keyed calls join one evaluation", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  const [a, b] = await run(countingLayer(counter), Effect.gen(function* () {
    const decision = yield* Decision.Service
    const context = { sessionID, purpose: "permission" as const, authority: "baseline" as const, invocationKey: "tool:msg:call" }
    return yield* Effect.all([decision.evaluate(input(), context), decision.evaluate(input(), context)], { concurrency: 2 })
  }))
  expect(counter.calls).toBe(1)
  expect(b).toEqual(a)
})

test("failed keyed calls are not cached and a later identical call evaluates again", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  await run(countingLayer(counter, Effect.fail(new DecisionAgent.Error({ reason: "timeout" }))), Effect.gen(function* () {
    const decision = yield* Decision.Service
    const context = { sessionID, purpose: "permission" as const, authority: "baseline" as const, invocationKey: "per_1" }
    yield* decision.evaluate(input(), context).pipe(Effect.exit)
    yield* decision.evaluate(input(), context).pipe(Effect.exit)
  }))
  expect(counter.calls).toBe(2)
})

test("a cancelled leader does not fail its joiner, which evaluates again", async () => {
  let calls = 0
  const release = Promise.withResolvers<void>()
  const layer = Decision.layer.pipe(Layer.provide(Layer.succeed(DecisionAgent.Service, DecisionAgent.Service.of({
    modelKey: () => Effect.succeed("model-a"),
    evaluate: (request) => Effect.suspend(() => {
      calls++
      return calls === 1 ? Effect.promise(() => release.promise).pipe(Effect.as(answered(request))) : Effect.succeed(answered(request))
    }),
  }))))
  const joined = await Effect.runPromise(Effect.gen(function* () {
    const decision = yield* Decision.Service
    const context = { sessionID, purpose: "answer" as const, authority: "yolo" as const, invocationKey: "que_cancel:0" }
    const leader = yield* Effect.forkChild(decision.evaluate(input(), context))
    yield* Effect.yieldNow
    const joiner = yield* Effect.forkChild(decision.evaluate(input(), context))
    yield* Effect.yieldNow
    yield* Fiber.interrupt(leader)
    return yield* Fiber.join(joiner)
  }).pipe(Effect.provide(layer)))
  expect(calls).toBe(2)
  expect(joined.response.answers[0]?.name).toBe("ok")
})

test("purpose and authority are required together and a baseline answer is rejected", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  const exits = await run(countingLayer(counter), Effect.gen(function* () {
    const decision = yield* Decision.Service
    return yield* Effect.all([
      decision.evaluate(input(), { sessionID, purpose: "answer" }).pipe(Effect.exit),
      decision.evaluate(input(), { sessionID, authority: "yolo" }).pipe(Effect.exit),
      decision.evaluate(input(), { sessionID, purpose: "answer", authority: "baseline" }).pipe(Effect.exit),
      decision.evaluate(input(), { sessionID, invocationKey: "" }).pipe(Effect.exit),
    ])
  }))
  expect(exits.map((exit) => exit._tag)).toEqual(["Failure", "Failure", "Failure", "Failure"])
  expect(counter.calls).toBe(0)
})

test("a helper-model switch never reuses a judgment settled by the previous model", async () => {
  const counter = { calls: 0, contexts: [] as DecisionAgent.Invocation[] }
  model.current = "model-a"
  await run(countingLayer(counter), Effect.gen(function* () {
    const decision = yield* Decision.Service
    const context = { sessionID, purpose: "answer" as const, authority: "yolo" as const, invocationKey: "que_model:0" }
    yield* decision.evaluate(input(), context)
    yield* decision.evaluate(input(), context)
    model.current = "model-b"
    yield* decision.evaluate(input(), context)
    yield* decision.evaluate(input(), context)
    model.current = "model-a"
    yield* decision.evaluate(input(), context)
  }))
  expect(counter.calls).toBe(2)
})
