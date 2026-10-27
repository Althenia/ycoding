import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
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
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
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

const graded = (request: Decision.Input, scores: Record<string, number>, evidence = "Bounded assessment evidence") =>
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

const applicability = (call: { readonly request: Decision.Input } | undefined) => {
  const state = call?.request.request.state
  if (!state || typeof state !== "object" || Array.isArray(state) || !("applicability" in state)) return undefined
  return state.applicability
}

const waitForPending = Effect.gen(function* () {
  const service = yield* Permission.Service
  for (let attempt = 0; attempt < 100 && (yield* service.forSession(sessionID)).length === 0; attempt++) yield* Effect.yieldNow
  const pending = yield* service.forSession(sessionID)
  expect(pending).toHaveLength(1)
  return pending[0]!
})

const admitSteer = (text: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    yield* SessionPending.admit(db, events, {
      id: SessionMessage.ID.make(`msg_steer_${text.length}`),
      sessionID,
      input: SessionPending.Message.make({ type: "user", delivery: "steer", data: { text } }),
    })
  })

describe("YOLO permission applicability evidence", () => {
  const human = harness({ baseline: true, decide: (request) => Effect.succeed(graded(request, { allow: 0.99 })) })
  human.it.effect("mandatory human approval never reaches the YOLO evaluator", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true, rules: [{ action: "read", resource: "*", effect: "allow" }] })
      const service = yield* Permission.Service
      const events = yield* EventRuntime.Service
      const entered = yield* Deferred.make<Permission.Request>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === Permission.Event.Asked.type && Schema.is(Permission.Request)(event.data)
          ? Deferred.succeed(entered, event.data).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(request({ requireExplicitDecision: true })).pipe(Effect.forkScoped)
      const pending = yield* Effect.race(Deferred.await(entered), Fiber.join(fiber).pipe(Effect.as(undefined)))
      expect(pending).toBeDefined()
      expect(human.calls).toEqual([])
      if (!pending) return
      yield* service.reply({ requestID: pending.id, reply: "once" })
      yield* Fiber.join(fiber)
    }),
  )

  human.it.effect("sleep defers mandatory human decisions and an exact human grant is consumed only once", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true, rules: [{ action: "read", resource: "*", effect: "allow" }] })
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, permissions: "auto", sleep: true })
      const service = yield* Permission.Service
      const input = request({ requireExplicitDecision: true, save: ["secret/*"], metadata: { operationDigest: "synthetic" } })
      expect(Exit.isFailure(yield* service.assert(input).pipe(Effect.exit))).toBe(true)
      const database = yield* Database.Service
      const items = yield* SessionReviewFold.fold(database.db, [sessionID])
      expect(items).toHaveLength(1)
      expect(items[0]?.payload).toMatchObject({ type: "permission" })
      expect(items[0]?.payload).not.toHaveProperty("save")
      const events = yield* EventRuntime.Service
      yield* events.publish(SessionEvent.Review.Decided, { sessionID, itemID: items[0]!.itemID, decision: { kind: "permission", reply: "once" } })
      yield* service.assert(input)
      expect(Exit.isFailure(yield* service.assert(input).pipe(Effect.exit))).toBe(true)
      expect(yield* SessionReviewFold.fold(database.db, [sessionID])).toHaveLength(2)
      expect(human.calls).toEqual([])
    }),
  )

  const origins = harness({ baseline: false, decide: (request) => Effect.succeed(graded(request, { allow: 0.95 })) })
  origins.it.effect("grading state names the deciding rule and its agent or unmatched origin for every resource", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true, rules: [{ action: "read", resource: "secret/*", effect: "ask" }] })
      const service = yield* Permission.Service
      yield* service.assert(request({ resources: ["secret/notes.txt", "other.bin"] }))
      expect(applicability(origins.calls[0])).toMatchObject({
        gate: "permission",
        rules: [
          { resource: "secret/notes.txt", origin: "agent", rule: { action: "read", resource: "secret/*", effect: "ask" } },
          { resource: "other.bin", origin: "unmatched", rule: { action: "read", resource: "*", effect: "ask" } },
        ],
        prior: [],
      })
    }),
  )

  const ceiling = harness({ baseline: true, decide: (request) => Effect.succeed(graded(request, { allow: 0.95 })) })
  ceiling.it.effect("a deny-only ceiling rule blocks before any assessment, so no assessed request carries a ceiling origin", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true, rules: [{ action: "read", resource: "*", effect: "ask" }] })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ permission: SessionPermissionCeiling.denyOnly([{ action: "read", resource: "secret/*", effect: "deny" }]) })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const service = yield* Permission.Service
      const error = yield* Effect.flip(service.assert(request()))
      expect(error._tag).toBe("Permission.BlockedError")
      expect(ceiling.calls).toHaveLength(0)
    }),
  )
})

describe("human permission rejections stay with the human", () => {
  const live = harness({
    baseline: false,
    decide: (request, index) => Effect.succeed(graded(request, index === 0 ? { escalate: 0.95 } : { allow: 0.95 })),
  })
  live.it.effect("an unchanged reissue of a request the human rejected awake is not auto-approved", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true })
      const service = yield* Permission.Service
      const first = yield* service.assert(request()).pipe(Effect.forkScoped)
      const pending = yield* waitForPending
      yield* service.reply({ requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)

      const second = yield* service.assert(request()).pipe(Effect.forkScoped)
      const again = yield* waitForPending
      expect(live.calls).toHaveLength(2)
      expect(applicability(live.calls[1])).toMatchObject({ prior: [{ source: "human", status: "rejected" }] })
      expect(again.escalation).toMatchObject({ authority: "yolo", reason: "escalated", choice: "allow" })
      yield* service.reply({ requestID: again.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
    }),
  )

  const recorded = harness({
    baseline: false,
    decide: (request, index) => Effect.succeed(graded(request, index === 0 ? { escalate: 0.95 } : { allow: 0.95 })),
  })
  recorded.it.effect("a review-box rejection of the exact request keeps a later automated allow from applying", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true })
      const autonomy = yield* SessionAutonomy.Service
      yield* autonomy.set({ sessionID, sleep: true })
      const service = yield* Permission.Service
      expect(Exit.isFailure(yield* service.assert(request()).pipe(Effect.exit))).toBe(true)
      const { db } = yield* Database.Service
      const items = yield* SessionReviewFold.fold(db, [sessionID])
      expect(items).toHaveLength(1)
      const events = yield* EventRuntime.Service
      yield* events.publish(SessionEvent.Review.Decided, {
        sessionID,
        itemID: items[0]!.itemID,
        decision: { kind: "permission", reply: "reject" },
      })
      yield* autonomy.set({ sessionID, sleep: false })

      const reissued = yield* service.assert(request()).pipe(Effect.forkScoped)
      const pending = yield* waitForPending
      expect(applicability(recorded.calls[1])).toMatchObject({ prior: [{ source: "review", status: "rejected" }] })
      expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated" })
      yield* service.reply({ requestID: pending.id, reply: "reject" })
      expect(Exit.isFailure(yield* Fiber.await(reissued))).toBe(true)
    }),
  )
})

describe("automated permission outcomes are revalidated at application", () => {
  for (const baseline of [true, false]) {
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const fenced = harness({
      baseline,
      decide: (request) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(graded(request, { allow: 0.95 })),
        ),
    })
    fenced.it.effect(`a YOLO approval with decide_reviews ${baseline} is withheld when a user instruction arrives during the assessment`, () =>
      Effect.gen(function* () {
        yield* setup({ yolo: true })
        const service = yield* Permission.Service
        const running = yield* service.assert(request()).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        yield* admitSteer("Stop reading secret files")
        yield* Deferred.succeed(gate, undefined)
        const pending = yield* waitForPending
        expect(pending.escalation).toMatchObject({ authority: "yolo", reason: "escalated" })
        yield* service.reply({ requestID: pending.id, reply: "reject" })
        expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true)
      }),
    )
  }

  for (const baseline of [true, false]) {
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const progressing = harness({
      baseline,
      decide: (request) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(graded(request, { allow: 0.95 })),
        ),
    })
    progressing.it.effect(`sibling assistant progress during a YOLO assessment with decide_reviews ${baseline} does not withhold its approval`, () =>
      Effect.gen(function* () {
        yield* setup({ yolo: true })
        const service = yield* Permission.Service
        const running = yield* service.assert(request()).pipe(Effect.forkScoped)
        yield* Deferred.await(entered)
        const { db } = yield* Database.Service
        yield* db
          .run(sql`
            INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
            VALUES ('msg_sibling_progress', ${sessionID}, 'assistant', 1, 0, 0,
              ${JSON.stringify({ agent: "test", model: { providerID: "test", id: "main-model" }, content: [], time: { created: 0 } })})
          `)
          .pipe(Effect.orDie)
        yield* Deferred.succeed(gate, undefined)
        expect(Exit.isSuccess(yield* Fiber.await(running))).toBe(true)
        expect(yield* service.forSession(sessionID)).toEqual([])
      }),
    )
  }

  const denied = harness({
    baseline: false,
    decide: (request) => Effect.succeed(graded(request, { deny: 0.95 }, "Reads private notes the task does not need")),
  })
  denied.it.effect("an automated denial tells the agent it was not a human decision and how to proceed", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true })
      const service = yield* Permission.Service
      const error = yield* Effect.flip(service.assert(request()))
      expect(error._tag).toBe("Permission.CorrectedError")
      if (error._tag !== "Permission.CorrectedError") return
      expect(error.feedback).toContain("Automated permission assessment, not a human decision")
      expect(error.feedback).toContain("Reads private notes the task does not need")
      expect(error.feedback).toContain("alternative")
    }),
  )
})

describe("the public permission request API", () => {
  const external = harness({ baseline: true, decide: (request) => Effect.succeed(graded(request, { allow: 0.95 })) })
  external.it.effect("Permission.ask opens a human request without any model assessment even with YOLO on", () =>
    Effect.gen(function* () {
      yield* setup({ yolo: true })
      const service = yield* Permission.Service
      const result = yield* service.ask(request())
      expect(result.effect).toBe("ask")
      expect(external.calls).toHaveLength(0)
      const pending = yield* service.forSession(sessionID)
      expect(pending.map((item) => item.id)).toEqual([result.id])
      expect(pending[0]).not.toHaveProperty("escalation")
    }),
  )
})
