import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
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
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionPermissionCeiling } from "@ycoding-ai/core/session/permission-ceiling"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_yolo_permissions")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)

function harness(input: {
  readonly baseline: boolean
  readonly decide: (request: Decision.Input, index: number) => Effect.Effect<Decision.Output, Decision.Error>
}) {
  const calls: Array<{ readonly request: Decision.Input; readonly context: Decision.Invocation }> = []
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventRuntime.node, SessionStore.node, SessionAutonomy.node, PermissionSaved.node, Agent.node, Permission.node]),
      [
        [Location.node, current],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (request: Decision.Input, context: Decision.Invocation) => {
              calls.push({ request, context })
              return input.decide(request, calls.length - 1)
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
  return { it, calls }
}

const setup = (options: { readonly rules?: Permission.Ruleset; readonly yolo?: boolean } = {}) =>
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
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "yolo permissions", agent: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...(options.rules ?? [])]
      }),
    )
    if (options.yolo) {
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "yolo" })
    }
  })

const request = (input: Partial<Permission.AssertInput> = {}) =>
  ({ sessionID, action: "read", resources: ["secret/notes.txt"], ...input }) satisfies Permission.AssertInput

const waitForPending = Effect.gen(function* () {
  const service = yield* Permission.Service
  for (let attempt = 0; attempt < 100 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
  const pending = yield* service.forSession(sessionID)
  expect(pending).toHaveLength(1)
  return pending[0]!
})

describe("permission decision modes", () => {
  const human = harness({ baseline: true, decide: () => Effect.die(new Error("Native permission admission must not evaluate a model")) })
  human.it.effect("native YOLO admits an explicit human-decision request without opening a request", () => Effect.gen(function* () {
    yield* setup({ yolo: true, rules: [{ action: "read", resource: "*", effect: "allow" }] })
    const service = yield* Permission.Service
    yield* service.assert(request({ requireExplicitDecision: true }))
    expect(yield* service.forSession(sessionID)).toEqual([])
    expect(human.calls).toEqual([])
  }))

  const origins = harness({ baseline: false, decide: () => Effect.die(new Error("Native YOLO must not grade rule origins")) })
  origins.it.effect("native YOLO admits agent ask and deny rules and unmatched resources without grading origins", () => Effect.gen(function* () {
    yield* setup({ yolo: true, rules: [
      { action: "read", resource: "secret/*", effect: "ask" },
      { action: "read", resource: "blocked/*", effect: "deny" },
    ] })
    const service = yield* Permission.Service
    yield* service.assert(request({ resources: ["secret/notes.txt", "blocked/file", "other.bin"] }))
    expect(yield* service.forSession(sessionID)).toEqual([])
    expect(origins.calls).toEqual([])
  }))

  const ceiling = harness({ baseline: true, decide: () => Effect.die(new Error("Native YOLO must not evaluate a ceiling")) })
  ceiling.it.effect("native YOLO admits a deny-only ceiling without any assessment", () => Effect.gen(function* () {
    yield* setup({ yolo: true, rules: [{ action: "read", resource: "*", effect: "ask" }] })
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ permission: SessionPermissionCeiling.denyOnly([{ action: "read", resource: "secret/*", effect: "deny" }]) })
      .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    const service = yield* Permission.Service
    yield* service.assert(request())
    expect(yield* service.forSession(sessionID)).toEqual([])
    expect(ceiling.calls).toEqual([])
  }))

  for (const mode of ["manual", "auto"] as const) {
    const denied = harness({ baseline: true, decide: () => Effect.die(new Error("Manual and Auto denies must not evaluate a model")) })
    denied.it.effect("a deny rule still blocks in " + mode + " without a helper call", () => Effect.gen(function* () {
      yield* setup({ rules: [{ action: "read", resource: "*", effect: "deny" }] })
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: mode })
      const service = yield* Permission.Service
      expect((yield* Effect.flip(service.assert(request())))._tag).toBe("Permission.BlockedError")
      expect(denied.calls).toEqual([])
    }))
  }

  const manual = harness({ baseline: true, decide: () => Effect.die(new Error("Manual permission requests must not evaluate a model")) })
  manual.it.effect("Manual asks for an unmatched permission without grading", () => Effect.gen(function* () {
    yield* setup()
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions: "manual" })
    const service = yield* Permission.Service
    const running = yield* service.assert(request()).pipe(Effect.forkScoped)
    const pending = yield* waitForPending
    expect(pending.escalation).toBeUndefined()
    yield* service.reply({ requestID: pending.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
    expect(manual.calls).toEqual([])
  }))

  const auto = harness({ baseline: false, decide: () => Effect.die(new Error("Auto permission admission must not evaluate a model")) })
  auto.it.effect("Auto admits an ordinary ask rule without grading", () => Effect.gen(function* () {
    yield* setup({ rules: [{ action: "read", resource: "*", effect: "ask" }] })
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions: "auto" })
    const service = yield* Permission.Service
    yield* service.assert(request())
    expect(yield* service.forSession(sessionID)).toEqual([])
    expect(auto.calls).toEqual([])
  }))

  for (const baseline of [true, false]) {
    const native = harness({ baseline, decide: () => Effect.die(new Error("Native YOLO must not evaluate a model")) })
    native.it.effect("native YOLO with decide_reviews " + baseline + " admits deferred executor requests without a review item", () => Effect.gen(function* () {
      yield* setup({ yolo: true })
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, defer: true })
      const service = yield* Permission.Service
      yield* service.assert(request({ defer: true }))
      expect(yield* service.forSession(sessionID)).toEqual([])
      const { db } = yield* Database.Service
      expect(yield* SessionReviewFold.fold(db, [sessionID])).toEqual([])
      expect(native.calls).toEqual([])
    }))
  }

  const external = harness({ baseline: true, decide: () => Effect.die(new Error("Native permission requests must not evaluate a model")) })
  external.it.effect("Permission.ask admits native YOLO without a pending human request or model assessment", () => Effect.gen(function* () {
    yield* setup({ yolo: true })
    const service = yield* Permission.Service
    expect((yield* service.ask(request())).effect).toBe("allow")
    expect(yield* service.forSession(sessionID)).toEqual([])
    expect(external.calls).toEqual([])
  }))
})

describe("deferred permission decisions", () => {
  const human = harness({ baseline: true, decide: () => Effect.die(new Error("Explicit human decisions must not evaluate a model")) })
  human.it.effect("Auto defers explicit human decisions and consumes an exact grant only once", () => Effect.gen(function* () {
    yield* setup({ rules: [{ action: "read", resource: "*", effect: "allow" }] })
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions: "auto", defer: true })
    const service = yield* Permission.Service
    const input = request({ requireExplicitDecision: true, save: ["secret/*"], metadata: { operationDigest: "synthetic" } })
    expect(Exit.isFailure(yield* service.assert(input).pipe(Effect.exit))).toBe(true)
    const { db } = yield* Database.Service
    const items = yield* SessionReviewFold.fold(db, [sessionID])
    expect(items).toHaveLength(1)
    expect(items[0]?.payload).toMatchObject({ type: "permission" })
    expect(items[0]?.payload).not.toHaveProperty("save")
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Review.Decided, { sessionID, itemID: items[0]!.itemID, decision: { kind: "permission", reply: "once" } })
    yield* service.assert(input)
    expect(Exit.isFailure(yield* service.assert(input).pipe(Effect.exit))).toBe(true)
    expect(yield* SessionReviewFold.fold(db, [sessionID])).toHaveLength(2)
    expect(human.calls).toEqual([])
  }))
})

describe("prior permission rejections", () => {
  const live = harness({ baseline: false, decide: () => Effect.die(new Error("Native permission admission must not evaluate a model")) })
  live.it.effect("native YOLO ignores an awake rejection without granting a later Manual reissue", () => Effect.gen(function* () {
    yield* setup()
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions: "manual" })
    const service = yield* Permission.Service
    const first = yield* service.assert(request()).pipe(Effect.forkScoped)
    const pending = yield* waitForPending
    yield* service.reply({ requestID: pending.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
    yield* autonomy.set({ sessionID, permissions: "yolo" })
    yield* service.assert(request())
    expect(yield* service.forSession(sessionID)).toEqual([])
    yield* autonomy.set({ sessionID, permissions: "manual" })
    const second = yield* service.assert(request()).pipe(Effect.forkScoped)
    const again = yield* waitForPending
    yield* service.reply({ requestID: again.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
    expect(live.calls).toEqual([])
  }))

  const recorded = harness({ baseline: false, decide: () => Effect.die(new Error("Native permission admission must not evaluate a model")) })
  recorded.it.effect("native YOLO ignores a review-box rejection without consuming it as a reusable grant", () => Effect.gen(function* () {
    yield* setup()
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, permissions: "manual", defer: true })
    const service = yield* Permission.Service
    expect(Exit.isFailure(yield* service.assert(request()).pipe(Effect.exit))).toBe(true)
    const { db } = yield* Database.Service
    const items = yield* SessionReviewFold.fold(db, [sessionID])
    expect(items).toHaveLength(1)
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Review.Decided, { sessionID, itemID: items[0]!.itemID, decision: { kind: "permission", reply: "reject" } })
    yield* autonomy.set({ sessionID, permissions: "yolo", defer: false })
    yield* service.assert(request())
    expect((yield* SessionReviewFold.fold(db, [sessionID]))[0]).toMatchObject({ consumed: false, decision: { kind: "permission", reply: "reject" } })
    yield* autonomy.set({ sessionID, permissions: "manual", defer: true })
    expect(Exit.isFailure(yield* service.assert(request()).pipe(Effect.exit))).toBe(true)
    expect(yield* SessionReviewFold.fold(db, [sessionID])).toHaveLength(2)
    expect(recorded.calls).toEqual([])
  }))
})
