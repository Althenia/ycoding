import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, SystemPart, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Config } from "@ycoding-ai/core/config"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionHelperPolicy, localGoal, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionV2 } from "@ycoding-ai/core/session"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Money } from "@ycoding-ai/schema/money"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
const model = Model.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const helperModel = Model.make({
  id: "helper-summary-model",
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
      LLMEvent.textDelta({ id: "summary", text: "manual summary" }),
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
let anthropicTtl: NonNullable<ConfigEfficiency.PromptCache["anthropic_ttl"]> = "adaptive"
const config = Layer.mock(Config.Service)({
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
})
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
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)),
})
let helperCalls = 0
const helperPolicy = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    settings: { titleMode: "local", goalMode: "local" },
    localTitle,
    localGoal,
    resolveModel: () => {
      helperCalls += 1
      return Effect.succeed(SessionRunnerModel.resolved(helperModel, undefined, cost))
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionProviderRequest.node,
      SessionHelperPolicy.node,
      SessionCompaction.node,
    ]),
    [
      [llmClient, client],
      [Config.node, config],
      [SessionCacheRuntime.node, cacheRuntime],
      [SessionRunnerModel.node, models],
      [SessionHelperPolicy.node, helperPolicy],
    ],
  ),
)

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["Conversation history"] })
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Important Details",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
  ])
  expect(prompt).toContain("one or two brief sentences")
  expect(prompt).toContain("constraints/preferences, decisions and why")
  expect(prompt).toContain("immediate concrete action")
  expect(prompt).toContain("next action if known")
  expect(prompt).toContain("Keep every section, even when empty.")
})

it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    cachePolicies.length = 0
    cacheObservations.length = 0
    anthropicTtl = "1h"
    helperCalls = 0
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const autonomy = SessionAutonomy.make({ db })
    const sessionID = SessionV2.ID.make("ses_manual_compaction")
    const parentID = SessionV2.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      time: { created: DateTime.makeUnsafe(0) },
    }
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
        parent_id: parentID,
        directory: "/project",
        title: "Manual compaction",
      })
      .run()
      .pipe(Effect.orDie)
    yield* autonomy.setGoal({ sessionID, text: "Keep the migration moving", maxNoProgress: 3 })
    yield* autonomy.advance({ sessionID, progress: "Completed the first migration step." })
    yield* autonomy.advance({ sessionID, progress: "Completed the first migration step." })
    const goalBefore = yield* autonomy.get(sessionID)

    const session = yield* store
      .get(sessionID)
      .pipe(
        Effect.flatMap((session) =>
          session ? Effect.succeed(session) : Effect.die("manual compaction test session missing"),
        ),
      )

    const delta = yield* events
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(
      yield* compaction.compactManual({
        session,
        messages: [userMessage],
        inputID: SessionMessage.ID.make("msg_manual_compaction"),
        system: [SystemPart.make("Manual constraints")],
      }),
    ).toEqual({ status: "completed" })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual(["manual summary"])

    expect(requests).toHaveLength(1)
    expect(helperCalls).toBe(1)
    expect(String(requests[0]?.model.id)).toBe("helper-summary-model")
    const providerRequests = yield* SessionProviderRequest.Service
    const recordedModel = (yield* providerRequests.list(sessionID))[0]?.model
    expect({ providerID: String(recordedModel?.providerID), id: String(recordedModel?.id) }).toEqual({
      providerID: "test",
      id: "helper-summary-model",
    })
    expect(requests[0]?.http?.headers).toEqual({
      "x-session-affinity": sessionID,
      "X-Session-Id": sessionID,
      "x-parent-session-id": parentID,
      "User-Agent": `ycoding/${InstallationVersion}`,
      "x-ycoding-project": Project.ID.global,
      "x-ycoding-session": sessionID,
      "x-ycoding-client": "cli",
    })
    expect(requests[0]?.generation).toBeUndefined()
    expect(requests[0]?.system.map((part) => part.text)).toEqual(["Manual constraints"])
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        summary: "manual summary",
        recent: "",
        messages: 1,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(yield* autonomy.get(sessionID)).toEqual(goalBefore)
    expect(cachePolicies).toHaveLength(1)
    expect(cachePolicies[0]).toMatchObject({
      modelID: "helper-summary-model",
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
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: EventV2.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: EventV2.versionedType(SessionEvent.UsageRecorded.type, 1) },
      { type: EventV2.versionedType(SessionEvent.ProviderRequestRecorded.type, 1) },
      { type: EventV2.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)
