import { expect, test } from "bun:test"
import { ToolFailure } from "@ycoding-ai/ai"
import { Cause, DateTime, Effect, Exit, Layer, Result, Schema } from "effect"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Project } from "../src/project"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { ConfigDecisions } from "../src/config/decisions"
import { Decision } from "../src/decision"
import { DecisionJudgment } from "../src/decision-judgment"
import { EventRuntime } from "../src/event"
import { Permission } from "../src/permission"
import { Provider } from "../src/provider"
import { CatalogModel } from "../src/model"
import { SessionAutonomy } from "../src/session/autonomy"
import { SessionEvent } from "../src/session/event"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { toSessionError } from "../src/session/to-session-error"
import { ScopeTool } from "../src/tool/scope"
import { SubagentTool } from "../src/tool/subagent"
import { Tool } from "../src/tool/tool"

const task = (id: string, ownership = [`${id}/**`], depends_on: string[] = []) => ({
  id, title: `Implement ${id}`, ownership, read_only: false, acceptance: `Run ${id} checks`, depends_on,
})
const context: Tool.Context = { sessionID: SessionSchema.ID.make("ses_scope"), agent: Agent.ID.make("parent"),
  messageID: SessionMessage.ID.make("msg_scope_assistant"), callID: "scope-call", progress: () => Effect.void }
const userID = SessionMessage.ID.make("msg_scope_user")
const model = Schema.decodeUnknownSync(CatalogModel.Info)({ ...CatalogModel.Info.empty(Provider.ID.make("openai"), CatalogModel.ID.make("fixture")),
  package: "@ai-sdk/openai", capabilities: { tools: true, input: ["text"], output: ["text"] },
  limit: { context: 10000, output: 1000 }, variants: [{ id: "high" }], profiles: [{ name: "fixture-profile", active: false }],
})

function run(input: {
  tasks?: ReturnType<typeof task>[]
  yolo?: SessionAutonomy.YoloLevel
  goal?: SessionAutonomy.Goal
  auto?: boolean
  configured?: boolean
  maxTasks?: number
  candidates?: boolean
  deny?: boolean
  capacity?: number
  depth?: number
  fail?: boolean
  choices?: Record<string, string>
  score?: number
  evidence?: string
  spawnFailure?: string
  defaultAgent?: string
  provider?: "agent" | "openai" | "typesafe"
  currentChildren?: number
  revokeAutonomy?: boolean
  beforeSpawn?: () => void
} = {}) {
  const evaluations: Decision.Input[] = []
  const launches: typeof SubagentTool.Input.Type[] = []
  const observations: { text: string; description?: string; metadata?: Readonly<Record<string, unknown>> }[] = []
  const assertions: Permission.AssertInput[] = []
  const state = { yolo: input.yolo ?? 0 }
  const settings = Schema.decodeUnknownSync(ConfigDecisions.Info)({
    ...(input.configured === false ? {} : { scoping: { provider: input.provider ?? "agent",
      ...(input.provider && input.provider !== "agent" ? { min_probability: 0.8 } : { min_confidence: 0.8 }),
      auto_dispatch: input.auto ?? false, max_tasks: input.maxTasks ?? 8 } }),
    ...(input.candidates ? { advisory: { provider: "agent", min_confidence: 0.8,
      candidates: [{ id: "expert", description: "Exact fixture variant", agent: "worker",
        model: { providerID: "openai", model: "fixture", variant: "high", profile: "fixture-profile" } }],
      directions: [{ id: "inspect", description: "Inspect" }] } } : {}),
  })
  const layers = Layer.mergeAll(
    Layer.mock(Decision.Service, { settings: () => Effect.succeed(settings), evaluate: (value) => {
      evaluations.push(value)
      if (input.revokeAutonomy) state.yolo = 0
      if (input.fail) return Effect.fail(new Decision.Error({ reason: "provider-failed" }))
      expect(Schema.is(Decision.Input)(value)).toBe(true)
      if (value.provider === "openai") return Effect.succeed({ provider: "openai", response: { model: "gpt-6-luna", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        answers: value.request.questions.map((question) => ({ type: "choice", name: question.name ?? null,
          choice: question.name === "granularity" ? "right-sized" : question.name?.startsWith("ready:") ? "yes" : "child",
          confidence: 0.1, probabilities: [{ value: question.name === "granularity" ? "right-sized" : question.name?.startsWith("ready:") ? "yes" : "child", probability: input.score ?? 0.9 }] })) } })
      if (value.provider === "typesafe") return Effect.succeed({ provider: "typesafe", response: { model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(Object.keys(value.request.questions).map((name) => {
          const choice = name === "granularity" ? "right-sized" : name.startsWith("ready:") ? "yes" : "child"
          return [name, { type: "choice", choice, confidence: 0.1, probabilities: { [choice]: input.score ?? 0.9 } }]
        })) } })
      expect(Result.isSuccess(Schema.decodeUnknownResult(DecisionJudgment.Request)(value.request))).toBe(true)
      return Effect.succeed({ provider: "agent" as const, response: { model: { providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make("fixture") },
        semantics: "model-estimate" as const, version: 1 as const,
        answers: value.request.questions.map((question) => ({ name: question.name, type: "choice" as const,
          answer: null, choice: input.choices?.[question.name] ?? (question.name === "granularity" ? "right-sized" :
            question.name.startsWith("ready:") ? "yes" : question.name.startsWith("delegate:") ? "child" : "expert"),
          score: null, confidence: input.score ?? 0.9 })),
      } })
    } }),
    Layer.mock(Permission.Service, { evaluateEffective: () => Effect.succeed(input.deny ? "deny" : "allow"),
      assert: (value) => { assertions.push(value); return input.deny ? Effect.fail(new Permission.BlockedError({
        rules: [], permission: value.action, resources: value.resources,
      })) : Effect.void } }),
    Layer.mock(Config.Service, { entries: () => Effect.succeed([new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({
      experimental: { subagent_depth: 1 }, default_agent: input.defaultAgent ?? "worker",
    }) })]) }),
    Layer.mock(Agent.Service, { list: () => Effect.succeed([Schema.decodeUnknownSync(Agent.Info)({ ...Agent.Info.empty(Agent.ID.make("worker")), mode: "subagent" })]) }),
    Layer.mock(Catalog.Service, { provider: { get: () => Effect.die("unused"), all: () => Effect.die("unused"), available: () => Effect.die("unused") }, model: { available: () => Effect.succeed([model]), get: () => Effect.succeed(model),
      all: () => Effect.die("unused"), default: () => Effect.die("unused"), defaultSelection: () => Effect.die("unused"),
      forConnection: () => Effect.die("unused"), small: () => Effect.die("unused") } }),
    Layer.mock(SessionAutonomy.Service, { get: () => Effect.succeed({ mode: "normal", yolo: state.yolo, goal: input.goal }) }),
    Layer.mock(SessionStore.Service, { context: () => Effect.succeed([{
      type: "user", id: userID, text: "User task evidence", files: [], agents: [],
      time: { created: DateTime.makeUnsafe(0), consumed: DateTime.makeUnsafe(1) },
    }]), get: (id) => Effect.succeed(Schema.decodeUnknownSync(SessionSchema.Info)({ id,
      ...(input.depth && id === context.sessionID ? { parentID: "ses_ancestor" } : {}),
      projectID: Project.ID.global, location: { directory: "/scope-fixture" }, title: "Scope fixture",
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
    })) }),
    Layer.mock(SessionGuardrail.Service, { status: () => Effect.succeed(new Guardrail.Status({ rootSessionID: context.sessionID,
      profile: "standard", customRules: 0, approvals: 0, blocked: 0, invalidFiles: [],
      counters: [new Guardrail.Counter({ id: "subagents", current: input.currentChildren ?? 0, limit: input.capacity ?? 8, scope: "family" })] })), }),
    Layer.mock(EventRuntime.Service, { publish: (event, value) => {
      if (event.type === SessionEvent.Synthetic.type) observations.push(Schema.decodeUnknownSync(SessionEvent.Synthetic.data)(value))
      return Effect.succeed({ id: EventRuntime.ID.create(), type: event.type, created: DateTime.makeUnsafe(1), data: value,
        ...(event.durability === "durable" ? { durable: { aggregateID: context.sessionID, seq: EventRuntime.Seq.make(0),
          version: EventRuntime.Version.make(event.durable.version) } } : {}) } as EventRuntime.Payload<typeof event>)
    } }),
  )
  return Effect.gen(function* () {
    const tool = yield* ScopeTool.make((value) => {
      input.beforeSpawn?.()
      launches.push(value)
      if (input.spawnFailure) return Effect.fail(new ToolFailure({ message: "Launch blocked", metadata: { reason: input.spawnFailure } }))
      return Effect.succeed({ sessionID: SessionSchema.ID.make(`ses_child_${launches.length}`), status: "running", output: "Started" })
    })
    const result = yield* tool.execute({ tasks: input.tasks ?? [task("one")], evidence: input.evidence }, context).pipe(Effect.exit)
    return { result, evaluations, launches, observations, assertions }
  }).pipe(Effect.provide(layers), Effect.runPromise)
}

function planOf(value: Awaited<ReturnType<typeof run>>) {
  expect(Exit.isSuccess(value.result)).toBe(true)
  if (Exit.isFailure(value.result)) throw Cause.squash(value.result.cause)
  return value.result.value.plan
}

test("scope rejects empty ownership, duplicate IDs, unknown dependencies, cycles and invalid labels", () => {
  for (const tasks of [[], [task("one", [])], [task("one"), task("one")], [task("one", ["one/**"], ["missing"])],
    [task("one", ["one/**"], ["two"]), task("two", ["two/**"], ["one"])], [task("Bad_label")],
    [task("a".repeat(33))], Array.from({ length: 11 }, (_, index) => task(`task-${index}`))])
    expect(Result.isFailure(Schema.decodeUnknownResult(ScopeTool.Input)({ tasks }))).toBe(true)
  expect(Schema.decodeUnknownSync(ScopeTool.Input)({ tasks: [{ ...task("a".repeat(32)), depends_on: undefined }] }).tasks[0].depends_on).toEqual([])
  expect(Result.isFailure(Schema.decodeUnknownResult(ScopeTool.Input)({ tasks: [task("one")], surprise: true }))).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(ScopeTool.Input)({ tasks: [{ ...task("one"), surprise: true }] }))).toBe(true)
})

test("ownership overlap respects segment boundaries and glob prefixes", () => {
  for (const [a, b, expected] of [
    ["a.ts", "a.ts", true], ["a/**", "a/b.ts", true], ["a/**", "a/b/**", true],
    ["a/**", "ab/c.ts", false], ["a/*.ts", "a/file.ts", true], ["a/*.ts", "b/file.ts", false],
    ["**", "a/b.ts", true], ["a/b.ts", "a/c.ts", false], ["a/**", "a", true],
  ] as const) {
    expect(ScopeTool.overlaps(a, b)).toBe(expected)
    expect(ScopeTool.overlaps(b, a)).toBe(expected)
  }
})

test("decision permission deny fails without evaluation or dispatch", async () => {
  const value = await run({ deny: true, auto: true, yolo: 1 })
  expect(Exit.isFailure(value.result)).toBe(true)
  if (Exit.isFailure(value.result)) expect(toSessionError(Cause.squash(value.result.cause)).type).toBe("permission.rejected")
  expect(value.evaluations).toHaveLength(0)
  expect(value.launches).toHaveLength(0)
})

test("ten tasks with candidates ask exactly 31 valid questions and preserve exact model refs", async () => {
  const value = await run({ maxTasks: 10, candidates: true, tasks: Array.from({ length: 10 }, (_, index) => task(`task-${index}`)) })
  expect(value.evaluations).toHaveLength(1)
  const request = value.evaluations[0]
  if (request.provider !== "agent") throw new Error("Expected agent")
  expect(request.request.questions).toHaveLength(31)
  expect(Schema.is(DecisionJudgment.Request)(request.request)).toBe(true)
  expect(Exit.isSuccess(value.result)).toBe(true)
  if (Exit.isSuccess(value.result)) expect(value.result.value.plan.tasks[0].tier).toMatchObject({ providerID: "openai", id: "fixture", variant: "high", profile: "fixture-profile" })
})

test("normal mode never dispatches and records the complete synthetic judgment", async () => {
  const value = await run({ auto: true })
  expect(value.launches).toHaveLength(0)
  expect(Exit.isSuccess(value.result)).toBe(true)
  if (Exit.isSuccess(value.result)) {
    expect(value.result.value.plan.tasks[0].dispatchable).toBe(true)
    expect(value.result.value.plan.dispatched).toBeUndefined()
  }
  expect(value.observations).toHaveLength(1)
  expect(value.observations[0]).toMatchObject({ description: "Scoping advisory", metadata: { decisionInputID: userID, scoping: true } })
  expect(value.observations[0].text.startsWith("Decision advisory:")).toBe(true)
  expect(value.observations[0].text).toContain("Recommended ")
  expect(value.observations[0].text).toContain('"dispatchable":true')
})

test("YOLO 1 dispatches dependencies first and skips conflicting ownership", async () => {
  const value = await run({ auto: true, yolo: 1, candidates: true, tasks: [task("two", ["two/**"], ["one"]), task("one"),
    task("conflict-a", ["shared/**"]), task("conflict-b", ["shared/file.ts"])] })
  expect(value.launches.map((launch) => launch.description)).toEqual(["Implement one", "Implement two"])
  expect(value.launches[0]).toMatchObject({ agent: "worker", model: { providerID: "openai", id: "fixture", variant: "high", profile: "fixture-profile" } })
  expect(value.launches[1].prompt).toContain("one: dispatched")
  expect(value.launches[0].prompt).toContain("Exclusive write ownership")
  expect(value.launches[0].prompt).toContain("Do not spawn subagents")
  if (Exit.isSuccess(value.result)) {
    expect(value.result.value.plan.dispatched?.map((item) => item.taskID)).toEqual(["one", "two"])
    expect(value.result.value.plan.tasks.find((item) => item.id === "conflict-a")?.reasons).toContain("ownership-conflict")
    expect(value.result.value.plan.conflicts).toEqual([{ a: "conflict-a", b: "conflict-b", path: "shared/**" }])
  }
  planOf(value)
  expect(value.observations[0].text).toContain('"dispatched"')
})

test("capacity overflow is non-dispatchable", async () => {
  const value = await run({ auto: true, yolo: 1, capacity: 1, tasks: [task("one"), task("two")] })
  expect(value.launches).toHaveLength(1)
  expect(planOf(value).tasks[1]).toMatchObject({ dispatchable: false, reasons: ["capacity-exceeded"] })
})

test("uncertain readiness, self delegation, blocked dependencies and depth prevent dispatch", async () => {
  const value = await run({ auto: true, yolo: 1, tasks: [task("one"), task("two", ["two/**"], ["one"])],
    choices: { "ready:one": "no", "delegate:two": "self" } })
  expect(value.launches).toHaveLength(0)
  planOf(value)
  if (Exit.isSuccess(value.result)) {
    expect(value.result.value.plan.tasks[0].reasons).toContain("not-ready")
    expect(value.result.value.plan.tasks[1].reasons).toContain("dependency-not-ready:one")
    expect(value.result.value.plan.tasks[1].reasons).toContain("not-delegated")
  }
  const uncertain = await run({ auto: true, yolo: 1, score: 0.79 })
  expect(uncertain.launches).toHaveLength(0)
  expect(planOf(uncertain).tasks[0].dispatchable).toBe(false)
  const depth = await run({ auto: true, yolo: 1, depth: 1 })
  expect(planOf(depth).tasks[0].reasons).toContain("depth-limit")
})

test("read-only tasks do not conflict with a writer and retain acceptance checks", async () => {
  const value = await run({ tasks: [task("one", ["shared/**"]), { ...task("review", ["shared/**"]), read_only: true }] })
  if (Exit.isSuccess(value.result)) {
    expect(value.result.value.plan.conflicts).toEqual([])
    expect(value.result.value.plan.tasks.every((item) => item.dispatchable)).toBe(true)
  }
  planOf(value)
})

test("active goal permits dispatch while stopped goal and omitted flag do not", async () => {
  const goal: SessionAutonomy.Goal = { text: "Verify changes", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 }
  expect((await run({ auto: true, goal })).launches).toHaveLength(1)
  expect((await run({ auto: true, goal: { ...goal, status: "stopped" } })).launches).toHaveLength(0)
  expect((await run({ yolo: 1 })).launches).toHaveLength(0)
})

test("native review remains undispatched with a reason and no fabricated child", async () => {
  const value = await run({ auto: true, yolo: 1, spawnFailure: "review-required" })
  if (Exit.isSuccess(value.result)) {
    expect(value.result.value.plan.dispatched).toEqual([])
    expect(value.result.value.plan.tasks[0]).toMatchObject({ dispatchable: false, reasons: ["review-required"] })
  }
  planOf(value)
})

test("unconfigured policy and provider errors fail without dispatch or fabricated advice", async () => {
  for (const input of [{ configured: false }, { fail: true }, { maxTasks: 1, tasks: [task("one"), task("two")] }]) {
    const value = await run({ ...input, auto: true, yolo: 1 })
    expect(Exit.isFailure(value.result)).toBe(true)
    expect(value.launches).toHaveLength(0)
    expect(value.observations).toHaveLength(0)
  }
})

test("an ineligible configured default never silently selects another agent", async () => {
  const value = await run({ auto: true, yolo: 1, defaultAgent: "primary-only" })
  expect(value.launches).toHaveLength(0)
  expect(Exit.isSuccess(value.result)).toBe(true)
  if (Exit.isSuccess(value.result)) expect(value.result.value.plan.tasks[0]).toMatchObject({ dispatchable: false, reasons: ["no-eligible-agent"] })
})

test("native scoping adapters assess selected probabilities, not confidence", async () => {
  for (const provider of ["openai", "typesafe"] as const) {
    const value = await run({ provider })
    expect(value.evaluations).toHaveLength(1)
    expect(planOf(value).tasks[0]).toMatchObject({ dispatchable: true, ready: { score: { metric: "probability", value: 0.9 } } })
    const uncertain = await run({ provider, score: 0.79, auto: true, yolo: 1 })
    expect(planOf(uncertain).tasks[0].dispatchable).toBe(false)
    expect(uncertain.launches).toHaveLength(0)
  }
})

test("existing family children consume capacity and unknown choices cannot dispatch", async () => {
  const full = await run({ auto: true, yolo: 1, currentChildren: 1, capacity: 1 })
  expect(planOf(full).tasks[0].reasons).toContain("capacity-exceeded")
  expect(full.launches).toHaveLength(0)
  const unknown = await run({ auto: true, yolo: 1, choices: { "delegate:one": "fabricated" } })
  expect(planOf(unknown).tasks[0]).toMatchObject({ delegate: { status: "refused" }, dispatchable: false })
  expect(unknown.launches).toHaveLength(0)
})

test("autonomy revoked during judgment prevents automatic dispatch", async () => {
  const value = await run({ auto: true, yolo: 1, revokeAutonomy: true })
  expect(value.launches).toHaveLength(0)
  expect(planOf(value).dispatched).toBeUndefined()
})

test("evidence replaces bounded promoted text and active objective is bounded", async () => {
  const value = await run({ evidence: "Supplied evidence", goal: { text: "g".repeat(5000), status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 } })
  planOf(value)
  expect(value.evaluations[0]).toMatchObject({ request: { state: { request: "Supplied evidence", objective: "g".repeat(4096),
    limits: { maxChildren: 8, depth: 1 } } } })
})
