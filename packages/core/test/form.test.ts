import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Decision } from "@ycoding-ai/core/decision"
import { AnswerFallback } from "@ycoding-ai/core/answer"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { Database } from "@ycoding-ai/core/database/database"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { testEffect } from "./lib/effect"

let decisionBehavior: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("Forms must not request judgments unless deferred")

const forms = AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node, Form.node]),
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
const it = testEffect(forms)

const decisionChoice = (value: string, confidence: number) => (input: Decision.Input) =>
  Effect.succeed(
    Schema.decodeUnknownSync(Decision.Output)({
      provider: "agent",
      response: {
        model: { providerID: "test", id: "decision-model" },
        semantics: "model-estimate",
        version: 1,
        answers: input.request.questions.map((question) => ({
          name: question.name,
          type: "choice",
          answer: null,
          choice: value,
          score: null,
          confidence,
        })),
      },
    }),
  )

const formID = Form.ID.create("frm_test")
const input = {
  id: formID,
  sessionID: SessionSchema.ID.make("ses_test"),
  title: "Test form",
  fields: [{ key: "name", type: "string", required: true }],
} satisfies Form.CreateInput

const setupAutonomy = Effect.fn("FormTest.setupAutonomy")(function* (mode: "normal" | "goal") {
  const autonomy = yield* SessionAutonomy.Service
  const { db } = yield* Database.Service
  const directory = AbsolutePath.make("/tmp/ycoding-form-autonomy")
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: input.sessionID,
      project_id: Project.ID.global,
      directory,
      path: "",
      title: "Form autonomy",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* mode === "goal"
    ? autonomy.setGoal({ sessionID: input.sessionID, text: "Finish safely" })
    : autonomy.set({ sessionID: input.sessionID, answers: "manual" })
})

describe("Form", () => {
  it.effect("restored YOLO discards revoked Form grades and confidence without another evaluator", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    decisionBehavior = request => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => {
      calls++
      return Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
        model: { providerID: "test", id: "decision-model" }, semantics: "model-estimate", version: 1,
        answers: request.request.questions.map(question => ({ name: question.name, type: "choice", answer: null, choice: null, score: null, confidence: 0,
          grades: question.type === "choice" ? question.choices.map(choice => ({ choice: choice.value, confidence: choice.value === "Careful" ? 0.9 : 0.1, evidence: "Held evaluator evidence" })) : [],
        })),
      } })
    })))
    const service = yield* Form.Service
    const fiber = yield* service.ask({ ...input, metadata: { kind: "question" }, fields: [{ key: "plan", type: "string", required: true, options: [{ value: "Fast", label: "Fast" }, { value: "Careful", label: "Careful" }] }] }).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* autonomy.set({ sessionID: input.sessionID, answers: "manual" })
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
    yield* Deferred.succeed(release, undefined)
    const result = yield* Fiber.join(fiber)
    expect(result).toMatchObject({ status: "answered", answer: { plan: "Fast" }, automatic: true, via: "yolo", assessment: { mode: "yolo", sourceSessionID: input.sessionID } })
    expect(result).not.toHaveProperty("confidence")
    expect(result.assessment?.fields).toEqual([{ key: "plan", status: "not_assessed", reason: "Previous assessment was revoked; current YOLO uses a deterministic valid fallback." }])
    expect(calls).toBe(1)
    expect(yield* service.list()).toEqual([])
  }))

  for (const mode of ["manual", "auto"] as const) {
    it.effect(`${mode} preserves closed empty-option membership and invalid defaults`, () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      yield* (yield* SessionAutonomy.Service).set({ sessionID: input.sessionID, answers: mode })
      decisionBehavior = () => Effect.die("Manual and Auto must not consult an evaluator")
      const service = yield* Form.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* (yield* EventRuntime.Service).listen(event => event.type === Form.Event.Created.type
        ? Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form).pipe(Effect.asVoid) : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask({ ...input, fields: [
        { key: "text", type: "string", options: [], default: "invented" },
        { key: "closedText", type: "string", options: [], custom: false, default: "invented" },
        { key: "selected", type: "multiselect", options: [], default: ["invented"] },
        { key: "closedSelected", type: "multiselect", options: [], custom: false, default: ["invented"] },
      ] }).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)
      const invalidAnswers: ReadonlyArray<Form.Answer> = [{ text: "invented" }, { closedText: "invented" }, { selected: ["invented"] }, { closedSelected: ["invented"] }]
      for (const answer of invalidAnswers) {
        expect(yield* service.reply({ id: form.id, answer }).pipe(Effect.flip)).toBeInstanceOf(Form.InvalidAnswerError)
        expect(yield* service.state(form.id)).toEqual({ status: "pending" })
      }
      yield* service.reply({ id: form.id, answer: { selected: [], closedSelected: [] } })
      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { selected: [], closedSelected: [] } })
    }))
  }

  it.effect("YOLO rejects closed empty-option required fields without invalid fallback or review", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    yield* (yield* SessionAutonomy.Service).set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "refused" }))
    const service = yield* Form.Service
    for (const type of ["string", "multiselect"] as const) {
      expect(yield* service.ask({ ...input, id: Form.ID.create(), fields: [{ key: "closed", type, options: [], custom: false, required: true }] }).pipe(Effect.flip)).toBeInstanceOf(Form.InvalidFormError)
      expect(yield* service.list()).toEqual([])
    }
    expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [input.sessionID])).toEqual([])
  }))

  test("pattern witnesses stay bounded through nested quantifiers and long sequences", () => {
    const nested = AnswerFallback.patternText("^((a{128}){128}){128}$")
    const sequence = AnswerFallback.patternText("^a{8192}b{8192}$")
    expect(nested.length).toBeLessThanOrEqual(8192)
    expect(sequence.length).toBeLessThanOrEqual(8192)
    expect(AnswerFallback.patternText("^[A-Z]{2}[0-9]{3}$")).toMatch(/^[A-Z]{2}[0-9]{3}$/)
  })

  for (const failure of ["provider-failed", "timeout", "refused", "invalid-output", "empty", "low-confidence"] as const) {
    it.effect(`YOLO settles explicit required, optional and conditional typed fields after ${failure}`, () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
      decisionBehavior = failure === "empty" ? () => Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
        model: { providerID: "test", id: "decision-model" }, semantics: "model-estimate", version: 1, answers: [],
      } })) : failure === "low-confidence" ? decisionChoice("bad", 0.1)
        : () => Effect.fail(new Decision.Error({ reason: failure }))
      const service = yield* Form.Service
      const settings = { ...input, metadata: { requireExplicitDecision: true }, fields: [
        { key: "choice", type: "string", options: [{ value: "bad", label: "Bad" }, { value: "good", label: "Good (Recommended)" }], required: true },
        { key: "count", type: "integer", minimum: 1.2, maximum: 2.2, required: true },
        { key: "negative", type: "integer", maximum: -0.2 },
        { key: "ratio", type: "number", minimum: 0.2, maximum: 0.3 },
        { key: "confirm", type: "boolean", default: true },
        { key: "selected", type: "multiselect", options: [{ value: "one", label: "One (Recommended)" }, { value: "two", label: "Two" }], minItems: 2, maxItems: 2, required: true },
        { key: "text", type: "string", options: [], custom: true, minLength: 8, maxLength: 12, required: true },
        { key: "code", type: "string", pattern: "^[A-Z]{2}[0-9]{3}$", required: true },
        { key: "email", type: "string", format: "email" },
        { key: "uri", type: "string", format: "uri" },
        { key: "date", type: "string", format: "date" },
        { key: "time", type: "string", format: "date-time" },
        { key: "active", type: "string", required: true, when: [{ key: "confirm", op: "eq", value: true }] },
        { key: "inactive", type: "string", required: true, when: [{ key: "confirm", op: "eq", value: false }] },
      ] } satisfies Form.CreateInput
      const outcome = yield* service.ask(settings)
      expect(outcome).toMatchObject({ status: "answered", automatic: true, via: "yolo" })
      if (outcome.status === "answered") {
        expect(Form.validateAnswer(settings, outcome.answer)).toBeUndefined()
        expect(outcome.answer).toMatchObject({ choice: "good", count: 2, negative: -1, ratio: 0.2, confirm: true, selected: ["one", "two"] })
        expect(Object.keys(outcome.answer)).toHaveLength(13)
        expect(outcome.answer).not.toHaveProperty("inactive")
      }
      expect(yield* service.list()).toEqual([])
    }))
  }

  it.effect("YOLO reconciles a pending explicit form exactly once", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const service = yield* Form.Service
    const created = yield* service.create({ ...input, metadata: { requireExplicitDecision: true } })
    const autonomy = yield* SessionAutonomy.Service
    const events = yield* EventRuntime.Service
    const replies: unknown[] = []
    const unsubscribe = yield* events.listen(event => Effect.sync(() => { if (event.type === Form.Event.Replied.type) replies.push(event.data) }))
    yield* Effect.addFinalizer(() => unsubscribe)
    decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "refused" }))
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
    yield* service.reconcileAutonomy(input.sessionID)
    yield* service.reconcileAutonomy(input.sessionID)
    expect((yield* service.state(created.id)).status).toBe("answered")
    expect(replies).toHaveLength(1)
    expect(yield* service.list()).toEqual([])
  }))

  it.effect("YOLO free-text multiselect and optional text progress after evaluator deadlines", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    const entered = yield* Deferred.make<void>()
    decisionBehavior = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    const service = yield* Form.Service
    const fiber = yield* service.ask({ ...input, fields: [
      { key: "steps", type: "multiselect", options: [], custom: true, minItems: 2, maxItems: 2, required: true },
      { key: "note", type: "string" },
    ] }).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* TestClock.adjust("121 seconds")
    const outcome = yield* Fiber.join(fiber)
    expect(outcome).toMatchObject({ status: "answered", automatic: true, via: "yolo" })
    if (outcome.status === "answered") {
      expect(outcome.answer.steps).toHaveLength(2)
      expect(String(outcome.answer.note).trim().length).toBeGreaterThan(0)
    }
    expect(yield* service.list()).toEqual([])
  }))

  it.effect("YOLO rejects contradictory constraints without opening a review", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    const service = yield* Form.Service
    const error = yield* service.ask({ ...input, fields: [{ key: "name", type: "string", minLength: 3, maxLength: 2 }] }).pipe(Effect.flip)
    expect(error).toBeInstanceOf(Form.InvalidFormError)
    expect(yield* service.list()).toEqual([])
    expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [input.sessionID])).toEqual([])
  }))

  it.effect("YOLO rejects unsatisfiable patterns instead of waiting or returning invalid text", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "refused" }))
    const service = yield* Form.Service
    expect(yield* service.ask({ ...input, fields: [{ key: "name", type: "string", pattern: "(?!)", required: true }] }).pipe(Effect.flip)).toBeInstanceOf(Form.InvalidFormError)
    expect(yield* service.list()).toEqual([])
    expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [input.sessionID])).toEqual([])
  }))

  it.effect("YOLO reconciliation releases an explicit form waiter with machine attribution", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const service = yield* Form.Service
    const events = yield* EventRuntime.Service
    const created = yield* Deferred.make<void>()
    const replies: unknown[] = []
    const unsubscribe = yield* events.listen(event => event.type === Form.Event.Created.type ? Deferred.succeed(created, undefined).pipe(Effect.asVoid) : Effect.sync(() => { if (event.type === Form.Event.Replied.type) replies.push(event.data) }))
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.ask({ ...input, metadata: { requireExplicitDecision: true } }).pipe(Effect.forkScoped)
    yield* Deferred.await(created)
    yield* Effect.yieldNow
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "refused" }))
    yield* Effect.all([service.reconcileAutonomy(input.sessionID), service.deferPending(input.sessionID)], { concurrency: "unbounded" })
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: "answered", automatic: true, via: "yolo" })
    expect(replies).toHaveLength(1)
    expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [input.sessionID])).toEqual([])
  }))

  it.effect("YOLO accepts valid optional scalar evaluator values and exposes their constraints", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
    const calls: Decision.Input[] = []
    decisionBehavior = request => {
      calls.push(request)
      return Effect.succeed(Schema.decodeUnknownSync(Decision.Output)({ provider: "agent", response: {
        model: { providerID: "test", id: "decision-model" }, semantics: "model-estimate", version: 1,
        answers: request.request.questions.map(question => ({ name: question.name, type: question.type === "predicate" ? "predicate" : "text", answer: question.type === "predicate" ? false : null, choice: null, score: null, confidence: 0.9, text: question.type === "predicate" ? null : question.name === "count" ? "-1" : question.name === "ratio" ? "0.25" : "bounded" })),
      } }))
    }
    const service = yield* Form.Service
    expect(yield* service.ask({ ...input, fields: [
      { key: "count", type: "integer", maximum: -0.2 }, { key: "ratio", type: "number", minimum: 0.2, maximum: 0.3 },
      { key: "confirm", type: "boolean" }, { key: "text", type: "string", minLength: 7, maxLength: 7 },
    ] })).toMatchObject({ status: "answered", answer: { count: -1, ratio: 0.25, confirm: false, text: "bounded" }, automatic: true, via: "yolo", confidence: 0.9 })
    expect(JSON.stringify(calls)).toContain('"maximum":-0.2')
    expect(JSON.stringify(calls)).toContain('"minLength":7')
    expect(JSON.stringify(calls)).not.toContain("Refuse if the evidence is insufficient")
  }))

  it.effect("YOLO preserves physical external fields without synthetic acknowledgement", () => Effect.gen(function* () {
    yield* setupAutonomy("normal")
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
    decisionBehavior = () => Effect.die("Physical external fields must not consult the evaluator")
    const service = yield* Form.Service
    expect(yield* service.ask({ ...input, fields: [{ key: "oauth", type: "external", url: "https://example.invalid/authorize" }] })).toMatchObject({ status: "deferred" })
    expect(yield* service.list()).toEqual([])
  }))

  for (const yolo of [false] as const) {
    it.effect(`forms use explicit defaults automatically only with Auto answers: yolo ${yolo}`, () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: yolo ? "yolo" : "manual" })
      const service = yield* Form.Service
      const settings = { ...input, fields: [{ key: "confirm", type: "boolean", default: true }] } satisfies Form.CreateInput
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
        ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
        : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask(settings).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([form])
      yield* service.reply({ id: form.id, answer: { confirm: false } })
      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { confirm: false } })
      yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
      expect(yield* service.ask({ ...settings, id: Form.ID.create("frm_toggle") })).toEqual({ status: "answered", answer: { confirm: true }, automatic: true, via: "auto-answer" })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }))
  }
  it.effect("automatic answering never fabricates values or acknowledges external fields", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const autonomy = yield* SessionAutonomy.Service
      yield* setupAutonomy("normal")
      yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
        ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
        : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)

      const fiber = yield* service.ask({
        sessionID: input.sessionID,
        title: "Release settings",
        fields: [
          {
            key: "branch",
            type: "string",
            required: true,
            options: [{ value: "main", label: "Main" }],
          },
          { key: "attempts", type: "integer", required: true, minimum: 1 },
          { key: "confirm", type: "boolean", required: true, default: true },
          {
            key: "features",
            type: "multiselect",
            required: true,
            minItems: 1,
            options: [
              { value: "tests", label: "Tests" },
              { value: "docs", label: "Docs" },
            ],
          },
          { key: "setup", type: "external", url: "https://example.com/setup" },
        ],
      }).pipe(Effect.forkScoped)

      const form = yield* Deferred.await(created)
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([form])
      yield* service.reply({
        id: form.id,
        answer: { branch: "main", attempts: 2, confirm: false, features: ["docs"], setup: true },
      })
      expect(yield* Fiber.join(fiber)).toEqual({
        status: "answered",
        answer: { branch: "main", attempts: 2, confirm: false, features: ["docs"], setup: true },
      })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }),
  )

  it.effect("auto answers deterministic forms with the toggle in goal mode", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const autonomy = yield* SessionAutonomy.Service
      yield* setupAutonomy("goal")
      yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
      decisionBehavior = () => Effect.die("Auto answers must not request judgments")

      expect(
        yield* service.ask({
          id: Form.ID.create("frm_goal_auto"),
          sessionID: input.sessionID,
          title: "Goal settings",
          fields: [
            {
              key: "branch",
              type: "string",
              required: true,
              options: [{ value: "main", label: "Main (Recommended)" }],
            },
            { key: "confirm", type: "boolean", required: true, default: true },
          ],
        }),
      ).toEqual({ status: "answered", answer: { branch: "main", confirm: true }, automatic: true, via: "auto-answer" })
      expect(yield* service.state(Form.ID.create("frm_goal_auto"))).toEqual({ status: "answered", answer: { branch: "main", confirm: true } })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }),
  )

  it.effect("required free-text forms wait for the user with the toggle in goal mode", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const autonomy = yield* SessionAutonomy.Service
      yield* setupAutonomy("goal")
      yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
        ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
        : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)

      const fiber = yield* service.ask({
        id: Form.ID.create("frm_goal_text"),
        sessionID: input.sessionID,
        title: "Required input",
        fields: [{ key: "name", type: "string", required: true }],
      }).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([form])
      yield* service.reply({ id: form.id, answer: { name: "release-42" } })
      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { name: "release-42" } })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }),
  )

  it.effect("returns a terminal cancelled state from ask", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Form.Event.Created.type
          ? Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)

      yield* service.cancel(form.id)

      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
      expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
    }),
  )

  for (const settlement of ["reply", "cancel"] as const) {
    it.effect(`an unsatisfied automatic form keeps the manual ${settlement} result`, () => Effect.gen(function* () {
      decisionBehavior = () => Effect.die("Awake forms must not request judgments")
      yield* setupAutonomy("goal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) => event.type === Form.Event.Created.type
        ? Deferred.succeed(created, Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form).pipe(Effect.asVoid)
        : Effect.void)
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask({
        ...input,
        fields: [{ key: "name", type: "string", required: true, pattern: "^release-[0-9]+$" }],
      }).pipe(Effect.forkScoped)
      const form = yield* Deferred.await(created)
      yield* TestClock.adjust("25 hours")
      expect(fiber.pollUnsafe()).toBeUndefined()
      expect(yield* service.state(form.id)).toEqual({ status: "pending" })
      yield* settlement === "reply"
        ? service.reply({ id: form.id, answer: { name: "release-42" } })
        : service.cancel(form.id)
      const expected = (settlement === "reply"
        ? { status: "answered", answer: { name: "release-42" } }
        : { status: "cancelled" }) satisfies Form.TerminalState
      expect(yield* Fiber.join(fiber)).toEqual(expected)
      expect(yield* service.state(form.id)).toEqual(expected)
    }))
  }

  for (const deferred of [false, true]) {
    for (const settlement of ["reply", "cancel"] as const) {
      it.effect(`${deferred ? "deferred" : "without defer"} automatic answers preserve a winning human ${settlement}`, () => Effect.gen(function* () {
        yield* setupAutonomy("goal")
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID: input.sessionID, answers: deferred ? "yolo" : "auto" })
        if (deferred) yield* autonomy.set({ sessionID: input.sessionID, defer: true })
        decisionBehavior = deferred ? decisionChoice("Fast", 0.9) : () => Effect.die("Awake forms must not request judgments")
        const service = yield* Form.Service
        const events = yield* EventRuntime.Service
        const published: EventRuntime.Payload[] = []
        const unsubscribe = yield* events.listen((event) => Effect.gen(function* () {
          if (event.type.startsWith("form.")) published.push(event)
          if (event.type !== Form.Event.Created.type) return
          const form = Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form
          yield* (settlement === "reply"
            ? service.reply({ id: form.id, answer: { plan: "Careful" } })
            : service.cancel(form.id)).pipe(Effect.orDie)
        }))
        yield* Effect.addFinalizer(() => unsubscribe)
        const expected = (settlement === "reply" ? { status: "answered", answer: { plan: "Careful" } } : { status: "cancelled" }) satisfies Form.TerminalState
        expect(yield* service.ask({ ...input, fields: [{ key: "plan", type: "string", required: true, options: [
          { value: "Fast", label: "Fast" }, { value: "Careful", label: "Careful" },
        ] }] })).toEqual(expected)
        expect(yield* service.state(input.id)).toEqual(expected)
        expect(published.map((event) => [event.type, event.data])).toEqual([
          [Form.Event.Created.type, { form: yield* service.get(input.id) }],
          settlement === "reply"
            ? [Form.Event.Replied.type, { id: input.id, sessionID: input.sessionID, answer: { plan: "Careful" } }]
            : [Form.Event.Cancelled.type, { id: input.id, sessionID: input.sessionID }],
        ])
      }))
    }
  }

  it.effect("supports the temporary global mcp elicitation owner", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "MCP input",
        fields: [{ key: "name", type: "string", required: true }],
      })
      expect(created.sessionID).toBe("global")
      expect(created.title).toBe("MCP input")

      const owned = yield* service.list({ sessionID: "global" })
      expect(owned.map((form) => form.id)).toEqual([created.id])
      expect(yield* service.list({ sessionID: "other" })).toEqual([])

      yield* service.reply({ id: created.id, answer: { name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { name: "Ava" } })

      const externalOnly = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [{ key: "setup", type: "external", url: "https://example.com/setup" }],
      })
      yield* service.reply({ id: externalOnly.id, answer: { setup: true } })
      expect(yield* service.state(externalOnly.id)).toEqual({ status: "answered", answer: { setup: true } })
    }),
  )

  it.effect("gates required fields and rejects inactive answers via when", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Conditional form",
        fields: [
          { key: "confirm", type: "boolean", required: true },
          { key: "reason", type: "string", required: true, when: [{ key: "confirm", op: "eq", value: false }] },
        ],
      })

      const inactive = yield* service
        .reply({ id: created.id, answer: { confirm: true, reason: "x" } })
        .pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: reason" }),
      )

      const missing = yield* service.reply({ id: created.id, answer: { confirm: false } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: reason" }),
      )

      yield* service.reply({ id: created.id, answer: { confirm: false, reason: "not ready" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { confirm: false, reason: "not ready" },
      })
    }),
  )

  it.effect("evaluates when against multiselect answers as inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Multiselect form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "goVersion", type: "string", required: true, when: [{ key: "langs", op: "eq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["go", "ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: goVersion" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["ts"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["ts"] } })
    }),
  )

  it.effect("requires every when condition to match and treats empty when as active", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Dependent form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "boolean" },
          {
            key: "x",
            type: "string",
            required: true,
            when: [
              { key: "a", op: "eq", value: true },
              { key: "b", op: "eq", value: true },
            ],
          },
          { key: "z", type: "string", required: true, when: [] },
        ],
      })

      const missingX = yield* service.reply({ id: created.id, answer: { a: true, b: true, z: "ok" } }).pipe(Effect.flip)
      expect(missingX).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: x" }),
      )

      const inactiveX = yield* service
        .reply({ id: created.id, answer: { a: true, b: false, x: "nope", z: "ok" } })
        .pipe(Effect.flip)
      expect(inactiveX).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: x" }))

      const missingZ = yield* service.reply({ id: created.id, answer: { a: true, b: false } }).pipe(Effect.flip)
      expect(missingZ).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: z" }),
      )

      yield* service.reply({ id: created.id, answer: { a: true, b: false, z: "ok" } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: true, b: false, z: "ok" } })
    }),
  )

  it.effect("evaluates neq against multiselect answers as non-inclusion", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const options = [
        { value: "go", label: "Go" },
        { value: "ts", label: "TypeScript" },
      ]
      const created = yield* service.create({
        sessionID: "global",
        title: "Selection form",
        fields: [
          { key: "langs", type: "multiselect", options },
          { key: "note", type: "string", required: true, when: [{ key: "langs", op: "neq", value: "go" }] },
        ],
      })

      const missing = yield* service.reply({ id: created.id, answer: { langs: ["ts"] } }).pipe(Effect.flip)
      expect(missing).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      // an answered-but-empty multiselect also satisfies neq
      const missingEmpty = yield* service.reply({ id: created.id, answer: { langs: [] } }).pipe(Effect.flip)
      expect(missingEmpty).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Missing required form field: note" }),
      )

      const inactive = yield* service.reply({ id: created.id, answer: { langs: ["go"], note: "x" } }).pipe(Effect.flip)
      expect(inactive).toEqual(
        new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: note" }),
      )

      yield* service.reply({ id: created.id, answer: { langs: ["go"] } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { langs: ["go"] } })
    }),
  )

  it.effect("treats unanswered when references as false and cascades inactivity", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "Cascading form",
        fields: [
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: true }] },
          // neq also fails against an unanswered reference, and hiding b cascades here through
          // the reject-inactive-answers rule: b can never be answered while a is false.
          { key: "c", type: "string", required: true, when: [{ key: "b", op: "neq", value: "x" }] },
        ],
      })

      const inactive = yield* service.reply({ id: created.id, answer: { a: false, b: "yes" } }).pipe(Effect.flip)
      expect(inactive).toEqual(new Form.InvalidAnswerError({ id: created.id, message: "Form field is not active: b" }))

      yield* service.reply({ id: created.id, answer: { a: false } })
      expect(yield* service.state(created.id)).toEqual({ status: "answered", answer: { a: false } })
    }),
  )

  it.effect("rejects invalid when definitions at creation", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const flipCreate = (fields: Form.CreateInput["fields"]) =>
        service.create({ sessionID: "global", title: "Invalid form", fields }).pipe(Effect.flip)

      expect(
        yield* flipCreate([{ key: "b", type: "string", when: [{ key: "missing", op: "eq", value: "x" }] }]),
      ).toEqual(
        new Form.InvalidFormError({ message: "Form field condition must reference an earlier field: b -> missing" }),
      )

      expect(
        yield* flipCreate([
          { key: "a", type: "string" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "external", url: "https://example.com" },
          { key: "a", type: "string" },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Duplicate form field key: a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "boolean" },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "yes" }] },
        ]),
      ).toEqual(new Form.InvalidFormError({ message: "Form field condition value must be a boolean: b -> a" }))

      expect(
        yield* flipCreate([
          { key: "a", type: "string", options: [{ value: "x", label: "X" }] },
          { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "y" }] },
        ]),
      ).toEqual(
        new Form.InvalidFormError({
          message: "Form field condition value must be one of the field's options: b -> a",
        }),
      )
      expect(yield* flipCreate([
        { key: "a", type: "string", options: [], custom: false },
        { key: "b", type: "string", when: [{ key: "a", op: "eq", value: "invented" }] },
      ])).toEqual(new Form.InvalidFormError({ message: "Form field condition value must be one of the field's options: b -> a" }))
    }),
  )

  it.effect("requires external field acknowledgements", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const created = yield* service.create({
        sessionID: "global",
        title: "External setup",
        fields: [
          { key: "authorization", type: "external", url: "https://example.com/setup", title: "Open setup" },
          { key: "name", type: "string", required: true },
        ],
      })

      const invalidAnswers: ReadonlyArray<Form.Answer> = [
        { name: "Ava" },
        { authorization: false, name: "Ava" },
        { authorization: "yes", name: "Ava" },
      ]
      for (const answer of invalidAnswers) {
        expect(yield* service.reply({ id: created.id, answer }).pipe(Effect.flip)).toEqual(
          new Form.InvalidAnswerError({
            id: created.id,
            message: "External form field must be acknowledged: authorization",
          }),
        )
      }

      yield* service.reply({ id: created.id, answer: { authorization: true, name: "Ava" } })
      expect(yield* service.state(created.id)).toEqual({
        status: "answered",
        answer: { authorization: true, name: "Ava" },
      })
    }),
  )

  it.effect("cleans up created forms when event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === Form.Event.Created.type ? Effect.die("create listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.create(input)))).toBe(true)
      expect(yield* service.get(formID).pipe(Effect.flip)).toEqual(new Form.NotFoundError({ id: formID }))

      yield* unsubscribe
      expect(yield* service.create(input)).toMatchObject({ id: formID })
    }),
  )

  it.effect("keeps forms pending when reply event publication fails", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      yield* service.create(input)
      const unsubscribe = yield* events.listen((event) =>
        event.type === Form.Event.Replied.type ? Effect.die("reply listener failed") : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      expect(Exit.isFailure(yield* Effect.exit(service.reply({ id: formID, answer: { name: "Ava" } })))).toBe(true)
      expect(yield* service.state(formID)).toEqual({ status: "pending" })

      yield* unsubscribe
      yield* service.reply({ id: formID, answer: { name: "Ava" } })
      expect(yield* service.state(formID)).toEqual({ status: "answered", answer: { name: "Ava" } })
    }),
  )

  it.effect("defer answers option fields through the decision model", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
      yield* autonomy.set({ sessionID: input.sessionID, defer: true })
      decisionBehavior = decisionChoice("Careful", 0.9)
      const service = yield* Form.Service
      const settings = {
        ...input,
        id: Form.ID.create("frm_defer_choice"),
        fields: [
          {
            key: "plan",
            type: "string",
            required: true,
            options: [
              { value: "Fast", label: "Fast" },
              { value: "Careful", label: "Careful" },
            ],
          },
        ],
      } satisfies Form.CreateInput
      expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { plan: "Careful" }, automatic: true, via: "yolo", confidence: 0.9 })
      expect(yield* service.state(settings.id)).toEqual({ status: "answered", answer: { plan: "Careful" } })
    }),
  )

  it.effect("YOLO selects a valid fallback when the evaluator fails with defer enabled", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
      yield* autonomy.set({ sessionID: input.sessionID, defer: true })
      decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "provider-failed" }))
      const service = yield* Form.Service
      const settings = {
        ...input,
        id: Form.ID.create("frm_defer_fallback"),
        fields: [
          {
            key: "plan",
            type: "string",
            required: true,
            options: [
              { value: "Fast", label: "Fast" },
              { value: "Careful", label: "Careful" },
            ],
          },
        ],
      } satisfies Form.CreateInput
      const answered = yield* service.ask(settings)
      expect(answered).toEqual({ status: "answered", answer: { plan: "Fast" }, automatic: true, via: "yolo" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  for (const reason of ["disabled", "free_text", "low_confidence"] as const) {
    it.effect(`defer ${reason} preserves decision-mode attribution`, () => Effect.gen(function* () {
      yield* setupAutonomy("goal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({
        sessionID: input.sessionID,
        answers: reason === "low_confidence" ? "yolo" : reason === "free_text" ? "auto" : "manual",
        defer: true,
      })
      const calls: Decision.Input[] = []
      decisionBehavior = (value) => {
        calls.push(value)
        return reason === "low_confidence" ? decisionChoice("Careful", 0.79)(value) : Effect.die("This form must defer without a helper")
      }
      const service = yield* Form.Service
      expect(yield* service.ask({
        ...input,
        fields: reason === "free_text"
          ? [{ key: "plan", type: "string", required: true }]
          : [{ key: "plan", type: "string", required: true, options: [{ value: "Careful", label: "Careful" }] }],
      })).toEqual(reason === "low_confidence"
        ? { status: "answered", answer: { plan: "Careful" }, automatic: true, via: "yolo" }
        : { status: "deferred", itemID: expect.any(String) })
      expect(calls).toHaveLength(reason === "low_confidence" ? 1 : 0)
      expect(yield* service.list()).toEqual([])
    }))
  }

  it.effect("defer inference creates no human-wait form state before the decision settles", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
      yield* autonomy.set({ sessionID: input.sessionID, defer: true })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      decisionBehavior = (value) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(decisionChoice("Careful", 0.9)(value)),
      )
      const events = yield* EventRuntime.Service
      const published: string[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
        if (event.type.startsWith("form.")) published.push(event.type)
      }))
      yield* Effect.addFinalizer(() => unsubscribe)
      const service = yield* Form.Service
      const id = Form.ID.create("frm_defer_inference_state")
      const fiber = yield* service.ask({
        id, sessionID: input.sessionID, title: "Choose a plan",
        fields: [{ key: "plan", type: "string", required: true, options: [
          { value: "Fast", label: "Fast" }, { value: "Careful", label: "Careful" },
        ] }],
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.reply({ id, answer: { plan: "Fast" } }).pipe(Effect.flip)).toBeInstanceOf(Form.NotFoundError)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { plan: "Careful" }, automatic: true, via: "yolo", confidence: 0.9 })
      expect(published).toEqual([Form.Event.Created.type, Form.Event.Replied.type])
    }),
  )

  it.effect("turning YOLO off while a deferred answer is pending defers instead of applying it", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo" })
      yield* autonomy.set({ sessionID: input.sessionID, defer: true })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      decisionBehavior = (value) => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(decisionChoice("Careful", 0.9)(value)),
      )
      const service = yield* Form.Service
      const fiber = yield* service.ask({
        ...input,
        id: Form.ID.create("frm_defer_toggle_off"),
        fields: [
          {
            key: "plan",
            type: "string",
            required: true,
            options: [
              { value: "Fast", label: "Fast" },
              { value: "Careful", label: "Careful" },
            ],
          },
        ],
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)
      yield* autonomy.set({ sessionID: input.sessionID, answers: "manual" })
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(fiber)).toEqual({ status: "deferred", itemID: expect.any(String) })
      expect(yield* service.list()).toEqual([])
    }),
  )

  describe("pending lifetime", () => {
    const start = Effect.fn("FormTest.start")(function* (service: Form.Interface, create: Form.CreateInput = input) {
      const events = yield* EventRuntime.Service
      const published: EventRuntime.Payload[] = []
      const created = yield* Deferred.make<Form.Info>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.gen(function* () {
          if (event.type.startsWith("form.")) published.push(event)
          if (event.type === Form.Event.Created.type)
            yield* Deferred.succeed(created, (event.data as { readonly form: Form.Info }).form)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.ask(create).pipe(Effect.forkScoped)
      return { fiber, form: yield* Deferred.await(created), published }
    })

    it.effect("created forms remain pending after 25 hours and accept a valid late reply", () => Effect.gen(function* () {
      const service = yield* Form.Service
      const form = yield* service.create(input)
      yield* TestClock.adjust("25 hours")
      expect(yield* service.state(form.id)).toEqual({ status: "pending" })
      expect(yield* service.list()).toEqual([form])
      yield* service.reply({ id: form.id, answer: { name: "Late" } })
      expect(yield* service.state(form.id)).toEqual({ status: "answered", answer: { name: "Late" } })
      expect(yield* service.list()).toEqual([])
    }))

    it.effect("fresh service scopes on the same database do not restore ordinary pending forms", () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const database = yield* Database.Service
      const context = yield* Effect.context<Config.Service | Database.Service | EventRuntime.Service | SessionAutonomy.Service | Decision.Service>()
      const layer = Form.layer.pipe(Layer.provideMerge(Layer.succeedContext(context)))
      const firstScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(layer), firstScope), Form.Service)
      const { fiber, form, published } = yield* start(first)
      const created = yield* first.create({ ...input, id: Form.ID.create("frm_restart_created") })
      expect(yield* first.list()).toEqual([form, created])
      yield* Scope.close(firstScope, Exit.void)
      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
      expect(yield* first.state(created.id)).toEqual({ status: "cancelled" })
      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const restarted = yield* Layer.buildWithScope(Layer.fresh(layer), secondScope)
      const second = Context.get(restarted, Form.Service)
      expect(Context.get(restarted, Database.Service).db).toBe(database.db)
      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ id: form.id, answer: { name: "Late" } }).pipe(Effect.flip)).toEqual(new Form.NotFoundError({ id: form.id }))
      expect(yield* first.state(form.id)).toEqual({ status: "cancelled" })
      expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Created.type, Form.Event.Cancelled.type, Form.Event.Cancelled.type])
    }))

    it.effect("defer entry defers an unanswered form after 25 hours without answering it", () => Effect.gen(function* () {
      yield* setupAutonomy("normal")
      const service = yield* Form.Service
      const { fiber, form, published } = yield* start(service)
      yield* TestClock.adjust("25 hours")
      yield* service.deferPending(input.sessionID)
      const result = yield* Fiber.join(fiber)
      expect(result.status).toBe("deferred")
      const reviews = yield* SessionReviewFold.fold((yield* Database.Service).db, [input.sessionID])
      expect(reviews).toHaveLength(1)
      expect(reviews[0].payload).toMatchObject({ type: "form", title: form.title, fields: form.fields })
      expect(reviews[0].decision).toBeUndefined()
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Deferred.type])
    }))

    for (const settlement of ["reply", "cancel"] as const) {
      it.effect(`a created form preserves its explicit ${settlement} result`, () => Effect.gen(function* () {
        const service = yield* Form.Service
        const form = yield* service.create(input)
        yield* settlement === "reply"
          ? service.reply({ id: form.id, answer: { name: "Ava" } })
          : service.cancel(form.id)
        yield* TestClock.adjust("5 minutes")
        expect(yield* service.state(form.id)).toEqual(settlement === "reply"
          ? { status: "answered", answer: { name: "Ava" } }
          : { status: "cancelled" })
      }))
    }

    it.effect("required answers remain pending after 25 hours without a synthetic result", () =>
      Effect.gen(function* () {
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)

        yield* TestClock.adjust("25 hours")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list({ sessionID: input.sessionID })).toEqual([form])
        expect(yield* service.state(form.id)).toEqual({ status: "pending" })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type])
        expect(yield* service.reply({ id: form.id, answer: {} }).pipe(Effect.flip)).toEqual(
          new Form.InvalidAnswerError({ id: form.id, message: "Missing required form field: name" }),
        )
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* service.reply({ id: form.id, answer: { name: "Late" } })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { name: "Late" } })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Replied.type])
        expect(yield* service.reply({ id: form.id, answer: { name: "Again" } }).pipe(Effect.flip)).toEqual(new Form.AlreadySettledError({ id: form.id }))
        expect(yield* service.cancel(form.id).pipe(Effect.flip)).toEqual(new Form.AlreadySettledError({ id: form.id }))
      }),
    )

    it.effect("a human answer remains settled as time advances", () =>
      Effect.gen(function* () {
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* TestClock.adjust("59 seconds")
        yield* service.reply({ id: form.id, answer: { name: "Ava" } })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { name: "Ava" } })
        yield* TestClock.adjust("5 minutes")
        expect(yield* service.state(form.id)).toEqual({ status: "answered", answer: { name: "Ava" } })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Replied.type])
      }),
    )

    it.effect("a cancelled form emits no further settlement as time advances", () =>
      Effect.gen(function* () {
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* service.cancel(form.id)
        expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
        yield* TestClock.adjust("5 minutes")
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Cancelled.type])
      }),
    )

    it.effect("interrupting the ask cancels the form without a later settlement", () =>
      Effect.gen(function* () {
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust("5 minutes")
        expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Cancelled.type])
      }),
    )

    it.effect("Auto answers settle a default without defer and YOLO answers settle a choice deferred", () =>
      Effect.gen(function* () {
        yield* setupAutonomy("normal")
        const autonomy = yield* SessionAutonomy.Service
        const service = yield* Form.Service
        const settings = { ...input, fields: [{ key: "confirm", type: "boolean", default: true }] } satisfies Form.CreateInput
        yield* autonomy.set({ sessionID: input.sessionID, answers: "auto" })
        expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { confirm: true }, automatic: true, via: "auto-answer" })
        yield* autonomy.set({ sessionID: input.sessionID, answers: "yolo", defer: true })
        decisionBehavior = decisionChoice("Fast", 0.9)
        expect(
          yield* service.ask({
            ...input,
            id: Form.ID.create("frm_automatic_defer"),
            fields: [{ key: "plan", type: "string", required: true, options: [{ value: "Fast", label: "Fast" }] }],
          }),
        ).toEqual({ status: "answered", answer: { plan: "Fast" }, automatic: true, via: "yolo", confidence: 0.9 })
      }),
    )
  })
})

describe("Form delegated settlement", () => {
  const delegatedSource = { kind: "dots-delegation", anchorSessionID: SessionSchema.ID.make("ses_anchor"), delegationID: "proposal_1", revision: 1, exchangeID: "exchange_1" } as const
  it.effect("settles with delegated source only on exact fingerprint and live validation", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const receipts: unknown[] = []
      const replied: unknown[] = []
      const unsubscribe = yield* events.listen((event) => Effect.sync(() => { if (event.type === SessionEvent.DotsDecisionSettled.type) receipts.push(event.data); if (event.type === Form.Event.Replied.type) replied.push(event.data) }))
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* service.create(input)
      const snapshot = yield* service.snapshot(formID)
      expect(snapshot?.state).toEqual({ status: "pending" })
      expect((yield* service.replyDelegated({ id: formID, answer: { name: "Ada" }, fingerprint: "0".repeat(64), source: delegatedSource, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* service.state(formID)).status).toBe("pending")
      yield* service.replyDelegated({ id: formID, answer: { name: "Ada" }, fingerprint: snapshot!.fingerprint, source: delegatedSource, validate: () => Effect.succeed(true) })
      const settled = yield* service.snapshot(formID)
      expect(settled?.state).toEqual({ status: "answered", answer: { name: "Ada" } })
      expect(replied).toEqual([{ id: formID, sessionID: input.sessionID, answer: { name: "Ada" }, source: delegatedSource }])
      expect(receipts).toEqual([{ sessionID: input.sessionID, source: delegatedSource, target: { kind: "form", formID, fingerprint: snapshot!.fingerprint } }])
    }))
})
