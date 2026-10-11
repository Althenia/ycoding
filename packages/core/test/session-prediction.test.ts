import { expect, test } from "bun:test"
import { LLMClient, LLMError, LLMEvent, Model, TransportReason, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Agent } from "../src/agent"
import { Config } from "../src/config"
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
let access: "allow" | "ask" | "deny" = "allow"
let output = "Run the focused tests"
let gate: Deferred.Deferred<void> | undefined
let started: Deferred.Deferred<void> | undefined
let memoryFailure = false
let outsideGit = false
let providerFailure = false
let partialUsage = false
let transportTimeout = false
const model = Model.make({ id: "prediction-model", provider: "test", route: OpenAIChat.route.with({ limits: { context: 10000, output: 1000 } }) })
const cost = [{ input: Money.USDPerMillionTokens.make(1), output: Money.USDPerMillionTokens.make(2), cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) } }]
const config = Layer.succeed(Config.Service, Config.Service.of({
  diagnostics: () => Effect.succeed([]), reload: () => Effect.void,
  entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
}))
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => Stream.unwrap(Effect.gen(function* () {
    requests.push(request)
    yield* ProviderRequestObserver.observe({ requestID: request.id ?? "prediction-request", routeID: request.model.route.id, transport: "test-client", attempt: 1, phase: "started", time: 0 })
    return Stream.make(...(partialUsage ? [LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 } })] : [])).pipe(Stream.concat(Stream.unwrap(Effect.gen(function* () {
      if (started) yield* Deferred.succeed(started, undefined)
      if (gate) yield* Deferred.await(gate)
      if (transportTimeout) return Stream.fail(new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider request timed out" }) }))
      return Stream.make(...(providerFailure ? [LLMEvent.providerError({ message: "Provider unavailable" })] : []), LLMEvent.textDelta({ id: "prediction", text: output }),
        ...(partialUsage ? [] : [LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 5 } })]),
        LLMEvent.finish({ reason: "stop" }))
    }))))
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

const helperText = (index = 0) => requests[index]?.messages[0]?.content.find((part) => part.type === "text")?.text

const setup = (options: { child?: boolean; goal?: boolean; pending?: boolean; running?: boolean; reply?: boolean; user?: string; assistant?: string } = {}) => Effect.gen(function* () {
  requests.length = 0; searches.length = 0; accessChecks.length = 0
  requestInterruptions = 0
  outsideGit = false
  providerFailure = false
  partialUsage = false
  transportTimeout = false
  access = "allow"; output = "Run the focused tests"; gate = undefined; started = undefined; memoryFailure = false
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
  if (options.reply !== false) {
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: sourceMessageID, agent: Agent.ID.make("build"), model: { providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("prediction-model") } })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0, text: options.assistant ?? "The build is fixed." })
    if (!options.running) yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: sourceMessageID, finish: "stop", cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  }
  if (options.pending) yield* events.publish(SessionEvent.InputAdmitted, { sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "Already next" }, delivery: "queue" } })
  const published: SessionEvent.PredictionUpdated[] = []
  const stop = yield* events.listen((event) => Effect.sync(() => { if (event.type === "session.prediction.updated") published.push(event as SessionEvent.PredictionUpdated) }))
  yield* Effect.addFinalizer(() => stop)
  const prediction = yield* SessionPrediction.Service
  return { sessionID, sourceMessageID, events, published, prediction, db: database.db }
})

it.live("execution success does not request or publish a prediction", () => Effect.gen(function* () {
  const f = yield* setup()
  started = yield* Deferred.make<void>()
  yield* f.events.publish(SessionEvent.Execution.Succeeded, { sessionID: f.sessionID })
  const began = yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.as(true), Effect.catch(() => Effect.succeed(false)))
  expect(began).toBe(false)
  expect(requests).toHaveLength(0)
  expect(f.published).toHaveLength(0)
}))

it.effect("request returns the suggestion, publishes it, and includes hint only when set", () => Effect.gen(function* () {
  const f = yield* setup()
  const hinted = yield* f.prediction.request(f.sessionID, { memory: [], hint: "  cover the regression tests  " })
  expect(hinted).toEqual({ status: "suggested", text: output })
  expect(f.published.map((event) => event.data)).toEqual([{ sessionID: f.sessionID, sourceMessageID: f.sourceMessageID, text: output }])
  expect(f.published[0] && "durable" in f.published[0]).toBe(false)
  expect(JSON.parse(helperText(0) ?? "")).toEqual({ user: "Fix the failing build", assistant: "The build is fixed.", memory: [], hint: "cover the regression tests" })
  expect(JSON.stringify(requests[0]?.system)).toContain("An optional hint is the user's guidance for what the next message should be about")
  const blank = yield* f.prediction.request(f.sessionID, { memory: [], hint: "   " })
  expect(blank).toEqual({ status: "suggested", text: output })
  expect(JSON.parse(helperText(1) ?? "")).toEqual({ user: "Fix the failing build", assistant: "The build is fixed.", memory: [] })
  const omitted = yield* f.prediction.request(f.sessionID, { memory: [] })
  expect(omitted.status).toBe("suggested")
  expect(JSON.parse(helperText(2) ?? "")).not.toHaveProperty("hint")
  const bounded = yield* f.prediction.request(f.sessionID, { memory: [], hint: ` ${"h".repeat(2500)} ` })
  expect(bounded.status).toBe("suggested")
  expect(JSON.parse(helperText(3) ?? "").hint).toBe("h".repeat(2000))
  expect(f.published).toHaveLength(4)
}))

it.effect("one idle settled root reply produces a bounded helper request, ephemeral suggestion and prediction ledger usage", () => Effect.gen(function* () {
  const f = yield* setup()
  const storeBefore = yield* SessionStore.Service
  expect((yield* storeBefore.context(f.sessionID)).at(-1)).toMatchObject({ type: "assistant", content: [{ type: "text", text: "The build is fixed." }], time: { completed: expect.anything() } })
  const helperAgent = yield* Agent.Service
  expect(yield* helperAgent.get(Agent.ID.make("prediction"))).toBeDefined()
  const result = yield* f.prediction.request(f.sessionID, { memory: [] })
  expect(result).toEqual({ status: "suggested", text: output })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.tools).toEqual([])
  expect(searches).toHaveLength(0)
  expect(accessChecks).toHaveLength(0)
  expect(JSON.stringify(requests[0]?.messages)).toContain("The build is fixed.")
  expect(f.published.map((event) => event.data)).toEqual([{ sessionID: f.sessionID, sourceMessageID: f.sourceMessageID, text: output }])
  expect(f.published[0] && "durable" in f.published[0]).toBe(false)
  const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]?.source).toBe("prediction")
  expect(rows[0]?.attempts).toBe(1)
  const store = yield* SessionStore.Service
  expect((yield* store.get(f.sessionID))?.tokens.output).toBe(5)
  expect((yield* store.get(f.sessionID))?.cost).toBeCloseTo(0.00002)
  expect((yield* store.context(f.sessionID)).map((message) => message.type)).toEqual(["user", "assistant"])
}))

it.effect("searches only selected memory scopes and treats ask as consent", () => Effect.gen(function* () {
  const repository = yield* setup()
  yield* repository.prediction.request(repository.sessionID, { memory: ["repository"] })
  expect(searches.map((input) => [input.scope, input.limit])).toEqual([["repository", 3]])
  expect(accessChecks).toHaveLength(1)

  const knowledge = yield* setup()
  access = "ask"
  const asked = yield* knowledge.prediction.request(knowledge.sessionID, { memory: ["knowledge"] })
  expect(asked.status).toBe("suggested")
  expect(searches.map((input) => input.scope)).toEqual(["knowledge"])
  expect(accessChecks.every((input) => input.agent === "build" && input.action === "memory_read")).toBe(true)
  expect(JSON.stringify(requests[0]?.messages)).toContain("Test rule 0")
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("Test rule 3")
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("x".repeat(601))
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("not sent")

  const denied = yield* setup()
  access = "deny"
  const skipped = yield* denied.prediction.request(denied.sessionID, { memory: ["repository", "knowledge"] })
  expect(skipped).toEqual({ status: "suggested", text: output })
  expect(searches).toEqual([])
  expect(accessChecks).toHaveLength(2)
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("Test rule")

  const none = yield* setup()
  yield* none.prediction.request(none.sessionID, { memory: [] })
  expect(searches).toEqual([])
  expect(accessChecks).toEqual([])
}))

it.effect("ineligible sessions and rejected helper output return unavailable without an event", () => Effect.gen(function* () {
  for (const options of [{ running: true }, { pending: true }, { child: true }, { reply: false }, { goal: true }] as const) {
    const f = yield* setup(options)
    const result = yield* f.prediction.request(f.sessionID, { memory: ["repository", "knowledge"] })
    expect(result).toEqual({ status: "unavailable" })
    expect(requests).toHaveLength(0)
    expect(searches).toHaveLength(0)
    expect(f.published).toHaveLength(0)
  }
  const rejected = yield* setup()
  output = "Suggestion: Run the tests"
  const result = yield* rejected.prediction.request(rejected.sessionID, { memory: [] })
  expect(result).toEqual({ status: "unavailable" })
  expect(requests).toHaveLength(1)
  expect(rejected.published).toHaveLength(0)
  expect((yield* rejected.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, rejected.sessionID)).all())[0]?.source).toBe("prediction")
}))

it.live("a second request cancels the first and the first returns unavailable", () => Effect.gen(function* () {
  const f = yield* setup()
  gate = yield* Deferred.make<void>()
  started = yield* Deferred.make<void>()
  const first = yield* f.prediction.request(f.sessionID, { memory: [] }).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
  const secondStarted = yield* Deferred.make<void>()
  started = secondStarted
  const second = yield* f.prediction.request(f.sessionID, { memory: [] }).pipe(Effect.forkChild)
  const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("First did not cancel")))
  expect(firstResult).toEqual({ status: "unavailable" })
  expect(f.published).toHaveLength(0)
  yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Second did not start")))
  yield* Deferred.succeed(gate, undefined)
  const secondResult = yield* Fiber.join(second).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Second did not finish")))
  expect(secondResult).toEqual({ status: "suggested", text: output })
  expect(f.published.map((event) => event.data.text)).toEqual([output])
  expect(requests).toHaveLength(2)
}))

it.live("new admission interrupts a gated helper and publishes nothing", () => Effect.gen(function* () {
  const f = yield* setup()
  gate = yield* Deferred.make<void>(); started = yield* Deferred.make<void>()
  const fiber = yield* f.prediction.request(f.sessionID, { memory: [] }).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
  yield* f.events.publish(SessionEvent.InputAdmitted, { sessionID: f.sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "New instruction" }, delivery: "steer" } })
  const result = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not cancel")))
  expect(result).toEqual({ status: "unavailable" })
  expect(f.published).toHaveLength(0)
  expect(requests).toHaveLength(1)
  expect(requestInterruptions).toBe(1)
}))

for (const selection of ["agent", "model", "profile"] as const) it.live(`${selection} selection interrupts a held helper, suppresses late text and retains partial usage`, () => Effect.gen(function* () {
  const f = yield* setup()
  const originalModel = { providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("prediction-model"), profile: "Original" }
  yield* f.events.publish(SessionEvent.ModelSelected, { sessionID: f.sessionID, model: originalModel })
  partialUsage = true
  gate = yield* Deferred.make<void>(); started = yield* Deferred.make<void>()
  const fiber = yield* f.prediction.request(f.sessionID, { memory: [] }).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
  if (selection === "agent") yield* f.events.publish(SessionEvent.AgentSelected, { sessionID: f.sessionID, agent: Agent.ID.make("review") })
  if (selection !== "agent") yield* f.events.publish(SessionEvent.ModelSelected, { sessionID: f.sessionID, model: {
    ...originalModel, ...(selection === "profile" ? { profile: "Replacement" } : { id: CatalogModel.ID.make("replacement-model") }),
  } })
  const result = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
  yield* Deferred.succeed(gate, undefined)
  expect(result).toEqual({ status: "unavailable" })
  expect(f.published).toHaveLength(0)
  expect(requestInterruptions).toBe(1)
  expect(requests).toHaveLength(1)
  const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ source: "prediction", tokens: { input: 10, output: 5 }, cost: 0.00002 })
}))

it.effect("provider failure never publishes an otherwise valid suggestion", () => Effect.gen(function* () {
  const f = yield* setup(); providerFailure = true
  const result = yield* f.prediction.request(f.sessionID, { memory: [] })
  expect(result).toEqual({ status: "unavailable" })
  expect(requests).toHaveLength(1)
  expect(f.published).toHaveLength(0)
}))

it.effect("provider timeout suppresses a suggestion without losing reported partial usage", () => Effect.gen(function* () {
  const f = yield* setup()
  partialUsage = true; transportTimeout = true
  const result = yield* f.prediction.request(f.sessionID, { memory: [] })
  expect(result).toEqual({ status: "unavailable" })
  expect(f.published).toHaveLength(0)
  expect(requests).toHaveLength(1)
  expect(requestInterruptions).toBe(1)
  const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
  expect(rows[0]).toMatchObject({ source: "prediction", attempts: 1, tokens: { input: 10, output: 5 }, cost: 0.00002 })
}))

it.effect("a complete follow-up above the old output cap is published without transcript insertion", () => Effect.gen(function* () {
  const f = yield* setup()
  output = "Please review the implementation and run the focused regression tests, then summarize the results, explain any remaining risks, and identify whether the current changes preserve the selected model, provider profile, permissions, and composer draft behavior."
  expect(output.split(/\s+/)).toHaveLength(35)
  expect(output.length).toBeGreaterThan(200)
  const result = yield* f.prediction.request(f.sessionID, { memory: [] })
  expect(result).toEqual({ status: "suggested", text: output })
  expect(f.published.map((event) => event.data.text)).toEqual([output])
  expect(JSON.stringify(requests[0]?.system)).toContain("2–40 words and at most 400 characters")
  const store = yield* SessionStore.Service
  expect((yield* store.context(f.sessionID)).map((message) => message.type)).toEqual(["user", "assistant"])
}))

it.effect("recent text is truncated and memory queries include both sides within the search bound", () => Effect.gen(function* () {
  const f = yield* setup({ user: "U".repeat(2500), assistant: "A".repeat(4500) })
  yield* f.prediction.request(f.sessionID, { memory: ["repository", "knowledge"] })
  const context = JSON.stringify(requests[0]?.messages)
  expect(context).toContain("U".repeat(2000))
  expect(context).not.toContain("U".repeat(2001))
  expect(context).toContain("A".repeat(4000))
  expect(context).not.toContain("A".repeat(4001))
  expect(searches.map((input) => input.query)).toEqual(["U".repeat(512) + " " + "A".repeat(511), "U".repeat(512) + " " + "A".repeat(511)])
  expect(searches.map((input) => [input.scope, input.limit])).toEqual([["repository", 3], ["knowledge", 3]])
}))

it.effect("memory failure degrades to a no-memory helper", () => Effect.gen(function* () {
  const f = yield* setup(); memoryFailure = true
  const result = yield* f.prediction.request(f.sessionID, { memory: ["repository", "knowledge"] })
  expect(result).toEqual({ status: "suggested", text: output })
  expect(f.published).toHaveLength(1)
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("Test rule")
}))

it.effect("outside Git prediction searches shared knowledge only", () => Effect.gen(function* () {
  const f = yield* setup(); outsideGit = true
  const result = yield* f.prediction.request(f.sessionID, { memory: ["repository", "knowledge"] })
  expect(result.status).toBe("suggested")
  expect(searches.map((input) => input.scope)).toEqual(["knowledge"])
  expect(f.published).toHaveLength(1)
}))

test.each([
  ["Run the tests", true], ["a ".repeat(39) + "b", true], ["Thanks", false], ["a ".repeat(40) + "b", false],
  ["", false], ["No suggestion", false], ["nothing", false], ["Nothing else to suggest", false],
  ["Suggestion: Run the tests", false], ['"Run the tests"', false], ["Error: request failed", false],
  ["I cannot predict the next message", false], ["Run tests\nThen report", false], ["Fix the failing build", false],
  ["An error occurred", false], ["User might ask to run tests", false], ["Suggested prompt: Run tests", false],
  ["No useful suggestion", false], ["Run \u001b[31mthe tests", false],
  ["x".repeat(397) + " yz", true], ["x".repeat(398) + " yz", false],
  ["Run \u200ethe tests", false], ["Run \u200fthe tests", false], ["Run \u061cthe tests", false],
  ["Run the\u2028tests", false], ["Run the\u2029tests", false],
])("filters helper output %j", (value, accepted) => {
  expect(SessionPrediction.accept(value, "Fix the failing build") !== undefined).toBe(accepted)
})
