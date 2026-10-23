import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { Coordination } from "@ycoding-ai/schema/coordination"
import { Provider } from "@ycoding-ai/schema/provider"
import { Agent } from "@ycoding-ai/core/agent"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { CoordinationService } from "@ycoding-ai/core/coordination/index"
import { CoordinationAccessResolver } from "@ycoding-ai/core/coordination/access"
import { CoordinationDispatchSelection } from "@ycoding-ai/core/coordination/selection"
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
import { CoordinationRuntime } from "@ycoding-ai/core/session/coordination-runtime"
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
import { Effect, Layer, Schema, Stream } from "effect"
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
    snapshot: () => Effect.die("unused"),
    snapshots: () => Effect.die("unused"),
    reconsider: () => Effect.die("unused"),
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
  "coordination",
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
  name: "test/coordination-model-request-tools",
  layer: fixtureTools,
  deps: [ToolRegistry.node],
})
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
  PluginSupervisor.Service.of({ flush: Effect.void }),
)
const compactionExecution = Layer.succeed(
  SessionCompactionExecution.Service,
  SessionCompactionExecution.Service.of({
    start: () => Effect.void,
    run: () => Effect.die("unused"),
  }),
)
const dispatchSelection: Coordination.DispatchSelection = {
  agent: Agent.ID.make("occam"),
  model: CatalogModel.Ref.make({
    providerID: Provider.ID.make("fake"),
    id: CatalogModel.ID.make("replacement"),
    variant: CatalogModel.VariantID.make("medium"),
  }),
  reason: "Bounded assignment with settled behavior",
}
const fixtureSelections = CoordinationDispatchSelection.layerWith((_target, chosen) =>
  Effect.gen(function* () {
    const agent =
      chosen.agent === "occam" || chosen.agent === "build"
        ? { ...Agent.Info.empty(chosen.agent), mode: "subagent" as const, hidden: false }
        : undefined
    const info =
      chosen.model.providerID === "fake" && (chosen.model.id === "replacement" || chosen.model.id === "fake-model")
        ? {
            ...CatalogModel.Info.empty(chosen.model.providerID, CatalogModel.ID.make(chosen.model.id)),
            variants: ["low", "medium", "high"].map((id) => ({ id: CatalogModel.VariantID.make(id) })),
          }
        : undefined
    const problem = CoordinationDispatchSelection.check({ agent, model: info, selection: chosen })
    if (problem !== undefined)
      return yield* new CoordinationDispatchSelection.InvalidSelectionError({ message: problem })
  }),
)
const coordinationLayer = CoordinationService.layer.pipe(Layer.provide(fixtureSelections))
const resolverLayer = Layer.effect(
  CoordinationAccessResolver.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const coordination = yield* CoordinationService.Service
    return CoordinationAccessResolver.Service.of(CoordinationAccessResolver.make({ db: database.db, coordination }))
  }),
).pipe(Layer.provide(coordinationLayer))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
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
  [CoordinationAccessResolver.node, resolverLayer],
  [CoordinationService.node, coordinationLayer],
  [CoordinationDispatchSelection.node, fixtureSelections],
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
).pipe(Layer.provide(runnerLayer))
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
      CoordinationDispatchSelection.node,
      CoordinationAccessResolver.node,
    ]),
    [
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
      [CoordinationDispatchSelection.node, fixtureSelections],
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
  const agents = yield* Agent.Service
  yield* agents.transform((draft) => {
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
const setupCoordination = Effect.gen(function* () {
  const session = yield* setup
  yield* insertSession(otherSessionID)
  const coordination = yield* CoordinationService.Service
  const group = yield* coordination.create(
    { kind: "human" },
    {
      name: "Runner team",
      policy: { concurrency: 2, queueCapacity: 10 },
      members: [
        { sessionID: otherSessionID, role: "coordinator" },
        { sessionID, role: "worker", allowedTools: ["read", "edit", "shell"], resourceScopes: ["src/*"] },
      ],
    },
  )
  const armed = yield* coordination.arm({ kind: "human" }, { groupID: group.id, expectedRevision: group.revision })
  const actor = { kind: "coordinator" as const, sessionID: otherSessionID }
  const claim = yield* coordination.claim(actor, {
    groupID: group.id,
    expectedRevision: armed.revision,
    targetSessionID: sessionID,
    leaseMs: 60_000,
  })
  return { session, coordination, group: armed, claim, actor }
})
const dispatchToWorker = (
  fixture: Effect.Success<typeof setupCoordination>,
  text: string,
  chosen: Coordination.DispatchSelection,
  extra?: { readonly allowedTools?: string[] },
) =>
  Effect.gen(function* () {
    const current = yield* fixture.coordination.get(fixture.group.id)
    return yield* fixture.coordination.dispatch(fixture.actor, {
      groupID: fixture.group.id,
      expectedRevision: current.revision,
      generation: fixture.claim.generation,
      targetSessionID: sessionID,
      text,
      selection: chosen,
      ...(extra ?? {}),
    })
  })
const admitDispatch = (fixture: Effect.Success<typeof setupCoordination>, dispatch: Coordination.DispatchInfo) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventRuntime.Service
    const runtime = CoordinationRuntime.make({ db, events, coordination: fixture.coordination, wake: () => Effect.void })
    return yield* runtime.admit(dispatch)
  })

describe("coordination model request materialization", () => {
  it.effect("ordinary Sessions keep their configured tools, agent, and model", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* admit(session, "Ordinary work")
      response = replyText("Ordinary reply", "ordinary")
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(toolNames(requests[0])).toEqual(
        expect.arrayContaining(["shell", "patch", "edit", "coordination", "mcp_fixture_update"]),
      )
      expect(JSON.stringify(requests[0])).not.toContain("I need [the concrete outcome]")
      const rows = yield* providerRows(sessionID)
      expect(rows[0]?.agent).not.toBe("occam")
      expect(rows[0]?.model.id).toBe(CatalogModel.ID.make("fake-model"))
    }),
  )

  it.effect("armed coordinators lose implementation tools and gain the coordination voice instructions", () =>
    Effect.gen(function* () {
      const fixture = yield* setupCoordination
      yield* fixture.session.prompt({ sessionID: otherSessionID, text: "Coordinate the team", resume: false })
      response = replyText("Coordinating", "coordinator")
      yield* fixture.session.resume(otherSessionID)
      expect(requests).toHaveLength(1)
      const names = toolNames(requests[0])
      for (const banned of ["shell", "patch", "edit", "write", "mcp_fixture_update"]) expect(names).not.toContain(banned)
      for (const allowed of ["coordination", "read", "glob", "grep", "decision"]) expect(names).toContain(allowed)
      expect(JSON.stringify(requests[0])).toContain("I need [the concrete outcome]")
      expect(JSON.stringify(requests[0])).toContain("Do not invent decisions")
    }),
  )

  it.effect("a promoted worker assignment narrows the first physical request and applies its selection", () =>
    Effect.gen(function* () {
      const fixture = yield* setupCoordination
      const first = yield* dispatchToWorker(fixture, "Assigned work", dispatchSelection, {
        allowedTools: ["read", "edit"],
      })
      const second = yield* dispatchToWorker(
        fixture,
        "Queued work",
        { ...dispatchSelection, agent: Agent.ID.make("build"), reason: "Queued choice must not leak into the active assignment" },
        { allowedTools: ["glob"] },
      )
      expect(second.status).toBe("queued")
      yield* admitDispatch(fixture, first)
      response = replyText("Assigned reply", "assigned")
      yield* fixture.session.resume(sessionID)
      expect(requests).toHaveLength(1)
      const names = toolNames(requests[0])
      expect(names).toEqual(expect.arrayContaining(["read", "edit"]))
      for (const banned of ["shell", "patch", "write", "glob", "mcp_fixture_update"]) expect(names).not.toContain(banned)
      const rows = yield* providerRows(sessionID)
      expect(rows.at(-1)?.agent).toBe(Agent.ID.make("occam"))
      expect(rows.at(-1)?.model).toMatchObject({ id: "replacement", variant: "medium" })
      const { db } = yield* Database.Service
      const stored = yield* db
        .select({ agent: SessionTable.agent, model: SessionTable.model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(stored?.agent ?? null).toBeNull()
      expect(stored?.model ?? null).toBeNull()
      expect(JSON.stringify(requests[0])).not.toContain("I need [the concrete outcome]")
    }),
  )

  it.effect("later human input restores the configured Session selection without touching persistent defaults", () =>
    Effect.gen(function* () {
      const fixture = yield* setupCoordination
      const first = yield* dispatchToWorker(fixture, "Assigned work", dispatchSelection, {
        allowedTools: ["read", "edit"],
      })
      yield* admitDispatch(fixture, first)
      response = replyText("Assigned reply", "assigned-first")
      yield* fixture.session.resume(sessionID)
      const assignedRows = yield* providerRows(sessionID)
      yield* fixture.coordination.settleDispatch(
        { kind: "system" },
        { groupID: fixture.group.id, dispatchID: first.id, outcome: "completed" },
      )
      yield* admit(fixture.session, "Human follow-up")
      response = replyText("Human reply", "human-next")
      yield* fixture.session.resume(sessionID)
      const rows = yield* providerRows(sessionID)
      expect(rows.length).toBeGreaterThan(assignedRows.length)
      expect(rows.at(-1)?.agent).not.toBe("occam")
      expect(rows.at(-1)?.model.id).toBe(CatalogModel.ID.make("fake-model"))
      const names = toolNames(requests.at(-1))
      expect(names).toContain("shell")
      expect(names).not.toContain("patch")
    }),
  )

  it.effect("independent standing restrictions intersect with the assignment narrowing", () =>
    Effect.gen(function* () {
      const fixture = yield* setupCoordination
      const coordinator2 = Session.ID.make("ses_coord_coordinator2")
      yield* insertSession(coordinator2)
      const second = yield* fixture.coordination.create(
        { kind: "human" },
        {
          name: "Observer overlap",
          policy: { concurrency: 1, queueCapacity: 4 },
          members: [
            { sessionID: coordinator2, role: "coordinator" },
            { sessionID, role: "observer" },
          ],
        },
      )
      yield* fixture.coordination.arm({ kind: "human" }, { groupID: second.id, expectedRevision: second.revision })
      const first = yield* dispatchToWorker(fixture, "Assigned work", dispatchSelection, {
        allowedTools: ["read", "edit"],
      })
      yield* admitDispatch(fixture, first)
      response = replyText("Intersected reply", "intersected")
      yield* fixture.session.resume(sessionID)
      const names = toolNames(requests.at(-1))
      expect(names).toContain("read")
      expect(names).not.toContain("edit")
      expect(names).not.toContain("shell")
    }),
  )

  it.effect("a subagent of a coordinator does not inherit the coordinator implementation ban", () =>
    Effect.gen(function* () {
      const fixture = yield* setupCoordination
      const childID = Session.ID.make("ses_coord_child")
      yield* insertSession(childID, otherSessionID)
      yield* fixture.session.prompt({ sessionID: childID, text: "Child work", resume: false })
      response = replyText("Child reply", "child")
      yield* fixture.session.resume(childID)
      const names = toolNames(requests.at(-1))
      expect(names).toEqual(expect.arrayContaining(["shell", "patch", "edit"]))
    }),
  )
})
