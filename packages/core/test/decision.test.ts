import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { Agent } from "@ycoding-ai/core/agent"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { Config } from "@ycoding-ai/core/config"
import { Credential } from "@ycoding-ai/core/credential"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { requestExecutor } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Image } from "@ycoding-ai/core/image"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Integration } from "@ycoding-ai/core/integration"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { DecisionTool } from "@ycoding-ai/core/tool/decision"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { AuthenticationReason, LLM, LLMClient, LLMError } from "@ycoding-ai/ai"
import { ConfigDecisions } from "@ycoding-ai/core/config/decisions"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const wire: Array<{ url: string; body: unknown; authorization: string | undefined }> = []
const behavior = { denied: false, refused: false, hold: false, telemetry: false, mismatch: false, unauthorized: false, score: false }
let entered = Deferred.makeUnsafe<void>()
const executor = Layer.mock(RequestExecutor.Service, { execute: (request) => Effect.sync(() => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON body")
  wire.push({ url: request.url, body: JSON.parse(new TextDecoder().decode(request.body.body)), authorization: request.headers.authorization })
  return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(request.url.includes("typesafe") ? {
    model: "jev-1.13.0", answers: { decision: behavior.score ? {
      type: "score", score: 2.65, probabilities: { "0": 0.1, "1": 0, "2": 0.05, "3": 0.85, "4": 0 },
      confidence: 0.6, legend: { "0": "none", "1": "minor", "2": "recoverable", "3": "irreversible", "4": "destructive" },
    } : { type: "choice", choice: "review", probabilities: { allow: 0.2, review: 0.8 }, confidence: 0.6 } },
    usage: { input_tokens: 12, output_tokens: 0 },
  } : {
    model: "gpt-6-luna",
    answers: [behavior.refused ? { type: "refusal", name: "decision" } : behavior.score ? {
      type: "score", name: "decision", score: 2.65, confidence: 0.6,
      probabilities: [0.1, 0, 0.05, 0.85, 0].map((probability, value) => ({ value,
        label: ["none", "minor", "recoverable", "irreversible", "destructive"][value], probability })),
    } : {
      type: "choice", name: "decision", choice: behavior.mismatch ? "escalate" : "review", probabilities: [{ value: "allow", probability: 0.2 }, { value: "review", probability: 0.8 }], confidence: 0.6,
    }],
    usage: behavior.telemetry ? { input_tokens: 12, output_tokens: 5, total_tokens: 17,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 2 },
    } : { input_tokens: 12, output_tokens: 0, total_tokens: 12 },
  }), { headers: { "content-type": "application/json" } }))
}).pipe(Effect.flatMap((response) => Deferred.succeed(entered, undefined).pipe(
  Effect.andThen(behavior.hold ? Effect.never : behavior.unauthorized ? Effect.fail(new LLMError({
    module: "RequestExecutor", method: "execute", reason: new AuthenticationReason({ message: "Rejected key", kind: "invalid" }),
  })) : Effect.succeed(response)),
))) })
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Decision.node, SessionProjector.node, SessionProviderRequest.node, ToolRegistry.node, ToolRegistry.toolsNode, Permission.node, Credential.node, EventRuntime.node, Agent.node, SessionStore.node]), [
  [requestExecutor, executor],
  [DecisionAgent.node, Layer.mock(DecisionAgent.Service, { evaluate: () => Effect.die("Native decisions must not invoke the helper agent") })],
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([{
    type: "document", path: "fixture", info: Schema.decodeUnknownSync(Config.Info)({ decisions: {
      providers: { openai: { api_key: "fixture-openai-key" }, typesafe: { api_key: "fixture-typesafe-key" } },
    } }),
  }]) })],
  [Permission.node, Layer.mock(Permission.Service, {
    evaluateEffective: () => Effect.succeed("ask" as const),
    assert: () => behavior.denied ? Effect.fail(new Permission.BlockedError({ rules: [], permission: "decision", resources: ["openai"] })) : Effect.void,
  })],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [Image.node, imagePassthrough],
]))

const seed = (id: string) => Effect.gen(function* () {
  wire.length = 0
  behavior.denied = false
  behavior.refused = false
  behavior.hold = false
  behavior.telemetry = false
  behavior.mismatch = false
  behavior.unauthorized = false
  behavior.score = false
  entered = Deferred.makeUnsafe<void>()
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const sessionID = Session.ID.make(id)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Decisions" }).run().pipe(Effect.orDie)
  return sessionID
})

const choice = (sessionID: Session.ID, provider: "openai" | "typesafe") => ({
  context: { sessionID, agent: toolIdentity.agent }, provider, state: { action: "patch" },
  instructions: "Choose the risk", choices: { allow: "Safe", review: "Needs review" },
})

it.effect("native score questions run through the real adapters, normalize risk and settle usage", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_score_native")
  behavior.score = true
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const levels = ["none", "minor", "recoverable", "irreversible", "destructive"].map((label) => ({ label, description: label }))
  for (const provider of ["openai", "typesafe"] as const)
    expect(yield* decisions.score({ context: { sessionID }, provider, state: { action: "shell" }, instructions: "Score risk", levels }))
      .toEqual({ choice: "3", probability: 0.85, refused: false })
  expect(wire[0].body).toMatchObject({ questions: [{ type: "score", name: "decision", levels }] })
  expect(wire[1].body).toMatchObject({ questions: { decision: { type: "score", criteria: levels.map((level) => `${level.label}: ${level.description}`) } } })
  expect((yield* requests.list(sessionID)).map((request) => ({ source: request.source, attempts: request.attempts, input: request.tokens.input })))
    .toEqual([{ source: "decision", attempts: 1, input: 12 }, { source: "decision", attempts: 1, input: 12 }])
}))

it.effect("both native providers retain probabilities and account for one physical decision request", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_native")
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  for (const provider of ["openai", "typesafe"] as const) {
    expect(yield* decisions.choose(choice(sessionID, provider))).toEqual({ choice: "review", probability: 0.8, refused: false })
  }
  expect(wire).toHaveLength(2)
  expect(wire[0]).toMatchObject({ url: "https://api.openai.com/v1/decisions", authorization: "Bearer fixture-openai-key" })
  expect(wire[1]).toMatchObject({ url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer fixture-typesafe-key" })
  const records = yield* requests.list(sessionID)
  expect(records).toHaveLength(2)
  expect(records.map((record) => ({ source: record.source, attempts: record.attempts, tokens: record.tokens.input, cacheReadReported: record.cacheReadReported }))).toEqual([
    { source: "decision", attempts: 1, tokens: 12, cacheReadReported: false },
    { source: "decision", attempts: 1, tokens: 12, cacheReadReported: false },
  ])
  expect(records.every((record) => record.cost === undefined)).toBe(true)
  expect(JSON.stringify(records)).not.toContain("fixture-openai-key")
}))

it.effect("a refusal is preserved as uncertainty rather than an affirmative decision", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_refusal")
  behavior.refused = true
  const decisions = yield* Decision.Service
  expect(yield* decisions.choose(choice(sessionID, "openai"))).toEqual({ refused: true })
}))

it.effect("native adapter failures keep distinct sanitized reasons and settle the ledger", () => Effect.gen(function* () {
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const mismatched = yield* seed("ses_decision_invalid_output")
  behavior.mismatch = true
  const invalidOutput = yield* decisions.choose(choice(mismatched, "openai")).pipe(Effect.exit)
  expect(Exit.isFailure(invalidOutput) && Cause.squash(invalidOutput.cause)).toMatchObject({ _tag: "Decision.Error", reason: "invalid-output" })
  expect(wire).toHaveLength(1)
  expect(yield* requests.list(mismatched)).toHaveLength(1)

  const rejected = yield* seed("ses_decision_rejected_key")
  behavior.unauthorized = true
  const unavailable = yield* decisions.choose(choice(rejected, "openai")).pipe(Effect.exit)
  expect(Exit.isFailure(unavailable) && Cause.squash(unavailable.cause)).toMatchObject({ _tag: "Decision.Error", reason: "unavailable" })
  expect(JSON.stringify(Exit.isFailure(unavailable) && Cause.squash(unavailable.cause))).not.toContain("fixture-openai-key")
  expect(yield* requests.list(rejected)).toHaveLength(1)

  const oversizedImages = yield* seed("ses_decision_adapter_request")
  const invalidRequest = yield* decisions.evaluate({ provider: "openai", request: {
    model: "gpt-6-luna",
    input: [{ role: "user", content: Array.from({ length: 129 }, () => ({ type: "input_image" as const, image_url: "data:image/png;base64,AAAA" })) }],
    questions: [{ type: "predicate", name: "damage", instructions: "Is any product damaged?" }],
  } }, { sessionID: oversizedImages }).pipe(Effect.exit)
  expect(Exit.isFailure(invalidRequest) && Cause.squash(invalidRequest.cause)).toMatchObject({ _tag: "Decision.Error", reason: "invalid-request" })
  expect(wire).toHaveLength(0)
}))

it.effect("assessment separates native probability from uncalibrated confidence and rejects unusable scores", () => Effect.sync(() => {
  const native = new ConfigDecisions.Policy({ provider: "openai", min_probability: 0.8 })
  const agent = new ConfigDecisions.AgentPolicy({ provider: "agent", min_confidence: 0.8 })
  expect(Decision.assess(native, { choice: "allow", probability: 0.8, confidence: 0.1, refused: false }))
    .toEqual({ status: "confident", choice: "allow", score: { metric: "probability", value: 0.8 } })
  expect(Decision.assess(agent, { choice: "allow", probability: 0.99, confidence: 0.79, refused: false }))
    .toEqual({ status: "uncertain", score: { metric: "confidence", value: 0.79 } })
  expect(Decision.assess(agent, { choice: "allow", probability: 0.99, refused: false })).toEqual({ status: "uncertain" })
  for (const value of [Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY])
    expect(Decision.assess(native, { choice: "allow", probability: value, refused: false })).toEqual({ status: "uncertain" })
  expect(Decision.assess(native, { choice: "allow", probability: 0.99, refused: true })).toEqual({ status: "refused" })
  expect(Decision.assess(native, { probability: 0.99, refused: false })).toEqual({ status: "refused" })
  expect(Decision.confident(native, { choice: "allow", probability: 0.8, refused: false })).toBe(true)
  expect(Decision.confident(agent, { choice: "allow", probability: 0.99, confidence: 0.79, refused: false })).toBe(false)
  expect(Decision.describe({ metric: "probability", value: 0.912 })).toBe("native probability 0.91")
  expect(Decision.describe({ metric: "confidence", value: 0.8 })).toBe("model confidence 0.80, uncalibrated")
}))

it.effect("decision usage preserves native totals while normalizing non-overlapping ledger tokens", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_usage")
  behavior.telemetry = true
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const result = yield* decisions.evaluate({ provider: "openai", request: {
    model: "gpt-6-luna", input: "Classify risk", questions: [{ type: "choice", name: "decision", instructions: "Risk", choices: [{ value: "allow" }, { value: "review" }] }],
  } }, { sessionID })
  expect(result.response).toMatchObject({ usage: { input_tokens: 12, output_tokens: 5 } })
  const records = yield* requests.list(sessionID)
  expect(records[0].cacheReadReported).toBe(true)
  expect(records[0].tokens).toEqual({ input: 6, output: 3, reasoning: 2, cache: { read: 4, write: 2 } })
}))

it.effect("automatic decision usage follows the Session agent rather than a hardcoded default", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_actor")
  const database = yield* Database.Service
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  yield* database.db.update(SessionTable).set({ agent: Agent.ID.make("GSD") }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  yield* decisions.choose({ ...choice(sessionID, "openai"), context: { sessionID } })
  expect((yield* requests.list(sessionID))[0].agent).toBe(Agent.ID.make("GSD"))
}))

it.effect("the registered decision tool enforces permission before external inference", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_tool")
  yield* registerToolPlugin(DecisionTool.Plugin)
  const registry = yield* ToolRegistry.Service
  expect((yield* toolDefinitions(registry)).find((tool) => tool.name === "decision")).toBeDefined()
  const call = { sessionID, ...toolIdentity, call: { type: "tool-call" as const, id: "call_decision", name: "decision", input: {
    provider: "openai", request: { model: "gpt-6-luna", input: "Patch", questions: [{ type: "choice", name: "decision", instructions: "Risk", choices: [{ value: "allow" }, { value: "review" }] }] },
  } } }
  behavior.denied = true
  expect((yield* executeTool(registry, call)).type).toBe("error")
  expect(wire).toHaveLength(0)
  behavior.denied = false
  const result = yield* executeTool(registry, call)
  expect(result).toMatchObject({ type: "text", value: expect.stringContaining('"provider":"openai"') })
  expect(wire).toHaveLength(1)
}))

it.effect("Chat and Responses advertise both native decision request shapes to the model", () => Effect.gen(function* () {
  yield* seed("ses_decision_model_schema")
  yield* registerToolPlugin(DecisionTool.Plugin)
  const registry = yield* ToolRegistry.Service
  const tools = yield* toolDefinitions(registry)
  for (const api of ["chat", "responses"] as const) {
    const model = yield* SessionRunnerModel.fromCatalogModel(CatalogModel.Info.make({
      id: CatalogModel.ID.make("fixture"), modelID: CatalogModel.ID.make("fixture"), providerID: Provider.ID.make("openai"), name: "Fixture",
      package: Provider.aisdk("@ai-sdk/openai-compatible"), api,
      settings: { baseURL: "https://example.test/v1" }, headers: {}, body: {},
      capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [],
      time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 10000, output: 1000 },
    }))
    const body = (yield* LLMClient.prepare(LLM.request({ model, prompt: "Classify this action", tools }))).body
    const decoded = Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Union([
      Schema.Struct({ function: Schema.Struct({ name: Schema.String, parameters: Schema.Json }) }),
      Schema.Struct({ name: Schema.String, parameters: Schema.Json }),
    ])) }))(body)
    const tool = decoded.tools[0]
    const definition = "function" in tool ? tool.function : tool
    expect(definition.name).toBe("decision")
    const schema = JSON.stringify(definition.parameters)
    expect(JSON.parse(schema)).toMatchObject({ type: "object", required: expect.arrayContaining(["provider", "request"]), properties: {
      provider: { anyOf: expect.arrayContaining([{ type: "string", enum: ["openai"] }, { type: "string", enum: ["typesafe"] }]) }, request: expect.anything(),
    } })
    for (const type of ["predicate", "noul", "choice", "score"]) expect(schema).toContain(`"${type}"`)
    expect(schema).toContain('"gpt-6-luna"')
  }
}))

it.effect("interrupted inference settles its ledger without retry or a fabricated result", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_interrupt")
  behavior.hold = true
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const fiber = yield* decisions.choose(choice(sessionID, "openai")).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* Fiber.interrupt(fiber)
  const exit = yield* Fiber.await(fiber)
  expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  expect(wire).toHaveLength(1)
  const records = yield* requests.list(sessionID)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ source: "decision", attempts: 1, cacheReadReported: false })
  expect(records[0].cost).toBeUndefined()
}))

it.effect("a bounded timeout fails once and settles without retry", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_timeout")
  behavior.hold = true
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const fiber = yield* decisions.choose(choice(sessionID, "openai")).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* TestClock.adjust("10 seconds")
  const exit = yield* Fiber.await(fiber)
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "Decision.Error", reason: "timeout" })
  expect(wire).toHaveLength(1)
  expect(yield* requests.list(sessionID)).toHaveLength(1)
}))

it.effect("oversized evidence is rejected before inference or ledger admission", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_oversized")
  const decisions = yield* Decision.Service
  const requests = yield* SessionProviderRequest.Service
  const exit = yield* decisions.choose({ ...choice(sessionID, "openai"), state: "x".repeat(1_048_576) }).pipe(Effect.exit)
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "Decision.Error", reason: "input-too-large" })
  expect(wire).toHaveLength(0)
  expect(yield* requests.list(sessionID)).toEqual([])
}))

it.effect("a subscription profile is not a native decision API key", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_decision_subscription")
  const credentials = yield* Credential.Service
  const agents = yield* Agent.Service
  const store = yield* SessionStore.Service
  const requests = yield* SessionProviderRequest.Service
  const events = yield* EventRuntime.Service
  yield* credentials.create({ integrationID: Integration.ID.make("openai"), value: Credential.OAuth.make({
    type: "oauth", methodID: Integration.MethodID.make("chatgpt"), access: "fixture-subscription", refresh: "fixture-refresh", expires: 99999999,
  }) })
  const decisions = Decision.make({
    settings: () => Effect.succeed(undefined), credentials, agents, store, requests, events, environment: {},
    executor: { execute: () => Effect.die("Missing credentials must not execute HTTP") },
  })
  const exit = yield* decisions.choose(choice(sessionID, "openai")).pipe(Effect.exit)
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "Decision.Error", reason: "unavailable" })
  expect(yield* requests.list(sessionID)).toEqual([])
}))
