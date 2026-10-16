import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, type LLMRequest } from "@ycoding-ai/ai"
import { Agent } from "../src/agent"
import { AgentPlugin } from "../src/plugin/agent"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { Decision } from "../src/decision"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { InstructionDiscovery } from "../src/instruction-discovery"
import { Instructions } from "../src/instructions"
import { Location } from "../src/location"
import { McpInstructions } from "../src/mcp/instructions"
import { CatalogModel } from "../src/model"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { ReferenceInstructions } from "../src/reference/instructions"
import { AbsolutePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionPending } from "../src/session/pending"
import { SessionProjector } from "../src/session/projector"
import { SessionRunner } from "../src/session/runner"
import { SessionRunnerLLM } from "../src/session/runner/llm"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SkillInstructions } from "../src/skill/instructions"
import { Snapshot } from "../src/snapshot"
import { ToolOutputStore } from "../src/tool-output-store"
import { DecisionTool } from "../src/tool/decision"
import { ToolRegistry } from "../src/tool/registry"
import { Effect, Exit, Layer, Stream } from "effect"
import { Permission } from "../src/permission"
import { agentHost, host } from "./plugin/host"
import { registerToolPlugin } from "./lib/tool"

const directory = AbsolutePath.make("/tmp")
const providerID = Provider.ID.make("decision-test")
const baselineID = CatalogModel.ID.make("baseline")

async function run(input: { agent?: Agent.ID; child?: boolean; denied?: boolean }) {
  const requests: LLMRequest[] = []
  const judgments: Decision.Input[] = []
  const layer = AppNodeBuilder.build(LayerNode.group([
    Database.node, EventRuntime.node, SessionStore.node, Agent.node, Catalog.node,
    SessionProjector.node, SessionRunnerLLM.node, ToolRegistry.node, ToolRegistry.toolsNode, Decision.node, Permission.node,
  ]), [
    [Location.node, Location.boundNode({ directory })], [Snapshot.node, Snapshot.noopLayer],
    [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
    [PluginSupervisor.node, Layer.mock(PluginSupervisor.Service, { flush: Effect.void })],
    [InstructionDiscovery.node, Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [SkillInstructions.node, Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [ReferenceInstructions.node, Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [McpInstructions.node, Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Decision.node, Layer.mock(Decision.Service, { evaluate: (value) => Effect.sync(() => judgments.push(value)).pipe(Effect.andThen(Effect.die("Only explicit tool calls may judge"))) })],
    [LayerNodePlatform.llmClient, Layer.mock(LLMClient.Service, { stream: (request) => {
      requests.push(request)
      return Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "reply" }),
        LLMEvent.textDelta({ id: "reply", text: "Verified response" }), LLMEvent.textEnd({ id: "reply" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }),
      ])
    } })],
  ])
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    yield* agents.transform((draft) => {
      for (const agent of draft.list()) draft.update(agent.id, (item) => { item.steps = 2 })
    })
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => { provider.package = "@ycoding-ai/ai/providers/openai" })
      draft.model.update(providerID, baselineID, (model) => { model.limit = { context: 128_000, output: 4_000 } })
      draft.model.default.set(providerID, baselineID)
    })
    yield* registerToolPlugin(DecisionTool.Plugin)
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const store = yield* SessionStore.Service
    const runner = yield* SessionRunner.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: directory, sandboxes: [] }).onConflictDoNothing().run()
    const sessionID = SessionSchema.ID.create()
    const parentID = input.child ? SessionSchema.ID.create() : undefined
    if (parentID) yield* events.publish(SessionEvent.Created, { sessionID: parentID, projectID: Project.ID.global, location: { directory }, title: "parent", created: Date.now() })
    yield* events.publish(SessionEvent.Created, {
      sessionID, projectID: Project.ID.global, location: { directory }, title: "explicit decisions", created: Date.now(), agent: input.agent, parentID,
      permissionCeiling: input.denied ? [{ action: "decision", resource: "*", effect: "deny" }] : undefined,
    })
    const pending = yield* SessionPending.admit(db, events, { id: SessionMessage.ID.create(), sessionID,
      input: { type: "user", delivery: "steer", data: { text: "Review a bounded task" } },
    })
    const exit = yield* runner.drain({ sessionID, force: false }).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(yield* SessionPending.find(db, pending.id)).toBeUndefined()
    return { session: yield* store.get(sessionID), history: yield* store.context(sessionID), requests, judgments }
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
}

test("uses normal defaults without invoking a decision helper or publishing task advice", async () => {
  const result = await run({})
  expect(result.session?.agent).toBeUndefined()
  expect(result.history.find((message) => message.type === "assistant")).toMatchObject({ agent: Agent.defaultID, model: { providerID, id: baselineID } })
  expect(String(result.requests[0]?.model.id)).toBe(baselineID)
  expect(result.judgments).toEqual([])
  expect(result.history.filter((message) => message.type === "synthetic")).toEqual([])
})

for (const agent of ["god", "zeus", "btw"]) {
  test(`real ${agent} Session requests expose decision and shared guidance without calling a helper`, async () => {
    const result = await run({ agent: Agent.ID.make(agent), child: agent !== "god" })
    expect(result.requests).toHaveLength(1)
    expect(result.requests[0].tools.map((tool) => tool.name)).toContain("decision")
    const instructions = JSON.stringify([result.requests[0].system, result.requests[0].messages])
    expect(instructions).toContain("bounded typed judgments from the hidden helper")
    expect(instructions).toContain("grade: true")
    expect(result.judgments).toEqual([])
  })
}

test("an inherited decision deny removes the tool from a child request", async () => {
  const result = await run({ agent: Agent.ID.make("zeus"), child: true, denied: true })
  expect(result.requests[0].tools.map((tool) => tool.name)).not.toContain("decision")
  expect(result.judgments).toEqual([])
})
