import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Form } from "@ycoding-ai/schema/form"
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
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

let decisionBehavior: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("Questions must not request judgments unless asleep")
const questions = AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node, Question.node]),
  [
    [Decision.node, Layer.mock(Decision.Service, { evaluate: (input: Decision.Input) => decisionBehavior(input) })],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
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
          choice: item.type === "choice" && item.grade === true ? null : value,
          score: null,
          confidence: item.type === "choice" && item.grade === true ? 0 : confidence,
          ...(item.type === "choice" && item.grade === true ? { grades: item.choices.map((choice) => ({ choice: choice.value, confidence: choice.value === value ? confidence : 0.1, evidence: `Fixture support for ${choice.value}.` })) } : {}),
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
const recommended: Question.Info = { ...question, options: [{ label: "One (Recommended)", description: "First option" }] }
const assessment = (selected: string, choices: string[]): Form.Assessment => ({ mode: "yolo", sourceSessionID: sessionID, fields: [{ key: "question_0", status: "assessed", reason: "Unique best-supported option.", recommendation: [selected], confidence: 0.9,
  grades: choices.map((choice) => ({ choice, confidence: choice === selected ? 0.9 : 0.1, evidence: `Fixture support for ${choice}.` })),
}] })

const setupAutonomy = Effect.fn("QuestionTest.setupAutonomy")(function* (mode: "normal" | "goal") {
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
    : autonomy.set({ sessionID, answers: "manual" })
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
  for (const yolo of [false] as const) {
    it.effect(`questions use explicit recommendations automatically only with Auto answers: yolo ${yolo}`, () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: yolo ? "yolo" : "manual" })
      const service = yield* Question.Service
      const pending = yield* waitForAsk(service, { sessionID, questions: [question] })
      expect(yield* service.list()).toEqual([pending.request])
      yield* service.reply({ requestID: pending.request.id, answers: [["Manual"]] })
      expect(yield* Fiber.join(pending.fiber)).toEqual({ status: "answered", answers: [["Manual"]] })
      yield* autonomy.set({ sessionID, answers: "auto" })
      expect(yield* service.ask({ sessionID, questions: [recommended] })).toEqual({
        status: "answered",
        answers: [["One (Recommended)"]],
        automatic: true,
        via: "auto-answer",
      })
      expect(yield* service.list()).toEqual([])
    }))
  }
  it.effect("free-text questions wait for the user with auto-answer in normal and goal states", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const autonomy = yield* SessionAutonomy.Service
      const fallback: Question.Info = { question: "Continue?", header: "Continue", options: [] }

      for (const mode of ["normal", "goal"] as const) {
        yield* setupAutonomy(mode)
        yield* autonomy.set({ sessionID, answers: "auto" })
        decisionBehavior = () => Effect.die("Auto answers must not request judgments")
        const pending = yield* waitForAsk(service, { sessionID, questions: [question, fallback] })
        yield* service.reply({ requestID: pending.request.id, answers: [["One"], ["Manual text"]] })
        expect(yield* Fiber.join(pending.fiber)).toEqual({
          status: "answered",
          answers: [["One"], ["Manual text"]],
        })
        expect(yield* service.list()).toEqual([])
      }
    }),
  )

  it.effect("replies reject answers outside closed options and duplicate selections", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const closed: Question.Info = { ...question, custom: false }
      const pending = yield* waitForAsk(service, { sessionID, questions: [closed] })
      const invalid = yield* service.reply({ requestID: pending.request.id, answers: [["Nope"]] }).pipe(Effect.flip)
      expect(invalid).toBeInstanceOf(Question.InvalidAnswerError)
      const duplicate = yield* service.reply({ requestID: pending.request.id, answers: [["One", "One"]] }).pipe(Effect.flip)
      expect(duplicate).toBeInstanceOf(Question.InvalidAnswerError)
      yield* service.reply({ requestID: pending.request.id, answers: [["One"]] })
      expect(yield* Fiber.join(pending.fiber)).toEqual({ status: "answered", answers: [["One"]] })
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

  it.effect("an interrupted ask publishes exactly one rejection for its request and records no answer", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const events = yield* EventRuntime.Service
      const terminal: EventRuntime.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Question.Event.Rejected.type || event.type === Question.Event.Replied.type) terminal.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
      yield* Fiber.interrupt(fiber)
      expect(terminal.map((event) => [event.type, event.data])).toEqual([[Question.Event.Rejected.type, { sessionID, requestID: request.id }]])
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: request.id, answers: [["Late"]] }).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: request.id }),
      )
      expect(terminal).toHaveLength(1)
    }),
  )

  it.effect("finalizing the service scope publishes exactly one rejection per pending request", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const database = yield* Database.Service
      const eventRuntime = yield* EventRuntime.Service
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Question.node]), [
        [Config.node, Layer.succeed(Config.Service, yield* Config.Service)],
        [Database.node, Layer.succeed(Database.Service, database)],
        [EventRuntime.node, Layer.succeed(EventRuntime.Service, eventRuntime)],
        [SessionAutonomy.node, Layer.succeed(SessionAutonomy.Service, yield* SessionAutonomy.Service)],
        [Decision.node, Layer.succeed(Decision.Service, yield* Decision.Service)],
      ])
      const terminal: EventRuntime.Payload[] = []
      const unsubscribe = yield* eventRuntime.listen((event) =>
        Effect.sync(() => {
          if (event.type === Question.Event.Rejected.type || event.type === Question.Event.Replied.type) terminal.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const service = Context.get(yield* Layer.buildWithScope(Layer.fresh(layer), scope), Question.Service)
      const first = yield* waitForAsk(service, { sessionID, questions: [question] })
      const second = yield* waitForAsk(service, { sessionID, questions: [question] })
      expect(first.request.id).not.toBe(second.request.id)
      yield* Fiber.interrupt(second.fiber)
      expect(terminal.map((event) => event.data)).toEqual([{ sessionID, requestID: second.request.id }])

      yield* Scope.close(scope, Exit.void)
      const exit = yield* Fiber.await(first.fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Question.RejectedError")
      expect(terminal.map((event) => [event.type, event.data])).toEqual([
        [Question.Event.Rejected.type, { sessionID, requestID: second.request.id }],
        [Question.Event.Rejected.type, { sessionID, requestID: first.request.id }],
      ])
      yield* Scope.close(scope, Exit.void)
      expect(terminal).toHaveLength(2)
    }),
  )

  it.effect("fresh service scopes on the same database do not restore ordinary pending questions", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const database = yield* Database.Service
      const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Question.node]), [
        [Config.node, Layer.succeed(Config.Service, yield* Config.Service)],
        [Database.node, Layer.succeed(Database.Service, database)],
        [EventRuntime.node, Layer.succeed(EventRuntime.Service, yield* EventRuntime.Service)],
        [SessionAutonomy.node, Layer.succeed(SessionAutonomy.Service, yield* SessionAutonomy.Service)],
        [Decision.node, Layer.succeed(Decision.Service, yield* Decision.Service)],
      ])
      const firstScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(layer), firstScope), Question.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(layer), secondScope), Question.Service)
      const { fiber, request } = yield* waitForAsk(first, { sessionID, questions: [question] })

      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: request.id }),
      )

      yield* Scope.close(firstScope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Question.RejectedError")
      yield* Scope.close(secondScope, Exit.void)
      const restartedScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(restartedScope, Exit.void))
      const restarted = yield* Layer.buildWithScope(Layer.fresh(layer), restartedScope)
      expect(Context.get(restarted, Database.Service).db).toBe(database.db)
      const service = Context.get(restarted, Question.Service)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ requestID: request.id, answers: [["Late"]] }).pipe(Effect.flip)).toEqual(
        new Question.NotFoundError({ requestID: request.id }),
      )
    }),
  )

  it.effect("sleep answers questions through the decision model", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "yolo" })
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
      expect(answers).toEqual({ status: "answered", answers: [["Two"]], automatic: true, via: "yolo", confidence: 0.9, assessment: assessment("Two", ["One", "Two"]) })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("sleep defers to the review box when the decision model refuse or fails", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "yolo" })
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

  it.effect("public question multiselect uses one coherent set rather than combining independent high grades", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = input => Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
      model: { providerID: "test", id: "decision-model" }, semantics: "model-estimate", version: 1,
      answers: input.request.questions.map(item => item.type === "choice" ? { name: item.name, type: "choice", answer: null, choice: null, score: null, confidence: 0,
        grades: [{ choice: "One", confidence: 0.95, evidence: "One engine is supported." }, { choice: "Two", confidence: 0.94, evidence: "The alternative engine is supported." }],
      } : { name: item.name, type: "text", answer: null, choice: null, score: null, confidence: 0.92, text: JSON.stringify({ recommendation: ["One"], compatible: true, reason: "The engines are mutually exclusive." }) }),
    } }))
    const service = yield* Question.Service
    expect(yield* service.ask({ sessionID, questions: [{ ...question, question: "Choose one of two mutually exclusive engines.", multiple: true, options: [{ label: "One", description: "First engine" }, { label: "Two", description: "Second engine" }] }] })).toMatchObject({
      status: "answered", answers: [["One"]], automatic: true, via: "yolo", confidence: 0.92,
      assessment: { mode: "yolo", fields: [{ status: "assessed", recommendation: ["One"], grades: [{ choice: "One" }, { choice: "Two" }] }] },
    })
  }))

  it.effect("duplicate actual option IDs produce an unavailable assessment without consulting the evaluator", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = () => Effect.die("Duplicate IDs must not reach the evaluator")
    const service = yield* Question.Service
    const pending = yield* waitForAsk(service, { sessionID, questions: [{ ...question, options: [question.options[0], question.options[0]] }] })
    expect(pending.request.assessment?.fields[0]?.status).toBe("unavailable")
    expect(pending.request.assessment?.fields[0]?.reason).toContain("duplicated")
    yield* service.reject(pending.request.id)
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
  }))

  it.effect("turning YOLO off while a sleeping answer is pending defers instead of applying it", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "yolo" })
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
      yield* autonomy.set({ sessionID, answers: "manual" })
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).status).toBe("deferred")
      expect(yield* service.list()).toEqual([])
    }),
  )

  describe("pending lifetime", () => {
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

    it.effect("sleep entry defers an unanswered question after 25 hours without answering it", () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const service = yield* Question.Service
      const published = yield* observe()
      const { fiber } = yield* waitForAsk(service, { sessionID, questions: [question] })
      yield* TestClock.adjust("25 hours")
      yield* service.deferPending(sessionID)
      expect((yield* Fiber.join(fiber)).status).toBe("deferred")
      const reviews = yield* SessionReviewFold.fold((yield* Database.Service).db, [sessionID])
      expect(reviews).toHaveLength(1)
      expect(reviews[0].payload).toEqual({ type: "question", questions: [question] })
      expect(reviews[0].decision).toBeUndefined()
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type, Question.Event.Deferred.type])
    }))

    it.effect("required answers remain pending after 25 hours without a synthetic result", () =>
      Effect.gen(function* () {
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [{ question: "Provide a value", header: "Value", options: [] }] })

        yield* TestClock.adjust("25 hours")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list()).toEqual([request])
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type])
        yield* service.reply({ requestID: request.id, answers: [["Late"]] })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["Late"]] })
        expect(yield* service.list()).toEqual([])
        expect(published.map((event) => [event.type, event.data])).toEqual([
          [Question.Event.Asked.type, request],
          [Question.Event.Replied.type, { sessionID, requestID: request.id, answers: [["Late"]] }],
        ])
        expect(yield* service.reply({ requestID: request.id, answers: [["Late"]] }).pipe(Effect.flip)).toEqual(
          new Question.NotFoundError({ requestID: request.id }),
        )
        expect(yield* service.reject(request.id).pipe(Effect.flip)).toEqual(
          new Question.NotFoundError({ requestID: request.id }),
        )
      }),
    )

    it.effect("choice questions accept a reply after 25 hours", () =>
      Effect.gen(function* () {
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* TestClock.adjust("25 hours")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list()).toEqual([request])
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type])
        yield* service.reply({ requestID: request.id, answers: [["One"]] })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["One"]] })
      }),
    )

    it.effect("a human answer emits no further settlement as time advances", () =>
      Effect.gen(function* () {
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

    it.effect("interrupting the ask rejects the pending question once and records no answer", () =>
      Effect.gen(function* () {
        const service = yield* Question.Service
        const published = yield* observe()
        const { fiber } = yield* waitForAsk(service, { sessionID, questions: [question] })
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust("10 minutes")
        expect(published.map((event) => event.type)).toEqual([Question.Event.Asked.type, Question.Event.Rejected.type])
        expect(yield* service.list()).toEqual([])
      }),
    )

    it.effect("explicit automatic answering remains available awake and asleep", () =>
      Effect.gen(function* () {
        yield* setupAutonomy("normal")
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID, answers: "auto" })
        const service = yield* Question.Service
        decisionBehavior = () => Effect.die("Auto answers must not request judgments")
        const answered = { status: "answered", answers: [["One (Recommended)"]], automatic: true, via: "auto-answer" } as const
        expect(yield* service.ask({ sessionID, questions: [recommended] })).toEqual(answered)
        yield* autonomy.set({ sessionID, sleep: true })
        expect(yield* service.ask({ sessionID, questions: [recommended] })).toEqual(answered)
        expect((yield* service.ask({ sessionID, questions: [question] })).status).toBe("deferred")
      }),
    )

    it.effect("YOLO evaluator answers a question awake and records model provenance", () =>
      Effect.gen(function* () {
        yield* setupAutonomy("normal")
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID, answers: "yolo" })
        const service = yield* Question.Service
        decisionBehavior = decisionChoice("One", 0.9)
        expect(yield* service.ask({ sessionID, questions: [question] })).toEqual({
          status: "answered",
          answers: [["One"]],
          automatic: true,
          via: "yolo",
          confidence: 0.9,
          assessment: assessment("One", ["One"]),
        })
      }),
    )
  })
})

describe("Question delegated settlement", () => {
  const delegatedSource = { kind: "dots-delegation", anchorSessionID: Session.ID.make("ses_anchor"), delegationID: "proposal_1", revision: 1, exchangeID: "exchange_1" } as const
  it.effect("propagates delegated source to the outcome only on exact fingerprint", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const service = yield* Question.Service
      const fiber = yield* service.ask({ sessionID, questions: [{ ...question, custom: false }] }).pipe(Effect.forkScoped)
      let request = (yield* service.list())[0]
      for (let attempt = 0; request === undefined && attempt < 100; attempt++) {
        yield* Effect.yieldNow
        request = (yield* service.list())[0]
      }
      expect(request).toBeDefined()
      const fingerprint = Question.fingerprint(request!)
      expect((yield* service.replyDelegated({ requestID: request!.id, answers: [["One"]], fingerprint: "0".repeat(64), source: delegatedSource, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* service.list()).toHaveLength(1)
      yield* service.replyDelegated({ requestID: request!.id, answers: [["One"]], fingerprint, source: delegatedSource, validate: () => Effect.succeed(true) })
      const outcome = yield* Fiber.join(fiber)
      expect(outcome.status).toBe("answered")
      if (outcome.status === "answered") expect(outcome.source).toEqual(delegatedSource)
    }))
})
