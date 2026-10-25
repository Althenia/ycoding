import { describe, expect } from "bun:test"
import { tmpdir } from "node:os"
import { Message, Model, type LLMRequest } from "@ycoding-ai/ai"
import { route } from "@ycoding-ai/ai/protocols/openai-chat"
import { Effect, Layer, Schema, Stream } from "effect"
import { Agent } from "../src/agent"
import { AttachmentStore } from "../src/attachment-store"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { Credential } from "../src/credential"
import { DotsRuntime } from "../src/dots"
import { DotsRuntimeNode } from "../src/dots/node"
import type { DotsTransport } from "../src/dots/transport"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { InstructionDiscovery } from "../src/instruction-discovery"
import { Instructions } from "../src/instructions/index"
import { Integration } from "../src/integration"
import { Location } from "../src/location"
import { McpInstructions } from "../src/mcp/instructions"
import { Permission } from "../src/permission"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { ReferenceInstructions } from "../src/reference/instructions"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionContext } from "../src/session/context"
import { SessionExecution } from "../src/session/execution"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionLiveState } from "../src/session/live-state"
import { SessionMessage } from "../src/session/message"
import { SessionModelRequest } from "../src/session/model-request"
import { SessionRunnerModel } from "../src/session/runner/model"
import type { SessionSchema } from "../src/session/schema"
import { SkillInstructions } from "../src/skill/instructions"
import { ToolRegistry } from "../src/tool/registry"
import { Tool } from "../src/tool/tool"
import { Tools } from "../src/tool/tools"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make(tmpdir())
const destination = { dotID: "dot_request", threadID: "thread_request", generation: "1", label: "Request Dot" }
const target = { ...destination, profile: "request-fixture" }
const pausedDestination = { ...destination, threadID: "thread_paused_request" }
const unpausedDestination = { ...destination, threadID: "thread_unpaused_request" }
const transport: DotsTransport.Interface = {
  destinations: () => Effect.succeed([destination, pausedDestination, unpausedDestination]),
  runtimeState: (_credentials, target) => Effect.succeed(target.threadID === pausedDestination.threadID ? "paused" : target.threadID === unpausedDestination.threadID ? "unpaused" : "unknown"),
  control: () => Effect.die("No runtime mutations are allowed"),
  connect: () =>
    Effect.succeed({
      subscribe: () => Effect.succeed([]),
      send: () => Effect.die("No sends are allowed"),
      inbound: Stream.never,
    }),
}
const configuration = Layer.succeed(
  Config.Service,
  Config.Service.of({
    diagnostics: () => Effect.succeed([]),
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({ dots: { enabled: true } }),
        }),
      ]),
    reload: () => Effect.void,
  }),
)
const catalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    defaultSelection: () => Effect.succeed(undefined),
    forConnection: (model) => Effect.succeed(model),
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.succeed(undefined),
    small: () => Effect.succeed(undefined),
  },
})
const requestNodes = [
  SessionModelRequest.node,
  SessionLiveState.node,
  DotsRuntimeNode.node,
  DotsRuntimeNode.requestToolsNode,
  ToolRegistry.node,
  ToolRegistry.toolsNode,
  Session.node,
  Integration.node,
  Credential.node,
]
const overrides = [
  [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
  [
    AttachmentStore.node,
    Layer.mock(AttachmentStore.Service, {
      absolutePath: () => {
        throw new Error("No attachment path is expected")
      },
    }),
  ],
  [DotsRuntimeNode.node, DotsRuntimeNode.withTransport(transport)],
  [Permission.node, Layer.mock(Permission.Service, { assert: () => Effect.void })],
  [
    SessionGuardrail.node,
    Layer.mock(SessionGuardrail.Service, {
      reviewPolicy: { enabled: true, decideReviews: false, decideHardReviews: true },
      assert: () => Effect.succeed({ release: Effect.void }),
      snapshot: () => Effect.succeed({ sequence: 0, digest: "fixture" }),
    }),
  ],
  [SessionExecution.node, SessionExecution.noopLayer],
  [Config.node, configuration],
  [Catalog.node, catalog],
] as const
const it = testEffect(AppNodeBuilder.build(LayerNode.group(requestNodes), overrides))
const emptyInstructions = () => Effect.succeed(Instructions.empty)
const contextIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([...requestNodes, Agent.node, SessionContext.node]), [
    ...overrides,
    [InstructionDiscovery.node, Layer.mock(InstructionDiscovery.Service, { load: emptyInstructions })],
    [SkillInstructions.node, Layer.mock(SkillInstructions.Service, { load: emptyInstructions })],
    [ReferenceInstructions.node, Layer.mock(ReferenceInstructions.Service, { load: emptyInstructions })],
    [McpInstructions.node, Layer.mock(McpInstructions.Service, { load: emptyInstructions })],
    [
      PluginSupervisor.node,
      Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void })),
    ],
    [SessionRunnerModel.node, Layer.mock(SessionRunnerModel.Service, {})],
  ]),
)

const model = SessionRunnerModel.resolved(
  Model.make({
    id: "fake-model",
    provider: "fake",
    route: route.with({ limits: { context: 262_144, output: 8_192 } }),
  }),
)
const agent = Agent.Info.empty(Agent.ID.make("fixture"))

const connectProfile = Effect.gen(function* () {
  const integration = yield* Integration.Service
  const credential = yield* Credential.Service
  const integrationID = Integration.ID.make("openai")
  const methodID = Integration.MethodID.make("chatgpt-browser")
  yield* integration.transform((draft) =>
    draft.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Synthetic ChatGPT" },
      authorize: () => Effect.die("No authentication may be started"),
    }),
  )
  yield* credential.create({
    integrationID,
    label: target.profile,
    value: Credential.OAuth.make({
      type: "oauth",
      methodID,
      access: "synthetic-request-access",
      refresh: "synthetic-request-refresh",
      expires: Date.now() + 3600000,
      metadata: { accountID: "synthetic-request-account" },
    }),
  })
})

const newSession = (title: string) =>
  Effect.gen(function* () {
    return yield* (yield* Session.Service).create({ location: { directory }, title })
  })

const prepare = (
  session: SessionSchema.Info,
  selected: SessionContext.Selection["agent"] = { id: agent.id, info: agent },
) =>
  Effect.gen(function* () {
    const requests = yield* SessionModelRequest.Service
    const live = yield* SessionLiveState.Service
    return yield* requests.prepare({
      step: 1,
      messages: [Message.user("Synthetic request")],
      context: {
        session,
        model,
        agent: selected,
        initial: "Synthetic Dots request instructions",
        contextRevision: 0,
        messages: [],
        liveState: yield* live.load(session.id),
      },
    })
  })

const names = (tools: LLMRequest["tools"]) => tools.map((tool) => tool.name).toSorted()

const executeSearch = (
  prepared: Effect.Success<ReturnType<typeof prepare>>,
  session: SessionSchema.Info,
  query = "dots",
) =>
  Effect.gen(function* () {
    const resolution = prepared.resolveToolCall("execute")
    if (resolution.type !== "settle") return yield* Effect.die(new Error("execute was not executable"))
    const settled = yield* resolution.settle({
      sessionID: session.id,
      agent: agent.id,
      messageID: SessionMessage.ID.make("msg_dots_request_search"),
      call: {
        type: "tool-call",
        id: `call_dots_search_${query}`,
        name: "execute",
        input: { code: `return search({ query: ${JSON.stringify(query)} })` },
      },
    })
    return JSON.stringify(settled.result)
  })

describe("Dots tools through model request preparation", () => {
  it.live("exposes only the control matching a freshly read runtime state and rejects stale captured tools", () =>
    Effect.gen(function* () {
      yield* connectProfile
      const active = yield* newSession("Paused Dot request")
      const unbound = yield* newSession("No Dot request")
      const dots = yield* DotsRuntime.Service
      yield* dots.bind({ sessionID: active.id, target: { ...pausedDestination, profile: target.profile } })
      expect((yield* dots.status(active.id)).runtimeState).toBe("paused")
      const captured = yield* prepare(active)
      const search = yield* executeSearch(captured, active)
      expect(search).toContain("tools.dots_resume(input:")
      expect(search).not.toContain("tools.dots_pause(input:")
      expect(yield* executeSearch(yield* prepare(unbound), unbound)).not.toContain("tools.dots_resume(input:")
      yield* dots.bind({ sessionID: active.id, target })
      const resolution = captured.resolveToolCall("execute")
      if (resolution.type !== "settle") throw new Error("The captured execute tool is missing")
      const stale = yield* resolution.settle({
        sessionID: active.id, agent: agent.id, messageID: SessionMessage.ID.make("msg_captured_control"),
        call: { type: "tool-call", id: "call_captured_control", name: "execute", input: { code: 'return await tools.dots_resume({})' } },
      })
      expect(JSON.stringify(stale.result)).toContain("confirmed Dot changed")
      yield* dots.bind({ sessionID: active.id, target: { ...unpausedDestination, profile: target.profile } })
      const unpaused = yield* executeSearch(yield* prepare(active), active)
      expect(unpaused).toContain("tools.dots_pause(input:")
      expect(unpaused).not.toContain("tools.dots_resume(input:")
    }),
  )

  it.live(
    "prepares the base surface for unbound Sessions and adds Dots only to the bound Session in either order",
    () =>
      Effect.gen(function* () {
        yield* connectProfile
        const bound = yield* newSession("Bound request")
        const unbound = yield* newSession("Unbound request")
        const base = (yield* prepare(unbound)).request.tools
        expect(names(base)).not.toContain("execute")
        expect(names(base)).not.toContain("dots_send")
        expect(names(base).some(name => name === "dots_pause" || name === "dots_resume")).toBe(false)
        const registry = yield* ToolRegistry.Service
        expect(names(base)).toEqual(names((yield* registry.materialize()).definitions))

        expect((yield* (yield* DotsRuntime.Service).bind({ sessionID: bound.id, target })).target).toEqual(target)

        const boundFirst = yield* prepare(bound)
        const unboundSecond = yield* prepare(unbound)
        const unboundFirst = yield* prepare(unbound)
        const boundSecond = yield* prepare(bound)

        expect(unboundSecond.request.tools).toEqual(base)
        expect(unboundFirst.request.tools).toEqual(base)
        expect(boundSecond.request.tools).toEqual(boundFirst.request.tools)
        expect(names(boundFirst.request.tools)).toEqual([...names(base), "execute"].toSorted())
        expect(names(boundFirst.request.tools)).not.toContain("dots_send")
        expect(names(boundFirst.request.tools).some(name => name === "dots_pause" || name === "dots_resume")).toBe(false)
        const reachable = yield* executeSearch(boundFirst, bound)
        expect(reachable).toContain("tools.dots_send(input:")
        expect(reachable).not.toContain("tools.dots_pause(input:")
        expect(reachable).not.toContain("tools.dots_resume(input:")
      }),
  )

  it.live("keeps a non-Dots CodeMode tool behind execute for unbound and bound Session requests", () =>
    Effect.gen(function* () {
      yield* connectProfile
      yield* (yield* Tools.Service).register({
        fixture_codemode: Tool.make({
          description: "Fixture CodeMode tool",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed("fixture"),
        }),
      })
      const bound = yield* newSession("Bound CodeMode request")
      const unbound = yield* newSession("Unbound CodeMode request")
      const base = (yield* prepare(unbound)).request.tools
      expect(names(base)).toContain("execute")

      yield* (yield* DotsRuntime.Service).bind({ sessionID: bound.id, target })

      const boundRequest = yield* prepare(bound)
      const unboundRequest = yield* prepare(unbound)
      expect(unboundRequest.request.tools).toEqual(base)
      expect(names(boundRequest.request.tools)).toEqual(names(base))
      expect(yield* executeSearch(boundRequest, bound, "fixture")).toContain("tools.fixture_codemode(input:")
      const boundCatalog = yield* executeSearch(boundRequest, bound)
      expect(boundCatalog).toContain("tools.dots_send(input:")
      expect(boundCatalog).not.toContain("tools.dots_pause(input:")
      expect(boundCatalog).not.toContain("tools.dots_resume(input:")
      expect(yield* executeSearch(unboundRequest, unbound, "fixture")).toContain("tools.fixture_codemode(input:")
      const unboundCatalog = yield* executeSearch(unboundRequest, unbound)
      expect(unboundCatalog).not.toContain("tools.dots_send(input:")
      expect(unboundCatalog).not.toContain("tools.dots_pause(input:")
      expect(unboundCatalog).not.toContain("tools.dots_resume(input:")
    }),
  )
})

describe("Dots tools and Session instructions", () => {
  const toolBlocks = {
    "core/decision-use": "decision",
    "core/task-completion": "task_complete",
    "core/human-input": "question",
    "core/subagent-reuse": "subagent",
    "core/shell-memory": "shell",
  }
  const instructionValues = (sessionID: SessionSchema.ID) =>
    Effect.gen(function* () {
      const contexts = yield* SessionContext.Service
      const selection = yield* contexts.select(sessionID)
      return { selection, values: yield* Instructions.read(selection.instructions) }
    })

  contextIt.live("a binding leaves Session instructions unchanged and in agreement with the request tools", () =>
    Effect.gen(function* () {
      yield* connectProfile
      yield* (yield* Agent.Service).transform((draft) =>
        draft.update(agent.id, (info) => {
          info.mode = "primary"
        }),
      )
      yield* (yield* ToolRegistry.Service).register(
        {
          decision: Tool.make({
            description: "Fixture decision tool",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.succeed("decision"),
          }),
          task_complete: Tool.make({
            description: "Fixture completion tool",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.succeed("complete"),
          }),
        },
        { codemode: false },
      )
      const bound = yield* newSession("Bound instructions")
      const unbound = yield* newSession("Unbound instructions")
      const before = yield* instructionValues(bound.id)

      yield* (yield* DotsRuntime.Service).bind({ sessionID: bound.id, target })

      const boundContext = yield* instructionValues(bound.id)
      const unboundContext = yield* instructionValues(unbound.id)
      expect(boundContext.values).toEqual(before.values)
      expect(unboundContext.values).toEqual(before.values)
      const keys = new Set(
        boundContext.values.flatMap((entry) =>
          entry.value === Instructions.removed || entry.value === Instructions.unavailable ? [] : [entry.key],
        ),
      )
      expect(keys.has(Instructions.Key.make("core/decision-use"))).toBe(true)

      const boundTools = new Set(names((yield* prepare(bound, boundContext.selection.agent)).request.tools))
      const unboundTools = new Set(names((yield* prepare(unbound, unboundContext.selection.agent)).request.tools))
      expect(boundTools.has("execute")).toBe(true)
      expect(unboundTools.has("execute")).toBe(false)
      for (const [block, tool] of Object.entries(toolBlocks)) {
        expect([block, keys.has(Instructions.Key.make(block))]).toEqual([block, boundTools.has(tool)])
        expect([block, keys.has(Instructions.Key.make(block))]).toEqual([block, unboundTools.has(tool)])
      }
    }),
  )
})
