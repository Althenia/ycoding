import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema } from "effect"
import { Config } from "@ycoding-ai/core/config"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { Agent } from "@ycoding-ai/core/agent"
import { DecisionChoice } from "@ycoding-ai/core/decision-choice"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_yolo_decision_test")
let sequence = 1
let asleep = true
let autoAnswer = false
let yolo = true
let flipSequenceOnDecision = false

const output = (answers: unknown) =>
  Schema.decodeUnknownSync(Decision.Output)({
    provider: "agent",
    response: {
      model: { providerID: "test", id: "decision-model" },
      semantics: "model-estimate",
      version: 1,
      answers,
    },
  })

const seen: Array<{ purpose?: string; authority?: string; invocationKey?: string }> = []
let decisionBehavior: (input: Decision.Input, context?: Decision.Invocation) => Effect.Effect<Decision.Output, Decision.Error> = (input, context) =>
  Effect.sync(() => {
    seen.push({ purpose: context?.purpose, authority: context?.authority, invocationKey: context?.invocationKey })
    if (flipSequenceOnDecision) sequence++
  }).pipe(
    Effect.as(output(input.request.questions.map((item) =>
      item.type === "choice" && item.grade === true
        ? { name: item.name, type: "choice", answer: null, choice: null, score: null, text: null, confidence: 0,
            grades: item.choices.map((choice) => ({ choice: choice.value, confidence: 0.3, evidence: "Weak support." })) }
        : item.type === "predicate"
        ? { name: item.name, type: "predicate", answer: false, choice: null, score: null, text: null, confidence: 0.95 }
        : { name: item.name, type: "text", answer: null, choice: null, score: null, text: "ship it", confidence: 0.95 },
    ))),
  )

const autonomyMock = Layer.mock(SessionAutonomy.Service, {
  snapshot: () =>
    Effect.succeed({
      state: SessionAutonomy.read({ mode: "normal", yolo, autoAnswer }),
      sequence,
      digest: "test",
    }),
  isAsleep: () => Effect.succeed(asleep),
  canYolo: () => Effect.succeed(yolo),
} as never)

const harness = AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node, Question.node, Form.node]),
  [
    [Decision.node, Layer.mock(Decision.Service, { evaluate: (input: Decision.Input, context: Decision.Invocation) => decisionBehavior(input, context) })],
    [SessionAutonomy.node, autonomyMock],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
      }),
    ],
  ],
)
const it = testEffect(harness)

const setup = Effect.gen(function* () {
  sequence = 1
  flipSequenceOnDecision = false
  seen.length = 0
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
    .values({ id: sessionID, project_id: Project.ID.global, directory, title: "Yolo decision" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("YOLO decision helpers", () => {
  it.effect("authority and purpose select the specialized hidden helper agents", () =>
    Effect.sync(() => {
      expect(DecisionAgent.agentFor({ purpose: "permission", authority: "yolo" })).toEqual(Agent.ID.make("yolo-permission"))
      expect(DecisionAgent.agentFor({ purpose: "guardrail", authority: "yolo" })).toEqual(Agent.ID.make("yolo-guardrail"))
      expect(DecisionAgent.agentFor({ purpose: "answer", authority: "yolo" })).toEqual(Agent.ID.make("yolo-answer"))
      expect(DecisionAgent.agentFor({ purpose: "permission", authority: "baseline" })).toEqual(Agent.ID.make("decision"))
      expect(DecisionAgent.agentFor({})).toEqual(Agent.ID.make("decision"))
    }),
  )

  it.effect("YOLO answers a required free-text question asleep without the autoAnswer toggle", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      const service = yield* Question.Service
      const result = yield* service.ask({
        sessionID,
        questions: [{ question: "What should we do?", header: "Action", options: [] }],
      })
      expect(result).toEqual({ status: "answered", answers: [["ship it"]], automatic: true, via: "yolo", confidence: 0.95 })
      expect(seen).toEqual([{ purpose: "answer", authority: "yolo", invocationKey: expect.stringMatching(/^que.*:0$/) }])
    }),
  )

  it.effect("a stale autonomy snapshot defers instead of settling the YOLO answer", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      flipSequenceOnDecision = true
      const service = yield* Question.Service
      const result = yield* service.ask({
        sessionID,
        questions: [{ question: "What should we do?", header: "Action", options: [] }],
      })
      expect(result.status).toBe("deferred")
    }),
  )

  it.effect("unsupported strict routes stay typed and unsettled for human escalation", () =>
    Effect.gen(function* () {
      const failing: Decision.Interface = {
        evaluate: () => Effect.fail(new Decision.Error({ reason: "unsupported-output" })),
      }
      const choice = yield* DecisionChoice.chooseDetailed(failing, {
        sessionID,
        name: "route",
        instructions: "Choose",
        state: {},
        choices: [{ value: "allow" }, { value: "deny" }, { value: "escalate" }],
      })
      expect(choice).toEqual({ type: "unsettled", reason: "unsupported-output" })
      const graded = yield* DecisionChoice.grade(failing, {
        sessionID,
        name: "route",
        instructions: "Grade",
        state: {},
        choices: [{ value: "allow" }, { value: "deny" }, { value: "escalate" }],
      })
      expect(graded).toEqual({ type: "unsettled", reason: "unsupported-output" })
      expect(new Decision.Error({ reason: "unsupported-output" }).message).toContain("strict")
    }),
  )

  it.effect("a boolean form field answered false by YOLO is settled, not treated as absent", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = false
      autoAnswer = false
      yolo = true
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID,
        title: "Confirm",
        fields: [{ key: "confirm", type: "boolean", required: true }],
      })
      expect(result).toEqual({ status: "answered", answer: { confirm: false }, automatic: true, via: "yolo", confidence: 0.95 })
      expect(seen).toEqual([{ purpose: "answer", authority: "yolo", invocationKey: expect.stringMatching(/:confirm$/) }])
    }),
  )

  it.effect("autoAnswer alone settles only an explicit valid default and never calls the helper", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = false
      autoAnswer = true
      yolo = false
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID,
        title: "Confirm",
        fields: [{ key: "confirm", type: "boolean", required: true, default: false }],
      })
      expect(result).toEqual({ status: "answered", answer: { confirm: false }, automatic: true, via: "auto-answer" })
      expect(seen).toEqual([])
    }),
  )

  it.effect("autoAnswer alone defers a required field with no default asleep without inventing an answer", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = true
      yolo = false
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID,
        title: "Confirm",
        fields: [{ key: "name", type: "string", required: true }],
      })
      expect(result.status).toBe("deferred")
      expect(seen).toEqual([])
    }),
  )

  it.effect("autoAnswer alone accepts only a single explicitly recommended question option", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = true
      yolo = false
      const service = yield* Question.Service
      const recommended = yield* service.ask({
        sessionID,
        questions: [{ question: "Pick", header: "Pick", options: [{ label: "A (Recommended)", description: "a" }, { label: "B", description: "b" }] }],
      })
      expect(recommended).toEqual({ status: "answered", answers: [["A (Recommended)"]], automatic: true, via: "auto-answer" })
      const unmarked = yield* service.ask({
        sessionID,
        questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
      })
      expect(unmarked.status).toBe("deferred")
      expect(seen).toEqual([])
    }),
  )

  it.effect("an external consent field is never acknowledged automatically", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = true
      yolo = true
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID,
        title: "Consent",
        fields: [{ key: "consent", type: "external", url: "https://example.test/consent", title: "Consent" }],
      })
      expect(result.status).toBe("deferred")
      expect(seen).toEqual([])
    }),
  )
})

describe("automatic form and question settlement provenance", () => {
  const lastReason = Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* SessionReviewFold.fold(db, [sessionID])).at(-1)?.reason
  })

  it.effect("YOLO leaves a form with only omitted optional fields unsettled for the human", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      const service = yield* Form.Service
      const result = yield* service.ask({ sessionID, title: "Notes", fields: [{ key: "note", type: "string" }] })
      expect(result.status).toBe("deferred")
      expect(seen).toEqual([])
    }),
  )

  it.effect("an awake form with no obtainable value stays pending instead of submitting empty", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = false
      autoAnswer = true
      yolo = false
      const service = yield* Form.Service
      const fiber = yield* service.ask({ sessionID, title: "Notes", fields: [{ key: "note", type: "string" }] }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(fiber.pollUnsafe()).toBeUndefined()
      const [pending] = yield* service.list({ sessionID })
      expect(pending?.title).toBe("Notes")
      yield* service.cancel(pending!.id)
      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" })
    }),
  )

  it.effect("multiselect grading redacts model-bound values and restores selected original values", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      const secret = "synthetic-grading-credential-7319"
      const original = process.env.YCODING_TEST_GRADING_SECRET
      const previous = decisionBehavior
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (original === undefined) delete process.env.YCODING_TEST_GRADING_SECRET
        else process.env.YCODING_TEST_GRADING_SECRET = original
        decisionBehavior = previous
      }))
      process.env.YCODING_TEST_GRADING_SECRET = secret
      const requests: Decision.Input[] = []
      decisionBehavior = (input) => Effect.sync(() => {
        requests.push(input)
        return output(input.request.questions.map((question) => ({
          name: question.name, type: "choice", answer: null, choice: null, score: null, text: null, confidence: 0,
          grades: question.type === "choice" ? question.choices.map((choice, index) => ({
            choice: choice.value, confidence: index === 0 ? 0.95 : 0.1, evidence: "Synthetic option evidence.",
          })) : [],
        })))
      })
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID, title: "Synthetic deployment targets",
        fields: [{ key: "targets", type: "multiselect", required: true, options: [
          { value: `environment:${secret}`, label: `Synthetic ${secret}`, description: `Value ${secret}` },
          { value: "local", label: "Local" },
        ] }],
      })
      expect(requests).toHaveLength(1)
      expect(JSON.stringify(requests)).not.toContain(secret)
      expect(requests[0]?.request.questions[0]).toMatchObject({ choices: [
        { value: "environment:[redacted]", description: "Value [redacted]" },
        { value: "local", description: "Local" },
      ] })
      expect(result).toEqual({ status: "answered", answer: { targets: [`environment:${secret}`] }, automatic: true, via: "yolo", confidence: 0.95 })
    }),
  )

  it.effect("graded values retain their original mapping when an environment credential rotates during evaluation", () =>
    Effect.gen(function* () {
      const original = process.env.YCODING_TEST_GRADING_SECRET
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        if (original === undefined) delete process.env.YCODING_TEST_GRADING_SECRET
        else process.env.YCODING_TEST_GRADING_SECRET = original
      }))
      const secret = "synthetic-grading-before-rotation-7319"
      process.env.YCODING_TEST_GRADING_SECRET = secret
      const result = yield* DecisionChoice.grade({ evaluate: (input) => Effect.sync(() => {
        process.env.YCODING_TEST_GRADING_SECRET = "synthetic-grading-after-rotation-7320"
        return output(input.request.questions.map((question) => ({
          name: question.name, type: "choice", answer: null, choice: null, score: null, text: null, confidence: 0,
          grades: question.type === "choice" ? question.choices.map((choice) => ({
            choice: choice.value, confidence: 0.95, evidence: "Synthetic evidence.",
          })) : [],
        })))
      }) }, { sessionID, name: "target", instructions: "Grade", state: {}, choices: [{ value: `environment:${secret}` }] })
      expect(result).toEqual({ type: "grades", grades: [{ choice: `environment:${secret}`, confidence: 0.95, evidence: "Synthetic evidence." }] })
    }),
  )

  it.effect("multiselect redaction collisions defer without dispatching the helper", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      const originals = [process.env.YCODING_TEST_GRADING_SECRET, process.env.YCODING_TEST_GRADING_TOKEN]
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        for (const [index, key] of ["YCODING_TEST_GRADING_SECRET", "YCODING_TEST_GRADING_TOKEN"].entries()) {
          const original = originals[index]
          if (original === undefined) delete process.env[key]
          else process.env[key] = original
        }
      }))
      process.env.YCODING_TEST_GRADING_SECRET = "synthetic-grading-first-7319"
      process.env.YCODING_TEST_GRADING_TOKEN = "synthetic-grading-second-7320"
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID, title: "Ambiguous synthetic targets",
        fields: [{ key: "targets", type: "multiselect", required: true, options: [
          { value: `environment:${process.env.YCODING_TEST_GRADING_SECRET}`, label: "First" },
          { value: `environment:${process.env.YCODING_TEST_GRADING_TOKEN}`, label: "Second" },
        ] }],
      })
      expect(result.status).toBe("deferred")
      expect(seen).toEqual([])
    }),
  )

  it.effect("an optional multiselect the model grades entirely below the threshold yields no automatic submission", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = false
      yolo = true
      const service = yield* Form.Service
      const result = yield* service.ask({
        sessionID,
        title: "Features",
        fields: [{ key: "features", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }],
      })
      expect(result.status).toBe("deferred")
      expect(seen).toHaveLength(1)
    }),
  )

  it.effect("a default-only answer is attributed to autoAnswer while a consulted model makes it YOLO", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = false
      autoAnswer = true
      yolo = false
      const service = yield* Form.Service
      const fields = [
        { key: "confirm", type: "boolean", required: true, default: true },
        { key: "note", type: "string" },
      ] as const
      expect(yield* service.ask({ sessionID, title: "Defaults", fields: [...fields] })).toEqual({
        status: "answered", answer: { confirm: true }, automatic: true, via: "auto-answer",
      })
      expect(seen).toEqual([])
      yolo = true
      const consulted = yield* service.ask({
        sessionID,
        title: "Consulted",
        fields: [
          fields[0],
          { key: "features", type: "multiselect", options: [{ value: "a", label: "A" }] },
        ],
      })
      expect(consulted).toEqual({ status: "answered", answer: { confirm: true }, automatic: true, via: "yolo" })
      expect(seen).toHaveLength(1)
    }),
  )

  it.effect("a choice or yes/no with no default defers as disabled while a text field defers as free_text", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = true
      yolo = false
      const service = yield* Form.Service
      const cases = [
        ["disabled", { key: "go", type: "boolean", required: true }],
        ["disabled", { key: "plan", type: "string", required: true, options: [{ value: "a", label: "A" }] }],
        ["disabled", { key: "set", type: "multiselect", required: true, options: [{ value: "a", label: "A" }] }],
        ["free_text", { key: "name", type: "string", required: true }],
        ["free_text", { key: "count", type: "integer", required: true }],
      ] as const
      for (const [reason, field] of cases) {
        expect((yield* service.ask({ sessionID, title: "Unanswered", fields: [field] })).status).toBe("deferred")
        expect(yield* lastReason).toBe(reason)
      }
    }),
  )

  it.effect("a question with options defers as disabled and a free-text question as free_text without YOLO", () =>
    Effect.gen(function* () {
      yield* setup
      asleep = true
      autoAnswer = true
      yolo = false
      const service = yield* Question.Service
      expect((yield* service.ask({ sessionID, questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }] }] })).status).toBe("deferred")
      expect(yield* lastReason).toBe("disabled")
      expect((yield* service.ask({ sessionID, questions: [{ question: "Name", header: "Name", options: [] }] })).status).toBe("deferred")
      expect(yield* lastReason).toBe("free_text")
    }),
  )
})
