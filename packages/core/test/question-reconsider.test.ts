import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
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
  Effect.die("the Decision helper must not be called")
let helperCalls = 0

const layer = AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node, Question.node]),
  [
    [
      Decision.node,
      Layer.mock(Decision.Service, {
        evaluate: (input: Decision.Input) => Effect.sync(() => void helperCalls++).pipe(Effect.andThen(decisionBehavior(input))),
      }),
    ],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
      }),
    ],
  ],
)
const it = testEffect(layer)

const choice = (value: string, confidence: number) => (input: Decision.Input) =>
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
          choice: null,
          score: null,
          confidence: 0,
          grades:
            item.type === "choice" && item.grade === true
              ? item.choices.map((option) => ({
                  choice: option.value,
                  confidence: option.value === value ? confidence : 0.1,
                  evidence: `Fixture support for ${option.value}.`,
                }))
              : [],
        })),
      },
    }),
  )

const sessionID = Session.ID.make("ses_question_reconsider")
const plain: Question.Info = { question: "Which option?", header: "Option", options: [{ label: "One", description: "First option" }, { label: "Two", description: "Second option" }] }
const recommended: Question.Info = { ...plain, options: [{ label: "One (Recommended)", description: "First option" }, { label: "Two", description: "Second option" }] }
const owner = "ses_goal_owner_synthetic"
const dotsSource = {
  kind: "dots-client",
  anchorSessionID: Session.ID.make("ses_anchor_reconsider"),
  bindingID: "binding",
  delegationID: "grant",
  revision: 2,
  exchangeID: "decision",
  principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "oauth-grant", epoch: "epoch" },
} as const

const setup = Effect.gen(function* () {
  helperCalls = 0
  decisionBehavior = () => Effect.die("the Decision helper must not be called")
  const { db } = yield* Database.Service
  const directory = AbsolutePath.make("/project")
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: directory, sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory, title: "Question reconsider" }).onConflictDoNothing().run().pipe(Effect.orDie)
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.set({ sessionID, answers: "manual" })
  const events = yield* EventRuntime.Service
  const seen: Array<{ type: string; data: unknown }> = []
  const stop = yield* events.listen((event) => Effect.sync(() => void seen.push({ type: event.type, data: event.data })))
  yield* Effect.addFinalizer(() => stop)
  return { service: yield* Question.Service, autonomy, seen }
})

const ask = (f: Effect.Success<typeof setup>, questions: ReadonlyArray<Question.Info> = [plain]) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<Question.Request>()
    const events = yield* EventRuntime.Service
    const stop = yield* events.listen((event) =>
      event.type === Question.Event.Asked.type ? Deferred.succeed(asked, Schema.decodeUnknownSync(Question.Request)(event.data)).pipe(Effect.asVoid) : Effect.void,
    )
    const fiber = yield* f.service.ask({ sessionID, questions }).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* stop
    return { fiber, request }
  })

const reconsider = (
  f: Effect.Success<typeof setup>,
  request: Question.Request,
  overrides: Partial<Question.ReconsiderInput> = {},
) =>
  f.service.reconsider({
    requestID: request.id,
    fingerprint: Question.fingerprint(request),
    actor: "coordinator",
    source: { coordinatorSessionID: owner, rationale: "Synthetic routine answer." },
    validate: () => Effect.succeed(true),
    ...overrides,
  })

const gate = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const behavior = (value: string, confidence: number) => (input: Decision.Input) =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(choice(value, confidence)(input)))
  return { entered, release, behavior }
})

const replies = (f: Effect.Success<typeof setup>) => f.seen.filter((event) => event.type === Question.Event.Replied.type)

it.effect("QR1 manual answers mode never settles and makes no helper call", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { request } = yield* ask(f, [recommended])

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "escalated", settled: false, reason: "explicit-decision:manual-answers" })
    expect(helperCalls).toBe(0)
    expect(yield* f.service.list()).toHaveLength(1)
    expect(replies(f)).toEqual([])
  }),
)

it.effect("QR2 a switch to Auto settles a single Recommended option with the automatic outcome", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { fiber, request } = yield* ask(f, [recommended])
    yield* f.autonomy.set({ sessionID, answers: "auto" })

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "allowed", settled: true, via: "auto-answer" })
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: "answered",
      answers: [["One (Recommended)"]],
      automatic: true,
      via: "auto-answer",
      source: { kind: "coordinator", coordinatorSessionID: owner, via: "auto-answer", rationale: "Synthetic routine answer." },
    })
    expect(replies(f)).toHaveLength(1)
    expect(yield* f.service.list()).toEqual([])
    expect(helperCalls).toBe(0)
  }),
)

it.effect("QR3 a switch to YOLO settles through the scripted evaluator with confidence and assessment", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { fiber, request } = yield* ask(f)
    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = choice("Two", 0.9)

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "allowed", settled: true, via: "yolo", confidence: 0.9 })
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: "answered",
      answers: [["Two"]],
      automatic: true,
      via: "yolo",
      confidence: 0.9,
      assessment: { mode: "yolo", fields: [{ key: "question_0", status: "assessed", recommendation: ["Two"] }] },
    })
    expect(helperCalls).toBe(1)
    expect(replies(f)).toHaveLength(1)
  }),
)

it.effect("QR4 an unsettled YOLO assessment escalates and the request stays pending for a human", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { fiber, request } = yield* ask(f)
    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = choice("One", 0.5)

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "escalated", settled: false, reason: "low_confidence" })
    expect(yield* f.service.list()).toHaveLength(1)
    yield* f.service.reply({ requestID: request.id, answers: [["One"]] })
    expect(yield* Fiber.join(fiber)).toEqual({ status: "answered", answers: [["One"]] })
  }),
)

for (const delegated of [false, true])
  it.effect(`QR5 a human ${delegated ? "replyDelegated" : "reply"} during the evaluation settles exactly once and reconsider is stale`, () =>
    Effect.gen(function* () {
      const f = yield* setup
      const { fiber, request } = yield* ask(f)
      yield* f.autonomy.set({ sessionID, answers: "yolo" })
      const held = yield* gate
      decisionBehavior = held.behavior("Two", 0.9)
      const running = yield* reconsider(f, request).pipe(Effect.forkScoped)
      yield* Deferred.await(held.entered)

      if (delegated)
        yield* f.service.replyDelegated({
          requestID: request.id,
          fingerprint: Question.fingerprint(request),
          source: dotsSource,
          validate: () => Effect.succeed(true),
          answers: [["One"]],
        })
      else yield* f.service.reply({ requestID: request.id, answers: [["One"]] })
      yield* Deferred.succeed(held.release, undefined)

      expect(yield* Fiber.join(running)).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* Fiber.join(fiber)).toMatchObject({ status: "answered", answers: [["One"]] })
      expect((yield* Fiber.join(fiber)) as object).not.toHaveProperty("automatic")
      expect(replies(f)).toHaveLength(1)
    }),
  )

it.effect("QR6 a rejection, rejectDelegated, cancelPending or interrupt before the lock leaves reconsider stale and unanswered", () =>
  Effect.gen(function* () {
    for (const how of ["reject", "rejectDelegated", "cancelPending", "interrupt"] as const) {
      const f = yield* setup
      const { fiber, request } = yield* ask(f)
      yield* f.autonomy.set({ sessionID, answers: "yolo" })
      const held = yield* gate
      decisionBehavior = held.behavior("Two", 0.9)
      const running = yield* reconsider(f, request).pipe(Effect.forkScoped)
      yield* Deferred.await(held.entered)

      if (how === "reject") yield* f.service.reject(request.id)
      if (how === "rejectDelegated")
        yield* f.service.rejectDelegated({
          requestID: request.id,
          fingerprint: Question.fingerprint(request),
          explicitDecision: true,
          source: dotsSource,
          validate: () => Effect.succeed(true),
        })
      if (how === "cancelPending") yield* f.service.cancelPending(sessionID)
      if (how === "interrupt") yield* Fiber.interrupt(fiber)
      yield* Deferred.succeed(held.release, undefined)

      expect(yield* Fiber.join(running)).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* f.service.list()).toEqual([])
      expect(replies(f)).toEqual([])
      if (how !== "interrupt") expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
    }
  }),
)

it.effect("QR7 a fingerprint mismatch or an unknown request is stale", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { request } = yield* ask(f, [recommended])
    yield* f.autonomy.set({ sessionID, answers: "auto" })

    expect(yield* reconsider(f, request, { fingerprint: "0".repeat(64) })).toMatchObject({ outcome: "stale", settled: false })
    expect(yield* reconsider(f, request, { requestID: Question.ID.ascending("que_unknown") })).toMatchObject({ outcome: "stale", settled: false })
    expect(yield* f.service.list()).toHaveLength(1)
    expect(replies(f)).toEqual([])
  }),
)

it.effect("QR8 autonomy changed or delegation revoked between capture and the lock never settles", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { request } = yield* ask(f)
    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    const held = yield* gate
    decisionBehavior = held.behavior("Two", 0.9)
    const running = yield* reconsider(f, request).pipe(Effect.forkScoped)
    yield* Deferred.await(held.entered)
    yield* f.autonomy.set({ sessionID, answers: "manual" })
    yield* Deferred.succeed(held.release, undefined)

    expect(yield* Fiber.join(running)).toMatchObject({ outcome: "escalated", settled: false, reason: "stale-assessment" })
    expect(yield* f.service.list()).toHaveLength(1)

    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    decisionBehavior = choice("Two", 0.9)
    let validations = 0
    expect(yield* reconsider(f, request, { validate: () => Effect.sync(() => ++validations === 1) })).toMatchObject({
      outcome: "escalated",
      settled: false,
      reason: "delegation-invalid",
    })
    expect(yield* f.service.list()).toHaveLength(1)
    expect(replies(f)).toEqual([])
  }),
)

it.effect("QR9 a concurrent reconsider of the same request is in progress and exactly one settles", () =>
  Effect.gen(function* () {
    const f = yield* setup
    const { fiber, request } = yield* ask(f)
    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    const held = yield* gate
    decisionBehavior = held.behavior("Two", 0.9)
    const first = yield* reconsider(f, request).pipe(Effect.forkScoped)
    yield* Deferred.await(held.entered)

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "escalated", settled: false, reason: "native-assessment-in-progress" })
    yield* Deferred.succeed(held.release, undefined)
    expect(yield* Fiber.join(first)).toMatchObject({ outcome: "allowed", settled: true, via: "yolo" })
    expect(yield* Fiber.join(fiber)).toMatchObject({ status: "answered", answers: [["Two"]], automatic: true })
    expect(replies(f)).toHaveLength(1)
  }),
)

it.effect("A1 a reconsider during the ask-time evaluation is in progress and the ask-time outcome and assessment stay intact", () =>
  Effect.gen(function* () {
    const f = yield* setup
    yield* f.autonomy.set({ sessionID, answers: "yolo" })
    const held = yield* gate
    decisionBehavior = held.behavior("Two", 0.9)
    const fiber = yield* f.service.ask({ sessionID, questions: [plain] }).pipe(Effect.forkScoped)
    yield* Deferred.await(held.entered)
    const [request] = yield* f.service.list()

    expect(yield* reconsider(f, request)).toMatchObject({ outcome: "escalated", settled: false, reason: "native-assessment-in-progress" })
    expect(helperCalls).toBe(1)
    yield* Deferred.succeed(held.release, undefined)
    expect(yield* Fiber.join(fiber)).toMatchObject({
      status: "answered",
      answers: [["Two"]],
      automatic: true,
      via: "yolo",
      confidence: 0.9,
      assessment: { mode: "yolo", fields: [{ key: "question_0", status: "assessed", recommendation: ["Two"] }] },
    })
    expect(replies(f)).toEqual([])
  }),
)
