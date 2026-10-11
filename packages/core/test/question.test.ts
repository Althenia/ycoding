import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const questions = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionAutonomy.node, Question.node]),
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
  for (const yolo of [0, 1, 2, 3] as const) {
    it.effect(`questions are automatic only at YOLO 2-3: level ${yolo}`, () => Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID, yolo })
      const service = yield* Question.Service
      if (yolo >= 2) {
        expect(yield* service.ask({ sessionID, questions: [question] })).toEqual([["One"]])
        expect(yield* service.list()).toEqual([])
        return
      }
      const pending = yield* waitForAsk(service, { sessionID, questions: [question] })
      expect(yield* service.list()).toEqual([pending.request])
      yield* service.reply({ requestID: pending.request.id, answers: [["Manual"]] })
      expect(yield* Fiber.join(pending.fiber)).toEqual([["Manual"]])
    }))
  }
  it.effect("auto answers questions in yolo and goal mode without pending requests", () =>
    Effect.gen(function* () {
      const service = yield* Question.Service
      const fallback: Question.Info = { question: "Continue?", header: "Continue", options: [] }

      for (const mode of ["yolo", "goal"] as const) {
        yield* setupAutonomy(mode)
        expect(yield* service.ask({ sessionID, questions: [question, fallback] })).toEqual([
          ["One"],
          ["Continue with the safest reasonable default."],
        ])
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

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
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
})
