import { describe, expect, test } from "bun:test"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
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
      yield* autonomy.set({ sessionID, defer: true })
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
        const fiber = yield* service.assert(request({ requireExplicitDecision: true })).pipe(Effect.forkScoped)
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

describe("deny rules and permission ceilings follow the effective permission mode", () => {
  for (const mode of ["manual", "yolo", "auto"] as const) {
    const denied = harness({ decide: () => Effect.die("Explicit denies never reach the helper") })
    denied.it.effect(mode === "yolo" ? "YOLO permissions bypass an agent deny without a helper call" : `an agent deny blocks ${mode} before any helper call`, () =>
      Effect.gen(function* () {
        yield* setup([{ action: "read", resource: "*", effect: "deny" }])
        yield* setPermissions(mode)
        const service = yield* Permission.Service
        if (mode === "yolo") {
          yield* service.assert(request())
          expect(yield* facts("session.permission.assessed")).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo", reply: "once" })])
        } else expect(yield* service.assert(request()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
        expect(denied.calls).toEqual([])
      }),
    )
    const ceiling = harness({ decide: () => Effect.die("Ceiling denies never reach the helper") })
    ceiling.it.effect(mode === "yolo" ? "YOLO permissions bypass a Session ceiling without a helper call" : `a Session permission ceiling blocks ${mode} before any helper call`, () =>
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
        if (mode === "yolo") {
          yield* service.assert(request())
          expect(yield* facts("session.permission.assessed")).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo", reply: "once" })])
        } else expect(yield* service.assert(request()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
        expect(ceiling.calls).toEqual([])
      }),
    )
  }
})

describe("YOLO permissions do not invoke a decision model", () => {
  for (const config of [undefined, true, false] as const) {
    const run = harness({ config, decide: () => Effect.never })
    run.it.effect(`decide_reviews ${String(config)} does not affect direct YOLO permission grants`, () =>
      Effect.gen(function* () {
        yield* setup()
        yield* setPermissions("yolo")
        const service = yield* Permission.Service
        yield* service.assert(request())
        expect(yield* service.list()).toEqual([])
        expect(run.calls).toEqual([])
        expect(yield* facts("session.permission.assessed")).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo", reply: "once" })])
      }),
    )
  }

  const deferred = harness({ decide: () => Effect.never })
  deferred.it.effect("YOLO permission grants remain direct while requests are deferred", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      yield* (yield* SessionAutonomy.Service).set({ sessionID, defer: true })
      const service = yield* Permission.Service
      yield* service.assert(request())
      expect(yield* service.list()).toEqual([])
      expect(yield* SessionReviewFold.fold((yield* Database.Service).db, [sessionID])).toEqual([])
      expect(deferred.calls).toEqual([])
    }),
  )

  const explicit = harness({ decide: () => Effect.never })
  explicit.it.effect("YOLO permission grants apply to explicit asks without a fabricated human reply", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const service = yield* Permission.Service
      yield* service.assert(request({ requireExplicitDecision: true }))
      expect(yield* service.list()).toEqual([])
      expect(explicit.calls).toEqual([])
      expect(yield* facts("session.permission.replied")).toEqual([])
    }),
  )

  const changed = harness({ decide: () => Effect.never })
  changed.it.effect("a grant under YOLO does not grant a later request after switching to Manual", () =>
    Effect.gen(function* () {
      yield* setup()
      yield* setPermissions("yolo")
      const service = yield* Permission.Service
      yield* service.assert(request())
      yield* setPermissions("manual")
      const waiting = yield* service.assert(request()).pipe(Effect.exit, Effect.forkScoped)
      const pending = yield* waitForPending
      expect(yield* service.list()).toHaveLength(1)
      yield* service.reply({ requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.join(waiting))).toBe(true)
      expect(changed.calls).toEqual([])
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
