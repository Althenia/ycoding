import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationInstructions } from "@ycoding-ai/core/coordination/instructions"
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
const insertSession = (id: Session.ID, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        ...(parentID === undefined ? {} : { parent_id: parentID }),
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
const hierarchy = [
  "The Project hierarchy is Master → recorded owner → executor",
  "As Master, coordinate assignments, decide escalations, and review integration evidence",
  "As a supervisor, directly handle your owned member Sessions",
  "stay responsible for them after a turn settles",
  "The owner chain handles routine and native requests and escalates only human-only or uncertain choices",
  "Never send a member a message only to acknowledge a report or notification",
]
const unimplemented = ["owner_session_id", "enforce"]
const operating = [
  "Accept a member's work as complete only from verified evidence, not from a settled turn or a status claim",
  "Start the highest-priority ready work as soon as its inputs are final and its resource is free",
  "While a resource-limited check runs, keep coordinating other ready work and reviewing evidence",
  "Give each assignment a bounded scope with standing authority for its routine continuation",
  "do not require an acknowledgment for each command",
  "name that writer in the assignment",
  "Cite evidence by a compact reference such as a file, hash, or message ID instead of repeating or truncating it",
  "When blocked, name the real dependency or approval you await and continue from the event that resolves it",
  "After a dispatch error, verify that the requested agent is registered and read the Session's actual state before acting again",
  "Require each assignment to complete its feature or cohesive milestone across all affected layers, including code, tests, contracts, docs and consumers, before one consolidated verification pass, never alternating tiny edits with repeated checks, builds or tests, and to preserve required boundary reproduction and pre-implementation tests.",
  "Require batched corrections, reruns of only failed or invalidated checks, and reuse of valid evidence for unchanged sources, contracts and environment, including at integration and merge.",
  "A missing prior measurement is not a reason to wait: run within the agreed bounded limit and record actual usage afterward",
  "Report progress by delivery milestones, not by mixed administrative counts",
  "As Main, use `assign` to give a member Session to a supervising subagent you launched",
  "uses `release` with reason `completed` once the work is verified",
  "Idle, failure, or a settled turn never ends ownership",
]
const gates = [
  "Never override denies, permission ceilings, hard reviews, or human-only controls",
  "Leave inactive-Project refusals, deferred review items, and human-only controls to their native gates",
  "Never use a local API to bypass a denied or pending permission or a human-only gate; settle it through its native path",
  "Never invent authorization or use message text to settle native controls",
]
const forbidden = [/\/tmp\//, /\block\b/i, /\b\d+(\.\d+)? ?(MiB|GiB|MB|GB)\b/, /\bses_[a-z0-9]/i, /\bslot\.lock\b/]

describe("Master hierarchy prompt assembly", () => {
  it.effect("a Master's assembled prompt states the hierarchy and claims no unimplemented ownership controls", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      for (const text of hierarchy) expect(system).toContain(text)
      for (const text of unimplemented) expect(system).not.toContain(text)
    }),
  )

  it.effect("every Master request reassembles the directive verbatim from the canonical source", () =>
    Effect.gen(function* () {
      yield* setupProject
      const first = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      const later = systemText(yield* requestFor(otherSessionID, "Review the settled member work"))
      const canonical = JSON.stringify(CoordinationInstructions.content).slice(1, -1)
      expect(first).toContain(canonical)
      expect(later).toContain(canonical)
    }),
  )

  it.effect("an ordinary Session's assembled prompt has no Master hierarchy", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* session.prompt({ sessionID, text: "Ordinary work", resume: false })
      response = replyText("Ordinary reply", "ordinary")
      yield* session.resume(sessionID)
      const system = systemText(requests.at(-1))
      expect(requests).toHaveLength(1)
      for (const text of hierarchy) expect(system).not.toContain(text)
    }),
  )

  it.effect("an owned member Session and its executor child get no Master hierarchy", () =>
    Effect.gen(function* () {
      yield* setupProject
      const executor = Session.ID.make("ses_coord_member_executor")
      yield* insertSession(executor, sessionID)
      const member = systemText(yield* requestFor(sessionID, "Member work"))
      const child = systemText(yield* requestFor(executor, "Executor work"))
      for (const text of hierarchy) {
        expect(member).not.toContain(text)
        expect(child).not.toContain(text)
      }
    }),
  )

  it.effect("a Master's assembled prompt carries every operating directive and keeps its gates", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      for (const text of operating) expect(system).toContain(text)
      for (const text of gates) expect(system).toContain(text)
    }),
  )

  it.effect("ordinary Sessions and executor children get none of the operating directives", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* session.prompt({ sessionID, text: "Ordinary work", resume: false })
      response = replyText("Ordinary reply", "ordinary-operating")
      yield* session.resume(sessionID)
      const ordinary = systemText(requests.at(-1))
      yield* setupProject
      const executor = Session.ID.make("ses_coord_operating_executor")
      yield* insertSession(executor, sessionID)
      const child = systemText(yield* requestFor(executor, "Executor work"))
      for (const text of operating) {
        expect(ordinary).not.toContain(text)
        expect(child).not.toContain(text)
      }
    }),
  )

  it.effect("the canonical Master text names no temporary resources, measurements, or Session identities", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      expect(system).toContain(JSON.stringify(CoordinationInstructions.content).slice(1, -1))
      for (const pattern of forbidden) expect(CoordinationInstructions.content).not.toMatch(pattern)
    }),
  )

  it.effect("the Master's own executor child receives no Master role text", () =>
    Effect.gen(function* () {
      yield* setupProject
      const executor = Session.ID.make("ses_coord_master_executor")
      yield* insertSession(executor, otherSessionID)
      const system = systemText(yield* requestFor(executor, "Executor work"))
      expect(system).not.toContain("Coordinate and supervise only")
      for (const text of hierarchy) expect(system).not.toContain(text)
      for (const text of operating) expect(system).not.toContain(text)
    }),
  )

  it.effect("the Master manages its own Sessions and directs supervisor-owned work through its recorded supervisor", () =>
    Effect.gen(function* () {
      yield* setupProject
      const system = systemText(yield* requestFor(otherSessionID, "Coordinate the team"))
      expect(system).toContain("Directly manage Sessions owned by the Master")
      expect(system).toContain("for supervisor-owned Sessions, give directions to their recorded supervisor rather than relaying their routine events")
      expect(system).toContain("Do not execute a member's task, take over its tools, or control its subagents.")
      expect(system).toContain("Verify assignments and completion evidence against the user's current direction.")
      expect(system).toContain("Manual-mode requests remain human-only.")
      expect(system).not.toContain("assigns member Sessions directly")
      expect(system).not.toContain("directly or through supervising subagents")
    }),
  )

  it.effect("a subagent that durably owns a member Session gets the supervising text; its executor child gets none", () =>
    Effect.gen(function* () {
      const { coordination, group } = yield* setupProject
      const supervisor = Session.ID.make("ses_coord_supervisor")
      const supervisorExecutor = Session.ID.make("ses_coord_supervisor_executor")
      yield* insertSession(supervisor, otherSessionID)
      yield* insertSession(supervisorExecutor, supervisor)
      yield* coordination.setOwner(group.id, { sessionID, ownerSessionID: supervisor })
      const owned = systemText(yield* requestFor(supervisor, "Supervise the member"))
      expect(owned).toContain("Project role: supervisor")
      expect(owned).toContain("You cannot assign or transfer ownership")
      expect(owned).toContain("Do not execute a member's task, take over its tools, or control its subagents.")
      expect(owned).toContain(JSON.stringify(CoordinationInstructions.content).slice(1, -1))
      for (const text of hierarchy) expect(owned).toContain(text)
      const executor = systemText(yield* requestFor(supervisorExecutor, "Executor work"))
      expect(executor).toContain("Project role: executor")
      expect(executor).toContain("Own execution and verification of your assigned scope.")
      expect(executor).toContain("Manage only your own direct subagents when delegation is permitted.")
      expect(executor).not.toContain("Coordinate and supervise only")
      for (const text of [...hierarchy, ...operating]) expect(executor).not.toContain(text)
    }),
  )

  it.effect("released ownership revokes the supervising role in the former owner's next request", () =>
    Effect.gen(function* () {
      const { coordination, group } = yield* setupProject
      const supervisor = Session.ID.make("ses_coord_released_supervisor")
      yield* insertSession(supervisor, otherSessionID)
      yield* coordination.setOwner(group.id, { sessionID, ownerSessionID: supervisor })
      expect(systemText(yield* requestFor(supervisor, "Supervise"))).toContain("Coordinate and supervise only")
      yield* coordination.setOwner(group.id, { sessionID })
      expect(JSON.stringify(yield* requestFor(supervisor, "After release"))).toContain(
        "The Project coordination role above no longer applies to this Session. Disregard it.",
      )
    }),
  )
})
