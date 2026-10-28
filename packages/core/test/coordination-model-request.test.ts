import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Provider } from "@ycoding-ai/schema/provider"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
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
import { CatalogModel } from "@ycoding-ai/core/model"
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
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionMessage } from "@ycoding-ai/core/session/message"
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
import { SessionProviderRequestTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { InstructionEntry } from "@ycoding-ai/core/session/instruction-entry"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { Snapshot } from "@ycoding-ai/core/snapshot"
import { Tool } from "@ycoding-ai/core/tool/tool"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
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
const fixtureTools = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode]), [
  [Location.node, Location.boundNode({ directory: runnerDirectory })],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
]).pipe(
  Layer.tap((context) => {
    const registry = Context.get(context, ToolRegistry.Service)
    return registry.register(
      Object.fromEntries(toolNamesFixture.map((name) => [name, fixtureTool(name)])),
      { codemode: false },
    )
  }),
)
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
  [ToolRegistry.node, fixtureTools],
  [ToolRegistry.toolsNode, fixtureTools],
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
      [ToolRegistry.node, fixtureTools],
      [ToolRegistry.toolsNode, fixtureTools],
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
const admit = (session: Session.Interface, text: string) => session.prompt({ sessionID, text, resume: false })
const toolNames = (request: LLMRequest | undefined) => request?.tools.map((tool) => tool.name) ?? []
const providerRows = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ agent: SessionProviderRequestTable.agent, model: SessionProviderRequestTable.model })
      .from(SessionProviderRequestTable)
      .where(eq(SessionProviderRequestTable.session_id, id))
      .all()
      .pipe(Effect.orDie)
  })
const setupProject = Effect.gen(function* () {
  const session = yield* setup
  yield* insertSession(otherSessionID)
  const coordination = yield* CoordinationService.Service
  const group = yield* coordination.create({ name: "Runner team", masterSessionID: otherSessionID, memberSessionIDs: [sessionID] })
  return { session, coordination, group }
})
const overrideRef = CatalogModel.Ref.make({
  providerID: Provider.ID.make("fake"),
  id: CatalogModel.ID.make("replacement"),
  variant: CatalogModel.VariantID.make("medium"),
})
const sendFromMaster = (groupID: string, text: string, model?: CatalogModel.Ref) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const inputID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, {
      sessionID,
      inputID,
      input: {
        type: "user",
        delivery: "steer",
        data: { text, metadata: { inputOrigin: "coordination", coordination: { groupID, senderSessionID: otherSessionID, messageID: inputID, ...(model === undefined ? {} : { model }) } } },
      },
    })
  })
const requestFor = (id: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.prompt({ sessionID: id, text, resume: false })
    response = replyText("Reply", `reply-${id}`)
    yield* session.resume(id)
    return requests.at(-1)
  })

describe("project tool and model request materialization", () => {
  it.effect("ordinary Sessions keep their configured tools and model and never see the project tool", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Ordinary work")
      response = replyText("Ordinary reply", "ordinary")
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      const names = toolNames(requests[0])
      expect(names).toEqual(expect.arrayContaining(["shell", "patch", "edit", "mcp_fixture_update"]))
      expect(names).not.toContain("project")
      expect(JSON.stringify(requests[0])).not.toContain("Project notifications")
      expect(JSON.stringify(requests[0]?.system)).not.toContain("Coordinate and supervise only")
      const rows = yield* providerRows(sessionID)
      expect(rows[0]?.model.id).toBe(CatalogModel.ID.make("fake-model"))
    }),
  )

  it.effect("a Master keeps every ordinary tool, gains the project tool, and gets the Master instructions", () =>
    Effect.gen(function* () {
      yield* setupProject
      const request = yield* requestFor(otherSessionID, "Coordinate the team")
      const names = toolNames(request)
      expect(names).toEqual(expect.arrayContaining(["project", "shell", "patch", "edit", "write", "read", "mcp_fixture_update"]))
      expect(JSON.stringify(request)).toContain("Project notifications")
      expect(JSON.stringify(request?.system)).toContain("Coordinate and supervise only")
    }),
  )

  it.effect("executor children never gain the project tool from ancestry; recorded owners gain it until ownership is released", () =>
    Effect.gen(function* () {
      const fixture = yield* setupProject
      const masterChild = Session.ID.make("ses_coord_master_child")
      const memberChild = Session.ID.make("ses_coord_member_child")
      yield* insertSession(masterChild, otherSessionID)
      yield* insertSession(memberChild, sessionID)
      const masterRequest = yield* requestFor(masterChild, "Drive the member")
      expect(toolNames(masterRequest)).not.toContain("project")
      expect(JSON.stringify(masterRequest?.system)).not.toContain("Coordinate and supervise only")
      yield* fixture.coordination.setOwner(fixture.group.id, { sessionID, ownerSessionID: masterChild })
      const supervising = yield* requestFor(masterChild, "Supervise the member")
      expect(toolNames(supervising)).toContain("project")
      expect(JSON.stringify(supervising)).toContain("Project role: supervisor")
      const executor = Session.ID.make("ses_coord_owned_executor")
      yield* insertSession(executor, masterChild)
      expect(toolNames(yield* requestFor(executor, "Implement the assignment"))).not.toContain("project")
      yield* fixture.coordination.setOwner(fixture.group.id, { sessionID })
      expect(toolNames(yield* requestFor(masterChild, "After release"))).not.toContain("project")
      const memberRequest = yield* requestFor(sessionID, "Member work")
      expect(toolNames(memberRequest)).not.toContain("project")
      expect(JSON.stringify(memberRequest?.system)).not.toContain("Coordinate and supervise only")
      const childRequest = yield* requestFor(memberChild, "Member child work")
      expect(toolNames(childRequest)).not.toContain("project")
      expect(JSON.stringify(childRequest?.system)).not.toContain("Coordinate and supervise only")
      expect(toolNames(yield* requestFor(memberChild, "Again"))).toContain("shell")
    }),
  )

  it.effect("deleting the Project removes the project tool from the former Master", () =>
    Effect.gen(function* () {
      const fixture = yield* setupProject
      expect(toolNames(yield* requestFor(otherSessionID, "First"))).toContain("project")
      yield* fixture.coordination.delete(fixture.group.id)
      expect(toolNames(yield* requestFor(otherSessionID, "Second"))).not.toContain("project")
    }),
  )

  it.effect("a coordination message's model override applies to its turn and a later human input restores the configured model", () =>
    Effect.gen(function* () {
      const fixture = yield* setupProject
      yield* sendFromMaster(fixture.group.id, "Assigned work", overrideRef)
      response = replyText("Assigned reply", "assigned")
      yield* fixture.session.resume(sessionID)
      const assigned = yield* providerRows(sessionID)
      expect(assigned.at(-1)?.model).toMatchObject({ id: "replacement", variant: "medium" })
      yield* admit(fixture.session, "Human follow-up")
      response = replyText("Human reply", "human-next")
      yield* fixture.session.resume(sessionID)
      const rows = yield* providerRows(sessionID)
      expect(rows.length).toBeGreaterThan(assigned.length)
      expect(rows.at(-1)?.model.id).toBe(CatalogModel.ID.make("fake-model"))
    }),
  )

  it.effect("a coordination message without a model override uses the configured model", () =>
    Effect.gen(function* () {
      const fixture = yield* setupProject
      yield* sendFromMaster(fixture.group.id, "Plain work")
      response = replyText("Plain reply", "plain")
      yield* fixture.session.resume(sessionID)
      expect((yield* providerRows(sessionID)).at(-1)?.model.id).toBe(CatalogModel.ID.make("fake-model"))
    }),
  )
})
