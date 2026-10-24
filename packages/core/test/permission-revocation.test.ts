import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
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
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_permission_revocation")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

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
        grades: question.type === "choice"
          ? question.choices.map((choice) => ({
              choice: choice.value,
              confidence: scores[String(choice.value)] ?? 0,
              evidence: "Bounded assessment evidence",
            }))
          : [],
      })),
    },
  })

function harness(input: { readonly baseline: boolean; readonly scores: Record<string, number> }) {
  const entered = Deferred.makeUnsafe<void>()
  const gate = Deferred.makeUnsafe<void>()
  const calls: Array<Decision.Invocation> = []
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventRuntime.node, SessionStore.node, SessionAutonomy.node, PermissionSaved.node, Agent.node, Permission.node]),
      [
        [Location.node, current],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (request: Decision.Input, context: Decision.Invocation) => {
              calls.push(context)
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate)),
                Effect.as(graded(request, input.scores)),
              )
            },
          }),
        ],
        [
          Config.node,
          Layer.mock(Config.Service, {
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: input.baseline } }),
                }),
              ]),
          }),
        ],
      ],
    ),
  )
  return { it, entered, gate, calls }
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "revocation", agent: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )
})

const request = () => ({ sessionID, action: "read", resources: ["README.md"] }) satisfies Permission.AssertInput

const facts = Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  return (yield* events.log({ aggregateID: sessionID, follow: false }).pipe(Stream.runCollect)).flatMap((event) =>
    event.type === "session.permission.assessed" && "data" in event ? [event.data as Record<string, unknown>] : [],
  )
})

const waitForPending = Effect.gen(function* () {
  const service = yield* Permission.Service
  for (let attempt = 0; attempt < 100 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
  const pending = yield* service.forSession(sessionID)
  expect(pending).toHaveLength(1)
  return pending[0]!
})

const tightenCeiling = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .update(SessionTable)
    .set({ permission: SessionPermissionCeiling.denyOnly([{ action: "read", resource: "*", effect: "deny" }]) })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

describe("YOLO permission assessment is fenced by current authorization", () => {
  const control = harness({ baseline: false, scores: { allow: 0.95 } })
  control.it.effect("an unchanged YOLO authorization applies its approval once", () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "yolo" })
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
      yield* Deferred.await(control.entered)
      yield* Deferred.succeed(control.gate, undefined)
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* facts).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo" })])
    }),
  )

  for (const choice of ["allow", "deny"] as const) {
    const aba = harness({ baseline: false, scores: { [choice]: 0.95 } })
    aba.it.effect(`a YOLO ${choice} is discarded when permissions leave YOLO and return during the assessment`, () =>
      Effect.gen(function* () {
        yield* setup
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID, permissions: "yolo" })
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
        yield* Deferred.await(aba.entered)
        yield* autonomy.set({ sessionID, permissions: "manual" })
        yield* autonomy.set({ sessionID, permissions: "yolo" })
        yield* Deferred.succeed(aba.gate, undefined)
        const pending = yield* waitForPending
        expect(pending.escalation).toEqual({ authority: "yolo", reason: "escalated" })
        expect(yield* facts).toEqual([expect.objectContaining({ outcome: "escalate", via: "yolo" })])
        yield* service.reply({ requestID: pending.id, reply: "once" })
        yield* Fiber.join(fiber)
      }),
    )
  }

  const unrelated = harness({ baseline: false, scores: { allow: 0.95 } })
  unrelated.it.effect("any autonomy change during the assessment withholds the YOLO approval", () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "yolo" })
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
      yield* Deferred.await(unrelated.entered)
      yield* autonomy.set({ sessionID, answers: "auto" })
      yield* Deferred.succeed(unrelated.gate, undefined)
      const pending = yield* waitForPending
      expect(pending.escalation).toEqual({ authority: "yolo", reason: "escalated" })
      yield* service.reply({ requestID: pending.id, reply: "reject" })
      yield* Fiber.await(fiber)
    }),
  )
})

describe("permission outcomes re-evaluate the current rules and ceiling", () => {
  for (const baseline of [true, false]) {
    const ceiling = harness({ baseline, scores: { allow: 0.95 } })
    ceiling.it.effect(`a YOLO approval with decide_reviews ${baseline} cannot outlive a ceiling deny added during the assessment`, () =>
      Effect.gen(function* () {
        yield* setup
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID, permissions: "yolo" })
        const service = yield* Permission.Service
        const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
        yield* Deferred.await(ceiling.entered)
        yield* tightenCeiling
        yield* Deferred.succeed(ceiling.gate, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("Permission.BlockedError")
        expect(yield* service.list()).toEqual([])
        expect(yield* facts).toEqual([])
      }),
    )
  }

  const escalation = harness({ baseline: true, scores: { escalate: 1 } })
  escalation.it.effect("an escalation never opens a human prompt for a request the ceiling now denies", () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "yolo" })
      const service = yield* Permission.Service
      const fiber = yield* service.assert(request()).pipe(Effect.forkScoped)
      yield* Deferred.await(escalation.entered)
      yield* tightenCeiling
      yield* Deferred.succeed(escalation.gate, undefined)
      const exit = yield* Fiber.await(fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(exit.cause.toString()).toContain("Permission.BlockedError")
      expect(yield* service.list()).toEqual([])
    }),
  )
})
