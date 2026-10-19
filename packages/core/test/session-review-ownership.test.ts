import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Hash } from "@ycoding-ai/core/util/hash"
import { SessionPendingTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Question, QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { SessionReview as SessionReviewSchema } from "@ycoding-ai/schema/session-review"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Config } from "@ycoding-ai/core/config"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { SubagentControlTool } from "@ycoding-ai/core/tool/subagent-control"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { Tools } from "@ycoding-ai/core/tool/tools"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(reviewLayer())

for (const change of ["action", "child", "payload", "launch-prompt", "launch-model"] as const) it.effect(`subagent permission grants bind ${change} and permit an identical re-issue`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  const caller = Agent.ID.make("review-subagent")
  yield* agents.transform((draft) => draft.update(caller, (agent) => { agent.permissions = [] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const send = { action: "send", sessionID: "ses_child_a", text: "Approved input", delivery: "steer" }
  const launch = { action: "launch", prompt: "Approved task", model: { providerID: "test", id: "first" }, background: true }
  const original = change.startsWith("launch") ? launch : send
  const changed = change === "action" ? { action: "cancel", sessionID: send.sessionID }
    : change === "child" ? { ...send, sessionID: "ses_child_b" }
    : change === "payload" ? { ...send, text: "Different input" }
    : change === "launch-prompt" ? { ...launch, prompt: "Different task" }
    : { ...launch, model: { providerID: "test", id: "second" } }
  const authorize = (operation: unknown) => SessionOrchestration.authorize(root.id, Agent.ID.make("build"), {
    agent: caller, messageID: SessionMessage.ID.make("msg_subagent_approval"), callID: "call_subagent_approval",
  }, Hash.json(operation)).pipe(Effect.provideService(Permission.Service, permission))
  expect(Exit.isFailure(yield* authorize(original).pipe(Effect.exit))).toBe(true)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(root.id))[0]
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  expect(Exit.isFailure(yield* authorize(changed).pipe(Effect.exit))).toBe(true)
  yield* authorize(original)
  expect((yield* SessionReviewFold.fold((yield* Database.Service).db, [root.id])).find((entry) => entry.itemID === item.itemID)?.consumed).toBe(true)
}))

for (const change of ["operation", "content", "arguments"] as const) it.effect(`single-use grants reject changed ${change} and retain the identical operation`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(root.location)))
  const input = { sessionID: root.id, action: "file_mutation", resources: ["/outside/review-operation"],
    metadata: { operation: "write", memoryAction: "write", operationDigest: "a".repeat(64) } }
  expect(yield* guardrail.assert(input).pipe(Effect.flip)).toBeInstanceOf(SessionGuardrail.DeferredError)
  const reviews = yield* SessionReview.Service
  const first = (yield* reviews.list(root.id))[0]
  yield* reviews.decide({ sessionID: root.id, itemID: first.itemID, decision: { kind: "guardrail", reply: "once" } })
  const changed = { ...input, metadata: change === "operation" ? { operation: "remove", memoryAction: "purge", operationDigest: "b".repeat(64) }
    : { ...input.metadata, operationDigest: "b".repeat(64) } }
  const attempt = yield* guardrail.assert(changed).pipe(Effect.exit)
  expect(Exit.isFailure(attempt)).toBe(true)
  if (Exit.isSuccess(attempt)) yield* attempt.value.release
  const grant = yield* guardrail.assert(input)
  yield* grant.release
  expect((yield* SessionReviewFold.fold((yield* Database.Service).db, [root.id])).find((item) => item.itemID === first.itemID)?.consumed).toBe(true)
}))

const childQuestion = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const child = yield* sessions.create({ parentID: root.id })
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
    type: "launched", parentID: root.id, parentAssistantMessageID: "msg_owned_parent", toolCallID: "call_owned", inputID: "msg_owned_child",
    description: "Owned question", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
  } }))
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  return { root, child }
})

for (const change of ["cancel", "child", "text"] as const) it.effect(`the subagent control tool cannot spend a send approval on changed ${change}`, () => Effect.gen(function* () {
  const fixture = yield* childQuestion
  const sessions = yield* Session.Service
  const child = yield* sessions.create({ parentID: fixture.root.id })
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
    type: "launched", parentID: fixture.root.id, parentAssistantMessageID: "msg_second_parent", toolCallID: "call_second", inputID: "msg_second_child",
    description: "Second child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
  } }))
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(fixture.root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(toolIdentity.agent, (agent) => { agent.permissions = [
    { action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "ask" },
  ] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const orchestration = yield* SessionOrchestration.Service
  const tools = yield* Tools.Service.pipe(Effect.provide(located))
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(located))
  const toolName = `review_control_${change}`
  const unavailable = () => Effect.die(new Error("unused PluginRuntime operation"))
  yield* registerToolPlugin(SubagentControlTool.Plugin, toolName).pipe(Effect.provideService(Tools.Service, tools),
    Effect.provideService(Permission.Service, permission), Effect.provide(Layer.succeed(PluginRuntime.Service, PluginRuntime.Service.of({
      orchestration, session: sessions,
      job: { start: unavailable, wait: unavailable, block: unavailable, background: unavailable, cancel: unavailable, noticeAdmitted: unavailable },
      location: { agent: { list: unavailable } },
    }))))
  const original = { action: "send", sessionID: fixture.child.id, text: "Approved input", delivery: "steer" }
  const changed = change === "cancel" ? { action: "cancel", sessionID: fixture.child.id }
    : { ...original, sessionID: change === "child" ? child.id : fixture.child.id, text: change === "text" ? "Different input" : original.text }
  const call = (id: string, input: unknown) => executeTool(registry, { sessionID: fixture.root.id, ...toolIdentity,
    call: { type: "tool-call", id, name: toolName, input } }).pipe(Effect.exit)
  yield* sessions.autonomy.set({ sessionID: fixture.root.id, sleep: true })
  expect(Exit.isFailure(yield* call("first", original))).toBe(true)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(fixture.root.id))[0]
  yield* reviews.decide({ sessionID: fixture.root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  expect(Exit.isFailure(yield* call("changed", changed))).toBe(true)
  expect((yield* orchestration.get(fixture.root.id, fixture.child.id)).state).toBe("running")
  expect(Exit.isSuccess(yield* call("identical", original))).toBe(true)
}))

it.effect("permission grants normalize omitted metadata fields without changing operation identity", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(Agent.ID.make("review-metadata"), (agent) => { agent.permissions = [] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const input = { sessionID: root.id, agent: Agent.ID.make("review-metadata"), action: "edit", resources: ["file"], metadata: { operationDigest: "a".repeat(64) } }
  const attempt = yield* permission.assert({ ...input, metadata: { ...input.metadata, optional: undefined } }).pipe(Effect.exit)
  expect(Exit.isFailure(attempt)).toBe(true)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(root.id))[0]
  expect(item).toBeDefined()
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  yield* permission.assert(input)
}))

it.effect("a child decision and its human answer become visible atomically", () => Effect.gen(function* () {
  const fixture = yield* childQuestion
  const sessions = yield* Session.Service
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(fixture.child.id, "Need human evidence")
  yield* sessions.autonomy.set({ sessionID: fixture.root.id, sleep: true })
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(fixture.root.id))[0]
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const events = yield* EventRuntime.Service
  const stop = yield* events.listen((event) => event.type === SessionEvent.Review.Decided.type
    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const deciding = yield* reviews.decide({ sessionID: fixture.root.id, itemID: item.itemID, decision: { kind: "subagent_question", text: "Human evidence" } }).pipe(Effect.forkScoped)
  const competing = yield* Effect.gen(function* () {
    yield* Deferred.await(entered)
    const answer = yield* orchestration.answer({ parentID: fixture.root.id, childID: fixture.child.id, questionID: question.question.id, text: "Agent answer" }).pipe(Effect.exit, Effect.forkScoped)
    yield* TestClock.adjust("10 minutes")
    const task = yield* orchestration.get(fixture.root.id, fixture.child.id)
    expect(task.state).toBe("running")
    expect(task.question).toBeUndefined()
    expect((yield* sessions.pending(fixture.child.id)).some((input) => input.type === "synthetic" && input.data.text.includes("Human evidence"))).toBe(true)
    return answer
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  yield* Fiber.join(deciding)
  expect(Exit.isFailure(yield* Fiber.join(competing))).toBe(true)
  expect((yield* sessions.pending(fixture.child.id)).some((input) => input.type === "synthetic" && input.data.text.includes("Human evidence"))).toBe(true)
}))

it.effect("sleep conversion keeps an old child question pending under human review ownership", () => Effect.gen(function* () {
  const fixture = yield* childQuestion
  const sessions = yield* Session.Service
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(fixture.child.id, "Need human evidence")
  yield* sessions.autonomy.set({ sessionID: fixture.root.id, sleep: true })
  yield* TestClock.adjust("24 hours")
  expect(yield* orchestration.get(fixture.root.id, fixture.child.id)).toMatchObject({
    state: "waiting", question: { id: question.question.id, deferred: true },
  })
  expect(yield* orchestration.answer({ parentID: fixture.root.id, childID: fixture.child.id, questionID: question.question.id, text: "Parent answer" }).pipe(Effect.flip)).toBeInstanceOf(SessionOrchestration.ConflictError)
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(fixture.root.id))[0]
  yield* reviews.decide({ sessionID: fixture.root.id, itemID: item.itemID, decision: { kind: "subagent_question", text: "Human evidence" } })
  expect(yield* orchestration.get(fixture.root.id, fixture.child.id)).toMatchObject({ state: "running", question: undefined })
}))

it.effect("a human answer cannot overtake a historically closed child question", () => Effect.gen(function* () {
  const fixture = yield* childQuestion
  const sessions = yield* Session.Service
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(fixture.child.id, "Need evidence")
  yield* sessions.autonomy.set({ sessionID: fixture.root.id, sleep: true })
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(fixture.root.id))[0]
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: fixture.child.id, change: { type: "question_timed_out", questionID: question.question.id } })
  expect(yield* reviews.decide({ sessionID: fixture.root.id, itemID: item.itemID, decision: { kind: "subagent_question", text: "Human evidence" } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
  expect((yield* reviews.list(fixture.root.id)).map((entry) => entry.itemID)).toEqual([item.itemID])
  const retry = yield* reviews.decide({ sessionID: fixture.root.id, itemID: item.itemID, decision: { kind: "subagent_question", text: "Human evidence" } }).pipe(Effect.flip)
  expect(retry).toBeInstanceOf(SessionReview.ConflictError)
  expect(retry.message).not.toContain("already decided")
  expect((yield* reviews.list(fixture.root.id)).map((entry) => entry.itemID)).toEqual([item.itemID])
  expect((yield* sessions.pending(fixture.child.id)).some((input) => input.type === "synthetic" && input.data.text.includes("Human evidence"))).toBe(false)
}))

it.effect("permission shutdown and a concurrent reply settle the waiting caller exactly once", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  const agent = Agent.ID.make("review-shutdown")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [] }))
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.succeed(undefined)))
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const store = yield* SessionStore.Service
  const config = yield* Config.Service.pipe(Effect.provide(located))
  const placement = yield* Location.Service.pipe(Effect.provide(located))
  const context = yield* Layer.build(Layer.fresh(AppNodeBuilder.build(Permission.node, [
    [Database.node, Layer.succeed(Database.Service, database)], [EventRuntime.node, Layer.succeed(EventRuntime.Service, events)],
    [SessionStore.node, Layer.succeed(SessionStore.Service, store)], [Agent.node, Layer.succeed(Agent.Service, agents)],
    [Config.node, Layer.succeed(Config.Service, config)], [Location.node, Layer.succeed(Location.Service, placement)],
  ]))).pipe(Effect.provideService(Scope.Scope, scope))
  const permission = Context.getUnsafe(context, Permission.Service)
  const asked = yield* Deferred.make<Permission.Request>()
  const replying = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const shutdown = yield* Deferred.make<void>()
  const stop = yield* events.listen((event) => {
    if (event.type === Permission.Event.Asked.type) return Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
    if (event.type === Permission.Event.Replied.type) return Deferred.succeed(replying, undefined).pipe(Effect.andThen(Deferred.await(release)))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* permission.assert({ sessionID: root.id, agent, action: "edit", resources: ["file"] }).pipe(Effect.exit, Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  const reply = yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit, Effect.forkScoped)
  yield* Deferred.await(replying)
  yield* Scope.addFinalizer(scope, Deferred.succeed(shutdown, undefined))
  const closing = yield* Scope.close(scope, Exit.succeed(undefined)).pipe(Effect.forkScoped)
  yield* Deferred.await(shutdown)
  yield* Effect.yieldNow
  yield* Deferred.succeed(release, undefined)
  expect(Exit.isSuccess(yield* Fiber.join(reply))).toBe(true)
  expect(Exit.isSuccess(yield* Fiber.join(waiting))).toBe(true)
  yield* Fiber.join(closing)
  expect(yield* permission.forSession(root.id)).toEqual([])
}))

for (const winner of ["reply", "conversion"] as const) it.effect(`permission ${winner} owns settlement without a ghost deferred item`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(Agent.ID.make("review-permission"), (agent) => { agent.permissions = [] }))
  const permission = yield* Permission.Service.pipe(Effect.provide(located))
  const events = yield* EventRuntime.Service
  const asked = yield* Deferred.make<Permission.Request>()
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const stop = yield* events.listen((event) => {
    if (event.type === Permission.Event.Asked.type) return Deferred.succeed(asked, Schema.decodeUnknownSync(Permission.Request)(event.data)).pipe(Effect.asVoid)
    if (event.type === (winner === "reply" ? Permission.Event.Replied.type : SessionEvent.Review.Deferred.type))
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* permission.assert({ sessionID: root.id, agent: Agent.ID.make("review-permission"), action: "edit", resources: ["file"], save: ["file"], metadata: {},
    source: { type: "tool", messageID: "msg_permission_order", callID: "call_permission_order" } }).pipe(Effect.forkScoped)
  const request = yield* Effect.raceFirst(Deferred.await(asked), Fiber.await(waiting).pipe(
    Effect.flatMap((exit) => Effect.die(new Error(`Permission settled before admission: ${exit._tag === "Failure" ? exit.cause.toString() : "allowed"}`))),
  ))
  const reply = () => permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
  const convert = () => permission.deferPending(root.id).pipe(Effect.exit)
  const first = yield* (winner === "reply" ? reply() : convert()).pipe(Effect.forkScoped)
  yield* Deferred.await(entered)
  const second = yield* (winner === "reply" ? convert() : reply()).pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  yield* Deferred.succeed(release, undefined)
  const firstResult = yield* Fiber.join(first)
  const secondResult = yield* Fiber.join(second)
  const reviews = yield* SessionReview.Service
  if (winner === "reply") {
    expect(Exit.isSuccess(firstResult)).toBe(true)
    expect(Exit.isSuccess(secondResult)).toBe(true)
    expect(yield* reviews.list(root.id)).toEqual([])
    expect(Exit.isSuccess(yield* Fiber.await(waiting))).toBe(true)
    return
  }
  expect(Exit.isSuccess(firstResult)).toBe(true)
  expect(Exit.isFailure(secondResult)).toBe(true)
  expect(yield* reviews.list(root.id)).toHaveLength(1)
  expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true)
}))

test("a persisted child decision retains ownership across restart before reconciliation delivers it", async () => {
  await using directory = await tmpdir("ycoding-review-owned-restart-")
  const database = () => Database.layer({ path: path.join(directory.path, "state.sqlite") })
  const state = await Effect.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }) })
    const child = yield* sessions.create({ parentID: root.id })
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
      type: "launched", parentID: root.id, parentAssistantMessageID: "msg_restart_parent", toolCallID: "call_restart", inputID: "msg_restart_child",
      description: "Restart question", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
    } }))
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
    const orchestration = yield* SessionOrchestration.Service
    const question = yield* orchestration.question(child.id, "Need evidence")
    yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
    const reviews = yield* SessionReview.Service
    const item = (yield* reviews.list(root.id))[0]
    yield* events.publish(SessionEvent.Review.Decided, { sessionID: child.id, itemID: item.itemID, decision: { kind: "subagent_question", text: "Recovered human evidence" } })
    return { rootID: root.id, childID: child.id, questionID: question.question.id }
  }).pipe(Effect.scoped, Effect.provide(reviewLayer(database()))))
  await Effect.runPromise(Effect.gen(function* () {
    const orchestration = yield* SessionOrchestration.Service
    expect(yield* orchestration.answer({ parentID: state.rootID, childID: state.childID, questionID: state.questionID, text: "Overtaking agent answer" }).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
  }).pipe(Effect.scoped, Effect.provide(reviewLayer(database(), false))))
  await Effect.runPromise(Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    yield* reviews.reconcile
    const sessions = yield* Session.Service
    expect((yield* sessions.pending(state.childID)).some((input) => input.type === "synthetic" && input.data.text.includes("Recovered human evidence"))).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(reviewLayer(database()))))
})

it.effect("a human-review delivery without a review decision cannot answer a recovery question", () => Effect.gen(function* () {
  const fixture = yield* childQuestion
  const events = yield* EventRuntime.Service
  const question = Question.make({ id: QuestionID.make("qst_recovery_bypass"), text: "Choose Continue or Stop.", time: 1 })
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: fixture.child.id, change: { type: "question_asked", question } })
  yield* events.publish(SessionEvent.Review.Deferred, Schema.decodeUnknownSync(SessionEvent.Review.Deferred.data)({
    sessionID: fixture.child.id, itemID: SessionReviewSchema.ID.create(), kind: "recovery", reason: "restart",
    origin: { questionID: question.id },
    payload: { type: "recovery", tools: [{ messageID: "msg_recovery_bypass", callID: "call_recovery_bypass", name: "edit" }] },
  }))
  const orchestration = yield* SessionOrchestration.Service
  const { db } = yield* Database.Service
  const answer = (origin?: "human-review") => orchestration.answer({
    parentID: fixture.root.id, childID: fixture.child.id, questionID: question.id, text: "Continue", ...(origin === undefined ? {} : { origin }),
  }).pipe(Effect.flip)

  expect(yield* answer()).toBeInstanceOf(SessionOrchestration.ConflictError)
  expect(yield* answer("human-review")).toBeInstanceOf(SessionOrchestration.InvalidRequestError)
  expect((yield* db.select({ state: SessionTaskTable.state }).from(SessionTaskTable).where(eq(SessionTaskTable.session_id, fixture.child.id)).get().pipe(Effect.orDie))?.state).toBe("waiting")
  expect(yield* db.select({ id: SessionPendingTable.id }).from(SessionPendingTable).where(eq(SessionPendingTable.session_id, fixture.child.id)).all().pipe(Effect.orDie)).toEqual([])
  const answered = (yield* db.select({ data: EventTable.data }).from(EventTable).where(eq(EventTable.aggregate_id, fixture.child.id)).all().pipe(Effect.orDie))
    .filter((row) => JSON.stringify(row.data).includes("question_answered"))
  expect(answered).toEqual([])
}))
