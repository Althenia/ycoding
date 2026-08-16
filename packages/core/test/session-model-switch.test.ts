import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { ConfigEfficiency } from "@ycoding-ai/core/config/efficiency"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { Location } from "@ycoding-ai/core/location"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionContextBudget } from "@ycoding-ai/core/session/context-budget"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionModelSwitch } from "@ycoding-ai/core/session/model-switch"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionRunnerCache } from "@ycoding-ai/core/session/runner/cache"
import { SessionRunCoordinator } from "@ycoding-ai/core/session/run-coordinator"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import * as SessionRunnerLLM from "@ycoding-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionStore } from "@ycoding-ai/core/session/store"
import {
  SessionMessageTable,
  SessionPendingTable,
  SessionProviderRequestTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { and, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { FileAttachment } from "@ycoding-ai/schema/prompt"

const createSession = () => {
  const sessionID = SessionV2.ID.create()
  const location = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
  return { sessionID, location }
}

const messageID = (sessionID: SessionV2.ID, id: SessionMessage.ID) =>
  SessionMessage.ID.make(`${id}_${String(sessionID).replace(/^ses_/, "")}`)

const ref = (providerID: string, id: string) =>
  ModelV2.Ref.make({ id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make(providerID) })
const sonnet = ref("anthropic", "claude-sonnet-4-5")
const haiku = ref("anthropic", "claude-haiku-4-5")
const gpt = ref("openai", "gpt-5.6")

const info = (providerID: string, id: string, context: number, output: number) => ({
  ...ModelV2.Info.empty(ProviderV2.ID.make(providerID), ModelV2.ID.make(id)),
  limit: { context, output },
})
const catalogModels = [
  info("anthropic", "claude-sonnet-4-5", 128_000, 16_384),
  info("anthropic", "claude-haiku-4-5", 64_000, 8_192),
  info("openai", "gpt-5.6", 400_000, 100_000),
]

test("model-switch history estimation is independent of managed payload size", () => {
  const message = (bytes: number) =>
    SessionMessage.User.make({
      id: SessionMessage.ID.make("msg_attachment_estimate"),
      type: "user",
      text: "Inspect the attachment",
      files: [
        FileAttachment.make({
          content: {
            type: "managed",
            digest: "a".repeat(64),
            bytes,
            path: `attachments/sha256/aa/${"a".repeat(64)}`,
          },
          mime: "image/png",
          name: "image.png",
        }),
      ],
      time: { created: DateTime.makeUnsafe(0) },
    })

  expect(SessionModelSwitch.estimateContextTokens([message(1)], sonnet)).toBe(
    SessionModelSwitch.estimateContextTokens([message(20 * 1024 * 1024)], sonnet),
  )
})
const promptCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed(catalogModels),
    available: () => Effect.succeed(catalogModels),
    default: () => Effect.succeed(catalogModels[0]),
    small: () => Effect.succeed(catalogModels[1]),
  },
})

let efficiencyConfig: ConfigEfficiency.Info | undefined
let compactionConfig: readonly ConfigCompaction.Info[] = []
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        ...compactionConfig.map(
          (compaction) =>
            new Config.Document({
              type: "document",
              info: new Config.Info({ compaction }),
            }),
        ),
        new Config.Document({
          type: "document",
          info: new Config.Info({ ...(efficiencyConfig === undefined ? {} : { efficiency: efficiencyConfig }) }),
        }),
      ]),
  }),
)

const requests: LLMRequest[] = []
let idleStarted: Deferred.Deferred<void> | undefined
let idleGate: Deferred.Deferred<void> | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const events = Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textDelta({ id: "text", text: "hello" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      )
      if (!idleGate) return events
      return Stream.unwrap(
        (idleStarted ? Deferred.succeed(idleStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(idleGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const sonnetRouteModel = Model.make({ id: "claude-sonnet-4-5", provider: "anthropic", route: OpenAIChat.route })
const gptRouteModel = Model.make({ id: "gpt-5.6", provider: "openai", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith((session) =>
  Effect.succeed(
    SessionRunnerModel.resolved(
      session.model?.id === "gpt-5.6" ? gptRouteModel : sonnetRouteModel,
      session.model?.variant,
      [],
    ),
  ),
)
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })
const skillInstructions = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
  load: () => Effect.succeed(Instructions.empty),
})
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const pluginSupervisor = Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void }))
// Model switches do not generate compaction manifests.
const compaction = Layer.succeed(
  SessionCompaction.Service,
  SessionCompaction.Service.of({
    manifest: () => Effect.die("unused"),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [InstructionBuiltIns.node, systemContext],
  [InstructionDiscovery.node, instructionContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillInstructions.node, skillInstructions],
  [ReferenceInstructions.node, referenceInstructions],
  [McpInstructions.node, mcpInstructions],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PluginSupervisor.node, pluginSupervisor],
  [SessionCompaction.node, compaction],
])
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () =>
      idleGate === undefined
        ? Effect.void
        : (idleStarted ? Deferred.succeed(idleStarted, undefined) : Effect.void).pipe(
            Effect.andThen(Deferred.await(idleGate)),
          ),
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
      AgentV2.node,
      Catalog.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PluginHooks.node,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      McpInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [Project.node, projects],
      [PermissionV2.node, permission],
      [Catalog.node, promptCatalog],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillInstructions.node, skillInstructions],
      [ReferenceInstructions.node, referenceInstructions],
      [McpInstructions.node, mcpInstructions],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionCompaction.node, compaction],
    ],
  ),
)

const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const userRow = (sessionID: SessionV2.ID, id: SessionMessage.ID, seq: number, text: string) => {
  const message = SessionMessage.User.make({
    type: "user",
    id,
    text,
    files: [],
    agents: [],
    time: { created: DateTime.makeUnsafe(0) },
  })
  const { id: _id, type, ...data } = encodeMessage(message)
  return { id, session_id: sessionID, type, seq, time_created: seq * 1000, data }
}
const assistantRow = (sessionID: SessionV2.ID, id: SessionMessage.ID, seq: number, text: string) => {
  const message = SessionMessage.Assistant.make({
    type: "assistant",
    id,
    agent: AgentV2.ID.make("build"),
    model: sonnet,
    content: [{ type: "text", text, phase: "final_answer" }],
    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
  })
  const { id: _id, type, ...data } = encodeMessage(message)
  return { id, session_id: sessionID, type, seq, time_created: seq * 1000, data }
}
const compactionRow = (sessionID: SessionV2.ID, summary: string, recent: string, seq: number) => {
  const message = SessionMessage.CompactionCompleted.make({
    type: "compaction",
    id: SessionMessage.ID.make("msg_summary"),
    status: "completed",
    reason: "auto",
    summary,
    recent,
    time: { created: DateTime.makeUnsafe(0) },
  })
  const { id: _id, type, ...data } = encodeMessage(message)
  return {
    id: messageID(sessionID, SessionMessage.ID.make("msg_summary")),
    session_id: sessionID,
    type,
    seq,
    time_created: seq * 1000,
    data,
  }
}

const seedTranscript = Effect.fnUntraced(function* (input: {
  readonly sessionID: SessionV2.ID
  readonly summary: string
  readonly posts: readonly { readonly id: SessionMessage.ID; readonly text: string }[]
}) {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionMessageTable)
    .values(compactionRow(input.sessionID, input.summary, "R1", 10))
    .run()
    .pipe(Effect.orDie)
  yield* Effect.forEach(input.posts, (post, index) => {
    const row =
      index % 2 === 0
        ? userRow(input.sessionID, messageID(input.sessionID, post.id), 11 + index, post.text)
        : assistantRow(input.sessionID, messageID(input.sessionID, post.id), 11 + index, post.text)
    return db.insert(SessionMessageTable).values(row).run().pipe(Effect.orDie)
  })
})

const eventCountFor = (sessionID: SessionV2.ID, type?: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(
        type === undefined
          ? and(eq(EventTable.aggregate_id, sessionID))
          : and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, type)),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })

const pendingRows = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionPendingTable)
      .where(eq(SessionPendingTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
  })

describe("SessionV2.switchModel context validation", () => {
  it.effect("applies a fitting switch and preserves the visible summary and recent transcript", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({
        sessionID,
        summary: "S1",
        posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "hello" }],
      })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome).toEqual({ status: "switched" })
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "claude-haiku-4-5", providerID: "anthropic" })
      const messages = yield* session.context(sessionID)
      const summary = messages.find((message) => message.type === "compaction")
      expect(summary).toMatchObject({ type: "compaction", status: "completed", summary: "S1", recent: "R1" })
      expect(messages).toContainEqual(expect.objectContaining({ type: "user", text: "hello" }))
    }),
  )

  it.effect("succeeds switching to a larger-context model without compaction", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: haiku })
      yield* seedTranscript({
        sessionID,
        summary: "S1".repeat(20_000),
        posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "hello" }],
      })

      const outcome = yield* session.switchModel({ sessionID, model: sonnet })

      expect(outcome).toEqual({ status: "switched" })
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "claude-sonnet-4-5", providerID: "anthropic" })
      expect((yield* session.context(sessionID)).filter((message) => message.type === "compaction")).toHaveLength(1)
      expect((yield* pendingRows(sessionID)).filter((row) => row.type === "compaction")).toHaveLength(0)
    }),
  )

  it.effect("succeeds switching to a smaller-context model that fits without compaction", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({
        sessionID,
        summary: "S1",
        posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "hello" }],
      })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome).toEqual({ status: "switched" })
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "claude-haiku-4-5", providerID: "anthropic" })
      expect((yield* session.context(sessionID)).filter((message) => message.type === "compaction")).toHaveLength(1)
    }),
  )

  it.effect("uses the default 4,096-token compaction safety margin when blocking a switch", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({
        sessionID,
        summary: "x".repeat(195_000),
        posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "y".repeat(60_000) }],
      })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome.status).toBe("blocked")
      if (outcome.status !== "blocked") throw new Error("Expected a blocked switch, got a switch")
      expect(outcome.currentModel).toMatchObject({ id: "claude-sonnet-4-5", providerID: "anthropic" })
      expect(outcome.targetModel).toMatchObject({ id: "claude-haiku-4-5", providerID: "anthropic" })
      expect(outcome.targetSafeInputTokens).toBe(64_000 - 8_192 - 4_096)
      expect(outcome.currentContextTokens).toBeGreaterThan(outcome.targetSafeInputTokens)
      expect(outcome.requiredReductionTokens).toBe(outcome.currentContextTokens - outcome.targetSafeInputTokens)
      expect(outcome.reason).toBe("context-window-exceeded")
      expect(outcome.maximumSafeSummaryBoundary).toBe(messageID(sessionID, SessionMessage.ID.make("msg_u1")))
    }),
  )

  it.effect("uses the resolved default keep-recent setting when offering an advisory boundary", () =>
    Effect.gen(function* () {
      compactionConfig = []
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({
        sessionID,
        summary: "x".repeat(250_000),
        posts: ["msg_p0", "msg_p1", "msg_p2", "msg_p3", "msg_p4"].map((id) => ({
          id: SessionMessage.ID.make(id),
          text: "post-switch context",
        })),
      })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome).toMatchObject({
        status: "blocked",
        maximumSafeSummaryBoundary: messageID(sessionID, SessionMessage.ID.make("msg_p4")),
      })
    }),
  )

  it.effect("uses the last configured compaction safety margin when blocking a switch", () =>
    Effect.gen(function* () {
      compactionConfig = [
        new ConfigCompaction.Info({ context_safety_margin_tokens: 1_024 }),
        new ConfigCompaction.Info({ context_safety_margin_tokens: 2_048 }),
      ]
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({ sessionID, summary: "x".repeat(250_000), posts: [] })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome).toMatchObject({
        status: "blocked",
        targetSafeInputTokens: 64_000 - 8_192 - 2_048,
      })
    }),
  )

  it.effect("retains the mandatory default safety margin when compaction advice is disabled", () =>
    Effect.gen(function* () {
      compactionConfig = [new ConfigCompaction.Info({ advisory: false })]
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({ sessionID, summary: "x".repeat(250_000), posts: [] })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })

      expect(outcome).toMatchObject({
        status: "blocked",
        targetSafeInputTokens: 64_000 - 8_192 - 4_096,
      })
    }),
  )

  it.effect("a blocked switch retains the current active model", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({ sessionID, summary: "x".repeat(250_000), posts: [] })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })
      expect(outcome.status).toBe("blocked")
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "claude-sonnet-4-5", providerID: "anthropic" })
      expect(yield* eventCountFor(sessionID, "session.model.selected")).toBe(0)
      expect((yield* session.context(sessionID)).some((message) => message.type === "model-switched")).toBe(false)
    }),
  )

  it.effect("a blocked switch does not modify SQLite", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({
        sessionID,
        summary: "x".repeat(195_000),
        posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "y".repeat(60_000) }],
      })
      const { db } = yield* Database.Service
      const eventsBefore = yield* eventCountFor(sessionID)
      const messagesBefore = (yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)).length

      const outcome = yield* session.switchModel({ sessionID, model: haiku })
      expect(outcome.status).toBe("blocked")
      expect(yield* eventCountFor(sessionID)).toBe(eventsBefore)
      expect(
        (yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)).length,
      ).toBe(messagesBefore)
      expect(
        (yield* db
          .select()
          .from(SessionProviderRequestTable)
          .where(eq(SessionProviderRequestTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)).length,
      ).toBe(0)
      expect((yield* pendingRows(sessionID)).length).toBe(0)
    }),
  )

  it.effect("a blocked switch never invokes summarization", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      yield* seedTranscript({ sessionID, summary: "x".repeat(250_000), posts: [] })

      const outcome = yield* session.switchModel({ sessionID, model: haiku })
      expect(outcome.status).toBe("blocked")
      expect((yield* pendingRows(sessionID)).filter((row) => row.type === "compaction")).toHaveLength(0)
      expect(yield* eventCountFor(sessionID, "session.compaction.started")).toBe(0)
      expect(yield* eventCountFor(sessionID, "session.compaction.ended")).toBe(0)
      expect(yield* eventCountFor(sessionID, "session.compaction.failed")).toBe(0)
    }),
  )

  it.effect(
    "changing the summarizer helper model config neither changes the main-chat model nor regenerates the summary",
    () =>
      Effect.gen(function* () {
        const { sessionID, location } = createSession()
        efficiencyConfig = new ConfigEfficiency.Info({
          helper_models: new ConfigEfficiency.HelperModels({
            compaction: new ConfigEfficiency.CompactionHelperModels({ main: "session" }),
          }),
        })
        const session = yield* SessionV2.Service
        yield* session.create({ id: sessionID, location, model: sonnet })
        yield* seedTranscript({
          sessionID,
          summary: "S1",
          posts: [{ id: SessionMessage.ID.make("msg_u1"), text: "hello" }],
        })

        expect((yield* session.get(sessionID)).model).toMatchObject({
          id: "claude-sonnet-4-5",
          providerID: "anthropic",
        })

        const outcome = yield* session.switchModel({ sessionID, model: gpt })
        expect(outcome).toEqual({ status: "switched" })
        expect((yield* session.get(sessionID)).model).toMatchObject({ id: "gpt-5.6", providerID: "openai" })

        const messages = yield* session.context(sessionID)
        expect(
          messages.filter((message) => message.type === "compaction" && message.status === "completed"),
        ).toHaveLength(1)
        expect(
          messages.find((message) => message.type === "compaction" && message.status === "completed"),
        ).toMatchObject({ summary: "S1", recent: "R1" })
      }),
  )
})

describe("SessionV2.switchModel in-flight boundary", () => {
  it.effect("applies a switch only after the active request boundary settles", () =>
    Effect.gen(function* () {
      const { sessionID, location } = createSession()
      const session = yield* SessionV2.Service
      yield* session.create({ id: sessionID, location, model: sonnet })
      idleStarted = yield* Deferred.make<void>()
      idleGate = yield* Deferred.make<void>()

      const switched = yield* session.switchModel({ sessionID, model: gpt }).pipe(Effect.forkScoped)
      yield* Deferred.await(idleStarted)
      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "claude-sonnet-4-5", providerID: "anthropic" })
      yield* Deferred.succeed(idleGate, undefined)
      yield* Fiber.join(switched)

      expect((yield* session.get(sessionID)).model).toMatchObject({ id: "gpt-5.6", providerID: "openai" })
      idleStarted = undefined
      idleGate = undefined
    }),
  )
})

describe("SessionProviderRequest continuation invalidation across models and providers", () => {
  const providerIt = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionProviderRequest.node]),
    ),
  )
  providerIt.effect("never reuses continuation state across models or providers", () =>
    Effect.gen(function* () {
      const providerSessionID = SessionV2.ID.make("ses_invalidation")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({ id: providerSessionID, project_id: Project.ID.global, directory: "/project", title: "test" })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const service = yield* SessionProviderRequest.Service
      const record = Effect.fnUntraced(function* (model: ModelV2.Ref) {
        const tracker = yield* service.next({
          sessionID: providerSessionID,
          source: "step",
          agent: AgentV2.ID.make("build"),
          model,
          routeID: "openai-responses",
          promptCacheKey: "same-key",
          systemDigest: "same-system",
          toolDigest: "same-tools",
        })
        yield* tracker.complete({
          continuation: "full",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      })

      yield* record(ref("openai", "gpt-5.6"))
      yield* record(ref("openai", "gpt-5.6-mini"))
      yield* record(ref("anthropic", "claude-sonnet-4-5"))

      const invalidation = (yield* service.list(providerSessionID)).map((item) => item.invalidation)
      expect(invalidation).toEqual(["first-request", "model-switched", "model-switched"])
    }),
  )
})

describe("SessionRunnerCache prompt cache namespace identity", () => {
  const base = {
    projectID: "prj_test",
    directory: "/project",
    providerID: "openai",
    modelID: "gpt-5.6",
    variant: "default",
    policyRevision: "revision",
    permissions: [],
    system: [],
    tools: [],
  }
  test("changes when the model id changes on a model switch", () => {
    expect(SessionRunnerCache.promptCacheNamespace(base)).not.toBe(
      SessionRunnerCache.promptCacheNamespace({ ...base, modelID: "gpt-5.6-mini" }),
    )
  })
  test("changes when the provider changes on a provider switch", () => {
    expect(SessionRunnerCache.promptCacheNamespace(base)).not.toBe(
      SessionRunnerCache.promptCacheNamespace({ ...base, providerID: "anthropic", modelID: "claude-sonnet-4-5" }),
    )
  })
  test("changes when the variant changes", () => {
    expect(SessionRunnerCache.promptCacheNamespace(base)).not.toBe(
      SessionRunnerCache.promptCacheNamespace({ ...base, variant: "high" }),
    )
  })
  test("stays stable for the same model identity", () => {
    expect(SessionRunnerCache.promptCacheNamespace(base)).toBe(SessionRunnerCache.promptCacheNamespace(base))
  })
})

describe("SessionModelSwitch decision logic", () => {
  test("offers an advisory boundary only when keep_recent_messages is configured", () => {
    const posts = ["msg_p0", "msg_p1", "msg_p2", "msg_p3", "msg_p4"].map((id, index) =>
      SessionMessage.User.make({
        type: "user",
        id: SessionMessage.ID.make(id),
        text: index < 3 ? "y".repeat(60_000) : "short recent message",
        files: [],
        agents: [],
        time: { created: DateTime.makeUnsafe(index) },
      }),
    )
    const outcome = SessionModelSwitch.decide({
      currentModel: sonnet,
      targetModel: haiku,
      model: sonnet,
      target: SessionContextBudget.resolveCapabilities(
        catalogModels,
        ProviderV2.ID.make("anthropic"),
        ModelV2.ID.make("claude-haiku-4-5"),
        { safetyMarginTokens: 0 },
      ),
      messages: [
        SessionMessage.CompactionCompleted.make({
          type: "compaction",
          id: SessionMessage.ID.make("msg_summary"),
          status: "completed",
          reason: "auto",
          summary: "x".repeat(195_000),
          recent: "R1",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        ...posts,
      ],
      keepRecentMessages: 2,
    })
    expect(outcome).toMatchObject({ status: "blocked", maximumSafeSummaryBoundary: SessionMessage.ID.make("msg_p2") })
  })

  test("an unresolvable target proceeds exactly as before", () => {
    expect(
      SessionModelSwitch.decide({
        currentModel: sonnet,
        targetModel: haiku,
        messages: [],
        model: sonnet,
        target: undefined,
        keepRecentMessages: undefined,
      }),
    ).toEqual({ status: "switched" })
  })
  test("a session without a current model cannot be blocked", () => {
    expect(
      SessionModelSwitch.decide({
        targetModel: haiku,
        messages: [],
        model: haiku,
        target: SessionContextBudget.resolveCapabilities(
          catalogModels,
          ProviderV2.ID.make("anthropic"),
          ModelV2.ID.make("claude-haiku-4-5"),
        ),
        keepRecentMessages: undefined,
      }),
    ).toEqual({ status: "switched" })
  })
})
