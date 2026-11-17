import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schema, Scope, Stream } from "effect"
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
import { PermissionSession } from "@ycoding-ai/core/permission/session"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
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

function harness() {
  const calls: Array<Decision.Invocation> = []
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventRuntime.node, SessionStore.node, SessionAutonomy.node, PermissionSaved.node, PermissionSession.node, CoordinationService.node, Location.node, Agent.node, Permission.node]),
      [
        [Location.node, current],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (_request: Decision.Input, context: Decision.Invocation) => Effect.sync(() => {
              calls.push(context)
              throw new Error("Permission modes must not invoke the evaluator")
            }),
          }),
        ],
        [
          Config.node,
          Layer.mock(Config.Service, {
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: true } }),
                }),
              ]),
          }),
        ],
      ],
    ),
  )
  return { it, calls }
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


describe("permission mode changes settle only pending actions", () => {
  const control = harness()
  control.it.effect("Manual applies rules from the captured configuration while YOLO skips configuration capture", () => Effect.gen(function* () {
    yield* setup
    const scope = yield* Scope.Scope
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = [{ action: "read", resource: "*", effect: "allow" }]
    }))
    const service = yield* Permission.make({
      entries: () => Effect.succeed([]),
      capture: () => agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "read", resource: "*", effect: "deny" }]
      })).pipe(Effect.provideService(Scope.Scope, scope), Effect.as(Effect.void)),
    })
    expect(yield* service.assert(request()).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
    yield* (yield* SessionAutonomy.Service).set({ sessionID, permissions: "yolo" })
    const yolo = yield* Permission.make({
      entries: () => Effect.die("YOLO must not read configured permissions"),
      capture: () => Effect.die("YOLO must not capture configured permissions"),
    })
    yield* yolo.assert(request())
    expect(yield* yolo.list()).toEqual([])
  }))

  control.it.effect("True YOLO never evaluates and current denies apply again after leaving YOLO", () => Effect.gen(function* () {
    yield* setup
    const autonomy = yield* SessionAutonomy.Service
    const service = yield* Permission.Service
    yield* tightenCeiling
    yield* autonomy.set({ sessionID, permissions: "yolo" })
    yield* service.assert(request())
    expect(yield* facts).toEqual([expect.objectContaining({ outcome: "allow", via: "yolo", reply: "once" })])
    expect(control.calls).toEqual([])
    yield* autonomy.set({ sessionID, permissions: "auto" })
    expect((yield* service.assert(request()).pipe(Effect.flip))).toBeInstanceOf(Permission.BlockedError)
    yield* autonomy.set({ sessionID, permissions: "manual" })
    expect((yield* service.ask(request())).effect).toBe("deny")
    expect(yield* service.list()).toEqual([])
  }))

  for (const requireExplicitDecision of [false, true]) {
    const pending = harness()
    pending.it.effect("True YOLO settles current pending permission once with explicit=" + requireExplicitDecision, () => Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      const service = yield* Permission.Service
      const waiting = yield* service.assert({ ...request(), requireExplicitDecision }).pipe(Effect.forkScoped)
      const value = yield* waitForPending
      yield* tightenCeiling
      yield* service.reconcileAutonomy(sessionID)
      expect(yield* service.get(value.id)).toBeDefined()
      yield* autonomy.set({ sessionID, guardrails: "yolo" })
      yield* service.reconcileAutonomy(sessionID)
      expect(yield* service.get(value.id)).toBeDefined()
      yield* autonomy.set({ sessionID, permissions: "yolo" })
      yield* service.reconcileAutonomy(sessionID)
      yield* service.reconcileAutonomy(sessionID)
      yield* Fiber.join(waiting)
      expect(yield* service.list()).toEqual([])
      expect(yield* facts).toEqual([expect.objectContaining({ requestID: value.id, outcome: "allow", via: "yolo", reply: "once" })])
      expect(pending.calls).toEqual([])
    }))
  }
})
