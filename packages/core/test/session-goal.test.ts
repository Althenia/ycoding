import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
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
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Layer, LayerMap, Stream } from "effect"
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
    return Stream.make(
      LLMEvent.textDelta({ id: "goal", text: "Repair the migration and verify the suite passes.\n" }),
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
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      SessionAutonomy.node,
      SessionGoal.node,
    ]),
    [
      [llmClient, client],
      [SessionRunnerModel.node, models],
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
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() =>
    Layer.succeed(
      SessionGoal.Service,
      SessionGoal.Service.of({
        synthesize: ({ text }) => {
          if (text === "Interrupt synthesis") return Effect.interrupt
          return Effect.succeed(text === "Use the fallback" ? undefined : "Repair the migration and verify the suite passes.")
        },
      }),
    ) as unknown as Layer.Layer<LocationServices>,
  ),
)
const setIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
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

it.effect("synthesizes a concise goal from the raw request and recent conversation", () =>
  Effect.gen(function* () {
    requests = []
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
    expect(yield* store.context(sessionID)).toEqual(before)
  }),
)

it.effect("returns no synthesized goal for provider failure or empty output", () =>
  Effect.gen(function* () {
    yield* configureGoalAgent
    const sessionID = SessionV2.ID.make("ses_goal_fallback")
    yield* insertSession(sessionID)
    const session = yield* (yield* SessionStore.Service)
      .get(sessionID)
      .pipe(Effect.flatMap((item) => (item ? Effect.succeed(item) : Effect.die("session missing"))))
    const goals = yield* SessionGoal.Service

    expect(yield* goals.synthesize({ session, text: "model failure" })).toBeUndefined()
    expect(yield* goals.synthesize({ session, text: "empty output" })).toBeUndefined()
  }),
)

it.effect("keeps goal iteration and no-progress exhaustion behavior", () =>
  Effect.gen(function* () {
    const service = yield* SessionAutonomy.Service
    const sessionID = SessionV2.ID.make("ses_goal_iteration")
    yield* insertSession(sessionID)
    yield* service.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

    expect((yield* service.advance({ sessionID, progress: "first" })).goal).toMatchObject({ status: "active", iteration: 1 })
    expect((yield* service.advance({ sessionID, progress: "first" })).goal).toMatchObject({
      status: "active",
      iteration: 2,
      noProgress: 1,
    })
    expect((yield* service.advance({ sessionID, progress: "first" })).goal).toMatchObject({
      status: "active",
      iteration: 3,
      noProgress: 2,
    })
    expect((yield* service.advance({ sessionID, progress: "first" })).goal).toMatchObject({
      status: "exhausted",
      iteration: 4,
      noProgress: 3,
    })
  }),
)

setIt.effect("stores synthesized goals without changing the admitted user prompt and falls back to trimmed raw text", () =>
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

    expect(
      yield* session.autonomy.set({ sessionID: created.id, mode: "goal", goal: rawText }),
    ).toMatchObject({
      mode: "goal",
      goal: {
        text: "Repair the migration and verify the suite passes.",
        rawText,
      },
    })
    expect(yield* session.context(created.id)).toEqual(before)
    expect(
      yield* session.autonomy.set({ sessionID: created.id, mode: "goal", goal: "  Use the fallback  " }),
    ).toMatchObject({
      mode: "goal",
      goal: { text: "Use the fallback", rawText: "Use the fallback" },
    })
  }),
)

setIt.effect("propagates goal synthesis interruption without storing a raw-text fallback", () =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const created = yield* session.create({ location })
    const outcome = yield* session.autonomy
      .set({ sessionID: created.id, mode: "goal", goal: "Interrupt synthesis" })
      .pipe(Effect.exit)

    expect(outcome._tag).toBe("Failure")
    expect(yield* session.autonomy.get(created.id)).toEqual({ mode: "normal" })
  }),
)
