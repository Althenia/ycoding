import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNodePlatform } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { InstructionDiscovery } from "@ycoding-ai/core/instruction-discovery"
import { Instructions } from "@ycoding-ai/core/instructions"
import { InstructionBuiltIns } from "@ycoding-ai/core/instructions/builtins"
import { Job } from "@ycoding-ai/core/job"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { McpInstructions } from "@ycoding-ai/core/mcp/instructions"
import { Permission } from "@ycoding-ai/core/permission"
import { AgentPlugin } from "@ycoding-ai/core/plugin/agent"
import { PluginHooks } from "@ycoding-ai/core/plugin/hooks"
import { PluginSupervisor } from "@ycoding-ai/core/plugin/supervisor"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ReferenceInstructions } from "@ycoding-ai/core/reference/instructions"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionContext } from "@ycoding-ai/core/session/context"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionModelRequest } from "@ycoding-ai/core/session/model-request"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionRunCoordinator } from "@ycoding-ai/core/session/run-coordinator"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionRunnerLLM } from "@ycoding-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTodo } from "@ycoding-ai/core/session/todo"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
const runnerDirectory = AbsolutePath.make(import.meta.dir)
let response: LLMEvent[] = []
const replyText = (text: string, id: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(response)
    },
    generate: () => Effect.die("unused"),
  }),
)
const testLimits = { context: 262_144, output: 8_192 } as const
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route.with({ limits: testLimits }) })
const replacementModel = Model.make({
  id: "replacement",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: testLimits }),
})
const models = SessionRunnerModel.layerWith((session) =>
  Effect.succeed(
    SessionRunnerModel.resolved(session.model?.id === "replacement" ? replacementModel : model, session.model?.variant, []),
  ),
)
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    deferPending: () => Effect.void,
    reconcileAutonomy: () => Effect.void,
    evaluateEffective: () => Effect.succeed("allow"),
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    replyDelegated: () => Effect.die("unused"),
    delegatedEligible: () => Effect.die("unused"),
    snapshot: () => Effect.die("unused"),
    snapshots: () => Effect.die("unused"),
    reconsider: () => Effect.die("unused"),
    escalate: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const toolNamesFixture = [
  "shell",
  "patch",
  "edit",
  "write",
  "read",
  "glob",
  "grep",
  "project",
  "decision",
  "question",
  "todowrite",
  "goal",
  "task_complete",
  "subagent",
  "subagent_control",
  "mcp_fixture_update",
] as const
const fixtureTool = (name: string) =>
  Tool.make({
    description: `Fixture ${name}`,
    input: Schema.Struct({}),
    output: Schema.Struct({}),
    execute: () => Effect.succeed({}),
  })
const fixtureTools = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register(
      Object.fromEntries(toolNamesFixture.map((name) => [name, fixtureTool(name)])),
      { codemode: false },
    ),
  ),
)
const fixtureToolsNode = makeLocationNode({
  name: "test/coordination-hierarchy-prompt-tools",
  layer: fixtureTools,
  deps: [ToolRegistry.node],
})
const fixtureAgents = AppNodeBuilder.build(Agent.node).pipe(
  Layer.tap((context) => {
    const agents = Context.get(context, Agent.Service)
    return agents.transform((draft) => {
      AgentPlugin.apply(draft)
      draft.update(Agent.ID.make("god"), (agent) => {
        agent.mode = "primary"
        agent.hidden = false
      })
      draft.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
        agent.hidden = false
      })
      draft.update(Agent.ID.make("occam"), (agent) => {
        agent.mode = "subagent"
        agent.hidden = false
      })
    })
  }),
)
const emptyInstructions = () => Effect.succeed(Instructions.empty)
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: emptyInstructions })
const instructionContext = Layer.mock(InstructionDiscovery.Service, { load: emptyInstructions })
const skillInstructions = Layer.mock(SkillInstructions.Service, { load: emptyInstructions })
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, { load: emptyInstructions })
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: emptyInstructions })
const projects = Layer.mock(Project.Service, {
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
})
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({ diagnostics: () => Effect.succeed([]), reload: () => Effect.void, entries: () => Effect.succeed([]) }),
)
const promptCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    defaultSelection: () => Effect.succeed(undefined),
    forConnection: (value) => Effect.succeed(value),
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const snapshotLayer = Layer.succeed(
  Snapshot.Service,
  Snapshot.Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    fingerprints: (input) => Effect.succeed(input.paths.map((path) => ({ path, digest: "missing" }))),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)
const pluginSupervisor = Layer.succeed(
  PluginSupervisor.Service,
  PluginSupervisor.Service.of({ flush: Effect.void, settled: Effect.void }),
)
const compactionExecution = Layer.succeed(
  SessionCompactionExecution.Service,
  SessionCompactionExecution.Service.of({
    start: () => Effect.void,
    run: () => Effect.die("unused"),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Agent.node, fixtureAgents],
  [Snapshot.node, snapshotLayer],
  [LayerNodePlatform.llmClient, client],
  [Catalog.node, promptCatalog],
  [SessionRunnerModel.node, models],
  [InstructionBuiltIns.node, systemContext],
  [InstructionDiscovery.node, instructionContext],
  [Location.node, Location.boundNode({ directory: runnerDirectory })],
  [SkillInstructions.node, skillInstructions],
  [ReferenceInstructions.node, referenceInstructions],
  [Permission.node, permission],
  [Config.node, config],
  [McpInstructions.node, mcpInstructions],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PluginSupervisor.node, pluginSupervisor],
  [
    SessionCompaction.node,
    Layer.succeed(SessionCompaction.Service, SessionCompaction.Service.of({ manifest: () => Effect.die("unused") })),
  ],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const compaction = yield* SessionCompactionExecution.Service
    const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
      drain: (sessionID, force) =>
        sessionRunner.drain({ sessionID, force }).pipe(SessionCompactionExecution.bind(compaction)),
    })
    return SessionExecution.Service.of({
      prepareTask: () => Effect.void,
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      awaitIdle: coordinator.awaitIdle,
      shutdown: coordinator.shutdown(),
      withTransition: coordinator.withTransition,
    })
  }),
).pipe(Layer.provide(runnerLayer), Layer.provide(compactionExecution))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
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
      fixtureToolsNode,
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
      CoordinationService.node,
    ]),
    [
      [Agent.node, fixtureAgents],
      [LayerNodePlatform.llmClient, client],
      [Project.node, projects],
      [Permission.node, permission],
      [Catalog.node, promptCatalog],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: runnerDirectory })],
      [SkillInstructions.node, skillInstructions],
      [ReferenceInstructions.node, referenceInstructions],
      [Snapshot.node, snapshotLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionCompactionExecution.node, compactionExecution],
    ],
  ),
)
const sessionID = Session.ID.make("ses_coord_worker")
const otherSessionID = Session.ID.make("ses_coord_coordinator")
const insertSession = (id: Session.ID, parentID?: Session.ID, agent?: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        ...(parentID === undefined ? {} : { parent_id: parentID }),
        ...(agent === undefined ? {} : { agent }),
        directory: runnerDirectory,
        title: "coordination fixture",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* SessionContextState.initialize(db, id, Date.now())
  })
const setup = Effect.gen(function* () {
  requests.length = 0
  response = replyText("Fixture response", "text-fixture")
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: runnerDirectory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
  return yield* Session.Service
})
const setupProject = Effect.gen(function* () {
  const session = yield* setup
  yield* insertSession(otherSessionID)
  const coordination = yield* CoordinationService.Service
  const group = yield* coordination.create({ name: "Runner team", masterSessionID: otherSessionID, memberSessionIDs: [sessionID] })
  return { session, coordination, group }
})
const requestFor = (id: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.prompt({ sessionID: id, text, resume: false })
    response = replyText("Reply", `reply-${id}`)
    yield* session.resume(id)
    return requests.at(-1)
  })
const systemText = (request: LLMRequest | undefined) => JSON.stringify(request?.system)

describe("Swarm prompt contract", () => {
  it.effect("an ordinary root uses Swarm by default and starts it without replacing itself", () =>
    Effect.gen(function* () {
      yield* setup
      const request = yield* requestFor(sessionID, "Plan project work")
      const system = systemText(request)
      expect(system).toContain("Default to Swarm for Project work")
      expect(system).toContain(
        "`coordination.create {name, masterSessionID: <current root Session ID>, memberSessionIDs: []}`",
      )
      expect(system).toMatch(/same root Session keeps its history and permission, guardrail and answer modes/)
      expect(system).toMatch(/Modes flow down to members only/)
      expect(system).toMatch(/starts inactive.*direct prompt in that same root.*activates it/)
      expect(system).not.toMatch(/`project (?:send|create|answer)`|\btaskTitle\b|Project role: Master/)
      expect(request?.tools.map((tool) => tool.name)).not.toContain("project")
    }),
  )

  it.effect("Master decomposes work, assigns supervisors and reviews integration evidence", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate project work"))
      expect(system).toMatch(/Project role: Master.*Decompose.*assign or transfer.*review integration evidence/)
      expect(system).toContain("The board distinguishes `master`, `supervisor`, `member` and `subagent`")
      expect(system).toContain("Recorded ownership changes appear as handoffs, and results attach to tasks")
      expect(system).toMatch(/one writer per mutable scope/)
      expect(system).not.toContain("`project send`")
    }),
  )

  it.effect(
    "a supervisor records task dependencies and routes permission waits without stopping independent work",
    () =>
      Effect.gen(function* () {
        const { coordination, group } = yield* setupProject
        const supervisor = Session.ID.make("ses_swarm_supervisor")
        yield* insertSession(supervisor, otherSessionID, "occam")
        yield* coordination.setOwner(group.id, { sessionID, ownerSessionID: supervisor })
        const system = systemText(yield* requestFor(supervisor, "Dispatch member tasks"))
        expect(system).toMatch(/Project role: supervisor.*own.*scopes.*dependencies.*routine requests/)
        expect(system).toMatch(/`project send`.*optional `taskTitle` and `dependsOnTaskIDs`/)
        expect(system).toMatch(/stable delivery `messageId`.*`SessionMessage.ID`.*`taskID`/)
        expect(system).toMatch(/dependencies.*earlier tasks in the same group/)
        expect(system).toMatch(
          /pending permission.*own task `waiting`.*explicit dependents.*`blocked`.*independent branches/,
        )
        expect(system).toContain("`blocked` is a task state, not a node state")
        expect(system).toMatch(/resume.*native settlement/)
        expect(system).toMatch(/native `answer`.*`escalate`/)
        expect(system).toMatch(/human-only gates.*permission ceilings/)
        expect(system).not.toContain("`project create`")
      }),
  )

  it.effect("members own verification and executor children report only to their owning main", () =>
    Effect.gen(function* () {
      yield* setupProject
      const executor = Session.ID.make("ses_swarm_member_executor")
      yield* insertSession(executor, sessionID, "occam")
      const member = systemText(yield* requestFor(sessionID, "Implement the member's scope"))
      const child = systemText(yield* requestFor(executor, "Implement one independent part"))
      expect(member).toMatch(/Project role: member.*own implementation and verification/)
      expect(member).toMatch(/Delegate only independent work to your own direct subagents/)
      expect(member).toMatch(/Report.*recorded supervisor/)
      expect(child).toMatch(/Project role: subagent.*bounded result.*owning main Session/)
      expect(child).toContain("no Project authority")
      for (const system of [member, child])
        expect(system).not.toMatch(
          /`coordination\.create|`project (?:send|create|answer)`|\btaskTitle\b|Project role: (?:Master|supervisor)/,
        )
    }),
  )
})

describe("Master hierarchy prompt assembly", () => {
  it.effect("the Master sends supervisor work by steer and leaves member dispatch to its recorded owner", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      expect(system).toContain("Route even single-member work through a recorded supervisor")
      expect(system).toContain("Brief supervisors through `subagent_control` with explicit steer delivery")
      expect(system).toContain("with the resolved placement and `ownerSessionID`, without a prompt")
      expect(system).toContain("never enroll a child or a restricted `scope: standalone` Session")
      expect(system).not.toContain("`dependsOnTaskIDs`")
    }),
  )

  it.effect("released ownership removes supervisor controls from the former owner's next request", () =>
    Effect.gen(function* () {
      const { coordination, group } = yield* setupProject
      const supervisor = Session.ID.make("ses_coord_released_supervisor")
      yield* insertSession(supervisor, otherSessionID, "occam")
      yield* coordination.setOwner(group.id, { sessionID, ownerSessionID: supervisor })
      expect(systemText(yield* requestFor(supervisor, "Supervise"))).toContain("`project send`")
      yield* coordination.setOwner(group.id, { sessionID })
      const released = JSON.stringify(yield* requestFor(supervisor, "After release"))
      expect(released).toContain("The Project coordination role above no longer applies to this Session. Disregard it.")
      expect(released).toContain("Work read-only in the Master's family")
      expect(released).not.toContain("`project send`")
    }),
  )

  it.effect("a supervisor's executor child can review evidence but never inherits supervisor controls", () =>
    Effect.gen(function* () {
      const { coordination, group } = yield* setupProject
      const supervisor = Session.ID.make("ses_coord_supervisor")
      const executor = Session.ID.make("ses_coord_supervisor_executor")
      yield* insertSession(supervisor, otherSessionID, "occam")
      yield* insertSession(executor, supervisor, "occam")
      yield* coordination.setOwner(group.id, { sessionID, ownerSessionID: supervisor })
      const request = yield* requestFor(executor, "Review the check results")
      const system = systemText(request)
      expect(system).toContain("Work read-only in the Master's family")
      expect(system).not.toMatch(/`project (?:send|create|list)`|\btaskTitle\b|Project role: (?:Master|supervisor)/)
      expect(request?.tools.map((tool) => tool.name)).not.toContain("project")
    }),
  )
})
