import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { SessionHelperPolicy, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Money } from "@ycoding-ai/schema/money"
import { Deferred, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { testEffect } from "./lib/effect"

const model = Model.make({
  id: "goal-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
let requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  stream: (request: LLMRequest) => {
    requests.push(request)
    const text = JSON.stringify(request.messages)
    if (text.includes("model failure")) return Stream.make(LLMEvent.providerError({ message: "unavailable" }))
    if (text.includes("empty output")) return Stream.make(LLMEvent.finish({ reason: "stop" }))
    if (text.includes("no settlement"))
      return Stream.make(LLMEvent.textDelta({ id: "goal", text: "Unsettled goal text." }))
    const output = text.includes("User-proxy steer request:")
      ? "Inspect the SQLite migration failure next and verify the focused suite.\n"
      : "Repair the migration and verify the suite passes.\n"
    return Stream.make(
      LLMEvent.textDelta({ id: "goal", text: output }),
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
        },
      }),
      LLMEvent.finish({ reason: "stop" }),
    )
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
})
let modelAvailable = true
const helperPolicy = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    get settings() {
      return { titleMode: "local" as const, models: {} }
    },
    localTitle,
    resolveModel: () =>
      modelAvailable
        ? Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost))
        : Effect.succeed(undefined),
  }),
)
const cachePolicies: SessionCacheRuntime.PolicyInput[] = []
const cacheObservations: SessionCacheRuntime.Observation[] = []
const cacheRuntime = Layer.succeed(
  SessionCacheRuntime.Service,
  SessionCacheRuntime.Service.of({
    policy: (input) =>
      Effect.sync(() => {
        cachePolicies.push(input)
        return { ttlSeconds: 300 as const, promoted: false }
      }),
    observe: (input) => Effect.sync(() => void cacheObservations.push(input)),
    generation: () => Effect.succeed(0),
  }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            efficiency: new ConfigEfficiency.Info({
              prompt_cache: new ConfigEfficiency.PromptCache({ anthropic_ttl: "adaptive" }),
            }),
          }),
        }),
      ]),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      SessionAutonomy.node,
      SessionHelperPolicy.node,
      SessionGoal.node,
    ]),
    [
      [llmClient, client],
      [SessionRunnerModel.node, models],
      [SessionHelperPolicy.node, helperPolicy],
      [Config.node, config],
      [SessionCacheRuntime.node, cacheRuntime],
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const synthesisCalls: string[] = []
const steerCalls: Array<{
  readonly goal: SessionAutonomy.Goal
  readonly latestAssistantText?: string
  readonly phase: "start" | "continue"
}> = []
const calculationEntered = Deferred.makeUnsafe<void>()
const calculationRelease = Deferred.makeUnsafe<void>()
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      Layer.succeed(
        SessionGoal.Service,
        SessionGoal.Service.of({
          synthesize: ({ text }) => {
            synthesisCalls.push(text)
            if (text === "Delayed goal") return Effect.gen(function* () {
              yield* Deferred.succeed(calculationEntered, undefined)
              yield* Deferred.await(calculationRelease)
              return "Delayed calculated objective"
            })
            if (text === "Interrupt synthesis") return Effect.interrupt
            if (text === "Use the fallback")
              return Effect.fail(new SessionGoal.Error({ code: "goal.model_unavailable" }))
            if (text === "Fail steer") return Effect.succeed("Steer failure objective")
            return Effect.succeed("Repair the migration and verify the suite passes.")
          },
          steer: (input) => {
            steerCalls.push(input)
            if (input.goal.text === "Steer failure objective")
              return Effect.fail(new SessionGoal.Error({ code: "goal.calculation_failed" }))
            return Effect.succeed("Inspect the migration failure next and run the focused checks.")
          },
        }),
      ) as unknown as Layer.Layer<LocationServices>,
  ),
)
const setIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionAutonomy.node, SessionV2.node]),
    [
      [LocationServiceMap.node, locations],
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)

const insertSession = (id: SessionV2.ID) =>
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
      .values({
        id,
        project_id: Project.ID.global,
        directory: "/project",
        title: "goal",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: SessionV2.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const messageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID: messageID,
      input: { type: "user", data: { text }, delivery: "steer" },
    })
    yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID: messageID })
  })

const configureGoalAgent = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) => {
    editor.update(AgentV2.ID.make("goal"), (agent) => {
      agent.mode = "primary"
      agent.hidden = true
      agent.system = "Infer the user goal."
    })
  })
})

it.effect("synthesizes the goal through the configured goal model without a local mode", () =>
  Effect.gen(function* () {
    requests = []
    modelAvailable = true
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_local")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "The project uses SQLite for durable state.")
    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const before = yield* store.context(sessionID)

    expect(
      yield* (yield* SessionGoal.Service).synthesize({
        session,
        text: "  Please investigate\n the migration failure, fix it, and run the relevant checks. ",
      }),
    ).toBe("Repair the migration and verify the suite passes.")
    expect(requests).toHaveLength(1)
    expect(yield* store.context(sessionID)).toEqual(before)
  }),
)

it.effect("fails with goal.model_unavailable instead of falling back to the Session model", () =>
  Effect.gen(function* () {
    requests = []
    modelAvailable = false
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_unavailable")
    yield* insertSession(sessionID)
    const session = yield* (yield* SessionStore.Service)
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const error = yield* (yield* SessionGoal.Service)
      .synthesize({ session, text: "Fix the migration" })
      .pipe(Effect.flip)

    expect(error.code).toBe("goal.model_unavailable")
    expect(error._tag).toBe("SessionGoal.Error")
    expect(requests).toHaveLength(0)
  }),
)

it.effect("preserves conversation-aware goal synthesis", () =>
  Effect.gen(function* () {
    requests = []
    cachePolicies.length = 0
    cacheObservations.length = 0
    modelAvailable = true
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_synthesis")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "The project uses SQLite for durable state.")
    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const before = yield* store.context(sessionID)
    const goals = yield* SessionGoal.Service

    expect(
      yield* goals.synthesize({
        session,
        text: "Please investigate the migration failure, fix it, and run the relevant checks.",
      }),
    ).toBe("Repair the migration and verify the suite passes.")
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain("The project uses SQLite for durable state.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Please investigate the migration failure")
    expect(JSON.stringify(requests[0]?.system)).toContain("Infer the user goal.")
    expect(yield* store.context(sessionID)).toEqual(before)
    const promptCacheKey = requests[0]?.providerOptions?.openai?.promptCacheKey
    expect(typeof promptCacheKey).toBe("string")
    if (typeof promptCacheKey !== "string") return yield* Effect.die("prompt cache key missing")
    expect(cachePolicies).toHaveLength(1)
    expect(cachePolicies[0]).toMatchObject({
      modelID: "goal-model",
      configured: "adaptive",
    })
    expect(cacheObservations).toEqual([
      {
        namespace: promptCacheKey,
        cacheRead: 3,
        cacheWrite: 2,
        eligible: 15,
      },
    ])
  }),
)

it.effect("generates a concise contextual user-proxy steer without changing the active goal", () =>
  Effect.gen(function* () {
    requests = []
    modelAvailable = true
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_steer")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "The project uses SQLite for durable state.")
    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const goal: SessionAutonomy.Goal = {
      text: "Repair the migration and verify the suite passes.",
      rawText: "Fix the migration",
      status: "active",
      iteration: 2,
      noProgress: 1,
      maxNoProgress: 3,
    }

    expect(
      yield* (yield* SessionGoal.Service).steer({
        session,
        goal,
        phase: "continue",
        latestAssistantText: "Which migration should I inspect next?",
      }),
    ).toBe("Inspect the SQLite migration failure next and verify the focused suite.")
    expect(goal).toEqual({
      text: "Repair the migration and verify the suite passes.",
      rawText: "Fix the migration",
      status: "active",
      iteration: 2,
      noProgress: 1,
      maxNoProgress: 3,
    })
    expect(requests).toHaveLength(1)
    const message = JSON.stringify(requests[0]?.messages)
    expect(message).toContain("User-proxy steer request:")
    expect(message).toContain("Active goal: Repair the migration and verify the suite passes.")
    expect(message).toContain("Latest assistant response: Which migration should I inspect next?")
    expect(message).toContain("The project uses SQLite for durable state.")
    expect(message).not.toContain("Continue autonomously toward the active user goal.")
  }),
)

it.effect("fails with goal.calculation_failed for provider failure or empty output", () =>
  Effect.gen(function* () {
    modelAvailable = true
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_fallback")
    yield* insertSession(sessionID)
    const session = yield* (yield* SessionStore.Service)
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const goals = yield* SessionGoal.Service

    expect((yield* goals.synthesize({ session, text: "model failure" }).pipe(Effect.flip)).code).toBe(
      "goal.calculation_failed",
    )
    expect((yield* goals.synthesize({ session, text: "empty output" }).pipe(Effect.flip)).code).toBe(
      "goal.calculation_failed",
    )
  }),
)

it.effect("fails with goal.calculation_failed when the stream ends without provider settlement", () =>
  Effect.gen(function* () {
    modelAvailable = true
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_unsettled")
    yield* insertSession(sessionID)
    const session = yield* (yield* SessionStore.Service)
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const goals = yield* SessionGoal.Service

    // A text-only stream that ends without stepFinish/finish is an invalid provider settlement.
    // The nonempty text must not be accepted as a calculated goal.
    expect((yield* goals.synthesize({ session, text: "no settlement" }).pipe(Effect.flip)).code).toBe(
      "goal.calculation_failed",
    )
  }),
)

it.effect("uses agent reports only as no-progress retry attempts", () =>
  Effect.gen(function* () {
    const service = yield* SessionAutonomy.Service
    const sessionID = SessionV2.ID.make("ses_goal_iteration")
    yield* insertSession(sessionID)
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgress: 1,
    })
    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "active",
      iteration: 0,
      noProgress: 2,
    })
    expect((yield* service.report({ sessionID })).goal).toMatchObject({
      status: "exhausted",
      iteration: 0,
      noProgress: 3,
    })
  }),
)

setIt.effect(
  "stores synthesized goals without changing the admitted user prompt and preserves state on failure",
  () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const inputID = SessionMessage.ID.create()
      const rawText = "Fix the migration failure and run the relevant checks."
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID,
        input: { type: "user", data: { text: rawText }, delivery: "steer" },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID })
      const before = yield* session.context(created.id)
      steerCalls.length = 0

      expect(yield* session.autonomy.set({ sessionID: created.id, goal: rawText })).toMatchObject({
        mode: "normal",
        yolo: 0,
        goal: {
          text: "Repair the migration and verify the suite passes.",
          rawText,
        },
      })
      expect(yield* session.context(created.id)).toEqual(before)
      expect(steerCalls).toMatchObject([
        {
          goal: { text: "Repair the migration and verify the suite passes.", rawText, status: "active", iteration: 0 },
          phase: "start",
        },
      ])
      expect((yield* session.pending(created.id)).at(-1)).toMatchObject({
        type: "synthetic",
        data: {
          text: "Inspect the migration failure next and run the focused checks.",
          description: "Goal · steer",
          metadata: { autonomy: { goal: true, iteration: 0 } },
        },
      })

      const failed = yield* session.autonomy
        .set({ sessionID: created.id, goal: "  Use the fallback  " })
        .pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(yield* session.autonomy.get(created.id)).toMatchObject({
        goal: { text: "Repair the migration and verify the suite passes.", rawText },
      })
    }),
)

setIt.effect("does not activate or admit a goal when user-proxy steer generation fails", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const created = yield* session.create({ location })
    const before = yield* session.pending(created.id)

    const failed = yield* session.autonomy
      .set({ sessionID: created.id, goal: "Fail steer" })
      .pipe(Effect.exit)

    expect(failed._tag).toBe("Failure")
    expect(yield* session.autonomy.get(created.id)).toEqual({ mode: "normal", yolo: 0 })
    expect(yield* session.pending(created.id)).toEqual(before)
  }),
)

setIt.effect("propagates goal synthesis interruption without storing a raw-text fallback", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const created = yield* session.create({ location })
    const outcome = yield* session.autonomy
      .set({ sessionID: created.id, goal: "Interrupt synthesis" })
      .pipe(Effect.exit)

    expect(outcome._tag).toBe("Failure")
    expect(yield* session.autonomy.get(created.id)).toEqual({ mode: "normal", yolo: 0 })
  }),
)

setIt.effect("R7 ordinary prompts preserve the user-owned goal and accumulated no-progress count", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const autonomy = yield* SessionAutonomy.Service
    const created = yield* session.create({ location })

    synthesisCalls.length = 0
    yield* session.autonomy.set({ sessionID: created.id, goal: "Initial request", maxNoProgress: 4 })
    yield* autonomy.report({ sessionID: created.id })
    yield* session.prompt({
      id: SessionMessage.ID.create(),
      sessionID: created.id,
      text: "Second request",
      resume: false,
    })
    expect(yield* session.autonomy.get(created.id)).toMatchObject({
      goal: { text: "Repair the migration and verify the suite passes.", rawText: "Initial request", status: "active", noProgress: 1, maxNoProgress: 4 },
    })

    yield* session.prompt({
      id: SessionMessage.ID.create(),
      sessionID: created.id,
      text: "Third request",
      resume: false,
    })
    expect(yield* session.autonomy.get(created.id)).toMatchObject({
      goal: { text: "Repair the migration and verify the suite passes.", rawText: "Initial request", status: "active", noProgress: 1, maxNoProgress: 4 },
    })
    expect(synthesisCalls).toEqual(["Initial request"])
  }),
)

setIt.effect("R7 resumes the retained goal without synthesis and admits its continuation", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const autonomy = yield* SessionAutonomy.Service
    const created = yield* session.create({ location })
    synthesisCalls.length = 0
    steerCalls.length = 0
    yield* session.autonomy.set({ sessionID: created.id, goal: "Explicit objective" })
    yield* autonomy.report({ sessionID: created.id })
    yield* session.autonomy.set({ sessionID: created.id, goal: null })
    const before = yield* session.pending(created.id)
    const resumed = yield* session.autonomy.set({ sessionID: created.id, goal: true })
    expect(resumed.goal).toMatchObject({ text: "Repair the migration and verify the suite passes.", rawText: "Explicit objective", status: "active", noProgress: 1 })
    expect(synthesisCalls).toEqual(["Explicit objective"])
    expect(steerCalls).toMatchObject([
      { goal: { text: "Repair the migration and verify the suite passes.", status: "active", iteration: 0 }, phase: "start" },
      { goal: { text: "Repair the migration and verify the suite passes.", status: "active", iteration: 0 }, phase: "start" },
    ])
    const pending = yield* session.pending(created.id)
    expect(pending).toHaveLength(before.length + 1)
    expect(pending.at(-1)).toMatchObject({
      type: "synthetic",
      data: {
        text: "Inspect the migration failure next and run the focused checks.",
        description: "Goal · steer",
        metadata: { autonomy: { goal: true, iteration: 0 } },
      },
    })
  }),
)

setIt.effect("R7 refuses resume without a retained goal and commits combined YOLO only with successful calculation", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const created = yield* session.create({ location })
    expect(yield* session.autonomy.set({ sessionID: created.id, goal: true }).pipe(Effect.flip)).toMatchObject({ code: "goal.no_retained_goal" })
    expect(yield* session.pending(created.id)).toEqual([])
    yield* session.autonomy.set({ sessionID: created.id, goal: "Initial objective", yolo: 1 })
    expect(yield* session.autonomy.get(created.id)).toMatchObject({ yolo: 1, goal: { rawText: "Initial objective" } })
    const before = yield* session.pending(created.id)
    expect((yield* session.autonomy.set({ sessionID: created.id, goal: "Use the fallback", yolo: 2 }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* session.autonomy.get(created.id)).toMatchObject({ yolo: 1, goal: { rawText: "Initial objective" } })
    expect(yield* session.pending(created.id)).toEqual(before)
  }),
)

setIt.effect("R7 stopping during calculation prevents late reactivation and continuation admission", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const created = yield* session.create({ location })
    yield* session.autonomy.set({ sessionID: created.id, goal: "Initial objective" })
    const before = yield* session.pending(created.id)
    const calculation = yield* session.autonomy.set({ sessionID: created.id, goal: "Delayed goal" }).pipe(Effect.exit, Effect.forkChild)
    yield* Deferred.await(calculationEntered)
    yield* session.autonomy.set({ sessionID: created.id, goal: null })
    yield* Deferred.succeed(calculationRelease, undefined)
    const settled = yield* Fiber.join(calculation)
    expect(settled._tag).toBe("Failure")
    expect(yield* session.autonomy.get(created.id)).toMatchObject({ goal: { rawText: "Initial objective", status: "stopped" } })
    expect(yield* session.pending(created.id)).toEqual(before)
  }),
)
