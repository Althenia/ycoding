import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Model } from "@ycoding-ai/schema/model"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { Shell } from "@ycoding-ai/schema/shell"
import { Agent } from "@ycoding-ai/core/agent"
import { ConfigCoordination } from "@ycoding-ai/core/config/coordination"
import { CoordinationSettings } from "@ycoding-ai/core/coordination-settings"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { KV } from "@ycoding-ai/core/kv"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionDecisionContext } from "@ycoding-ai/core/session/decision-context"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Hash } from "@ycoding-ai/core/util/hash"
import { SessionGoalDecisions } from "../src/session/goal-decisions"
import { reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

type Reconsider<I, R> = (input: I, real: (input: I) => Effect.Effect<R>) => Effect.Effect<R>

interface Entry {
  readonly type: string
  readonly data: Record<string, unknown>
  readonly event?: EventRuntime.Payload
}

interface Tap {
  readonly seen: Entry[]
  readonly push: (entry: Entry) => Effect.Effect<void>
  readonly until: (done: (seen: ReadonlyArray<Entry>) => boolean) => Effect.Effect<void>
}

const decisionCalls: Decision.Input[] = []
const wakes: SessionSchema.ID[] = []
const interrupts: SessionSchema.ID[] = []
const reconsiderCalls: string[] = []
const running = new Set<SessionSchema.ID>()
type ChildReconsiderInput = Parameters<SessionOrchestration.Interface["reconsiderQuestion"]>[0]
type ChildReconsiderResult = Effect.Success<ReturnType<SessionOrchestration.Interface["reconsiderQuestion"]>>

const hooks: {
  permission?: Reconsider<Permission.ReconsiderInput, Permission.ReconsiderResult>
  form?: Reconsider<Form.ReconsiderInput, Form.ReconsiderResult>
  question?: Reconsider<Question.ReconsiderInput, Question.ReconsiderResult>
  child?: Reconsider<ChildReconsiderInput, ChildReconsiderResult>
} = {}
let fakeGuardrail: SessionGoalDecisions.Located["guardrail"] | undefined
let fakeShell: SessionGoalDecisions.Located["shell"] | undefined
let tap: Tap
let passGate: Deferred.Deferred<void> | undefined
let missingLocation = false
let locateCalls = 0
let policy = ConfigCoordination.resolve()
let decide: (input: Decision.Input) => ReturnType<Decision.Interface["evaluate"]> = () => Effect.die("the Decision helper must not be called")

const childWakes: SessionSchema.ID[] = []
const recordingExecution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set<SessionSchema.ID>()),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void childWakes.push(sessionID)),
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
    shutdown: Effect.void,
    withTransition: (_sessionID, effect) => effect,
  }),
)

const fixtureOverrides = [
  [
    Project.node,
    Layer.mock(Project.Service, {
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      recordOpened: () => Effect.void,
    }),
  ],
  [
    KeepAwake.node,
    Layer.mock(KeepAwake.Service, {
      hold: () => Effect.succeed({ state: "off" as const }),
      release: () => Effect.succeed({ state: "off" as const }),
      get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
    }),
  ],
] as const

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      EventRuntime.node,
      Session.node,
      SessionStore.node,
      SessionExecution.node,
      Project.node,
      SessionAutonomy.node,
      SessionOrchestration.node,
      SessionReview.node,
      LocationServiceMap.node,
    ]),
    [
      ...fixtureOverrides,
      [SessionExecution.node, recordingExecution],
      [
        Decision.node,
        Layer.mock(Decision.Service, {
          evaluate: (input: Decision.Input) => {
            decisionCalls.push(input)
            return tap.push({ type: "test.decision", data: {} }).pipe(Effect.andThen(decide(input)))
          },
        }),
      ],
    ],
  ),
)

const reset = Effect.sync(() => {
  decisionCalls.length = 0
  childWakes.length = 0
  wakes.length = 0
  interrupts.length = 0
  reconsiderCalls.length = 0
  running.clear()
  delete hooks.permission
  delete hooks.form
  delete hooks.question
  delete hooks.child
  fakeGuardrail = undefined
  fakeShell = undefined
  passGate = undefined
  missingLocation = false
  locateCalls = 0
  policy = ConfigCoordination.resolve()
  decide = () => Effect.die("the Decision helper must not be called")
})

const makeTap = Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const seen: Entry[] = []
  const waiters: Array<{ readonly done: (seen: ReadonlyArray<Entry>) => boolean; readonly latch: Deferred.Deferred<void> }> = []
  const push = (entry: Entry) =>
    Effect.gen(function* () {
      seen.push(entry)
      for (const waiter of waiters.filter((item) => item.done(seen))) {
        waiters.splice(waiters.indexOf(waiter), 1)
        yield* Deferred.succeed(waiter.latch, undefined)
      }
    })
  const stop = yield* events.listen((event) => push({ type: event.type, data: typeof event.data === "object" && event.data !== null ? Object.fromEntries(Object.entries(event.data)) : {}, event }))
  yield* Effect.addFinalizer(() => stop)
  const until = (done: (seen: ReadonlyArray<Entry>) => boolean) =>
    Effect.gen(function* () {
      if (done(seen)) return
      const latch = yield* Deferred.make<void>()
      waiters.push({ done, latch })
      yield* Deferred.await(latch)
    })
  return { seen, push, until } satisfies Tap
})

const execution = {
  active: Effect.sync(() => new Set(running) as ReadonlySet<SessionSchema.ID>),
  wake: (sessionID: SessionSchema.ID) =>
    Effect.sync(() => void wakes.push(sessionID)).pipe(Effect.andThen(tap.push({ type: "test.wake", data: { sessionID } }))),
  interrupt: (sessionID: SessionSchema.ID) => Effect.sync(() => void interrupts.push(sessionID)),
}

const graded = (request: Decision.Input, scores: Record<string, number>) =>
  Schema.decodeUnknownSync(Decision.Output)({
    provider: "agent",
    response: {
      model: { providerID: "test", id: "decision-model" },
      semantics: "model-estimate",
      version: 1,
      answers: request.request.questions.map((question) => ({
        name: question.name,
        type: "choice",
        answer: null,
        choice: null,
        score: null,
        confidence: 0,
        grades:
          question.type === "choice"
            ? question.choices.map((choice) => ({
                choice: choice.value,
                confidence: scores[String(choice.value)] ?? 0,
                evidence: "Bounded assessment evidence",
              }))
            : [],
      })),
    },
  })

const instrument = (located: SessionGoalDecisions.Located | undefined): SessionGoalDecisions.Located | undefined => {
  if (located === undefined) return undefined
  const permission = located.permission
  const form = located.form
  const questions = located.question
  const guardrail = fakeGuardrail ?? located.guardrail
  return {
    ...located,
    ...(fakeGuardrail === undefined ? {} : { guardrail: fakeGuardrail }),
    ...(guardrail === undefined
      ? {}
      : {
          guardrail: {
            ...guardrail,
            reconsider: (input: Parameters<typeof guardrail.reconsider>[0]) => {
              reconsiderCalls.push(`guardrail:${input.requestID}`)
              return tap.push({ type: "test.reconsider", data: { requestID: input.requestID } }).pipe(Effect.andThen(guardrail.reconsider(input)))
            },
          },
        }),
    ...(fakeShell === undefined ? {} : { shell: fakeShell }),
    ...(permission === undefined
      ? {}
      : {
          permission: {
            ...permission,
            reconsider: (input: Permission.ReconsiderInput) => {
              reconsiderCalls.push(`permission:${input.requestID}`)
              return tap
                .push({ type: "test.reconsider", data: { requestID: input.requestID } })
                .pipe(Effect.andThen(hooks.permission === undefined ? permission.reconsider(input) : hooks.permission(input, permission.reconsider)))
            },
          },
        }),
    ...(questions === undefined
      ? {}
      : {
          question: {
            ...questions,
            reconsider: (input: Question.ReconsiderInput) => {
              reconsiderCalls.push(`question:${input.requestID}`)
              return tap
                .push({ type: "test.reconsider", data: { requestID: input.requestID } })
                .pipe(Effect.andThen(hooks.question === undefined ? questions.reconsider(input) : hooks.question(input, questions.reconsider)))
            },
          },
        }),
    ...(form === undefined
      ? {}
      : {
          form: {
            ...form,
            reconsider: (input: Form.ReconsiderInput) => {
              reconsiderCalls.push(`form:${input.id}`)
              return tap
                .push({ type: "test.reconsider", data: { requestID: input.id } })
                .pipe(Effect.andThen(hooks.form === undefined ? form.reconsider(input) : hooks.form(input, form.reconsider)))
            },
          },
        }),
  }
}

const goalText = "Ship the synthetic feature"

const startLoop = Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const autonomy = yield* SessionAutonomy.Service
  const locate = SessionGoalDecisions.locate(yield* SessionStore.Service, yield* LocationServiceMap.Service)
  const orchestration = yield* SessionOrchestration.Service
  const loop = SessionGoalDecisions.make({
    db: (yield* Database.Service).db,
    events,
    autonomy,
    execution,
    orchestration: {
      questionSnapshots: orchestration.questionSnapshots,
      reconsiderQuestion: (input: ChildReconsiderInput) => {
        reconsiderCalls.push(`child_question:${input.questionID}`)
        return tap
          .push({ type: "test.reconsider", data: { requestID: input.questionID } })
          .pipe(Effect.andThen(hooks.child === undefined ? orchestration.reconsiderQuestion(input) : hooks.child(input, orchestration.reconsiderQuestion)))
      },
    },
    policy: () => Effect.sync(() => policy),
    locate: (sessionID) =>
      Effect.sync(() => void locateCalls++).pipe(
        Effect.andThen(passGate === undefined ? Effect.void : Deferred.await(passGate)),
        Effect.andThen(missingLocation ? Effect.succeed(undefined) : locate(sessionID)),
        Effect.map(instrument),
      ),
  })
  const scope = yield* Scope.make()
  yield* SessionGoalDecisions.start({ events, autonomy, loop }).pipe(Effect.provideService(Scope.Scope, scope))
  return { loop, stop: Scope.close(scope, Exit.void) }
})

const model = Schema.decodeUnknownSync(Model.Ref)({ providerID: "test", id: "model" })

const setup = (options: { readonly goal?: boolean; readonly guardrailRule?: boolean } = {}) =>
  Effect.gen(function* () {
    yield* reset
    tap = yield* makeTap
    const location = yield* reviewLocation
    if (options.guardrailRule) {
      yield* Effect.promise(() => fs.mkdir(`${location.directory}/.ycoding/guardrails`, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          `${location.directory}/.ycoding/guardrails/native.md`,
          "---\nid: native-choice\ndecision: ask\nactions: [shell]\nresources: [native-synthetic-command]\nreason: Explicit native choice\n---\n",
        ),
      )
    }
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ location })
    const located = (yield* LocationServiceMap.Service).get(root.location, [LocationServiceMap.full])
    const permissions = yield* Permission.Service.pipe(Effect.provide(located))
    const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(located))
    const forms = yield* Form.Service.pipe(Effect.provide(located))
    const questions = yield* Question.Service.pipe(Effect.provide(located))
    const agents = yield* Agent.Service.pipe(Effect.provide(located))
    const agent = Agent.ID.make("goal-loop")
    yield* agents.transform((draft) =>
      draft.update(agent, (entry) => {
        entry.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
    const autonomy = yield* SessionAutonomy.Service
    const started = yield* startLoop
    if (options.goal !== false) yield* autonomy.setGoal({ sessionID: root.id, text: goalText })
    return {
      root,
      sessions,
      permissions,
      guardrails,
      forms,
      questions,
      agents,
      agent,
      autonomy,
      loop: started.loop,
      stop: started.stop,
      orchestration: yield* SessionOrchestration.Service,
      reviews: yield* SessionReview.Service,
      events: yield* EventRuntime.Service,
      db: (yield* Database.Service).db,
    }
  })

type Fixture = Effect.Success<ReturnType<typeof setup>>

const isReceipt = (entry: Entry, owner: SessionSchema.ID) =>
  entry.type === SessionEvent.InputAdmitted.type && entry.data.sessionID === owner && String(entry.data.inputID).startsWith("msg_goaldec_")

const awaitReceipts = (owner: SessionSchema.ID, count: number) =>
  tap.until((seen) => seen.filter((entry) => isReceipt(entry, owner)).length >= count)

const receipts = (f: Pick<Fixture, "db">, sessionID: SessionSchema.ID) =>
  SessionPending.list(f.db, sessionID).pipe(
    Effect.map((items) =>
      items.flatMap((item) =>
        item.type === "synthetic" && item.id.startsWith("msg_goaldec_")
          ? [
              {
                id: item.id,
                text: item.data.text,
                metadata: item.data.metadata ?? {},
                goalDecision: Schema.decodeUnknownSync(SessionGoalDecisions.Receipt)(item.data.metadata?.goalDecision),
              },
            ]
          : [],
      ),
    ),
  )

const outcomes = (items: Effect.Success<ReturnType<typeof receipts>>) =>
  items.map((item) => `${item.goalDecision.outcome}:${item.goalDecision.reason ?? item.goalDecision.via ?? ""}`).toSorted()

const askInput = (
  f: Fixture,
  input: {
    readonly sessionID?: SessionSchema.ID
    readonly action?: string
    readonly resources?: ReadonlyArray<string>
    readonly requireExplicitDecision?: boolean
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  } = {},
) => ({
  sessionID: input.sessionID ?? f.root.id,
  agent: f.agent,
  action: input.action ?? "read",
  resources: input.resources ?? ["src/goal.ts"],
  ...(input.requireExplicitDecision === undefined ? {} : { requireExplicitDecision: input.requireExplicitDecision }),
  ...(input.source === undefined ? {} : { source: input.source }),
})

const pendingAsk = (f: Fixture, input: Parameters<typeof askInput>[1] = {}) =>
  Effect.gen(function* () {
    const asked = yield* f.permissions.ask(askInput(f, input))
    expect(asked.effect).toBe("ask")
    const snapshot = yield* f.permissions.snapshot(asked.id)
    return { id: asked.id, fingerprint: snapshot!.fingerprint }
  })

const assessed = () => tap.seen.filter((event) => event.type === SessionEvent.PermissionAssessed.type)
const isHandled = (event: EventRuntime.Payload | undefined): event is SessionGoalDecisions.HandledEvent =>
  event !== undefined && SessionGoalDecisions.handledEvents.some((definition) => definition.type === event.type)

const replay = (f: Pick<Fixture, "loop">, type: string) =>
  Effect.forEach(
    tap.seen.filter((entry) => entry.type === type),
    (entry) => (isHandled(entry.event) ? f.loop.handle(entry.event) : Effect.void),
    { discard: true },
  )

const awaitWakes = (count: number) => tap.until((seen) => seen.filter((entry) => entry.type === "test.wake").length >= count)
const reconsidered = (count: number) => tap.until((seen) => seen.filter((entry) => entry.type === "test.reconsider").length >= count)

const managedChild = (f: Fixture, parent: SessionSchema.ID = f.root.id) =>
  Effect.gen(function* () {
    const child = yield* f.sessions.create({ parentID: parent, model })
    yield* f.events.publish(SessionEvent.Task.Updated, {
      sessionID: child.id,
      change: {
        type: "launched",
        parentID: parent,
        parentAssistantMessageID: SessionMessage.ID.create(),
        toolCallID: `call_${child.id}`,
        inputID: SessionMessage.ID.create(),
        description: "Synthetic child",
        agent: Agent.ID.make("build"),
        model,
        promptDigest: "digest",
        background: true,
        delivery: "steer",
      },
    })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    return child
  })

it.live("B1 Manual: an active goal never settles a pending ask and records one waiting receipt", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const ask = yield* pendingAsk(f)

    yield* awaitReceipts(f.root.id, 1)
    const [waiting] = yield* receipts(f, f.root.id)
    expect(waiting.goalDecision).toMatchObject({
      outcome: "waiting",
      reason: "human-only:manual-permissions",
      candidate: { kind: "permission", sessionID: f.root.id, requestID: ask.id, fingerprint: ask.fingerprint },
      requirement: { goalDigest: Hash.sha256(goalText), iteration: 0, revision: expect.any(Number) },
    })
    expect(waiting.goalDecision.rationale.length).toBeGreaterThan(0)
    expect(waiting.metadata).not.toHaveProperty("inputOrigin")
    expect(waiting.text.length).toBeLessThanOrEqual(1000)
    expect(waiting.text).toContain("authorizes nothing")

    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(decisionCalls).toHaveLength(0)
    expect(assessed()).toEqual([])
    expect(tap.seen.filter((event) => event.type === "coordination.request.escalated")).toEqual([])
    expect(reconsiderCalls).toEqual([])
    expect(wakes).toEqual([])
    expect(interrupts).toEqual([])
  }),
)

it.live("B2/B12 Auto: a switch to Auto settles a routine ask; the owner is blocked on its own ask, so the active-owner resume gate admits a receipt without a wake", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    running.add(f.root.id)
    const source = { messageID: SessionMessage.ID.make("msg_synthetic_source"), callID: "call_synthetic" }
    const ask = yield* pendingAsk(f, { source: { type: "tool", ...source } })
    yield* awaitReceipts(f.root.id, 1)
    expect(yield* f.permissions.list()).toHaveLength(1)

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* awaitReceipts(f.root.id, 3)

    const settled = (yield* receipts(f, f.root.id)).find((item) => item.goalDecision.outcome === "settled")!
    expect(settled.goalDecision).toMatchObject({
      outcome: "settled",
      via: "auto-permission",
      candidate: { kind: "permission", sessionID: f.root.id, requestID: ask.id, fingerprint: ask.fingerprint },
      requirement: { goalDigest: Hash.sha256(goalText), iteration: 0, revision: expect.any(Number) },
      source,
    })
    expect(settled.text).toContain("authorizes nothing")
    expect(yield* f.permissions.list()).toEqual([])
    expect(assessed()).toHaveLength(1)
    expect(assessed()[0].data).toMatchObject({
      requestID: ask.id,
      outcome: "allow",
      via: "auto-permission",
      actor: "coordinator",
      coordinatorSessionID: f.root.id,
      rationale: expect.stringMatching(/\S/),
    })
    expect(assessed()[0].data).not.toHaveProperty("groupID")
    expect(decisionCalls).toHaveLength(0)

    yield* f.loop.inspect(f.root.id)
    expect(assessed()).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "settled:allowed", "waiting:human-only:manual-permissions"])
    expect(reconsiderCalls).toHaveLength(1)
    expect(wakes).toEqual([])
    expect(interrupts).toEqual([])
  }),
)

it.live("B12 switching back to Manual before the native lock produces no settlement", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* pendingAsk(f)
    yield* awaitReceipts(f.root.id, 1)
    let validations = 0
    hooks.permission = (input, real) =>
      real({
        ...input,
        validate: (request) =>
          (++validations === 2 ? f.autonomy.set({ sessionID: f.root.id, permissions: "manual" }).pipe(Effect.orDie) : Effect.void).pipe(
            Effect.andThen(input.validate(request)),
          ),
      })

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(validations).toBeGreaterThanOrEqual(2)
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
    expect(reconsiderCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:delegation-invalid", "waiting:human-only:manual-permissions"])
  }),
)

for (const [name, input, reason] of [
  ["requireExplicitDecision", { requireExplicitDecision: true }, "explicit-decision:request"],
  ["external_directory", { action: "external_directory", resources: ["/outside-synthetic/data"] }, "explicit-decision:external-write"],
  ["git push", { action: "shell", resources: ["git push origin main"] }, "explicit-decision:publication"],
] as const)
  it.live(`B3 ${name} stays human-only after a switch to Auto`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* pendingAsk(f, input)
      yield* awaitReceipts(f.root.id, 1)

      yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
      yield* f.loop.reconcile(f.root.id)

      expect(outcomes(yield* receipts(f, f.root.id))).toEqual([`waiting:${reason}`])
      expect(yield* f.permissions.list()).toHaveLength(1)
      expect(assessed()).toEqual([])
      expect(reconsiderCalls).toEqual([])
      expect(decisionCalls).toHaveLength(0)
    }),
  )

it.live("B3 an explicit deny rule is never allowed by the loop and the native deny path still denies", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const waiting = yield* f.permissions.assert(askInput(f)).pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.agents.transform((draft) =>
      draft.update(f.agent, (entry) => {
        entry.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      }),
    )

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })

    expect((yield* Fiber.await(waiting))._tag).toBe("Failure")
    yield* awaitReceipts(f.root.id, 2)
    expect((yield* receipts(f, f.root.id)).find((item) => item.goalDecision.outcome === "settled")!.goalDecision).toMatchObject({
      via: "permission-rules",
      reason: "denied",
    })
    expect(assessed().map((event) => event.data.outcome)).toEqual(["deny"])
    expect(tap.seen.filter((event) => event.type === Permission.Event.Replied.type).map((event) => event.data.reply)).toEqual(["reject"])
  }),
)

for (const kind of ["hard", "custom"] as const)
  it.live(`B3 a ${kind} guardrail review is never settled by the loop under Auto guardrails`, () =>
    Effect.gen(function* () {
      const f = yield* setup({ guardrailRule: kind === "custom" })
      const resource = kind === "hard" ? "git reset --hard" : "native-synthetic-command"
      yield* f.autonomy.set({ sessionID: f.root.id, guardrails: "auto" })
      yield* f.guardrails.assert({ sessionID: f.root.id, action: "shell", resources: [resource] }).pipe(Effect.forkScoped)
      yield* awaitReceipts(f.root.id, 1)

      const [request] = yield* f.guardrails.list()
      const items = yield* receipts(f, f.root.id)
      expect(items).toHaveLength(1)
      expect(items[0].goalDecision).toMatchObject({
        outcome: "waiting",
        reason: kind === "hard" ? "explicit-decision:hard-review" : "explicit-decision:custom-review",
        candidate: { kind: "guardrail", sessionID: f.root.id, requestID: request.id },
      })
      yield* f.loop.inspect(f.root.id)
      expect(yield* f.guardrails.list()).toHaveLength(1)
      expect(reconsiderCalls).toEqual([])
      expect(decisionCalls).toHaveLength(0)
    }),
  )

for (const [name, change, reason] of [
  ["disabled", { enabled: false }, "delegation-revoked"],
  ["expired", { expires_at: 1 }, "delegation-expired"],
  ["out of scope", { categories: ["question"] as const }, "delegation-out-of-scope"],
] as const)
  it.live(`B4 delegated decisions ${name} stop settlement and wait for a human`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      yield* pendingAsk(f)
      yield* awaitReceipts(f.root.id, 1)
      policy = ConfigCoordination.resolve(new ConfigCoordination.Info({ delegated_decisions: change }))

      yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
      yield* awaitReceipts(f.root.id, 2)

      expect(outcomes(yield* receipts(f, f.root.id))).toEqual([`waiting:${reason}`, "waiting:human-only:manual-permissions"].toSorted())
      expect(yield* f.permissions.list()).toHaveLength(1)
      expect(assessed()).toEqual([])
      expect(reconsiderCalls).toEqual([])
    }),
  )

it.live("B4 a stopped goal leaves a pending ask untouched", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* pendingAsk(f)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.autonomy.clearGoal(f.root.id)

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* f.loop.reconcile(f.root.id)

    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
    expect(reconsiderCalls).toEqual([])
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
  }),
)

it.live("B4 a validation that sees a different requesting Session never settles", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* pendingAsk(f)
    yield* awaitReceipts(f.root.id, 1)
    hooks.permission = (input, real) =>
      real({ ...input, validate: (request) => input.validate({ ...request, sessionID: SessionSchema.ID.make("ses_other_family") }) })

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
  }),
)

for (const scope of ["archived", "regoaled"] as const)
  it.live(`B4 a requesting Session ${scope === "archived" ? "archived" : "re-owned by an intermediate goal"} between capture and the native lock is never settled by the previous owner`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const mid = yield* f.sessions.create({ parentID: f.root.id })
      const kid = yield* f.sessions.create({ parentID: mid.id })
      yield* pendingAsk(f, { sessionID: kid.id })
      yield* awaitReceipts(f.root.id, 1)
      let validations = 0
      hooks.permission = (input, real) =>
        real({
          ...input,
          validate: (request) =>
            (validations++ === 1
              ? scope === "archived"
                ? f.db.update(SessionTable).set({ time_archived: 1 }).where(eq(SessionTable.id, kid.id)).run().pipe(Effect.orDie, Effect.asVoid)
                : f.autonomy.setGoal({ sessionID: mid.id, text: goalText }).pipe(Effect.orDie, Effect.asVoid)
              : Effect.void
            ).pipe(Effect.andThen(input.validate(request))),
        })

      yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
      yield* reconsidered(1)
      yield* f.loop.inspect(f.root.id)
      yield* f.loop.inspect(mid.id)

      expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")).toEqual([])
      expect(assessed().every((event) => event.data.coordinatorSessionID === mid.id)).toBe(true)
      if (scope === "archived") expect(yield* f.permissions.list()).toHaveLength(1)
    }),
  )

it.live("B5 duplicate events and repeated passes call reconsider once per attempt key and a defect is never retried", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const ask = yield* pendingAsk(f)
    yield* awaitReceipts(f.root.id, 1)
    hooks.permission = (input) =>
      Effect.succeed({ outcome: "escalated", requestID: input.requestID, fingerprint: input.fingerprint, settled: false, reason: "permission-ask" })

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* awaitReceipts(f.root.id, 2)
    for (let index = 0; index < 3; index++) {
      yield* f.events.publish(Permission.Event.Asked, { id: ask.id, sessionID: f.root.id, action: "read", resources: ["src/goal.ts"] })
      yield* f.loop.inspect(f.root.id)
    }
    expect(reconsiderCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions", "waiting:permission-ask"])

    hooks.permission = () => Effect.die("synthetic failure")
    yield* f.autonomy.set({ sessionID: f.root.id, answers: "yolo" })
    yield* reconsidered(2)
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)
    expect(reconsiderCalls).toHaveLength(2)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(
      ["waiting:human-only:manual-permissions", "waiting:permission-ask", "waiting:reconsider-failed"],
    )
    expect(yield* f.permissions.list()).toHaveLength(1)
  }),
)

it.live("B5 a YOLO-assessed candidate is not run again under an unchanged key and runs once after the key changes", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const scripts: Array<Record<string, number>> = [{ escalate: 0.95 }, { allow: 0.95 }]
    decide = (input) => Effect.succeed(graded(input, scripts[decisionCalls.length - 1] ?? { escalate: 0.95 }))
    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "yolo" })
    const waiting = yield* f.permissions.assert(askInput(f)).pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    expect(decisionCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:yolo-assessed"])
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)
    expect(decisionCalls).toHaveLength(1)
    expect(reconsiderCalls).toEqual([])

    yield* f.autonomy.set({ sessionID: f.root.id, answers: "yolo" })
    expect(yield* Fiber.join(waiting)).toBeUndefined()
    yield* f.loop.inspect(f.root.id)
    expect(decisionCalls).toHaveLength(2)
    expect(reconsiderCalls).toHaveLength(1)
    expect((yield* receipts(f, f.root.id)).some((item) => item.goalDecision.outcome === "settled" && item.goalDecision.via === "yolo")).toBe(true)
  }),
)

it.live("reconsider without a groupID keeps the exact fingerprint, validation, mode, explicit-decision and deny boundaries", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const source = { coordinatorSessionID: f.root.id, rationale: "Synthetic routine work." }
    const ask = yield* pendingAsk(f)
    const call = (overrides: Partial<Permission.ReconsiderInput> = {}) =>
      f.permissions.reconsider({
        requestID: ask.id,
        fingerprint: ask.fingerprint,
        actor: "coordinator",
        source,
        validate: () => Effect.succeed(true),
        ...overrides,
      })

    expect(yield* call({ fingerprint: "0".repeat(64) })).toMatchObject({ outcome: "stale", settled: false })
    expect(yield* call({ validate: () => Effect.succeed(false) })).toMatchObject({ outcome: "escalated", reason: "delegation-invalid" })
    expect(yield* call()).toMatchObject({ outcome: "escalated", reason: "native-assessment-unavailable" })
    expect(yield* f.permissions.list()).toHaveLength(1)

    const explicit = yield* pendingAsk(f, { requireExplicitDecision: true, resources: ["src/explicit.ts"] })
    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    expect(
      yield* f.permissions.reconsider({ requestID: explicit.id, fingerprint: explicit.fingerprint, actor: "coordinator", source, validate: () => Effect.succeed(true) }),
    ).toMatchObject({ outcome: "escalated", reason: "explicit-decision:request" })

    yield* f.agents.transform((draft) =>
      draft.update(f.agent, (entry) => {
        entry.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      }),
    )
    expect(yield* call()).toMatchObject({ outcome: "denied", settled: true, via: "permission-rules" })
    expect(assessed().map((event) => event.data.outcome)).toEqual(["deny"])
    expect(assessed()[0].data).toMatchObject({ coordinatorSessionID: f.root.id, rationale: source.rationale })
    expect(assessed()[0].data).not.toHaveProperty("groupID")
  }),
)

const fakeReview = (f: Fixture, calls: Array<Record<string, unknown>>, beforeValidate: Effect.Effect<void>) => {
  const request = new Guardrail.Request({
    id: Guardrail.RequestID.make("grq_synthetic_review"),
    rootSessionID: f.root.id,
    sessionID: f.root.id,
    action: "edit",
    resources: ["src/goal.ts"],
    ruleIDs: ["standard.review.synthetic"],
    reason: "Synthetic standard review",
    standard: true,
  })
  const fingerprint = "a".repeat(64)
  const guardrail: NonNullable<SessionGoalDecisions.Located["guardrail"]> = {
    requestSnapshots: () => Effect.succeed([{ request, fingerprint }]),
    reconsider: (input) =>
      Effect.gen(function* () {
        calls.push({ source: input.source })
        yield* beforeValidate
        const valid = yield* input.validate(request)
        return valid
          ? { outcome: "allowed" as const, requestID: request.id, fingerprint, settled: true, via: "auto-guardrail" as const }
          : { outcome: "escalated" as const, requestID: request.id, fingerprint, settled: false, reason: "delegation-invalid" }
      }),
  }
  return guardrail
}

it.live("a routine guardrail review settles through native reconsider with the owner as coordinator and no groupID under Auto guardrails", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const calls: Array<Record<string, unknown>> = []
    fakeGuardrail = fakeReview(f, calls, Effect.void)
    yield* f.autonomy.set({ sessionID: f.root.id, guardrails: "auto" })
    yield* awaitReceipts(f.root.id, 1)

    const [settled] = yield* receipts(f, f.root.id)
    expect(settled.goalDecision).toMatchObject({ outcome: "settled", via: "auto-guardrail", candidate: { kind: "guardrail", requestID: "grq_synthetic_review" } })
    expect(calls).toEqual([{ source: { coordinatorSessionID: f.root.id, rationale: expect.stringMatching(/\S/) } }])
    expect(calls[0].source).not.toHaveProperty("groupID")
  }),
)

it.live("a guardrail review in a sleeping family is never settled because the loop checks the family is awake", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const calls: Array<Record<string, unknown>> = []
    fakeGuardrail = fakeReview(f, calls, Effect.void)
    yield* f.autonomy.set({ sessionID: f.root.id, guardrails: "auto", sleep: true })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect((yield* f.autonomy.get(f.root.id)).sleep).toEqual({})
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:delegation-invalid"])
  }),
)

it.live(
  "D2 a validation failure records a waiting receipt so a later native answer still resumes the owner",
  () =>
    Effect.gen(function* () {
      const f = yield* setup({ goal: false })
      const kid = yield* f.sessions.create({ parentID: f.root.id })
      const ask = yield* pendingAsk(f, { sessionID: kid.id })
      yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
      let validations = 0
      hooks.permission = (input, real) =>
        real({
          ...input,
          validate: (request) =>
            (validations++ === 1 ? f.autonomy.advance({ sessionID: f.root.id, progress: "synthetic" }).pipe(Effect.orDie) : Effect.void).pipe(
              Effect.andThen(input.validate(request)),
            ),
        })

      yield* f.autonomy.set({ sessionID: f.root.id, goal: goalText })
      yield* awaitReceipts(f.root.id, 1)
      expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:delegation-invalid"])
      expect(yield* f.permissions.list()).toHaveLength(1)
      expect(reconsiderCalls).toHaveLength(1)

      yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
      yield* awaitReceipts(f.root.id, 2)
      yield* awaitWakes(1)
      expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:delegation-invalid"].toSorted())
      expect(wakes).toEqual([f.root.id])
    }),
  15000,
)

it.live("D3 a storm of triggers for one owner runs at most two inspection passes and settles exactly once", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    policy = ConfigCoordination.resolve(new ConfigCoordination.Info({ delegated_decisions: { enabled: false } }))
    const ask = yield* pendingAsk(f)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* awaitReceipts(f.root.id, 2)
    expect(yield* f.permissions.list()).toHaveLength(1)

    policy = ConfigCoordination.resolve()
    const gate = yield* Deferred.make<void>()
    passGate = gate
    const before = locateCalls
    yield* Effect.all(
      [...Array.from({ length: 20 }, () => f.loop.inspect(f.root.id)), Deferred.succeed(gate, undefined)],
      { concurrency: "unbounded", discard: true },
    )

    expect(locateCalls - before).toBeLessThanOrEqual(2)
    expect(reconsiderCalls).toEqual([`permission:${ask.id}`])
    expect(assessed()).toHaveLength(1)
    expect(yield* f.permissions.list()).toEqual([])
  }),
)

it.live("B6 an answered request resumes an idle owner once per settlement; a live rejection never resumes; a busy owner gets a receipt and no wake", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const ask = yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    expect(wakes).toEqual([])

    yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
    yield* awaitReceipts(f.root.id, 2)
    yield* awaitWakes(1)
    yield* f.loop.inspect(f.root.id)
    for (let index = 0; index < 2; index++) {
      yield* f.events.publish(Permission.Event.Replied, { sessionID: kid.id, requestID: ask.id, reply: "once" })
      yield* f.loop.inspect(f.root.id)
    }
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
    expect(wakes).toEqual([f.root.id])

    const rejected = yield* pendingAsk(f, { sessionID: kid.id, resources: ["src/rejected.ts"] })
    yield* awaitReceipts(f.root.id, 3)
    yield* f.permissions.reply({ requestID: rejected.id, reply: "reject" })
    yield* replay(f, Permission.Event.Replied.type)
    yield* f.loop.inspect(f.root.id)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toHaveLength(1)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")).toEqual([])
    expect(reconsiderCalls).toEqual([])
    expect(wakes).toEqual([f.root.id])

    running.add(f.root.id)
    const busy = yield* pendingAsk(f, { sessionID: kid.id, resources: ["src/busy.ts"] })
    yield* awaitReceipts(f.root.id, 4)
    yield* f.permissions.reply({ requestID: busy.id, reply: "once" })
    yield* awaitReceipts(f.root.id, 5)
    yield* f.loop.inspect(f.root.id)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toHaveLength(2)
    expect(wakes).toEqual([f.root.id])
    expect(interrupts).toEqual([])
  }),
)

it.live("B6 an owner with an active managed child task is resumed with a receipt but never woken", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const child = yield* managedChild(f)
    const ask = yield* pendingAsk(f, { sessionID: child.id })
    yield* awaitReceipts(f.root.id, 1)

    yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
    yield* awaitReceipts(f.root.id, 2)
    yield* f.loop.inspect(f.root.id)

    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
    expect(wakes).toEqual([])
    expect(interrupts).toEqual([])
  }),
)

it.live("B7 a fresh loop over the same database adds no receipts, never wakes at startup and still resumes a waiting request", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const ask = yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    yield* f.stop

    const restarted = yield* startLoop
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
    expect(wakes).toEqual([])

    yield* restarted.loop.inspect(f.root.id)
    yield* restarted.loop.inspect(f.root.id)
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
    expect(wakes).toEqual([])

    yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
    yield* awaitReceipts(f.root.id, 2)
    yield* awaitWakes(1)
    yield* restarted.loop.inspect(f.root.id)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
    expect(wakes).toEqual([f.root.id])
    yield* restarted.stop
  }),
)

it.live("B8 an inert loop acts on no goal-less family, no other family and no review-box item", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    yield* pendingAsk(f)
    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "auto" })
    yield* f.loop.reconcile(f.root.id)
    expect(yield* receipts(f, f.root.id)).toEqual([])
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(reconsiderCalls).toEqual([])

    const owner = yield* f.sessions.create({ location: f.root.location })
    yield* f.autonomy.setGoal({ sessionID: owner.id, text: goalText })
    yield* f.autonomy.set({ sessionID: owner.id, permissions: "auto" })
    const review = yield* SessionReviewFold.open(f.db, f.events, {
      sessionID: owner.id,
      kind: "question",
      reason: "disabled",
      origin: { requestID: "req_synthetic_review" },
      payload: { type: "question", questions: [{ header: "Mode", question: "Which?", options: [{ label: "One", description: "First" }] }] },
      limit: 16,
    })
    yield* f.loop.reconcile(owner.id)
    expect(yield* receipts(f, owner.id)).toEqual([])
    expect(yield* receipts(f, f.root.id)).toEqual([])
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(yield* SessionReviewFold.openCount(f.db, owner.id)).toBe(1)
    expect(review.itemID).toBeDefined()
    expect(reconsiderCalls).toEqual([])
  }),
)

it.live("a candidate belongs only to its nearest ancestor-or-self Session with an active goal", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const mid = yield* f.sessions.create({ parentID: f.root.id })
    const leaf = yield* f.sessions.create({ parentID: mid.id })
    yield* f.autonomy.setGoal({ sessionID: mid.id, text: goalText })
    yield* pendingAsk(f, { sessionID: leaf.id })
    yield* awaitReceipts(mid.id, 1)
    yield* f.loop.reconcile(f.root.id)

    expect(yield* receipts(f, mid.id)).toHaveLength(1)
    expect(yield* receipts(f, f.root.id)).toEqual([])
  }),
)

it.live("a goal receipt is a synthetic input outside the authority digest and reprocessing never settles again", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const digest = (id: SessionSchema.ID) => SessionDecisionContext.read(f.db, id).pipe(Effect.map(SessionDecisionContext.authorityDigest))
    const before = { root: yield* digest(f.root.id), kid: yield* digest(kid.id) }
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)

    expect(yield* digest(f.root.id)).toBe(before.root)
    expect(yield* digest(kid.id)).toBe(before.kid)
    const context = yield* SessionDecisionContext.read(f.db, f.root.id)
    expect([...context.userInstructions, ...context.pendingInstructions].filter((item) => item.text.includes("authorizes nothing"))).toEqual([])
    const [receipt] = yield* receipts(f, f.root.id)
    expect(receipt.metadata).not.toHaveProperty("inputOrigin")
    expect((yield* SessionPending.list(f.db, f.root.id)).every((item) => item.type === "synthetic")).toBe(true)
  }),
)

const questionInput = (label: string) => ({
  questions: [{ header: "Mode", question: "Which?", options: [{ label, description: "First" }], custom: false }],
})

it.live("B9 under Manual a Question-service request waits with human-only:manual-answers, resumes on reply and not on rejection", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const waiting = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("One") }).pipe(Effect.exit, Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    const [request] = yield* f.questions.list()
    const [receipt] = yield* receipts(f, f.root.id)
    expect(receipt.goalDecision).toMatchObject({
      outcome: "waiting",
      reason: "human-only:manual-answers",
      candidate: { kind: "question", sessionID: f.root.id, requestID: request.id, fingerprint: Question.fingerprint(request) },
    })
    expect(receipt.goalDecision.rationale.length).toBeGreaterThan(0)

    for (let index = 0; index < 2; index++) {
      yield* f.events.publish(Question.Event.Asked, request)
      yield* f.loop.inspect(f.root.id)
    }
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
    expect(yield* f.questions.list()).toHaveLength(1)

    yield* f.questions.reply({ requestID: request.id, answers: [["One"]] })
    expect((yield* Fiber.join(waiting))._tag).toBe("Success")
    yield* awaitReceipts(f.root.id, 2)
    yield* awaitWakes(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-answers"].toSorted())
    expect(wakes).toEqual([f.root.id])

    const rejected = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("Two") }).pipe(Effect.exit, Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 3)
    const [second] = yield* f.questions.list()
    yield* f.questions.reject(second.id)
    expect((yield* Fiber.join(rejected))._tag).toBe("Failure")
    yield* replay(f, Question.Event.Rejected.type)
    yield* f.loop.reconcile(f.root.id)
    yield* f.loop.inspect(f.root.id)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toHaveLength(1)
    expect(wakes).toEqual([f.root.id])
  }),
)

it.live("B9 under Auto the existing ask-time answer settles a Recommended option and the loop adds no second answer", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    const answered = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("One (Recommended)") })
    expect(answered).toMatchObject({ status: "answered", automatic: true, via: "auto-answer" })
    yield* f.loop.reconcile(f.root.id)
    expect(yield* f.questions.list()).toEqual([])
    expect(tap.seen.filter((event) => event.type === Question.Event.Replied.type)).toEqual([])
    expect(yield* receipts(f, f.root.id)).toEqual([])
  }),
)

it.live("B10 under Manual a child question waits with human-only:manual-answers, is never answered, resumes on its answer and not on cancellation", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const child = yield* managedChild(f)
    const { question } = yield* f.orchestration.question(child.id, "Need synthetic evidence")
    yield* awaitReceipts(f.root.id, 1)

    const [receipt] = yield* receipts(f, f.root.id)
    expect(receipt.goalDecision).toMatchObject({
      outcome: "waiting",
      reason: "human-only:manual-answers",
      candidate: { kind: "child_question", sessionID: child.id, requestID: question.id },
    })
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)
    expect(yield* receipts(f, f.root.id)).toHaveLength(1)
    expect((yield* f.orchestration.get(f.root.id, child.id)).state).toBe("waiting")

    yield* f.orchestration.answer({ parentID: f.root.id, childID: child.id, questionID: question.id, text: "Evidence" })
    yield* awaitReceipts(f.root.id, 2)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-answers"].toSorted())
    expect(wakes).toEqual([])

    const lapsed = yield* managedChild(f)
    const timedOut = yield* f.orchestration.question(lapsed.id, "Lapsed evidence")
    yield* awaitReceipts(f.root.id, 3)
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: lapsed.id, change: { type: "question_timed_out", questionID: timedOut.question.id } })
    yield* replay(f, SessionEvent.Task.Updated.type)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toHaveLength(1)

    const other = yield* managedChild(f)
    yield* f.orchestration.question(other.id, "Cancelled evidence")
    yield* awaitReceipts(f.root.id, 4)
    yield* f.orchestration.cancel({ parentID: f.root.id, childID: other.id })
    yield* replay(f, SessionEvent.Task.Updated.type)
    yield* f.loop.reconcile(f.root.id)
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toHaveLength(1)
    expect(wakes).toEqual([])
  }),
)

const nativeSource = (rootSessionID: SessionSchema.ID) =>
  ({
    kind: "dots-native",
    profile: "synthetic",
    credentialID: "cred_synthetic",
    accountID: "acct_synthetic",
    accountGeneration: 1,
    environmentID: "env_synthetic",
    connectionID: "conn_synthetic",
    clientID: "client_synthetic",
    streamID: "stream_synthetic",
    rootSessionID,
    accessRevision: 1,
    requestID: "req_synthetic",
  }) as const

const recommendedForm = (sessionID: SessionSchema.ID): Form.CreateInput => ({
  sessionID,
  title: "Choose the synthetic branch",
  fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe (Recommended)" }] }],
})

const nativeFormReply = (f: Fixture, form: Form.Info, fingerprint: string) =>
  f.forms.replyDelegated({
    id: form.id,
    fingerprint,
    source: nativeSource(f.root.id),
    explicitDecision: true,
    validate: () => Effect.succeed(true),
    answer: { branch: "safe" },
  })

const formReplies = () => tap.seen.filter((event) => event.type === Form.Event.Replied.type)

it.live("B11 a native client that settles the Form first leaves the loop with a stale result, no retry and no settled receipt", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const form = yield* f.forms.create(recommendedForm(f.root.id))
    const fingerprint = Form.fingerprint(form)
    yield* awaitReceipts(f.root.id, 1)
    hooks.form = (input, real) => nativeFormReply(f, form, fingerprint).pipe(Effect.orDie, Effect.andThen(real(input)))

    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)

    expect(reconsiderCalls).toHaveLength(1)
    expect(formReplies()).toHaveLength(1)
    expect(formReplies()[0].data).toMatchObject({ source: { kind: "dots-native" } })
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")).toEqual([])
  }),
)

it.live("B11 a Form settled by the loop first rejects a later native reply with the old fingerprint", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const form = yield* f.forms.create(recommendedForm(f.root.id))
    const fingerprint = Form.fingerprint(form)
    yield* awaitReceipts(f.root.id, 1)

    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    yield* awaitReceipts(f.root.id, 2)

    expect((yield* receipts(f, f.root.id)).find((item) => item.goalDecision.outcome === "settled")!.goalDecision).toMatchObject({
      via: "auto-answer",
      candidate: { kind: "form", requestID: form.id, fingerprint },
    })
    expect((yield* nativeFormReply(f, form, fingerprint).pipe(Effect.exit))._tag).toBe("Failure")
    expect(formReplies()).toHaveLength(1)
    expect(formReplies()[0].data).toMatchObject({ source: { kind: "coordinator", coordinatorSessionID: f.root.id, via: "auto-answer" } })
    expect(formReplies()[0].data.source).not.toHaveProperty("groupID")
    expect(reconsiderCalls).toHaveLength(1)
  }),
)

it.live("B11 a concurrent native reply and loop settlement produce exactly one Form settlement", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const form = yield* f.forms.create(recommendedForm(f.root.id))
    const fingerprint = Form.fingerprint(form)
    yield* awaitReceipts(f.root.id, 1)
    const native = yield* Deferred.make<Exit.Exit<void, unknown>>()
    hooks.form = (input, real) =>
      Effect.all([real(input), nativeFormReply(f, form, fingerprint).pipe(Effect.exit, Effect.tap((exit) => Deferred.succeed(native, exit)))], {
        concurrency: "unbounded",
      }).pipe(Effect.map(([result]) => result))

    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    const nativeExit = yield* Deferred.await(native)
    yield* f.loop.inspect(f.root.id)

    const settled = (yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")
    expect(formReplies()).toHaveLength(1)
    expect(settled.length + (Exit.isSuccess(nativeExit) ? 1 : 0)).toBe(1)
    expect(reconsiderCalls).toHaveLength(1)
  }),
)

const deferredItem = (type: string) =>
  Effect.gen(function* () {
    yield* tap.until((seen) => seen.some((entry) => entry.type === type))
    return SessionReview.ID.make(String(tap.seen.find((entry) => entry.type === type)?.data.itemID))
  })

const unauthorized = /approved|proceed|re-?run|re-?issue/i

const deferredAsk = (f: Fixture, kid: Session.Info, kind: "permission" | "guardrail") =>
  Effect.gen(function* () {
    if (kind === "permission") yield* pendingAsk(f, { sessionID: kid.id })
    else yield* f.guardrails.assert({ sessionID: kid.id, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.autonomy.set({ sessionID: f.root.id, sleep: true })
    if (kind === "permission") yield* f.permissions.deferPending(kid.id)
    else yield* f.guardrails.deferPending(kid.id)
    return yield* deferredItem(kind === "permission" ? Permission.Event.Deferred.type : Guardrail.Event.Deferred.type).pipe(
      Effect.andThen(tap.until((seen) => seen.some((entry) => entry.type === SessionEvent.Review.Deferred.type))),
      Effect.andThen(deferredItem(SessionEvent.Review.Deferred.type)),
    )
  })

for (const kind of ["permission", "guardrail"] as const)
  it.live(`D1 approving a deferred ${kind} item while the family sleeps resumes the owner once and replays nothing`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const kid = yield* f.sessions.create({ parentID: f.root.id })
      const itemID = yield* deferredAsk(f, kid, kind)
      const asleep = (yield* f.autonomy.get(f.root.id)).sleep
      expect(asleep).toEqual({})

      yield* f.reviews.decide({ sessionID: kid.id, itemID, decision: { kind, reply: "once" } })
      yield* awaitReceipts(f.root.id, 2)
      yield* awaitWakes(1)
      for (let index = 0; index < 2; index++) {
        yield* replay(f, SessionEvent.Review.Decided.type)
        yield* f.loop.reconcile(f.root.id)
      }

      const items = yield* receipts(f, f.root.id)
      expect(outcomes(items)).toEqual(["resumed:", `waiting:${kind === "permission" ? "human-only:manual-permissions" : "explicit-decision:hard-review"}`].toSorted())
      expect(items.every((item) => !unauthorized.test(item.text))).toBe(true)
      expect(wakes).toEqual([f.root.id])
      expect(reconsiderCalls).toEqual([])
      expect(assessed()).toEqual([])
      expect(tap.seen.filter((entry) => entry.type === SessionEvent.Review.Consumed.type)).toEqual([])
      expect((yield* SessionReviewFold.fold(f.db, [kid.id]))[0]).toMatchObject({ consumed: false, decision: { kind, reply: "once" } })
      expect(yield* f.permissions.list()).toEqual([])
      expect((yield* f.autonomy.get(f.root.id)).sleep).toEqual(asleep)
      expect(interrupts).toEqual([])
    }),
  )

it.live("D2 a typed rejection of a deferred item is a human settlement that resumes under the gates and authorizes nothing", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const itemID = yield* deferredAsk(f, kid, "permission")

    yield* f.reviews.decide({ sessionID: kid.id, itemID, decision: { kind: "permission", reply: "reject" } })
    yield* awaitReceipts(f.root.id, 2)
    yield* awaitWakes(1)
    yield* replay(f, SessionEvent.Review.Decided.type)
    yield* f.loop.inspect(f.root.id)

    const items = yield* receipts(f, f.root.id)
    expect(outcomes(items)).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
    expect(items.every((item) => !unauthorized.test(item.text))).toBe(true)
    expect(wakes).toEqual([f.root.id])
    expect(reconsiderCalls).toEqual([])
    expect(tap.seen.filter((entry) => entry.type === SessionEvent.Review.Consumed.type)).toEqual([])
    expect((yield* SessionReviewFold.fold(f.db, [kid.id]))[0]).toMatchObject({ consumed: false, decision: { kind: "permission", reply: "reject" } })
  }),
)

it.live("D2 dismissing a deferred question never resumes or settles it", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* f.questions.ask({ sessionID: kid.id, ...questionInput("One") }).pipe(Effect.exit, Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.autonomy.set({ sessionID: f.root.id, sleep: true })
    yield* f.questions.deferPending(kid.id)
    const itemID = yield* deferredItem(Question.Event.Deferred.type)

    yield* f.reviews.decide({ sessionID: kid.id, itemID, decision: { kind: "question", dismissed: true } })
    yield* replay(f, SessionEvent.Review.Decided.type)
    yield* f.loop.reconcile(f.root.id)

    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-answers"])
    expect(wakes).toEqual([])
    expect(reconsiderCalls).toEqual([])
  }),
)

it.live("D2 withdrawing a deferred item never resumes the owner", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* deferredAsk(f, kid, "permission")

    yield* f.reviews.withdraw(kid.id, "task_closed")
    yield* tap.until((seen) => seen.some((entry) => entry.type === SessionEvent.Review.Withdrawn.type))
    yield* replay(f, SessionEvent.Review.Withdrawn.type)
    yield* f.loop.reconcile(f.root.id)

    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions"])
    expect(wakes).toEqual([])
  }),
)

it.live("D2 a recovery stop is decided natively only: no settlement, no resume and no wake", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const child = yield* managedChild(f)
    const questionID = QuestionID.make("qst_goal_recovery")
    yield* f.events.publish(SessionEvent.Task.Updated, {
      sessionID: child.id,
      change: { type: "question_asked", question: { id: questionID, text: "Restart recovery", time: 1 } },
    })
    yield* awaitReceipts(f.root.id, 1)
    const item = yield* f.reviews.open({
      sessionID: child.id,
      kind: "recovery",
      reason: "restart",
      origin: { questionID },
      payload: {
        type: "recovery",
        tools: [{ messageID: SessionMessage.ID.make("msg_goal_recovery"), callID: "call_goal_recovery", name: "edit" }],
      },
      limit: 16,
    })

    yield* f.reviews.decide({ sessionID: child.id, itemID: item.itemID, decision: { kind: "recovery", choice: "stop" } })
    yield* replay(f, SessionEvent.Review.Decided.type)
    yield* replay(f, SessionEvent.Task.Updated.type)
    yield* f.loop.reconcile(f.root.id)

    expect((yield* f.orchestration.get(f.root.id, child.id)).state).toBe("lost")
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-answers"])
    expect(wakes).toEqual([])
    expect(reconsiderCalls).toEqual([])
  }),
)

const gateCase = (name: string, prepare: (f: Fixture) => Effect.Effect<void>) =>
  it.live(`B6 gate: ${name} admits the resumed receipt and never wakes the owner`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const kid = yield* f.sessions.create({ parentID: f.root.id })
      const ask = yield* pendingAsk(f, { sessionID: kid.id })
      yield* awaitReceipts(f.root.id, 1)
      yield* prepare(f)

      yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
      yield* awaitReceipts(f.root.id, 2)
      yield* f.loop.inspect(f.root.id)

      expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
      expect(wakes).toEqual([])
    }),
  )

gateCase("another open review item", (f) =>
  SessionReviewFold.open(f.db, f.events, {
    sessionID: f.root.id,
    kind: "question",
    reason: "disabled",
    origin: { requestID: "req_gate_review" },
    payload: { type: "question", questions: [{ header: "Mode", question: "Which?", options: [{ label: "One", description: "First" }] }] },
    limit: 16,
  }).pipe(Effect.orDie, Effect.asVoid),
)

gateCase("an active shell", (f) =>
  Effect.sync(() => {
    fakeShell = {
      list: () =>
        Effect.succeed([
          Schema.decodeUnknownSync(Shell.Info)({
            id: "sh_goal_gate",
            status: "running",
            command: "sleep 1",
            cwd: "/tmp",
            shell: "sh",
            file: "/tmp/sh_goal_gate",
            metadata: { sessionID: f.root.id },
            time: { started: 1 },
          }),
        ]),
    }
  }),
)

gateCase("a revert in progress", (f) =>
  f.db
    .update(SessionTable)
    .set({ revert: { messageID: SessionMessage.ID.make("msg_goal_gate_revert") } })
    .where(eq(SessionTable.id, f.root.id))
    .run()
    .pipe(Effect.orDie, Effect.asVoid),
)

it.live("B6 gate: a managed child owner whose own task is not running admits the resumed receipt and is never woken", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const mid = yield* managedChild(f)
    yield* f.autonomy.setGoal({ sessionID: mid.id, text: goalText })
    yield* f.orchestration.question(mid.id, "Gate evidence")
    expect((yield* f.orchestration.get(f.root.id, mid.id)).state).toBe("waiting")
    const kid = yield* f.sessions.create({ parentID: mid.id })
    const ask = yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(mid.id, 1)

    yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
    yield* awaitReceipts(mid.id, 2)
    yield* f.loop.inspect(mid.id)

    expect(outcomes(yield* receipts(f, mid.id))).toEqual(["resumed:", "waiting:human-only:manual-permissions"].toSorted())
    expect(wakes).toEqual([])
  }),
)

it.live("B4 a goal stopped between capture and the native lock never settles", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    let validations = 0
    hooks.permission = (input, real) =>
      real({
        ...input,
        validate: (request) => (++validations === 2 ? f.autonomy.clearGoal(f.root.id).pipe(Effect.orDie) : Effect.void).pipe(Effect.andThen(input.validate(request))),
      })

    yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(validations).toBeGreaterThanOrEqual(2)
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions"])
  }),
)

it.live("B12 an unrelated autonomy write between capture and the native lock invalidates the held authority", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    let validations = 0
    hooks.permission = (input, real) =>
      real({
        ...input,
        validate: (request) =>
          (validations++ % 2 === 1
            ? f.autonomy.set({ sessionID: kid.id, answers: validations % 4 === 2 ? "yolo" : "manual" }).pipe(Effect.orDie, Effect.asVoid)
            : Effect.void
          ).pipe(Effect.andThen(input.validate(request))),
      })

    yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(validations).toBeGreaterThanOrEqual(2)
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
  }),
)

it.live("B4 a delegation revoked between capture and the native lock never settles", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    let validations = 0
    hooks.permission = (input, real) =>
      real({
        ...input,
        validate: (request) =>
          Effect.sync(() => {
            if (++validations === 2) policy = ConfigCoordination.resolve(new ConfigCoordination.Info({ delegated_decisions: { enabled: false } }))
          }).pipe(Effect.andThen(input.validate(request))),
      })

    yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)

    expect(validations).toBeGreaterThanOrEqual(2)
    expect(yield* f.permissions.list()).toHaveLength(1)
    expect(assessed()).toEqual([])
  }),
)

it.live("B9 under YOLO the existing ask-time answer settles through the scripted evaluator and the loop adds no second answer or helper call", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    decide = (input) => Effect.succeed(graded(input, { One: 0.95 }))
    yield* f.autonomy.set({ sessionID: f.root.id, answers: "yolo" })
    const answered = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("One") })
    expect(answered).toMatchObject({ status: "answered", automatic: true, via: "yolo" })
    expect(decisionCalls).toHaveLength(1)

    yield* f.loop.reconcile(f.root.id)

    expect(decisionCalls).toHaveLength(1)
    expect(yield* f.questions.list()).toEqual([])
    expect(tap.seen.filter((entry) => entry.type === Question.Event.Replied.type)).toEqual([])
    expect(yield* receipts(f, f.root.id)).toEqual([])
    expect(reconsiderCalls).toEqual([])
  }),
)

it.live("a real standard outside-repository review settles through guardrail reconsider under Auto and never writes the path", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const directory = `${os.homedir()}/ycoding-goal-synthetic-${crypto.randomUUID()}`
    const target = `${directory}/notes.txt`
    const waiting = yield* f.guardrails.assert({ sessionID: f.root.id, action: "file_mutation", resources: [target] }).pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    const [request] = yield* f.guardrails.list()
    expect(request).toMatchObject({ standard: true, ruleIDs: ["standard.review.outside-repo"] })
    expect(request.hardReview).not.toBe(true)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-guardrails"])

    yield* f.autonomy.set({ sessionID: f.root.id, guardrails: "auto" })
    yield* (yield* Fiber.join(waiting)).release
    yield* awaitReceipts(f.root.id, 2)

    const settled = (yield* receipts(f, f.root.id)).find((item) => item.goalDecision.outcome === "settled")!
    expect(settled.goalDecision).toMatchObject({ via: "auto-guardrail", candidate: { kind: "guardrail", requestID: request.id } })
    const decided = tap.seen.filter((entry) => entry.type === SessionEvent.GuardrailDecided.type)
    expect(decided).toHaveLength(1)
    expect(decided[0].data).toMatchObject({ actor: "coordinator", coordinatorSessionID: f.root.id, reply: "once", rationale: expect.stringMatching(/\S/) })
    expect(decided[0].data).not.toHaveProperty("groupID")
    expect(yield* f.guardrails.list()).toEqual([])
    expect(yield* Effect.promise(() => Bun.file(target).exists())).toBe(false)
    expect(yield* Effect.promise(() => fs.stat(directory).then(() => true, () => false))).toBe(false)
  }),
)

const wiredLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    KV.node,
    EventRuntime.node,
    Session.node,
    SessionStore.node,
    SessionExecution.node,
    Project.node,
    SessionAutonomy.node,
    SessionOrchestration.node,
    LocationServiceMap.node,
    SessionGoalDecisions.node,
  ]),
  [
    [
      Project.node,
      Layer.mock(Project.Service, {
        resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
        recordOpened: () => Effect.void,
      }),
    ],
    [SessionExecution.node, SessionExecution.noopLayer],
    [
      KeepAwake.node,
      Layer.mock(KeepAwake.Service, {
        hold: () => Effect.succeed({ state: "off" as const }),
        release: () => Effect.succeed({ state: "off" as const }),
        get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
      }),
    ],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("the Decision helper must not be called") })],
    [CoordinationSettings.node, Layer.succeed(CoordinationSettings.Service, { read: () => Effect.succeed(ConfigCoordination.resolve()) })],
  ],
)

testEffect(wiredLayer).live("the production layer consumes events and autonomy changes and settles one routine ask end to end", () =>
  Effect.gen(function* () {
    yield* reset
    tap = yield* makeTap
    yield* SessionGoalDecisions.Service
    const root = yield* (yield* Session.Service).create({ location: yield* reviewLocation })
    const located = (yield* LocationServiceMap.Service).get(root.location, [LocationServiceMap.full])
    const permissions = yield* Permission.Service.pipe(Effect.provide(located))
    const agent = Agent.ID.make("goal-wired")
    yield* (yield* Agent.Service.pipe(Effect.provide(located))).transform((draft) =>
      draft.update(agent, (entry) => {
        entry.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.setGoal({ sessionID: root.id, text: goalText })
    const asked = yield* permissions.ask({ sessionID: root.id, agent, action: "read", resources: ["src/wired.ts"] })
    yield* awaitReceipts(root.id, 1)

    yield* autonomy.set({ sessionID: root.id, permissions: "auto" })
    yield* awaitReceipts(root.id, 2)

    expect(assessed()).toHaveLength(1)
    expect(assessed()[0].data).toMatchObject({ requestID: asked.id, outcome: "allow", via: "auto-permission", coordinatorSessionID: root.id })
    expect(assessed()[0].data).not.toHaveProperty("groupID")
    expect(yield* permissions.list()).toEqual([])
  }),
)

it.live(
  "B13 an old waiting receipt still resumes the owner after more than 200 newer goal receipts",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const original = yield* f.sessions.create({ parentID: f.root.id })
      const target = yield* pendingAsk(f, { sessionID: original.id, resources: ["src/original.ts"] })
      yield* awaitReceipts(f.root.id, 1)
      yield* f.stop

      for (let index = 0; index < 5; index++) {
        const kid = yield* f.sessions.create({ parentID: f.root.id })
        for (let ask = 0; ask < 45; ask++) yield* pendingAsk(f, { sessionID: kid.id, resources: [`src/other-${index}-${ask}.ts`] })
      }
      const restarted = yield* startLoop
      yield* restarted.loop.reconcile(f.root.id)
      expect(yield* receipts(f, f.root.id)).toHaveLength(226)

      yield* f.permissions.reply({ requestID: target.id, reply: "once" })
      yield* awaitReceipts(f.root.id, 227)
      yield* awaitWakes(1)
      yield* f.loop.inspect(f.root.id)

      const resumed = (yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")
      expect(resumed.map((item) => item.goalDecision.candidate.requestID)).toEqual([target.id])
      expect(wakes).toEqual([f.root.id])
      yield* restarted.stop
    }),
  60000,
)

const goalReceiptRows = (f: Pick<Fixture, "db">) =>
  f.db
    .all<{ id: string }>(sql`SELECT id FROM session_message WHERE id LIKE 'msg_goaldec_%'`)
    .pipe(Effect.orDie)

const pruneCompactedHistory = (f: Pick<Fixture, "db">, sessionID: SessionSchema.ID) =>
  f.db
    .run(
      sql`DELETE FROM session_message
        WHERE session_id = ${sessionID} AND seq < (SELECT max(seq) + 1 FROM session_message WHERE session_id = ${sessionID}) AND type <> 'compaction'
          AND id IS NOT (SELECT id FROM session_message WHERE session_id = ${sessionID} AND type = 'user' ORDER BY seq LIMIT 1)
          AND id NOT IN (SELECT fork_message_id FROM session WHERE fork_session_id = ${sessionID} AND fork_message_id IS NOT NULL)`,
    )
    .pipe(Effect.orDie)

it.live(
  "B14 a waiting receipt promoted into history and pruned still resumes the owner exactly once",
  () =>
    Effect.gen(function* () {
      const f = yield* setup()
      const kid = yield* f.sessions.create({ parentID: f.root.id })
      const ask = yield* pendingAsk(f, { sessionID: kid.id })
      yield* awaitReceipts(f.root.id, 1)
      expect(yield* SessionPending.promoteSteers(f.db, f.events, f.root.id)).toBe(1)
      expect(yield* receipts(f, f.root.id)).toEqual([])
      expect(yield* goalReceiptRows(f)).toHaveLength(1)

      yield* pruneCompactedHistory(f, f.root.id)
      expect(yield* goalReceiptRows(f)).toHaveLength(0)

      yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
      yield* awaitReceipts(f.root.id, 2)
      yield* awaitWakes(1)
      for (let index = 0; index < 2; index++) yield* replay(f, Permission.Event.Replied.type)
      yield* f.loop.inspect(f.root.id)

      expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["resumed:"])
      expect(wakes).toEqual([f.root.id])
    }),
  15000,
)

it.live("B14 a waiting receipt removed by a committed revert never resumes the owner", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const ask = yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    expect(yield* SessionPending.promoteSteers(f.db, f.events, f.root.id)).toBe(1)
    const [receipt] = yield* goalReceiptRows(f)
    yield* f.events.publish(SessionEvent.RevertEvent.Committed, { sessionID: f.root.id, to: SessionMessage.ID.make(receipt.id) })
    expect(yield* goalReceiptRows(f)).toHaveLength(0)

    yield* f.permissions.reply({ requestID: ask.id, reply: "once" })
    yield* replay(f, Permission.Event.Replied.type)
    yield* f.loop.inspect(f.root.id)

    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toEqual([])
    expect(wakes).toEqual([])
  }),
)

it.live("R1 an agent switch that auto-rejects a waiting request never resumes the owner", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const ask = yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)

    yield* f.events.publish(SessionEvent.AgentSelected, { sessionID: kid.id, agent: Agent.ID.make("goal-loop-switched") })
    yield* tap.until((seen) => seen.some((entry) => entry.type === Permission.Event.Replied.type))
    expect(tap.seen.find((entry) => entry.type === Permission.Event.Replied.type)?.data).toMatchObject({ requestID: ask.id, reply: "reject" })
    yield* replay(f, Permission.Event.Replied.type)
    yield* f.loop.inspect(f.root.id)

    expect(yield* f.permissions.list()).toEqual([])
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions"])
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled" || item.goalDecision.outcome === "resumed")).toEqual([])
    expect(reconsiderCalls).toEqual([])
    expect(wakes).toEqual([])
  }),
)

it.live("R2 a failed reconsider records a waiting receipt so a goal stop and resume never retries the same key", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    hooks.permission = () => Effect.die("synthetic failure")

    yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)
    yield* f.autonomy.clearGoal(f.root.id)
    yield* f.loop.inspect(f.root.id)
    yield* f.autonomy.set({ sessionID: f.root.id, goal: true })
    yield* f.loop.inspect(f.root.id)

    expect(reconsiderCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions", "waiting:reconsider-failed"])
    expect(yield* f.permissions.list()).toHaveLength(1)
  }),
)

it.live("R2 a failed reconsider is not retried after the candidate is absent from one pass and present again with the same key", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    yield* pendingAsk(f, { sessionID: kid.id })
    yield* awaitReceipts(f.root.id, 1)
    hooks.permission = () => Effect.die("synthetic failure")

    yield* f.autonomy.set({ sessionID: kid.id, permissions: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)
    missingLocation = true
    yield* f.loop.inspect(f.root.id)
    missingLocation = false
    yield* f.loop.inspect(f.root.id)

    expect(reconsiderCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-permissions", "waiting:reconsider-failed"])
    expect(yield* f.permissions.list()).toHaveLength(1)
  }),
)

it.live("G1 a cancelled or timed-out Form never resumes the owner", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const kid = yield* f.sessions.create({ parentID: f.root.id })
    const cancelled = yield* f.forms.create({ ...recommendedForm(kid.id), title: "Cancelled synthetic form" })
    const lapsed = yield* f.forms.create({ ...recommendedForm(kid.id), title: "Lapsed synthetic form" })
    yield* awaitReceipts(f.root.id, 2)

    yield* f.forms.cancel(cancelled.id)
    yield* f.events.publish(Form.Event.TimedOut, { id: lapsed.id, sessionID: kid.id })
    expect(tap.seen.filter((entry) => entry.type === Form.Event.Cancelled.type || entry.type === Form.Event.TimedOut.type)).toHaveLength(2)
    yield* replay(f, Form.Event.Cancelled.type)
    yield* replay(f, Form.Event.TimedOut.type)
    yield* f.loop.inspect(f.root.id)

    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "resumed")).toEqual([])
    expect(wakes).toEqual([])
  }),
)

const scripted = (value: string, confidence: number) => (input: Decision.Input) =>
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
          ...(item.type === "choice" && item.grade === true
            ? { grades: item.choices.map((option) => ({ choice: option.value, confidence: option.value === value ? confidence : 0.1, evidence: "Fixture support." })) }
            : {}),
        })),
      },
    }),
  )

const heldDecision = (value: string, confidence: number) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    decide = (input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(scripted(value, confidence)(input)))
    return { entered, release }
  })

const answeredEvents = () =>
  tap.seen.filter(
    (entry) =>
      entry.type === SessionEvent.Task.Updated.type &&
      typeof entry.data.change === "object" &&
      entry.data.change !== null &&
      "type" in entry.data.change &&
      entry.data.change.type === "question_answered",
  )

const answerInputs = (f: Pick<Fixture, "db">, childID: SessionSchema.ID) =>
  SessionPending.list(f.db, childID).pipe(
    Effect.map((items) => items.flatMap((item) => (item.type === "synthetic" && item.data.text.startsWith("Parent answer") ? [item] : []))),
  )

const approach = { options: ["Safe (Recommended)", "Fast"] }

const waitingChild = (f: Fixture, data: Schema.Json = approach) =>
  Effect.gen(function* () {
    const child = yield* managedChild(f)
    const { question } = yield* f.orchestration.question(child.id, "Pick an approach", data)
    const snapshot = (yield* f.orchestration.questionSnapshots(f.root.id)).find((item) => item.task.sessionID === child.id)
    return { child, question, fingerprint: snapshot!.fingerprint }
  })

const reconsiderChild = (
  f: Fixture,
  waiting: Effect.Success<ReturnType<typeof waitingChild>>,
  overrides: Partial<ChildReconsiderInput> = {},
) =>
  f.orchestration.reconsiderQuestion({
    parentID: f.root.id,
    childID: waiting.child.id,
    questionID: waiting.question.id,
    fingerprint: waiting.fingerprint,
    actor: "coordinator",
    source: { coordinatorSessionID: f.root.id, rationale: "Synthetic routine answer." },
    validate: () => Effect.succeed(true),
    ...overrides,
  })

it.live("CQ1 manual answers mode leaves a waiting child question untouched without a helper call", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const waiting = yield* waitingChild(f)

    expect(yield* reconsiderChild(f, waiting)).toMatchObject({ outcome: "escalated", settled: false, reason: "explicit-decision:manual-answers" })
    expect((yield* f.orchestration.get(f.root.id, waiting.child.id)).state).toBe("waiting")
    expect(decisionCalls).toHaveLength(0)
    expect(answeredEvents()).toEqual([])
    expect(childWakes).toEqual([])
  }),
)

it.live("CQ2 a switch to Auto settles a waiting child question once through the waiting-task answer primitive and wakes the child", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const waiting = yield* waitingChild(f)
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "auto" })

    expect(yield* reconsiderChild(f, waiting)).toMatchObject({ outcome: "allowed", settled: true, via: "auto-answer" })
    expect((yield* f.orchestration.get(f.root.id, waiting.child.id)).state).toBe("running")
    expect(answeredEvents()).toHaveLength(1)
    const inputs = yield* answerInputs(f, waiting.child.id)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      data: {
        text: expect.stringContaining("Safe (Recommended)"),
        description: "Autonomous subagent answer",
        metadata: { source: "subagent_parent", kind: "answer", questionID: waiting.question.id, automatic: true, via: "auto-answer" },
      },
    })
    expect(childWakes).toEqual([waiting.child.id])
    expect(decisionCalls).toHaveLength(0)
  }),
)

it.live("CQ3 a switch to YOLO settles a waiting child question through the scripted evaluator", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const waiting = yield* waitingChild(f, { options: ["Safe", "Fast"] })
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "yolo" })
    decide = scripted("Fast", 0.9)

    expect(yield* reconsiderChild(f, waiting)).toMatchObject({ outcome: "allowed", settled: true, via: "yolo", confidence: 0.9 })
    expect(answeredEvents()).toHaveLength(1)
    expect((yield* answerInputs(f, waiting.child.id))[0]).toMatchObject({ data: { metadata: { automatic: true, via: "yolo", confidence: 0.9 } } })
    expect(decisionCalls).toHaveLength(1)
  }),
)

it.live("CQ4 a concurrent parent answer wins exactly once and the evaluation-time reconsider is stale", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const waiting = yield* waitingChild(f, { options: ["Safe", "Fast"] })
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "yolo" })
    const held = yield* heldDecision("Fast", 0.9)
    const running = yield* reconsiderChild(f, waiting).pipe(Effect.forkScoped)
    yield* Deferred.await(held.entered)

    yield* f.orchestration.answer({ parentID: f.root.id, childID: waiting.child.id, questionID: waiting.question.id, text: "Safe" })
    yield* Deferred.succeed(held.release, undefined)

    expect(yield* Fiber.join(running)).toMatchObject({ outcome: "stale", settled: false })
    expect(answeredEvents()).toHaveLength(1)
    const inputs = yield* answerInputs(f, waiting.child.id)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ data: { description: "Parent subagent answer" } })
  }),
)

it.live("CQ5 a cancelled child, a deferred question or a wrong fingerprint is never settled", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const cancelled = yield* waitingChild(f)
    yield* f.autonomy.set({ sessionID: cancelled.child.id, answers: "auto" })
    expect(yield* reconsiderChild(f, cancelled, { fingerprint: "0".repeat(64) })).toMatchObject({ outcome: "stale", settled: false })
    yield* f.orchestration.cancel({ parentID: f.root.id, childID: cancelled.child.id })
    expect(yield* reconsiderChild(f, cancelled)).toMatchObject({ outcome: "stale", settled: false })

    const slept = yield* f.sessions.create({ parentID: f.root.id, model })
    yield* f.events.publish(SessionEvent.Task.Updated, {
      sessionID: slept.id,
      change: {
        type: "launched",
        parentID: f.root.id,
        parentAssistantMessageID: SessionMessage.ID.create(),
        toolCallID: `call_${slept.id}`,
        inputID: SessionMessage.ID.create(),
        description: "Synthetic sleeping child",
        agent: Agent.ID.make("build"),
        model,
        promptDigest: "digest",
        background: true,
        delivery: "steer",
      },
    })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: slept.id, change: { type: "started" } })
    yield* f.autonomy.set({ sessionID: f.root.id, sleep: true })
    const { question } = yield* f.orchestration.question(slept.id, "Deferred approach", approach)
    expect((yield* f.orchestration.get(f.root.id, slept.id)).question?.deferred).toBe(true)
    yield* f.autonomy.set({ sessionID: slept.id, answers: "auto" })
    expect(
      yield* f.orchestration.reconsiderQuestion({
        parentID: f.root.id,
        childID: slept.id,
        questionID: question.id,
        fingerprint: "0".repeat(64),
        actor: "coordinator",
        source: { coordinatorSessionID: f.root.id, rationale: "Synthetic routine answer." },
        validate: () => Effect.succeed(true),
      }),
    ).toMatchObject({ outcome: "stale", settled: false })
    expect(answeredEvents()).toEqual([])
  }),
)

it.live("CQ6 a mode reverted or a delegation revoked between capture and the lock never settles a child question", () =>
  Effect.gen(function* () {
    const f = yield* setup({ goal: false })
    const waiting = yield* waitingChild(f, { options: ["Safe", "Fast"] })
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "yolo" })
    const held = yield* heldDecision("Fast", 0.9)
    const running = yield* reconsiderChild(f, waiting).pipe(Effect.forkScoped)
    yield* Deferred.await(held.entered)
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "manual" })
    yield* Deferred.succeed(held.release, undefined)

    expect(yield* Fiber.join(running)).toMatchObject({ outcome: "escalated", settled: false, reason: "stale-assessment" })
    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "yolo" })
    decide = scripted("Fast", 0.9)
    let validations = 0
    expect(yield* reconsiderChild(f, waiting, { validate: () => Effect.sync(() => ++validations === 1) })).toMatchObject({
      outcome: "escalated",
      settled: false,
      reason: "stale-assessment",
    })
    expect((yield* f.orchestration.get(f.root.id, waiting.child.id)).state).toBe("waiting")
    expect(answeredEvents()).toEqual([])
  }),
)

it.live("CQ7 an explicit-decision wording only in a child question option stays unsettled under Auto", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const waiting = yield* waitingChild(f, { options: ["Purchase the paid plan (Recommended)", "Hold"] })
    yield* awaitReceipts(f.root.id, 1)

    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "auto" })
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)

    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:explicit-decision:purchase-spend"])
    expect(reconsiderCalls).toEqual([])
    expect(answeredEvents()).toEqual([])
    expect((yield* f.orchestration.get(f.root.id, waiting.child.id)).state).toBe("waiting")
    expect(childWakes).toEqual([])
  }),
)

it.live("Q1 a mode change alone settles one pending Question-service request through the loop with provenance", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    running.add(f.root.id)
    const waiting = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("One (Recommended)") }).pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    const [request] = yield* f.questions.list()
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-answers"])

    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    yield* awaitReceipts(f.root.id, 3)
    for (let index = 0; index < 2; index++) {
      yield* replay(f, Question.Event.Asked.type)
      yield* f.loop.reconcile(f.root.id)
    }

    const settled = (yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")
    expect(settled).toHaveLength(1)
    expect(settled[0].goalDecision).toMatchObject({
      outcome: "settled",
      via: "auto-answer",
      reason: "allowed",
      rationale: expect.stringMatching(/\S/),
      requirement: { goalDigest: Hash.sha256(goalText), iteration: 0, revision: expect.any(Number) },
      candidate: { kind: "question", sessionID: f.root.id, requestID: request.id, fingerprint: Question.fingerprint(request) },
    })
    expect(yield* Fiber.join(waiting)).toMatchObject({ status: "answered", automatic: true, via: "auto-answer", source: { kind: "coordinator", coordinatorSessionID: f.root.id } })
    expect(tap.seen.filter((entry) => entry.type === Question.Event.Replied.type)).toHaveLength(1)
    expect(reconsiderCalls).toEqual([`question:${request.id}`])
    expect(decisionCalls).toHaveLength(0)
  }),
)

it.live("Q2 a mode change alone settles one waiting child question through the loop with provenance", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const waiting = yield* waitingChild(f)
    yield* awaitReceipts(f.root.id, 1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:human-only:manual-answers"])

    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "auto" })
    yield* awaitReceipts(f.root.id, 3)
    for (let index = 0; index < 2; index++) {
      yield* replay(f, SessionEvent.Task.Updated.type)
      yield* f.loop.reconcile(f.root.id)
    }

    const settled = (yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")
    expect(settled).toHaveLength(1)
    expect(settled[0].goalDecision).toMatchObject({
      via: "auto-answer",
      requirement: { goalDigest: Hash.sha256(goalText), iteration: 0, revision: expect.any(Number) },
      candidate: { kind: "child_question", sessionID: waiting.child.id, requestID: waiting.question.id, fingerprint: waiting.fingerprint },
    })
    expect(answeredEvents()).toHaveLength(1)
    expect(yield* answerInputs(f, waiting.child.id)).toHaveLength(1)
    expect(reconsiderCalls).toEqual([`child_question:${waiting.question.id}`])
    expect(childWakes).toEqual([waiting.child.id])
  }),
)

for (const delegated of [false, true])
  it.live(`Q3 an external ${delegated ? "replyDelegated" : "reply"} between the mode change and the reconsider settles once and the loop sees stale without retry`, () =>
    Effect.gen(function* () {
      const f = yield* setup()
      running.add(f.root.id)
      const asking = yield* f.questions.ask({ sessionID: f.root.id, ...questionInput("One (Recommended)") }).pipe(Effect.forkScoped)
      yield* awaitReceipts(f.root.id, 1)
      const [request] = yield* f.questions.list()
      hooks.question = (input, real) =>
        (delegated
          ? f.questions.replyDelegated({
              requestID: input.requestID,
              fingerprint: Question.fingerprint(request),
              source: {
                kind: "dots-client",
                anchorSessionID: f.root.id,
                bindingID: "binding",
                delegationID: "grant",
                revision: 2,
                exchangeID: "decision",
                principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "oauth-grant", epoch: "epoch" },
              },
              validate: () => Effect.succeed(true),
              answers: [["One (Recommended)"]],
            })
          : f.questions.reply({ requestID: input.requestID, answers: [["One (Recommended)"]] })
        ).pipe(Effect.orDie, Effect.andThen(real(input)))

      yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
      yield* reconsidered(1)
      yield* f.loop.inspect(f.root.id)
      yield* f.loop.inspect(f.root.id)

      expect(tap.seen.filter((entry) => entry.type === Question.Event.Replied.type)).toHaveLength(1)
      expect(yield* Fiber.join(asking)).not.toHaveProperty("automatic")
      expect(reconsiderCalls).toEqual([`question:${request.id}`])
      expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")).toEqual([])
    }),
  )

it.live("Q3 an external parent answer between the mode change and the reconsider settles once and the loop sees stale without retry", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    const waiting = yield* waitingChild(f)
    yield* awaitReceipts(f.root.id, 1)
    hooks.child = (input, real) =>
      f.orchestration
        .answer({ parentID: input.parentID, childID: input.childID, questionID: input.questionID, text: "Fast" })
        .pipe(Effect.orDie, Effect.andThen(real(input)))

    yield* f.autonomy.set({ sessionID: waiting.child.id, answers: "auto" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)
    yield* f.loop.inspect(f.root.id)

    expect(answeredEvents()).toHaveLength(1)
    expect(reconsiderCalls).toEqual([`child_question:${waiting.question.id}`])
    expect((yield* receipts(f, f.root.id)).filter((item) => item.goalDecision.outcome === "settled")).toEqual([])
    expect((yield* answerInputs(f, waiting.child.id))[0]).toMatchObject({ data: { description: "Parent subagent answer" } })
  }),
)

it.live("Q4 an explicit human-only question text is never settled by the loop under Auto", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.autonomy.set({ sessionID: f.root.id, answers: "auto" })
    yield* f.questions
      .ask({ sessionID: f.root.id, questions: [{ header: "Plan", question: "Approve the purchase of the paid plan?", options: [{ label: "Yes", description: "Buy" }], custom: false }] })
      .pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    yield* f.loop.inspect(f.root.id)

    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:explicit-decision:purchase-spend"])
    expect(yield* f.questions.list()).toHaveLength(1)
    expect(reconsiderCalls).toEqual([])
  }),
)

it.live("Q5 a Question-service request already assessed under YOLO is not run again under an unchanged key and runs once after the key changes", () =>
  Effect.gen(function* () {
    const f = yield* setup()
    yield* f.autonomy.set({ sessionID: f.root.id, answers: "yolo" })
    decide = scripted("Yes", 0.5)
    yield* f.questions
      .ask({ sessionID: f.root.id, questions: [{ header: "Mode", question: "Which?", options: [{ label: "Yes", description: "First" }, { label: "No", description: "Second" }] }] })
      .pipe(Effect.forkScoped)
    yield* awaitReceipts(f.root.id, 1)
    expect(decisionCalls).toHaveLength(1)
    expect(outcomes(yield* receipts(f, f.root.id))).toEqual(["waiting:yolo-assessed"])
    yield* f.loop.inspect(f.root.id)
    expect(decisionCalls).toHaveLength(1)
    expect(reconsiderCalls).toEqual([])

    yield* f.autonomy.set({ sessionID: f.root.id, permissions: "yolo" })
    yield* reconsidered(1)
    yield* f.loop.inspect(f.root.id)
    expect(reconsiderCalls).toHaveLength(1)
    expect(decisionCalls).toHaveLength(2)
    expect(yield* f.questions.list()).toHaveLength(1)
  }),
)
