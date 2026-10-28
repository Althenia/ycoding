import { expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { Job } from "@ycoding-ai/core/job"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { AppProcess } from "@ycoding-ai/core/process"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionRunnerLLM } from "@ycoding-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { Shell } from "@ycoding-ai/core/shell"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { fixedLocations } from "./fixture/location-map"

const requests: LLMRequest[] = []
const responses: LLMEvent[][] = []
const executions: string[] = []
const runnerDirectory = AbsolutePath.make(import.meta.dir)
const model = Model.make({
  id: "fake-model",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 262_144, output: 8_192 } }),
})
const modelRef = CatalogModel.Ref.make({ providerID: Provider.ID.make("fake"), id: CatalogModel.ID.make("fake-model") })

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const echoNode = makeLocationNode({
  name: "test/restart-recovery-tools",
  layer: Layer.effectDiscard(
    ToolRegistry.Service.use((registry) =>
      registry.register(
        {
          echo: Tool.make({
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
            execute: ({ text }) =>
              Effect.sync(() => {
                executions.push(text)
                return { text }
              }),
          }),
        },
        { codemode: false },
      ),
    ),
  ),
  deps: [ToolRegistry.node],
})
const empty = { load: () => Effect.succeed(Instructions.empty) }
const replacements = [
  [LayerNodePlatform.llmClient, client],
  [Project.node, Layer.mock(Project.Service, { resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }) })],
  [
    Permission.node,
    Layer.mock(Permission.Service, {
      deferPending: () => Effect.void,
      evaluateEffective: () => Effect.succeed("allow" as const),
    }),
  ],
  [
    Catalog.node,
    Layer.mock(Catalog.Service, {
      provider: { get: () => Effect.succeed(undefined), all: () => Effect.succeed([]), available: () => Effect.succeed([]) },
      model: {
        defaultSelection: () => Effect.succeed(undefined),
        forConnection: (value) => Effect.succeed(value),
        get: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.succeed(undefined),
        small: () => Effect.succeed(undefined),
      },
    }),
  ],
  [
    SessionRunnerModel.node,
    SessionRunnerModel.layerWith(() => Effect.succeed(SessionRunnerModel.resolved(model, undefined, [], "a".repeat(64)))),
  ],
  [InstructionBuiltIns.node, Layer.mock(InstructionBuiltIns.Service, empty)],
  [InstructionDiscovery.node, Layer.mock(InstructionDiscovery.Service, empty)],
  [SkillInstructions.node, Layer.mock(SkillInstructions.Service, empty)],
  [ReferenceInstructions.node, Layer.mock(ReferenceInstructions.Service, empty)],
  [McpInstructions.node, Layer.mock(McpInstructions.Service, empty)],
  [Location.node, Location.boundNode({ directory: runnerDirectory })],
  [
    Snapshot.node,
    Layer.mock(Snapshot.Service, {
      capture: () => Effect.succeed(undefined),
      files: () => Effect.succeed([]),
      fingerprints: (input) => Effect.succeed(input.paths.map((path) => ({ path, digest: "missing" }))),
    }),
  ],
  [
    Config.node,
    Layer.mock(Config.Service, {
      diagnostics: () => Effect.succeed([]),
      reload: () => Effect.void,
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                keep_recent_messages: 20,
                context_safety_margin_tokens: 3_000,
                reserved_output_tokens: 1_000,
              }),
            }),
          }),
        ]),
    }),
  ],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PluginSupervisor.node, Layer.mock(PluginSupervisor.Service, { flush: Effect.void })],
  [SessionCompaction.node, Layer.mock(SessionCompaction.Service, { manifest: () => Effect.die("unused") })],
  [
    SessionCompactionExecution.node,
    Layer.mock(SessionCompactionExecution.Service, { start: () => Effect.die("unused"), run: () => Effect.die("unused") }),
  ],
  [
    KeepAwake.node,
    Layer.mock(KeepAwake.Service, {
      hold: () => Effect.succeed({ state: "off" as const }),
      release: () => Effect.succeed({ state: "off" as const }),
      get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
    }),
  ],
] as const
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [...replacements])
const execution = Layer.unwrap(
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    return SessionExecution.layer.pipe(
      Layer.provide(
        Layer.effect(
          LocationServiceMap.Service,
          fixedLocations(
            () =>
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
              Layer.mergeAll(
                Layer.succeed(SessionRunner.Service, runner),
                Layer.mock(Shell.Service, { list: () => Effect.succeed([]) }),
                Layer.mock(SessionGoal.Service, { continuation: () => Effect.die("no goal") }),
              ) as unknown as Layer.Layer<LocationServices>,
          ),
        ),
      ),
    )
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Database.node,
      Job.node,
      EventRuntime.node,
      Form.node,
      SessionProjector.node,
      SessionStore.node,
      SessionProviderRequest.node,
      Agent.node,
      Catalog.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      PluginHooks.node,
      echoNode,
      SessionRunnerModel.node,
      SessionTodo.node,
      SessionAutonomy.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      InstructionEntry.node,
      SkillInstructions.node,
      Skill.node,
      LocationServiceMap.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionCompactionJob.node,
      SessionContextState.node,
      SessionLiveState.node,
      SessionGuardrail.node,
      SessionCompactionExecution.node,
      SessionExecution.node,
      Session.node,
      AttachmentStore.node,
      SessionContext.node,
      SessionModelRequest.node,
      SessionOrchestration.node,
      SessionReview.node,
      SessionRestart.node,
    ]),
    [...replacements, [SessionExecution.node, execution]],
  ),
)

const text = (value: string, id: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text: value }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const crashedChild = (tools: ReadonlyArray<{ readonly callID: string; readonly called: boolean }>) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((draft) =>
      draft.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )
    const session = yield* Session.Service
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    const root = yield* session.create({ location: { directory: runnerDirectory }, agent: Agent.ID.make("build") })
    const child = yield* session.create({ parentID: root.id, agent: Agent.ID.make("build") })
    yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: child.id,
        parent_id: root.id,
        parent_assistant_message_id: SessionMessage.ID.make(`msg_launch_${child.id}`),
        tool_call_id: `call_launch_${child.id}`,
        input_id: SessionMessage.ID.make(`msg_input_${child.id}`),
        description: "recover through the runner",
        agent: Agent.ID.make("build"),
        model: modelRef,
        prompt_digest: "digest",
        background: true,
        delivery: "steer",
        state: "running",
        revision: 1,
        owner_pid: 2_000_000_000,
        owner_started: "Thu Jan  1 00:00:00 1970",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: child.id })
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: child.id,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: modelRef,
    })
    yield* events.publish(SessionEvent.Text.Started, { sessionID: child.id, assistantMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID: child.id, assistantMessageID, ordinal: 0, text: "Calling echo" })
    for (const tool of tools) {
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID: child.id, assistantMessageID, callID: tool.callID, name: "echo" })
      if (tool.called)
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: child.id,
          assistantMessageID,
          callID: tool.callID,
          input: { text: tool.callID },
          executed: false,
        })
    }
    const restart = yield* SessionRestart.Service
    yield* restart.reconcileInterruptedExecutions
    yield* restart.recoverTasks
    return { root, child }
  })

const reset = (...queued: ReadonlyArray<ReadonlyArray<LLMEvent>>) =>
  Effect.sync(() => {
    requests.length = 0
    executions.length = 0
    responses.splice(0, responses.length, ...queued.map((events) => [...events]))
  })

const toolPairs = (request: LLMRequest) => {
  const parts = request.messages.flatMap((message) => message.content)
  const results = parts.flatMap((part) => (part.type === "tool-result" ? [part] : []))
  return {
    unpaired: parts.flatMap((part) =>
      part.type === "tool-call" && !results.some((result) => result.id === part.id) ? [part.id] : [],
    ),
    results: results.map((result) => [result.id, result.result.type]),
  }
}

it.live("a crash while a tool call was still streaming resumes with a settled call and executes nothing", () =>
  Effect.gen(function* () {
    yield* reset(text("Recovered.", "text-recovered"))
    const family = yield* crashedChild([{ callID: "call_partial", called: false }])
    const execution = yield* SessionExecution.Service
    yield* execution.awaitIdle(family.child.id)
    expect(requests).toHaveLength(1)
    expect(toolPairs(requests[0]!)).toEqual({ unpaired: [], results: [["call_partial", "error"]] })
    expect(JSON.stringify(requests[0]!.messages)).toContain("were not executed")
    expect(executions).toEqual([])
    const db = (yield* Database.Service).db
    const task = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, family.child.id)).get().pipe(Effect.orDie)
    expect(task?.state).toBe("completed")
  }),
)

it.live("a human Continue after uncertain and streaming calls sends settled pairs and never reruns the original call", () =>
  Effect.gen(function* () {
    yield* reset()
    const family = yield* crashedChild([
      { callID: "call_ran", called: true },
      { callID: "call_partial", called: false },
    ])
    expect(requests).toEqual([])
    const reviews = yield* SessionReview.Service
    const item = (yield* reviews.list(family.root.id)).find((candidate) => candidate.kind === "recovery")
    expect(item?.payload).toMatchObject({ type: "recovery", tools: [{ callID: "call_ran", name: "echo" }] })
    responses.push(text("Checked the earlier call.", "text-continued"))
    yield* reviews.decide({ sessionID: family.root.id, itemID: item!.itemID, decision: { kind: "recovery", choice: "continue" } })
    const execution = yield* SessionExecution.Service
    yield* execution.awaitIdle(family.child.id)
    expect(requests).toHaveLength(1)
    expect(toolPairs(requests[0]!)).toEqual({
      unpaired: [],
      results: [
        ["call_ran", "error"],
        ["call_partial", "error"],
      ],
    })
    expect(JSON.stringify(requests[0]!.messages)).toContain("The user chose Continue")
    expect(executions).toEqual([])
  }),
)
