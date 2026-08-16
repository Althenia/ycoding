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
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionHelperPolicy, localGoal, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionTitle } from "@ycoding-ai/core/session/title"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const model = Model.make({
  id: "title-model",
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
const client = Layer.mock(LLMClient.Service)({
  prepare: () => Effect.die("unused"),
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(
      LLMEvent.textDelta({ id: "title", text: "Generated Title\n" }),
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
      LLMEvent.finish({
        reason: "stop",
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
})
let titleMode: SessionHelperPolicy.TitleMode = "local"
let anthropicTtl: NonNullable<ConfigEfficiency.PromptCache["anthropic_ttl"]> = "adaptive"
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
              prompt_cache: new ConfigEfficiency.PromptCache({ anthropic_ttl: anthropicTtl }),
            }),
          }),
        }),
      ]),
  }),
)
const helperPolicy = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    get settings() {
      return { titleMode, goalMode: "local" as const, models: {} }
    },
    localTitle,
    localGoal,
    resolveModel: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
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
      SessionHelperPolicy.node,
      SessionTitle.node,
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
        title: "New session - fake",
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
    yield* events.publish(SessionEvent.InputPromoted, {
      sessionID,
      inputID: messageID,
    })
  })

it.effect("uses a deterministic local title by default without a provider call", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const sessionID = SessionV2.ID.make("ses_title_local")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "# Help me debug the failing build\nIgnore this line")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const renamed = yield* store.get(sessionID)
    expect(renamed?.title).toBe("Help me debug the failing build")
    expect(renamed?.tokens).toEqual({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    expect(renamed?.cost).toBe(Money.USD.zero)
  }),
)

it.effect("preserves model-generated titles when explicitly enabled", () =>
  Effect.gen(function* () {
    requests = []
    cachePolicies.length = 0
    cacheObservations.length = 0
    titleMode = "model"
    anthropicTtl = "1h"
    const agentService = yield* AgentV2.Service
    yield* agentService.transform((editor) => {
      editor.update(AgentV2.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = SessionV2.ID.make("ses_title_generate")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "User-Agent": `ycoding/${InstallationVersion}`,
      "x-ycoding-project": Project.ID.global,
      "x-ycoding-session": sessionID,
      "x-ycoding-client": "cli",
    })
    expect(JSON.stringify(requests[0]?.messages)).toContain("Help me debug the failing build")
    const renamed = yield* store.get(sessionID)
    expect(renamed?.title).toBe("Generated Title")
    expect(renamed?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
    expect(renamed?.cost).toBeCloseTo(0.0000233)
    expect(cachePolicies).toHaveLength(1)
    expect(cachePolicies[0]).toMatchObject({
      modelID: "title-model",
      configured: "1h",
    })
    expect(requests[0]?.providerOptions?.openai?.promptCacheKey).toBe(cachePolicies[0]?.namespace)
    expect(cacheObservations).toEqual([
      {
        namespace: cachePolicies[0]!.namespace,
        cacheRead: 3,
        cacheWrite: 2,
        eligible: 15,
      },
    ])
  }),
)

it.effect("leaves the generated title unchanged when title generation is off", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "off"
    const sessionID = SessionV2.ID.make("ses_title_off")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    yield* (yield* SessionTitle.Service).generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    expect((yield* store.get(sessionID))?.title).toBe("New session - fake")
  }),
)

it.effect("does not generate once a second user message exists", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const agentService = yield* AgentV2.Service
    yield* agentService.transform((editor) => {
      editor.update(AgentV2.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = SessionV2.ID.make("ses_title_second_message")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "First message")
    yield* prompt(sessionID, "Second message")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const untouched = yield* store.get(sessionID)
    expect(untouched?.title).toBe("New session - fake")
  }),
)

it.effect("does not generate for a child session", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "local"
    const agentService = yield* AgentV2.Service
    yield* agentService.transform((editor) => {
      editor.update(AgentV2.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "You are a title generator."
      })
    })
    const sessionID = SessionV2.ID.make("ses_title_child")
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
        id: sessionID,
        project_id: Project.ID.global,
        parent_id: SessionV2.ID.make("ses_title_parent"),
        directory: "/project",
        title: "Child session - fake",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* prompt(sessionID, "Do this subtask")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
  }),
)

it.effect("does not generate in model mode when the title agent is removed", () =>
  Effect.gen(function* () {
    requests = []
    titleMode = "model"
    const sessionID = SessionV2.ID.make("ses_title_no_agent")
    yield* insertSession(sessionID)
    yield* prompt(sessionID, "Help me debug the failing build")

    const store = yield* SessionStore.Service
    const session = yield* store
      .get(sessionID)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die("session missing"))))
    const title = yield* SessionTitle.Service
    yield* title.generateForFirstPrompt(session)

    expect(requests).toHaveLength(0)
    const untouched = yield* store.get(sessionID)
    expect(untouched?.title).toBe("New session - fake")
  }),
)
