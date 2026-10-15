import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ycoding-ai/core/config"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Decision } from "@ycoding-ai/core/decision"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { Database } from "@ycoding-ai/core/database/database"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { testEffect } from "./lib/effect"

let decisionBehavior: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("Forms must not request judgments unless asleep")

let configuredTimeout: number | undefined
const forms = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventRuntime.node, SessionAutonomy.node, Form.node]),
  [
    [Decision.node, Layer.mock(Decision.Service, { evaluate: (input: Decision.Input) => decisionBehavior(input) })],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () =>
          Effect.sync(() =>
            configuredTimeout === undefined
              ? []
              : [
                  new Config.Document({
                    type: "document",
                    info: new Config.Info({ question_timeout_seconds: configuredTimeout }),
                  }),
                ],
          ),
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

const setupAutonomy = Effect.fn("FormTest.setupAutonomy")(function* (mode: "yolo" | "goal") {
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
    : autonomy.setMode({ sessionID: input.sessionID, mode })
})

describe("Form", () => {
  for (const yolo of [0, 1, 2, 3] as const) {
    it.effect(`forms are automatic only at YOLO 2-3: level ${yolo}`, () => Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID: input.sessionID, yolo })
      const service = yield* Form.Service
      const settings = { ...input, fields: [{ key: "confirm", type: "boolean", default: true }] } satisfies Form.CreateInput
      if (yolo >= 2) {
        expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { confirm: true } })
        expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
        return
      }
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
    }))
  }
  it.effect("auto answers deterministic forms in yolo mode", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      yield* setupAutonomy("yolo")

      const result = yield* service.ask({
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
      })

      expect(result).toEqual({
        status: "answered",
        answer: { branch: "main", attempts: 1, confirm: true, features: ["tests"], setup: true },
      })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }),
  )

  it.effect("auto answers deterministic forms in goal mode", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      yield* setupAutonomy("goal")

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
              options: [{ value: "main", label: "Main" }],
            },
            { key: "confirm", type: "boolean", required: true, default: true },
          ],
        }),
      ).toEqual({ status: "answered", answer: { branch: "main", confirm: true } })
      expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
    }),
  )

  it.effect("auto answers required free-text forms with a safe default in goal mode", () =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      yield* setupAutonomy("goal")

      expect(
        yield* service.ask({
          id: Form.ID.create("frm_goal_text"),
          sessionID: input.sessionID,
          title: "Required input",
          fields: [{ key: "name", type: "string", required: true }],
        }),
      ).toEqual({ status: "answered", answer: { name: "Continue" } })
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

  it.effect("sleep answers option fields through the decision model", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID: input.sessionID, yolo: 0 })
      yield* autonomy.set({ sessionID: input.sessionID, sleep: true })
      decisionBehavior = decisionChoice("Careful", 0.9)
      const service = yield* Form.Service
      const settings = {
        ...input,
        id: Form.ID.create("frm_sleep_choice"),
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
      expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { plan: "Careful" } })
    }),
  )

  it.effect("sleep falls back to the automatic answer when the decision model fails", () =>
    Effect.gen(function* () {
      yield* setupAutonomy("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.setYolo({ sessionID: input.sessionID, yolo: 0 })
      yield* autonomy.set({ sessionID: input.sessionID, sleep: true })
      decisionBehavior = () => Effect.fail(new Decision.Error({ reason: "provider-failed" }))
      const service = yield* Form.Service
      const settings = {
        ...input,
        id: Form.ID.create("frm_sleep_fallback"),
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
      expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { plan: "Fast" } })
    }),
  )

  for (const settlement of ["reply", "cancel"] as const) {
    it.effect(`a human ${settlement} during sleep inference wins without a second reply`, () =>
      Effect.gen(function* () {
        configuredTimeout = undefined
        yield* setupAutonomy("yolo")
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.setYolo({ sessionID: input.sessionID, yolo: 0 })
        yield* autonomy.set({ sessionID: input.sessionID, sleep: true })
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
        const id = Form.ID.create(`frm_sleep_${settlement}_race`)
        const fiber = yield* service.ask({
          id, sessionID: input.sessionID, title: "Choose a plan",
          fields: [{ key: "plan", type: "string", required: true, options: [
            { value: "Fast", label: "Fast" }, { value: "Careful", label: "Careful" },
          ] }],
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* autonomy.set({ sessionID: input.sessionID, sleep: false })
        yield* settlement === "reply"
          ? service.reply({ id, answer: { plan: "Fast" } })
          : service.cancel(id)
        const expected: Form.TerminalState = settlement === "reply"
          ? { status: "answered", answer: { plan: "Fast" } }
          : { status: "cancelled" }
        expect(yield* service.state(id)).toEqual(expected)
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(fiber)).toEqual(expected)
        expect(yield* service.state(id)).toEqual(expected)
        expect(published).toEqual([Form.Event.Created.type,
          settlement === "reply" ? Form.Event.Replied.type : Form.Event.Cancelled.type])
      }),
    )
  }

  describe("timeout", () => {
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

    it.effect("created forms time out without an ask waiter", () => Effect.gen(function* () {
      configuredTimeout = 5
      const service = yield* Form.Service
      const form = yield* service.create(input)
      yield* TestClock.adjust("4 seconds")
      expect(yield* service.state(form.id)).toEqual({ status: "pending" })
      yield* TestClock.adjust("1 second")
      expect(yield* service.state(form.id)).toEqual({ status: "timed_out", seconds: 5 })
      expect(yield* service.list()).toEqual([])
    }))

    it.effect("closing the owner cancels created forms and their timers", () => Effect.gen(function* () {
      configuredTimeout = 5
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(forms.pipe(Layer.fresh), scope)
      const service = Context.get(context, Form.Service)
      const form = yield* service.create(input)
      yield* Scope.close(scope, Exit.void)
      yield* TestClock.adjust("10 seconds")
      expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
      expect(yield* service.list()).toEqual([])
    }))

    for (const settlement of ["reply", "cancel"] as const) {
      it.effect(`a created form's ${settlement} cancels its entry-owned timer`, () => Effect.gen(function* () {
        configuredTimeout = 5
        const service = yield* Form.Service
        const form = yield* service.create(input)
        yield* settlement === "reply"
          ? service.reply({ id: form.id, answer: { name: "Ava" } })
          : service.cancel(form.id)
        yield* TestClock.adjust("10 seconds")
        expect(yield* service.state(form.id)).toEqual(settlement === "reply"
          ? { status: "answered", answer: { name: "Ava" } }
          : { status: "cancelled" })
      }))
    }

    it.effect("times out at the default 5 minutes, closes the form, and rejects a late reply", () =>
      Effect.gen(function* () {
        configuredTimeout = undefined
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)

        yield* TestClock.adjust("299 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.list({ sessionID: input.sessionID })).toEqual([form])

        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toEqual({ status: "timed_out", seconds: 300 })
        expect(yield* service.state(form.id)).toEqual({ status: "timed_out", seconds: 300 })
        expect(yield* service.list({ sessionID: input.sessionID })).toEqual([])
        expect(published.map((event) => [event.type, event.data])).toEqual([
          [Form.Event.Created.type, { form }],
          [Form.Event.TimedOut.type, { id: form.id, sessionID: input.sessionID }],
        ])
        expect(yield* service.reply({ id: form.id, answer: { name: "Late" } }).pipe(Effect.flip)).toEqual(
          new Form.AlreadySettledError({ id: form.id }),
        )
        expect(yield* service.cancel(form.id).pipe(Effect.flip)).toEqual(new Form.AlreadySettledError({ id: form.id }))
      }),
    )

    it.effect("times out at the configured seconds", () =>
      Effect.gen(function* () {
        configuredTimeout = 45
        const service = yield* Form.Service
        const { fiber } = yield* start(service)
        yield* TestClock.adjust("44 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(fiber)).toEqual({ status: "timed_out", seconds: 45 })
      }),
    )

    it.effect("never times out when disabled with 0", () =>
      Effect.gen(function* () {
        configuredTimeout = 0
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* TestClock.adjust("24 hours")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* service.state(form.id)).toEqual({ status: "pending" })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type])
        yield* service.reply({ id: form.id, answer: { name: "Ava" } })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { name: "Ava" } })
      }),
    )

    it.effect("a human answer before the deadline wins and leaves no timer behind", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
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

    it.effect("a cancelled form is not timed out later", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* service.cancel(form.id)
        expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
        yield* TestClock.adjust("5 minutes")
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Cancelled.type])
      }),
    )

    it.effect("interrupting the ask cancels the form and leaves no timeout behind", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        const service = yield* Form.Service
        const { fiber, form, published } = yield* start(service)
        yield* Fiber.interrupt(fiber)
        yield* TestClock.adjust("5 minutes")
        expect(yield* service.state(form.id)).toEqual({ status: "cancelled" })
        expect(published.map((event) => event.type)).toEqual([Form.Event.Created.type, Form.Event.Cancelled.type])
      }),
    )

    it.effect("automatic answers never wait for the timeout", () =>
      Effect.gen(function* () {
        configuredTimeout = 60
        yield* setupAutonomy("yolo")
        const autonomy = yield* SessionAutonomy.Service
        const service = yield* Form.Service
        const settings = { ...input, fields: [{ key: "confirm", type: "boolean", default: true }] } satisfies Form.CreateInput
        yield* autonomy.setYolo({ sessionID: input.sessionID, yolo: 2 })
        expect(yield* service.ask(settings)).toEqual({ status: "answered", answer: { confirm: true } })
        yield* autonomy.setYolo({ sessionID: input.sessionID, yolo: 0 })
        yield* autonomy.set({ sessionID: input.sessionID, sleep: true })
        decisionBehavior = decisionChoice("Fast", 0.9)
        expect(
          yield* service.ask({
            ...input,
            id: Form.ID.create("frm_timeout_sleep"),
            fields: [{ key: "plan", type: "string", required: true, options: [{ value: "Fast", label: "Fast" }] }],
          }),
        ).toEqual({ status: "answered", answer: { plan: "Fast" } })
      }),
    )
  })
})
