import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ycoding-ai/core/config"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

let decisionBehavior: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("Questions must not request judgments unless asleep")
let configuredTimeout: number | undefined
const questions = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionAutonomy.node, Question.node]),
  [
    [Decision.node, Layer.mock(Decision.Service, { evaluate: (input: Decision.Input) => decisionBehavior(input) })],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () =>
          Effect.sync(() =>
            [
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({ ...(configuredTimeout === undefined ? {} : { question_timeout_seconds: configuredTimeout }) }),
                  }),
                ],
          ),
      }),
    ],
  ],
)

const decisionChoice = (value: string, confidence: number) => (input: Decision.Input) =>
  Effect.succeed(
    Schema.decodeUnknownSync(Decision.Output)({
      provider: "agent",
      response: {
        model: { providerID: "test", id: "decision-model" },
        semantics: "model-estimate",
        version: 1,
        answers: input.request.questions.map((item) => ({
          name: item.name,
          type: "choice",
          answer: null,
          choice: value,
          score: null,
          confidence,
        })),
      },
    }),
  )
const it = testEffect(questions)

const sessionID = Session.ID.make("ses_question_test")
const question: Question.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

const setupAutonomy = Effect.fn("QuestionTest.setupAutonomy")(function* (mode: "yolo" | "goal") {
  const { db } = yield* Database.Service
  const directory = AbsolutePath.make("/project")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      directory,
      title: "Question autonomy",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const autonomy = yield* SessionAutonomy.Service
  yield* mode === "goal"
    ? autonomy.setGoal({ sessionID, text: "Finish safely" })
    : autonomy.setMode({ sessionID, mode })
})

const waitForAsk = Effect.fn("QuestionTest.waitForAsk")(function* (
  service: Question.Interface,
  input: Question.AskInput,
) {
  const events = yield* EventRuntime.Service
  const asked = yield* Deferred.make<Question.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === Question.Event.Asked.type
      ? Deferred.succeed(asked, event.data as Question.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("Question", () => {
  for (const yolo of [0, 1, 2] as const) {
    it.effect(`questions are automatic only with the Session autoAnswer toggle: level ${yolo}`, () => Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo })
      const service = yield* Question.Service
      const pending = yield* waitForAsk(service, { sessionID, questions: [question] })
      expect(yield* service.list()).toEqual([pending.request])
      yield* service.reply({ requestID: pending.request.id, answers: [["Manual"]] })
      expect(yield* Fiber.join(pending.fiber)).toEqual({ status: "answered", answers: [["Manual"]] })
      yield* autonomy.set({ sessionID, autoAnswer: true })
      expect(yield* service.ask({ sessionID, questions: [question] })).toEqual({
        status: "answered",
        answers: [["One"]],
      })
      expect(yield* service.list()).toEqual([])
    }))
  }
  it.effect("auto answers questions with the toggle in yolo and goal mode without pending requests", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const autonomy = yield* SessionAutonomy.Service
      const fallback: Question.Info = { question: "Continue?", header: "Continue", options: [] }

      for (const mode of ["yolo", "goal"] as const) {
        yield* setupAutonomy(mode)
        yield* autonomy.set({ sessionID, autoAnswer: true })
        expect(yield* service.ask({ sessionID, questions: [question, fallback] })).toEqual({
          status: "answered",
          answers: [["One"], ["Continue with the safest reasonable default."]],
        })
        expect(yield* service.list()).toEqual([])
      }
    }),
  )

  it.effect("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const events = yield* EventRuntime.Service
      const published: EventRuntime.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(request.id).toMatch(/^que_/)
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["One"]] })
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [Question.Event.Asked.type, request],
        [Question.Event.Replied.type, { sessionID, requestID: request.id, answers: [["One"]] }],
      ])
    }),
  )

  it.effect("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const events = yield* EventRuntime.Service
      const published: EventRuntime.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Question.Event.Rejected.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* service.reject(request.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Question.RejectedError")
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])

      const unknown = Question.ID.ascending("que_unknown")
      expect(yield* service.reply({ requestID: unknown, answers: [] }).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: unknown }),
      )
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.effect("isolates pending requests by location-layer instance and rejects them on finalization", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), firstScope), Question.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), secondScope), Question.Service)
      const fiber = yield* first.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const request = (yield* first.list())[0]!

      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: request.id }),
      )

      yield* Scope.close(firstScope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Question.RejectedError")
      yield* Scope.close(secondScope, Exit.void)
    }),
  )

  it.effect("sleep answers questions through the decision model", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo: 0 })
      yield* autonomy.set({ sessionID, autoAnswer: true })
      yield* autonomy.set({ sessionID, sleep: true })
      decisionBehavior = decisionChoice("Two", 0.9)
      const service = yield* Question.Service
      const answers = yield* service.ask({
        sessionID,
        questions: [
          {
            question: "Which option?",
            header: "Option",
            options: [
              { label: "One", description: "First option" },
              { label: "Two", description: "Second option" },
            ],
          },
        ],
      })
      expect(answers).toEqual({ status: "answered", answers: [["Two"]] })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("sleep defers to the review box when the decision model refuse or fails", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo: 0 })
      yield* autonomy.set({ sessionID, autoAnswer: true })
      yield* autonomy.set({ sessionID, sleep: true })
      decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "timeout" }))
      const service = yield* Question.Service
      const answers = yield* service.ask({
        sessionID,
        questions: [
          {
            question: "Which option?",
            header: "Option",
            options: [
              { label: "One", description: "First option" },
              { label: "Two", description: "Second option" },
            ],
          },
        ],
      })
      expect(answers.status).toBe("deferred")
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("turning autoAnswer off while a sleeping answer is pending defers instead of applying it", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo: 0 })
      yield* autonomy.set({ sessionID, autoAnswer: true })
      yield* autonomy.set({ sessionID, sleep: true })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      decisionBehavior = (input) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(decisionChoice("One", 0.9)(input)),
      )
      const service = yield* Question.Service
      const fiber = yield* service.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* autonomy.set({ sessionID, autoAnswer: false })
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).status).toBe("deferred")
      expect(yield* service.list()).toEqual([])
    }),
  )

  describe("timeout", () => {
    const observe = Effect.fn("QuestionTest.observe")(function* () {
      const events = yield* EventRuntime.Service
      const published: EventRuntime.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      return published
    })

    it.effect("times out at the default 5 minutes, closes the request, and rejects a late reply", () =>
      Effect.gen(function* () {
        configuredTimeout = undefined
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

        yield* TestClock.adjust("299 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list()).toEqual([request])

        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toEqual({ status: "timed_out", seconds: 300 })
        expect(yield* service.list()).toEqual([])
        expect(published.map((event) => [event.type, event.data])).toEqual([
          [Question.Event.Asked.type, request],
          [Question.Event.TimedOut.type, { sessionID, requestID: request.id }],
        ])
        expect(yield* service.reply({ requestID: request.id, answers: [["Late"]] }).pipe(Effect.flip)).toEqual(
          new Question.NotFoundError({ requestID: request.id }),
        )
        expect(yield* service.reject(request.id).pipe(Effect.flip)).toEqual(
          new Question.NotFoundError({ requestID: request.id }),
        )
      }),
    )

    it.effect("times out at the configured seconds", () =>
      Effect.gen(function* () {
        configuredTimeout = 30
        const service = yield* Question.Service
        const { fiber } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* TestClock.adjust("29 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toEqual({ status: "timed_out", seconds: 30 })
      }),
    )

    it.effect("never times out when disabled with 0", () =>
      Effect.gen(function* () {
        configuredTimeout = 0
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* TestClock.adjust("24 hours")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list()).toEqual([request])
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type])
        yield* service.reply({ requestID: request.id, answers: [["One"]] })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["One"]] })
      }),
    )

    it.effect("a human answer before the deadline wins and leaves no timer behind", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* TestClock.adjust("59 seconds")
        yield* service.reply({ requestID: request.id, answers: [["One"]] })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["One"]] })
        yield* TestClock.adjust("10 minutes")
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type, Question.Event.Replied.type])
      }),
    )

    it.effect("interrupting the ask clears the timer without publishing a timeout", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust("10 minutes")
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type])
        expect(yield* service.list()).toEqual([])
      }),
    )

    it.effect("automatic answers never wait for the timeout", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        yield* setupAutonomy("yolo")
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.setYolo({ sessionID, yolo: 2 })
        yield* autonomy.set({ sessionID, autoAnswer: true })
        const service = yield* Question.Service
        expect(yield* service.ask({ sessionID, questions: [question] })).toEqual({
          status: "answered",
          answers: [["One"]],
        })
        yield* autonomy.setYolo({ sessionID, yolo: 0 })
        yield* autonomy.set({ sessionID, autoAnswer: true })
      yield* autonomy.set({ sessionID, sleep: true })
        decisionBehavior = decisionChoice("One", 0.9)
        expect(yield* service.ask({ sessionID, questions: [question] })).toEqual({
          status: "answered",
          answers: [["One"]],
        })
      }),
    )
  })
})
