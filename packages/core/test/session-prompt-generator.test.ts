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
import { SessionPromptGenerator } from "../src/session/prompt-generator"
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
let output = "Fix the build, keep the public API, and verify with the focused tests."
let finishReason: "stop" | "length" = "stop"
let gate: Deferred.Deferred<void> | undefined
let started: Deferred.Deferred<void> | undefined
let memoryFailure = false
let outsideGit = false
let providerFailure = false
let partialUsage = false
let transportTimeout = false
const model = Model.make({ id: "prompt-model", provider: "test", route: OpenAIChat.route.with({ limits: { context: 10000, output: 1000 } }) })
const cost = [{ input: Money.USDPerMillionTokens.make(1), output: Money.USDPerMillionTokens.make(2), cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) } }]
const config = Layer.succeed(Config.Service, Config.Service.of({
  diagnostics: () => Effect.succeed([]), reload: () => Effect.void,
  entries: () => Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({}) })]),
}))
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => Stream.unwrap(Effect.gen(function* () {
    requests.push(request)
    yield* ProviderRequestObserver.observe({ requestID: request.id ?? "prompt-request", routeID: request.model.route.id, transport: "test-client", attempt: 1, phase: "started", time: 0 })
    return Stream.make(...(partialUsage ? [LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 } })] : [])).pipe(Stream.concat(Stream.unwrap(Effect.gen(function* () {
      if (started) yield* Deferred.succeed(started, undefined)
      if (gate) yield* Deferred.await(gate)
      if (transportTimeout) return Stream.fail(new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider request timed out" }) }))
      return Stream.make(...(providerFailure ? [LLMEvent.providerError({ message: "Provider unavailable" })] : []), LLMEvent.textDelta({ id: "prompt", text: output }),
        ...(partialUsage ? [] : [LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 5 } })]),
        LLMEvent.finish({ reason: finishReason }))
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
  Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Agent.node, SessionPromptGenerator.node,
]), [[llmClient, client], [Config.node, config], [Memory.node, memory], [Permission.node, permission], [SessionRunnerModel.node, models], [Location.node, Layer.succeed(Location.Service, Location.Service.of({ directory: AbsolutePath.make("/project"), project: { id: Project.ID.global, directory: AbsolutePath.make("/project") } }))]]))

const helperText = (index = 0) => requests[index]?.messages[0]?.content.find((part) => part.type === "text")?.text

it.effect("preserves a known zero helper price", () => Effect.gen(function* () {
  const zero = Money.USDPerMillionTokens.make(0)
  yield* Effect.acquireUseRelease(
    Effect.sync(() => cost.splice(0, cost.length, { input: zero, output: zero, cache: { read: zero, write: zero } })),
    () => Effect.gen(function* () {
      const f = yield* setup()
      expect((yield* f.generator.request(f.sessionID, { mode: "start", intent: "Fix the build", memory: [] })).status).toBe("generated")
      expect(yield* f.db.select({ source: SessionProviderRequestTable.source, cost: SessionProviderRequestTable.cost }).from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).get()).toEqual({ source: "prompt", cost: 0 })
    }),
    (previous) => Effect.sync(() => cost.splice(0, cost.length, ...previous)),
  )
}))

const setup = (options: { child?: boolean; goal?: boolean; pending?: boolean; running?: boolean; reply?: boolean; user?: string; assistant?: string; directory?: string } = {}) => Effect.gen(function* () {
  requests.length = 0; searches.length = 0; accessChecks.length = 0
  requestInterruptions = 0
  outsideGit = false
  providerFailure = false
  partialUsage = false
  transportTimeout = false
  finishReason = "stop"
  access = "allow"; output = "Fix the build, keep the public API, and verify with the focused tests."; gate = undefined; started = undefined; memoryFailure = false
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const agents = yield* Agent.Service
  yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
  const sessionID = Session.ID.create()
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* database.db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, directory: options.directory ?? "/project", title: "Prompt", agent: "build",
    ...(options.child ? { parent_id: Session.ID.make("ses_parent") } : {}),
    ...(options.goal ? { autonomy: { mode: "normal" as const, permissions: "manual", guardrails: "manual", answers: "manual", goal: { text: "Finish", status: "active" as const, iteration: 0, noProgress: 0, maxNoProgress: 3 } } } : {}),
  }).run().pipe(Effect.orDie)
  if (options.user !== "") {
    const inputID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.InputAdmitted, { sessionID, inputID, input: { type: "user", data: { text: options.user ?? "Fix the failing build" }, delivery: "steer" } })
    yield* events.publish(SessionEvent.InputPromoted, { sessionID, inputID })
  }
  const sourceMessageID = SessionMessage.ID.create()
  if (options.reply !== false && options.user !== "") {
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: sourceMessageID, agent: Agent.ID.make("build"), model: { providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("prompt-model") } })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: sourceMessageID, ordinal: 0, text: options.assistant ?? "The build is fixed." })
    if (!options.running) yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: sourceMessageID, finish: "stop", cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  }
  if (options.pending) yield* events.publish(SessionEvent.InputAdmitted, { sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "Already next" }, delivery: "queue" } })
  const generator = yield* SessionPromptGenerator.Service
  return { sessionID, sourceMessageID, events, generator, db: database.db }
})

const request = (sessionID: Session.ID, input?: { mode?: "start" | "steer" | "queue" | "goal"; intent?: string; memory?: ReadonlyArray<"repository" | "knowledge"> }) =>
  Effect.gen(function* () {
    const generator = yield* SessionPromptGenerator.Service
    return yield* generator.request(sessionID, { mode: input?.mode ?? "steer", intent: input?.intent ?? "Cover the regression", memory: input?.memory ?? [] })
  })

it.effect("returns generated text for an idle Session and records prompt usage without a transcript entry", () => Effect.gen(function* () {
  const f = yield* setup()
  const storeBefore = yield* SessionStore.Service
  expect((yield* storeBefore.context(f.sessionID)).map((message) => message.type)).toEqual(["user", "assistant"])
  const helperAgent = yield* Agent.Service
  const promptAgent = yield* helperAgent.get(Agent.ID.make("prompt"))
  expect(promptAgent).toMatchObject({ mode: "primary", hidden: true })
  const result = yield* request(f.sessionID, { mode: "start", intent: "  Cover the regression  " })
  expect(result).toEqual({ status: "generated", text: output })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.tools).toEqual([])
  expect(JSON.stringify(requests[0]?.system)).toContain("Output only the prompt text")
  expect(JSON.parse(helperText() ?? "")).toEqual({
    mode: "start",
    intent: "Cover the regression",
    recent: { user: "Fix the failing build", assistant: "The build is fixed." },
    memory: [],
  })
  const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]?.source).toBe("prompt")
  const store = yield* SessionStore.Service
  expect((yield* store.get(f.sessionID))?.tokens.output).toBe(5)
  expect((yield* store.get(f.sessionID))?.cost).toBeCloseTo(0.00002)
  expect((yield* store.context(f.sessionID)).map((message) => message.type)).toEqual(["user", "assistant"])
}))

it.effect("sends the user-constraint policy in the assembled system request for every prompt mode, outside the untrusted user message", () => Effect.gen(function* () {
  const policy = [
    "In every mode, including goal, carry the applicable user configuration and constraints into the prompt: required model, provider and profile bindings, permissions, ownership, workflow, tests and checks, toolchain and filesystem.",
    "Never direct a workaround that substitutes a binding, widens access, or redirects toolchain, cache, build or config locations or invents directories (for example CARGO_HOME, CARGO_TARGET_DIR, --config, custom target or cache paths, a repository .cache or macOS Library path).",
    "Where the work cannot proceed within them, direct reporting the exact gap and the decision needed.",
    "Keep any explicit user-authorized exception or later change through a supported control valid, and preserve the objective and its completion criteria.",
  ]
  for (const mode of ["start", "steer", "queue", "goal"] as const) {
    const f = yield* setup()
    expect(yield* request(f.sessionID, { mode, intent: "Ship the fix" })).toEqual({ status: "generated", text: output })
    expect(requests).toHaveLength(1)
    const system = JSON.stringify(requests[0]?.system)
    for (const clause of policy) expect(system.split(JSON.stringify(clause).slice(1, -1))).toHaveLength(2)
    expect(system).toContain("Output only the prompt text")
    expect(system).not.toContain("Main-session controls:")
    expect(requests[0]?.tools).toEqual([])
    expect(JSON.parse(helperText() ?? "")).toMatchObject({ mode, intent: "Ship the fix" })
    expect(helperText()).not.toContain("CARGO_HOME")
  }
}))

it.effect("generates for a running child Session with an active goal, pending input, and an unfinished reply", () => Effect.gen(function* () {
  for (const options of [{ running: true, goal: true }, { pending: true }, { child: true }, { reply: false }, { user: "" }] as const) {
    const f = yield* setup(options)
    const result = yield* request(f.sessionID, { mode: "goal", intent: "Ship the fix" })
    expect(result).toEqual({ status: "generated", text: output })
    expect(requests).toHaveLength(1)
  }
}))

it.effect("omits absent recent parts and bounds recent text in the helper message and memory query", () => Effect.gen(function* () {
  const empty = yield* setup({ user: "" })
  yield* request(empty.sessionID, { intent: "Open the task" })
  expect(JSON.parse(helperText() ?? "")).toEqual({ mode: "steer", intent: "Open the task", memory: [] })

  const f = yield* setup({ user: "U".repeat(2500), assistant: "A".repeat(4500) })
  yield* f.generator.request(f.sessionID, { mode: "queue", intent: "I".repeat(100), memory: ["repository", "knowledge"] })
  const parsed = JSON.parse(helperText() ?? "")
  expect(parsed.recent.user).toBe("U".repeat(2000))
  expect(parsed.recent.user).not.toContain("U".repeat(2001))
  expect(parsed.recent.assistant).toBe("A".repeat(4000))
  expect(parsed.mode).toBe("queue")
  const tail = `${"U".repeat(2000)} ${"A".repeat(4000)}`
  const intent = "I".repeat(100)
  const query = `${intent} ${tail.slice(0, 1024 - intent.length - 1)}`
  expect(searches.map((input) => input.query)).toEqual([query, query])
  expect(searches.map((input) => [input.scope, input.limit])).toEqual([["repository", 3], ["knowledge", 3]])
  expect(query.length).toBeLessThanOrEqual(1024)
}))

it.effect("searches only selected memory scopes and treats ask as consent", () => Effect.gen(function* () {
  const repository = yield* setup()
  yield* request(repository.sessionID, { memory: ["repository"] })
  expect(searches.map((input) => [input.scope, input.limit])).toEqual([["repository", 3]])
  expect(accessChecks).toHaveLength(1)

  const knowledge = yield* setup()
  access = "ask"
  const asked = yield* request(knowledge.sessionID, { memory: ["knowledge"] })
  expect(asked.status).toBe("generated")
  expect(searches.map((input) => input.scope)).toEqual(["knowledge"])
  expect(accessChecks.every((input) => input.agent === "build" && input.action === "memory_read")).toBe(true)
  expect(JSON.stringify(requests[0]?.messages)).toContain("Test rule 0")
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("Test rule 3")
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("x".repeat(601))
  expect(JSON.stringify(requests[0]?.messages)).not.toContain("not sent")

  const denied = yield* setup()
  access = "deny"
  const skipped = yield* request(denied.sessionID, { memory: ["repository", "knowledge"] })
  expect(skipped).toEqual({ status: "generated", text: output })
  expect(searches).toEqual([])
  expect(accessChecks).toHaveLength(2)
  expect(JSON.parse(helperText() ?? "").memory).toEqual([])

  const none = yield* setup()
  yield* request(none.sessionID, { memory: [] })
  expect(searches).toEqual([])
  expect(accessChecks).toEqual([])
}))

it.effect("a missing or foreign Session and rejected helper output return unavailable", () => Effect.gen(function* () {
  requests.length = 0
  const missing = yield* request(Session.ID.make("ses_missing"), { intent: "Anything" })
  expect(missing).toEqual({ status: "unavailable" })
  expect(requests).toHaveLength(0)

  const foreign = yield* setup({ directory: "/other" })
  expect(yield* request(foreign.sessionID)).toEqual({ status: "unavailable" })
  expect(requests).toHaveLength(0)

  const rejected = yield* setup()
  output = "I cannot draft this prompt"
  const result = yield* request(rejected.sessionID)
  expect(result).toEqual({ status: "unavailable" })
  expect((yield* rejected.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, rejected.sessionID)).all())[0]?.source).toBe("prompt")
  const store = yield* SessionStore.Service
  expect((yield* store.context(rejected.sessionID)).map((message) => message.type)).toEqual(["user", "assistant"])
}))

it.effect("provider failure, a non-stop finish, and a timeout return unavailable", () => Effect.gen(function* () {
  const failed = yield* setup()
  providerFailure = true
  expect(yield* request(failed.sessionID)).toEqual({ status: "unavailable" })

  const length = yield* setup()
  finishReason = "length"
  expect(yield* request(length.sessionID)).toEqual({ status: "unavailable" })

  const timed = yield* setup()
  partialUsage = true
  transportTimeout = true
  expect(yield* request(timed.sessionID)).toEqual({ status: "unavailable" })
  const rows = yield* timed.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, timed.sessionID)).all()
  expect(rows[0]).toMatchObject({ source: "prompt", attempts: 1, tokens: { input: 10, output: 5 }, cost: 0.00002 })
}))

it.effect("strips one wrapping fence or quote pair and keeps a multiline draft", () => Effect.gen(function* () {
  const f = yield* setup()
  output = "```markdown\nFix the build.\nVerify the focused tests.\n```"
  expect(yield* request(f.sessionID)).toEqual({ status: "generated", text: "Fix the build.\nVerify the focused tests." })
}))

it.live("a second request cancels the first and the first returns unavailable", () => Effect.gen(function* () {
  const f = yield* setup()
  gate = yield* Deferred.make<void>()
  started = yield* Deferred.make<void>()
  const first = yield* request(f.sessionID).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
  const secondStarted = yield* Deferred.make<void>()
  started = secondStarted
  const second = yield* request(f.sessionID, { mode: "queue", intent: "Follow up" }).pipe(Effect.forkChild)
  const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("First did not cancel")))
  expect(firstResult).toEqual({ status: "unavailable" })
  yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Second did not start")))
  yield* Deferred.succeed(gate, undefined)
  const secondResult = yield* Fiber.join(second).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Second did not finish")))
  expect(secondResult).toEqual({ status: "generated", text: output })
  expect(requests).toHaveLength(2)
  expect(requestInterruptions).toBe(1)
}))

it.live("admission and execution start do not cancel, while move, delete, and archive do", () => Effect.gen(function* () {
  const held = yield* setup()
  gate = yield* Deferred.make<void>()
  started = yield* Deferred.make<void>()
  const fiber = yield* request(held.sessionID).pipe(Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
  yield* held.events.publish(SessionEvent.InputAdmitted, { sessionID: held.sessionID, inputID: SessionMessage.ID.create(), input: { type: "user", data: { text: "New instruction" }, delivery: "steer" } })
  yield* held.events.publish(SessionEvent.Execution.Started, { sessionID: held.sessionID })
  yield* Deferred.succeed(gate, undefined)
  expect(yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not finish")))).toEqual({ status: "generated", text: output })

  for (const kind of ["moved", "deleted", "archived"] as const) {
    const f = yield* setup()
    partialUsage = true
    gate = yield* Deferred.make<void>()
    started = yield* Deferred.make<void>()
    const running = yield* request(f.sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(started).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die("Helper did not start")))
    if (kind === "moved") yield* f.events.publish(SessionEvent.Moved, { sessionID: f.sessionID, location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }) })
    if (kind === "deleted") yield* f.events.publish(SessionEvent.Deleted, { sessionID: f.sessionID })
    if (kind === "archived") yield* f.events.publish(SessionEvent.Archived, { sessionID: f.sessionID })
    expect(yield* Fiber.join(running).pipe(Effect.timeout("1 second"), Effect.catch(() => Effect.die(`${kind} did not cancel`)))).toEqual({ status: "unavailable" })
    if (kind === "deleted") continue
    const rows = yield* f.db.select().from(SessionProviderRequestTable).where(eq(SessionProviderRequestTable.session_id, f.sessionID)).all()
    expect(rows[0]).toMatchObject({ source: "prompt", tokens: { input: 10, output: 5 } })
  }
}))

it.effect("memory failure and a repository outside Git degrade without failing the draft", () => Effect.gen(function* () {
  const failed = yield* setup()
  memoryFailure = true
  expect(yield* request(failed.sessionID, { memory: ["repository", "knowledge"] })).toEqual({ status: "generated", text: output })
  expect(JSON.parse(helperText() ?? "").memory).toEqual([])

  const outside = yield* setup()
  outsideGit = true
  expect((yield* request(outside.sessionID, { memory: ["repository", "knowledge"] })).status).toBe("generated")
  expect(searches.map((input) => input.scope)).toEqual(["knowledge"])
}))

test.each([
  ["Fix the build and verify it.", "Fix the build and verify it."],
  ["```\nFix the build.\n```", "Fix the build."],
  ["```ts\nLine one.\nLine two.\n```", "Line one.\nLine two."],
  ["\"Fix the build.\"", "Fix the build."],
  ["'Fix the build.'", "Fix the build."],
  ["“Fix the build.”", "Fix the build."],
  ["‘Fix the build.’", "Fix the build."],
  ["```\n\"Fix the build.\"\n```", "Fix the build."],
  ["Keep going.\nThen verify.", "Keep going.\nThen verify."],
  ["Column\tone", "Column\tone"],
  ["Line\r\nbreak", "Line\r\nbreak"],
  ["x".repeat(8000), "x".repeat(8000)],
  ["", undefined],
  ["   ", undefined],
  ["x".repeat(8001), undefined],
  ["I cannot draft this", undefined],
  ["I can't help with that", undefined],
  ["I can’t help with that", undefined],
  ["Sorry, no prompt", undefined],
  ["As an AI I should refuse", undefined],
  ["Fix the\u0000build", undefined],
  ["Fix the\u200ebuild", undefined],
  ["Fix the\u2028build", undefined],
  ["Fix the\u2029build", undefined],
])("filters helper output %j", (value, accepted) => {
  expect(SessionPromptGenerator.accept(value)).toBe(accepted)
})
