import { expect, test } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Agent } from "../src/agent"
import { Config } from "../src/config"
import { ConfigPrediction } from "../src/config/prediction"
import { ConfigMemory } from "../src/config/memory"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { llmClient } from "../src/effect/app-node-platform"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Memory } from "../src/memory"
import { Location } from "../src/location"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { AgentPlugin } from "../src/plugin/agent"
import { agentHost, host } from "./plugin/host"
import { Permission } from "../src/permission"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { Session } from "@ycoding-ai/schema/session"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionPrediction } from "../src/session/prediction"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { SessionHelperPolicy } from "../src/session/helper-policy"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { ProviderRequestObserver } from "../src/session/provider-request-observer"
import { Money } from "@ycoding-ai/schema/money"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
const searches: Array<{ scope?: Memory.Scope; query: string; limit?: number }> = []
const accessChecks: Permission.EvaluateEffectiveInput[] = []
let requestInterruptions = 0
let enabled = false
let withMemory = true
let access: "allow" | "ask" | "deny" = "allow"
let output = "Run the focused tests"
let gate: Deferred.Deferred<void> | undefined
let started: Deferred.Deferred<void> | undefined
let memoryFailure = false
let outsideGit = false
let providerFailure = false
const model = Model.make({ id: "prediction-model", provider: "test", route: OpenAIChat.route.with({ limits: { context: 10000, output: 1000 } }) })
const cost = [{ input: Money.USDPerMillionTokens.make(1), output: Money.USDPerMillionTokens.make(2), cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) } }]
const config = Layer.succeed(Config.Service, Config.Service.of({
  diagnostics: () => Effect.succeed([]), reload: () => Effect.void,
  entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({
    prediction: new ConfigPrediction.Info({ enabled, memory: withMemory }),
  }) })]),
}))
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => Stream.unwrap(Effect.gen(function* () {
    requests.push(request)
    yield* ProviderRequestObserver.observe({ requestID: request.id ?? "prediction-request", routeID: request.model.route.id, transport: "test-client", attempt: 1, phase: "started", time: 0 })
    if (started) yield* Deferred.succeed(started, undefined)
    if (gate) yield* Deferred.await(gate)
    return Stream.make(...(providerFailure ? [LLMEvent.providerError({ message: "Provider unavailable" })] : []), LLMEvent.textDelta({ id: "prediction", text: output }),
      LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 5 } }),
      LLMEvent.finish({ reason: "stop" }))
  })).pipe(Stream.onExit(exit => Effect.sync(() => { if (exit._tag === "Failure") requestInterruptions++ }))),
})
const memory = Layer.mock(Memory.Service)({
  status: (scope = "repository") => Effect.succeed({ enabled: true, scope, directory: "/project", base: "/memory", knowledgeRoot: "/memory/knowledge", limits: ConfigMemory.resolve([]), root: `/memory/${scope}`, ...(outsideGit ? {} : { repository: { id: "repo_test", directory: "/project", commonDirectory: "/project/.git", worktrees: ["/project"] } }) }),
  search: (input: { scope?: Memory.Scope; query: string; limit?: number }) => Effect.gen(function* () {
    searches.push(input)
    if (memoryFailure) return yield* Effect.die("memory unavailable")
    return { hits: Array.from({ length: 4 }, (_, index) => ({ id: `testing/rule-${index}`, title: `Test rule ${index}`, snippet: "x".repeat(900), digest: "not sent", score: 1, type: "gotcha" })), warnings: [] }
  }),
})
const permission = Layer.mock(Permission.Service)({ evaluateEffective: (input) => Effect.sync(() => { accessChecks.push(input); return access }) })
const models = Layer.mock(SessionRunnerModel.Service)({ resolve: () => Effect.succeed(SessionRunnerModel.resolved(model, undefined, cost)) })
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Agent.node, SessionPrediction.node,
]), [[llmClient, client], [Config.node, config], [Memory.node, memory], [Permission.node, permission], [SessionRunnerModel.node, models], [Location.node, Layer.succeed(Location.Service, Location.Service.of({ directory: AbsolutePath.make("/project"), project: { id: Project.ID.global, directory: AbsolutePath.make("/project") } }))]]))

const setup = (options: { child?: boolean; goal?: boolean; pending?: boolean; user?: string; assistant?: string } = {}) => Effect.gen(function* () {
  requests.length = 0; searches.length = 0; accessChecks.length = 0
  requestInterruptions = 0
  outsideGit = false
  providerFailure = false
  enabled = true; withMemory = false; access = "allow"; output = "Run the focused tests"; gate = undefined; started = undefined; memoryFailure = false
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const agents = yield* Agent.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
  const sessionID = Session.ID.create()
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Prediction", agent: "build",
    ...(options.child ? { parent_id: Session.ID.make("ses_parent") } : {}),
    ...(options.goal ? { autonomy: { mode: "normal" as const, yolo: 0 as const, goal: { text: "Finish", status: "active" as const, iteration: 0, noProgress: 0, maxNoProgress: 3 } } } : {}),
  }).run().pipe(Effect.orDie)
  const inputID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.InputAdmitted, { sessionID, inputID, input: { type: "user", data: { text: options.user ?? "Fix the failing build" }, delivery: "steer" } })
  yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID })
  const sourceMessageID = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: sourceMessageID, agent: Agent.ID.make("build"), model: { providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("prediction-model") } })
  yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0 })
  yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0, text: options.assistant ?? "The build is fixed." })
  yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: sourceMessageID, finish: "stop", cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  if (options.pending) yield* events.publish(SessionEvent.InputAdmitted, { sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "Already next" }, delivery: "queue" } })
  const published: SessionEvent.PredictionUpdated[] = []
  const stop = yield* events.listen((event) => Effect.sync(() => { if (event.type === "session.prediction.updated") published.push(event as SessionEvent.PredictionUpdated) }))
  yield* Effect.addFinalizer(() => stop)
  const prediction = yield* SessionPrediction.Service
  return { sessionID, sourceMessageID, events, published, prediction, db: database.db }
})

it.effect("off by default and skips children, active goals and pending input", () => Effect.gen(function* () {
  expect(ConfigPrediction.resolve([])).toEqual({ enabled: false, memory: true })
  expect(ConfigPrediction.resolve([new ConfigPrediction.Info({ enabled: true }), new ConfigPrediction.Info({ memory: false })])).toEqual({ enabled: true, memory: false })
  for (const options of [{}, { child: true }, { goal: true }, { pending: true }]) {
    const f = yield* setup(options)
    if (Object.keys(options).length === 0) enabled = false
    yield* f.prediction.generateForReply(f.sessionID)
    expect(requests).toHaveLength(0)
    expect(searches).toHaveLength(0)
    expect(f.published).toHaveLength(0)
  }
}))

it.effect("one idle settled root reply produces a bounded helper request, ephemeral suggestion and prediction ledger usage", () => Effect.gen(function* () {
  const f = yield* setup()
  const storeBefore = yield* SessionStore.Service
  expect((yield* storeBefore.context(f.sessionID)).at(-1)).toMatchObject({ type: "assistant", content: [{ type: "text", text: "The build is fixed." }], time: { completed: expect.anything() } })
  const helperAgent = yield* Agent.Service
  expect(yield* helperAgent.get(Agent.ID.make("prediction"))).toBeDefined()
  yield* f.prediction.generateForReply(f.sessionID)
  yield* f.prediction.generateForReply(f.sessionID)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.tools).toEqual([])
  expect(searches).toHaveLength(0)
  expect(JSON.stringify(requests[0]?.messages)).toContain("The build is fixed.")
  expect(f.published.map(event => event.data)).toEqual([{ sessionID: f.sessionID, sourceMessageID: f.sourceMessageID, text: output }])
  expect(f.published[0] && "durable" in f.published[0]).toBe(false)
  const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]?.source).toBe("prediction")
  expect(rows[0]?.attempts).toBe(1)
  const store = yield* SessionStore.Service
  expect((yield* store.get(f.sessionID))?.tokens.output).toBe(5)
  expect((yield* store.get(f.sessionID))?.cost).toBeCloseTo(0.00002)
  expect((yield* store.context(f.sessionID)).map(message => message.type)).toEqual(["user", "assistant"])
}))

it.live("new admission interrupts a gated helper and publishes nothing", () => Effect.gen(function* () {
  const f = yield* setup()
  gate = yield* Deferred.make<void>(); started = yield* Deferred.make<void>()
  const fiber = yield* f.prediction.generateForReply(f.sessionID).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
  yield* f.events.publish(SessionEvent.InputAdmitted, { sessionID: f.sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "New instruction" }, delivery: "steer" } })
  yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not cancel")))
  expect(f.published).toHaveLength(0)
  expect(requests).toHaveLength(1)
  expect(requestInterruptions).toBe(1)
}))

it.live("idle execution event forks once and does not await the helper", () => Effect.gen(function* () {
  const f = yield* setup()
  gate = yield* Deferred.make<void>(); started = yield* Deferred.make<void>()
  const predicted = yield* Deferred.make<void>()
  const stop = yield* f.events.listen(event => event.type === "session.prediction.updated" ? Deferred.succeed(predicted, undefined).pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  expect(requests).toHaveLength(0)
  yield* f.events.publish(SessionEvent.Execution.Succeeded, { sessionID: f.sessionID })
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
  expect(requests).toHaveLength(1)
  expect(f.published).toHaveLength(0)
  yield* f.events.publish(SessionEvent.Execution.Succeeded, { sessionID: f.sessionID })
  yield* Deferred.succeed(gate, undefined)
  yield* Deferred.await(predicted).pipe(Effect.timeout("1 second"))
  yield* f.prediction.generateForReply(f.sessionID)
  expect(requests).toHaveLength(1)
  expect(f.published).toHaveLength(1)
}))

it.effect("invalid helper text produces no event but keeps accounting", () => Effect.gen(function* () {
  const f = yield* setup(); output = "Suggestion: Run the tests"
  yield* f.prediction.generateForReply(f.sessionID)
  expect(requests).toHaveLength(1)
  expect(f.published).toHaveLength(0)
  expect((yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all())[0]?.source).toBe("prediction")
}))

it.effect("provider failure never publishes an otherwise valid suggestion", () => Effect.gen(function* () {
  const f = yield* setup(); providerFailure = true
  yield* f.prediction.generateForReply(f.sessionID)
  expect(requests).toHaveLength(1)
  expect(f.published).toHaveLength(0)
}))

it.effect("recent text is truncated and memory queries include both sides within the search bound", () => Effect.gen(function* () {
  const f = yield* setup({ user: "U".repeat(2500), assistant: "A".repeat(4500) }); withMemory = true
  yield* f.prediction.generateForReply(f.sessionID)
  const context = JSON.stringify(requests[0]?.messages)
  expect(context).toContain("U".repeat(2000))
  expect(context).not.toContain("U".repeat(2001))
  expect(context).toContain("A".repeat(4000))
  expect(context).not.toContain("A".repeat(4001))
  expect(searches.map(input => input.query)).toEqual(["U".repeat(512) + " " + "A".repeat(511), "U".repeat(512) + " " + "A".repeat(511)])
}))

for (const effect of ["allow", "ask", "deny"] as const) it.effect(`memory requires selected-agent memory_read allow (${effect})`, () => Effect.gen(function* () {
  const f = yield* setup(); withMemory = true; access = effect
  yield* f.prediction.generateForReply(f.sessionID)
  expect(searches.map(input => [input.scope, input.limit])).toEqual(effect === "allow" ? [["repository", 3], ["knowledge", 3]] : [])
  expect(accessChecks.every(input => input.agent === "build" && input.action === "memory_read")).toBe(true)
  expect(searches.every(input => input.query.includes("Fix the failing build") && input.query.includes("The build is fixed.") && input.query.length <= 1024)).toBe(true)
  const context = JSON.stringify(requests[0]?.messages)
  expect(context.includes("Test rule 0")).toBe(effect === "allow")
  expect(context).not.toContain("Test rule 3")
  expect(context).not.toContain("x".repeat(601))
  expect(context).not.toContain("not sent")
}))

it.effect("memory failure degrades to a no-memory helper", () => Effect.gen(function* () {
  const f = yield* setup(); withMemory = true; memoryFailure = true
  yield* f.prediction.generateForReply(f.sessionID)
  expect(f.published).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("Test rule")
}))

it.effect("outside Git prediction searches shared knowledge only", () => Effect.gen(function* () {
  const f = yield* setup(); withMemory = true; outsideGit = true
  yield* f.prediction.generateForReply(f.sessionID)
  expect(searches.map(input => input.scope)).toEqual(["knowledge"])
  expect(f.published).toHaveLength(1)
}))

test.each([
  ["Run the tests", true], ["a ".repeat(19) + "b", true], ["Thanks", false], ["a ".repeat(20) + "b", false],
  ["", false], ["No suggestion", false], ["nothing", false], ["Nothing else to suggest", false],
  ["Suggestion: Run the tests", false], ['"Run the tests"', false], ["Error: request failed", false],
  ["I cannot predict the next message", false], ["Run tests\nThen report", false], ["Fix the failing build", false],
  ["An error occurred", false], ["User might ask to run tests", false], ["Suggested prompt: Run tests", false],
  ["No useful suggestion", false], ["Run \u001b[31mthe tests", false],
  ["x".repeat(199) + " y", false],
])("filters helper output %j", (value, accepted) => {
  expect(SessionPrediction.accept(value, "Fix the failing build") !== undefined).toBe(accepted)
})
