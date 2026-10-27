import { describe, expect } from "bun:test"
import { tmpdir } from "node:os"
import { Cause, Deferred, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsRuntime } from "../src/dots"
import { DotsPeer } from "../src/dots/peer"
import { EventTable } from "../src/event/sql"
import { eq } from "drizzle-orm"
import { Agent } from "../src/agent"
import { Model } from "@ycoding-ai/schema/model"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { CoordinationService } from "../src/coordination/index"
import { Database } from "../src/database/database"
import { DotsExchange } from "../src/dots/exchange"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { memory, update } from "../src/session/message-updater"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionPending } from "../src/session/pending"
import { Permission } from "../src/permission"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Question as QuestionSchema } from "@ycoding-ai/schema/question"
import { Decision } from "../src/decision"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { SessionMcpEvents } from "../src/mcp-events/index"
import { location } from "./fixture/location"
import { Form } from "../src/form"
import { Question } from "../src/question"
import { SessionGuardrail } from "../src/session/guardrail"
import { SessionAutonomy } from "../src/session/autonomy"
import { SessionProjector } from "../src/session/projector"
import { SessionProviderRequestTable } from "../src/session/sql"
import { SessionReview } from "../src/session/review"
import { QuestionID, type Task } from "@ycoding-ai/schema/session-orchestration"
import type { Item } from "@ycoding-ai/schema/session-review"
import { testEffect } from "./lib/effect"

const wakes: Session.ID[] = []
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.succeed(new Set<Session.ID>()),
  wake: () => Effect.void,
  interrupt: () => Effect.void,
})
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventRuntime.node, SessionProjector.node, Session.node,
  SessionExecution.node, SessionOrchestration.node, CoordinationService.node, SessionAutonomy.node,
  Permission.node, SessionGuardrail.node, Form.node, Question.node, Agent.node,
  Location.node, LocationServiceMap.node, SessionReview.node,
]), [
  [SessionExecution.node, execution],
  [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmpdir()) })))],
  [Decision.node, Layer.mock(Decision.Service, { evaluate: () => Effect.fail(new Decision.Error({ reason: "unavailable" })) })],
]))

const source = {
  requestID: "request_fixture", epoch: "epoch_fixture",
  principal: { ownerID: "owner_fixture", deviceID: "device_fixture", clientID: "client_fixture" },
}
const target = { profile: "fixture", dotID: "dot_fixture", threadID: "thread_fixture", generation: "generation_fixture", label: "V" }

const setup = Effect.gen(function* () {
  wakes.length = 0
  const sessions = yield* Session.Service
  const db = (yield* Database.Service).db
  const events = yield* EventRuntime.Service
  const coordination = yield* CoordinationService.Service
  const realPermission = yield* Permission.Service
  const realGuardrail = yield* SessionGuardrail.Service
  const realForms = yield* Form.Service
  const realQuestions = yield* Question.Service
  const agents = yield* Agent.Service
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "Master" })
  const alpha = yield* sessions.create({ location, title: "Alpha" })
  const beta = yield* sessions.create({ location, title: "Beta" })
  const outsider = yield* sessions.create({ location, title: "Outside" })
  const group = yield* coordination.create({ name: "Fixture", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  yield* coordination.activate(group.id)
  const attachment = { target, accountDigest: "a".repeat(64) }
  const authorization = { enabled: true, calls: 0, grantID: "grant_fixture" }
  const authority: DotsRuntime.BindingAuthority = { incarnation: "binding_fixture", target, accountDigest: attachment.accountDigest, grants: new Map(), proposals: new Map() }
  const binding: { current: DotsRuntime.BindingAuthority | undefined } = { current: authority }
  const authorities = new Map<string, DotsRuntime.BindingAuthority>()
  const writer = Semaphore.makeUnsafe(1)
  const approval = { calls: [] as unknown[], enabled: true, wait: undefined as Effect.Effect<void> | undefined }
  const clock = { now: Date.now() }
  const decisionFake = { pending: [] as DotsExchange.PendingDecision[], settled: [] as unknown[], denied: new Set<string>(), defect: false, fail: false, unavailable: false }
  const hooks: { attachment?: () => void; message?: () => void; wake?: () => void; authorize?: () => Effect.Effect<void>; checkStored?: () => Effect.Effect<void> } = {}
  const build = (decisions: DotsExchange.Options["decisions"]) => DotsExchange.make({
    db, events, sessions: { get: sessions.get, message: (input) => sessions.message(input).pipe(Effect.tap(() => Effect.sync(() => hooks.message?.()))) }, coordination,
    execution: { active: Effect.succeed(new Set<Session.ID>()), wake: (id) => Effect.sync(() => { wakes.push(id); hooks.wake?.() }) },
    attachment: () => Effect.sync(() => { hooks.attachment?.(); return attachment }),
    withBinding: (id, use) => writer.withPermits(1)(Effect.gen(function* () {
      const alternate = id === master.id ? undefined : authorities.get(id) ?? { incarnation: `binding_${id}`, target, accountDigest: attachment.accountDigest, grants: new Map(), proposals: new Map() }
      if (alternate) authorities.set(id, alternate)
      const current = id === master.id ? binding.current : alternate
      if (!current) return yield* new DotsRuntime.Error({ code: "not_bound", message: "Synthetic binding ended" })
      current.target = attachment.target
      current.accountDigest = attachment.accountDigest
      return yield* use(current)
    })),
    approve: (input) => Effect.gen(function* () {
      approval.calls.push(input)
      if (approval.wait) yield* approval.wait
      if (!approval.enabled) return yield* new DotsRuntime.Error({ code: "authorization_failed", message: "Synthetic human rejection" })
    }),
    now: () => clock.now,
    authorize: (context) => Effect.suspend(() => hooks.authorize?.() ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => {
      authorization.calls++
      if (!authorization.enabled || context.epoch !== source.epoch || context.principal.deviceID !== source.principal.deviceID)
        throw new Error("Unauthorized synthetic invocation")
      return { ...context.principal, epoch: context.epoch, grantID: authorization.grantID }
    }))),
    checkStored: (principal) => Effect.suspend(() => hooks.checkStored?.() ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => {
      if (!authorization.enabled || principal.grantID !== authorization.grantID) throw new Error("Revoked synthetic grant")
      return { expiresAt: clock.now + 10_000_000 }
    }))),
    decisions,
  })
  const fakeDecisions: DotsExchange.Options["decisions"] = {
    pending: (sessionID) => Effect.suspend(() => decisionFake.unavailable ? Effect.fail(new Error("Synthetic pending inventory unavailable")) : Effect.succeed(decisionFake.pending.filter((item) => item.sessionID === sessionID))),
    permissionEffect: (_sessionID, action, resource) => Effect.sync(() => decisionFake.denied.has(`${action}\0${resource}`) ? "deny" as const : "ask" as const),
    settle: (input) => Effect.gen(function* () {
      if (decisionFake.fail) throw new Error("Synthetic settlement failure")
      const index = decisionFake.pending.indexOf(input.pending)
      if (index === -1) throw new Error("Synthetic pending request settled twice")
      if (!(yield* input.validate())) throw new Error("Synthetic live authorization revoked")
      decisionFake.pending.splice(index, 1)
      decisionFake.settled.push(input)
      const pending = input.pending
      const target = pending.kind === "form"
        ? { kind: "form" as const, formID: Form.ID.make(pending.formID), fingerprint: pending.fingerprint }
        : pending.kind === "guardrail"
          ? { kind: "guardrail" as const, requestID: Guardrail.RequestID.make(pending.requestID), fingerprint: pending.fingerprint }
          : pending.kind === "question"
            ? { kind: "question" as const, requestID: QuestionSchema.ID.make(pending.requestID), fingerprint: pending.fingerprint }
            : pending.kind === "permission" ? { kind: "permission" as const, requestID: Permission.ID.create(pending.requestID), fingerprint: pending.fingerprint }
              : pending.kind === "subagent_question" ? { kind: "subagent_question" as const, questionID: pending.task.question!.id, fingerprint: pending.fingerprint }
                : { kind: "review" as const, itemID: pending.item.itemID, fingerprint: pending.fingerprint }
      yield* events.publish(SessionEvent.DotsDecisionSettled, { sessionID: pending.sessionID, source: input.source, target, ...("reply" in input.choice ? { reply: input.choice.reply } : {}) })
      if (decisionFake.defect) return yield* Effect.die(new Error("Synthetic settlement defect"))
    }),
  }
  const make = () => build(fakeDecisions)
  const makeReal = () => build(DotsExchange.decisionServices({ permission: realPermission, guardrail: realGuardrail, forms: realForms, questions: realQuestions }))
  const runtime = make()
  const create = (exchangeID: string, targetSessionID = alpha.id, text = "Investigate the synthetic module") => runtime.create({
    sessionID: master.id, remoteSource: source, exchangeID, targetSessionID,
    expectedAttachment: target, channel: "task", delivery: "queue", text,
  })
  const read = (exchangeID: string) => runtime.read({ sessionID: master.id, exchangeID, remoteSource: source })
  return { sessions, db, events, coordination, master, alpha, beta, outsider, group, attachment, authorization, hooks, make, makeReal, runtime, create, read, authority, binding, approval, clock, decisionFake, realPermission, realGuardrail, realForms, realQuestions, agents }
})

const delegated = Effect.gen(function* () {
  const f = yield* setup
  const task = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Implement the synthetic local task", resume: false })
  yield* f.create("source")
  yield* SessionPending.promoteSteers(f.db, f.events, f.alpha.id)
  yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id)
  const proposal = {
    sessionID: f.master.id, proposalID: "native_proposal", sourceExchangeID: "source", targetSessionID: f.alpha.id,
    taskInputID: task.id, expectedAttachment: target, expiresAt: f.clock.now + 3_600_000,
    scope: { operations: ["continue", "presentation"], format: ["prose", "bullets"], detail: ["concise", "standard", "detailed"] } as const,
  }
  const grant = yield* f.runtime.delegationCreate(proposal)
  const input = {
    sessionID: f.master.id, remoteSource: source, exchangeID: "routine", targetSessionID: f.alpha.id,
    expectedAttachment: target, channel: "task" as const, delivery: "queue" as const,
    delegation: { id: grant.id, revision: grant.revision }, taskInputID: task.id, instruction: { operation: "continue" as const },
  }
  return { ...f, task, proposal, grant, input }
})

describe("authenticated device delegation", () => {
  it.live("authorization events leave chat messages unchanged", () => Effect.gen(function* () {
    const f = yield* setup
    const state = { messages: [] as SessionMessage.Info[] }
    const adapter = memory(state)
    const principal = { ...source.principal, epoch: source.epoch, grantID: "grant_fixture" }
    const events = [
      yield* f.events.publish(Dots.BindingBound, { sessionID: f.master.id, binding: { id: f.authority.incarnation, target, accountDigest: f.authority.accountDigest } }),
      yield* f.events.publish(Dots.DeviceDelegationCreated, { sessionID: f.master.id, exchangeID: "projection_enroll", fingerprint: "a".repeat(64), grant: {
        id: "projection_grant", revision: 1, basis: "device", anchorSessionID: f.master.id, bindingID: f.authority.incarnation, principal,
        scope: { target: "device", operations: ["task", "decision"] }, expiresAt: f.clock.now + 60_000, active: true,
      } }),
      yield* f.events.publish(Dots.DeviceDelegationRevoked, { sessionID: f.master.id, exchangeID: "projection_revoke", fingerprint: "b".repeat(64), delegationID: "projection_grant", revision: 2, principal }),
      yield* f.events.publish(Dots.BindingUnbound, { sessionID: f.master.id, bindingID: f.authority.incarnation }),
    ]
    for (const event of events) yield* update(adapter, event)
    expect(state.messages).toEqual([])
  }))
  const enrolled = Effect.gen(function* () {
    const f = yield* setup
    yield* f.events.publish(Dots.BindingBound, { sessionID: f.master.id, binding: { id: f.authority.incarnation, target, accountDigest: f.authority.accountDigest } })
    const status = yield* f.runtime.deviceDelegationRead({ sessionID: f.master.id, remoteSource: source })
    const enrollment = { sessionID: f.master.id, remoteSource: source, id: "device_grant", exchangeID: "device_enroll", bindingID: status.binding.id, expectedAttachment: target, scope: { target: "device", operations: ["task", "decision"] } as const }
    const grant = yield* f.runtime.deviceDelegationCreate(enrollment)
    const list = { sessionID: f.master.id, remoteSource: source, bindingID: status.binding.id, expectedAttachment: target, delegation: { id: grant.id, revision: grant.revision } }
    const task = { sessionID: f.master.id, remoteSource: source, expectedAttachment: target, delegation: list.delegation, targetSessionID: f.alpha.id, exchangeID: "device_task", channel: "task", delivery: "queue", instruction: { operation: "task", text: "Inspect a synthetic device task" } } as const
    return { ...f, grant, enrollment, list, task }
  })
  const composed = Effect.gen(function* () {
    const f = yield* enrolled
    const runtime = yield* DotsExchange.service.pipe(
      Effect.provide(Layer.mock(DotsRuntime.Service, {
        attachment: () => Effect.succeed(f.attachment),
        withBinding: (_sessionID, use) => use(f.authority),
      })),
      Effect.provideService(SessionMcpEvents.Authorization.Service, {
        capabilities: Effect.succeed(true),
        resolve: () => Effect.succeed({ grantID: f.grant.principal.grantID, expiresAt: f.grant.expiresAt }),
        check: () => Effect.succeed({ expiresAt: f.grant.expiresAt }),
      }),
    )
    return { ...f, runtime }
  })
  it.live("discovers the binding and enrolls without a human task or human approval through OAuth expiry", () => Effect.gen(function* () {
    const f = yield* enrolled
    expect(f.approval.calls).toEqual([])
    expect(f.grant.expiresAt).toBe(f.clock.now + 10_000_000)
    expect(f.grant.principal).toEqual({ ...source.principal, epoch: source.epoch, grantID: "grant_fixture" })
    expect((yield* f.runtime.deviceDelegationCreate(f.enrollment))).toEqual(f.grant)
    expect((yield* f.runtime.deviceDelegationCreate({ ...f.enrollment, scope: { target: "device", operations: ["task"] } }).pipe(Effect.exit))._tag).toBe("Failure")
    const restarted = f.make()
    expect((yield* restarted.deviceDelegationRead({ sessionID: f.master.id, remoteSource: source })).grants).toEqual([f.grant])
    yield* restarted.create(f.task)
    yield* restarted.create({ ...f.task, targetSessionID: f.outsider.id, exchangeID: "device_outside_project" })
    expect((yield* SessionPending.list(f.db, f.outsider.id))).toHaveLength(1)
  }))
  it.live("lists native sensitive and hard requests across Sessions and settles one exact decision once", () => Effect.gen(function* () {
    const f = yield* enrolled
    const fingerprint = "f".repeat(64)
    f.decisionFake.pending.push(
      { kind: "permission", sessionID: f.alpha.id, requestID: "per_device", fingerprint, action: "edit", resources: ["synthetic.env"], metadata: { requireExplicitDecision: true } },
      { kind: "guardrail", sessionID: f.beta.id, requestID: "grq_device", fingerprint, action: "shell", resources: ["synthetic custom review"], ruleIDs: ["custom.test"], standard: false, hardReview: true },
    )
    const page = yield* f.runtime.decisionsList({ ...f.list, limit: 1 })
    expect(page.data).toHaveLength(1)
    expect(page.nextCursor).toBeDefined()
    const next = yield* f.runtime.decisionsList({ ...f.list, cursor: page.nextCursor, limit: 1 })
    expect([...page.data, ...next.data].map((entry) => entry.candidate.target.kind).toSorted()).toEqual(["guardrail", "permission"])
    const input = { ...f.task, exchangeID: "device_permission", instruction: { operation: "decision", target: { kind: "permission", requestID: Permission.ID.create("per_device"), fingerprint }, reply: "once" } } as const
    const spoofed = { ...input, explicitDecision: true }
    expect((yield* f.runtime.create(spoofed).pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toEqual([])
    const outcome = yield* f.runtime.create(input)
    expect(outcome.decisionOutcome?.state).toBe("settled")
    yield* f.runtime.create(input)
    expect(f.decisionFake.settled).toHaveLength(1)
    expect(f.decisionFake.settled[0]).toMatchObject({ explicitDecision: true, source: { kind: "dots-client", principal: f.grant.principal, bindingID: f.grant.bindingID, exchangeID: input.exchangeID } })
    expect((yield* f.read(input.exchangeID)).decisionOutcome?.state).toBe("settled")
    expect((yield* f.runtime.create({ ...input, instruction: { ...input.instruction, reply: "reject" } satisfies Dots.DelegatedInstruction }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toHaveLength(1)
    f.decisionFake.unavailable = true
    expect((yield* f.read(input.exchangeID)).decisionOutcome?.state).toBe("settled")
  }))
  it.live("revocation survives rebuilding the exchange service and rejects queued work at promotion", () => Effect.gen(function* () {
    const f = yield* enrolled
    const admitted = yield* f.runtime.create(f.task)
    const revoke = { sessionID: f.master.id, remoteSource: source, id: f.grant.id, revision: f.grant.revision, bindingID: f.grant.bindingID, expectedAttachment: target, exchangeID: "device_revoke" }
    const revoked = yield* f.runtime.deviceDelegationRevoke(revoke)
    expect(revoked.active).toBe(false)
    expect((yield* f.runtime.deviceDelegationRevoke(revoke))).toEqual(revoked)
    const restarted = f.make()
    expect((yield* restarted.deviceDelegationRead({ sessionID: f.master.id, remoteSource: source })).grants[0]?.active).toBe(false)
    expect((yield* restarted.create({ ...f.task, exchangeID: "after_device_revoke" }).pipe(Effect.exit))._tag).toBe("Failure")
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, restarted.promoteRoutine)
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: admitted.inputID })).toBeUndefined()
    expect((yield* f.read(f.task.exchangeID)).state).toBe("failed")
  }))
  it.live("expiry, principal replacement and binding reincarnation cannot inherit device authority", () => Effect.gen(function* () {
    const f = yield* enrolled
    f.clock.now = f.grant.expiresAt
    expect((yield* f.runtime.create(f.task).pipe(Effect.exit))._tag).toBe("Failure")
    f.clock.now--
    f.authorization.grantID = "replacement_grant"
    expect((yield* f.runtime.decisionsList(f.list).pipe(Effect.exit))._tag).toBe("Failure")
    f.authorization.grantID = "grant_fixture"
    f.binding.current = { ...f.authority, incarnation: "replacement_binding" }
    expect((yield* f.runtime.create(f.task).pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toHaveLength(0)
  }))
  it.live("device decisions address a managed child without granting ordinary child task input", () => Effect.gen(function* () {
    const f = yield* enrolled
    const child = yield* f.sessions.create({ parentID: f.alpha.id, title: "Managed child" })
    const fingerprint = "e".repeat(64)
    f.decisionFake.pending.push({ kind: "permission", sessionID: child.id, requestID: "per_child", fingerprint, action: "edit", resources: ["child.ts"], metadata: { requireExplicitDecision: true } })
    const page = yield* f.runtime.decisionsList({ ...f.list, targetSessionID: child.id })
    expect(page.data.map((entry) => entry.targetSessionID)).toEqual([child.id])
    expect((yield* f.runtime.create({ ...f.task, targetSessionID: child.id, exchangeID: "child_task" }).pipe(Effect.exit))._tag).toBe("Failure")
    const decisionTarget = page.data.map((entry) => entry.candidate.target).find((target) => target.kind === "permission")!
    const outcome = yield* f.runtime.create({ ...f.task, targetSessionID: child.id, exchangeID: "child_decision", instruction: { operation: "decision", target: decisionTarget, reply: "once" } satisfies Dots.DelegatedInstruction })
    expect(outcome.decisionOutcome?.state).toBe("settled")
    expect(yield* SessionPending.list(f.db, child.id)).toEqual([])
  }))
  it.live("device scope reaches real explicit permission, hard review, external form and question cancellation", () => Effect.gen(function* () {
    const f = yield* enrolled
    const runtime = f.makeReal()
    const autonomy = yield* SessionAutonomy.Service
    yield* autonomy.set({ sessionID: f.alpha.id, permissions: "manual", guardrails: "manual", answers: "manual" })
    const agent = (yield* f.sessions.get(f.alpha.id)).agent ?? Agent.ID.make("build")
    yield* f.agents.transform((editor) => editor.update(agent, (value) => { value.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
    const waitFor = <A, E>(type: string, effect: Effect.Effect<A, E>) => Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const unsubscribe = yield* f.events.listen((event) => event.type === type ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void)
      const fiber = yield* effect.pipe(Effect.forkScoped)
      yield* Deferred.await(ready).pipe(Effect.timeout("2 seconds"))
      yield* unsubscribe
      return fiber
    })
    const permissionID = Permission.ID.create("per_device_human")
    const permission = yield* waitFor(Permission.Event.Asked.type, f.realPermission.assert({ id: permissionID, sessionID: f.alpha.id, action: "edit", resources: ["synthetic.env"], requireExplicitDecision: true }))
    const requests = yield* runtime.decisionsList({ ...f.list, targetSessionID: f.alpha.id })
    const pendingPermission = requests.data.map((entry) => entry.candidate.target).find((target) => target.kind === "permission")!
    const approved = yield* runtime.create({ ...f.task, exchangeID: "real_device_permission", instruction: { operation: "decision", target: pendingPermission, reply: "once" } satisfies Dots.DelegatedInstruction })
    yield* Fiber.join(permission)
    expect(approved.decisionOutcome?.state).toBe("settled")

    const guardrail = yield* waitFor(Guardrail.Event.Asked.type, f.realGuardrail.assert({ sessionID: f.alpha.id, action: "shell", resources: ["rm -rf ."] }))
    const hard = (yield* runtime.decisionsList({ ...f.list, targetSessionID: f.alpha.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "guardrail")!
    yield* runtime.create({ ...f.task, exchangeID: "real_device_hard", instruction: { operation: "decision", target: hard, reply: "once" } satisfies Dots.DelegatedInstruction })
    yield* (yield* Fiber.join(guardrail)).release

    const formID = Form.ID.create("frm_device_external")
    yield* f.realForms.create({ id: formID, sessionID: f.alpha.id, title: "Synthetic credential setup", fields: [{ type: "external", key: "setup", url: "https://example.invalid/setup" }, { type: "string", key: "api_key", required: true }], metadata: { requireExplicitDecision: true } })
    const form = (yield* runtime.decisionsList({ ...f.list, targetSessionID: f.alpha.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "form")!
    yield* runtime.create({ ...f.task, exchangeID: "real_device_form_cancel", instruction: { operation: "decision", target: form, cancelled: true } satisfies Dots.DelegatedInstruction })
    expect((yield* f.realForms.state(formID)).status).toBe("cancelled")

    const question = yield* waitFor(Question.Event.Asked.type, f.realQuestions.ask({ sessionID: f.alpha.id, questions: [{ question: "Synthetic credential rotation", header: "Choose", options: [] }] }))
    const pendingQuestion = (yield* runtime.decisionsList({ ...f.list, targetSessionID: f.alpha.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "question")!
    yield* runtime.create({ ...f.task, exchangeID: "real_device_question_cancel", instruction: { operation: "decision", target: pendingQuestion, cancelled: true } satisfies Dots.DelegatedInstruction })
    expect(yield* Fiber.join(question).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { _tag: "Question.RejectedError" } })
    expect((yield* runtime.read({ sessionID: f.master.id, remoteSource: source, exchangeID: "real_device_question_cancel" })).decisionOutcome?.state).toBe("settled")
    expect(f.approval.calls).toHaveLength(0)
  }))
  it.live("the native adapter lists child questions and durable reviews and preserves their settlement authority", () => Effect.gen(function* () {
    const f = yield* enrolled
    const child = yield* f.sessions.create({ parentID: f.alpha.id, title: "Waiting child" })
    const task: Task = { sessionID: child.id, parentID: f.alpha.id, description: "Synthetic task", agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }), background: true, state: "waiting", revision: 1, time: { created: 1, updated: 2 }, question: { id: QuestionID.make("qst_device"), text: "Continue?", time: 2 } }
    const review: Item = { itemID: SessionReview.ID.make("rvw_device"), sessionID: child.id, rootSessionID: f.alpha.id, sessionTitle: "Waiting child", created: 2, kind: "recovery", reason: "restart", origin: { requestID: "recovery_device" }, payload: { type: "recovery", tools: [{ messageID: SessionMessage.ID.make("msg_device_uncertain"), callID: "call_device", name: "shell" }] } }
    const calls: unknown[] = []
    const adapter = DotsExchange.decisionServices({ permission: f.realPermission, guardrail: f.realGuardrail, forms: f.realForms, questions: f.realQuestions, sessions: f.sessions,
      orchestration: { questionSnapshots: () => Effect.succeed([{ task, fingerprint: "a".repeat(64) }]), answer: (input) => Effect.sync(() => { calls.push(input); return task }) },
      reviews: { pendingSnapshots: () => Effect.succeed([{ item: review, fingerprint: "b".repeat(64) }]), decideDelegated: (input) => Effect.sync(() => { calls.push(input) }) },
    })
    const pending = yield* adapter.pending(child.id)
    expect(pending.map((item) => item.kind).toSorted()).toEqual(["review", "subagent_question"])
    const source: Form.DotsClientReplySource = { kind: "dots-client", anchorSessionID: f.master.id, bindingID: f.grant.bindingID, delegationID: f.grant.id, revision: 1, exchangeID: "child_control", principal: f.grant.principal }
    const childInput = { pending: pending.find((item) => item.kind === "subagent_question")!, choice: { text: "Synthetic answer", data: { selected: false } }, source, validate: () => Effect.succeed(true) }
    const reviewInput = { pending: pending.find((item) => item.kind === "review")!, choice: { decision: { kind: "recovery" as const, choice: "continue" as const } }, source, validate: () => Effect.succeed(true) }
    expect((yield* adapter.settle(childInput).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* adapter.settle(reviewInput).pipe(Effect.exit))._tag).toBe("Failure")
    expect(calls).toEqual([])
    yield* adapter.settle({ ...childInput, explicitDecision: true })
    yield* adapter.settle({ ...reviewInput, explicitDecision: true })
    expect(calls[0]).toMatchObject({ parentID: f.alpha.id, childID: child.id, questionID: task.question!.id, text: "Synthetic answer", data: { selected: false }, dots: { source, fingerprint: "a".repeat(64), explicitDecision: true } })
    expect(calls[1]).toMatchObject({ sessionID: child.id, itemID: review.itemID, decision: { kind: "recovery", choice: "continue" }, source, fingerprint: "b".repeat(64), explicitDecision: true })
  }))

  it.live("provenance alone cannot supply explicit-decision capability or replace live validation", () => Effect.gen(function* () {
    const f = yield* enrolled
    const adapter = DotsExchange.decisionServices({ permission: f.realPermission, guardrail: f.realGuardrail, forms: f.realForms, questions: f.realQuestions })
    const formID = Form.ID.create("frm_explicit_capability")
    yield* f.realForms.create({ id: formID, sessionID: f.alpha.id, title: "Synthetic account credential choice", fields: [{ type: "string", key: "choice", required: true }], metadata: { requireExplicitDecision: true } })
    const pending = (yield* adapter.pending(f.alpha.id)).find((item) => item.kind === "form" && item.formID === formID)!
    const input = { pending, choice: { answers: { choice: "synthetic" } }, source: { kind: "dots-client" as const, anchorSessionID: f.master.id, bindingID: f.grant.bindingID, delegationID: f.grant.id, revision: 1, exchangeID: "capability_fixture", principal: f.grant.principal }, validate: () => Effect.succeed(true) }
    expect((yield* adapter.settle(input).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.realForms.state(formID)).status).toBe("pending")
    expect((yield* adapter.settle({ ...input, explicitDecision: true, validate: () => Effect.succeed(false) }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.realForms.state(formID)).status).toBe("pending")
    yield* adapter.settle({ ...input, explicitDecision: true })
    expect((yield* f.realForms.state(formID)).status).toBe("answered")
  }))
  it.live("the composed device exchange lists and settles a real form in a second Location", () => Effect.gen(function* () {
    const f = yield* composed
    const directory = yield* Effect.acquireRelease(Effect.promise(async () => {
      const { tmpdir } = await import("./fixture/tmpdir")
      return tmpdir("ycoding-dots-location-")
    }), (value) => Effect.promise(() => value[Symbol.asyncDispose]()))
    const remote = yield* f.sessions.create({ location: { directory: AbsolutePath.make(directory.path) }, title: "Second Location" })
    const locations = yield* LocationServiceMap.Service
    const forms = yield* Form.Service.pipe(Effect.provide(locations.get(remote.location)))
    const formID = Form.ID.create("frm_second_location")
    yield* forms.create({ id: formID, sessionID: remote.id, title: "Synthetic remote choice", fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe" }] }], metadata: { requireExplicitDecision: true } })
    expect((yield* f.realForms.list()).some((item) => item.id === formID)).toBe(false)
    const page = yield* f.runtime.decisionsList({ ...f.list, targetSessionID: remote.id })
    expect(page.data).toHaveLength(1)
    expect(page.data[0]?.targetSessionID).toBe(remote.id)
    const decisionTarget = page.data.map((entry) => entry.candidate.target).find((target) => target.kind === "form")!
    const settled = yield* f.runtime.create({ ...f.task, targetSessionID: remote.id, exchangeID: "second_location_form", instruction: { operation: "decision", target: decisionTarget, answers: { branch: "safe" } } satisfies Dots.DelegatedInstruction })
    expect(settled.decisionOutcome?.state).toBe("settled")
    expect((yield* forms.state(formID)).status).toBe("answered")
    expect((yield* f.realForms.list()).some((item) => item.id === formID)).toBe(false)
  }))
  it.live("the composed child-question exchange commits its receipt with the continuation and resumes once", () => Effect.gen(function* () {
    const f = yield* composed
    const model = Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") })
    const child = yield* f.sessions.create({ parentID: f.alpha.id, title: "Actual waiting child", model })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "launched", parentID: f.alpha.id, parentAssistantMessageID: SessionMessage.ID.make("msg_actual_parent"), toolCallID: "call_actual_child", inputID: SessionMessage.ID.make("msg_actual_child"), description: "Synthetic child", agent: Agent.ID.make("build"), model, promptDigest: "synthetic", background: true, delivery: "steer" } })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    const orchestration = yield* SessionOrchestration.Service
    yield* orchestration.question(child.id, "Which synthetic branch?")
    const pending = (yield* f.runtime.decisionsList({ ...f.list, targetSessionID: child.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "subagent_question")!
    const receipt = yield* Deferred.make<boolean>()
    const unsubscribe = yield* f.events.listen((event) => event.type !== SessionEvent.DotsDecisionSettled.type ? Effect.void : Effect.gen(function* () {
      const data = Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(event.data)
      if (data.source.exchangeID !== "actual_child_answer") return
      const inputs = yield* SessionPending.list(f.db, child.id)
      yield* Deferred.succeed(receipt, inputs.some((item) => item.type === "synthetic" && item.data.text.includes("Synthetic child answer")))
    }))
    const input = { ...f.task, targetSessionID: child.id, exchangeID: "actual_child_answer", instruction: { operation: "decision", target: pending, text: "Synthetic child answer" } } as const
    expect((yield* f.runtime.create(input)).decisionOutcome?.state).toBe("settled")
    expect(yield* Deferred.await(receipt)).toBe(true)
    yield* unsubscribe
    yield* f.runtime.create(input)
    expect(yield* SessionPending.list(f.db, child.id)).toHaveLength(1)
    expect((yield* orchestration.questionSnapshots(f.alpha.id))).toEqual([])
    yield* orchestration.question(child.id, "Another synthetic question?")
    const second = (yield* f.runtime.decisionsList({ ...f.list, targetSessionID: child.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "subagent_question")!
    expect((yield* f.runtime.create({ ...f.task, targetSessionID: child.id, exchangeID: "actual_child_dismiss", instruction: { operation: "decision", target: second, dismissed: true } satisfies Dots.DelegatedInstruction })).decisionOutcome?.state).toBe("settled")
    expect(yield* SessionPending.list(f.db, child.id)).toHaveLength(2)
    expect((yield* orchestration.questionSnapshots(f.alpha.id))).toEqual([])
  }))
  it.live("the composed durable-review exchange commits its receipt and continuation without holding the inbox lock", () => Effect.gen(function* () {
    const f = yield* composed
    const reviews = yield* SessionReview.Service
    const item = yield* reviews.open({ sessionID: f.beta.id, kind: "question", reason: "free_text", origin: { requestID: "qst_actual_review" }, payload: { type: "form", title: "Synthetic branch", fields: [{ key: "branch", type: "string", required: true }] }, limit: 16 })
    const pending = (yield* f.runtime.decisionsList({ ...f.list, targetSessionID: f.beta.id })).data.map((entry) => entry.candidate.target).find((target) => target.kind === "review")!
    const receipt = yield* Deferred.make<boolean>()
    const unsubscribe = yield* f.events.listen((event) => event.type !== SessionEvent.DotsDecisionSettled.type ? Effect.void : Effect.gen(function* () {
      const data = Schema.decodeUnknownSync(SessionEvent.DotsDecisionSettled.data)(event.data)
      if (data.source.exchangeID !== "actual_review_answer") return
      const inputs = yield* SessionPending.list(f.db, f.beta.id)
      yield* Deferred.succeed(receipt, inputs.some((input) => input.type === "synthetic" && input.id === SessionReview.promptID(item.itemID)))
    }))
    const input = { ...f.task, targetSessionID: f.beta.id, exchangeID: "actual_review_answer", instruction: { operation: "decision", target: pending, decision: { kind: "question", answers: { branch: "safe" } } } } as const
    expect((yield* f.runtime.create(input)).decisionOutcome?.state).toBe("settled")
    expect(yield* Deferred.await(receipt)).toBe(true)
    yield* unsubscribe
    yield* f.runtime.create(input)
    expect(yield* SessionPending.list(f.db, f.beta.id)).toHaveLength(1)
    expect(yield* reviews.list(f.beta.id)).toEqual([])
  }))
})

describe("native typed task delegation", () => {
  it.live("requires explicit native approval once and admits closed continuation and presentation without another approval", () => Effect.gen(function* () {
    const f = yield* delegated
    expect(f.approval.calls).toHaveLength(1)
    expect(f.approval.calls[0]).toMatchObject({ requireExplicitDecision: true, action: "dots_delegate" })
    expect(f.approval.calls[0]).not.toHaveProperty("save")
    expect((yield* f.runtime.delegationCreate(f.proposal)).id).toBe(f.grant.id)
    const first = yield* f.runtime.create(f.input)
    expect((yield* f.runtime.create(f.input)).inputID).toBe(first.inputID)
    const presentation = yield* f.runtime.create({ ...f.input, exchangeID: "present", instruction: { operation: "presentation", preferences: { format: "bullets", detail: "concise" } } satisfies Dots.RoutineInstruction })
    expect(presentation.inputID).not.toBe(first.inputID)
    expect(f.approval.calls).toHaveLength(1)
    expect(wakes).toEqual([f.alpha.id, f.alpha.id, f.alpha.id])
    const pending = (yield* SessionPending.list(f.db, f.alpha.id)).find((item): item is SessionPending.User => item.type === "user" && item.id === first.inputID)
    expect(pending?.data.metadata?.inputOrigin).toBe("plugin")
    expect(pending?.data.metadata?.dotsExchange).toHaveProperty("routine.taskInputID", f.task.id)
    expect(DotsPeer.resetsStepAllowance(pending!)).toBe(false)
    const status = yield* f.runtime.delegationStatus({ sessionID: f.master.id, targetSessionID: f.alpha.id, expectedAttachment: target })
    expect(status.tasks).toEqual([{ taskInputID: f.task.id, text: "Implement the synthetic local task" }])
    expect(status.sources[0]?.principal).toEqual(f.grant.principal)
    expect(status.grants).toContainEqual(f.grant)
    expect((yield* f.runtime.create({ ...f.input, instruction: { operation: "presentation", preferences: { format: "bullets" } } satisfies Dots.RoutineInstruction }).pipe(Effect.result))._tag).toBe("Failure")
  }))
  it.live("rejects new prose, changed proposals, out-of-scope preferences and nonhuman tasks", () => Effect.gen(function* () {
    const f = yield* delegated
    const { sessionID, remoteSource, ...routine } = f.input
    expect((yield* Schema.decodeUnknownEffect(Dots.ExchangeCreate)({ ...routine, text: "Deploy a new task" }).pipe(
      Effect.flatMap((input) => f.runtime.create({ ...input, sessionID, remoteSource })), Effect.exit,
    ))._tag).toBe("Failure")
    expect((yield* f.runtime.delegationCreate({ ...f.proposal, expiresAt: f.clock.now + 1 }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.runtime.delegationCreate({ ...f.proposal, proposalID: "too_long", expiresAt: f.clock.now + 3_600_001 }).pipe(Effect.exit))._tag).toBe("Failure")
    const plugin = yield* f.sessions.prompt({ sessionID: f.alpha.id, origin: "plugin", text: "Claimed human task", resume: false })
    expect((yield* f.runtime.delegationCreate({ ...f.proposal, proposalID: "plugin", taskInputID: plugin.id }).pipe(Effect.exit))._tag).toBe("Failure")
    const narrow = yield* f.runtime.delegationCreate({ ...f.proposal, proposalID: "narrow", scope: { operations: ["presentation"], format: ["bullets"] } satisfies Dots.DelegationScope })
    expect((yield* f.runtime.create({ ...f.input, delegation: { id: narrow.id, revision: narrow.revision } }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.runtime.create({ ...f.input, delegation: { id: narrow.id, revision: narrow.revision }, instruction: { operation: "presentation", preferences: { format: "prose" } } satisfies Dots.RoutineInstruction }).pipe(Effect.exit))._tag).toBe("Failure")
  }))
  for (const change of ["revoke", "expiry", "unbind", "rebind", "account", "target", "principal", "grant", "epoch", "task", "completed", "owner-return", "restart"] as const) {
    it.live(`rejects new and queued routine instructions after ${change} without losing the following human input`, () => Effect.gen(function* () {
      const f = yield* delegated
      const queued = yield* f.runtime.create(f.input)
      if (change === "revoke") yield* f.runtime.delegationRevoke({ sessionID: f.master.id, id: f.grant.id, revision: f.grant.revision, expectedAttachment: target })
      if (change === "expiry") f.clock.now = f.proposal.expiresAt
      if (change === "unbind") f.binding.current = undefined
      if (change === "rebind" || change === "restart") f.binding.current = { ...f.authority, incarnation: "replacement", grants: new Map(), proposals: new Map() }
      if (change === "account") f.attachment.accountDigest = "b".repeat(64)
      if (change === "target") f.attachment.target = { ...target, generation: "replacement" }
      if (change === "principal") f.input.remoteSource = { ...source, principal: { ...source.principal, clientID: "replacement" } }
      if (change === "grant") f.authorization.grantID = "replacement"
      if (change === "epoch") f.input.remoteSource = { ...source, epoch: "replacement" }
      if (change === "task") yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Different direct task", resume: false })
      if (change === "completed") yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: f.task.id, assistantMessageID: SessionMessage.ID.make("msg_finished_native") })
      if (change === "owner-return") {
        yield* f.coordination.setOwner(f.group.id, { sessionID: f.alpha.id, ownerSessionID: f.beta.id })
        yield* f.coordination.setOwner(f.group.id, { sessionID: f.alpha.id })
      }
      expect((yield* f.runtime.create({ ...f.input, exchangeID: "new_after_change" }).pipe(Effect.exit))._tag).toBe("Failure")
      const next = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Next native queued task", delivery: "queue", resume: false })
      const promoted = yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
      expect(promoted).toBe(true)
      expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: queued.inputID })).toBeUndefined()
      expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: next.id })).toBeDefined()
      expect((yield* SessionPending.list(f.db, f.alpha.id)).some((item) => item.id === queued.inputID)).toBe(false)
      const rejected = yield* f.db.select({ data: EventTable.data }).from(EventTable).where(eq(EventTable.type, EventRuntime.versionedType(SessionEvent.DotsInstructionRejected.type, 1))).all().pipe(Effect.orDie)
      expect(rejected.map((row) => row.data.inputID)).toContain(queued.inputID)
      if (["revoke", "expiry", "task", "restart"].includes(change)) expect((yield* f.read("routine")).state).toBe("failed")
    }))
  }
  it.live("rechecks all local fences after human approval and never holds the binding writer while asking", () => Effect.gen(function* () {
    const f = yield* setup
    const task = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Native task", resume: false })
    yield* f.create("source")
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    f.approval.wait = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    const pending = yield* f.runtime.delegationCreate({ sessionID: f.master.id, proposalID: "racing", sourceExchangeID: "source", targetSessionID: f.alpha.id, taskInputID: task.id, expectedAttachment: target, expiresAt: f.clock.now + 1000, scope: { operations: ["continue"] } }).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    f.binding.current = undefined
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(pending).pipe(Effect.exit))._tag).toBe("Failure")
  }))
  for (const boundary of ["admission", "promotion"] as const) it.live(`permits revocation while authorization awaits at ${boundary} and rejects before promotion`, () => Effect.gen(function* () {
    const f = yield* delegated
    const queued = boundary === "promotion" ? yield* f.runtime.create(f.input) : undefined
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    f.hooks.checkStored = () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    const work = boundary === "admission" ? f.runtime.create(f.input).pipe(Effect.as(true)) : SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const fiber = yield* work.pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* f.runtime.delegationRevoke({ sessionID: f.master.id, id: f.grant.id, revision: f.grant.revision, expectedAttachment: target })
    yield* Deferred.succeed(release, undefined)
    const settled = yield* Fiber.join(fiber).pipe(Effect.result)
    expect(settled._tag === "Failure" || settled.success === false).toBe(true)
    if (queued) expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: queued.inputID })).toBeUndefined()
    expect((yield* SessionPending.list(f.db, f.alpha.id)).some((entry) => entry.type === "user" && Dots.routine(entry.data.metadata) !== undefined)).toBe(false)
  }))
  it.live("revocation after successful promotion retains the accepted instruction and never rewrites the native task", () => Effect.gen(function* () {
    const f = yield* delegated
    const result = yield* f.runtime.create(f.input)
    expect(yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)).toBe(true)
    const message = yield* f.sessions.message({ sessionID: f.alpha.id, messageID: result.inputID })
    yield* f.runtime.delegationRevoke({ sessionID: f.master.id, id: f.grant.id, revision: f.grant.revision, expectedAttachment: target })
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: result.inputID })).toEqual(message)
    expect(yield* f.runtime.currentRoutine(f.alpha.id)).toMatchObject({ delegation: f.input.delegation, instruction: f.input.instruction })
    expect((yield* f.sessions.message({ sessionID: f.alpha.id, messageID: f.task.id }))?.type).toBe("user")
    expect((yield* f.runtime.delegationStatus({ sessionID: f.master.id, targetSessionID: f.alpha.id, expectedAttachment: target })).grants[0]?.active).toBe(false)
  }))
  it.live("keeps a pending replacement human task eligible when earlier work completes before its promotion", () => Effect.gen(function* () {
    const f = yield* delegated
    const next = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "The next approved native task", resume: false })
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: f.task.id, assistantMessageID: SessionMessage.ID.make("msg_previous_completed") })
    const grant = yield* f.runtime.delegationCreate({ ...f.proposal, proposalID: "next_task", taskInputID: next.id })
    const input = { ...f.input, exchangeID: "next_task_routine", delegation: { id: grant.id, revision: grant.revision }, taskInputID: next.id }
    const receipt = yield* f.runtime.create(input)
    yield* SessionPending.promoteSteers(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    expect(yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)).toBe(true)
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: receipt.inputID })).toBeDefined()
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: receipt.inputID, assistantMessageID: SessionMessage.ID.make("msg_next_completed") })
    expect((yield* f.runtime.create({ ...input, exchangeID: "after_task_completion" }).pipe(Effect.result))._tag).toBe("Failure")
  }))
  it.live("does not restore an older pending task grant while promoting steers before a newer human task", () => Effect.gen(function* () {
    const f = yield* setup
    const first = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "First native task", resume: false })
    yield* f.create("source")
    const grant = yield* f.runtime.delegationCreate({ sessionID: f.master.id, proposalID: "pending_native", sourceExchangeID: "source", targetSessionID: f.alpha.id, taskInputID: first.id, expectedAttachment: target, expiresAt: f.clock.now + 60_000, scope: { operations: ["continue"] } })
    const routine = yield* f.runtime.create({ sessionID: f.master.id, remoteSource: source, exchangeID: "pending_routine", targetSessionID: f.alpha.id, taskInputID: first.id, expectedAttachment: target, channel: "task", delivery: "steer", delegation: { id: grant.id, revision: grant.revision }, instruction: { operation: "continue" } })
    const next = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Newer native task", resume: false })
    yield* SessionPending.promoteSteers(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: routine.inputID })).toBeUndefined()
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: next.id })).toBeDefined()
  }))
})

const managed = Effect.fn(function* (fixture: Effect.Success<typeof setup>, parentID: Session.ID) {
  const child = yield* fixture.sessions.create({ parentID, title: "Managed child" })
  yield* fixture.events.publish(SessionEvent.Task.Updated, {
    sessionID: child.id,
    change: { type: "launched", parentID, parentAssistantMessageID: SessionMessage.ID.create(), toolCallID: `call_${child.id}`,
      inputID: SessionMessage.ID.create(), description: "Synthetic owned task", agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }),
      promptDigest: "synthetic", background: true, delivery: "queue" },
  })
  return child
})

describe("Dots exchange admission", () => {
  it.live("routing envelope stamps coordinator and grant scope without a fictitious source Session", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("envelope_task")
    const pending = (yield* SessionPending.list(f.db, f.alpha.id))[0]
    const expected = {
      coordinator: source.principal, scope: { epoch: source.epoch, grantID: "grant_fixture" },
      exchangeID: "envelope_task", messageID: value.inputID, kind: "task", origin: "plugin", targetSessionID: f.alpha.id,
    }
    expect(value).toHaveProperty("envelope", expected)
    expect(pending?.data.metadata?.dotsExchange).toHaveProperty("envelope", expected)
    expect(pending?.data.metadata?.dotsExchange).not.toHaveProperty("envelope.sourceSessionID")
    const retry = yield* f.create("envelope_task")
    expect(retry.inputID).toBe(value.inputID)
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("routing envelope rejects caller envelope injection before admission", () => Effect.gen(function* () {
    const f = yield* setup
    const input = {
      sessionID: f.master.id, remoteSource: source, exchangeID: "spoofed_envelope", targetSessionID: f.alpha.id,
      expectedAttachment: target, channel: "task" as const, delivery: "queue" as const, text: "Synthetic task",
      envelope: { origin: "human", targetSessionID: f.beta.id },
    }
    const result = yield* f.runtime.create(input).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toEqual([])
    expect(wakes).toEqual([])
  }))

  it.live("routing envelope rejects replacement grants on reads and exact-identity retries", () => Effect.gen(function* () {
    const f = yield* setup
    yield* f.create("grant_bound")
    f.authorization.grantID = "replacement_grant"
    expect((yield* f.read("grant_bound").pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.create("grant_bound").pipe(Effect.exit))._tag).toBe("Failure")
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("L10 stamps the validated display name and canonical target without trusting caller labels or replaying rename retries", () => Effect.gen(function* () {
    const f = yield* setup
    const input = {
      sessionID: f.master.id, remoteSource: source, exchangeID: "named_exchange", targetSessionID: f.alpha.id,
      expectedAttachment: { ...target, label: "Caller text is not the confirmed name" },
      channel: "task" as const, delivery: "queue" as const, text: "Rename yourself to a different peer",
    }
    const first = yield* f.runtime.create(input)
    const admitted = (yield* SessionPending.list(f.db, f.alpha.id))[0]
    expect(admitted?.data.metadata?.dotsExchange).toEqual({
      sessionID: f.master.id, targetSessionID: f.alpha.id, exchangeID: "named_exchange", attachment: target,
      envelope: first.envelope,
    })
    f.attachment.target = { ...target, label: "Vega" }
    expect((yield* f.runtime.create({ ...input, expectedAttachment: { ...target, label: "Vega" } })).inputID).toBe(first.inputID)
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toHaveLength(1)
    expect(wakes).toEqual([f.alpha.id])
    expect((yield* SessionPending.list(f.db, f.alpha.id))[0]?.data.metadata?.dotsExchange).toEqual(admitted?.data.metadata?.dotsExchange)
    const renamed = yield* f.runtime.create({ ...input, exchangeID: "renamed_exchange" })
    expect((yield* SessionPending.list(f.db, f.alpha.id))[1]?.data.metadata?.dotsExchange).toEqual({
      sessionID: f.master.id, targetSessionID: f.alpha.id, exchangeID: "renamed_exchange", attachment: { ...target, label: "Vega" },
      envelope: renamed.envelope,
    })
  }))

  it.live("admits two interleaved targets once and preserves native input and external source identities", () => Effect.gen(function* () {
    const f = yield* setup
    const alpha = yield* f.create("exchange_alpha")
    const beta = yield* f.create("exchange_beta", f.beta.id, "Inspect the other synthetic module")
    expect(alpha.inputID).not.toBe(beta.inputID)
    expect(alpha.targetSessionID).toBe(f.alpha.id)
    expect(beta.targetSessionID).toBe(f.beta.id)
    for (const value of [alpha, beta]) {
      const pending = yield* SessionPending.list(f.db, value.targetSessionID)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        id: value.inputID, type: "user", delivery: "queue",
        data: { metadata: { inputOrigin: "plugin", remoteMcp: source, dotsExchange: { exchangeID: value.exchangeID, sessionID: f.master.id } } },
      })
    }
    expect(wakes).toEqual([f.alpha.id, f.beta.id])
    expect((yield* f.create("exchange_alpha")).inputID).toBe(alpha.inputID)
    expect(wakes).toHaveLength(2)
    expect((yield* f.read("exchange_beta")).targetSessionID).toBe(f.beta.id)
    expect(f.attachment.target).toEqual(target)
  }))

  it.live("routing envelope admits device-authorized roots without assigning native Project authority", () => Effect.gen(function* () {
    const f = yield* setup
    expect((yield* f.create("outside", f.outsider.id)).targetSessionID).toBe(f.outsider.id)
    expect((yield* f.runtime.create({
      sessionID: f.alpha.id, remoteSource: source, exchangeID: "sibling", targetSessionID: f.beta.id,
      expectedAttachment: target, channel: "task", delivery: "queue", text: "Device-authorized task",
    })).targetSessionID).toBe(f.beta.id)
    expect((yield* f.coordination.accessOf(f.alpha.id))?.role).toBe("executor")
    expect(wakes).toEqual([f.outsider.id, f.beta.id])
  }))

  it.live("routing envelope fences prior ownership snapshots while newly authorized root tasks use the current scope", () => Effect.gen(function* () {
    const f = yield* setup
    yield* f.create("before_removal")
    yield* f.coordination.update(f.group.id, { revision: (yield* f.coordination.get(f.group.id)).revision, memberSessionIDs: [f.beta.id] })
    expect((yield* f.create("after_removal")).targetSessionID).toBe(f.alpha.id)
    expect((yield* f.read("before_removal").pipe(Effect.exit))._tag).toBe("Failure")
    expect(wakes).toEqual([f.alpha.id, f.alpha.id])
  }))

  it.live("conflicts on changed target, text, delivery, channel or authenticated source", () => Effect.gen(function* () {
    const f = yield* setup
    const prior = yield* f.create("collision")
    const input = {
      sessionID: f.master.id, remoteSource: source, exchangeID: "collision", targetSessionID: f.alpha.id,
      expectedAttachment: target, channel: "task" as const, delivery: "queue" as const, text: "Investigate the synthetic module",
    }
    for (const change of [
      { targetSessionID: f.beta.id }, { text: "Changed task" }, { delivery: "steer" as const },
      { remoteSource: { ...source, principal: { ...source.principal, clientID: "other_client" } } },
    ]) expect((yield* f.runtime.create({ ...input, ...change }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.read("collision")).inputID).toBe(prior.inputID)
    expect(wakes).toHaveLength(1)
  }))

  it.live("reconciles after runtime recreation but refuses changed account and attachment generation", () => Effect.gen(function* () {
    const f = yield* setup
    const prior = yield* f.create("recovered")
    const restored = f.make()
    expect((yield* restored.read({ sessionID: f.master.id, remoteSource: source, exchangeID: "recovered" })).inputID).toBe(prior.inputID)
    expect((yield* restored.create({
      sessionID: f.master.id, remoteSource: { ...source, requestID: "request_retry" }, exchangeID: "recovered",
      targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task", delivery: "queue", text: "Investigate the synthetic module",
    })).inputID).toBe(prior.inputID)
    expect(wakes).toHaveLength(1)
    f.attachment.accountDigest = "b".repeat(64)
    expect((yield* f.read("recovered").pipe(Effect.exit))._tag).toBe("Failure")
    f.attachment.accountDigest = "a".repeat(64)
    f.attachment.target = { ...target, generation: "replacement" }
    expect((yield* f.read("recovered").pipe(Effect.exit))._tag).toBe("Failure")
    expect(wakes).toHaveLength(1)
  }))

  it.live("labels do not change canonical attachment or exchange identity", () => Effect.gen(function* () {
    const f = yield* setup
    const prior = yield* f.create("label")
    f.attachment.target = { ...target, label: "Renamed display label" }
    const same = yield* f.create("label")
    expect(same.inputID).toBe(prior.inputID)
    expect(wakes).toHaveLength(1)
  }))

  it.live("grant revocation and wrong epochs fail before any admission", () => Effect.gen(function* () {
    const f = yield* setup
    f.authorization.enabled = false
    expect((yield* f.create("revoked").pipe(Effect.exit))._tag).toBe("Failure")
    expect(wakes).toEqual([])
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toEqual([])
  }))

  it.live("a regular attachment can address itself without gaining any Project authority", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.runtime.create({
      sessionID: f.alpha.id, remoteSource: source, exchangeID: "self", targetSessionID: f.alpha.id,
      expectedAttachment: target, channel: "task", delivery: "queue", text: "Local work only",
    })
    expect(value.targetSessionID).toBe(f.alpha.id)
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("routing envelope preserves native parent-only managed-child delivery even for related attachments", () => Effect.gen(function* () {
    const f = yield* setup
    const child = yield* managed(f, f.alpha.id)
    const grandchild = yield* managed(f, child.id)
    const own = yield* f.runtime.create({
      sessionID: f.alpha.id, remoteSource: source, exchangeID: "own_family", targetSessionID: grandchild.id,
      expectedAttachment: target, channel: "task", delivery: "queue", text: "Owned family task",
    }).pipe(Effect.exit)
    expect(own._tag).toBe("Failure")
    expect((yield* f.create("master_family", grandchild.id).pipe(Effect.exit))._tag).toBe("Failure")
    yield* f.sessions.archive(child.id)
    expect((yield* f.runtime.create({
      sessionID: f.alpha.id, remoteSource: source, exchangeID: "archived_own_family", targetSessionID: grandchild.id,
      expectedAttachment: target, channel: "task", delivery: "queue", text: "Archived family task",
    }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.create("archived_master_family", grandchild.id).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.runtime.read({ sessionID: f.alpha.id, exchangeID: "own_family", remoteSource: source }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.read("master_family").pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* SessionPending.list(f.db, grandchild.id)).toEqual([])
    expect(wakes).toEqual([])
  }))

  it.live("reads refuse another authenticated client and wrong epochs", () => Effect.gen(function* () {
    const f = yield* setup
    yield* f.create("private")
    for (const remoteSource of [
      { ...source, epoch: "old_epoch" },
      { ...source, principal: { ...source.principal, clientID: "another_client" } },
    ]) expect((yield* f.runtime.read({ sessionID: f.master.id, exchangeID: "private", remoteSource }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(wakes).toHaveLength(1)
  }))
})

describe("Dots exchange return correlation", () => {
  it.live("report reads retain explicit report identity and body without accepting another exchange", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("explicit_reports")
    yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: f.alpha.id, inputID: value.inputID })
    const messageID = SessionMessage.ID.create()
    const report = { deliveryID: "report_fixture", messageID, text: "Synthetic blocker", envelope: {
      coordinator: source.principal, scope: { epoch: source.epoch, grantID: "grant_fixture" },
      exchangeID: value.exchangeID, messageID, replyToMessageID: value.inputID, kind: "blocker" as const,
      origin: "agent" as const, sourceSessionID: f.alpha.id,
    } }
    yield* f.events.publish(SessionEvent.DotsReportRecorded, { sessionID: f.alpha.id, callID: "call_report", ...report })
    yield* f.events.publish(SessionEvent.DotsReportRecorded, { sessionID: f.alpha.id, callID: "call_other", ...report, envelope: { ...report.envelope, exchangeID: "other" } })
    expect((yield* f.read(value.exchangeID)).progress).toEqual([report])
  }))

  it.live("report context resolves the current native input and rejects stale tool sources or grants", () => Effect.gen(function* () {
    const f = yield* setup
    const exchange = yield* f.create("report_context")
    const messageID = SessionMessage.ID.create()
    expect((yield* f.runtime.resolveReport(f.alpha.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    const promoted = yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: f.alpha.id, inputID: exchange.inputID })
    expect((yield* f.runtime.resolveReport(f.alpha.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID: messageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    expect(yield* f.db.select().from(SessionProviderRequestTable).all()).toHaveLength(0)
    const inStep = yield* f.runtime.resolveReport(f.alpha.id, messageID)
    expect(inStep.record.inputID).toBe(exchange.inputID)
    yield* f.db.insert(SessionProviderRequestTable).values({
      id: ProviderRequest.ID.make("prq_report_context"), session_id: f.alpha.id, input_id: exchange.inputID, assistant_message_id: messageID,
      source: "step", agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }),
      route_id: "fixture", prompt_cache_key: "fixture", system_digest: "fixture", tool_digest: "fixture", request: 1, attempts: 1,
      invalidation: "first-request", continuation: "full", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time_created: 1,
    }).run()
    const resolved = yield* f.runtime.resolveReport(f.alpha.id, messageID)
    expect(resolved.record.inputID).toBe(exchange.inputID)
    expect(resolved.generation).toBe(promoted.durable?.seq)
    yield* f.events.publish(SessionEvent.Text.Started, { sessionID: f.alpha.id, assistantMessageID: messageID, ordinal: 0 })
    yield* f.events.publish(SessionEvent.Text.Ended, { sessionID: f.alpha.id, assistantMessageID: messageID, ordinal: 0, text: "Synthetic progress" })
    const progress = (yield* f.read(exchange.exchangeID)).progress[0]
    expect((yield* f.runtime.resolveReport(f.beta.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.runtime.resolveReport(f.alpha.id, SessionMessage.ID.create()).pipe(Effect.exit))._tag).toBe("Failure")
    f.authorization.enabled = false
    expect((yield* f.runtime.resolveReport(f.alpha.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    f.authorization.enabled = true
    f.attachment.target = { ...target, generation: "replacement" }
    expect((yield* f.runtime.resolveReport(f.alpha.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    f.attachment.target = target
    const native = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Independent native input", resume: false })
    yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: f.alpha.id, inputID: native.id })
    expect((yield* f.runtime.resolveReport(f.alpha.id, messageID).pipe(Effect.exit))._tag).toBe("Failure")
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: exchange.inputID, assistantMessageID: messageID })
    const completed = (yield* f.read(exchange.exchangeID)).result
    expect(progress?.envelope.kind).toBe("progress")
    expect(completed?.envelope.kind).toBe("completion")
    expect(completed?.deliveryID).not.toBe(progress?.deliveryID)
  }))

  it.live("report attachment lookup follows the anchor's persisted Location rather than the reporter's runtime", () => Effect.gen(function* () {
    const f = yield* setup
    const reporter = yield* f.sessions.create({ location: { directory: AbsolutePath.make(`${tmpdir()}/dots-reporter`) }, title: "Remote Location" })
    const reads: unknown[] = []
    const attachment = DotsExchange.attachmentForSession({
      sessions: f.sessions, currentLocation: reporter.location,
      current: { attachment: () => Effect.die("The reporting Location must not own the anchor binding") },
      runtimeAt: (location) => Effect.sync(() => {
        reads.push(location)
        return { attachment: (sessionID: Session.ID) => Effect.sync(() => { expect(sessionID).toBe(f.master.id); return f.attachment }) }
      }),
    })
    expect(yield* attachment(f.master.id)).toEqual(f.attachment)
    expect(reads).toEqual([f.master.location])
    expect((yield* attachment(Session.ID.make("ses_absent_anchor")).pipe(Effect.exit))._tag).toBe("Failure")
    expect(reads).toHaveLength(1)
    const local = DotsExchange.attachmentForSession({ sessions: f.sessions, currentLocation: f.master.location, current: { attachment: () => Effect.succeed(f.attachment) }, runtimeAt: () => Effect.die("Same-Location reads must not rebuild the Location") })
    expect(yield* local(f.master.id)).toEqual(f.attachment)
  }))

  it.live("tool-only assistant output is not advertised as an empty progress report", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("tool_only")
    yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: f.alpha.id, inputID: value.inputID })
    const messageID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID: messageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    yield* f.db.insert(SessionProviderRequestTable).values({ id: ProviderRequest.ID.make("prq_tool_only"), session_id: f.alpha.id, input_id: value.inputID, assistant_message_id: messageID, source: "step", agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }), route_id: "fixture", prompt_cache_key: "fixture", system_digest: "fixture", tool_digest: "fixture", request: 1, attempts: 1, invalidation: "first-request", continuation: "full", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time_created: 1 }).run()
    expect((yield* f.read(value.exchangeID)).progress).toEqual([])
  }))

  it.live("routing envelope returns completion to the originating coordinator with the exact input correlation", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("envelope_completion")
    const messageID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.Step.Started, {
      sessionID: f.alpha.id, assistantMessageID: messageID, agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }),
    })
    yield* f.events.publish(SessionEvent.Text.Started, { sessionID: f.alpha.id, assistantMessageID: messageID, ordinal: 0 })
    yield* f.events.publish(SessionEvent.Text.Ended, { sessionID: f.alpha.id, assistantMessageID: messageID, ordinal: 0, text: "Verified synthetic completion" })
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: value.inputID, assistantMessageID: messageID })
    const completed = yield* f.read("envelope_completion")
    expect(completed.result).toHaveProperty("envelope", {
      coordinator: source.principal, scope: { epoch: source.epoch, grantID: "grant_fixture" },
      exchangeID: "envelope_completion", messageID, replyToMessageID: value.inputID,
      kind: "completion", origin: "agent", sourceSessionID: f.alpha.id,
    })
    expect(completed.result).not.toHaveProperty("envelope.targetSessionID")
    expect((yield* f.read("envelope_completion")).result).toEqual(completed.result)
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("a failed input and an interrupted unknown outcome never admit again on read or recreation", () => Effect.gen(function* () {
    const f = yield* setup
    const failed = yield* f.create("failed")
    const uncertain = yield* f.create("uncertain", f.beta.id)
    for (const value of [failed, uncertain])
      yield* f.events.publish(SessionEvent.InputPromoted, { sessionID: value.targetSessionID, inputID: value.inputID })
    yield* f.events.publish(SessionEvent.Execution.Failed, { sessionID: f.alpha.id, error: { type: "provider.error", message: "Synthetic provider failed" } })
    yield* f.events.publish(SessionEvent.Execution.Interrupted, { sessionID: f.beta.id, reason: "shutdown" })
    expect((yield* f.read("failed")).state).toBe("failed")
    expect((yield* f.read("uncertain")).state).toBe("unknown")
    const restored = f.make()
    expect((yield* restored.read({ sessionID: f.master.id, exchangeID: "uncertain", remoteSource: source })).state).toBe("unknown")
    yield* f.create("uncertain", f.beta.id)
    expect(wakes).toEqual([f.alpha.id, f.beta.id])
  }))

  it.live("returns only the completed output identified by each exchange even when completion order differs", () => Effect.gen(function* () {
    const f = yield* setup
    const alpha = yield* f.create("return_alpha")
    const beta = yield* f.create("return_beta", f.beta.id)
    for (const [exchange, text] of [[beta, "Beta result"], [alpha, "Alpha result"]] as const) {
      const id = SessionMessage.ID.create()
      yield* f.events.publish(SessionEvent.Step.Started, {
        sessionID: exchange.targetSessionID, assistantMessageID: id, agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }),
      })
      yield* f.events.publish(SessionEvent.Text.Started, { sessionID: exchange.targetSessionID, assistantMessageID: id, ordinal: 0 })
      yield* f.events.publish(SessionEvent.Text.Ended, {
        sessionID: exchange.targetSessionID, assistantMessageID: id, ordinal: 0, text,
      })
      yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: exchange.targetSessionID, inputID: exchange.inputID, assistantMessageID: id })
    }
    const readBeta = yield* f.read("return_beta")
    const readAlpha = yield* f.read("return_alpha")
    expect(readBeta).toMatchObject({ state: "completed", result: { text: "Beta result" } })
    expect(readAlpha).toMatchObject({ state: "completed", result: { text: "Alpha result" } })
    expect(readAlpha.result?.deliveryID).not.toBe(readBeta.result?.deliveryID)
    expect((yield* f.read("return_alpha")).result?.deliveryID).toBe(readAlpha.result?.deliveryID)
    expect(wakes).toHaveLength(2)
  }))
})

describe("Dots exchange final fences", () => {
  for (const change of ["generation", "account"] as const)
    it.live(`rejects ${change} changes while commit authorization awaits`, () => Effect.gen(function* () {
      const f = yield* setup
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let armed = false
      let held = false
      f.hooks.attachment = () => { armed = true }
      f.hooks.authorize = () => {
        if (!armed || held) return Effect.void
        held = true
        return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.asVoid)
      }
      const creating = yield* f.create(`gated_${change}`).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(entered)
      if (change === "generation") f.attachment.target = { ...target, generation: "changed_while_authorizing" }
      if (change === "account") f.attachment.accountDigest = "b".repeat(64)
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(creating))._tag).toBe("Failure")
      expect(yield* SessionPending.list(f.db, f.alpha.id)).toEqual([])
      expect(wakes).toEqual([])
    }))

  it.live("rejects owner-scope changes while final return authorization awaits", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("gated_scope_return")
    const assistantMessageID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    yield* f.events.publish(SessionEvent.Text.Started, { sessionID: f.alpha.id, assistantMessageID, ordinal: 0 })
    yield* f.events.publish(SessionEvent.Text.Ended, { sessionID: f.alpha.id, assistantMessageID, ordinal: 0, text: "Protected scoped result" })
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: value.inputID, assistantMessageID })
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let armed = false
    let held = false
    f.hooks.message = () => { armed = true }
    f.hooks.authorize = () => {
      if (!armed || held) return Effect.void
      held = true
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.asVoid)
    }
    const reading = yield* f.read("gated_scope_return").pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* f.coordination.update(f.group.id, { revision: (yield* f.coordination.get(f.group.id)).revision, memberSessionIDs: [f.beta.id] })
    yield* Deferred.succeed(release, undefined)
    expect((yield* Fiber.join(reading))._tag).toBe("Failure")
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("reports an uncertain outcome after admission when return authorization is revoked", () => Effect.gen(function* () {
    const f = yield* setup
    f.hooks.wake = () => { f.authorization.enabled = false }
    const error = yield* f.create("revoked_after_admission").pipe(Effect.flip)
    expect(error.code).toBe("exchange_outcome_unknown")
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toHaveLength(1)
    expect(wakes).toEqual([f.alpha.id])
    f.hooks.wake = undefined
    f.authorization.enabled = true
    yield* f.create("revoked_after_admission")
    expect(wakes).toEqual([f.alpha.id])
  }))

  it.live("rejects grant revocation at the commit boundary without admission or wake", () => Effect.gen(function* () {
    const f = yield* setup
    f.hooks.attachment = () => { f.authorization.enabled = false }
    expect((yield* f.create("revoked_commit").pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toEqual([])
    expect(wakes).toEqual([])
  }))

  it.live("rejects attachment replacement at the commit boundary without admission or wake", () => Effect.gen(function* () {
    const f = yield* setup
    let reads = 0
    f.hooks.attachment = () => {
      if (++reads === 2) f.attachment.target = { ...target, generation: "changed_at_commit" }
    }
    expect((yield* f.create("changed_commit").pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* SessionPending.list(f.db, f.alpha.id)).toEqual([])
    expect(wakes).toEqual([])
  }))

  it.live("rejects grant revocation at the return boundary without releasing the result", () => Effect.gen(function* () {
    const f = yield* setup
    const value = yield* f.create("revoked_return")
    const assistantMessageID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    yield* f.events.publish(SessionEvent.Text.Started, { sessionID: f.alpha.id, assistantMessageID, ordinal: 0 })
    yield* f.events.publish(SessionEvent.Text.Ended, { sessionID: f.alpha.id, assistantMessageID, ordinal: 0, text: "Protected result" })
    yield* f.events.publish(SessionEvent.Work.Completed, { sessionID: f.alpha.id, inputID: value.inputID, assistantMessageID })
    f.hooks.message = () => { f.authorization.enabled = false }
    expect((yield* f.read("revoked_return").pipe(Effect.exit))._tag).toBe("Failure")
  }))

  it.live("rejects archived attachments and targets independently before admission and read", () => Effect.gen(function* () {
    for (const archived of ["attachment", "target"]) {
      const f = yield* setup
      yield* f.create("before_archive")
      yield* f.sessions.archive(archived === "attachment" ? f.master.id : f.alpha.id)
      expect((yield* f.create("after_archive").pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* f.read("before_archive").pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* SessionPending.list(f.db, f.alpha.id)).toHaveLength(1)
      expect(wakes).toEqual([f.alpha.id])
    }
  }))
})

const sessionDelegated = Effect.gen(function* () {
  const f = yield* setup
  yield* f.create("session_source")
  const proposal = {
    sessionID: f.master.id, proposalID: "session_proposal", sourceExchangeID: "session_source", targetSessionID: f.alpha.id,
    basis: "session" as const, expectedAttachment: target, expiresAt: f.clock.now + 3_600_000,
    scope: { operations: ["task", "decision"] } as const,
  }
  const grant = yield* f.runtime.delegationCreate(proposal)
  const taskInput = {
    sessionID: f.master.id, remoteSource: source, exchangeID: "delegated_task", targetSessionID: f.alpha.id,
    expectedAttachment: target, channel: "task" as const, delivery: "queue" as const,
    delegation: { id: grant.id, revision: grant.revision }, instruction: { operation: "task" as const, text: "Inspect the synthetic delegated scope" },
  }
  return { ...f, proposal, grant, taskInput }
})

describe("session-basis delegated tasks and decisions", () => {
  it.live("approves a session grant with no current direct task and admits a delegated task exactly once", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    expect(f.approval.calls).toHaveLength(1)
    expect(f.approval.calls[0]).toMatchObject({ requireExplicitDecision: true, action: "dots_delegate" })
    expect(f.grant).toMatchObject({ basis: "session", targetSessionID: f.alpha.id, scope: { operations: ["task", "decision"] }, active: true })
    expect(f.grant).not.toHaveProperty("taskInputID")
    const status = yield* f.runtime.delegationStatus({ sessionID: f.master.id, targetSessionID: f.alpha.id, expectedAttachment: target })
    expect(status.tasks).toEqual([])
    expect(status.grants).toContainEqual(f.grant)
    const first = yield* f.runtime.create(f.taskInput)
    expect((yield* f.runtime.create(f.taskInput)).inputID).toBe(first.inputID)
    expect(wakes.filter((id) => id === f.alpha.id)).toHaveLength(2)
    const pending = (yield* SessionPending.list(f.db, f.alpha.id)).find((item) => item.id === first.inputID)
    expect(pending?.data.metadata?.inputOrigin).toBe("plugin")
    expect(pending?.data.text).toBe("Inspect the synthetic delegated scope")
    expect(pending?.data.metadata?.dotsExchange).toHaveProperty("delegated.instruction.operation", "task")
    expect(DotsPeer.resetsStepAllowance(pending!)).toBe(true)
    expect((yield* f.read("delegated_task")).decisions).toEqual([])
    expect((yield* f.runtime.create({ ...f.taskInput, delegation: { id: f.grant.id, revision: 99 } }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.runtime.create({ ...f.taskInput, exchangeID: "other_target", targetSessionID: f.beta.id }).pipe(Effect.exit))._tag).toBe("Failure")
  }))

  it.live("drops an unpromoted delegated task after revocation and keeps the next direct input", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    const queued = yield* f.runtime.create(f.taskInput)
    yield* f.runtime.delegationRevoke({ sessionID: f.master.id, id: f.grant.id, revision: f.grant.revision, expectedAttachment: target })
    expect((yield* f.runtime.create({ ...f.taskInput, exchangeID: "after_revoke" }).pipe(Effect.exit))._tag).toBe("Failure")
    const next = yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Next native task", delivery: "queue", resume: false })
    expect(yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)).toBe(true)
    expect(yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)).toBe(true)
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: queued.inputID })).toBeUndefined()
    expect(yield* f.sessions.message({ sessionID: f.alpha.id, messageID: next.id })).toBeDefined()
    expect((yield* f.read("delegated_task")).state).toBe("failed")
  }))

  it.live("lists only eligible candidates from this delegated task and settles by exact fingerprint once", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    yield* f.runtime.create(f.taskInput)
    const assistantMessageID = SessionMessage.ID.make("msg_delegated_step")
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    expect(yield* f.db.select().from(SessionProviderRequestTable).all()).toHaveLength(0)
    yield* f.sessions.prompt({ sessionID: f.alpha.id, text: "Later native task", delivery: "queue", resume: false })
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const laterAssistantMessageID = SessionMessage.ID.make("msg_later_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID: laterAssistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    const fingerprint = "f".repeat(64)
    f.decisionFake.pending.push(
      { kind: "permission", sessionID: f.alpha.id, requestID: "per_delegated", fingerprint, action: "edit", resources: ["src/a.ts"], sourceMessageID: assistantMessageID },
      { kind: "permission", sessionID: f.alpha.id, requestID: "per_explicit", fingerprint: "e".repeat(64), action: "edit", resources: ["src/explicit.ts"], metadata: { requireExplicitDecision: true }, sourceMessageID: assistantMessageID },
      { kind: "permission", sessionID: f.alpha.id, requestID: "per_other", fingerprint: "d".repeat(64), action: "edit", resources: ["src/other.ts"], sourceMessageID: "msg_someone_else" },
      { kind: "guardrail", sessionID: f.alpha.id, requestID: "grq_hard", fingerprint: "c".repeat(64), action: "shell", resources: ["synthetic"], ruleIDs: ["standard.hard.delete"], standard: true, hardReview: true, sourceMessageID: assistantMessageID },
      { kind: "permission", sessionID: f.alpha.id, requestID: "per_later", fingerprint: "b".repeat(64), action: "edit", resources: ["src/later.ts"], sourceMessageID: laterAssistantMessageID },
    )
    const read = yield* f.read("delegated_task")
    expect(read.decisions).toEqual([{ target: { kind: "permission", requestID: Permission.ID.create("per_delegated"), fingerprint }, action: "edit", resources: ["src/a.ts"] }])
    const decisionInput = { ...f.taskInput, exchangeID: "delegated_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_delegated"), fingerprint }, reply: "once" as const } }
    expect((yield* f.runtime.create({ ...decisionInput, exchangeID: "spoofed", instruction: { ...decisionInput.instruction, target: { kind: "permission" as const, requestID: Permission.ID.create("per_delegated"), fingerprint: "0".repeat(64) } } }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toHaveLength(0)
    const settled = yield* f.runtime.create(decisionInput)
    expect(settled.decisionOutcome).toMatchObject({ state: "settled", reply: "once" })
    expect(f.decisionFake.settled).toHaveLength(1)
    expect(f.decisionFake.settled[0]).not.toHaveProperty("explicitDecision")
    expect((yield* f.runtime.create(decisionInput)).decisionOutcome).toMatchObject({ state: "settled" })
    expect(f.decisionFake.settled).toHaveLength(1)
    expect((yield* f.read("delegated_decision")).decisionOutcome).toMatchObject({ state: "settled" })
    expect((yield* f.read("delegated_task")).decisions).toEqual([])
  }))

  it.live("settles a decision listed from the twenty-first delegated task by exact source association", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    for (let index = 1; index <= 21; index++) {
      yield* f.runtime.create({ ...f.taskInput, exchangeID: `numbered_task_${index}`, instruction: { operation: "task" as const, text: `Numbered delegated task ${index}` } })
      yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    }
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const assistantMessageID = SessionMessage.ID.make("msg_task21_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    const fingerprint = "1".repeat(64)
    f.decisionFake.pending.push({ kind: "permission", sessionID: f.alpha.id, requestID: "per_task21", fingerprint, action: "edit", resources: ["src/task21.ts"], sourceMessageID: assistantMessageID })
    expect((yield* f.read("numbered_task_21")).decisions).toEqual([{ target: { kind: "permission", requestID: Permission.ID.create("per_task21"), fingerprint }, action: "edit", resources: ["src/task21.ts"] }])
    expect((yield* f.read("numbered_task_20")).decisions).toEqual([])
    const settled = yield* f.runtime.create({ ...f.taskInput, exchangeID: "task21_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_task21"), fingerprint }, reply: "once" as const } })
    expect(settled.decisionOutcome).toMatchObject({ state: "settled", reply: "once" })
    expect(f.decisionFake.settled).toHaveLength(1)
  }))

  it.live("task-only scope cannot settle decisions and expiry ends future admissions", () => Effect.gen(function* () {
    const f = yield* setup
    yield* f.create("task_only_source")
    const grant = yield* f.runtime.delegationCreate({ sessionID: f.master.id, proposalID: "task_only", sourceExchangeID: "task_only_source", targetSessionID: f.alpha.id, basis: "session", expectedAttachment: target, expiresAt: f.clock.now + 60_000, scope: { operations: ["task"] } })
    const base = { sessionID: f.master.id, remoteSource: source, targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task" as const, delivery: "queue" as const, delegation: { id: grant.id, revision: grant.revision } }
    expect((yield* f.runtime.create({ ...base, exchangeID: "task_only_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_x"), fingerprint: "f".repeat(64) }, reply: "reject" as const } }).pipe(Effect.exit))._tag).toBe("Failure")
    f.clock.now += 60_001
    expect((yield* f.runtime.create({ ...base, exchangeID: "task_only_expired", instruction: { operation: "task" as const, text: "Too late" } }).pipe(Effect.exit))._tag).toBe("Failure")
  }))

  const realDelegated = Effect.gen(function* () {
    const f = yield* setup
    const runtime = f.makeReal()
    const alpha = yield* f.sessions.get(f.alpha.id)
    const agentID = Agent.ID.make(alpha.agent ?? "build")
    yield* f.agents.transform((editor) => editor.update(agentID, (agent) => { agent.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
    yield* f.create("real_source")
    yield* (yield* SessionAutonomy.Service).set({ sessionID: f.alpha.id, permissions: "manual", guardrails: "manual", answers: "manual" })
    const grant = yield* runtime.delegationCreate({ sessionID: f.master.id, proposalID: "real_session", sourceExchangeID: "real_source", targetSessionID: f.alpha.id, basis: "session", expectedAttachment: target, expiresAt: f.clock.now + 3_600_000, scope: { operations: ["task", "decision"] } })
    const base = { sessionID: f.master.id, remoteSource: source, targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task" as const, delivery: "queue" as const, delegation: { id: grant.id, revision: grant.revision } }
    yield* runtime.create({ ...base, exchangeID: "real_task", instruction: { operation: "task" as const, text: "Real delegated work" } })
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, runtime.promoteRoutine)
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, runtime.promoteRoutine)
    const assistantMessageID = SessionMessage.ID.make("msg_real_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    expect(yield* f.db.select().from(SessionProviderRequestTable).all()).toHaveLength(0)
    const until = <A, E>(effect: Effect.Effect<A | undefined, E>) => Effect.gen(function* (): Effect.fn.Return<A, E> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const value = yield* effect
        if (value !== undefined) return value
        yield* Effect.sleep("10 millis")
      }
      return yield* Effect.die(new Error("Timed out waiting for a native pending request"))
    })
    const decide = (exchangeID: string, instruction: Dots.DelegatedInstruction) => runtime.create({ ...base, exchangeID, instruction })
    const candidates = () => runtime.read({ sessionID: f.master.id, exchangeID: "real_task", remoteSource: source }).pipe(Effect.map((value) => value.decisions ?? []))

    return { f, runtime, grant, base, assistantMessageID, agentID, until, decide, candidates }
  })

  it.live("settles real native permission decisions from its own delegated task", () => Effect.gen(function* () {
    const { f, assistantMessageID, until, decide, candidates } = yield* realDelegated
    const onceFiber = yield* f.realPermission.assert({ id: Permission.ID.create("per_real_once"), sessionID: f.alpha.id, action: "edit", resources: ["src/a.ts"], source: { type: "tool", messageID: assistantMessageID, callID: "call_once" } }).pipe(Effect.forkScoped)
    const onceSnapshot = yield* until(f.realPermission.snapshot(Permission.ID.create("per_real_once")))
    expect((yield* candidates()).map((item) => item.target)).toContainEqual({ kind: "permission", requestID: Permission.ID.create("per_real_once"), fingerprint: onceSnapshot.fingerprint })
    yield* decide("real_decision_once", { operation: "decision", target: { kind: "permission", requestID: Permission.ID.create("per_real_once"), fingerprint: onceSnapshot.fingerprint }, reply: "once" })
    yield* Fiber.join(onceFiber)

    const rejectFiber = yield* f.realPermission.assert({ id: Permission.ID.create("per_real_reject"), sessionID: f.alpha.id, action: "edit", resources: ["src/b.ts"], source: { type: "tool", messageID: assistantMessageID, callID: "call_reject" } }).pipe(Effect.forkScoped)
    const rejectSnapshot = yield* until(f.realPermission.snapshot(Permission.ID.create("per_real_reject")))
    const unrelatedFiber = yield* f.realPermission.assert({ id: Permission.ID.create("per_real_unrelated"), sessionID: f.alpha.id, action: "edit", resources: ["src/unrelated.ts"], source: { type: "tool", messageID: assistantMessageID, callID: "call_unrelated" } }).pipe(Effect.forkScoped)
    yield* until(f.realPermission.snapshot(Permission.ID.create("per_real_unrelated")))
    yield* decide("real_decision_reject", { operation: "decision", target: { kind: "permission", requestID: Permission.ID.create("per_real_reject"), fingerprint: rejectSnapshot.fingerprint }, reply: "reject" })
    expect((yield* Fiber.join(rejectFiber).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* f.realPermission.snapshot(Permission.ID.create("per_real_unrelated"))).toBeDefined()
    yield* f.realPermission.reply({ requestID: Permission.ID.create("per_real_unrelated"), reply: "reject" })
    expect((yield* Fiber.join(unrelatedFiber).pipe(Effect.exit))._tag).toBe("Failure")

  }))

  it.live("settles real native question and form answers from its own delegated task", () => Effect.gen(function* () {
    const { f, assistantMessageID, until, decide, candidates } = yield* realDelegated
    const questionFiber = yield* f.realQuestions.ask({ sessionID: f.alpha.id, questions: [{ question: "Which branch?", header: "Branch", options: [{ label: "main", description: "Main branch" }], custom: false }], tool: { messageID: assistantMessageID, callID: "call_question" } }).pipe(Effect.forkScoped)
    const questionRequest = yield* until(f.realQuestions.list().pipe(Effect.map((items) => items[0])))
    const questionFingerprint = DotsExchange.questionFingerprint(questionRequest)
    expect((yield* candidates()).map((item) => item.target)).toContainEqual({ kind: "question", requestID: questionRequest.id, fingerprint: questionFingerprint })
    expect((yield* decide("real_question_invalid", { operation: "decision", target: { kind: "question", requestID: questionRequest.id, fingerprint: questionFingerprint }, answers: [["nope"]] }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* f.realQuestions.list()).toHaveLength(1)
    yield* decide("real_question_valid", { operation: "decision", target: { kind: "question", requestID: questionRequest.id, fingerprint: questionFingerprint }, answers: [["main"]] })
    expect((yield* Fiber.join(questionFiber)).status).toBe("answered")

    const freeFiber = yield* f.realQuestions.ask({ sessionID: f.alpha.id, questions: [{ question: "Name it", header: "Name", options: [] }], tool: { messageID: assistantMessageID, callID: "call_free" } }).pipe(Effect.forkScoped)
    const freeRequest = yield* until(f.realQuestions.list().pipe(Effect.map((items) => items[0])))
    yield* decide("real_question_free", { operation: "decision", target: { kind: "question", requestID: freeRequest.id, fingerprint: DotsExchange.questionFingerprint(freeRequest) }, answers: [["free text"]] })
    expect((yield* Fiber.join(freeFiber)).status).toBe("answered")

    const formID = Form.ID.create("frm_real")
    yield* f.realForms.create({ id: formID, sessionID: f.alpha.id, title: "Choose branch", fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe" }] }], metadata: { tool: { messageID: assistantMessageID, callID: "call_form" } } })
    const formSnapshot = yield* until(f.realForms.snapshot(formID))
    expect((yield* candidates()).map((item) => item.target)).toContainEqual({ kind: "form", formID, fingerprint: formSnapshot.fingerprint })
    expect((yield* decide("real_form_invalid", { operation: "decision", target: { kind: "form", formID, fingerprint: formSnapshot.fingerprint }, answers: { branch: "nope" } }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.realForms.state(formID)).status).toBe("pending")
    yield* decide("real_form_valid", { operation: "decision", target: { kind: "form", formID, fingerprint: formSnapshot.fingerprint }, answers: { branch: "safe" } })
    expect(yield* f.realForms.state(formID)).toEqual({ status: "answered", answer: { branch: "safe" } })

    const sensitiveID = Form.ID.create("frm_sensitive")
    yield* f.realForms.create({ id: sensitiveID, sessionID: f.alpha.id, title: "Credential", fields: [{ key: "api_key", type: "string", required: true }], metadata: { note: "password rotation", tool: { messageID: assistantMessageID, callID: "call_sensitive" } } })
    expect((yield* candidates()).map((item) => item.target.kind)).not.toContain("form")
    yield* f.realForms.cancel(sensitiveID)

  }))

  it.live("settles real ordinary guardrail decisions and excludes hard, denied, and revoked requests", () => Effect.gen(function* () {
    const { f, runtime, grant, assistantMessageID, agentID, until, decide, candidates } = yield* realDelegated
    const guardrailFiber = yield* f.realGuardrail.assert({ sessionID: f.alpha.id, action: "shell", resources: ["touch /outside/nested/file.txt"], source: { messageID: assistantMessageID, callID: "call_guardrail" } }).pipe(Effect.forkScoped)
    const guardrailSnapshot = yield* until(f.realGuardrail.requestSnapshots(f.alpha.id).pipe(Effect.map((items) => items[0])))
    expect(guardrailSnapshot.request.hardReview).not.toBe(true)
    expect((yield* candidates()).map((item) => item.target)).toContainEqual({ kind: "guardrail", requestID: guardrailSnapshot.request.id, fingerprint: guardrailSnapshot.fingerprint })
    yield* decide("real_guardrail_once", { operation: "decision", target: { kind: "guardrail", requestID: guardrailSnapshot.request.id, fingerprint: guardrailSnapshot.fingerprint }, reply: "once" })
    yield* (yield* Fiber.join(guardrailFiber)).release

    const hardFiber = yield* f.realGuardrail.assert({ sessionID: f.alpha.id, action: "shell", resources: ["rm -rf ."], source: { messageID: assistantMessageID, callID: "call_hard" } }).pipe(Effect.forkScoped)
    const hardSnapshot = yield* until(f.realGuardrail.requestSnapshots(f.alpha.id).pipe(Effect.map((items) => items[0])))
    expect(hardSnapshot.request.hardReview).toBe(true)
    expect((yield* candidates()).map((item) => item.target.kind)).not.toContain("guardrail")
    expect((yield* decide("real_guardrail_hard", { operation: "decision", target: { kind: "guardrail", requestID: hardSnapshot.request.id, fingerprint: hardSnapshot.fingerprint }, reply: "once" }).pipe(Effect.exit))._tag).toBe("Failure")
    yield* f.realGuardrail.reply({ sessionID: f.alpha.id, requestID: hardSnapshot.request.id, reply: "reject" })
    expect((yield* Fiber.join(hardFiber).pipe(Effect.exit))._tag).toBe("Failure")

    const denyFiber = yield* f.realPermission.assert({ id: Permission.ID.create("per_real_deny"), sessionID: f.alpha.id, action: "edit", resources: ["src/denied.ts"], source: { type: "tool", messageID: assistantMessageID, callID: "call_deny" } }).pipe(Effect.forkScoped)
    const denySnapshot = yield* until(f.realPermission.snapshot(Permission.ID.create("per_real_deny")))
    yield* f.agents.transform((editor) => editor.update(agentID, (agent) => { agent.permissions = [{ action: "*", resource: "*", effect: "ask" }, { action: "edit", resource: "src/denied.ts", effect: "deny" }] }))
    expect((yield* candidates()).map((item) => item.target.kind)).not.toContain("permission")
    expect((yield* decide("real_decision_deny", { operation: "decision", target: { kind: "permission", requestID: Permission.ID.create("per_real_deny"), fingerprint: denySnapshot.fingerprint }, reply: "once" }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* f.realPermission.snapshot(Permission.ID.create("per_real_deny"))).toBeDefined()
    yield* f.agents.transform((editor) => editor.update(agentID, (agent) => { agent.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
    yield* f.realPermission.reply({ requestID: Permission.ID.create("per_real_deny"), reply: "reject" })
    expect((yield* Fiber.join(denyFiber).pipe(Effect.exit))._tag).toBe("Failure")

    const revokeFiber = yield* f.realPermission.assert({ id: Permission.ID.create("per_real_revoke"), sessionID: f.alpha.id, action: "edit", resources: ["src/c.ts"], source: { type: "tool", messageID: assistantMessageID, callID: "call_revoke" } }).pipe(Effect.forkScoped)
    const revokeSnapshot = yield* until(f.realPermission.snapshot(Permission.ID.create("per_real_revoke")))
    yield* runtime.delegationRevoke({ sessionID: f.master.id, id: grant.id, revision: grant.revision, expectedAttachment: target })
    expect((yield* decide("real_decision_revoked", { operation: "decision", target: { kind: "permission", requestID: Permission.ID.create("per_real_revoke"), fingerprint: revokeSnapshot.fingerprint }, reply: "once" }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(yield* f.realPermission.snapshot(Permission.ID.create("per_real_revoke"))).toBeDefined()
    yield* f.realPermission.reply({ requestID: Permission.ID.create("per_real_revoke"), reply: "reject" })
    expect((yield* Fiber.join(revokeFiber).pipe(Effect.exit))._tag).toBe("Failure")
  }))

  it.live("a nonexistent decision target fails before any exchange is recorded", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    const input = { ...f.taskInput, exchangeID: "missing_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_missing"), fingerprint: "f".repeat(64) }, reply: "once" as const } }
    expect((yield* f.runtime.create(input).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.read("missing_decision").pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toHaveLength(0)
  }))

  it.live("a second anchor reusing the exchange ID and proposal ID inherits neither receipt nor task association", () => Effect.gen(function* () {
    const f = yield* setup
    const master2 = yield* f.sessions.create({ location: { directory: AbsolutePath.make(tmpdir()) }, title: "Master two" })
    const grantFor = (anchorID: Session.ID, sourceExchangeID: string) => f.runtime.delegationCreate({
      sessionID: anchorID, proposalID: "shared_proposal", sourceExchangeID, targetSessionID: f.alpha.id,
      basis: "session", expectedAttachment: target, expiresAt: f.clock.now + 3_600_000, scope: { operations: ["task", "decision"] },
    })
    yield* f.runtime.create({ sessionID: f.master.id, remoteSource: source, exchangeID: "anchor_a_source", targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task", delivery: "queue", text: "Anchor A source" })
    yield* f.runtime.create({ sessionID: master2.id, remoteSource: source, exchangeID: "anchor_b_source", targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task", delivery: "queue", text: "Anchor B source" })
    const grantA = yield* grantFor(f.master.id, "anchor_a_source")
    const grantB = yield* grantFor(master2.id, "anchor_b_source")
    expect(grantA.id).toBe(grantB.id)
    const baseFor = (anchorID: Session.ID, grant: Dots.DelegationInfo) => ({ sessionID: anchorID, remoteSource: source, targetSessionID: f.alpha.id, expectedAttachment: target, channel: "task" as const, delivery: "queue" as const, delegation: { id: grant.id, revision: grant.revision } })
    yield* f.runtime.create({ ...baseFor(f.master.id, grantA), exchangeID: "anchor_a_task", instruction: { operation: "task" as const, text: "Anchor A task" } })
    for (let index = 0; index < 3; index++) yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const assistantMessageID = SessionMessage.ID.make("msg_anchor_a_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    const fingerprintA = "a".repeat(64)
    f.decisionFake.pending.push({ kind: "permission", sessionID: f.alpha.id, requestID: "per_anchor_a", fingerprint: fingerprintA, action: "edit", resources: ["src/a.ts"], sourceMessageID: assistantMessageID })
    expect((yield* f.runtime.create({ ...baseFor(master2.id, grantB), exchangeID: "foreign_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_anchor_a"), fingerprint: fingerprintA }, reply: "once" as const } }).pipe(Effect.exit))._tag).toBe("Failure")
    expect(f.decisionFake.settled).toHaveLength(0)
    const settledA = yield* f.runtime.create({ ...baseFor(f.master.id, grantA), exchangeID: "shared_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_anchor_a"), fingerprint: fingerprintA }, reply: "once" as const } })
    expect(settledA.decisionOutcome).toMatchObject({ state: "settled" })
    yield* f.runtime.create({ ...baseFor(master2.id, grantB), exchangeID: "anchor_b_task", instruction: { operation: "task" as const, text: "Anchor B task" } })
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const assistantB = SessionMessage.ID.make("msg_anchor_b_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID: assistantB, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    const fingerprintB = "b".repeat(64)
    f.decisionFake.pending.push({ kind: "permission", sessionID: f.alpha.id, requestID: "per_anchor_b", fingerprint: fingerprintB, action: "edit", resources: ["src/b.ts"], sourceMessageID: assistantB })
    f.decisionFake.fail = true
    expect((yield* f.runtime.create({ ...baseFor(master2.id, grantB), exchangeID: "shared_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_anchor_b"), fingerprint: fingerprintB }, reply: "once" as const } }).pipe(Effect.exit))._tag).toBe("Failure")
    f.decisionFake.fail = false
    const readB = yield* f.runtime.read({ sessionID: master2.id, exchangeID: "shared_decision", remoteSource: source })
    expect(readB.decisionOutcome).toMatchObject({ state: "pending" })
    expect(f.decisionFake.settled).toHaveLength(1)
  }))

  it.live("a stale form candidate cannot settle when the actual form source or metadata requires an explicit decision", () => Effect.gen(function* () {
    const f = yield* setup
    const services = DotsExchange.decisionServices({ permission: f.realPermission, guardrail: f.realGuardrail, forms: f.realForms, questions: f.realQuestions })
    const formID = Form.ID.create()
    yield* f.realForms.create({ id: formID, sessionID: f.alpha.id, title: "Choose branch", fields: [{ key: "branch", type: "string", required: true, options: [{ value: "safe", label: "Safe" }] }], metadata: { requireExplicitDecision: true, tool: { messageID: "msg_actual_form_source", callID: "call_stale_form" } } })
    const snapshot = yield* f.realForms.snapshot(formID)
    if (!snapshot) return yield* Effect.die("stale form snapshot was not retained")
    const source = { kind: "dots-delegation" as const, anchorSessionID: f.master.id, delegationID: "stale_form_grant", revision: 1, exchangeID: "stale_form_decision" }
    const staleSource: DotsExchange.PendingDecision = { kind: "form", sessionID: f.alpha.id, formID, fingerprint: snapshot.fingerprint, title: snapshot.form.title, fields: snapshot.form.fields, sourceMessageID: "msg_stale_form_source" }
    expect((yield* services.settle({ pending: staleSource, choice: { answers: { branch: "safe" } }, source, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.realForms.state(formID)).status).toBe("pending")
    const staleMetadata: DotsExchange.PendingDecision = { kind: "form", sessionID: f.alpha.id, formID, fingerprint: snapshot.fingerprint, title: snapshot.form.title, fields: snapshot.form.fields, sourceMessageID: "msg_actual_form_source" }
    expect((yield* services.settle({ pending: staleMetadata, choice: { answers: { branch: "safe" } }, source, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
    expect((yield* f.realForms.state(formID)).status).toBe("pending")
    yield* f.realForms.cancel(formID)
  }))

  it.live("effect-then-throw settlement reconciles by receipt read without blind replay", () => Effect.gen(function* () {
    const f = yield* sessionDelegated
    yield* f.runtime.create(f.taskInput)
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    yield* SessionPending.promoteNextQueued(f.db, f.events, f.alpha.id, undefined, undefined, f.runtime.promoteRoutine)
    const assistantMessageID = SessionMessage.ID.make("msg_unknown_step")
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.alpha.id, assistantMessageID, agent: Agent.ID.make("build"), model: Model.Ref.make({ providerID: Provider.ID.make("fixture"), id: Model.ID.make("fixture") }) })
    const fingerprint = "f".repeat(64)
    f.decisionFake.pending.push({ kind: "permission", sessionID: f.alpha.id, requestID: "per_unknown", fingerprint, action: "edit", resources: ["src/u.ts"], sourceMessageID: assistantMessageID })
    const input = { ...f.taskInput, exchangeID: "unknown_decision", instruction: { operation: "decision" as const, target: { kind: "permission" as const, requestID: Permission.ID.create("per_unknown"), fingerprint }, reply: "once" as const } }
    f.decisionFake.defect = true
    const failed = yield* f.runtime.create(input).pipe(Effect.exit)
    expect(failed._tag).toBe("Failure")
    if (failed._tag === "Failure") expect(Cause.squash(failed.cause)).toMatchObject({ code: "exchange_outcome_unknown" })
    expect(f.decisionFake.settled).toHaveLength(1)
    expect((yield* f.read("unknown_decision")).decisionOutcome).toMatchObject({ state: "settled" })
    f.decisionFake.defect = false
    expect((yield* f.runtime.create(input)).decisionOutcome).toMatchObject({ state: "settled" })
    expect(f.decisionFake.settled).toHaveLength(1)
  }))
})
