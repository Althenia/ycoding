import { expect } from "bun:test"
import { AuthenticationReason, LLMClient, LLMError, LLMEvent, Model, TransportReason, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols/openai-chat"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { eq } from "drizzle-orm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { DecisionAgent } from "@ycoding-ai/core/decision-agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { llmClient, requestExecutor } from "@ycoding-ai/core/effect/app-node-platform"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionHelperPolicy } from "@ycoding-ai/core/session/helper-policy"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const ref = (providerID: string, id: string, variant?: string, profile?: string) =>
  CatalogModel.Ref.make({
    providerID: Provider.ID.make(providerID),
    id: CatalogModel.ID.make(id),
    ...(variant === undefined ? {} : { variant: CatalogModel.VariantID.make(variant) }),
    ...(profile === undefined ? {} : { profile }),
  })
const key = (value: CatalogModel.Ref | undefined) =>
  value === undefined ? "session" : [value.providerID, value.id, value.variant ?? "", value.profile ?? ""].join("|")

const yoloPin = ref("openai", "yolo-pin", "high", "Work")
const decisionPin = ref("anthropic", "decision-pin", "medium")
const helper = ref("openai", "helper", "low")
const sessionModel = ref("openai", "session-model", "medium", "Personal")
const switchedSession = ref("openai", "switched-session")

type Step = "ok" | "malformed" | "truncated" | "transport" | "auth" | "refused" | "hold"
type Mode = "native" | "unsupported" | "missing"

const modes = new Map<string, Mode>()
const plans = new Map<string, Step[]>()
const requests: LLMRequest[] = []
const resolveCalls: string[] = []
const baselineResolves: string[] = []
const resolveOptions: Array<unknown> = []
const config = { helper: undefined as CatalogModel.Ref | "session" | undefined }
const hold = { entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() }
const RAW = "RAW-MODEL-OUTPUT-MARKER"

const valid = JSON.stringify({
  decisions: { version: 1, answers: [{ name: "ok", type: "predicate", answer: true, choice: null, score: null, confidence: 0.9 }] },
})

const modelFor = (value: CatalogModel.Ref | undefined) => {
  const mode = modes.get(key(value)) ?? "native"
  if (mode === "missing") return undefined
  const base = Model.make({ id: value?.id ?? "session-default", provider: value?.providerID ?? "openai", route: OpenAIChat.route })
  const model = mode === "unsupported" ? Model.update(base, { route: base.route.with({ id: "openai-compatible-chat" }) }) : base
  return { ...SessionRunnerModel.resolved(model, value?.variant), ref: value ?? ref("openai", "session-default") }
}

const client = Layer.mock(LLMClient.Service, {
  stream: (request) => {
    requests.push(request)
    const step = plans.get(String(request.model.id))?.shift() ?? "ok"
    if (step === "transport" || step === "auth")
      return Stream.fail(new LLMError({ module: "test", method: "stream", reason: step === "transport"
        ? new TransportReason({ message: "connection reset" })
        : new AuthenticationReason({ message: "invalid key", kind: "invalid" }) }))
    const reason = step === "truncated" ? "length" as const : step === "refused" ? "content-filter" as const : "stop" as const
    const text = step === "malformed" ? `{"probability":1,"echo":"${RAW}"}` : step === "refused" || step === "truncated" ? "" : valid
    const emit = Stream.make(
      LLMEvent.textDelta({ id: "judgment", text }),
      LLMEvent.stepFinish({ index: 0, reason, usage: { inputTokens: 12, nonCachedInputTokens: 12, outputTokens: 5, reasoningTokens: 2 } }),
      LLMEvent.finish({ reason }),
    )
    return step === "hold"
      ? Stream.fromEffect(Deferred.succeed(hold.entered, undefined).pipe(Effect.andThen(Deferred.await(hold.release)))).pipe(Stream.flatMap(() => emit))
      : emit
  },
})

const policy = SessionHelperPolicy.Service.of({
  get settings() {
    return { titleMode: "local" as const, models: config.helper === undefined ? {} : { decision: config.helper } }
  },
  localTitle: () => "Decision",
  resolveModel: (session, _role, agent, options) => {
    baselineResolves.push(agent?.id ?? "none")
    resolveOptions.push(options)
    return Effect.succeed(modelFor(agent?.model ?? (config.helper === "session" ? session.model : config.helper) ?? session.model))
  },
  resolveRef: (_session, value, options) => {
    resolveCalls.push(key(value))
    resolveOptions.push(options)
    return Effect.succeed(modelFor(value))
  },
} as SessionHelperPolicy.Interface)

const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, Decision.node, DecisionAgent.node, Agent.node, SessionProjector.node, SessionProviderRequest.node, EventRuntime.node, SessionStore.node, Permission.node,
]), [
  [llmClient, client],
  [requestExecutor, Layer.mock(RequestExecutor.Service, { execute: () => Effect.die("Decision recovery must use the stream client") })],
  [SessionHelperPolicy.node, Layer.succeed(SessionHelperPolicy.Service, policy)],
  [Config.node, Layer.mock(Config.Service, { entries: () => Effect.succeed([]) })],
  [Permission.node, Layer.mock(Permission.Service, { evaluateEffective: () => Effect.succeed("ask" as const), assert: () => Effect.void })],
]))

const question = { type: "predicate" as const, name: "ok", instructions: "Is it ok?" }
const input = (state: Record<string, string> = {}) => ({ provider: "agent" as const, request: { state, questions: [question] } })

const seed = (id: string, pins: { yolo?: CatalogModel.Ref; decision?: CatalogModel.Ref; session?: CatalogModel.Ref | null } = {}) => Effect.gen(function* () {
  requests.length = 0
  resolveCalls.length = 0
  baselineResolves.length = 0
  resolveOptions.length = 0
  modes.clear()
  plans.clear()
  config.helper = helper
  hold.entered = Deferred.makeUnsafe<void>()
  hold.release = Deferred.makeUnsafe<void>()
  const database = yield* Database.Service
  yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const sessionID = SessionSchema.ID.make(id)
  const stored = pins.session === null ? undefined : (pins.session ?? sessionModel)
  yield* database.db.insert(SessionTable).values({
    id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Decision recovery",
    ...(stored === undefined ? {} : { model: stored }),
  }).run().pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((draft) => {
    for (const name of ["decision", "yolo-permission", "yolo-guardrail", "yolo-answer"])
      draft.update(Agent.ID.make(name), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = "Return the requested typed judgment."
        agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
        if (name === "decision" && pins.decision) agent.model = pins.decision
        if (name === "yolo-answer" && pins.yolo) agent.model = pins.yolo
      })
  })
  return sessionID
})

const audits = Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const seen: Array<Record<string, unknown>> = []
  const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
    if (event.type === "session.decision.audited") seen.push(event.data as Record<string, unknown>)
  }))
  yield* Effect.addFinalizer(() => unsubscribe)
  return seen
})

const yolo = (sessionID: SessionSchema.ID, value = input()) =>
  Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(value, { sessionID, purpose: "answer", authority: "yolo" })
  })
const baseline = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input(), { sessionID, purpose: "permission", authority: "baseline" })
  })
const advisory = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    return yield* (yield* Decision.Service).evaluate(input(), { sessionID })
  })
const failureReason = (exit: Exit.Exit<unknown, unknown>) =>
  exit._tag === "Failure" ? (Cause.squash(exit.cause) as { reason: string }).reason : undefined
const sent = () => requests.map((request) => String(request.model.id))
const prompt = (request: LLMRequest) => JSON.stringify(request.messages)

it.effect("a purpose-specific YOLO pin is tried first with its exact variant and profile", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_order", { yolo: yoloPin, decision: decisionPin })
  const seenAudits = yield* audits
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["yolo-pin"])
  expect(resolveCalls).toEqual([key(yoloPin)])
  expect(result.response.model).toEqual(yoloPin)
  expect(seenAudits).toEqual([expect.objectContaining({ outcome: "succeeded", authority: "yolo", agent: "yolo-answer", model: yoloPin, attempts: 1 })])
}))

it.effect("candidates follow YOLO pin, decision pin, configured helper, then the session model without repeats", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_precedence", { yolo: yoloPin, decision: decisionPin })
  for (const candidate of [yoloPin, decisionPin, helper, sessionModel]) modes.set(key(candidate), "unsupported")
  const exit = yield* yolo(sessionID).pipe(Effect.exit)
  expect(failureReason(exit)).toBe("unsupported-output")
  expect(resolveCalls).toEqual([key(yoloPin), key(decisionPin), key(helper), key(sessionModel)])
  expect(requests).toHaveLength(0)
}))

it.effect("a decision pin equal to the configured helper or session model is not retried as a separate candidate", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_dedup", { decision: helper, session: helper })
  modes.set(key(helper), "unsupported")
  yield* yolo(sessionID).pipe(Effect.exit)
  expect(resolveCalls).toEqual([key(helper)])
}))

it.effect("a configured session selector uses the session model only after explicit candidates and an unset one uses the default", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_session_selector", { session: null })
  config.helper = "session"
  modes.set(key(undefined), "native")
  yield* yolo(sessionID)
  expect(resolveCalls).toEqual([key(undefined)])
  expect(sent()).toEqual(["session-default"])
}))

it.effect("an unsupported pinned route sends no request and the next configured candidate answers once", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_unsupported", { yolo: yoloPin, decision: decisionPin })
  modes.set(key(yoloPin), "unsupported")
  const ledger = yield* SessionProviderRequest.Service
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["decision-pin"])
  expect(resolveCalls).toEqual([key(yoloPin), key(decisionPin)])
  expect(result.response.model).toEqual(decisionPin)
  expect(yield* ledger.list(sessionID)).toHaveLength(1)
}))

it.effect("an unavailable pin is skipped and only exactly configured selections are ever resolved", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_unavailable", { yolo: yoloPin, decision: decisionPin })
  modes.set(key(yoloPin), "missing")
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["decision-pin"])
  expect(result.response.model).toEqual(decisionPin)
  expect(resolveCalls).toEqual([key(yoloPin), key(decisionPin)])
  expect(resolveCalls).not.toContain(key(ref("openai", "yolo-pin", "high")))
  expect(resolveCalls).not.toContain(key(ref("openai", "yolo-pin")))
}))

it.effect("malformed output repairs once on the same candidate with a sanitized note, then recovers on the next", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_malformed", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["malformed", "malformed"])
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["yolo-pin", "yolo-pin", "decision-pin"])
  expect(result.response.model).toEqual(decisionPin)
  expect(prompt(requests[0]!)).not.toContain("not a valid JSON")
  for (const request of requests.slice(1)) {
    expect(prompt(request)).toContain("previous response was not a valid JSON document")
    expect(prompt(request)).not.toContain(RAW)
    expect(prompt(request)).not.toContain("probability")
  }
  for (const request of requests) {
    expect(request.tools).toEqual([])
    expect(request.responseFormat).toMatchObject({ type: "json" })
  }
}))

it.effect("a transport failure retries the same candidate once and then recovers on the next", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_transport", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["transport", "transport"])
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["yolo-pin", "yolo-pin", "decision-pin"])
  expect(result.response.model).toEqual(decisionPin)
}))

it.effect("truncated output retries with a larger limit before recovering and never gains a free-text answer", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_truncated", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["truncated", "truncated"])
  const result = yield* yolo(sessionID)
  expect(sent()).toEqual(["yolo-pin", "yolo-pin", "decision-pin"])
  expect(requests[0]?.generation?.maxTokens).toBe(4096)
  expect(requests[1]?.generation?.maxTokens).toBe(8192)
  expect(result.response.answers[0]).toMatchObject({ type: "predicate", answer: true })
}))

it.effect("total provider attempts stay at three across at most two per candidate and fail with the last typed reason", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_cap", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["malformed", "malformed"])
  plans.set("decision-pin", ["malformed", "malformed"])
  const seenAudits = yield* audits
  const ledger = yield* SessionProviderRequest.Service
  const exit = yield* yolo(sessionID).pipe(Effect.exit)
  expect(failureReason(exit)).toBe("invalid-output")
  expect(sent()).toEqual(["yolo-pin", "yolo-pin", "decision-pin"])
  expect(seenAudits).toEqual([expect.objectContaining({ outcome: "failed", reason: "invalid-output", attempts: 3, model: decisionPin })])
  expect(yield* ledger.list(sessionID)).toHaveLength(3)
}))

it.effect("failures that must not evade a refusal, credential, or request bound never hop to another candidate", () => Effect.gen(function* () {
  for (const [step, reason] of [["auth", "provider-failed"], ["refused", "refused"]] as const) {
    const sessionID = yield* seed(`ses_recovery_nohop_${step}`, { yolo: yoloPin, decision: decisionPin })
    plans.set("yolo-pin", [step])
    const exit = yield* yolo(sessionID).pipe(Effect.exit)
    expect(failureReason(exit)).toBe(reason)
    expect(sent()).toEqual(["yolo-pin"])
  }
  const oversized = yield* seed("ses_recovery_nohop_size", { yolo: yoloPin, decision: decisionPin })
  const exit = yield* yolo(oversized, input({ big: "x".repeat(1_100_000) })).pipe(Effect.exit)
  expect(failureReason(exit)).toBe("input-too-large")
  expect(requests).toHaveLength(0)
  expect(resolveCalls).toEqual([])
}))

it.effect("when every candidate is skipped the primary candidate's typed reason is reported in one audit", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_all_skipped", { yolo: yoloPin, decision: decisionPin })
  modes.set(key(yoloPin), "unsupported")
  modes.set(key(decisionPin), "missing")
  modes.set(key(helper), "missing")
  modes.set(key(sessionModel), "missing")
  const seenAudits = yield* audits
  const exit = yield* yolo(sessionID).pipe(Effect.exit)
  expect(failureReason(exit)).toBe("unsupported-output")
  expect(requests).toHaveLength(0)
  expect(seenAudits).toEqual([expect.objectContaining({ outcome: "failed", reason: "unsupported-output", attempts: 0, route: "openai-compatible-chat", model: yoloPin })])
}))

it.effect("baseline and advisory invocations keep one candidate, ignore YOLO pins, and never hop", () => Effect.gen(function* () {
  for (const run of [baseline, advisory]) {
    const sessionID = yield* seed(`ses_recovery_single_${run === baseline ? "baseline" : "advisory"}`, { yolo: yoloPin, decision: decisionPin })
    plans.set("decision-pin", ["malformed", "malformed"])
    const exit = yield* run(sessionID).pipe(Effect.exit)
    expect(failureReason(exit)).toBe("invalid-output")
    expect(sent()).toEqual(["decision-pin", "decision-pin"])
    expect(resolveCalls).toEqual([])
    expect(baselineResolves).toEqual(["decision"])
    expect(prompt(requests[1]!)).not.toContain(RAW)
  }
  const unsupported = yield* seed("ses_recovery_single_unsupported", { yolo: yoloPin, decision: decisionPin })
  modes.set(key(decisionPin), "unsupported")
  expect(failureReason(yield* baseline(unsupported).pipe(Effect.exit))).toBe("unsupported-output")
  expect(requests).toHaveLength(0)
  expect(resolveCalls).toEqual([])
}))

it.effect("a main-session model switch leaves an explicit helper first and only changes the trailing candidate", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_switch", { session: sessionModel })
  modes.set(key(switchedSession), "unsupported")
  const database = yield* Database.Service
  yield* database.db.update(SessionTable).set({ model: switchedSession }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  const result = yield* yolo(sessionID)
  expect(result.response.model).toEqual(helper)
  expect(sent()).toEqual(["helper"])
  expect(resolveCalls).toEqual([key(helper)])
  config.helper = undefined
  const exit = yield* yolo(sessionID).pipe(Effect.exit)
  expect(failureReason(exit)).toBe("unsupported-output")
  expect(resolveCalls.at(-1)).toBe(key(switchedSession))
}))

it.effect("an unset decision helper inherits the current session model before and after a session model switch", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_inherit_switch", { session: sessionModel })
  config.helper = undefined
  const first = yield* yolo(sessionID)
  expect(first.response.model).toEqual(sessionModel)
  const database = yield* Database.Service
  yield* database.db.update(SessionTable).set({ model: switchedSession }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  const second = yield* yolo(sessionID)
  expect(second.response.model).toEqual(switchedSession)
  expect(sent()).toEqual([sessionModel.id, switchedSession.id])
  expect(resolveCalls).toEqual([key(sessionModel), key(switchedSession)])
}))

it.effect("the model key follows the actual purpose and authority candidate chain", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_key", { yolo: yoloPin, decision: decisionPin })
  const agent = yield* DecisionAgent.Service
  const yoloContext = { sessionID, purpose: "answer" as const, authority: "yolo" as const }
  const baselineContext = { sessionID, purpose: "permission" as const, authority: "baseline" as const }
  const first = yield* agent.modelKey(yoloContext)
  expect(yield* agent.modelKey(yoloContext)).toBe(first)
  const base = yield* agent.modelKey(baselineContext)
  expect(base).not.toBe(first)
  config.helper = ref("openai", "other-helper")
  expect(yield* agent.modelKey(yoloContext)).not.toBe(first)
  expect(yield* agent.modelKey(baselineContext)).toBe(base)
  modes.set(key(yoloPin), "missing")
  expect(yield* agent.modelKey(yoloContext)).not.toBe(first)
  expect(yield* agent.modelKey(baselineContext)).toBe(base)
}))

it.effect("an interruption between candidates records one cancelled audit and settles every started request", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_interrupt", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["malformed", "hold"])
  const seenAudits = yield* audits
  const ledger = yield* SessionProviderRequest.Service
  const fiber = yield* yolo(sessionID).pipe(Effect.forkChild)
  yield* Deferred.await(hold.entered)
  yield* Fiber.interrupt(fiber)
  expect(sent()).toEqual(["yolo-pin", "yolo-pin"])
  expect(seenAudits).toEqual([expect.objectContaining({ outcome: "cancelled", attempts: 2 })])
  expect(seenAudits[0]).not.toHaveProperty("reason")
  expect(yield* ledger.list(sessionID)).toHaveLength(2)
}))

it.effect("usage aggregates across candidates while each request records its own model", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_usage", { yolo: yoloPin, decision: decisionPin })
  plans.set("yolo-pin", ["malformed", "malformed"])
  const ledger = yield* SessionProviderRequest.Service
  const result = yield* yolo(sessionID)
  expect(result.response.usage).toMatchObject({ input: 36, output: 9, reasoning: 6 })
  expect((yield* ledger.list(sessionID)).map((row) => row.model)).toEqual([yoloPin, yoloPin, decisionPin])
}))

it.effect("computing the model key resolves every candidate without credential refresh while evaluation keeps normal resolution", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_key_readonly", { yolo: yoloPin, decision: decisionPin })
  const agent = yield* DecisionAgent.Service
  yield* agent.modelKey({ sessionID, purpose: "answer", authority: "yolo" })
  expect(resolveCalls).toEqual([key(yoloPin), key(decisionPin), key(helper), key(sessionModel)])
  expect(resolveOptions).toEqual([{ refresh: false }, { refresh: false }, { refresh: false }, { refresh: false }])
  resolveOptions.length = 0
  yield* agent.modelKey({ sessionID, purpose: "permission", authority: "baseline" })
  expect(resolveOptions).toEqual([{ refresh: false }])
  resolveOptions.length = 0
  yield* yolo(sessionID)
  expect(resolveOptions).toEqual([undefined])
}))

it.effect("an evaluation shares the start time it is given so earlier work counts against its single deadline", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_recovery_shared_deadline", { yolo: yoloPin })
  plans.set("yolo-pin", ["hold", "hold"])
  const agent = yield* DecisionAgent.Service
  const fiber = yield* agent.evaluate(input().request, { sessionID, purpose: "answer", authority: "yolo", startedAt: -59_000 }).pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(hold.entered)
  yield* TestClock.adjust("2 seconds")
  const exit = yield* Fiber.join(fiber)
  expect(failureReason(exit)).toBe("timeout")
  expect(sent()).toEqual(["yolo-pin"])
}))
