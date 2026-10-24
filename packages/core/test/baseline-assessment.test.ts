import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAssessment } from "@ycoding-ai/core/session/assessment"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_baseline")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

type Scores = Record<string, number>

const graded = (request: Decision.Input, scores: Scores) =>
  Schema.decodeUnknownSync(Decision.Output)({
    provider: "agent",
    response: {
      model: { providerID: "test", id: "decision-model" },
      semantics: "model-estimate",
      version: 1,
      answers: request.request.questions.map((question) =>
        question.type === "choice"
          ? {
              name: question.name,
              type: "choice",
              answer: null,
              choice: null,
              score: null,
              confidence: 0,
              grades: question.choices.map((choice) => ({
                choice: choice.value,
                confidence: scores[String(choice.value)] ?? 0,
                evidence: "Bounded assessment evidence",
              })),
            }
          : { name: question.name, type: "refusal", answer: null, choice: null, score: null, confidence: 0 },
      ),
    },
  })

interface Behavior {
  readonly config?: boolean
  readonly decide: (request: Decision.Input, context: Decision.Invocation) => Effect.Effect<Decision.Output, Decision.Error>
}

function harness(input: Behavior) {
  const calls: Array<{ readonly request: Decision.Input; readonly context: Decision.Invocation }> = []
  const settings = input.config === undefined ? {} : { guardrails: { decide_reviews: input.config } }
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        EventRuntime.node,
        SessionStore.node,
        SessionAutonomy.node,
        PermissionSaved.node,
        Agent.node,
        Permission.node,
      ]),
      [
        [Location.node, current],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (request: Decision.Input, context: Decision.Invocation) => {
              calls.push({ request, context })
              return input.decide(request, context)
            },
          }),
        ],
        [
          Config.node,
          Layer.mock(Config.Service, {
            entries: () =>
              Effect.succeed([new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)(settings) })]),
          }),
        ],
      ],
    ),
  )
  return { it, calls }
}

const setup = (rules: Permission.Ruleset = []) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "baseline", agent: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

const request = (input: Partial<Permission.AssertInput> = {}) =>
  ({ sessionID, action: "read", resources: ["README.md"], ...input }) satisfies Permission.AssertInput

const facts = (type: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    return (yield* events.log({ aggregateID: sessionID, follow: false }).pipe(Stream.runCollect))
      .flatMap((event) => event.type === type && "data" in event ? [event.data as Record<string, unknown>] : [])
  })

const humanRequest = Effect.gen(function* () {
  const service = yield* Permission.Service
  const pending = yield* service.forSession(sessionID)
  expect(pending).toHaveLength(1)
  return pending[0]!
})

const waitForPending = Effect.gen(function* () {
  const service = yield* Permission.Service
  for (let attempt = 0; attempt < 50 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
  return yield* humanRequest
})

const setPermissions = (permissions: "manual" | "yolo" | "auto") =>
  Effect.gen(function* () {
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions })
  })

describe("Manual permissions are human-only", () => {
  for (const config of [undefined, true, false] as const) {
    const run = harness({ config, decide: () => Effect.die("Manual permissions must not reach the helper") })
    run.it.effect(`decide_reviews ${String(config)} still asks the human without a helper call or assessment fact`, () =>
      Effect.gen(function* () {
        yield* setup()
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
        const pending = yield* waitForPending
        expect(pending).not.toHaveProperty("escalation")
        yield* service.reply({ requestID: pending.id, reply: "once" })
        yield* Fiber.join(fiber)
        expect(run.calls).toEqual([])
        expect(yield* facts("session.permission.assessed")).toEqual([])
      }),
    )
  }

  const sleeping = harness({ decide: () => Effect.die("Manual permissions must not reach the helper") })
  sleeping.it.effect("a sleeping family defers a Manual ask to the review box as disabled", () =>
    Effect.gen(function* () {
      yield* setup()
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, sleep: true })
      const service = yield* Permission.Service
      const exit = yield* service.assert(request()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      const items = yield* SessionReviewFold.fold((yield* Database.Service).db, [sessionID])
      expect(items).toEqual([expect.objectContaining({ kind: "permission", reason: "disabled" })])
      expect(sleeping.calls).toEqual([])
    }),
  )

  const allowed = harness({ decide: () => Effect.die("Rule-allowed operations never reach the helper") })
  allowed.it.effect("an operation the rules allow still runs in Manual without a human", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* Permission.Service
      yield* service.assert(request())
      expect(yield* service.list()).toEqual([])
      expect(allowed.calls).toEqual([])
    }),
  )
})

describe("Auto permissions apply only the deterministic rule", () => {
  const flag = harness({ decide: () => Effect.die("Auto permissions never consult the helper") })
  flag.it.effect("Auto allows an ask once without a helper call", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("auto")
      const service = yield* Permission.Service
      yield* service.assert(request())
      expect(flag.calls).toEqual([])
      expect(yield* facts("session.permission.assessed")).toEqual([
        expect.objectContaining({ outcome: "allow", via: "auto-permission", reply: "once" }),
      ])
    }),
  )

  for (const config of [undefined, true] as const) {
    const human = harness({ config, decide: () => Effect.die("Auto permissions never fall back to a model") })
    human.it.effect(`a human-only ask under Auto with decide_reviews ${String(config)} asks the human without a helper call`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setPermissions("auto")
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request({ requireHuman: true })).pipe(Effect.forkScoped)
        const pending = yield* waitForPending
        expect(pending).not.toHaveProperty("escalation")
        yield* service.reply({ requestID: pending.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(human.calls).toEqual([])
        expect(yield* facts("session.permission.assessed")).toEqual([])
      }),
    )
  }
})

describe("deny rules and permission ceilings block in every mode", () => {
  for (const mode of ["manual", "yolo", "auto"] as const) {
    const denied = harness({ decide: () => Effect.die("Explicit denies never reach the helper") })
    denied.it.effect(`an agent deny blocks ${mode} before any helper call`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "read", resource: "*", effect: "deny" }])
        yield* setPermissions(mode)
        const service = yield* Permission.Service
        expect(yield* service.assert(request()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
        expect(denied.calls).toEqual([])
      }),
    )
    const ceiling = harness({ decide: () => Effect.die("Ceiling denies never reach the helper") })
    ceiling.it.effect(`a Session permission ceiling blocks ${mode} before any helper call`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "read", resource: "*", effect: "allow" }])
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ permission: [{ action: "read", resource: "*", effect: "deny" }] })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* setPermissions(mode)
        const service = yield* Permission.Service
        expect(yield* service.assert(request()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
        expect(ceiling.calls).toEqual([])
      }),
    )
  }
})

describe("YOLO permissions use only the hidden permission evaluator", () => {
  for (const config of [undefined, true, false] as const) {
    const run = harness({ config, decide: (input) => Effect.succeed(graded(input, { allow: 0.9 })) })
    run.it.effect(`decide_reviews ${String(config)} makes exactly one YOLO-authority call and approves once`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setPermissions("yolo")
        const service = yield* Permission.Service
        yield* service.assert(request())
        expect(yield* service.list()).toEqual([])
        expect(run.calls).toHaveLength(1)
        expect(run.calls[0]!.context).toMatchObject({ sessionID, purpose: "permission", authority: "yolo" })
        const question = run.calls[0]!.request.request.questions[0]!
        if (question.type !== "choice") throw new Error("Expected a graded choice")
        expect(question.grade).toBe(true)
        expect(question.choices.map((choice) => choice.value)).toEqual(["allow", "deny", "escalate"])
        expect(yield* facts("session.permission.assessed")).toEqual([
          expect.objectContaining({
            outcome: "allow",
            via: "yolo",
            reply: "once",
            authority: "yolo",
            choice: "allow",
            confidence: 0.9,
            grades: expect.any(Array),
          }),
        ])
      }),
    )
  }

  const fixtures: ReadonlyArray<{
    readonly name: string
    readonly input: Partial<Permission.AssertInput>
    readonly scores: Scores
    readonly expected: "allow" | "deny" | "human"
    readonly reason?: Guardrail.EscalationReason
  }> = [
    { name: "read-only file read", input: { action: "read", resources: ["README.md"] }, scores: { allow: 0.95 }, expected: "allow" },
    { name: "version probe", input: { action: "bash", resources: ["git --version"] }, scores: { allow: 0.9 }, expected: "allow" },
    { name: "recursive home deletion", input: { action: "bash", resources: ["rm -rf ~/Documents"] }, scores: { deny: 0.92 }, expected: "deny" },
    { name: "credential read", input: { action: "read", resources: ["~/.ssh/synthetic_key"] }, scores: { escalate: 1 }, expected: "human", reason: "escalated" },
    { name: "outbound upload", input: { action: "webfetch", resources: ["https://synthetic.invalid/upload"] }, scores: { allow: 0.79 }, expected: "human", reason: "low_confidence" },
    { name: "ambiguous target", input: { action: "bash", resources: ["task-runner deploy"] }, scores: { allow: 0.9, deny: 0.85 }, expected: "human", reason: "conflicting_grades" },
  ]
  for (const fixture of fixtures) {
    const run = harness({ decide: (input) => Effect.succeed(graded(input, fixture.scores)) })
    run.it.effect(`fixture ${fixture.name} settles as ${fixture.expected}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setPermissions("yolo")
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request(fixture.input)).pipe(Effect.forkScoped)
        if (fixture.expected === "allow") {
          yield* Fiber.join(fiber)
          expect(yield* service.list()).toEqual([])
          return
        }
        if (fixture.expected === "deny") {
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("Permission.CorrectedError")
          expect(yield* service.list()).toEqual([])
          expect(yield* facts("session.permission.assessed")).toEqual([
            expect.objectContaining({ outcome: "deny", via: "yolo", reply: "reject", authority: "yolo" }),
          ])
          return
        }
        const pending = yield* waitForPending
        expect(pending.escalation).toMatchObject({ authority: "yolo", reason: fixture.reason, grades: expect.any(Array) })
        expect(yield* facts("session.permission.assessed")).toEqual([
          expect.objectContaining({ outcome: "escalate", via: "yolo", authority: "yolo", reason: fixture.reason }),
        ])
        yield* service.reply({ requestID: pending.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      }),
    )
  }

  const reasons = [
    "unavailable",
    "invalid-request",
    "provider-failed",
    "timeout",
    "input-too-large",
    "invalid-output",
    "refused",
    "truncated-output",
    "unsupported-output",
  ] as const
  for (const reason of reasons) for (const asleep of [false, true]) {
    const run = harness({ decide: () => Effect.fail(new Decision.Error({ reason })) })
    run.it.effect(`a ${reason} evaluator failure ${asleep ? "defers to the review box" : "asks the human with the typed reason"}`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setPermissions("yolo")
        const autonomy = yield* SessionAutonomy.Service
        if (asleep) yield* autonomy.set({ sessionID, sleep: true })
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
        if (asleep) {
          expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
          const items = yield* SessionReviewFold.fold((yield* Database.Service).db, [sessionID])
          expect(items).toEqual([expect.objectContaining({ kind: "permission", reason })])
          expect(items[0]).not.toHaveProperty("grades")
          expect(yield* facts("session.permission.assessed")).toEqual([])
          return
        }
        const pending = yield* waitForPending
        expect(pending.escalation).toEqual({ authority: "yolo", reason })
        expect(Guardrail.escalationText(pending.escalation!)).toContain("Review this request manually")
        yield* service.reply({ requestID: pending.id, reply: "once" })
        yield* Fiber.join(fiber)
      }),
    )
  }

  const asleepAllow = harness({ decide: (input) => Effect.succeed(graded(input, { allow: 0.85 })) })
  asleepAllow.it.effect("a confident allow applies while the family sleeps and records no review item", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, sleep: true })
      const service = yield* Permission.Service
      yield* service.assert(request())
      expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [sessionID])).toEqual([])
    }),
  )

  const humanOnly = harness({ decide: () => Effect.die("A human-only ask never reaches the evaluator") })
  humanOnly.it.effect("a human-only ask under YOLO asks the human without a helper call", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request({ requireHuman: true })).pipe(Effect.forkScoped)
      const pending = yield* waitForPending
      yield* service.reply({ requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(humanOnly.calls).toEqual([])
    }),
  )

  const interrupted = harness({
    decide: () => Effect.never,
  })
  interrupted.it.effect("interrupting an assessment leaves no pending request or assessment fact", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 50 && interrupted.calls.length === 0; attempt++) yield* Effect.yieldNow
      expect(interrupted.calls).toHaveLength(1)
      yield* Fiber.interrupt(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* facts("session.permission.assessed")).toEqual([])
    }),
  )

  const flipped = Deferred.makeUnsafe<void>()
  const stale = harness({
    decide: (input) => Deferred.await(flipped).pipe(Effect.as(graded(input, { allow: 0.95 }))),
  })
  stale.it.effect("a YOLO approval is discarded when permissions leave YOLO during the assessment", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 50 && stale.calls.length === 0; attempt++) yield* Effect.yieldNow
      yield* setPermissions("manual")
      yield* Deferred.succeed(flipped, undefined)
      const pending = yield* waitForPending
      expect(pending.escalation).toEqual({ authority: "yolo", reason: "escalated" })
      yield* service.reply({ requestID: pending.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )
})

describe("assessment grade interpretation", () => {
  const grades = (scores: Scores) => ({
    type: "grades" as const,
    grades: Object.entries(scores).map(([choice, confidence]) => ({
      choice: choice as Guardrail.DecisionChoice,
      confidence,
      evidence: "Bounded evidence",
    })),
  })
  const baseline = SessionAssessment.policy("baseline", true)

  test("settles only on exact choice IDs at their thresholds", () => {
    expect(SessionAssessment.interpret(grades({ allow: 0.8, deny: 0, escalate: 0 }), baseline).type).toBe("approve")
    expect(SessionAssessment.interpret(grades({ allow: 0.79, deny: 0, escalate: 0 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "low_confidence" } })
    expect(SessionAssessment.interpret(grades({ allow: 0, deny: 0.8, escalate: 0 }), baseline).type).toBe("deny")
    expect(SessionAssessment.interpret(grades({ approve: 1, reject: 0, escalate: 0 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "invalid-output" } })
    expect(SessionAssessment.interpret(grades({ allow: 1, deny: 0 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "invalid-output" } })
    expect(SessionAssessment.interpret(grades({ allow: 1, deny: 0, escalate: 0, approve: 0 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "invalid-output" } })
  })

  test("escalates a model escalation tie, a conflict, and any allow that cannot be granted", () => {
    expect(SessionAssessment.interpret(grades({ allow: 0.9, deny: 0, escalate: 0.9 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "escalated", choice: "escalate" } })
    expect(SessionAssessment.interpret(grades({ allow: 0.9, deny: 0.85, escalate: 0 }), baseline)).toMatchObject({ type: "escalate", provenance: { reason: "conflicting_grades", choice: "allow" } })
    expect(SessionAssessment.interpret(grades({ allow: 0.99, deny: 0, escalate: 0 }), SessionAssessment.policy("baseline", false))).toMatchObject({
      type: "escalate",
      provenance: { authority: "baseline", reason: "escalated", choice: "allow" },
    })
    expect(SessionAssessment.interpret(grades({ allow: 0.2, deny: 0.8, escalate: 0 }), SessionAssessment.policy("baseline", false)).type).toBe("deny")
  })

  test("applies the same exact vocabulary and once-only approval to YOLO", () => {
    const yolo = SessionAssessment.policy("yolo", true)
    expect(SessionAssessment.choices(yolo)).toEqual(["allow", "deny", "escalate"])
    expect(SessionAssessment.interpret(grades({ allow: 0.8, deny: 0, escalate: 0 }), yolo)).toMatchObject({ type: "approve", reply: "once", provenance: { authority: "yolo" } })
    expect(SessionAssessment.interpret(grades({ approve_all: 0.9, approve: 0.9, reject: 0, escalate: 0 }), yolo)).toMatchObject({ type: "escalate", provenance: { reason: "invalid-output" } })
    expect(SessionAssessment.interpret({ type: "unsettled", reason: "timeout" }, yolo)).toEqual({
      type: "escalate",
      provenance: { authority: "yolo", reason: "timeout" },
    })
  })
})
