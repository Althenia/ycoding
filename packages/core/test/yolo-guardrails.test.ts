import path from "path"
import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_yolo_guardrails")
const project = "/workspace/project"
const guardrailDirectory = "/global/guardrails"
const source = { messageID: SessionMessage.ID.make("msg_yolo_guardrail_call"), callID: "call_outside_write" }

const outsideWrite = {
  sessionID,
  action: "file_mutation",
  resources: ["/outside/notes/today.md"],
  metadata: { operation: "write" },
  source,
} satisfies SessionGuardrail.EvaluateInput

const outsideShell = { sessionID, action: "shell", resources: ["touch /outside/file"], metadata: { workdir: project } } satisfies SessionGuardrail.EvaluateInput
const forcePush = { sessionID, action: "shell", resources: ["git push --force origin main"], metadata: { workdir: project }, source } satisfies SessionGuardrail.EvaluateInput

function reviewRule(id: string, decision: "ask" | "hard_review" = "ask") {
  return `---
id: ${id}
decision: ${decision}
actions: [shell, file_mutation]
resources: ["*"]
reason: ${id}
priority: 0
---
`
}

function denyRule(id: string) {
  return `---
id: ${id}
decision: deny
actions: [shell, file_mutation]
resources: ["*"]
reason: ${id}
priority: 0
---
`
}

function harness(input: {
  readonly baseline: boolean
  readonly documents?: ReadonlyArray<readonly [string, string]>
  readonly decide: (request: Decision.Input, index: number) => Effect.Effect<Decision.Output, Decision.Error>
}) {
  const documents = new Map(Array.from(input.documents ?? [], ([file, content]) => [path.normalize(file), content]))
  const choices: Decision.Input[] = []
  const calls: Array<{ readonly name: string | undefined; readonly authority: string | undefined }> = []
  const storage = Layer.provideMerge(EventRuntime.layer, Database.layer({ path: ":memory:" }))
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        scan: (_pattern, options) =>
          Effect.sync(() =>
            Array.from(documents.keys()).filter((file) => options?.cwd !== undefined && path.dirname(file) === path.normalize(options.cwd)),
          ),
        readFileStringSafe: (file) => Effect.sync(() => documents.get(path.normalize(file))),
      })
    }),
  ).pipe(Layer.provide(FSUtil.layer), Layer.provide(NodeFileSystem.layer))
  const dependencies = Layer.mergeAll(
    Layer.mock(Decision.Service, {
      evaluate: (request: Decision.Input, context: Decision.Invocation) => {
        calls.push({ name: request.request.questions[0]?.name, authority: context.authority })
        choices.push(request)
        return input.decide(request, choices.length - 1)
      },
    }),
    Layer.mock(Config.Service, {
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: input.baseline } }),
          }),
        ]),
    }),
    Layer.mock(LocationMutation.Service, { repositoryWorktree: () => Effect.succeed(false) }),
    Layer.mock(Permission.Service, { evaluateEffective: () => Effect.succeed("ask" as const) }),
    Layer.mock(SessionStore.Service, {
      get: (id) => Effect.succeed(id === sessionID ? ({ id: sessionID } as Session.Info) : undefined),
    }),
    filesystem,
    Global.layerWith({ home: path.resolve("/home/user"), data: "/ycoding/data", config: "/global", cache: "/ycoding/cache", state: "/ycoding/state" }),
    Layer.succeed(
      Location.Service,
      Location.Service.of(location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) })),
    ),
    storage,
    SessionAutonomy.layer.pipe(Layer.provide(storage)),
  )
  return { documents, choices, calls, it: testEffect(SessionGuardrail.layer.pipe(Layer.provideMerge(dependencies))) }
}

const seed = (options: { readonly guardrails: "manual" | "yolo" | "auto"; readonly defer?: boolean }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: project, title: "yolo guardrails" }).onConflictDoNothing().run().pipe(Effect.orDie)
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, guardrails: options.guardrails })
    if (options.defer) yield* autonomy.set({ sessionID, defer: true })
  })

const awaitRequest = Effect.fnUntraced(function* () {
  const service = yield* SessionGuardrail.Service
  for (let attempt = 0; attempt < 200 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
  const requests = yield* service.forSession(sessionID)
  expect(requests).toHaveLength(1)
  return requests[0]!
})

const rejectPending = (running: Fiber.Fiber<SessionGuardrail.Reservation, SessionGuardrail.AssertError>) =>
  Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const pending = yield* awaitRequest()
    yield* service.reply({ sessionID, requestID: pending.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
  })

describe("native YOLO guardrails", () => {
  for (const [name, input, documents] of [
    ["outside writes", outsideWrite, []],
    ["hard reviews", forcePush, []],
    ["catastrophic denies", { ...outsideShell, resources: ["rm -rf /"] }, []],
    ["invalid configuration", outsideShell, [[guardrailDirectory + "/broken.md", "not a guardrail document"]]],
    ["custom denies", outsideShell, [[guardrailDirectory + "/deny.md", denyRule("deny-everything")]]],
    ["custom hard reviews", outsideShell, [[guardrailDirectory + "/hard.md", reviewRule("custom-hard", "hard_review")]]],
    ["custom reviews", outsideShell, [[guardrailDirectory + "/review.md", reviewRule("custom-review")]]],
  ] as const) {
    const native = harness({ baseline: true, documents, decide: () => Effect.die(new Error("Native YOLO must not evaluate a model")) })
    native.it.effect("native YOLO admits " + name + " while deferred without a helper or review item", () => Effect.gen(function* () {
      yield* seed({ guardrails: "yolo", defer: true })
      const service = yield* SessionGuardrail.Service
      yield* (yield* service.assert(input)).release
      expect(yield* service.forSession(sessionID)).toEqual([])
      const { db } = yield* Database.Service
      expect(yield* SessionReviewFold.fold(db, [sessionID])).toEqual([])
      expect(native.calls).toEqual([])
    }))
  }
})

function realPermissionHarness() {
  const choices: Decision.Input[] = []
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
        SessionGuardrail.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) })),
          ),
        ],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (request: Decision.Input) => {
              choices.push(request)
              return Effect.die(new Error("Native admission must not evaluate a model"))
            },
          }),
        ],
        [
          Config.node,
          Layer.mock(Config.Service, {
            entries: () =>
              Effect.succeed([
                new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: true } }) }),
              ]),
          }),
        ],
        [Global.node, Global.layerWith({ home: path.resolve("/home/user"), data: "/ycoding/data", config: "/global", cache: "/ycoding/cache", state: "/ycoding/state" })],
        [LocationMutation.node, Layer.mock(LocationMutation.Service, { repositoryWorktree: () => Effect.succeed(false) })],
      ],
    ),
  )
  return { it, choices }
}

describe("human directory approval", () => {
  const replied = realPermissionHarness()
  replied.it.effect("a human directory approval precedes native YOLO guardrail admission without grading", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: project, title: "same call", agent: "test" }).onConflictDoNothing().run().pipe(Effect.orDie)
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "manual", guardrails: "yolo" })
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [
            { action: "*", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "ask" },
          ]
        }),
      )
      const permission = yield* Permission.Service
      const approval = yield* permission
        .assert({
          sessionID,
          action: "external_directory",
          resources: ["/outside/notes/*"],
          save: ["/outside/notes/*"],
          source: { type: "tool", messageID: source.messageID, callID: source.callID },
        })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* permission.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
      const asked = (yield* permission.forSession(sessionID))[0]!
      yield* permission.reply({ requestID: asked.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.await(approval))).toBe(true)

      const service = yield* SessionGuardrail.Service
      yield* (yield* service.assert(outsideWrite)).release
      expect(yield* service.forSession(sessionID)).toEqual([])
      expect(replied.choices).toEqual([])
    }),
  )
})

describe("prior guardrail rejections", () => {
  const live = harness({ baseline: false, decide: () => Effect.die(new Error("Native admission must not evaluate a model")) })
  live.it.effect("native YOLO ignores an awake rejection without granting a later Manual reissue", () => Effect.gen(function* () {
    yield* seed({ guardrails: "manual" })
    const service = yield* SessionGuardrail.Service
    yield* rejectPending(yield* service.assert(outsideShell).pipe(Effect.forkScoped))
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, guardrails: "yolo" })
    yield* (yield* service.assert(outsideShell)).release
    expect(yield* service.forSession(sessionID)).toEqual([])
    yield* autonomy.set({ sessionID, guardrails: "manual" })
    yield* rejectPending(yield* service.assert(outsideShell).pipe(Effect.forkScoped))
    expect(live.calls).toEqual([])
  }))

  const recorded = harness({ baseline: false, decide: () => Effect.die(new Error("Native admission must not evaluate a model")) })
  recorded.it.effect("native YOLO ignores a review-box rejection without consuming it as a reusable grant", () => Effect.gen(function* () {
    yield* seed({ guardrails: "manual", defer: true })
    const service = yield* SessionGuardrail.Service
    expect(Exit.isFailure(yield* service.assert(outsideShell).pipe(Effect.exit))).toBe(true)
    const { db } = yield* Database.Service
    const items = yield* SessionReviewFold.fold(db, [sessionID])
    expect(items).toHaveLength(1)
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Review.Decided, { sessionID, itemID: items[0]!.itemID, decision: { kind: "guardrail", reply: "reject" } })
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, guardrails: "yolo", defer: false })
    yield* (yield* service.assert(outsideShell)).release
    expect((yield* SessionReviewFold.fold(db, [sessionID]))[0]).toMatchObject({ consumed: false, decision: { kind: "guardrail", reply: "reject" } })
    yield* autonomy.set({ sessionID, guardrails: "manual" })
    yield* rejectPending(yield* service.assert(outsideShell).pipe(Effect.forkScoped))
    expect(recorded.calls).toEqual([])
  }))
})

const reviewBox = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* SessionReviewFold.fold(db, [sessionID])
})

describe("guardrail decision modes", () => {
  for (const baseline of [true, false]) {
    const manual = harness({ baseline, decide: () => Effect.die(new Error("Manual guardrails never reach a model")) })
    manual.it.effect(`Manual with decide_reviews ${baseline} asks the human for an ordinary review without verification or grading`, () =>
      Effect.gen(function* () {
        yield* seed({ guardrails: "manual" })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        const pending = yield* awaitRequest()
        expect(pending.escalation).toBeUndefined()
        yield* service.reply({ sessionID, requestID: pending.id, reply: "once" })
        yield* (yield* Fiber.join(running)).release
        expect(manual.calls).toEqual([])
      }),
    )
  }

  const manualHard = harness({ baseline: true, decide: () => Effect.die(new Error("Manual guardrails never reach a model")) })
  manualHard.it.effect("Manual asks the human for a hard review without verification or grading", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "manual" })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert(forcePush).pipe(Effect.forkScoped)
      expect(yield* awaitRequest()).toHaveProperty("source", source)
      yield* rejectPending(running)
      expect(manualHard.calls).toEqual([])
    }),
  )

  const manualDeferred = harness({ baseline: true, decide: () => Effect.die(new Error("Manual guardrails never reach a model")) })
  manualDeferred.it.effect("Manual defers to the review box while decisions are deferred without a helper call", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "manual", defer: true })
      const service = yield* SessionGuardrail.Service
      const exit = yield* service.assert(outsideShell).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* reviewBox).toEqual([expect.objectContaining({ kind: "guardrail", reason: "disabled" })])
      expect(manualDeferred.calls).toEqual([])
    }),
  )

  const autoAwake = harness({ baseline: true, decide: () => Effect.die(new Error("Auto guardrails never reach a model")) })
  autoAwake.it.effect("Auto approves an ordinary standard review awake without a helper call", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto" })
      const service = yield* SessionGuardrail.Service
      yield* (yield* service.assert(outsideShell)).release
      expect(yield* service.forSession(sessionID)).toEqual([])
      expect(autoAwake.calls).toEqual([])
    }),
  )

  const autoDeferred = harness({ baseline: true, decide: () => Effect.die(new Error("Auto guardrails never fall back to a model")) })
  autoDeferred.it.effect("Auto defers an ordinary review while decisions are deferred without a model fallback", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto", defer: true })
      const service = yield* SessionGuardrail.Service
      expect(Exit.isFailure(yield* service.assert(outsideShell).pipe(Effect.exit))).toBe(true)
      expect(yield* reviewBox).toEqual([expect.objectContaining({ kind: "guardrail", reason: "disabled" })])
      expect(autoDeferred.calls).toEqual([])
    }),
  )

  const autoHard = harness({ baseline: true, decide: () => Effect.die(new Error("Auto guardrails never fall back to a model")) })
  autoHard.it.effect("Auto asks the human for a hard review without verification or grading", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto" })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert(forcePush).pipe(Effect.forkScoped)
      yield* rejectPending(running)
      expect(autoHard.calls).toEqual([])
    }),
  )

  const autoCustom = harness({
    baseline: true,
    documents: [[`${guardrailDirectory}/review.md`, reviewRule("custom-review")]],
    decide: () => Effect.die(new Error("Auto guardrails never fall back to a model")),
  })
  autoCustom.it.effect("Auto never approves a custom-rule review and asks the human without a helper call", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto" })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert({ sessionID, action: "shell", resources: ["task-runner execute"], metadata: { workdir: project } }).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(pending.ruleIDs).toEqual(["custom-review"])
      yield* service.reply({ sessionID, requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(autoCustom.calls).toEqual([])
    }),
  )

  for (const baseline of [true, false]) {
    const yolo = harness({ baseline, decide: () => Effect.die(new Error("Native YOLO must not evaluate a model")) })
    yolo.it.effect("YOLO with decide_reviews " + baseline + " admits ordinary reviews without verification or grading", () => Effect.gen(function* () {
      yield* seed({ guardrails: "yolo" })
      const service = yield* SessionGuardrail.Service
      yield* (yield* service.assert(outsideShell)).release
      expect(yield* service.forSession(sessionID)).toEqual([])
      expect(yolo.calls).toEqual([])
    }))
  }

  for (const mode of ["manual", "yolo", "auto"] as const) {
    const denied = harness({
      baseline: true,
      documents: [[`${guardrailDirectory}/deny.md`, denyRule("deny-everything")]],
      decide: () => Effect.die(new Error("Denies never reach a model")),
    })
    denied.it.effect(`a deny rule ${mode === "yolo" ? "is bypassed" : "blocks"} in ${mode} before any helper call`, () =>
      Effect.gen(function* () {
        yield* seed({ guardrails: mode })
        const service = yield* SessionGuardrail.Service
        const result = yield* service.assert(outsideShell).pipe(Effect.exit)
        if (Exit.isSuccess(result)) yield* result.value.release
        expect(Exit.isFailure(result)).toBe(mode !== "yolo")
        expect(denied.calls).toEqual([])
      }),
    )
  }
})
