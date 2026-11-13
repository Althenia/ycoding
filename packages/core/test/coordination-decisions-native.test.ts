import path from "path"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { NodeFileSystem } from "@effect/platform-node"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
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
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
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
  yield* autonomy.set({ sessionID, answers: "yolo" })
})

describe("native coordinator Form reconsideration", () => {
  it.effect("settles a coordinator-selected valid answer under YOLO answers with source and rationale and unchanged autonomy", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* Form.Service
      const autonomy = yield* SessionAutonomy.Service
      const events = yield* EventRuntime.Service
      const before = yield* autonomy.snapshot(sessionID)
      expect(before.state.answers).toBe("yolo")
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
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "manual" })
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

  const reconsiderForm = (id: Form.ID, answer?: Form.Answer) =>
    Effect.gen(function* () {
      const service = yield* Form.Service
      const snapshot = yield* service.snapshot(id)
      return yield* service.reconsider({
        id,
        fingerprint: snapshot!.fingerprint,
        actor: "coordinator",
        source: { coordinatorSessionID: "ses_coord", groupID: "cgrp_one", rationale: "Assigned branch in the task." },
        ...(answer === undefined ? {} : { answer, confidence: 0.95 }),
        validate: () => Effect.succeed(true),
      })
    })

  it.effect("Manual answers settle a coordinator's explicit answer, including on an explicit-decision Form, and require one to settle", () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "manual" })
      const service = yield* Form.Service
      const recommended = {
        ...form,
        id: Form.ID.create("frm_coord_manual"),
        fields: [{ key: "branch", type: "string", required: true, default: "safe", options: [{ value: "safe", label: "Safe (Recommended)" }] }],
      } satisfies Form.CreateInput
      yield* service.create(recommended)
      expect(yield* reconsiderForm(recommended.id)).toMatchObject({
        outcome: "escalated",
        settled: false,
        reason: "answer-required",
      })
      expect(yield* service.state(recommended.id)).toEqual({ status: "pending" })
      expect(yield* reconsiderForm(recommended.id, { branch: "safe" })).toMatchObject({
        outcome: "allowed",
        settled: true,
        via: "coordination",
        source: { kind: "coordinator", coordinatorSessionID: "ses_coord", groupID: "cgrp_one", via: "coordination" },
      })
      expect(yield* service.state(recommended.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      const explicit = { ...recommended, id: Form.ID.create("frm_coord_manual_explicit"), metadata: { requireExplicitDecision: true } } satisfies Form.CreateInput
      yield* service.create(explicit)
      expect(yield* reconsiderForm(explicit.id)).toMatchObject({ outcome: "escalated", settled: false, reason: "answer-required" })
      expect(yield* reconsiderForm(explicit.id, { branch: "safe" })).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      expect(yield* service.state(explicit.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      expect((yield* autonomy.snapshot(sessionID)).state.answers).toBe("manual")
    }),
  )

  for (const mode of ["auto", "yolo"] as const) it.effect(`${mode} answers settle a coordinator answer to a canonical explicit-decision Form and refuse it without an answer`, () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: mode })
      const service = yield* Form.Service
      for (const flag of [true, false, "true", undefined]) {
        const explicit = {
          ...form, id: Form.ID.create(), title: "requireExplicitDecision",
          metadata: { ...(flag === undefined ? {} : { requireExplicitDecision: flag }), note: "requireExplicitDecision: true" },
          fields: [{ key: "branch", title: "requireExplicitDecision", type: "string", required: true, default: "safe", options: [{ value: "safe", label: "Safe (Recommended)" }] }],
        } satisfies Form.CreateInput
        yield* service.create(explicit)
        if (flag === true) {
          expect(yield* reconsiderForm(explicit.id)).toMatchObject({ outcome: "escalated", settled: false, reason: "answer-required" })
          expect(yield* service.state(explicit.id)).toEqual({ status: "pending" })
        }
        expect(yield* reconsiderForm(explicit.id, { branch: "safe" })).toMatchObject({ outcome: "allowed", settled: true })
        expect(yield* service.state(explicit.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      }
    }),
  )

  for (const mode of ["auto", "yolo"] as const) it.effect(`holds a canonical explicit-decision Form ask under ${mode} answers`, () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: mode })
      const service = yield* Form.Service
      const events = yield* EventRuntime.Service
      const created = yield* Deferred.make<void>()
      const id = Form.ID.create("frm_explicit_ask")
      const stop = yield* events.listen((event) => event.type === Form.Event.Created.type ? Deferred.succeed(created, undefined).pipe(Effect.asVoid) : Effect.void)
      yield* Effect.addFinalizer(() => stop)
      const waiting = yield* service.ask({ ...form, id, metadata: { requireExplicitDecision: true },
        fields: [{ key: "branch", type: "string", required: true, default: "safe", options: [{ value: "safe", label: "Safe (Recommended)" }] }],
      }).pipe(Effect.forkScoped)
      yield* Deferred.await(created)
      yield* TestClock.adjust("1 millis")
      expect(yield* service.state(id)).toEqual({ status: "pending" })
      yield* service.reply({ id, answer: { branch: "safe" } })
      expect(yield* Fiber.join(waiting)).toEqual({ status: "answered", answer: { branch: "safe" } })
    }),
  )

  it.effect("Auto answers settle a coordinator's explicit answer and, without one, only the deterministic answer", () =>
    Effect.gen(function* () {
      yield* setup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, answers: "auto" })
      const service = yield* Form.Service
      const text = { ...form, id: Form.ID.create("frm_coord_auto_text"), fields: [{ key: "note", type: "string", required: true }] } satisfies Form.CreateInput
      yield* service.create(text)
      expect(yield* reconsiderForm(text.id)).toMatchObject({ outcome: "escalated", settled: false })
      expect(yield* service.state(text.id)).toEqual({ status: "pending" })
      expect(yield* reconsiderForm(text.id, { note: "coordinator text" })).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      expect(yield* service.state(text.id)).toEqual({ status: "answered", answer: { note: "coordinator text" } })

      const choice = {
        ...form,
        id: Form.ID.create("frm_coord_auto_choice"),
        fields: [
          {
            key: "branch",
            type: "string",
            required: true,
            options: [
              { value: "safe", label: "Safe (Recommended)" },
              { value: "fast", label: "Fast" },
            ],
          },
        ],
      } satisfies Form.CreateInput
      yield* service.create(choice)
      expect(yield* reconsiderForm(choice.id)).toMatchObject({ outcome: "allowed", settled: true, via: "auto-answer" })
      expect(yield* service.state(choice.id)).toEqual({ status: "answered", answer: { branch: "safe" } })
      const chosen = { ...choice, id: Form.ID.create("frm_coord_auto_chosen") } satisfies Form.CreateInput
      yield* service.create(chosen)
      expect(yield* reconsiderForm(chosen.id, { branch: "fast" })).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      expect(yield* service.state(chosen.id)).toEqual({ status: "answered", answer: { branch: "fast" } })
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
          sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"], requireExplicitDecision: true,
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
          ? { outcome: "escalated", settled: false, reason: "explicit-decision:request" }
          : { outcome: "denied", settled: true, via: "permission-rules" })
        expect(human.choices).toHaveLength(0)
        expect(CoordinationDecisions.explicitDecisionReason({
          kind: "permission", action: "read", resources: ["src/notes.txt"], metadata: { requireExplicitDecision: true },
        })).toBe("explicit-decision:request")
        if (effect === "allow") expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
        if (effect === "deny") expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      }),
    )

  const allowed = nativeHarness([{ escalate: 0.95 }, { allow: 0.95 }])
  allowed.it.effect("settles a pending ask through the YOLO permission evaluator with coordinator attribution and unchanged autonomy", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const autonomy = yield* SessionAutonomy.Service
      const captured = yield* captureNativeEvents()
      yield* autonomy.set({ sessionID: nativeSessionID, permissions: "yolo" })
      const before = yield* autonomy.snapshot(nativeSessionID)

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
      expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "yolo" })
      expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
      expect(allowed.choices).toHaveLength(2)
      const allowEvents = captured.assessed.filter((event) => event.outcome === "allow")
      expect(allowEvents).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id,
          outcome: "allow",
          via: "yolo",
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
  denied.it.effect("a deny rule current at reconsideration settles a Manual ask denied under the native lock without a helper call", () =>
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
      expect(denied.choices).toHaveLength(0)
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

describe("native coordinator reconsideration under Manual and Auto", () => {
  for (const mode of ["manual", "auto"] as const) {
    const permission = nativeHarness([{ allow: 0.99 }])
    permission.it.effect(`a ${mode} permission ask never reaches a model at reconsideration`, () =>
      Effect.gen(function* () {
        yield* nativeSetup
        const service = yield* Permission.Service
        const running = yield* service
          .assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"], ...(mode === "auto" ? { requireExplicitDecision: true } : {}) })
          .pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
          yield* Effect.yieldNow
        const pending = yield* service.forSession(nativeSessionID)
        expect(pending).toHaveLength(1)
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID: nativeSessionID, permissions: mode })
        const snapshot = yield* service.snapshot(pending[0]!.id)
        const result = yield* service.reconsider({
          requestID: pending[0]!.id,
          fingerprint: snapshot!.fingerprint,
          actor: "coordinator",
          source: coordinatorSource,
          validate: () => Effect.succeed(true),
        })
        expect(result).toMatchObject({
          outcome: "escalated",
          settled: false,
          reason: mode === "manual" ? "native-assessment-unavailable" : "explicit-decision:request",
        })
        expect(permission.choices).toHaveLength(0)
        yield* service.reply({ requestID: pending[0]!.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      }),
    )

    const review = nativeHarness([{ allow: 0.99 }])
    review.it.effect(`a ${mode} ordinary review is ${mode === "auto" ? "approved by rule" : "kept human-only"} at reconsideration without a model`, () =>
      Effect.gen(function* () {
        yield* nativeSetup
        const service = yield* SessionGuardrail.Service
        const running = yield* service
          .assert({ sessionID: nativeSessionID, action: "file_mutation", resources: ["/outside/notes/today.md"], metadata: { operation: "write" } })
          .pipe(Effect.forkScoped)
        for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
          yield* Effect.yieldNow
        const pending = yield* service.forSession(nativeSessionID)
        expect(pending).toHaveLength(1)
        const autonomy = yield* SessionAutonomy.Service
        yield* autonomy.set({ sessionID: nativeSessionID, guardrails: mode })
        const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
        const result = yield* service.reconsider({
          sessionID: nativeSessionID,
          requestID: pending[0]!.id,
          fingerprint: snapshot!.fingerprint,
          actor: "coordinator",
          source: coordinatorSource,
          validate: () => Effect.succeed(true),
        })
        expect(review.choices).toHaveLength(0)
        if (mode === "auto") {
          expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "auto-guardrail" })
          yield* (yield* Fiber.join(running)).release
          return
        }
        expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "native-assessment-unavailable" })
        yield* service.reply({ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      }),
    )
  }
})

describe("native coordinator Guardrail reconsideration", () => {
  const allowed = nativeHarness([{ escalate: 0.95 }, { allow: 0.95 }])
  allowed.it.effect("settles an ordinary pending review through the YOLO guardrail evaluator with coordinator attribution and unchanged autonomy", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const autonomy = yield* SessionAutonomy.Service
      const captured = yield* captureNativeEvents()
      yield* autonomy.set({ sessionID: nativeSessionID, guardrails: "yolo" })
      const before = yield* autonomy.snapshot(nativeSessionID)

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
      expect(result).toMatchObject({ outcome: "allowed", settled: true, via: "yolo" })
      yield* (yield* Fiber.join(running)).release
      expect(allowed.choices).toHaveLength(2)
      expect(captured.guardrailDecided).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id,
          reply: "once",
          authority: "yolo",
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
      expect(result).toMatchObject({ outcome: "escalated", settled: false, reason: "explicit-decision:hard-review" })
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
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: nativeSessionID, permissions: "yolo" })
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

  const manualDecline = nativeHarness([{ allow: 0.99 }])
  manualDecline.it.effect("a coordinator decline under Manual permissions rejects the ask natively without a helper call", () =>
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
      expect(pending).toHaveLength(1)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const result = yield* service.reconsider({
        requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(manualDecline.choices).toHaveLength(0)
      expect(yield* Fiber.join(running)).toBeInstanceOf(Permission.CorrectedError)
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" }])
    }),
  )

  const pendingAsk = (action: string, resources: ReadonlyArray<string>) => Effect.gen(function* () {
    const service = yield* Permission.Service
    const running = yield* service.assert({ sessionID: nativeSessionID, action, resources: [...resources] }).pipe(Effect.exit, Effect.forkScoped)
    for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
      yield* Effect.yieldNow
    const pending = yield* service.forSession(nativeSessionID)
    expect(pending).toHaveLength(1)
    const snapshot = yield* service.snapshot(pending[0].id)
    const approve = service.reconsider({
      requestID: pending[0].id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
      decision: "approve", validate: () => Effect.succeed(true),
    })
    return { service, running, pending: pending[0], approve }
  })

  const manualApprove = nativeHarness([{ deny: 0.99 }])
  manualApprove.it.effect("a coordinator approval under Manual permissions allows a routine ask once without a helper call", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const captured = yield* captureNativeEvents()
      const ask = yield* pendingAsk("shell", ["bun test"])
      expect(yield* ask.approve).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      expect(Exit.isSuccess(yield* Fiber.join(ask.running))).toBe(true)
      expect(manualApprove.choices).toHaveLength(0)
      expect(yield* ask.service.forSession(nativeSessionID)).toEqual([])
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: ask.pending.id, reply: "once" }])
      expect(captured.assessed).toEqual([expect.objectContaining({
        requestID: ask.pending.id, outcome: "allow", via: "coordination", reply: "once", actor: "coordinator",
        coordinatorSessionID: coordinatorSource.coordinatorSessionID, rationale: "Assigned routine work.",
      })])
    }),
  )

  const deniedApprove = nativeHarness([{ allow: 0.99 }])
  deniedApprove.it.effect("a coordinator approval never overrides a deny rule current at reconsideration", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const ask = yield* pendingAsk("shell", ["bun test"])
      const agents = yield* Agent.Service
      yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "shell", resource: "*", effect: "deny" }]
      }))
      expect(yield* ask.approve).toMatchObject({ outcome: "denied", settled: true, via: "permission-rules" })
      expect(Exit.isFailure(yield* Fiber.join(ask.running))).toBe(true)
      expect(deniedApprove.choices).toHaveLength(0)
    }),
  )

  const unclassified = nativeHarness([{ escalate: 0.95 }])
  unclassified.it.effect("a decline of an unclassified ask unblocks the waiting tool exactly once, and a stale fingerprint settles nothing", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: nativeSessionID, permissions: "yolo" })
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      const running = yield* service
        .assert({ sessionID: nativeSessionID, action: "mcp_execute", resources: ["ycoding/session_prompt"] })
        .pipe(Effect.flip, Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const decline = (fingerprint: string) => service.reconsider({
        requestID: pending[0]!.id, fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(yield* decline(`${snapshot!.fingerprint}x`)).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(captured.permissionReplied).toEqual([])

      expect(yield* decline(snapshot!.fingerprint)).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      const error = yield* Fiber.join(running)
      expect(error).toBeInstanceOf(Permission.CorrectedError)
      expect((error as Permission.CorrectedError).feedback).toContain("Assigned routine work.")
      expect(yield* decline(snapshot!.fingerprint)).toMatchObject({ outcome: "stale", settled: false })
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0]!.id, reply: "reject" }])
      expect(captured.assessed.filter((event) => event.via === "coordination")).toEqual([
        expect.objectContaining({
          requestID: pending[0]!.id, outcome: "deny", reply: "reject", actor: "coordinator",
          coordinatorSessionID: coordinatorSource.coordinatorSessionID, groupID: "cgrp_one", rationale: "Assigned routine work.",
        }),
      ])
    }),
  )

  const unclassifiedManual = nativeHarness([{ allow: 0.99 }])
  unclassifiedManual.it.effect("a decline of an unclassified ask under Manual permissions rejects it natively", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      yield* service
        .assert({ sessionID: nativeSessionID, action: "mcp_execute", resources: ["ycoding/session_prompt"] })
        .pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      expect(yield* service.reconsider({
        requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(true),
      })).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(unclassifiedManual.choices).toHaveLength(0)
      expect(captured.permissionReplied).toEqual([{ sessionID: nativeSessionID, requestID: pending[0].id, reply: "reject" }])
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
    }),
  )

  const human = nativeHarness([{ escalate: 0.95 }])
  human.it.effect("a decline rejects an explicit-decision ask natively but never one the delegation no longer covers", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* Permission.Service
      const captured = yield* captureNativeEvents()
      yield* service.assert({ sessionID: nativeSessionID, action: "read", resources: ["src/notes.txt"], requireExplicitDecision: true }).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      const snapshot = yield* service.snapshot(pending[0]!.id)
      const decline = (valid: boolean) => service.reconsider({
        requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator", source: coordinatorSource,
        decision: "decline", validate: () => Effect.succeed(valid),
      })
      expect(yield* decline(false)).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-invalid" })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      expect(yield* decline(true)).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
      expect(captured.assessed.filter((event) => event.via === "coordination")).toEqual([expect.objectContaining({ outcome: "deny", reply: "reject", actor: "coordinator" })])
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
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID: nativeSessionID, guardrails: "yolo" })
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

  const manualReviewDecline = nativeHarness([{ allow: 0.99 }])
  manualReviewDecline.it.effect("a coordinator decline under Manual guardrails rejects the review natively without a helper call", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const service = yield* SessionGuardrail.Service
      const captured = yield* captureNativeEvents()
      const running = yield* service.assert(outside).pipe(Effect.forkScoped)
      for (let attempt = 0; attempt < 200 && (yield* service.forSession(nativeSessionID)).length === 0; attempt++)
        yield* Effect.yieldNow
      const pending = yield* service.forSession(nativeSessionID)
      expect(pending).toHaveLength(1)
      const snapshot = yield* service.requestSnapshot(nativeSessionID, pending[0]!.id)
      const result = yield* service.reconsider({
        sessionID: nativeSessionID, requestID: pending[0]!.id, fingerprint: snapshot!.fingerprint, actor: "coordinator",
        source: coordinatorSource, decision: "decline", validate: () => Effect.succeed(true),
      })
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(manualReviewDecline.choices).toHaveLength(0)
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
      expect(captured.guardrailDecided).toEqual([expect.objectContaining({ requestID: pending[0].id, reply: "reject", actor: "coordinator" })])
      expect(captured.guardrailReplied).toEqual([expect.objectContaining({ requestID: pending[0]!.id, reply: "reject" })])
    }),
  )

  const hard = nativeHarness([{ allow: 0.99 }])
  hard.it.effect("a decline rejects a hard review natively", () =>
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
      expect(result).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
      expect(captured.guardrailDecided).toEqual([expect.objectContaining({ requestID: pending[0].id, reply: "reject", actor: "coordinator" })])
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
      accessOf: (sessionID) => Effect.succeed(sessionID === masterSource.coordinatorSessionID || sessionID === driverSource.coordinatorSessionID
        ? { scope, role: sessionID === masterSource.coordinatorSessionID ? "master" : "supervisor", ownedSessionIDs: [nativeSessionID] } as never : undefined),
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
      expect(master).toMatchObject({ outcome: "escalated", to: "client", coordinationEscalation: fullChain })
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
      expect(master).toMatchObject({ outcome: "escalated", to: "client", coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      yield* service.deferPending(nativeSessionID)
      const after = yield* decisions.escalate(input(driverSource.coordinatorSessionID, "review", pending[0]!.id, snapshot!.fingerprint, driverSource.rationale))
      expect(after).toMatchObject({ outcome: "escalated", reason: "deferred-to-review-box", reviewItemID: chain.deferred[0]!.itemID, coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(after.to).toBeUndefined()
      expect(yield* decisions.escalate(input(masterSource.coordinatorSessionID, "review", pending[0]!.id, "stale", masterSource.rationale))).toMatchObject({ outcome: "stale" })
    }),
  )
})

describe("native owner settlement of every delegation class through CoordinationDecisions", () => {
  const ownerDecisions = (memberSessionIDs: ReadonlyArray<SessionSchema.ID> = [nativeSessionID]) => Effect.gen(function* () {
    const permission = yield* Permission.Service
    const guardrail = yield* SessionGuardrail.Service
    const scope: CoordinationService.Scope = { groupID: Coordination.GroupID.make("cgrp_one"), masterSessionID: masterSource.coordinatorSessionID, memberSessionIDs, active: true, settings: { concurrency: null } }
    return CoordinationDecisions.make({
      policy: () => Effect.succeed({ enabled: true, categories: ["question", "permission", "review"] as const }),
      accessOf: (sessionID) => Effect.succeed<CoordinationService.Access | undefined>(sessionID === masterSource.coordinatorSessionID || sessionID === driverSource.coordinatorSessionID
        ? { scope, role: sessionID === masterSource.coordinatorSessionID ? "master" : "supervisor", ownedSessionIDs: [nativeSessionID] } : undefined),
      permission,
      guardrail,
      form: { snapshot: () => Effect.succeed(undefined), snapshots: () => Effect.succeed([]), reconsider: () => Effect.die("unused"), escalate: () => Effect.die("unused") },
    })
  })
  const approve = (decisions: CoordinationDecisions.Interface, kind: "permission" | "review", requestID: string, fingerprint: string) =>
    decisions.evaluate({
      groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: driverSource.coordinatorSessionID, targetSessionID: nativeSessionID,
      kind, requestID, fingerprint, rationale: "Owner-approved within the assignment.", decision: "approve",
    })
  const pendingPermission = (input: { readonly action: string; readonly resources: ReadonlyArray<string>; readonly requireExplicitDecision?: true }, sessionID = nativeSessionID) => Effect.gen(function* () {
    const service = yield* Permission.Service
    const running = yield* service.assert({ sessionID, ...input, resources: [...input.resources] }).pipe(Effect.exit, Effect.forkScoped)
    for (let attempt = 0; attempt < 200 && (yield* service.forSession(sessionID)).length === 0; attempt++)
      yield* Effect.yieldNow
    const pending = yield* service.forSession(sessionID)
    expect(pending).toHaveLength(1)
    return { running, request: pending[0], fingerprint: (yield* service.snapshot(pending[0].id))!.fingerprint }
  })
  const pendingReview = (action: string, resources: ReadonlyArray<string>, metadata: Guardrail.Request["metadata"], sessionID = nativeSessionID) => Effect.gen(function* () {
    const service = yield* SessionGuardrail.Service
    const running = yield* service.assert({ sessionID, action, resources: [...resources], metadata }).pipe(Effect.exit, Effect.forkScoped)
    for (let attempt = 0; attempt < 200 && (yield* service.forSession(sessionID)).length === 0; attempt++)
      yield* Effect.yieldNow
    const pending = yield* service.forSession(sessionID)
    expect(pending).toHaveLength(1)
    return { running, request: pending[0], fingerprint: (yield* service.requestSnapshot(sessionID, pending[0].id))!.fingerprint }
  })

  const permissions = nativeHarness([{ deny: 0.99 }])
  permissions.it.effect("an owner approval under Manual permissions allows explicit-decision and unclassified asks once without a helper call", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions()
      const captured = yield* captureNativeEvents()
      const service = yield* Permission.Service
      const asks = [
        { action: "shell", resources: ["git push origin main"] },
        { action: "external_directory", resources: ["/outside/report/*"] },
        { action: "read", resources: ["src/notes.txt"], requireExplicitDecision: true as const },
        { action: "mcp_database_update", resources: ["src/a"] },
      ]
      for (const ask of asks) {
        const pending = yield* pendingPermission(ask)
        expect(yield* approve(decisions, "permission", pending.request.id, pending.fingerprint), ask.action).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
        expect(Exit.isSuccess(yield* Fiber.join(pending.running))).toBe(true)
        expect(yield* service.forSession(nativeSessionID)).toEqual([])
      }
      expect(permissions.choices).toHaveLength(0)
      expect(captured.permissionReplied.map((event) => event.reply)).toEqual(asks.map(() => "once"))
    }),
  )

  const ceiling = nativeHarness([{ allow: 0.99 }])
  ceiling.it.effect("an owner approval never allows an ask a permission ceiling or deny rule covers at settlement", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions()
      const database = yield* Database.Service
      const agents = yield* Agent.Service
      const capped = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] })
      yield* database.db.update(SessionTable).set({ permission: [{ action: "shell", resource: "git push*", effect: "deny" }] })
        .where(eq(SessionTable.id, nativeSessionID)).run().pipe(Effect.orDie)
      expect(yield* approve(decisions, "permission", capped.request.id, capped.fingerprint)).toMatchObject({ outcome: "denied", settled: true, via: "permission-rules" })
      expect(Exit.isFailure(yield* Fiber.join(capped.running))).toBe(true)
      const ruled = yield* pendingPermission({ action: "shell", resources: ["wrangler deploy"] })
      yield* agents.transform((editor) => editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [{ action: "shell", resource: "wrangler*", effect: "deny" }]
      }))
      expect(yield* approve(decisions, "permission", ruled.request.id, ruled.fingerprint)).toMatchObject({ outcome: "denied", settled: true, via: "permission-rules" })
      expect(Exit.isFailure(yield* Fiber.join(ruled.running))).toBe(true)
      expect(ceiling.choices).toHaveLength(0)
    }),
  )

  const reviews = nativeHarness([{ allow: 0.99 }])
  reviews.it.effect("an owner approval under Manual guardrails allows an outside-repository review and a hard review once without a helper call", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions()
      const captured = yield* captureNativeEvents()
      const service = yield* SessionGuardrail.Service
      const choicesBefore = reviews.choices.length
      for (const [action, resources, metadata, expected] of [
        ["file_mutation", ["/outside/notes/today.md"], { operation: "write" }, { ruleIDs: ["standard.review.outside-repo"] }],
        ["shell", ["git push --force origin main"], { workdir: nativeProject }, { hardReview: true }],
      ] as const) {
        const pending = yield* pendingReview(action, resources, metadata)
        expect(pending.request).toMatchObject(expected)
        expect(yield* approve(decisions, "review", pending.request.id, pending.fingerprint), action).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
        const exit = yield* Fiber.join(pending.running)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) yield* exit.value.release
        expect(yield* service.forSession(nativeSessionID)).toEqual([])
      }
      expect(reviews.choices).toHaveLength(choicesBefore)
      expect(captured.guardrailDecided).toEqual([0, 1].map(() => expect.objectContaining({
        reply: "once", actor: "coordinator", coordinatorSessionID: driverSource.coordinatorSessionID, rationale: "Owner-approved within the assignment.",
      })))
    }),
  )

  const escalation = nativeHarness([{ allow: 0.99 }])
  escalation.it.effect("a Master escalation of a settleable hard review still reaches the human, who settles it", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions()
      const service = yield* SessionGuardrail.Service
      const pending = yield* pendingReview("shell", ["git push --force origin main"], { workdir: nativeProject })
      const master = yield* decisions.escalate({
        groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: masterSource.coordinatorSessionID, targetSessionID: nativeSessionID,
        kind: "review", requestID: pending.request.id, fingerprint: pending.fingerprint, reason: masterSource.rationale,
      })
      expect(master).toMatchObject({ outcome: "escalated", to: "client", coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(yield* service.forSession(nativeSessionID)).toHaveLength(1)
      yield* service.reply({ sessionID: nativeSessionID, requestID: pending.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.join(pending.running))).toBe(true)
    }),
  )

  const settled = nativeHarness([{ allow: 0.99 }])
  settled.it.effect("an owner approval after the human settled an escalated review is stale and settles nothing", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions()
      const captured = yield* captureNativeEvents()
      const service = yield* SessionGuardrail.Service
      const pending = yield* pendingReview("file_mutation", ["/outside/notes/today.md"], { operation: "write" })
      expect(pending.request.ruleIDs).toEqual(["standard.review.outside-repo"])
      expect(yield* decisions.escalate({
        groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: masterSource.coordinatorSessionID, targetSessionID: nativeSessionID,
        kind: "review", requestID: pending.request.id, fingerprint: pending.fingerprint, reason: masterSource.rationale,
      })).toMatchObject({ outcome: "escalated", to: "client" })
      yield* service.reply({ sessionID: nativeSessionID, requestID: pending.request.id, reply: "once" })
      const exit = yield* Fiber.join(pending.running)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) yield* exit.value.release
      const decided = captured.guardrailDecided.length
      expect(yield* approve(decisions, "review", pending.request.id, pending.fingerprint)).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* decisions.evaluate({
        groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: masterSource.coordinatorSessionID, targetSessionID: nativeSessionID,
        kind: "review", requestID: pending.request.id, fingerprint: pending.fingerprint, rationale: "The user directed the Master to approve it.", decision: "approve",
      })).toMatchObject({ outcome: "stale", settled: false })
      expect(captured.guardrailDecided).toHaveLength(decided)
      expect(yield* service.forSession(nativeSessionID)).toEqual([])
    }),
  )

  const outsider = nativeHarness([{ allow: 0.99 }])
  outsider.it.effect("a non-member Session's hard review and explicit-decision ask stay with the human", () =>
    Effect.gen(function* () {
      yield* nativeSetup
      const decisions = yield* ownerDecisions([])
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const review = yield* pendingReview("shell", ["git push --force origin main"], { workdir: nativeProject })
      expect(yield* approve(decisions, "review", review.request.id, review.fingerprint)).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-out-of-scope" })
      expect(yield* guardrail.forSession(nativeSessionID)).toHaveLength(1)
      yield* guardrail.reply({ sessionID: nativeSessionID, requestID: review.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.join(review.running))).toBe(true)
      const ask = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] })
      expect(yield* approve(decisions, "permission", ask.request.id, ask.fingerprint)).toMatchObject({ outcome: "escalated", settled: false, reason: "delegation-out-of-scope" })
      expect(yield* permission.forSession(nativeSessionID)).toHaveLength(1)
      yield* permission.reply({ requestID: ask.request.id, reply: "once" })
      expect(Exit.isSuccess(yield* Fiber.join(ask.running))).toBe(true)
    }),
  )

  const childSessionID = SessionSchema.ID.make("ses_coord_native_child")
  const strangerSessionID = SessionSchema.ID.make("ses_coord_native_stranger")
  const familySetup = Effect.gen(function* () {
    yield* nativeSetup
    const database = yield* Database.Service
    yield* database.db
      .insert(SessionTable)
      .values([
        { id: childSessionID, project_id: Project.ID.global, parent_id: nativeSessionID, directory: nativeProject, title: "Member subagent", agent: "test" },
        { id: strangerSessionID, project_id: Project.ID.global, directory: nativeProject, title: "Outside the member family", agent: "test" },
      ])
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
  const settleFamily = (decisions: CoordinationDecisions.Interface, kind: "permission" | "review", requestID: string, fingerprint: string, decision: CoordinationDecisions.Decision) =>
    decisions.evaluate({
      groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: driverSource.coordinatorSessionID, targetSessionID: nativeSessionID,
      descendantSessionIDs: [childSessionID], kind, requestID, fingerprint, rationale: "Owner-approved within the assignment.", decision,
    })
  const escalateFamily = (decisions: CoordinationDecisions.Interface, kind: "permission" | "review", requestID: string, fingerprint: string) =>
    decisions.escalate({
      groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: masterSource.coordinatorSessionID, targetSessionID: nativeSessionID,
      descendantSessionIDs: [childSessionID], kind, requestID, fingerprint, reason: masterSource.rationale,
    })

  const descendant = nativeHarness([{ allow: 0.99 }])
  descendant.it.effect("an owner settles a member subagent's permission ask and outside-repository review through the member: approve allows once and decline rejects", () =>
    Effect.gen(function* () {
      yield* familySetup
      const decisions = yield* ownerDecisions()
      const captured = yield* captureNativeEvents()
      const permission = yield* Permission.Service
      const guardrail = yield* SessionGuardrail.Service
      const choicesBefore = descendant.choices.length
      const approved = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] }, childSessionID)
      expect(yield* settleFamily(decisions, "permission", approved.request.id, approved.fingerprint, "approve")).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      expect(Exit.isSuccess(yield* Fiber.join(approved.running))).toBe(true)
      const declined = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] }, childSessionID)
      expect(yield* settleFamily(decisions, "permission", declined.request.id, declined.fingerprint, "decline")).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(Exit.isFailure(yield* Fiber.join(declined.running))).toBe(true)
      expect(yield* permission.forSession(childSessionID)).toEqual([])
      expect(captured.permissionReplied.map((event) => [event.sessionID, event.reply])).toEqual([[childSessionID, "once"], [childSessionID, "reject"]])
      const review = yield* pendingReview("file_mutation", ["/outside/notes/today.md"], { operation: "write" }, childSessionID)
      expect(review.request).toMatchObject({ sessionID: childSessionID, ruleIDs: ["standard.review.outside-repo"] })
      expect(yield* settleFamily(decisions, "review", review.request.id, review.fingerprint, "decline")).toMatchObject({ outcome: "denied", settled: true, via: "coordination" })
      expect(Exit.isFailure(yield* Fiber.join(review.running))).toBe(true)
      const reviewed = yield* pendingReview("file_mutation", ["/outside/notes/today.md"], { operation: "write" }, childSessionID)
      expect(yield* settleFamily(decisions, "review", reviewed.request.id, reviewed.fingerprint, "approve")).toMatchObject({ outcome: "allowed", settled: true, via: "coordination" })
      const exit = yield* Fiber.join(reviewed.running)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) yield* exit.value.release
      expect(yield* guardrail.forSession(childSessionID)).toEqual([])
      expect(captured.guardrailDecided.map((event) => [event.reply, event.actor])).toEqual([["reject", "coordinator"], ["once", "coordinator"]])
      expect(descendant.choices).toHaveLength(choicesBefore)
    }),
  )

  const scoped = nativeHarness([{ allow: 0.99 }])
  scoped.it.effect("pending through the member lists its subagent's request, and a request outside the member's family stays out of reach", () =>
    Effect.gen(function* () {
      yield* familySetup
      const decisions = yield* ownerDecisions()
      const permission = yield* Permission.Service
      const child = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] }, childSessionID)
      const stranger = yield* pendingPermission({ action: "shell", resources: ["git push origin main"] }, strangerSessionID)
      const listed = yield* decisions.pending({
        groupID: Coordination.GroupID.make("cgrp_one"), coordinatorSessionID: driverSource.coordinatorSessionID, targetSessionID: nativeSessionID, descendantSessionIDs: [childSessionID],
      })
      expect(listed.map((item) => item.kind === "question" ? [item.form.id, item.form.sessionID] : [item.request.id, item.request.sessionID])).toEqual([[child.request.id, childSessionID]])
      expect(yield* settleFamily(decisions, "permission", stranger.request.id, stranger.fingerprint, "approve")).toMatchObject({ outcome: "stale", settled: false })
      expect(yield* escalateFamily(decisions, "permission", stranger.request.id, stranger.fingerprint)).toMatchObject({ outcome: "stale" })
      expect(yield* permission.forSession(strangerSessionID)).toEqual([expect.objectContaining({ id: stranger.request.id })])
      expect((yield* permission.forSession(strangerSessionID))[0]!.coordinationEscalation).toBeUndefined()
    }),
  )

  const handedOff = nativeHarness([{ allow: 0.99 }])
  handedOff.it.effect("a Master escalation of a member subagent's hard review reaches the human, who settles it", () =>
    Effect.gen(function* () {
      yield* familySetup
      const decisions = yield* ownerDecisions()
      const service = yield* SessionGuardrail.Service
      const pending = yield* pendingReview("shell", ["git push --force origin main"], { workdir: nativeProject }, childSessionID)
      expect(yield* escalateFamily(decisions, "review", pending.request.id, pending.fingerprint))
        .toMatchObject({ outcome: "escalated", to: "client", coordinationEscalation: { reasons: [fullChain.reasons[1]] } })
      expect(yield* service.forSession(childSessionID)).toEqual([expect.objectContaining({ id: pending.request.id, coordinationEscalation: { reasons: [fullChain.reasons[1]] } })])
      yield* service.reply({ sessionID: childSessionID, requestID: pending.request.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.join(pending.running))).toBe(true)
    }),
  )
})
