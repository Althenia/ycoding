import path from "path"
import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Global } from "@ycoding-ai/core/global"
import { Location } from "@ycoding-ai/core/location"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { Permission } from "@ycoding-ai/core/permission"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { CoordinationDecisions } from "@ycoding-ai/core/session/coordination-decisions"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Config.node, Database.node, EventRuntime.node, SessionAutonomy.node, Decision.node, Form.node]),
  [
    [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.die("coordinator-selected answers must not call the hidden evaluator") })],
    [
      Config.node,
      Layer.mock(Config.Service, {
        entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
      }),
    ],
  ],
)
const it = testEffect(layer)
const sessionID = SessionSchema.ID.make("ses_coord_form")
const form = {
  id: Form.ID.create("frm_coord_native"),
  sessionID,
  title: "Choose the assigned branch",
  fields: [
    {
      key: "branch",
      type: "string",
      required: true,
      options: [{ value: "safe", label: "Safe" }],
    },
  ],
} satisfies Form.CreateInput

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const autonomy = yield* SessionAutonomy.Service
  const directory = AbsolutePath.make("/tmp/ycoding-coordination-form")
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory, path: "", title: "Coordination form" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* autonomy.setMode({ sessionID, mode: "normal" })
})

describe("native coordinator Form reconsideration", () => {
  it.effect("settles a coordinator-selected valid answer with source and rationale while autonomy flags stay off", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* Form.Service
      const autonomy = yield* SessionAutonomy.Service
      const events = yield* EventRuntime.Service
      const before = yield* autonomy.snapshot(sessionID)
      expect(before.state.yolo).toBe(false)
      expect(before.state.autoAnswer).toBeUndefined()
      const replied: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Form.Event.Replied.type) replied.push(event.data)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* service.create(form)
      const snapshot = yield* service.snapshot(form.id)
      expect(snapshot?.state).toEqual({ status: "pending" })
      const result = yield* service.reconsider({
        id: form.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: { coordinatorSessionID: "ses_coord", groupID: "cgrp_one", rationale: "Assigned branch in the task." },
        answer: { branch: "safe" },
        confidence: 0.95,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "coordination", confidence: 0.95 })
      expect(yield* service.state(form.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      expect(replied).toEqual([
        {
          id: form.id,
          sessionID,
          answer: { branch: "safe" },
          source: {
            kind: "coordinator",
            coordinatorSessionID: "ses_coord",
            groupID: "cgrp_one",
            via: "coordination",
            confidence: 0.95,
            rationale: "Assigned branch in the task.",
          },
        },
      ])
      const after = yield* autonomy.snapshot(sessionID)
      expect(after.state).toEqual(before.state)

      const second = yield* service.reconsider({
        id: form.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: { coordinatorSessionID: "ses_coord", groupID: "cgrp_one", rationale: "Assigned branch in the task." },
        answer: { branch: "safe" },
        confidence: 0.95,
        validate: () => Effect.succeed(true),
      })
      expect(second).toMatchObject({ outcome: "stale", settled: false })
      expect(replied).toHaveLength(1)
    }),
  )

  it.effect("invalid coordinator answers escalate without settling the pending form", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* Form.Service
      const invalidForm = { ...form, id: Form.ID.create("frm_coord_invalid") }
      yield* service.create(invalidForm)
      const snapshot = yield* service.snapshot(invalidForm.id)
      const result = yield* service.reconsider({
        id: invalidForm.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: { coordinatorSessionID: "ses_coord", groupID: "cgrp_one", rationale: "Assigned branch in the task." },
        answer: { branch: "missing" },
        confidence: 0.95,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "invalid-answer" })
      expect(yield* service.state(invalidForm.id)).toEqual({ status: "pending" })
    }),
  )

  it.effect("escalation hops append bounded reasons to the pending form, publish a refresh, and survive sleep deferral", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const refreshed: unknown[] = []
      const deferred: Array<Record<string, unknown>> = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === Coordination.Event.RequestEscalated.type) refreshed.push(event.data)
          if (event.type === SessionEvent.Review.Deferred.type) deferred.push(event.data as Record<string, unknown>)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const asked = { ...form, id: Form.ID.create("frm_coord_escalate") }
      const waiting = yield* service.ask(asked).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.snapshot(asked.id)) === undefined; attempt++) yield* Effect.yieldNow
      const snapshot = yield* service.snapshot(asked.id)
      const driver = { coordinatorSessionID: SessionSchema.ID.make("ses_driver"), groupID: "cgrp_one", rationale: "The branch is the owner's call." }
      const master = { coordinatorSessionID: SessionSchema.ID.make("ses_coord"), groupID: "cgrp_one", rationale: "No recorded instruction names a branch." }
      expect(yield* service.escalate({ id: asked.id, fingerprint: "stale", source: driver, handoff: false })).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* service.escalate({ id: asked.id, fingerprint: snapshot!.fingerprint, source: driver, handoff: false })).toMatchObject({ outcome: "escalated", settled: false })
      const chain = { reasons: [{ sessionID: driver.coordinatorSessionID, reason: driver.rationale }, { sessionID: master.coordinatorSessionID, reason: master.rationale }] }
      expect(yield* service.escalate({ id: asked.id, fingerprint: snapshot!.fingerprint, source: master, handoff: true })).toMatchObject({ outcome: "escalated", coordinationEscalation: chain })
      expect(yield* service.escalate({ id: asked.id, fingerprint: snapshot!.fingerprint, source: master, handoff: true })).toMatchObject({ outcome: "escalated", coordinationEscalation: chain })
      expect((yield* service.get(asked.id)).coordinationEscalation).toEqual(chain)
      expect((yield* service.snapshot(asked.id))!.fingerprint).toBe(snapshot!.fingerprint)
      expect(refreshed).toEqual([
        { sessionID, kind: "question", requestID: asked.id, coordinationEscalation: { reasons: [chain.reasons[0]] } },
        { sessionID, kind: "question", requestID: asked.id, coordinationEscalation: chain },
      ])
      yield* service.deferPending(sessionID)
      expect(yield* Fiber.join(waiting)).toMatchObject({ status: "deferred" })
      expect(deferred).toHaveLength(1)
      expect(deferred[0]!.payload).toMatchObject({ type: "form", coordinationEscalation: chain })
      expect(yield* service.escalate({ id: asked.id, fingerprint: snapshot!.fingerprint, source: { ...master, rationale: "After sleep." }, handoff: true })).toMatchObject({
        outcome: "escalated", reason: "deferred-to-review-box", reviewItemID: deferred[0]!.itemID, coordinationEscalation: chain,
      })
      expect(refreshed).toHaveLength(2)
    }),
  )
})

const nativeSessionID = SessionSchema.ID.make("ses_coord_native")
const nativeProject = "/workspace/project"
const coordinatorSource = {
  coordinatorSessionID: SessionSchema.ID.make("ses_coord"),
  groupID: "cgrp_one",
  rationale: "Assigned routine work.",
}

const nativeGraded = (request: Decision.Input, scores: Record<string, number>) =>
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

const matchConfirmed = Schema.decodeUnknownSync(Decision.Output)({
  provider: "agent",
  response: {
    model: { providerID: "test", id: "decision-model" },
    semantics: "model-estimate",
    version: 1,
    answers: [{ name: "guardrail_match", type: "choice", answer: null, choice: "deny", score: null, confidence: 1 }],
  },
})

function nativeHarness(scores: ReadonlyArray<Record<string, number>>) {
  const choices: Decision.Input[] = []
  const filesystem = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...fs,
        scan: () => Effect.succeed([] as string[]),
        readFileStringSafe: () => Effect.succeed(undefined),
      })
    }),
  ).pipe(Layer.provide(FSUtil.layer), Layer.provide(NodeFileSystem.layer))
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
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(nativeProject) },
                { projectDirectory: AbsolutePath.make(nativeProject) },
              ),
            ),
          ),
        ],
        [
          Decision.node,
          Layer.mock(Decision.Service, {
            evaluate: (request: Decision.Input) => {
              if (request.request.questions[0]?.name === "guardrail_match") return Effect.succeed(matchConfirmed)
              choices.push(request)
              return Effect.succeed(nativeGraded(request, scores[choices.length - 1] ?? scores.at(-1) ?? { escalate: 0.95 }))
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
                  info: Schema.decodeUnknownSync(Config.Info)({ guardrails: { decide_reviews: true } }),
                }),
              ]),
          }),
        ],
        [
          Global.node,
          Global.layerWith({
            home: path.resolve("/home/user"),
            data: "/ycoding/data",
            config: "/global",
            cache: "/ycoding/cache",
            state: "/ycoding/state",
          }),
        ],
        [LocationMutation.node, Layer.mock(LocationMutation.Service, { repositoryWorktree: () => Effect.succeed(false) })],
        [FSUtil.node, filesystem],
      ],
    ),
  )
  return { it, choices }
}

const nativeSetup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(nativeProject), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: nativeSessionID,
      project_id: Project.ID.global,
      directory: nativeProject,
      title: "Coordination native",
      agent: "test",
    })
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

function captureNativeEvents() {
  return Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const assessed: Array<Record<string, unknown>> = []
    const permissionReplied: Array<Record<string, unknown>> = []
    const guardrailDecided: Array<Record<string, unknown>> = []
    const guardrailReplied: Array<Record<string, unknown>> = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        const data = event.data as Record<string, unknown>
        if (event.type === SessionEvent.PermissionAssessed.type) assessed.push(data)
        if (event.type === Permission.Event.Replied.type) permissionReplied.push(data)
        if (event.type === SessionEvent.GuardrailDecided.type) guardrailDecided.push(data)
        if (event.type === Guardrail.Event.Replied.type) guardrailReplied.push(data)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return { assessed, permissionReplied, guardrailDecided, guardrailReplied }
  })
}

describe("native coordinator Permission reconsideration", () => {
  const human = nativeHarness([{ allow: 0.99 }])
  for (const effect of ["allow", "deny"] as const)
    human.it.effect(`retains a human-only permission under current ${effect} rules`, () =>
      Effect.gen(function* () {
        yield* nativeSetup
        const service = yield* Permission.Service
        const agents = yield* Agent.Service
        yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "read", resource: "src/*", effect: "allow" }]
        }))
        const running = yield* service.assert({
          sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"], requireHuman: true,
        }).pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
          yield* Effect.yieldNow
        const pending = yield* service.forSession(nativeSessionID)
        expect(pending).toHaveLength(1)
        if (effect === "deny")
          yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
            agent.permissions = [{ action: "read", resource: "src/*", effect: "deny" }]
          }))
        const snapshot = yield* service.snapshot(pending[0]!.id)
        const result = yield* service.reconsider({
          requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint,
          actor: "coordinator", source: coordinatorSource, validate: () => Effect.succeed(true),
        })
        expect(result).toMatchObject(effect === "allow"
          ? { outcome: "escalated", settled: false, reason: "human-only:request" }
          : { outcome: "denied", settled: true, via: "permission-rules" })
        expect(human.choices).toHaveLength(0)
        expect(CoordinationDecisions.humanOnlyReason({
          kind: "permission", action: "read", resources: ["src/notes.txt"], metadata: { requireHuman: true },
        })).toBe("human-only:request")
        if (effect === "allow") expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
        if (effect === "deny") expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      }),
    )

  const allowed = nativeHarness([{ escalate: 0.95 }, { allow: 0.95 }])
  allowed.it.effect("settles a pending ask through the native assessment with coordinator attribution and unchanged autonomy", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const autonomy = yield* SessionAutonomy.Service
      const captured = yield* captureNativeEvents()
      const before = yield* autonomy.snapshot(nativeSessionID)
      expect(before.state.yolo).toBe(false)
      expect(before.state.autoPermission).toBeUndefined()

      const running = yield* service
        .assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"] })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      expect(pending).toHaveLength(1)
      expect(allowed.choices).toHaveLength(1)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      expect(snapshot).toBeDefined()

      const revoked = yield* service.reconsider({
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(false),
      })
      expect(revoked).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-invalid" })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(allowed.choices).toHaveLength(1)

      const result = yield* service.reconsider({
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "baseline" })
      expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
      expect(allowed.choices).toHaveLength(2)
      const allowEvents = captured.assessed.filter((event) => event.outcome === "allow")
      expect(allowEvents).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id,
          outcome: "allow",
          via: "baseline",
          reply: "once",
          choice: "allow",
          actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID,
          groupID: "cgrp_one",
          rationale: "Assigned routine work.",
        }),
      ])
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "once" }])
      expect((yield* autonomy.snapshot(nativeSessionID)).state).toEqual(before.state)

      const second = yield* service.reconsider({
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(second).toMatchObject({ outcome: "stale", settled: false })
      expect(captured.assessed.filter((event) => event.outcome === "allow")).toHaveLength(1)
    }),
  )

  const denied = nativeHarness([{ escalate: 0.95 }])
  denied.it.effect("a deny rule current at reconsideration settles denied under the native lock without a second helper call", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const autonomy = yield* SessionAutonomy.Service
      const agents = yield* Agent.Service
      const captured = yield* captureNativeEvents()
      const before = yield* autonomy.snapshot(nativeSessionID)

      const running = yield* service
        .assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"] })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      expect(pending).toHaveLength(1)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "read", resource: "src/*", effect: "deny" }]
        }),
      )

      const result = yield* service.reconsider({
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "permission-rules" })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(denied.choices).toHaveLength(1)
      expect(captured.assessed.filter((event) => event.outcome === "deny")).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id,
          outcome: "deny",
          via: "coordination",
          reply: "reject",
          actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID,
          groupID: "cgrp_one",
          rationale: "Assigned routine work.",
        }),
      ])
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" }])
      expect((yield* autonomy.snapshot(nativeSessionID)).state).toEqual(before.state)
    }),
  )
})

describe("native coordinator Guardrail reconsideration", () => {
  const allowed = nativeHarness([{ escalate: 0.95 }, { allow: 0.95 }])
  allowed.it.effect("settles an ordinary pending review through the native assessment with coordinator attribution and unchanged autonomy", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const autonomy = yield* SessionAutonomy.Service
      const captured = yield* captureNativeEvents()
      const before = yield* autonomy.snapshot(nativeSessionID)
      expect(before.state.yolo).toBe(false)
      expect(before.state.autoGuardrail).toBeUndefined()

      const running = yield* service
        .assert({
          sessionID: nativeSessionID,
          action: "file_mutation",
          resources: ["/outside/notes/today.md"],
          metadata: { operation: "write" },
        })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.hardReview ?? false).toBe(false)
      expect(pending[0]!.ruleIDs).toEqual(["standard.review.outside-repo"])
      expect(allowed.choices).toHaveLength(1)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      expect(snapshot).toBeDefined()

      const revoked = yield* service.reconsider({
        sessionID: nativeSessionID,
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(false),
      })
      expect(revoked).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-invalid" })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(allowed.choices).toHaveLength(1)

      const result = yield* service.reconsider({
        sessionID: nativeSessionID,
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "baseline" })
      yield* (yield* Fiber.join(running)).release
      expect(allowed.choices).toHaveLength(2)
      expect(captured.guardrailDecided).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id,
          reply: "once",
          authority: "baseline",
          choice: "allow",
          actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID,
          groupID: "cgrp_one",
          rationale: "Assigned routine work.",
        }),
      ])
      expect(captured.guardrailReplied).toEqual([
        expect.objectContaining({ requestID: pending[0]!.id, reply: "once", decidedBy: "decision-model" }),
      ])
      expect((yield* autonomy.snapshot(nativeSessionID)).state).toEqual(before.state)

      const second = yield* service.reconsider({
        sessionID: nativeSessionID,
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(second).toMatchObject({ outcome: "stale", settled: false })
      expect(captured.guardrailDecided).toHaveLength(1)
    }),
  )

  const hard = nativeHarness([{ allow: 0.99 }, { allow: 0.99 }])
  hard.it.effect("a hard review stays human-owned at native reconsideration despite a confident helper allow", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const captured = yield* captureNativeEvents()

      const running = yield* service
        .assert({
          sessionID: nativeSessionID,
          action: "shell",
          resources: ["git push --force origin main"],
          metadata: { workdir: nativeProject },
        })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.hardReview).toBe(true)
      const choicesBefore = hard.choices.length
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)

      const result = yield* service.reconsider({
        sessionID: nativeSessionID,
        requestID: pending[0]!.id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: coordinatorSource,
        validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "human-only:hard-review" })
      expect(hard.choices).toHaveLength(choicesBefore)
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(captured.guardrailDecided).toEqual([])

      yield* service.reply({ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
    }),
  )
})

function captureEscalation() {
  return Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const refreshed: Array<Record<string, unknown>> = []
    const deferred: Array<SessionEvent.Review.Deferred["data"]> = []
    const guardrailEscalated: unknown[] = []
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        const data = event.data as Record<string, unknown>
        if (event.type === Coordination.Event.RequestEscalated.type) refreshed.push(data)
        if (event.type === SessionEvent.Review.Deferred.type) deferred.push(event.data as SessionEvent.Review.Deferred["data"])
        if (event.type === SessionEvent.GuardrailEscalated.type) guardrailEscalated.push(data)
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return { refreshed, deferred, guardrailEscalated }
  })
}

const driverSource = { coordinatorSessionID: SessionSchema.ID.make("ses_driver"), groupID: "cgrp_one", rationale: "Needs the owner's call." }
const masterSource = { coordinatorSessionID: SessionSchema.ID.make("ses_coord"), groupID: "cgrp_one", rationale: "Outside the recorded assignment." }
const fullChain = { reasons: [{ sessionID: driverSource.coordinatorSessionID, reason: driverSource.rationale }, { sessionID: masterSource.coordinatorSessionID, reason: masterSource.rationale }] }

describe("native coordinator Permission decline and escalation", () => {
  const declined = nativeHarness([{ escalate: 0.95 }])
  declined.it.effect("a decline rejects the pending ask natively with coordinator audit and the rationale as member feedback", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      const running = yield* service
        .assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"] })
        .pipe(Effect.flip, Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const result = yield* service.reconsider({
        requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      const error = yield* Fiber.join(running)
      expect(error).toBeInstanceOf(Permission.CorrectedError)
      expect((error as Permission.CorrectedError).feedback).toContain("Assigned routine work.")
      expect(declined.choices).toHaveLength(1)
      expect(captured.assessed.filter((event) => event.outcome === "deny")).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id, outcome: "deny", via: "coordination", reply: "reject", actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID, groupID: "cgrp_one", rationale: "Assigned routine work.",
        }),
      ])
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" }])
    }),
  )

  const human = nativeHarness([{ escalate: 0.95 }])
  human.it.effect("a decline never rejects a human-only ask or one the delegation no longer covers", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      yield* service.assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"], requireHuman: true }).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const decline = (valid: boolean) => service.reconsider({
        requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(valid),
      })
      expect(yield* decline(false)).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-invalid" })
      expect(yield* decline(true)).toMatchObject({ outcome: "escalated", settled: false, reason: "human-only:request" })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(captured.assessed.filter((event) => event.via === "coordination")).toEqual([])
    }),
  )

  const escalated = nativeHarness([{ escalate: 0.95 }])
  escalated.it.effect("driver and Master hops attach the full reason chain, audit the human handoff, and carry it into the review box", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      const chain = yield* captureEscalation()
      const running = yield* service
        .assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"] })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const escalate = (source: typeof driverSource, handoff: boolean, fingerprint = snapshot!.fingerprint) =>
        service.escalate({ sessionID: nativeSessionID, requestID: pending[0]!.id, fingerprint, source, handoff })
      expect(yield* escalate(driverSource, false, "stale")).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* escalate(driverSource, false)).toMatchObject({ outcome: "escalated", settled: false, coordinationEscalation: { reasons: [fullChain.reasons[0]] } })
      expect(captured.assessed.filter((event) => event.via === "coordination")).toEqual([])
      expect(yield* escalate(masterSource, true)).toMatchObject({ outcome: "escalated", coordinationEscalation: fullChain })
      expect(yield* escalate(masterSource, true)).toMatchObject({ outcome: "escalated", coordinationEscalation: fullChain })
      expect((yield* service.forSession(nativeSessionID))[0]!.coordinationEscalation).toEqual(fullChain)
      expect((yield* service.snapshot(pending[0]!.id))!.fingerprint).toBe(snapshot!.fingerprint)
      expect(chain.refreshed).toEqual([
        { sessionID: nativeSessionID, kind: "permission", requestID: pending[0]!.id, coordinationEscalation: { reasons: [fullChain.reasons[0]] } },
        { sessionID: nativeSessionID, kind: "permission", requestID: pending[0]!.id, coordinationEscalation: fullChain },
      ])
      expect(captured.assessed.filter((event) => event.via === "coordination")).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id, outcome: "escalate", via: "coordination", reason: "escalated", actor: "coordinator",
          coordinatorSessionID: masterSource.coordinatorSessionID, groupID: "cgrp_one", rationale: masterSource.rationale,
        }),
      ])
      for (const extra of ["Third hop.", "Fourth hop."])
        expect(yield* escalate({ ...masterSource, rationale: extra }, true)).toMatchObject({ outcome: "escalated" })
      const full = yield* escalate({ ...masterSource, rationale: "Fifth hop." }, true)
      expect(full).toMatchObject({ outcome: "escalated", reason: "escalation-chain-full" })
      expect(full.coordinationEscalation?.reasons).toHaveLength(4)
      const final = (yield* service.forSession(nativeSessionID))[0]!.coordinationEscalation!
      yield* service.deferPending(nativeSessionID)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(Permission.DeferredError)
      expect(chain.deferred).toHaveLength(1)
      expect(chain.deferred[0]!.payload).toMatchObject({ type: "permission", coordinationEscalation: final })
      const refreshes = chain.refreshed.length
      expect(yield* escalate({ ...masterSource, rationale: "After sleep." }, true)).toEqual({
        outcome: "escalated", requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, settled: false,
        reason: "deferred-to-review-box", reviewItemID: chain.deferred[0]!.itemID, coordinationEscalation: final,
      })
      expect(chain.refreshed).toHaveLength(refreshes)
    }),
  )
})

describe("native coordinator Guardrail decline and escalation", () => {
  const outside = { sessionID: nativeSessionID, action: "file_mutation", resources: ["/outside/notes/today.md"], metadata: { operation: "write" } }

  const declined = nativeHarness([{ escalate: 0.95 }])
  declined.it.effect("a decline rejects an ordinary review natively with coordinator audit and no model-incident escalation", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const captured = yield* captureNativeEvents()
      const chain = yield* captureEscalation()
      const running = yield* service.assert(outside).pipe(Effect.flip, Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      const choicesBefore = declined.choices.length
      const escalatedBefore = chain.guardrailEscalated.length
      const result = yield* service.reconsider({
        sessionID: nativeSessionID, requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator",
        source: coordinatorSource, decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      const error = yield* Fiber.join(running)
      expect(error).toBeInstanceOf(SessionGuardrail.DeclinedError)
      expect((error as SessionGuardrail.DeclinedError).message).toContain("Assigned routine work.")
      expect(declined.choices).toHaveLength(choicesBefore)
      expect(captured.guardrailDecided).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id, reply: "reject", actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID, groupID: "cgrp_one", rationale: "Assigned routine work.",
        }),
      ])
      expect(captured.guardrailDecided[0]).not.toHaveProperty("authority")
      expect(captured.guardrailReplied).toEqual([expect.objectContaining({ requestID: pending[0]!.id, reply: "reject" })])
      expect(captured.guardrailReplied[0]).not.toHaveProperty("decidedBy")
      expect(chain.guardrailEscalated).toHaveLength(escalatedBefore)
    }),
  )

  const hard = nativeHarness([{ allow: 0.99 }])
  hard.it.effect("a decline never rejects a hard review", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const captured = yield* captureNativeEvents()
      yield* service.assert({ sessionID: nativeSessionID, action: "shell", resources: ["git push --force origin main"], metadata: { workdir: nativeProject } }).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      const result = yield* service.reconsider({
        sessionID: nativeSessionID, requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator",
        source: coordinatorSource, decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "human-only:hard-review" })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(captured.guardrailDecided).toEqual([])
    }),
  )

  const escalated = nativeHarness([{ escalate: 0.95 }])
  escalated.it.effect("driver and Master hops attach the full reason chain without model-incident events and carry it into the review box", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const chain = yield* captureEscalation()
      const running = yield* service.assert(outside).pipe(Effect.flip, Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      const escalatedBefore = chain.guardrailEscalated.length
      const escalate = (source: typeof driverSource, handoff: boolean, fingerprint = snapshot!.fingerprint) =>
        service.escalate({ sessionID: nativeSessionID, requestID: pending[0]!.id, fingerprint, source, handoff })
      expect(yield* escalate(driverSource, false, "stale")).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* escalate(driverSource, false)).toMatchObject({ outcome: "escalated" })
      expect(yield* escalate(masterSource, true)).toMatchObject({ outcome: "escalated", coordinationEscalation: fullChain })
      expect((yield* service.forSession(nativeSessionID))[0]!.coordinationEscalation).toEqual(fullChain)
      expect((yield* service.requestSnapshot(nativeSessionID, pending[0]!.id))!.fingerprint).toBe(snapshot!.fingerprint)
      expect(chain.refreshed.at(-1)).toEqual({
        sessionID: nativeSessionID, rootSessionID: nativeSessionID, kind: "review", requestID: pending[0]!.id, coordinationEscalation: fullChain,
      })
      expect(chain.refreshed).toHaveLength(2)
      expect(chain.guardrailEscalated).toHaveLength(escalatedBefore)
      yield* service.deferPending(nativeSessionID)
      expect(yield* Fiber.join(running)).toBeInstanceOf(SessionGuardrail.DeferredError)
      expect(chain.deferred).toHaveLength(1)
      expect(chain.deferred[0]!.payload).toMatchObject({ type: "guardrail", coordinationEscalation: fullChain })
      expect(yield* escalate({ ...masterSource, rationale: "After sleep." }, true)).toMatchObject({
        outcome: "escalated", reason: "deferred-to-review-box", reviewItemID: chain.deferred[0]!.itemID, coordinationEscalation: fullChain,
      })
      expect(chain.refreshed).toHaveLength(2)
    }),
  )
})

describe("native escalation chain through CoordinationDecisions", () => {
  const chainHarness = nativeHarness([{ escalate: 0.95 }])
  const scope = {
    groupID: "cgrp_one", masterSessionID: masterSource.coordinatorSessionID, memberSessionIDs: [nativeSessionID],
    active: false, settings: { concurrency: null },
  }
  const decisionsOver = Effect.gen(function* () {
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    return CoordinationDecisions.make({
      policy: () => Effect.succeed({ enabled: false, categories: [] }) as never,
      scopeOf: (sessionID) => Effect.succeed(sessionID === masterSource.coordinatorSessionID || sessionID === driverSource.coordinatorSessionID ? (scope as never) : undefined),
      permission,
      guardrail,
      form: { snapshot: () => Effect.succeed(undefined), snapshots: () => Effect.succeed([]), reconsider: () => Effect.die("unused"), escalate: () => Effect.die("unused") },
    })
  })
  const input = (coordinatorSessionID: SessionSchema.ID, kind: "permission" | "review", requestID: string, fingerprint: string, reason: string) =>
    ({ groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID, targetSessionID: nativeSessionID, requestID, kind, fingerprint, reason })

  chainHarness.it.effect("a driver hop reaches the Master, the Master hop reaches the human, and an inactive revoked Project blocks neither", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const decisions = yield* decisionsOver
      const captured = yield* captureNativeEvents()
      yield* service.assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"] }).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const driver = yield* decisions.escalate(input(driverSource.coordinatorSessionID, "permission", pending[0]!.id, snapshot!.fingerprint, driverSource.rationale))
      expect(driver).toMatchObject({ outcome: "escalated", to: "master", coordinationEscalation: { reasons: [fullChain.reasons[0]] } })
      const master = yield* decisions.escalate(input(masterSource.coordinatorSessionID, "permission", pending[0]!.id, snapshot!.fingerprint, masterSource.rationale))
      expect(master).toMatchObject({ outcome: "escalated", to: "human", coordinationEscalation: fullChain })
      expect((yield* service.forSession(nativeSessionID))[0]!.coordinationEscalation).toEqual(fullChain)
      expect(captured.assessed.filter((event) => event.via === "coordination" && event.outcome === "escalate")).toHaveLength(1)
      expect(captured.permissionReplied).toEqual([])
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      for (const reason of ["Third hop.", "Fourth hop."])
        yield* decisions.escalate(input(driverSource.coordinatorSessionID, "permission", pending[0]!.id, snapshot!.fingerprint, reason))
      const full = yield* decisions.escalate(input(driverSource.coordinatorSessionID, "permission", pending[0]!.id, snapshot!.fingerprint, "Fifth hop."))
      expect(full).toMatchObject({ outcome: "escalated", reason: "escalation-chain-full" })
      expect(full.to).toBeUndefined()
      expect(full.coordinationEscalation?.reasons.map((item) => item.reason)).not.toContain("Fifth hop.")
      const fullHandoff = yield* decisions.escalate(input(masterSource.coordinatorSessionID, "permission", pending[0]!.id, snapshot!.fingerprint, "Fifth hop."))
      expect(fullHandoff.to).toBeUndefined()
      expect(captured.assessed.filter((event) => event.via === "coordination" && event.outcome === "escalate")).toHaveLength(1)
    }),
  )

  const direct = nativeHarness([{ escalate: 0.95 }])
  direct.it.effect("with no driver the Master hands a review straight to the human, and a deferred review reports its review-box item", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const decisions = yield* decisionsOver
      const chain = yield* captureEscalation()
      yield* service.assert({ sessionID: nativeSessionID, action: "file_mutation", resources: ["/outside/notes/today.md"], metadata: { operation: "write" } }).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      const master = yield* decisions.escalate(input(masterSource.coordinatorSessionID, "review", pending[0]!.id, snapshot!.fingerprint, masterSource.rationale))
      expect(master).toMatchObject({ outcome: "escalated", to: "human", coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      yield* service.deferPending(nativeSessionID)
      const after = yield* decisions.escalate(input(driverSource.coordinatorSessionID, "review", pending[0]!.id, snapshot!.fingerprint, driverSource.rationale))
      expect(after).toMatchObject({ outcome: "escalated", reason: "deferred-to-review-box", reviewItemID: chain.deferred[0]!.itemID, coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(after.to).toBeUndefined()
      expect(yield* decisions.escalate(input(masterSource.coordinatorSessionID, "review", pending[0]!.id, "stale", masterSource.rationale))).toMatchObject({ outcome: "stale" })
    }),
  )
})
