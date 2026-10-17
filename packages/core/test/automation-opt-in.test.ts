import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Decision } from "@ycoding-ai/core/decision"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

for (const flag of [false, true]) {
  for (const mode of [0, 1, 2, "goal", "sleep"] as const) {
    for (const kind of ["question", "form", "subagent"] as const) {
      const calls: Decision.Input[] = []
      const it = testEffect(reviewLayer(undefined, true, (input) => {
        calls.push(input)
        return Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({
          provider: "agent",
          response: {
            model: { providerID: "test", id: "decision" }, semantics: "model-estimate", version: 1,
            answers: input.request.questions.map((question) => ({
              name: question.name, type: "choice", answer: null, choice: "One", score: null, confidence: 0.99,
            })),
          },
        }))
      }))
      it.effect(`${kind} session autoAnswer=${String(flag)} respects ${mode}`, () => Effect.gen(function* () {
        const location = yield* reviewLocation
        yield* Effect.promise(() => Bun.write(`${location.directory}/ycoding.json`, JSON.stringify({ auto_answer: true })))
        const sessions = yield* Session.Service
        const root = yield* sessions.create({ location })
        const autonomy = yield* SessionAutonomy.Service
        if (mode === "goal") yield* autonomy.setGoal({ sessionID: root.id, text: "Finish safely" })
        if (mode === "sleep") yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
        if (typeof mode === "number") yield* autonomy.setYolo({ sessionID: root.id, yolo: mode })
        if (flag && kind !== "subagent") yield* autonomy.set({ sessionID: root.id, autoAnswer: true })
        const automatic = flag
        const reviews = yield* SessionReview.Service
        const events = yield* EventRuntime.Service
        if (kind === "subagent") {
          const child = yield* sessions.create({ parentID: root.id })
          yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({
            sessionID: child.id, change: {
              type: "launched", parentID: root.id, parentAssistantMessageID: "msg_parent", toolCallID: "call_child", inputID: "msg_child",
              description: "Synthetic child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
            },
          }))
          yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
          if (flag) yield* autonomy.set({ sessionID: child.id, autoAnswer: true })
          const orchestration = yield* SessionOrchestration.Service
          const result = yield* orchestration.question(child.id, "Choose", { options: ["One"] })
          expect(result.autoAnswered).toBe(automatic)
          if (!automatic && mode !== "sleep") {
            expect((yield* orchestration.get(root.id, child.id)).state).toBe("waiting")
            yield* orchestration.answer({ parentID: root.id, childID: child.id, questionID: result.question.id, text: "Human" })
            expect((yield* orchestration.get(root.id, child.id)).state).toBe("running")
          }
        } else {
          const locations = yield* LocationServiceMap.Service
          const located = locations.get(root.location)
          const questions = yield* Question.Service.pipe(Effect.provide(located))
          const forms = yield* Form.Service.pipe(Effect.provide(located))
          const pending = yield* Deferred.make<string>()
          const unsubscribe = yield* events.listen((event) => {
            if (kind === "question" && event.type === Question.Event.Asked.type)
              return Deferred.succeed(pending, Schema.decodeUnknownSync(Question.Request)(event.data).id).pipe(Effect.asVoid)
            if (kind === "form" && event.type === Form.Event.Created.type)
              return Deferred.succeed(pending, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form.id).pipe(Effect.asVoid)
            return Effect.void
          })
          yield* Effect.addFinalizer(() => unsubscribe)
          const request = kind === "question"
            ? questions.ask({ sessionID: root.id, questions: [{ header: "Choice", question: "Choose", options: [{ label: "One", description: "Synthetic option" }] }] })
            : forms.ask({ sessionID: root.id, title: "Choose", fields: [{ key: "choice", type: "string", required: true, default: "One", custom: false, options: [{ label: "One", value: "One" }] }] })
          const fiber = yield* request.pipe(Effect.forkScoped)
          if (!automatic && mode !== "sleep") {
            const observed = yield* Effect.raceFirst(
              Deferred.await(pending).pipe(Effect.map((id) => ({ type: "pending" as const, id }))),
              Fiber.join(fiber).pipe(Effect.map(() => ({ type: "settled" as const }))),
            )
            expect(observed.type).toBe("pending")
            if (observed.type !== "pending") return
            yield* TestClock.adjust(0)
            if (kind === "form") expect((yield* forms.state(Form.ID.make(observed.id))).status).toBe("pending")
            if (kind === "question") yield* questions.reply({ requestID: Question.ID.make(observed.id), answers: [["Human"]] })
            if (kind === "form") yield* forms.reply({ id: Form.ID.make(observed.id), answer: { choice: "One" } })
          }
          expect((yield* Fiber.join(fiber)).status).toBe(mode === "sleep" && !automatic ? "deferred" : "answered")
        }
        expect(calls).toHaveLength(mode === "sleep" && automatic ? 1 : 0)
        const items = yield* reviews.list(root.id)
        if (mode === "sleep" && !automatic) expect(items).toEqual([expect.objectContaining({ reason: "disabled" })])
        else expect(items).toEqual([])
      }))
    }
  }
}

const located = testEffect(reviewLayer())

located.effect("a subagent question reads autoAnswer from the child Session only", () => Effect.gen(function* () {
  const location = yield* reviewLocation
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const orchestration = yield* SessionOrchestration.Service
  const autonomy = yield* SessionAutonomy.Service
  const root = yield* sessions.create({ location })
  yield* autonomy.setYolo({ sessionID: root.id, yolo: 2 })
  yield* autonomy.set({ sessionID: root.id, autoAnswer: true })
  const ask = (index: number, childFlag: boolean) => Effect.gen(function* () {
    const child = yield* sessions.create({ parentID: root.id })
    yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({
      sessionID: child.id, change: {
        type: "launched", parentID: root.id, parentAssistantMessageID: "msg_parent", toolCallID: `call_child_${index}`, inputID: `msg_child_${index}`,
        description: "Synthetic child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
      },
    }))
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    if (childFlag) yield* autonomy.set({ sessionID: child.id, autoAnswer: true })
    return (yield* orchestration.question(child.id, "Choose", { options: ["One"] })).autoAnswered
  })
  expect(yield* ask(0, false)).toBe(false)
  expect(yield* ask(1, true)).toBe(true)
}))

located.effect("effective autonomy resolves inherited YOLO, family sleep, and captured review policy", () => Effect.gen(function* () {
  const location = yield* reviewLocation
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const autonomy = yield* SessionAutonomy.Service
  const root = yield* sessions.create({ location })
  yield* autonomy.setYolo({ sessionID: root.id, yolo: 1 })
  expect(yield* sessions.autonomy.effective(root.id)).toEqual({
    yolo: 1, asleep: false, ordinaryReviewsAuto: false, guardrailsEnabled: true, modelReviews: true, hardModelReviews: true,
  })
  const child = yield* sessions.create({ parentID: root.id })
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({
    sessionID: child.id, change: {
      type: "launched", parentID: root.id, parentAssistantMessageID: "msg_effective_parent", toolCallID: "call_effective", inputID: "msg_effective_child",
      description: "Effective child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
    },
  }))
  expect((yield* sessions.autonomy.effective(child.id)).yolo).toBe(1)
  yield* autonomy.setYolo({ sessionID: child.id, yolo: 2 })
  const childTwoRootOne = yield* sessions.autonomy.effective(child.id)
  expect(childTwoRootOne.yolo).toBe(2)
  expect(childTwoRootOne.ordinaryReviewsAuto).toBe(false)
  yield* autonomy.setYolo({ sessionID: root.id, yolo: 2 })
  expect((yield* sessions.autonomy.effective(child.id)).ordinaryReviewsAuto).toBe(true)
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const asleepChild = yield* sessions.autonomy.effective(child.id)
  expect(asleepChild.asleep).toBe(true)
  expect(asleepChild.ordinaryReviewsAuto).toBe(false)
  expect((yield* sessions.autonomy.get(root.id)).autoAnswer).toBeUndefined()
}))

let sleepGate: { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> } | undefined
const gated = testEffect(reviewLayer(undefined, true, (input) => {
  const respond = Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({
    provider: "agent",
    response: {
      model: { providerID: "test", id: "decision" }, semantics: "model-estimate", version: 1,
      answers: input.request.questions.map((question) => ({
        name: question.name, type: "choice", answer: null, choice: "One", score: null, confidence: 0.99,
      })),
    },
  }))
  const gate = sleepGate
  return gate
    ? Deferred.succeed(gate.entered, undefined).pipe(Effect.andThen(Deferred.await(gate.release)), Effect.andThen(respond))
    : respond
}))

gated.effect("turning child autoAnswer off while a sleeping subagent answer is pending defers it", () => Effect.gen(function* () {
  const location = yield* reviewLocation
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const orchestration = yield* SessionOrchestration.Service
  const autonomy = yield* SessionAutonomy.Service
  const reviews = yield* SessionReview.Service
  const root = yield* sessions.create({ location })
  const child = yield* sessions.create({ parentID: root.id })
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({
    sessionID: child.id, change: {
      type: "launched", parentID: root.id, parentAssistantMessageID: "msg_parent", toolCallID: "call_gated", inputID: "msg_gated",
      description: "Gated child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
    },
  }))
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  yield* autonomy.set({ sessionID: child.id, autoAnswer: true })
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  sleepGate = { entered, release }
  const fiber = yield* orchestration.question(child.id, "Choose", { options: ["One"] }).pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  yield* autonomy.set({ sessionID: child.id, autoAnswer: false })
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.join(fiber)
  sleepGate = undefined
  expect(result.autoAnswered).toBe(false)
  expect(result.question.deferred).toBe(true)
  expect(yield* reviews.list(root.id)).toEqual([expect.objectContaining({ reason: "disabled" })])
}))

for (const settings of [
  { model: true, hard: true, expected: true },
  { model: true, hard: false, expected: false },
  { model: false, hard: true, expected: false },
]) {
  located.effect(`disabled ordinary guardrails preserve hard-review model gates ${settings.model}/${settings.hard}`, () => Effect.gen(function* () {
    const location = yield* reviewLocation
    yield* Effect.promise(() => Bun.write(`${location.directory}/ycoding.json`, JSON.stringify({ guardrails: {
      enabled: false, decide_reviews: settings.model, decide_hard_reviews: settings.hard,
    } })))
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ location })
    expect(yield* sessions.autonomy.effective(root.id)).toEqual({
      yolo: 0, asleep: false, ordinaryReviewsAuto: false, guardrailsEnabled: false, modelReviews: false, hardModelReviews: settings.expected,
    })
  }))
}
