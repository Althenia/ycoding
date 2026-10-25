import path from "path"
import { describe, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { inArray, sql } from "drizzle-orm"
import { EventTable } from "@ycoding-ai/core/event/sql"
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
import { SessionPendingTable, SessionTable } from "@ycoding-ai/core/session/sql"
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

const graded = (request: Decision.Input, scores: Record<string, number>, evidence = "Bounded review evidence") =>
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
          ? question.choices.map((choice) => ({ choice: choice.value, confidence: scores[String(choice.value)] ?? 0, evidence }))
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
  readonly external?: { value: "ask" | "allow" }
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
        if (request.request.questions[0]?.name === "guardrail_match") return Effect.succeed(matchConfirmed)
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
    Layer.mock(Permission.Service, { evaluateEffective: () => Effect.sync(() => input.external?.value ?? "ask") }),
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

const seed = (options: { readonly yolo?: boolean; readonly guardrails?: "manual" | "yolo" | "auto"; readonly asleep?: boolean }) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: project, title: "yolo guardrails" }).onConflictDoNothing().run().pipe(Effect.orDie)
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID, guardrails: options.guardrails ?? (options.yolo ? "yolo" : "manual") })
    if (options.asleep) yield* autonomy.set({ sessionID, sleep: true })
  })

const state = (request: Decision.Input | undefined) => {
  const value = request?.request.state
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value
}

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

const recordSameCallPermission = (callID: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.PermissionAssessed, {
      sessionID,
      requestID: `per_${callID}`,
      outcome: "allow",
      via: "yolo",
      reply: "once",
      authority: "yolo",
      choice: "allow",
      confidence: 0.91,
      source: { messageID: source.messageID, callID },
    })
  })

describe("YOLO guardrail grading evidence", () => {
  const evidence = harness({ baseline: false, decide: (request) => Effect.succeed(graded(request, { escalate: 0.95 })) })
  evidence.it.effect("an outside write carries resolved targets, its operation, and only same-call permission settlements", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      yield* recordSameCallPermission(source.callID)
      yield* recordSameCallPermission("call_unrelated")
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert(outsideWrite).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(evidence.choices).toHaveLength(1)
      expect(state(evidence.choices[0])).toMatchObject({
        operation: "write",
        classifier: { resolvedTargets: [path.resolve("/outside/notes/today.md")] },
        directories: [path.resolve("/outside/notes")],
        applicability: {
          gate: "guardrail",
          sameCall: [{ gate: "permission", outcome: "allow", via: "yolo" }],
          prior: [],
        },
      })
      expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated" })
      yield* rejectPending(running)
    }),
  )

  const hard = harness({ baseline: false, decide: (request) => Effect.succeed(graded(request, { allow: 0.99 })) })
  hard.it.effect("same-call permission approval never lets a confident YOLO allow settle a hard review", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      yield* recordSameCallPermission(source.callID)
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert(forcePush).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(pending.hardReview).toBe(true)
      expect(pending.escalation).toMatchObject({ authority: "yolo", choice: "allow" })
      yield* rejectPending(running)
    }),
  )

  const invalid = harness({
    baseline: true,
    documents: [[`${guardrailDirectory}/broken.md`, "not a guardrail document"]],
    decide: (request) => Effect.succeed(graded(request, { allow: 0.99 })),
  })
  invalid.it.effect("an invalid guardrail configuration review is never model-approved", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert({ sessionID, action: "shell", resources: ["touch notes.txt"], metadata: { workdir: project } }).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(pending.ruleIDs).toEqual(["configuration.invalid"])
      expect(pending.escalation).toMatchObject({ reason: "escalated", choice: "allow" })
      yield* rejectPending(running)
    }),
  )
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
              if (request.request.questions[0]?.name === "guardrail_match") return Effect.succeed(matchConfirmed)
              choices.push(request)
              return Effect.succeed(graded(request, { escalate: 0.95 }))
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

describe("same-call human permission replies", () => {
  const replied = realPermissionHarness()
  replied.it.effect("a human once approval of the call's directory access reaches guardrail grading as evidence only", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: project, title: "same call", agent: "test" }).onConflictDoNothing().run().pipe(Effect.orDie)
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "yolo", guardrails: "yolo" })
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
      const running = yield* service.assert(outsideWrite).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      const grading = replied.choices.filter((request) => request.request.questions[0]?.name === "guardrail")
      expect(grading).toHaveLength(1)
      expect(state(grading[0])).toMatchObject({
        applicability: {
          sameCall: [
            { gate: "permission", source: "automated", outcome: "escalate", via: "yolo" },
            { gate: "permission", source: "human", reply: "once", action: "external_directory", resources: ["/outside/notes/*"] },
          ],
        },
      })
      expect(pending.ruleIDs).toEqual(["standard.review.outside-repo"])
      yield* rejectPending(running)
    }),
  )
})

describe("human guardrail rejections stay with the human", () => {
  const live = harness({
    baseline: false,
    decide: (request, index) => Effect.succeed(graded(request, index === 0 ? { escalate: 0.95 } : { allow: 0.95 })),
  })
  live.it.effect("an unchanged reissue of a review the human rejected awake is not auto-approved", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      const service = yield* SessionGuardrail.Service
      yield* rejectPending(yield* service.assert(outsideShell).pipe(Effect.forkScoped))
      const reissued = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(live.choices).toHaveLength(2)
      expect(state(live.choices[1])).toMatchObject({ applicability: { prior: [{ source: "human", status: "rejected" }] } })
      expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated", choice: "allow" })
      yield* rejectPending(reissued)
    }),
  )

  const recorded = harness({
    baseline: false,
    decide: (request, index) => Effect.succeed(graded(request, index === 0 ? { escalate: 0.95 } : { allow: 0.95 })),
  })
  recorded.it.effect("a review-box rejection of the exact review keeps a later automated allow from applying", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, sleep: true })
      const service = yield* SessionGuardrail.Service
      expect(Exit.isFailure(yield* service.assert(outsideShell).pipe(Effect.exit))).toBe(true)
      const { db } = yield* Database.Service
      const items = yield* SessionReviewFold.fold(db, [sessionID])
      expect(items).toHaveLength(1)
      const events = yield* EventRuntime.Service
      yield* events.publish(SessionEvent.Review.Decided, { sessionID, itemID: items[0]!.itemID, decision: { kind: "guardrail", reply: "reject" } })
      yield* autonomy.set({ sessionID, sleep: false })
      const reissued = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(state(recorded.choices[1])).toMatchObject({ applicability: { prior: [{ source: "review", status: "rejected" }] } })
      expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated" })
      yield* rejectPending(reissued)
    }),
  )
})

describe("automated guardrail outcomes are revalidated under the root lock", () => {
  for (const baseline of [true, false]) {
    const ruleEntered = Deferred.makeUnsafe<void>()
    const ruleGate = Deferred.makeUnsafe<void>()
    const rules = harness({
      baseline,
      decide: (request) => Deferred.succeed(ruleEntered, undefined).pipe(Effect.andThen(Deferred.await(ruleGate)), Effect.as(graded(request, { allow: 0.95 }))),
    })
    rules.it.effect(`a custom deny added during a YOLO assessment with decide_reviews ${baseline} blocks the approved action`, () =>
      Effect.gen(function* () {
        yield* seed({ yolo: true })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        yield* Deferred.await(ruleEntered)
        rules.documents.set(path.normalize(`${guardrailDirectory}/deny.md`), denyRule("deny-everything"))
        yield* Deferred.succeed(ruleGate, undefined)
        const error = yield* Effect.flip(Fiber.join(running))
        expect(error._tag).toBe("Guardrail.BlockedError")
        expect(yield* service.forSession(sessionID)).toEqual([])
      }),
    )

    const contextEntered = Deferred.makeUnsafe<void>()
    const contextGate = Deferred.makeUnsafe<void>()
    const context = harness({
      baseline,
      decide: (request) => Deferred.succeed(contextEntered, undefined).pipe(Effect.andThen(Deferred.await(contextGate)), Effect.as(graded(request, { allow: 0.95 }))),
    })
    context.it.effect(`a YOLO approval with decide_reviews ${baseline} is withheld when a user instruction arrives during the assessment`, () =>
      Effect.gen(function* () {
        yield* seed({ yolo: true })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        yield* Deferred.await(contextEntered)
        const { db } = yield* Database.Service
        yield* db
          .insert(SessionPendingTable)
          .values({
            id: SessionMessage.ID.make("msg_guardrail_steer"),
            session_id: sessionID,
            type: "user",
            data: { text: "Do not touch files outside the repository" },
            delivery: "steer",
            admitted_seq: 1,
          })
          .run()
          .pipe(Effect.orDie)
        yield* Deferred.succeed(contextGate, undefined)
        const pending = yield* awaitRequest()
        expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated" })
        yield* rejectPending(running)
      }),
    )

    const progressEntered = Deferred.makeUnsafe<void>()
    const progressGate = Deferred.makeUnsafe<void>()
    const progressing = harness({
      baseline,
      decide: (request) => Deferred.succeed(progressEntered, undefined).pipe(Effect.andThen(Deferred.await(progressGate)), Effect.as(graded(request, { allow: 0.95 }))),
    })
    progressing.it.effect(`sibling assistant progress during a YOLO assessment with decide_reviews ${baseline} does not withhold its approval`, () =>
      Effect.gen(function* () {
        yield* seed({ yolo: true })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        yield* Deferred.await(progressEntered)
        const { db } = yield* Database.Service
        yield* db
          .run(sql`
            INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            VALUES ('msg_sibling_progress', ${sessionID}, 'assistant', 1, 0, 0,
              ${JSON.stringify({ agent: "build", model: { providerID: "test", id: "main-model" }, content: [], time: { created: 0 } })})
          `)
          .pipe(Effect.orDie)
        yield* Deferred.succeed(progressGate, undefined)
        yield* (yield* Fiber.join(running)).release
        expect(yield* service.forSession(sessionID)).toEqual([])
      }),
    )
  }

  for (const [baseline, grant] of [[true, "always"], [false, "external_directory"]] as const) {
    const external = { value: "ask" as "ask" | "allow" }
    const allowEntered = Deferred.makeUnsafe<void>()
    const allowGate = Deferred.makeUnsafe<void>()
    const allowed = harness({
      baseline,
      external,
      decide: (request) => Deferred.succeed(allowEntered, undefined).pipe(Effect.andThen(Deferred.await(allowGate)), Effect.as(graded(request, { allow: 0.95 }))),
    })
    allowed.it.effect(`a ${grant} grant arriving during a YOLO assessment with decide_reviews ${baseline} settles the review by current policy`, () =>
      Effect.gen(function* () {
        yield* seed({ yolo: true })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        yield* Deferred.await(allowEntered)
        if (grant === "always") {
          const events = yield* EventRuntime.Service
          yield* events.publish(SessionEvent.GuardrailApproved, { sessionID, directories: [path.resolve("/outside")] })
        }
        if (grant === "external_directory") external.value = "allow"
        yield* Deferred.succeed(allowGate, undefined)
        for (let attempt = 0; attempt < 200 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
        expect(yield* service.forSession(sessionID)).toEqual([])
        yield* (yield* Fiber.join(running)).release
        const { db } = yield* Database.Service
        expect(yield* SessionReviewFold.fold(db, [sessionID])).toEqual([])
        const provenance = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(inArray(EventTable.type, ["session.guardrail.decided.1", "session.guardrail.escalated.1"]))
          .all()
          .pipe(Effect.orDie)
        expect(provenance).toEqual([])
      }),
    )
  }

  const denied = harness({
    baseline: false,
    decide: (request) => Effect.succeed(graded(request, { deny: 0.95 }, "Writes into another project the task never named")),
  })
  denied.it.effect("an automated rejection tells the agent it was not a human decision and how to proceed", () =>
    Effect.gen(function* () {
      yield* seed({ yolo: true })
      const service = yield* SessionGuardrail.Service
      const error = yield* Effect.flip(service.assert(outsideShell))
      expect(error._tag).toBe("Guardrail.DeclinedError")
      expect(SessionGuardrail.reviewMessage(error)).toContain("Automated guardrail assessment, not a human decision")
      expect(SessionGuardrail.reviewMessage(error)).toContain("Writes into another project the task never named")
      expect(SessionGuardrail.reviewMessage(error)).toContain("alternative")
    }),
  )
})

const reviewBox = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* SessionReviewFold.fold(db, [sessionID])
})

describe("guardrail decision modes", () => {
  for (const baseline of [true, false]) {
    const manual = harness({ baseline, decide: () => Effect.die("Manual guardrails never reach a model") })
    manual.it.effect(`Manual with decide_reviews ${baseline} asks the human for an ordinary review without verification or grading`, () =>
      Effect.gen(function* () {
        yield* seed({ guardrails: "manual" })
        const service = yield* SessionGuardrail.Service
        const running = yield* service.assert(outsideShell).pipe(Effect.forkScoped)
        const pending = yield* awaitRequest()
        expect(pending.escalation).toBeUndefined()
        yield* service.reply({ sessionID, requestID: pending.id, reply: "once" })
        yield* Fiber.join(running)
        expect(manual.calls).toEqual([])
      }),
    )
  }

  const manualHard = harness({ baseline: true, decide: () => Effect.die("Manual guardrails never reach a model") })
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

  const manualAsleep = harness({ baseline: true, decide: () => Effect.die("Manual guardrails never reach a model") })
  manualAsleep.it.effect("Manual defers to the review box while the family sleeps without a helper call", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "manual", asleep: true })
      const service = yield* SessionGuardrail.Service
      const exit = yield* service.assert(outsideShell).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* reviewBox).toEqual([expect.objectContaining({ kind: "guardrail", reason: "disabled" })])
      expect(manualAsleep.calls).toEqual([])
    }),
  )

  const autoAwake = harness({ baseline: true, decide: () => Effect.die("Auto guardrails never reach a model") })
  autoAwake.it.effect("Auto approves an ordinary standard review awake without a helper call", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto" })
      const service = yield* SessionGuardrail.Service
      yield* service.assert(outsideShell)
      expect(yield* service.forSession(sessionID)).toEqual([])
      expect(autoAwake.calls).toEqual([])
    }),
  )

  const autoAsleep = harness({ baseline: true, decide: () => Effect.die("Auto guardrails never fall back to a model") })
  autoAsleep.it.effect("Auto defers an ordinary review while asleep without a model fallback", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "auto", asleep: true })
      const service = yield* SessionGuardrail.Service
      expect(Exit.isFailure(yield* service.assert(outsideShell).pipe(Effect.exit))).toBe(true)
      expect(yield* reviewBox).toEqual([expect.objectContaining({ kind: "guardrail", reason: "disabled" })])
      expect(autoAsleep.calls).toEqual([])
    }),
  )

  const autoHard = harness({ baseline: true, decide: () => Effect.die("Auto guardrails never fall back to a model") })
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
    decide: () => Effect.die("Auto guardrails never fall back to a model"),
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
    const yolo = harness({ baseline, decide: (request) => Effect.succeed(graded(request, { allow: 0.95 })) })
    yolo.it.effect(`YOLO with decide_reviews ${baseline} uses only YOLO authority and ${baseline ? "verifies the match" : "skips match verification"}`, () =>
      Effect.gen(function* () {
        yield* seed({ guardrails: "yolo" })
        const service = yield* SessionGuardrail.Service
        yield* service.assert(outsideShell)
        expect(yield* service.forSession(sessionID)).toEqual([])
        expect(yolo.calls).toEqual([
          ...(baseline ? [{ name: "guardrail_match", authority: "yolo" }] : []),
          { name: "guardrail", authority: "yolo" },
        ])
      }),
    )
  }

  const yoloHard = harness({ baseline: true, decide: (request) => Effect.succeed(graded(request, { allow: 0.99 })) })
  yoloHard.it.effect("YOLO never approves a hard review; a confident allow still asks the human", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "yolo" })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert(forcePush).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(pending.hardReview).toBe(true)
      yield* service.reply({ sessionID, requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(yoloHard.calls.every((call) => call.authority === "yolo")).toBe(true)
    }),
  )

  const yoloHardDeny = harness({ baseline: true, decide: (request) => Effect.succeed(graded(request, { deny: 0.95 })) })
  yoloHardDeny.it.effect("YOLO may deny a hard review", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "yolo" })
      const service = yield* SessionGuardrail.Service
      expect(Exit.isFailure(yield* service.assert(forcePush).pipe(Effect.exit))).toBe(true)
      expect(yield* service.forSession(sessionID)).toEqual([])
    }),
  )

  const yoloCustom = harness({
    baseline: true,
    documents: [[`${guardrailDirectory}/review.md`, reviewRule("custom-review")]],
    decide: (request) => Effect.succeed(graded(request, { allow: 0.99 })),
  })
  yoloCustom.it.effect("YOLO never approves a custom-rule review; a confident allow still asks the human", () =>
    Effect.gen(function* () {
      yield* seed({ guardrails: "yolo" })
      const service = yield* SessionGuardrail.Service
      const running = yield* service.assert({ sessionID, action: "shell", resources: ["task-runner execute"], metadata: { workdir: project } }).pipe(Effect.forkScoped)
      const pending = yield* awaitRequest()
      expect(pending.ruleIDs).toEqual(["custom-review"])
      yield* service.reply({ sessionID, requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      expect(yoloCustom.calls.filter((call) => call.name === "guardrail_match")).toEqual([])
    }),
  )

  for (const mode of ["manual", "yolo", "auto"] as const) {
    const denied = harness({
      baseline: true,
      documents: [[`${guardrailDirectory}/deny.md`, denyRule("deny-everything")]],
      decide: () => Effect.die("Denies never reach a model"),
    })
    denied.it.effect(`a deny rule blocks in ${mode} before any helper call`, () =>
      Effect.gen(function* () {
        yield* seed({ guardrails: mode })
        const service = yield* SessionGuardrail.Service
        expect(Exit.isFailure(yield* service.assert(outsideShell).pipe(Effect.exit))).toBe(true)
        expect(denied.calls).toEqual([])
      }),
    )
  }
})
