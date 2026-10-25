import { describe, expect } from "bun:test"
import { tmpdir } from "node:os"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Agent } from "@ycoding-ai/schema/agent"
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
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionPending } from "../src/session/pending"
import { SessionProjector } from "../src/session/projector"
import { SessionProviderRequestTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const wakes: Session.ID[] = []
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.succeed(new Set<Session.ID>()),
  wake: () => Effect.void,
  interrupt: () => Effect.void,
})
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventRuntime.node, SessionProjector.node, Session.node,
  SessionExecution.node, SessionOrchestration.node, CoordinationService.node,
]), [[SessionExecution.node, execution]]))

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
  const location = { directory: AbsolutePath.make(tmpdir()) }
  const master = yield* sessions.create({ location, title: "Master" })
  const alpha = yield* sessions.create({ location, title: "Alpha" })
  const beta = yield* sessions.create({ location, title: "Beta" })
  const outsider = yield* sessions.create({ location, title: "Outside" })
  const group = yield* coordination.create({ name: "Fixture", masterSessionID: master.id, memberSessionIDs: [alpha.id, beta.id] })
  yield* coordination.activate(group.id)
  const attachment = { target, accountDigest: "a".repeat(64) }
  const authorization = { enabled: true, calls: 0, grantID: "grant_fixture" }
  const hooks: { attachment?: () => void; message?: () => void; wake?: () => void; authorize?: () => Effect.Effect<void> } = {}
  const make = () => DotsExchange.make({
    db, events, sessions: { get: sessions.get, message: (input) => sessions.message(input).pipe(Effect.tap(() => Effect.sync(() => hooks.message?.()))) }, coordination,
    execution: { active: Effect.succeed(new Set<Session.ID>()), wake: (id) => Effect.sync(() => { wakes.push(id); hooks.wake?.() }) },
    attachment: () => Effect.sync(() => { hooks.attachment?.(); return attachment }),
    authorize: (context) => Effect.suspend(() => hooks.authorize?.() ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => {
      authorization.calls++
      if (!authorization.enabled || context.epoch !== source.epoch || context.principal.deviceID !== source.principal.deviceID)
        throw new Error("Unauthorized synthetic invocation")
      return { ...context.principal, epoch: context.epoch, grantID: authorization.grantID }
    }))),
    checkStored: (principal) => Effect.sync(() => {
      if (!authorization.enabled || principal.grantID !== authorization.grantID) throw new Error("Revoked synthetic grant")
    }),
  })
  const runtime = make()
  const create = (exchangeID: string, targetSessionID = alpha.id, text = "Investigate the synthetic module") => runtime.create({
    sessionID: master.id, remoteSource: source, exchangeID, targetSessionID,
    expectedAttachment: target, channel: "task", delivery: "queue", text,
  })
  const read = (exchangeID: string) => runtime.read({ sessionID: master.id, exchangeID, remoteSource: source })
  return { sessions, db, events, coordination, master, alpha, beta, outsider, group, attachment, authorization, hooks, make, runtime, create, read }
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
