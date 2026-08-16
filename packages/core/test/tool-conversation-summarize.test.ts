import { expect } from "bun:test"
import { LLMClient } from "@ycoding-ai/ai"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Image } from "@ycoding-ai/core/image"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ConversationSummarizeTool } from "@ycoding-ai/core/tool/conversation-summarize"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { SessionHelperPolicy, localGoal, localTitle } from "@ycoding-ai/core/session/helper-policy"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionCacheRuntime } from "@ycoding-ai/core/session/runner/cache-runtime"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { EventSequenceTable } from "@ycoding-ai/core/event/sql"
import { llmClient } from "@ycoding-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"

const client = Layer.mock(LLMClient.Service, {
  prepare: () => Effect.die("unused"),
  stream: () => Stream.die("unused"),
  generate: () => Effect.die("unused"),
})
const config = Layer.mock(Config.Service, {
  entries: () =>
    Effect.succeed([
      new Config.Document({
        type: "document",
        info: new Config.Info({ compaction: new ConfigCompaction.Info({ keep_recent_messages: 1 }) }),
      }),
    ]),
})
const catalog = Layer.mock(Catalog.Service, {
  provider: { get: () => Effect.succeed(undefined), all: () => Effect.succeed([]), available: () => Effect.succeed([]) },
  model: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const cacheRuntime = Layer.succeed(
  SessionCacheRuntime.Service,
  SessionCacheRuntime.Service.of({ policy: () => Effect.succeed({ ttlSeconds: 300, promoted: false }), observe: () => Effect.void }),
)
const models = Layer.mock(SessionRunnerModel.Service, { resolve: () => Effect.die("unused") })
const helpers = Layer.succeed(
  SessionHelperPolicy.Service,
  SessionHelperPolicy.Service.of({
    settings: { titleMode: "local", goalMode: "local", models: {}, compactionScopes: {} },
    localTitle,
    localGoal,
    resolveModel: () => Effect.die("unused"),
  }),
)
const conversationSummarizeToolNode = makeLocationNode({
  name: "test/conversation-summarize-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ConversationSummarizeTool.Plugin)),
  deps: [ToolRegistry.toolsNode, Catalog.node, SessionCompaction.node, Config.node],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      SessionProviderRequest.node,
      SessionHelperPolicy.node,
      SessionCompaction.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      conversationSummarizeToolNode,
    ]),
    [
      [llmClient, client],
      [Config.node, config],
      [Catalog.node, catalog],
      [SessionCacheRuntime.node, cacheRuntime],
      [SessionRunnerModel.node, models],
      [SessionHelperPolicy.node, helpers],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Image.node, imagePassthrough],
    ],
  ),
)

it.effect("surfaces an unknown summary boundary as a tool execution failure", () =>
  Effect.gen(function* () {
    const sessionID = SessionSchema.ID.make("ses_conversation_summarize")
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Summary test" })
      .run()
    yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 0 }).run()

    const registry = yield* ToolRegistry.Service
    expect(
      yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-conversation-summarize",
          name: "conversation_summarize",
          input: { boundary_message_id: "msg_latest" },
        },
      }),
    ).toEqual({
      result: { type: "error", value: "Unknown boundary message: msg_latest" },
      error: { type: "tool.execution", message: "Unknown boundary message: msg_latest" },
    })
  }),
)
