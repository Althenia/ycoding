import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, LayerMap, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationError, LocationServices } from "@ycoding-ai/core/location-services"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { Question } from "@ycoding-ai/core/question"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import type { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/tmp/ycoding-decision-answer-revocation")
const location = Location.Ref.make({ directory })
const root = Session.ID.make("ses_revocation_root")
const middle = Session.ID.make("ses_revocation_middle")
const leaf = Session.ID.make("ses_revocation_leaf")
const sibling = Session.ID.make("ses_revocation_sibling")
const model = CatalogModel.Ref.make({ id: CatalogModel.ID.make("child"), providerID: Provider.ID.make("test") })

let decide: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error> = () =>
  Effect.die("No judgment is expected")
const synthetic: Array<{ readonly sessionID: Session.ID; readonly metadata?: Record<string, unknown> }> = []
let beforeSessionGet: Effect.Effect<void> = Effect.void

const decision = Layer.mock(Decision.Service, { evaluate: (input: Decision.Input) => decide(input) })
const config = Layer.mock(Config.Service, {
  entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
})

const harness = AppNodeBuilder.build(
  LayerNode.group([
    Config.node,
    Database.node,
    EventRuntime.node,
    SessionAutonomy.node,
    Decision.node,
    Form.node,
    Question.node,
    SessionExecution.node,
    Session.node,
    LocationServiceMap.node,
    SessionOrchestration.node,
  ]),
  [
    [Config.node, config],
    [Decision.node, decision],
    [SessionExecution.node, Layer.mock(SessionExecution.Service, { wake: () => Effect.void })],
    [
      Session.node,
      Layer.mock(Session.Service, {
        daybreak: { set: () => Effect.die("Unexpected daybreak update") },
        autonomy: {
          get: () => Effect.die("Use the real autonomy service"),
          set: () => Effect.die("Use the real autonomy service"),
          effective: () => Effect.die("Use the real autonomy service"),
        },
        revert: {
          stage: () => Effect.die("Unexpected revert"),
          clear: () => Effect.die("Unexpected revert"),
          commit: () => Effect.die("Unexpected revert"),
        },
        get: (sessionID: Session.ID) => beforeSessionGet.pipe(Effect.as({ id: sessionID, location } as unknown as Session.Info)),
        synthetic: (input) =>
          Effect.sync(() => {
            synthetic.push({ sessionID: input.sessionID, ...(input.metadata === undefined ? {} : { metadata: input.metadata }) })
            return input as unknown as SessionPending.Synthetic
          }),
      }),
    ],
    [
      LocationServiceMap.node,
      Layer.effect(LocationServiceMap.Service, LayerMap.make((_location: Location.Ref) =>
        Layer.mergeAll(config, decision) as Layer.Layer<LocationServices, LocationError>,
      )),
    ],
  ],
)
const it = testEffect(harness)

const choice = (value: string) => (input: Decision.Input) =>
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
        confidence: 0.9,
      })),
    },
  })

const holdChoice = Effect.fn("RevocationTest.holdChoice")(function* (value: string) {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  decide = (input) =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(choice(value)(input)))
  return { entered, release }
})

const family = Effect.fn("RevocationTest.family")(function* (input: { readonly asleep: boolean }) {
  const { db } = yield* Database.Service
  synthetic.length = 0
  beforeSessionGet = Effect.void
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    [
      [root, undefined],
      [middle, root],
      [leaf, middle],
      [sibling, middle],
    ] as const,
    ([id, parent]) =>
      Effect.gen(function* () {
        yield* db
          .insert(SessionTable)
          .values({ id, project_id: Project.ID.global, directory, path: "", title: id, ...(parent ? { parent_id: parent } : {}) })
          .run()
          .pipe(Effect.orDie)
        if (!parent) return
        yield* db
          .insert(SessionTaskTable)
          .values({
            session_id: id,
            parent_id: parent,
            parent_assistant_message_id: SessionMessage.ID.make(`msg_parent_${id}`),
            tool_call_id: `call_${id}`,
            input_id: SessionMessage.ID.make(`msg_input_${id}`),
            description: "delegated work",
            agent: "reviewer",
            model,
            prompt_digest: "digest",
            background: true,
            delivery: "steer",
            state: "running",
          })
          .run()
          .pipe(Effect.orDie)
      }),
    { discard: true },
  )
  const autonomy = yield* SessionAutonomy.Service
  if (input.asleep) yield* autonomy.set({ sessionID: root, sleep: true })
  return autonomy
})

const revocations = [
  {
    name: "root ancestor turns YOLO off",
    grant: (autonomy: SessionAutonomy.Interface) => autonomy.setYolo({ sessionID: root, yolo: true }),
    revoke: (autonomy: SessionAutonomy.Interface) => autonomy.setYolo({ sessionID: root, yolo: false }),
  },
  {
    name: "intermediate ancestor turns YOLO off",
    grant: (autonomy: SessionAutonomy.Interface) => autonomy.setYolo({ sessionID: middle, yolo: true }),
    revoke: (autonomy: SessionAutonomy.Interface) => autonomy.setYolo({ sessionID: middle, yolo: false }),
  },
  {
    name: "root ancestor turns YOLO off and on again",
    grant: (autonomy: SessionAutonomy.Interface) => autonomy.setYolo({ sessionID: root, yolo: true }),
    revoke: (autonomy: SessionAutonomy.Interface) =>
      autonomy.setYolo({ sessionID: root, yolo: false }).pipe(
        Effect.andThen(autonomy.setYolo({ sessionID: root, yolo: true })),
      ),
  },
] as const

const planForm = {
  id: Form.ID.create("frm_revocation"),
  sessionID: leaf,
  title: "Choose a plan",
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

const planQuestion: Question.Info = {
  question: "Which plan?",
  header: "Plan",
  options: [
    { label: "Fast", description: "Ship quickly" },
    { label: "Careful", description: "Verify first" },
  ],
  custom: false,
}

describe("a revoked inherited YOLO grant never applies a held automatic answer", () => {
  for (const asleep of [false, true]) {
    it.effect(`a ${asleep ? "sleeping" : "awake"} child does not apply an auto-answer flag revoked during context lookup`, () =>
      Effect.gen(function* () {
        const autonomy = yield* family({ asleep })
        yield* autonomy.set({ sessionID: leaf, autoAnswer: true })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        beforeSessionGet = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        const orchestration = yield* SessionOrchestration.Service
        const fiber = yield* orchestration.question(leaf, "Which plan?", {
          options: ["Fast", "Careful (Recommended)"],
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* autonomy.set({ sessionID: leaf, autoAnswer: false })
        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(fiber)).autoAnswered).toBe(false)
        expect(synthetic).toEqual([])
      }),
    )
  }

  for (const revocation of revocations) {
    it.effect(`asleep Form defers when the ${revocation.name} during evaluation`, () =>
      Effect.gen(function* () {
        const autonomy = yield* family({ asleep: true })
        yield* revocation.grant(autonomy)
        const gate = yield* holdChoice("Careful")
        const forms = yield* Form.Service
        const fiber = yield* forms.ask(planForm).pipe(Effect.forkScoped)
        yield* Deferred.await(gate.entered)
        yield* revocation.revoke(autonomy)
        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(fiber)).toEqual({ status: "deferred", itemID: expect.any(String) })
      }),
    )

    it.effect(`awake Form waits for the human when the ${revocation.name} during evaluation`, () =>
      Effect.gen(function* () {
        const autonomy = yield* family({ asleep: false })
        yield* revocation.grant(autonomy)
        const gate = yield* holdChoice("Careful")
        const forms = yield* Form.Service
        const fiber = yield* forms.ask(planForm).pipe(Effect.forkScoped)
        yield* Deferred.await(gate.entered)
        yield* revocation.revoke(autonomy)
        yield* Deferred.succeed(gate.release, undefined)
        yield* TestClock.adjust("0 millis")
        expect(yield* forms.state(planForm.id)).toEqual({ status: "pending" })
        yield* forms.reply({ id: planForm.id, answer: { plan: "Fast" } })
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answer: { plan: "Fast" } })
      }),
    )

    it.effect(`awake Question waits for the human when the ${revocation.name} during evaluation`, () =>
      Effect.gen(function* () {
        const autonomy = yield* family({ asleep: false })
        yield* revocation.grant(autonomy)
        const gate = yield* holdChoice("Careful")
        const questions = yield* Question.Service
        const events = yield* EventRuntime.Service
        const unsubscribe = yield* events.listen((event) =>
          event.type === Question.Event.Asked.type
            ? questions
                .reply({ requestID: (event.data as Question.Request).id, answers: [["Fast"]] })
                .pipe(Effect.orDie)
            : Effect.void,
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const fiber = yield* questions.ask({ sessionID: leaf, questions: [planQuestion] }).pipe(Effect.forkScoped)
        yield* Deferred.await(gate.entered)
        yield* revocation.revoke(autonomy)
        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["Fast"]] })
      }),
    )

    it.effect(`asleep Question defers when the ${revocation.name} during evaluation`, () =>
      Effect.gen(function* () {
        const autonomy = yield* family({ asleep: true })
        yield* revocation.grant(autonomy)
        const gate = yield* holdChoice("Careful")
        const questions = yield* Question.Service
        const fiber = yield* questions.ask({ sessionID: leaf, questions: [planQuestion] }).pipe(Effect.forkScoped)
        yield* Deferred.await(gate.entered)
        yield* revocation.revoke(autonomy)
        yield* Deferred.succeed(gate.release, undefined)
        expect(yield* Fiber.join(fiber)).toEqual({ status: "deferred", itemID: expect.any(String) })
      }),
    )

    for (const asleep of [false, true]) {
      it.effect(`${asleep ? "asleep" : "awake"} managed child question is not auto-answered when the ${revocation.name} during evaluation`, () =>
        Effect.gen(function* () {
          const autonomy = yield* family({ asleep })
          yield* revocation.grant(autonomy)
          const gate = yield* holdChoice("Careful")
          const orchestration = yield* SessionOrchestration.Service
          const fiber = yield* orchestration
            .question(leaf, "Which plan?", { options: ["Fast", "Careful"] })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(gate.entered)
          yield* revocation.revoke(autonomy)
          yield* Deferred.succeed(gate.release, undefined)
          expect((yield* Fiber.join(fiber)).autoAnswered).toBe(false)
          expect(synthetic).toEqual([])
        }),
      )
    }
  }

  it.effect("a neighboring Session's autonomy change does not fence the inherited answer", () =>
    Effect.gen(function* () {
      const autonomy = yield* family({ asleep: true })
      yield* autonomy.setYolo({ sessionID: root, yolo: true })
      const gate = yield* holdChoice("Careful")
      const forms = yield* Form.Service
      const fiber = yield* forms.ask(planForm).pipe(Effect.forkScoped)
      yield* Deferred.await(gate.entered)
      yield* autonomy.set({ sessionID: sibling, autoAnswer: true })
      yield* Deferred.succeed(gate.release, undefined)
      expect(yield* Fiber.join(fiber)).toEqual({
        status: "answered",
        answer: { plan: "Careful" },
        automatic: true,
        via: "yolo",
        confidence: 0.9,
      })
    }),
  )
})
