import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, type LLMRequest } from "@ycoding-ai/ai"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { Config } from "../src/config"
import { ConfigDecisions } from "../src/config/decisions"
import { Database } from "../src/database/database"
import { Decision } from "../src/decision"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { InstructionDiscovery } from "../src/instruction-discovery"
import { Instructions } from "../src/instructions"
import { InstructionBuiltIns } from "../src/instructions/builtins"
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
import { ToolRegistry } from "../src/tool/registry"
import { Tool } from "../src/tool/tool"
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { Permission } from "../src/permission"

const directory = AbsolutePath.make("/decision-routing-test")
const providerID = Provider.ID.make("routing-test")
const baselineID = CatalogModel.ID.make("baseline")
const selectedID = CatalogModel.ID.make("selected")
const selectedAgent = Agent.ID.make("architect")

const routing = Schema.decodeUnknownSync(ConfigDecisions.Info)({
  routing: {
    provider: "openai", min_probability: 0.8,
    candidates: [{ id: "design", description: "Design systems", agent: selectedAgent,
      model: { providerID, model: selectedID } }],
  },
})
const agentRouting = Schema.decodeUnknownSync(ConfigDecisions.Info)({
  routing: {
    provider: "agent",
    min_confidence: 0.8,
    candidates: [
      { id: "design", description: "Design systems", agent: selectedAgent, model: { providerID, model: selectedID } },
    ],
  },
})

function run(input: {
  settings?: ConfigDecisions.Info
  choose?: (input: Decision.ChoiceInput) => Effect.Effect<Decision.Choice, Decision.Error, EventRuntime.Service | Catalog.Service | Agent.Service | Scope.Scope>
  evaluate?: (input: Decision.Input) => Effect.Effect<Decision.Output, Decision.Error>
  agent?: Agent.ID
  model?: CatalogModel.Ref
  parentID?: SessionSchema.ID
  permissionCeiling?: Permission.Ruleset
  fails?: boolean
  failsAfterPromotion?: boolean
  delivery?: SessionPending.Delivery
  text?: string
  before?: (sessionID: SessionSchema.ID) => Effect.Effect<void, never, Agent.Service | Catalog.Service | Credential.Service | Integration.Service | Database.Service | EventRuntime.Service | ToolRegistry.Service | Scope.Scope>
  after?: (services: { runner: SessionRunner.Interface; store: SessionStore.Interface;
    db: Database.Interface["db"]; sessionID: SessionSchema.ID; requests: LLMRequest[];
    choices: Decision.ChoiceInput[]; events: EventRuntime.Interface }) => Effect.Effect<void, SessionRunner.RunError>
}) {
  const requests: LLMRequest[] = []
  const choices: Decision.ChoiceInput[] = []
  const evaluations: Decision.Input[] = []
  const layer = AppNodeBuilder.build(LayerNode.group([
    Database.node, EventRuntime.node, SessionStore.node, Agent.node, Catalog.node,
    SessionProjector.node, SessionRunnerLLM.node, ToolRegistry.node, Credential.node, Integration.node,
  ]), [
    [Location.node, Location.boundNode({ directory })],
    [Snapshot.node, Snapshot.noopLayer],
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ diagnostics: () => Effect.succeed([]), reload: () => Effect.void,
      entries: () => Effect.succeed([]) }))],
    [PluginSupervisor.node, Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void }))],
    [InstructionBuiltIns.node, Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [InstructionDiscovery.node, Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [SkillInstructions.node, Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [ReferenceInstructions.node, Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [McpInstructions.node, Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Decision.node, Layer.effect(Decision.Service, Effect.gen(function* () {
      const events = yield* EventRuntime.Service
      const catalog = yield* Catalog.Service
      const agents = yield* Agent.Service
      const scope = yield* Scope.Scope
      return Decision.Service.of({
        settings: () => Effect.succeed(input.settings),
        evaluate: (value) => Effect.sync(() => evaluations.push(value)).pipe(Effect.andThen(input.evaluate?.(value) ?? Effect.die("unused direct decision transport"))),
        choose: (value) => Effect.sync(() => choices.push(value)).pipe(Effect.andThen(
          (input.choose?.(value) ?? Effect.succeed({ choice: "design", probability: 0.95, refused: false }))
            .pipe(Effect.provideService(EventRuntime.Service, events),
              Effect.provideService(Catalog.Service, catalog), Effect.provideService(Agent.Service, agents),
              Effect.provideService(Scope.Scope, scope)))),
      })
    }))],
    [LayerNodePlatform.llmClient, Layer.succeed(LLMClient.Service, LLMClient.Service.of({
      prepare: () => Effect.die("unused preparation"),
      generate: () => Effect.die("unused generation"),
      stream: (request) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "reply" }),
          LLMEvent.textDelta({ id: "reply", text: "Selected response" }),
          LLMEvent.textEnd({ id: "reply" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ])
      },
    }))],
  ])
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((draft) => {
      draft.update(Agent.defaultID, (agent) => { agent.mode = "primary"; agent.steps = 1 })
      draft.update(selectedAgent, (agent) => { agent.mode = "primary"; agent.steps = 1 })
    })
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => {
      draft.provider.update(providerID, (provider) => { provider.package = "@ycoding-ai/ai/providers/openai" })
      for (const id of [baselineID, selectedID]) draft.model.update(providerID, id, (model) => {
        model.limit = { context: 128_000, output: 4_000 }
      })
      draft.model.default.set(providerID, baselineID)
    })
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const store = yield* SessionStore.Service
    const runner = yield* SessionRunner.Service
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: directory, sandboxes: [] }).onConflictDoNothing().run()
    const sessionID = SessionSchema.ID.create()
    if (input.parentID) yield* events.publish(SessionEvent.Created, {
      sessionID: input.parentID, projectID: Project.ID.global, location: { directory }, title: "parent", created: Date.now(),
    })
    yield* events.publish(SessionEvent.Created, {
      sessionID, projectID: Project.ID.global, location: { directory }, title: "routing", created: Date.now(),
      agent: input.agent, model: input.model, parentID: input.parentID, permissionCeiling: input.permissionCeiling,
    })
    const pending = yield* SessionPending.admit(db, events, {
      id: SessionMessage.ID.create(), sessionID,
      input: { type: "user", delivery: input.delivery ?? "steer", data: { text: input.text ?? "Design a distributed scheduler" } },
    })
    if (input.before) yield* input.before(sessionID)
    const exit = yield* runner.drain({ sessionID, force: false }).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(input.fails ?? false)
    if (input.fails) {
      if (input.failsAfterPromotion) expect(yield* SessionPending.find(db, pending.id)).toBeUndefined()
      if (!input.failsAfterPromotion) expect(yield* SessionPending.find(db, pending.id)).toMatchObject({ id: pending.id, type: "user" })
      expect(requests).toHaveLength(0)
    }
    if (!input.fails) expect(yield* SessionPending.find(db, pending.id)).toBeUndefined()
    const history = yield* store.context(sessionID)
    if (!input.fails) expect(history.find((message) => message.id === pending.id)).toMatchObject({ type: "user", text: input.text ?? "Design a distributed scheduler" })
    if (input.after) yield* input.after({ runner, store, db, sessionID, requests, choices, events })
    return { session: yield* store.get(sessionID), history: yield* store.context(sessionID), requests, choices, evaluations }
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
}

test("routes the real first pending input and runner request to the validated agent/model pair", async () => {
  const result = await run({ settings: routing, choose: () => Effect.succeed({ choice: "design", probability: 0.8, refused: false }) })
  expect(result.session).toMatchObject({ agent: selectedAgent, model: { providerID, id: selectedID } })
  expect(result.history.find((message) => message.type === "assistant")).toMatchObject({ agent: selectedAgent, model: { providerID, id: selectedID } })
  expect(String(result.requests[0]?.model.id)).toBe(selectedID)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0]?.state).toMatchObject({ text: "Design a distributed scheduler" })
  expect(result.choices[0]?.choices).toEqual({ "keep-current": "Keep the current default agent and model", design: "Design systems" })
  expect(result.history.slice(0, 3).map((message) => message.type)).toEqual(["agent-switched", "model-switched", "user"])
})

test("routes the real first pending input at the agent estimated-confidence threshold", async () => {
  const result = await run({
    settings: agentRouting,
    choose: () => Effect.succeed({ choice: "design", confidence: 0.8, refused: false }),
  })
  expect(result.session).toMatchObject({ agent: selectedAgent, model: { providerID, id: selectedID } })
  expect(result.history.find((message) => message.type === "assistant")).toMatchObject({
    agent: selectedAgent,
    model: { providerID, id: selectedID },
  })
  expect(String(result.requests[0]?.model.id)).toBe(selectedID)
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0]?.provider).toBe("agent")
  expect(result.history.slice(0, 3).map((message) => message.type)).toEqual([
    "agent-switched",
    "model-switched",
    "user",
  ])
})

test("keeps real runner defaults for uncertain or refused agent estimates and wrong metrics", async () => {
  for (const answer of [
    { confidence: 0.79 },
    { probability: 1 },
    { confidence: Infinity },
    { confidence: 1.01 },
    { confidence: -0.1 },
    { confidence: 1, refused: true },
  ]) {
    const result = await run({
      settings: agentRouting,
      choose: () => Effect.succeed({ choice: "design", refused: false, ...answer }),
    })
    expect(result.choices).toHaveLength(1)
    expect(result.session?.agent).toBeUndefined()
    expect(result.session?.model).toBeUndefined()
    expect(String(result.requests[0]?.model.id)).toBe(baselineID)
    expect(
      result.history.some((message) => message.type === "agent-switched" || message.type === "model-switched"),
    ).toBe(false)
  }
})

test("uses configured agent-only and model-only candidates without persisting omitted defaults", async () => {
  for (const candidate of [
    { id: "design", description: "Agent only", agent: selectedAgent },
    { id: "design", description: "Model only", model: { providerID, model: selectedID } },
  ]) {
    const result = await run({ settings: Schema.decodeUnknownSync(ConfigDecisions.Info)({ routing: {
      provider: "openai", min_probability: 0.8, candidates: [candidate],
    } }) })
    expect(result.choices).toHaveLength(1)
    expect(result.session?.agent).toBe(candidate.agent)
    expect(result.session?.model?.id).toBe(candidate.model?.model)
    expect(result.history.find((message) => message.type === "assistant")).toMatchObject({
      agent: candidate.agent ?? Agent.defaultID,
      model: { providerID, id: candidate.model?.model ?? baselineID },
    })
  }
})

test("routes the first queued user input at its idle promotion boundary", async () => {
  const result = await run({ settings: routing, delivery: "queue" })
  expect(result.choices).toHaveLength(1)
  expect(result.session).toMatchObject({ agent: selectedAgent, model: { providerID, id: selectedID } })
  expect(String(result.requests[0]?.model.id)).toBe(selectedID)
})

test("does not infer for explicit selections, child Sessions, or absent routing policy", async () => {
  for (const input of [
    { settings: routing, agent: selectedAgent },
    { settings: routing, model: CatalogModel.Ref.make({ providerID, id: selectedID }) },
    { settings: routing, parentID: SessionSchema.ID.create() },
    {},
  ]) {
    const result = await run(input)
    expect(result.choices).toHaveLength(0)
    expect(result.session?.agent).toBe(input.agent)
    expect(result.session?.model).toEqual(input.model)
  }
})

test("keeps defaults on refusal, low or missing confidence, unknown choice and baseline", async () => {
  for (const answer of [
    { refused: true },
    { choice: "design", probability: 0.7, refused: false },
    { choice: "design", refused: false },
    { choice: "arbitrary-provider/model", probability: 1, refused: false },
    { choice: "keep-current", probability: 1, refused: false },
  ]) {
    const result = await run({ settings: routing, choose: () => Effect.succeed(answer),
      after: ({ runner, sessionID, choices, db, events }) => Effect.gen(function* () {
        yield* SessionPending.admit(db, events, { id: SessionMessage.ID.create(), sessionID,
          input: { type: "user", delivery: "steer", data: { text: "Next real user input" } } })
        yield* runner.drain({ sessionID, force: false })
        expect(choices).toHaveLength(1)
      }),
    })
    expect(result.session?.agent).toBeUndefined()
    expect(result.session?.model).toBeUndefined()
    expect(result.requests.map((request) => String(request.model.id))).toEqual([baselineID, baselineID])
  }
})

test("excludes unknown, hidden, subagent, unavailable-model and denied-agent candidates before inference", async () => {
  for (const candidate of [
    { id: "design", description: "Unknown", agent: "missing" },
    { id: "design", description: "Hidden", agent: selectedAgent },
    { id: "design", description: "Subagent", agent: selectedAgent },
    { id: "design", description: "Unavailable", model: { providerID, model: "missing" } },
    { id: "design", description: "Unavailable variant", model: { providerID, model: selectedID, variant: "missing" } },
    { id: "design", description: "Denied", agent: selectedAgent },
    { id: "design", description: "Needs approval", agent: selectedAgent },
  ]) {
    const result = await run({ settings: Schema.decodeUnknownSync(ConfigDecisions.Info)({ routing: {
      provider: "openai", min_probability: 0.8, candidates: [candidate],
    } }), permissionCeiling: candidate.description === "Denied"
      ? [{ action: "agent", resource: selectedAgent, effect: "deny" }] : undefined,
      before: () => Effect.gen(function* () {
        const agents = yield* Agent.Service
        if (candidate.description === "Needs approval") yield* agents.transform((draft) =>
          draft.update(Agent.defaultID, (agent) => { agent.permissions = [{ action: "agent", resource: selectedAgent, effect: "ask" }] }))
        if (candidate.description === "Hidden" || candidate.description === "Subagent")
          yield* agents.transform((draft) => draft.update(selectedAgent, (agent) => {
            if (candidate.description === "Hidden") agent.hidden = true
            if (candidate.description === "Subagent") agent.mode = "subagent"
          }))
      }),
    })
    expect(result.choices).toHaveLength(0)
    expect(result.session?.agent).toBeUndefined()
    expect(result.session?.model).toBeUndefined()
  }
})

test("does not route established history even when it has no explicit agent/model", async () => {
  const result = await run({ settings: routing, before: (sessionID) => Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    yield* SessionPending.promoteSteers(db, events, sessionID)
    yield* SessionPending.admit(db, events, { id: SessionMessage.ID.create(), sessionID,
      input: { type: "user", delivery: "steer", data: { text: "Continue established history" } } })
  }) })
  expect(result.choices).toHaveLength(0)
  expect(String(result.requests[0]?.model.id)).toBe(baselineID)
})

test("preserves a concurrent explicit agent selection instead of overwriting it with either route field", async () => {
  const result = await run({ settings: routing, choose: (input) => Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.AgentSelected, { sessionID: input.context.sessionID, agent: Agent.defaultID })
    return { choice: "design", probability: 0.95, refused: false }
  }) })
  expect(result.session?.agent).toBe(Agent.defaultID)
  expect(result.session?.model).toBeUndefined()
  expect(String(result.requests[0]?.model.id)).toBe(baselineID)
})

test("preserves pending intent and fails without a main model request on decision provider failure", async () => {
  const result = await run({ settings: routing, fails: true,
    choose: () => Effect.fail(new Decision.Error({ reason: "provider-failed" })),
  })
  expect(result.session?.agent).toBeUndefined()
  expect(result.session?.model).toBeUndefined()
  expect(result.choices).toHaveLength(1)
})

test("preserves a concurrent explicit model selection without publishing the chosen agent", async () => {
  const result = await run({ settings: routing, choose: (input) => Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.ModelSelected, { sessionID: input.context.sessionID,
      model: CatalogModel.Ref.make({ providerID, id: baselineID }) })
    return { choice: "design", probability: 0.95, refused: false }
  }) })
  expect(result.session?.agent).toBeUndefined()
  expect(result.session?.model).toEqual(CatalogModel.Ref.make({ providerID, id: baselineID }))
  expect(String(result.requests[0]?.model.id)).toBe(baselineID)
})

test("validates the selected model before either selection event and preserves pending input when it disappears", async () => {
  const result = await run({ settings: routing, fails: true, choose: () => Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => draft.model.remove(providerID, selectedID))
    return { choice: "design", probability: 0.95, refused: false }
  }) })
  expect(result.session?.agent).toBeUndefined()
  expect(result.session?.model).toBeUndefined()
  expect(result.history).toHaveLength(0)
})

test("revalidates selectable agents after inference before committing the pair", async () => {
  const result = await run({ settings: routing, choose: () => Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((draft) => draft.update(selectedAgent, (agent) => { agent.hidden = true }))
    return { choice: "design", probability: 0.95, refused: false }
  }) })
  expect(result.session?.agent).toBeUndefined()
  expect(result.session?.model).toBeUndefined()
  expect(String(result.requests[0]?.model.id)).toBe(baselineID)
})

const advisoryPolicy = {
  provider: "agent", min_confidence: 0.8,
  candidates: [{ id: "careful", description: "Difficult tasks", model: { providerID, model: selectedID, variant: "high" } }],
  directions: [{ id: "inspect", description: "Inspect evidence before editing" }],
}
const advisory = Schema.decodeUnknownSync(ConfigDecisions.Info)({ advisory: advisoryPolicy })
const advice = (confidence = 0.9): Decision.Output => ({ provider: "agent", response: {
  model: CatalogModel.Ref.make({ providerID, id: baselineID }), semantics: "model-estimate", version: 1,
  answers: [
    { name: "model", type: "choice", choice: "careful", answer: null, score: null, confidence },
    { name: "direction", type: "choice", choice: "inspect", answer: null, score: null, confidence },
    { name: "tool", type: "choice", choice: "tool:read", answer: null, score: null, confidence },
  ],
} })
const advisorySetup = () => Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((draft) => draft.update(Agent.defaultID, (agent) => {
    agent.steps = 3
    agent.permissions.push({ action: "shell", resource: "*", effect: "deny" })
  }))
  const catalog = yield* Catalog.Service
  yield* catalog.transform((draft) => draft.model.update(providerID, selectedID, (model) => {
    model.variants = [{ id: CatalogModel.VariantID.make("high"), body: { secretOverlay: "must-not-disclose" } }]
    model.settings = { apiKey: "must-not-disclose" }
    model.capabilities = { tools: true, input: ["text"], output: ["text"] }
  }))
  const registry = yield* ToolRegistry.Service
  yield* registry.register(Object.fromEntries(["read", "shell"].map((name) => [name, Tool.make({
    description: `Use ${name}`, input: Schema.Struct({}), output: Schema.Struct({}),
    execute: () => Effect.die("Advice must never execute a tool"),
  })])), { codemode: false }).pipe(Effect.orDie)
})

test("batches model variant, direction and available tool advice into the real runner without selecting or executing", async () => {
  const result = await run({ settings: advisory, before: advisorySetup, evaluate: () => Effect.succeed(advice()),
    model: CatalogModel.Ref.make({ providerID, id: baselineID }), after: ({ runner, sessionID }) => runner.drain({ sessionID, force: true }),
  })
  expect(result.evaluations).toHaveLength(1)
  expect(result.evaluations[0]).toMatchObject({ provider: "agent", request: { questions: [
    { name: "model" }, { name: "direction" }, { name: "tool", choices: [{ value: "keep-current" }, { value: "tool:read" }] },
  ] } })
  expect(JSON.stringify(result.evaluations[0])).toContain('"high"')
  expect(JSON.stringify(result.evaluations[0])).not.toContain("must-not-disclose")
  expect(JSON.stringify(result.evaluations[0])).not.toContain("tool:shell")
  expect(result.session?.model?.id).toBe(baselineID)
  expect(result.history.filter((message) => message.type === "synthetic" && message.description === "Decision advisory")).toHaveLength(1)
  expect(JSON.stringify(result.requests[0]?.messages)).toContain("Decision advisory")
  expect(JSON.stringify(result.requests[0]?.messages)).toContain("high")
  expect(result.requests[0]?.system).toEqual(result.requests[1]?.system)
  expect(result.history.some((message) => message.type === "model-switched" || message.type === "agent-switched")).toBe(false)
})

test("unconfigured or denied advisory performs no helper inference", async () => {
  for (const settings of [undefined, advisory]) {
    const result = await run({ settings, permissionCeiling: [{ action: "decision", resource: "agent", effect: "deny" }] })
    expect(result.evaluations).toEqual([])
    expect(result.history.some((message) => message.type === "synthetic" && message.description === "Decision advisory")).toBe(false)
  }
})

test("uncertain advice and helper errors preserve the actual user input and main execution", async () => {
  for (const evaluate of [() => Effect.succeed(advice(0.79)), () => Effect.fail(new Decision.Error({ reason: "unavailable" }))]) {
    const result = await run({ settings: advisory, before: advisorySetup, evaluate })
    expect(result.evaluations).toHaveLength(1)
    expect(result.requests).toHaveLength(1)
    expect(result.history.some((message) => message.type === "user" && message.text === "Design a distributed scheduler")).toBe(true)
    expect(JSON.stringify(result.requests[0]?.messages)).not.toContain("Recommended model")
  }
})

test("each subsequently promoted queued user input gets one batch and synthetic inputs get none", async () => {
  const result = await run({ settings: advisory, before: advisorySetup, evaluate: () => Effect.succeed(advice()),
    after: ({ runner, sessionID, db, events }) => Effect.gen(function* () {
      yield* SessionPending.admit(db, events, { id: SessionMessage.ID.create(), sessionID,
        input: { type: "synthetic", delivery: "steer", data: { text: "Runtime observation", description: "Observation" } },
      })
      yield* SessionPending.admit(db, events, { id: SessionMessage.ID.create(), sessionID,
        input: { type: "user", delivery: "queue", data: { text: "Now verify the design" } },
      })
      yield* runner.drain({ sessionID, force: false })
    }),
  })
  expect(result.evaluations).toHaveLength(2)
  expect(JSON.stringify(result.evaluations[1])).toContain("Now verify the design")
  expect(result.history.filter((message) => message.type === "synthetic" && message.description === "Decision advisory")).toHaveLength(2)
})

test("a durable advisory fact fences the admitted input ID without another evaluation", async () => {
  const result = await run({ settings: advisory, before: (sessionID) => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const input = (yield* SessionPending.list(db, sessionID))[0]
    yield* events.publish(SessionEvent.Synthetic, { sessionID, text: "Existing helper recommendation", description: "Decision advisory",
      metadata: { decisionInputID: input.id },
    })
  }) })
  expect(result.evaluations).toEqual([])
  expect(result.history.filter((message) => message.type === "synthetic" && message.description === "Decision advisory")).toHaveLength(1)
})

test("advisory caller cancellation propagates without main execution or fabricated observation", async () => {
  const result = await run({ settings: advisory, before: advisorySetup, evaluate: () => Effect.interrupt,
    fails: true, failsAfterPromotion: true,
  })
  expect(result.evaluations).toHaveLength(1)
  expect(result.requests).toEqual([])
  expect(result.history.some((message) => message.type === "synthetic" && message.description === "Decision advisory")).toBe(false)
})

test("native batch advice uses selected probabilities instead of confidence", async () => {
  const result = await run({ settings: Schema.decodeUnknownSync(ConfigDecisions.Info)({ advisory: {
    ...advisoryPolicy, provider: "openai", min_confidence: undefined, min_probability: 0.8,
  } }), before: advisorySetup, evaluate: () => Effect.succeed({ provider: "openai", response: {
    model: "gpt-6-luna", usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 },
    answers: [
      { name: "model", type: "choice", choice: "careful", confidence: 0.01, probabilities: [{ value: "keep-current", probability: 0.2 }, { value: "careful", probability: 0.8 }] },
      { name: "direction", type: "choice", choice: "inspect", confidence: 1, probabilities: [{ value: "keep-current", probability: 0.21 }, { value: "inspect", probability: 0.79 }] },
      { name: "tool", type: "refusal" },
    ],
  } }) })
  expect(result.evaluations).toHaveLength(1)
  expect(JSON.stringify(result.requests[0]?.messages)).toContain("native probability 0.80")
  expect(JSON.stringify(result.requests[0]?.messages)).not.toContain("Recommended direction")
  expect(JSON.stringify(result.requests[0]?.messages)).not.toContain("Recommended tool")
})

const profileSetup = () => Effect.gen(function* () {
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  yield* integrations.transform((draft) => draft.update(Integration.ID.make(providerID), (item) => { item.name = "Fixture" }))
  const work = yield* credentials.create({ integrationID: Integration.ID.make(providerID), label: "Work", value: Credential.Key.make({ type: "key", key: "profile-fixture" }) }).pipe(Effect.orDie)
  const personal = yield* credentials.create({ integrationID: Integration.ID.make(providerID), label: "Personal", value: Credential.Key.make({ type: "key", key: "personal-fixture" }) }).pipe(Effect.orDie)
  const baseline = yield* catalog.model.get(providerID, baselineID)
  if (!baseline) return yield* Effect.die("Missing baseline fixture")
  return yield* catalog.transform((draft) => {
    draft.model.account.update(work, providerID, [{ ...baseline, id: selectedID, variants: [{ id: CatalogModel.VariantID.make("high") }] }])
    draft.model.account.update(personal, providerID, [baseline])
  })
})

test("advisory offers an inactive explicit profile's own model and variant, not the default account's inventory", async () => {
  const settings = Schema.decodeUnknownSync(ConfigDecisions.Info)({ advisory: {
    ...advisoryPolicy,
    candidates: [
      { id: "work", description: "Work route", model: { providerID, model: selectedID, profile: "Work", variant: "high" } },
      { id: "default", description: "Unavailable default", model: { providerID, model: selectedID, variant: "high" } },
      { id: "wrong", description: "Wrong profile variant", model: { providerID, model: selectedID, profile: "Work", variant: "low" } },
    ],
  } })
  const result = await run({ settings, evaluate: () => Effect.succeed(advice()), before: profileSetup })
  expect(result.evaluations).toHaveLength(1)
  const request = result.evaluations[0]
  if (request.provider !== "agent") throw new Error("Expected agent advice")
  expect(request.request.questions[0]).toMatchObject({ name: "model", choices: [{ value: "keep-current" }, { value: "work" }] })
  expect(JSON.stringify(request)).toContain('"profile":"Work"')
  expect(JSON.stringify(request)).not.toContain("profile-fixture")
  expect(JSON.stringify(request)).not.toContain("personal-fixture")
})

test("initial routing validates explicit inactive-profile inventory and variants before inference", async () => {
  const result = await run({ settings: Schema.decodeUnknownSync(ConfigDecisions.Info)({ routing: {
    provider: "openai", min_probability: 0.8, candidates: [
      { id: "work", description: "Work", model: { providerID, model: selectedID, profile: "Work", variant: "high" } },
      { id: "default", description: "Unavailable default", model: { providerID, model: selectedID, variant: "high" } },
      { id: "wrong", description: "Wrong Work variant", model: { providerID, model: selectedID, profile: "Work", variant: "low" } },
    ],
  } }), before: profileSetup, choose: () => Effect.succeed({ choice: "work", probability: 0.9, refused: false }) })
  expect(result.choices).toHaveLength(1)
  expect(result.choices[0].choices).toEqual({ "keep-current": "Keep the current default agent and model", work: "Work" })
  expect(result.session?.model).toEqual(CatalogModel.Ref.make({ providerID, id: selectedID, profile: "Work", variant: CatalogModel.VariantID.make("high") }))
  expect(result.history.find((message) => message.type === "assistant")).toMatchObject({ model: { providerID, id: selectedID, profile: "Work", variant: "high" } })
})

test("initial routing never publishes selection after its selected profile variant disappears", async () => {
  const result = await run({ settings: Schema.decodeUnknownSync(ConfigDecisions.Info)({ routing: {
    provider: "openai", min_probability: 0.8, candidates: [
      { id: "work", description: "Work", model: { providerID, model: selectedID, profile: "Work", variant: "high" } },
    ],
  } }), before: profileSetup, fails: true, choose: () => Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    yield* catalog.transform((draft) => draft.model.account.configure(providerID, (model) => { model.variants = [] }))
    return { choice: "work", probability: 0.9, refused: false }
  }) })
  expect(result.choices).toHaveLength(1)
  expect(result.session?.model).toBeUndefined()
  expect(result.history).toHaveLength(0)
})

test("advisory bounds current request evidence without changing the durable user message", async () => {
  const text = "bounded request ".repeat(1500)
  const result = await run({ settings: advisory, before: advisorySetup, text, evaluate: () => Effect.succeed(advice()) })
  expect(result.evaluations).toHaveLength(1)
  expect(result.evaluations[0]).toMatchObject({ provider: "agent", request: { state: { request: text.slice(0, 16384) } } })
  expect(result.history.find((message) => message.type === "user")).toMatchObject({ text })
})
