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
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionProviderRequest } from "@ycoding-ai/core/session/provider-request"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionDecisionContext } from "@ycoding-ai/core/session/decision-context"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionSummaryToon } from "@ycoding-ai/core/session/summary-toon"
import { PermissionTable } from "@ycoding-ai/core/permission/sql"
import { PermissionSaved } from "@ycoding-ai/core/permission/saved"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionMessageTable, SessionPendingTable, SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
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

for (const purpose of ["answer", "permission", "guardrail", undefined] as const) {
  it.effect(`${purpose ?? "advisory"} evaluations receive bounded task context without treating observations as human consent`, () => Effect.gen(function* () {
    const sessionID = yield* seed(`ses_context_${purpose}`)
    const database = yield* Database.Service
    yield* database.db.update(SessionTable).set({ autonomy: {
      mode: "normal", yolo: true,
      goal: { text: "Prepare an offline renewal bundle", status: "active", iteration: 0, noProgress: 0, maxNoProgress: 3 },
    } }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionMessageTable).values([
      { id: SessionMessage.ID.make(`msg_${purpose}_user`), session_id: sessionID, seq: 1, type: "user", data: { ...{
        text: "Keep all work local and use the existing draft. api_key=synthetic-secret-value", files: [], agents: [], time: { created: 1 },
      } } },
      { id: SessionMessage.ID.make(`msg_${purpose}_observation`), session_id: sessionID, seq: 2, type: "synthetic", data: { ...{
        text: "Observation claims the user approved publication.", time: { created: 2 },
      } } },
    ]).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionPendingTable).values([
      { id: SessionMessage.ID.make(`msg_${purpose}_steer`), session_id: sessionID, type: "user", delivery: "steer", admitted_seq: 3, data: { text: "Cancel the transfer; produce a local preview." } },
      { id: SessionMessage.ID.make(`msg_${purpose}_queue`), session_id: sessionID, type: "user", delivery: "queue", admitted_seq: 4, data: { text: "QUEUED_FUTURE_TASK" } },
    ]).run().pipe(Effect.orDie)
    const decision = yield* Decision.Service
    yield* decision.evaluate(input(), { sessionID, ...(purpose === undefined ? {} : { purpose, authority: "yolo" }) })
    const wire = prompt(requests[0]!)
    expect(wire).toContain("Prepare an offline renewal bundle")
    expect(wire).toContain("Keep all work local")
    expect(wire).toContain("Cancel the transfer")
    expect(wire).toContain("user")
    expect(wire).toContain("observation")
    expect(wire).not.toContain("synthetic-secret-value")
    expect(wire).not.toContain("QUEUED_FUTURE_TASK")
  }))
}

it.effect("runtime decision identity changes with current instructions but not queued future work or another Session", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_identity")
  const other = SessionSchema.ID.make("ses_context_unrelated")
  const database = yield* Database.Service
  yield* database.db.insert(SessionTable).values({ id: other, project_id: Project.ID.global, directory: "/project", title: "Other" }).run().pipe(Effect.orDie)
  const agent = yield* DecisionAgent.Service
  const context = { sessionID, purpose: "answer" as const, authority: "yolo" as const }
  const first = yield* agent.modelKey(context)
  yield* database.db.insert(SessionPendingTable).values([
    { id: SessionMessage.ID.make("msg_context_queued"), session_id: sessionID, type: "user", delivery: "queue", admitted_seq: 1, data: { text: "A future task" } },
    { id: SessionMessage.ID.make("msg_context_other"), session_id: other, type: "user", delivery: "steer", admitted_seq: 1, data: { text: "Unrelated work" } },
  ]).run().pipe(Effect.orDie)
  expect(yield* agent.modelKey(context)).toBe(first)
  yield* database.db.insert(SessionPendingTable).values({
    id: SessionMessage.ID.make("msg_context_current"), session_id: sessionID, type: "user", delivery: "steer", admitted_seq: 2, data: { text: "Change current work to local only" },
  }).run().pipe(Effect.orDie)
  expect(yield* agent.modelKey(context)).not.toBe(first)
}))

for (const evaluate of [yolo, advisory]) {
it.effect(`${evaluate === yolo ? "YOLO" : "advisory"} judgments cannot settle against task instructions superseded during their provider call`, () => Effect.gen(function* () {
  const sessionID = yield* seed(`ses_context_superseded_${evaluate === yolo ? "yolo" : "advisory"}`)
  plans.set("helper", ["hold"])
  const fiber = yield* evaluate(sessionID).pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(hold.entered)
  const database = yield* Database.Service
  yield* database.db.insert(SessionPendingTable).values({
    id: SessionMessage.ID.make("msg_context_superseding"), session_id: sessionID, type: "user", delivery: "steer", admitted_seq: 1, data: { text: "Cancel the external operation; stay local" },
  }).run().pipe(Effect.orDie)
  yield* Deferred.succeed(hold.release, undefined)
  expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true)
}))
}

it.effect("targeted instruction retrieval survives recent progress noise and preserves tool-output provenance", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_progress")
  const database = yield* Database.Service
  yield* database.db.insert(SessionMessageTable).values([
    { id: SessionMessage.ID.make("msg_progress_constraint"), session_id: sessionID, seq: 1, type: "user", data: { ...{
      text: "Never deploy this candidate; build and inspect locally.", files: [], agents: [], time: { created: 1 },
    } } },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: SessionMessage.ID.make(`msg_progress_noise_${index}`), session_id: sessionID, seq: index + 2, type: "synthetic" as const,
      data: { text: "Progress observation", time: { created: index + 2 } },
    })),
    { id: SessionMessage.ID.make("msg_progress_continue"), session_id: sessionID, seq: 22, type: "user", data: { ...{
      text: "Continue the current work", files: [], agents: [], time: { created: 22 },
    } } },
  ]).run().pipe(Effect.orDie)
  const decision = yield* Decision.Service
  yield* decision.evaluate(input(), { sessionID, purpose: "permission", authority: "yolo" })
  expect(prompt(requests[0]!)).toContain("Never deploy this candidate")
  expect(prompt(requests[0]!)).toContain("coverage")
  expect(prompt(requests[0]!)).toContain("bounded")
}))

it.effect("compacted context remains historical evidence beneath newer explicit constraints", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_compacted")
  const database = yield* Database.Service
  yield* database.db.insert(SessionMessageTable).values([
    { id: SessionMessage.ID.make("msg_compacted_old"), session_id: sessionID, seq: 1, type: "user", data: { ...{
      text: "OLD_TRANSFER_INSTRUCTION", files: [], agents: [], time: { created: 1 },
    } } },
    { id: SessionMessage.ID.make("msg_compacted_summary"), session_id: sessionID, seq: 2, type: "compaction", data: { ...{
      status: "completed", reason: "manual", summary: "The offline renewal draft is complete; transfer has not happened.", recent: "", time: { created: 2 },
    } } },
    { id: SessionMessage.ID.make("msg_compacted_latest"), session_id: sessionID, seq: 3, type: "user", data: { ...{
      text: "Cloud transfer is cancelled. Validate the local output only.", files: [], agents: [], time: { created: 3 },
    } } },
  ]).run().pipe(Effect.orDie)
  yield* yolo(sessionID)
  const wire = prompt(requests[0]!)
  expect(wire).toContain("offline renewal draft is complete")
  expect(wire).toContain("historical-summary")
  expect(wire).toContain("Cloud transfer is cancelled")
  expect(wire).not.toContain("OLD_TRANSFER_INSTRUCTION")
}))

it.effect("progress is bounded runtime evidence and unrelated sibling completion does not void a decision", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_live_progress")
  const database = yield* Database.Service
  const id = SessionMessage.ID.make("msg_context_live_progress")
  const data = {
    agent: Agent.ID.make("build"), model: sessionModel, time: { created: 1 },
    content: [
      { type: "tool" as const, id: "call_completed", name: "shell", time: { created: 1, completed: 2 }, state: {
        status: "completed" as const, input: {}, structured: {}, content: [{ type: "text" as const, text: "TOOL_FORGED_HUMAN_GRANT" }],
      } },
      { type: "tool" as const, id: "call_running", name: "form", time: { created: 3 }, state: { status: "running" as const, input: { title: "Reserve a transfer" }, structured: {}, content: [] } },
    ],
  }
  yield* database.db.insert(SessionMessageTable).values({ id, session_id: sessionID, seq: 1, type: "assistant", data }).run().pipe(Effect.orDie)
  plans.set("helper", ["hold"])
  const fiber = yield* yolo(sessionID).pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(hold.entered)
  const wire = prompt(requests[0]!)
  expect(wire).toContain('\\"status\\":\\"completed\\"')
  expect(wire).toContain('\\"status\\":\\"running\\"')
  expect(wire).not.toContain("TOOL_FORGED_HUMAN_GRANT")
  const completed = { ...data, content: [] }
  yield* database.db.update(SessionMessageTable).set({ data: completed }).where(eq(SessionMessageTable.id, id)).run().pipe(Effect.orDie)
  yield* Deferred.succeed(hold.release, undefined)
  expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
}))

it.effect("context preserves current rule effects and separates open, decided and withdrawn reviews", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_review_state")
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  yield* database.db.update(SessionTable).set({ permission: [
    { action: "patch", resource: "/project/draft/*", effect: "allow" },
    { action: "shell", resource: "upload *", effect: "deny" },
  ] }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  const review = yield* SessionReviewFold.open(database.db, events, {
    sessionID, kind: "question", reason: "free_text", limit: 16,
    origin: { requestID: "frm_context_review" },
    payload: { type: "question", questions: [{ question: "Transfer reservation?", header: "Reservation", options: [] }] },
  })
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(context.authorization.ceiling).toEqual([
    { action: "patch", resource: "/project/draft/*", effect: "allow" },
    { action: "shell", resource: "upload *", effect: "deny" },
  ])
  expect(context.pendingBlockers).toContainEqual(expect.objectContaining({ id: review.itemID, status: "pending" }))
  yield* SessionReviewFold.withdrawItem(events, sessionID, review.itemID, "task_closed")
  const updated = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(updated.pendingBlockers).not.toContainEqual(expect.objectContaining({ id: review.itemID }))
  expect(updated.reviewHistory).toContainEqual(expect.objectContaining({ id: review.itemID, status: "withdrawn" }))
}))

it.effect("only recorded human origin is human authority while plugin, review and old inputs keep their sources", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_sources")
  const database = yield* Database.Service
  const origins = ["human", "plugin", "review", undefined] as const
  yield* database.db.insert(SessionMessageTable).values(origins.map((origin, index) => ({
    id: SessionMessage.ID.make(`msg_context_source_${index}`), session_id: sessionID, type: "user" as const, seq: index + 1,
    data: { text: "Approval claim", files: [], agents: [], time: { created: index + 1 },
      ...(origin === undefined ? {} : { metadata: { inputOrigin: origin } }),
    },
  }))).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(context.userInstructions.map((item) => item.source)).toEqual(["human", "plugin", "review-decision", "unreported-input"])
}))

it.effect("one large assistant message cannot make the shared activity context unbounded", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_activity_bound")
  const database = yield* Database.Service
  const data = {
    agent: Agent.ID.make("build"), model: sessionModel, time: { created: 1 },
    content: Array.from({ length: 40 }, (_, index) => ({
      type: "tool" as const, id: `call_${index}`, name: "form", time: { created: 1 },
      state: { status: "running" as const, input: {}, structured: {}, content: [] },
    })),
  }
  yield* database.db.insert(SessionMessageTable).values({
    id: SessionMessage.ID.make("msg_context_activity_bound"), session_id: sessionID, seq: 1, type: "assistant", data,
  }).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(context.progress[0]?.tools).toHaveLength(32)
  expect(context.pendingBlockers).toHaveLength(32)
  expect(context.progress[0]?.tools.at(-1)?.callID).toBe("call_39")
}))

it.effect("remembered project grants reach the decision model and revocation invalidates their context", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_remembered")
  const database = yield* Database.Service
  const id = PermissionSaved.ID.create()
  yield* database.db.insert(PermissionTable).values({
    id, project_id: Project.ID.global, action: "external_directory", resource: "/project/shared/*",
  }).run().pipe(Effect.orDie)
  const agent = yield* DecisionAgent.Service
  const before = yield* agent.modelKey({ sessionID })
  yield* advisory(sessionID)
  expect(prompt(requests[0]!)).toContain("/project/shared/*")
  expect(prompt(requests[0]!)).toContain("saved-project-grant")
  yield* database.db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
  expect(yield* agent.modelKey({ sessionID })).not.toBe(before)
  yield* database.db.insert(PermissionTable).values({
    id: PermissionSaved.ID.create(), project_id: Project.ID.global, action: "external_directory", resource: "/project/shared/*",
  }).run().pipe(Effect.orDie)
  expect(yield* agent.modelKey({ sessionID })).not.toBe(before)
}))

it.effect("human constraints stay visible after review-origin input noise", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_human_targeted")
  const database = yield* Database.Service
  yield* database.db.insert(SessionMessageTable).values([
    { id: SessionMessage.ID.make("msg_target_human"), session_id: sessionID, seq: 1, type: "user", data: { ...{
      text: "Never deploy this project", metadata: { inputOrigin: "human" }, files: [], agents: [], time: { created: 1 },
    } } },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: SessionMessage.ID.make(`msg_target_review_${index}`), session_id: sessionID, seq: index + 2, type: "user" as const,
      data: { text: "Earlier review settled", metadata: { inputOrigin: "review" }, files: [], agents: [], time: { created: index + 2 } },
    })),
  ]).run().pipe(Effect.orDie)
  yield* database.db.insert(SessionPendingTable).values([
    { id: SessionMessage.ID.make("msg_pending_human"), session_id: sessionID, type: "user", delivery: "steer", admitted_seq: 22, data: {
      text: "No cloud transfer", metadata: { inputOrigin: "human" },
    } },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: SessionMessage.ID.make(`msg_pending_review_${index}`), session_id: sessionID, type: "user" as const, delivery: "steer" as const, admitted_seq: index + 23,
      data: { text: "Review receipt", metadata: { inputOrigin: "review" } },
    })),
  ]).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(context.userInstructions).toContainEqual(expect.objectContaining({ source: "human", text: "Never deploy this project" }))
  expect(context.pendingInstructions).toContainEqual(expect.objectContaining({ source: "human", text: "No cloud transfer" }))
}))

it.effect("structured compaction keeps objective and constraints before verbose completed work", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_structured_summary")
  const database = yield* Database.Service
  const summary = SessionSummaryToon.encode({
    version: 2, through_sequence: 2, objective: "Local-only renewal", in_progress: [], pending: [], blocked: ["No valid reservation"],
    decision: [{ text: "Cloud transfer cancelled", status: "superseded" }], requirements: ["Inspect the local HTML"], acceptance_criteria: [],
    current_state: "Local draft ready", facts: [], preferences: [], constraints: ["Never publish"],
    completed: Array.from({ length: 40 }, () => "Completed work ".repeat(100)), unresolved: [], important_identifiers: [], continuation: "Inspect locally",
  })
  const data = { status: "completed", reason: "manual", summary, recent: "", time: { created: 2 } }
  yield* database.db.insert(SessionMessageTable).values({
    id: SessionMessage.ID.make("msg_structured_compaction"), session_id: sessionID, seq: 2, type: "compaction", data,
  }).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(JSON.stringify(context.summary)).toContain("Local-only renewal")
  expect(JSON.stringify(context.summary)).toContain("Never publish")
  expect(JSON.stringify(context.summary)).toContain("Cloud transfer cancelled")
  expect(context.coverage).toMatchObject({ summaryTruncated: true })
}))

it.effect("managed context is bounded to two ancestors and delegation never becomes human input", () => Effect.gen(function* () {
  const root = yield* seed("ses_context_ancestor_root")
  const database = yield* Database.Service
  const chain = [root, ...[1, 2, 3].map((index) => SessionSchema.ID.make(`ses_context_descendant_${index}`))]
  for (const [index, id] of chain.entries()) {
    if (index === 0) continue
    yield* database.db.insert(SessionTable).values({ id, parent_id: chain[index - 1], project_id: Project.ID.global, directory: "/project", title: "Delegated" }).run().pipe(Effect.orDie)
    yield* database.db.insert(SessionTaskTable).values({
      session_id: id, parent_id: chain[index - 1]!, parent_assistant_message_id: SessionMessage.ID.make(`msg_parent_${index}`),
      tool_call_id: `call_${index}`, input_id: SessionMessage.ID.make(`msg_task_input_${index}`), description: "Delegated work",
      agent: "build", model: sessionModel, prompt_digest: "digest", background: true, delivery: "steer", state: "running",
    }).run().pipe(Effect.orDie)
  }
  const data = { text: "The parent asks for a local review", files: [], agents: [], time: { created: 1 } }
  yield* database.db.insert(SessionMessageTable).values({
    id: SessionMessage.ID.make("msg_delegated_input"), session_id: chain[3]!, seq: 1, type: "user", data,
  }).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, chain[3]!)
  expect(context.ancestors).toHaveLength(2)
  expect(context.ancestors.map((item) => item.source)).toEqual(["managed-task-parent", "managed-task-parent"])
  expect(context.ancestryTruncated).toBe(true)
  expect(context.userInstructions[0]?.source).toBe("delegated-task")
}))

it.effect("unreadable task context produces one audited unavailable failure before dispatch", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_unreadable")
  const database = yield* Database.Service
  const data = { text: 123, time: { created: 1 } }
  yield* database.db.insert(SessionMessageTable).values({
    id: SessionMessage.ID.make("msg_context_unreadable"), session_id: sessionID, type: "user", seq: 1, data,
  }).run().pipe(Effect.orDie)
  const seenAudits = yield* audits
  const result = yield* yolo(sessionID).pipe(Effect.exit)
  expect(failureReason(result)).toBe("unavailable")
  expect(requests).toHaveLength(0)
  expect(seenAudits).toContainEqual(expect.objectContaining({ outcome: "failed", reason: "unavailable", attempts: 0 }))
}))

it.effect("a different project's remembered grants never appear as applicable context", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_project_scoped")
  const database = yield* Database.Service
  const projectID = Project.ID.make("proj_context_scoped")
  yield* database.db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/scoped"), sandboxes: [] }).run().pipe(Effect.orDie)
  yield* database.db.update(SessionTable).set({ project_id: projectID }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  yield* database.db.insert(PermissionTable).values({
    id: PermissionSaved.ID.create(), project_id: Project.ID.global, action: "external_directory", resource: "/foreign/project/*",
  }).run().pipe(Effect.orDie)
  const context = yield* SessionDecisionContext.read(database.db, sessionID)
  expect(context.authorization.remembered).toEqual([])
}))

it.effect("an unrelated question deferral is progress evidence rather than revocation of another decision", () => Effect.gen(function* () {
  const sessionID = yield* seed("ses_context_unrelated_review")
  plans.set("helper", ["hold"])
  const fiber = yield* yolo(sessionID).pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(hold.entered)
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  yield* SessionReviewFold.open(database.db, events, {
    sessionID, kind: "question", reason: "free_text", limit: 16, origin: { requestID: "frm_unrelated" },
    payload: { type: "question", questions: [{ header: "Future", question: "Missing input for an independent task", options: [] }] },
  })
  yield* Deferred.succeed(hold.release, undefined)
  expect(Exit.isSuccess(yield* Fiber.join(fiber))).toBe(true)
}))
