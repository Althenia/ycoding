import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream, Schema } from "effect"
import { LLMClient, LLMError, LLMEvent, TransportReason, type LLMRequest, type LLMClientShape } from "@ycoding-ai/ai"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Session } from "../src/session"
import { SessionOrchestration } from "../src/session/orchestration"
import { SessionExecution } from "../src/session/execution"
import { SessionStepBoundary } from "../src/session/step-boundary"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionPending } from "../src/session/pending"
import { SessionTaskTable, SessionTable } from "../src/session/sql"
import { EventRuntime } from "../src/event"
import { Database } from "../src/database/database"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { Catalog } from "../src/catalog"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { Agent } from "../src/agent"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { AbsolutePath } from "../src/schema"
import { eq } from "drizzle-orm"
import { fixtureModels } from "./lib/models"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const provider = Provider.ID.make("selection-fixture")
const old = CatalogModel.Ref.make({ providerID: provider, id: CatalogModel.ID.make("original"), variant: CatalogModel.VariantID.make("high") })
const target = CatalogModel.Ref.make({ ...old, id: CatalogModel.ID.make("target") })
const requests: LLMRequest[] = []
let response = (_request: LLMRequest): Stream.Stream<LLMEvent, LLMError> => Stream.make(
  LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: "text" }), LLMEvent.textDelta({ id: "text", text: "Finished" }), LLMEvent.textEnd({ id: "text" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" }),
)
const client = Layer.succeed(LLMClient.Service, LLMClient.Service.of({
  prepare: () => Effect.die("Unexpected prepare"),
  stream: ((request: LLMRequest) => { requests.push(request); return response(request) }) as LLMClientShape["stream"],
  generate: () => Effect.die("Unexpected helper request"),
}))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, Credential.node, LocationServiceMap.node, Session.node, SessionOrchestration.node, SessionExecution.node, SessionStepBoundary.node]), [
  fixtureModels, [LayerNodePlatform.llmClient, client],
]))

const fixture = Effect.fn(function* () {
  const directory = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), value => Effect.promise(() => value[Symbol.asyncDispose]()))
  const sessions = yield* Session.Service
  const events = yield* EventRuntime.Service
  const db = (yield* Database.Service).db
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
  const locations = yield* LocationServiceMap.Service
  yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
    const catalog = yield* Catalog.Service
    yield* catalog.transform(draft => {
      draft.provider.update(provider, item => { item.package = Provider.aisdk("@ai-sdk/openai") })
      for (const model of [old, target]) draft.model.update(provider, model.id, item => {
        item.limit = { context: 128_000, output: 4096 }
        item.capabilities = { tools: true, input: ["text"], output: ["text"] }
        item.variants = [{ id: CatalogModel.VariantID.make("high") }]
      })
      draft.model.update(provider, CatalogModel.ID.make("tiny"), item => {
        item.limit = { context: 1, output: 1 }
      })
      draft.model.update(provider, CatalogModel.ID.make("small"), item => {
        item.limit = { context: 5000, output: 512 }
      })
    })
  }).pipe(Effect.provide(locations.get(location)))
  const parent = yield* sessions.create({ location, model: old })
  const child = yield* sessions.create({ parentID: parent.id, model: old, agent: Agent.ID.make("omoikane") })
  const assistant = SessionMessage.ID.create()
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: {
    type: "launched", parentID: parent.id, parentAssistantMessageID: assistant, toolCallID: "launch", inputID: SessionMessage.ID.create(),
    description: "Selection fixture", agent: Agent.ID.make("omoikane"), model: old, promptDigest: "fixture", background: true, delivery: "steer",
  } })
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  const orchestration = yield* SessionOrchestration.Service
  const select = (model = target, expectedModel = old) => orchestration.switchModel({
    parentID: parent.id, childID: child.id, expectedModel, model, source: { type: "native" },
  })
  return { sessions, events, db, parent, child, orchestration, select, locations }
})

it.live("idle child selection preserves task state, launch identity and authoritative reads", () => Effect.gen(function* () {
  const f = yield* fixture()
  const before = yield* f.orchestration.get(f.parent.id, f.child.id)
  const selected = yield* f.select()
  expect(selected.model).toEqual(target)
  expect(selected.state).toBe(before.state)
  expect((yield* f.sessions.get(f.child.id)).permissionCeiling).toEqual(f.child.permissionCeiling)
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(target)
  expect((yield* f.orchestration.list(f.parent.id))[0]?.model).toEqual(target)
  expect((yield* f.orchestration.page({ parentID: f.parent.id })).data[0]?.model).toEqual(target)
  expect((yield* f.orchestration.teamView(f.parent.id)).view.children[0]?.model).toEqual(target)
  expect((yield* f.db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, f.child.id)).get().pipe(Effect.orDie))?.model).toEqual(old)
  const execution = yield* SessionExecution.Service
  expect((yield* execution.active).has(f.child.id)).toBe(false)
  expect((yield* f.sessions.pending(f.child.id))).toEqual([])
}))

it.live("ownership, CAS and invalid targets fail without changing either selection", () => Effect.gen(function* () {
  const f = yield* fixture()
  const foreign = yield* f.sessions.create({ location: f.parent.location, model: old })
  for (const childID of [f.parent.id, foreign.id, Session.ID.make("ses_missing")]) {
    expect((yield* Effect.exit(f.orchestration.switchModel({ parentID: f.parent.id, childID, model: target, expectedModel: old, source: { type: "native" } })))._tag).toBe("Failure")
  }
  for (const model of [
    { ...target, id: CatalogModel.ID.make("missing") },
    { ...target, variant: CatalogModel.VariantID.make("missing") },
    { ...target, profile: "Missing" },
    { ...target, id: CatalogModel.ID.make("tiny"), variant: undefined },
  ]) {
    expect((yield* Effect.exit(f.select(model)))._tag).toBe("Failure")
    expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  }
  yield* f.select()
  expect((yield* Effect.exit(f.select(old)))._tag).toBe("Failure")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(target)
}))

it.live("remote, plugin and unknown tool causal inputs cannot select a child model", () => Effect.gen(function* () {
  const f = yield* fixture()
  for (const origin of ["plugin", "coordination", undefined] as const) {
    const inputID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.InputAdmitted, { sessionID: f.parent.id, inputID, input: SessionPending.Message.make({
      type: "user", data: { text: "Select target", files: [], agents: [], ...(origin ? { metadata: { inputOrigin: origin } } : {}) }, delivery: "steer",
    }) })
    yield* SessionPending.promoteSteers(f.db, f.events, f.parent.id)
    const messageID = SessionMessage.ID.create()
    yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.parent.id, assistantMessageID: messageID, agent: Agent.ID.make("build"), model: old })
    expect((yield* Effect.exit(f.orchestration.switchModel({ parentID: f.parent.id, childID: f.child.id, expectedModel: old, model: target, source: { type: "tool", agent: Agent.ID.make("omoikane"), messageID, callID: "select" } })))._tag).toBe("Failure")
    expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  }
}))

it.live("waiting, completed and cancelled children keep their lifecycle and pending work", () => Effect.gen(function* () {
  for (const change of [
    { type: "question_asked" as const, question: { id: QuestionID.make("qst_selection"), text: "Continue?", time: 1 } },
    { type: "completed" as const }, { type: "cancelled" as const },
  ]) {
    const f = yield* fixture()
    if (change.type === "cancelled") yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: f.child.id, change: { type: "cancel_requested" } })
    yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: f.child.id, change })
    const before = yield* f.orchestration.get(f.parent.id, f.child.id)
    const selected = yield* f.select()
    expect(selected.state).toBe(before.state)
    expect(selected.question).toEqual(before.question)
    expect((yield* f.sessions.pending(f.child.id))).toEqual([])
  }
}))

it.live("foreign claims, archived children and changed models reject without altering selection", () => Effect.gen(function* () {
  const f = yield* fixture()
  yield* f.db.update(SessionTaskTable).set({ owner_pid: process.pid + 1, owner_started: "foreign" }).where(eq(SessionTaskTable.session_id, f.child.id)).run().pipe(Effect.orDie)
  expect((yield* Effect.exit(f.select()))._tag).toBe("Failure")
  yield* f.db.update(SessionTaskTable).set({ owner_pid: null, owner_started: null }).where(eq(SessionTaskTable.session_id, f.child.id)).run().pipe(Effect.orDie)
  yield* f.db.update(SessionTable).set({ time_archived: 1 }).where(eq(SessionTable.id, f.child.id)).run().pipe(Effect.orDie)
  expect((yield* Effect.exit(f.select()))._tag).toBe("Failure")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
}))

it.live("cancelling a waiting selection releases the transition and cannot commit later", () => Effect.gen(function* () {
  const f = yield* fixture()
  const gate = yield* SessionStepBoundary.Service
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const step = yield* gate.withStep(f.child.id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const switching = yield* f.select().pipe(Effect.forkChild)
  yield* Effect.yieldNow
  yield* Fiber.interrupt(switching)
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(step)
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  expect((yield* f.select()).model).toEqual(target)
}))

it.live("busy child finishes its real provider Step before selection and keeps its task identity", () => Effect.gen(function* () {
  const f = yield* fixture()
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const original = response
  response = request => Stream.unwrap(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(original(request))))
  yield* Effect.addFinalizer(() => Effect.sync(() => { response = original }))
  yield* f.sessions.prompt({ sessionID: f.child.id, text: "Finish this task", resume: false })
  const execution = yield* SessionExecution.Service
  const running = yield* execution.resume(f.child.id).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const switching = yield* f.select().pipe(Effect.forkChild)
  yield* Effect.yieldNow
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  yield* Deferred.succeed(release, undefined)
  expect((yield* Fiber.join(switching)).model).toEqual(target)
  yield* Fiber.join(running)
  expect((yield* f.sessions.messages({ sessionID: f.child.id })).some(message => message.type === "assistant" && message.model.id === old.id && message.time.completed !== undefined)).toBe(true)
  expect((yield* f.sessions.get(f.child.id)).id).toBe(f.child.id)
}))

it.live("the real runner settles the current tool before its next provider Step uses the target", () => Effect.gen(function* () {
  const f = yield* fixture()
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(f.locations.get(f.child.location)))
  yield* registry.register({ selection_hold: Tool.make({
      description: "Hold a test Step", input: Schema.Struct({}), output: Schema.String,
      execute: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("settled")),
    }) }, { codemode: false })
  yield* Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform(draft => draft.update(Agent.ID.make("omoikane"), agent => { agent.permissions = [{ action: "*", resource: "*", effect: "allow" }] }))
  }).pipe(Effect.provide(f.locations.get(f.child.location)))
  const original = response
  const state = { first: true }
  const sent: string[] = []
  response = request => {
    sent.push(request.model.id)
    if (!state.first) return original(request)
    state.first = false
    return Stream.make(LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "hold_call", name: "selection_hold", input: {} }), LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" }))
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => { response = original }))
  yield* f.sessions.prompt({ sessionID: f.child.id, text: "Use selection_hold, then finish", resume: false })
  const execution = yield* SessionExecution.Service
  const running = yield* execution.resume(f.child.id).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const switching = yield* f.select().pipe(Effect.forkChild)
  yield* Effect.yieldNow
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(switching)
  yield* Fiber.join(running)
  expect(sent).toEqual([old.id, target.id])
}).pipe(Effect.timeout("15 seconds")), 20000)

it.live("physical retries retain the Step model while child selection waits", () => Effect.gen(function* () {
  const f = yield* fixture()
  const entered = yield* Deferred.make<void>()
  const original = response
  const sent: string[] = []
  response = request => {
    sent.push(request.model.id)
    if (sent.length > 1) return original(request)
    return Stream.fromEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.fail(new LLMError({
      module: "fixture", method: "stream", reason: new TransportReason({ message: "Fixture read failure", kind: "read" }),
    })))))
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => { response = original }))
  yield* f.sessions.prompt({ sessionID: f.child.id, text: "Complete after retry", resume: false })
  const execution = yield* SessionExecution.Service
  const running = yield* execution.resume(f.child.id).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const switching = yield* f.select().pipe(Effect.forkChild)
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  yield* Fiber.join(running)
  expect((yield* Fiber.join(switching)).model).toEqual(target)
  expect(sent).toEqual([old.id, old.id])
}).pipe(Effect.timeout("15 seconds")), 20000)

it.live("named selection keeps its private binding through activation and refuses account replacement", () => Effect.gen(function* () {
  const f = yield* fixture()
  const credentials = yield* Credential.Service
  const integrations = yield* Integration.Service.pipe(Effect.provide(f.locations.get(f.child.location)))
  yield* integrations.transform(draft => draft.update(Integration.ID.make(provider), info => { info.name = "Fixture provider" }))
  const work = yield* credentials.create({ integrationID: Integration.ID.make(provider), label: "Work", value: Credential.Key.make({ type: "key", key: "synthetic-work-key" }) })
  const personal = yield* credentials.create({ integrationID: Integration.ID.make(provider), label: "Personal", value: Credential.Key.make({ type: "key", key: "synthetic-personal-key" }) })
  const selected = CatalogModel.Ref.make({ ...old, profile: "Work" })
  const next = CatalogModel.Ref.make({ ...target, profile: "Work" })
  yield* f.sessions.switchModel({ sessionID: f.child.id, model: selected })
  const before = yield* f.db.select({ binding: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, f.child.id)).get().pipe(Effect.orDie)
  yield* credentials.activate(personal.id)
  expect((yield* f.select(next, selected)).model).toEqual(next)
  expect(yield* f.db.select({ binding: SessionTable.profile_binding }).from(SessionTable).where(eq(SessionTable.id, f.child.id)).get().pipe(Effect.orDie)).toEqual(before)
  yield* credentials.update(work.id, { value: Credential.Key.make({ type: "key", key: "synthetic-replacement-key" }) })
  expect((yield* Effect.exit(f.select(selected, next)))._tag).toBe("Failure")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(next)
}))

it.live("known selection failures carry nonempty diagnostic messages", () => Effect.gen(function* () {
  const f = yield* fixture()
  const missing = yield* f.orchestration.switchModel({ parentID: f.parent.id, childID: Session.ID.make("ses_missing"), model: target, expectedModel: old, source: { type: "native" } }).pipe(Effect.flip)
  expect(missing._tag).toBe("SessionOrchestration.NotFoundError")
  expect(missing.message).toContain("ses_missing")
  const foreign = yield* f.sessions.create({ location: f.parent.location, model: old })
  const forbidden = yield* f.orchestration.switchModel({ parentID: f.parent.id, childID: foreign.id, model: target, expectedModel: old, source: { type: "native" } }).pipe(Effect.flip)
  expect(forbidden._tag).toBe("SessionOrchestration.ForbiddenError")
  expect(forbidden.message).toContain(foreign.id)
  yield* f.sessions.prompt({ sessionID: f.child.id, text: "large retained history ".repeat(1000), resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.child.id)
  const blocked = yield* f.select(CatalogModel.Ref.make({ ...target, id: CatalogModel.ID.make("small"), variant: undefined })).pipe(Effect.flip)
  expect(blocked._tag).toBe("SessionOrchestration.ModelBlockedError")
  expect(blocked.message).toContain("context")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
}))

it.live("context-fit refusal leaves canonical messages and selection unchanged", () => Effect.gen(function* () {
  const f = yield* fixture()
  yield* f.sessions.prompt({ sessionID: f.child.id, text: "large retained history ".repeat(1000), resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.child.id)
  const before = yield* f.sessions.messages({ sessionID: f.child.id })
  const result = yield* Effect.exit(f.select(CatalogModel.Ref.make({ ...target, id: CatalogModel.ID.make("small"), variant: undefined })))
  expect(result._tag).toBe("Failure")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(old)
  expect(yield* f.sessions.messages({ sessionID: f.child.id })).toEqual(before)
}))

it.live("verified native tool input can select a child under current delegation permission", () => Effect.gen(function* () {
  const f = yield* fixture()
  yield* f.sessions.prompt({ sessionID: f.parent.id, text: "Select the child model", resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.parent.id)
  const messageID = SessionMessage.ID.create()
  yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.parent.id, assistantMessageID: messageID, agent: Agent.ID.make("gsd"), model: old })
  const agents = yield* Agent.Service.pipe(Effect.provide(f.locations.get(f.parent.location)))
  yield* agents.transform(draft => draft.update(Agent.ID.make("gsd"), agent => { agent.permissions = [{ action: "subagent", resource: "*", effect: "allow" }] }))
  expect((yield* f.orchestration.switchModel({ parentID: f.parent.id, childID: f.child.id, expectedModel: old, model: target,
    source: { type: "tool", agent: Agent.ID.make("gsd"), messageID, callID: "select" } })).model).toEqual(target)
}))

for (const canonical of [true, false]) it.live(`${canonical ? "canonical" : "forged"} TeamView preserves only durable native authority`, () => Effect.gen(function* () {
  const f = yield* fixture()
  yield* f.sessions.prompt({ sessionID: f.parent.id, text: "Select the child model", resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.parent.id)
  if (canonical) yield* f.events.publish(SessionEvent.ContextObserved, { sessionID: f.parent.id, source: "team-view", text: "TeamView fixture" })
  if (!canonical) yield* f.events.publish(SessionEvent.Synthetic, { sessionID: f.parent.id, text: "TeamView fixture", metadata: { contextSource: "team-view" } })
  const messageID = SessionMessage.ID.create()
  yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.parent.id, assistantMessageID: messageID, agent: Agent.ID.make("gsd"), model: old })
  const agents = yield* Agent.Service.pipe(Effect.provide(f.locations.get(f.parent.location)))
  yield* agents.transform(draft => draft.update(Agent.ID.make("gsd"), agent => { agent.permissions = [{ action: "subagent", resource: "*", effect: "allow" }] }))
  const selected = yield* Effect.exit(f.orchestration.switchModel({ parentID: f.parent.id, childID: f.child.id, expectedModel: old, model: target,
    source: { type: "tool", agent: Agent.ID.make("gsd"), messageID, callID: "select" } }))
  expect(selected._tag).toBe(canonical ? "Success" : "Failure")
  expect((yield* f.sessions.get(f.child.id)).model).toEqual(canonical ? target : old)
}))

it.live("an actual later send cannot borrow the child's native launch authority", () => Effect.gen(function* () {
  const f = yield* fixture()
  const launched = yield* f.db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, f.child.id)).get().pipe(Effect.orDie)
  if (!launched) return yield* Effect.die("Missing fixture task")
  yield* f.sessions.prompt({ sessionID: f.parent.id, text: "Native launch", resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.parent.id)
  yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.parent.id, assistantMessageID: launched.parent_assistant_message_id, agent: Agent.ID.make("gsd"), model: old })
  yield* f.sessions.prompt({ sessionID: f.child.id, id: launched.input_id, origin: "subagent", text: "Initial native child task", resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.child.id)
  const grandchild = yield* f.sessions.create({ parentID: f.child.id, model: old })
  yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: grandchild.id, change: {
    type: "launched", parentID: f.child.id, parentAssistantMessageID: SessionMessage.ID.create(), toolCallID: "grandchild", inputID: SessionMessage.ID.create(),
    description: "Grandchild", agent: Agent.ID.make("omoikane"), model: old, promptDigest: "grandchild", background: true, delivery: "steer",
  } })
  yield* f.events.publish(SessionEvent.Task.Updated, { sessionID: grandchild.id, change: { type: "started" } })
  yield* f.sessions.prompt({ sessionID: f.parent.id, origin: "plugin", text: "Untrusted follow-up", resume: false })
  yield* SessionPending.promoteSteers(f.db, f.events, f.parent.id)
  const sending = SessionMessage.ID.create()
  yield* f.events.publish(SessionEvent.Step.Started, { sessionID: f.parent.id, assistantMessageID: sending, agent: Agent.ID.make("gsd"), model: old })
  const sentID = SessionMessage.ID.create()
  yield* f.orchestration.send({ parentID: f.parent.id, childID: f.child.id, messageID: sentID, text: "Later untrusted send", delivery: "steer" })
  const execution = yield* SessionExecution.Service
  yield* execution.awaitIdle(f.child.id)
  const messages = yield* f.sessions.messages({ sessionID: f.child.id })
  expect(messages.find(message => message.id === sentID)).toMatchObject({ type: "synthetic", text: expect.stringContaining("Later untrusted send") })
  const assistant = [...messages].reverse().find(message => message.type === "assistant")
  if (!assistant) return yield* Effect.die("Expected the send to produce a real assistant Step")
  const agents = yield* Agent.Service.pipe(Effect.provide(f.locations.get(f.child.location)))
  yield* agents.transform(draft => draft.update(assistant.agent, agent => { agent.permissions = [{ action: "subagent", resource: "*", effect: "allow" }] }))
  const result = yield* Effect.exit(f.orchestration.switchModel({ parentID: f.child.id, childID: grandchild.id, expectedModel: old, model: target,
    source: { type: "tool", agent: assistant.agent, messageID: assistant.id, callID: "select-after-send" } }))
  expect(result._tag).toBe("Failure")
  expect((yield* f.sessions.get(grandchild.id)).model).toEqual(old)
}).pipe(Effect.timeout("15 seconds")), 20000)
