import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageUpdater } from "@ycoding-ai/core/session/message-updater"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { GoalTool } from "@ycoding-ai/core/tool/goal"
import { QuestionTool } from "@ycoding-ai/core/tool/question"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"
import { reviewLayer, reviewLocation } from "./fixture/review"

const it = testEffect(reviewLayer())
const fields = [{ key: "text", type: "string", required: true }] as const

it.effect("sleep entry converts questions, forms and permission asks across Locations without answering or expiring them", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const events = yield* EventRuntime.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const child = yield* sessions.create({ parentID: root.id })
  const childLocation = yield* reviewLocation
  yield* events.publish(SessionEvent.Moved, { sessionID: child.id, location: childLocation })
  const locations = yield* LocationServiceMap.Service
  const located = locations.get(root.location)
  const forms = yield* Form.Service.pipe(Effect.provide(located))
  const questions = yield* Question.Service.pipe(Effect.provide(located))
  const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(childLocation)))
  const agents = yield* Agent.Service.pipe(Effect.provide(locations.get(childLocation)))
  yield* agents.transform((draft) => draft.update(Agent.ID.make("review-test"), (agent) => { agent.permissions = [] }))
  const ready = yield* Deferred.make<void>()
  const seen = new Set<string>()
  const stop = yield* events.listen((event) => Effect.gen(function* () {
    if ([Form.Event.Created.type, Question.Event.Asked.type, Permission.Event.Asked.type].some((type) => type === event.type)) seen.add(event.type)
    if (seen.size === 3) yield* Deferred.succeed(ready, undefined)
  }))
  yield* Effect.addFinalizer(() => stop)
  const form = yield* forms.ask({ sessionID: root.id, title: "Details", fields }).pipe(Effect.forkScoped)
  const question = yield* questions.ask({ sessionID: root.id, questions: [{ header: "Details", question: "Which details?", options: [] }] }).pipe(Effect.forkScoped)
  const ask = yield* permission.assert({ sessionID: child.id, agent: Agent.ID.make("review-test"), action: "edit", resources: ["file"] }).pipe(Effect.forkScoped)
  yield* Deferred.await(ready)
  yield* sessions.autonomy.set({ sessionID: child.id, sleep: true })
  expect(yield* Fiber.join(form)).toMatchObject({ status: "deferred" })
  expect(yield* Fiber.join(question)).toMatchObject({ status: "deferred" })
  const exit = yield* Fiber.await(ask)
  expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeferredError)).toBe(true)
  expect(yield* forms.list()).toEqual([])
  expect(yield* questions.list()).toEqual([])
  expect(yield* permission.forSession(child.id)).toEqual([])
  const items = yield* reviews.list(root.id)
  expect(items.map((item) => [item.kind, item.sessionID, item.reason])).toEqual([
    ["question", root.id, "sleep_entry"], ["question", root.id, "sleep_entry"], ["permission", child.id, "escalated"],
  ])
  expect(items.find((item) => item.kind === "permission")).toMatchObject({ choice: "escalate", confidence: 0.7 })
  yield* TestClock.adjust("10 minutes")
  expect((yield* reviews.list(root.id)).map((item) => item.itemID)).toEqual(items.map((item) => item.itemID))
}))

for (const full of [false, true]) it.effect(`the registered question tool ${full ? "reports a full review box without inventing an answer" : "defers free text and admits a literal answer without waking"}`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const located = (yield* LocationServiceMap.Service).get(root.location)
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(toolIdentity.agent, (agent) => { agent.permissions = [{ action: "question", resource: "*", effect: "allow" }] }))
  yield* registerToolPlugin(QuestionTool.Plugin).pipe(Effect.provide(located))
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(located))
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const reviews = yield* SessionReview.Service
  if (full) for (let index = 0; index < 16; index += 1) yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16,
    origin: { requestID: `frm_full_${index}` }, payload: { type: "form", title: "Pending", fields } })
  const result = yield* settleTool(registry, { sessionID: root.id, ...toolIdentity, call: {
    type: "tool-call", id: "free-text", name: "question", input: { questions: [{ header: "Evidence", question: "Paste the failing input", options: [] }] },
  } })
  if (full) {
    expect(result.output?.structured).toEqual({ answers: [[]], reviewFull: true })
    expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("review box is full") })
    expect(yield* reviews.list(root.id)).toHaveLength(16)
    expect((yield* sessions.autonomy.get(root.id)).sleep).toEqual({})
    return
  }
  expect(result.output?.structured).toMatchObject({ answers: [[]], deferredItemID: expect.any(String) })
  expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("Do not guess the answer") })
  const items = yield* reviews.list(root.id)
  expect(items).toHaveLength(1)
  expect(items[0]?.origin).toEqual({ messageID: toolIdentity.messageID, callID: "free-text" })
  yield* reviews.decide({ sessionID: root.id, itemID: items[0].itemID, decision: { kind: "question", answers: { q0: "/literal input" } } })
  const admitted = yield* SessionPending.lookup((yield* Database.Service).db, root.id, SessionReview.promptID(items[0].itemID))
  expect(admitted?.type === "user" && admitted.data.text).toContain('"Paste the failing input"="/literal input"')
  expect((yield* sessions.autonomy.get(root.id)).sleep).toEqual({})
}))

for (const implicit of [false, true]) it.effect(`${implicit ? "prompt admission" : "explicit commit"} withdraws reverted reviews and grants atomically and projects durable notices`, () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const reviews = yield* SessionReview.Service
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  const first = yield* sessions.prompt({ sessionID: root.id, text: "Keep", origin: "review", resume: false })
  const boundary = yield* sessions.prompt({ sessionID: root.id, text: "Remove", origin: "review", resume: false })
  yield* SessionPending.promoteSteers(database.db, events, root.id)
  const kept = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16,
    origin: { messageID: first.id, callID: "kept" }, payload: { type: "form", title: "Kept", fields } })
  const removed = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16,
    origin: { messageID: boundary.id, callID: "removed" }, payload: { type: "form", title: "Removed", fields } })
  const fingerprint = SessionReview.fingerprint({ action: "edit", resources: ["file"], workdir: root.location.directory })
  const grant = yield* reviews.open({ sessionID: root.id, kind: "permission", reason: "sleep_entry", limit: 16,
    origin: { messageID: boundary.id, callID: "grant" }, payload: { type: "permission", requestID: Permission.ID.make("per_revert"), action: "edit", resources: ["file"], fingerprint } })
  yield* reviews.decide({ sessionID: root.id, itemID: grant.itemID, decision: { kind: "permission", reply: "once" } })
  yield* events.publish(SessionEvent.RevertEvent.Staged, { sessionID: root.id, revert: { messageID: boundary.id, files: [] } })
  if (implicit) yield* sessions.prompt({ sessionID: root.id, text: "Replacement", origin: "review", resume: false })
  if (!implicit) yield* sessions.revert.commit(root.id)
  expect((yield* reviews.list(root.id)).map((item) => item.itemID)).toEqual([kept.itemID])
  expect(yield* reviews.consume(root.id, "permission", fingerprint)).toBe(false)
  expect(yield* reviews.decide({ sessionID: root.id, itemID: removed.itemID, decision: { kind: "question", dismissed: true } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
  const messages = yield* sessions.messages({ sessionID: root.id })
  for (const item of [removed, grant]) expect(messages.some((message) => message.type === "system" && message.text.includes(item.itemID) && message.text.includes("withdrawn"))).toBe(true)
  const replay = { messages: [] as SessionMessage.Info[] }
  const records = yield* events.log({ aggregateID: root.id, follow: false }).pipe(Stream.runCollect)
  for (const event of records) {
    if (event.type !== SessionEvent.Review.Withdrawn.type || !event.durable) continue
    yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(replay), SessionEvent.Review.Withdrawn.make({
      ...event, durable: event.durable, type: "session.review.withdrawn", data: Schema.decodeUnknownSync(SessionEvent.Review.Withdrawn.data)(event.data),
    }))
  }
  const store = yield* SessionStore.Service
  const context = yield* store.context(root.id)
  expect(replay.messages.map((message) => message.id)).toEqual(context.filter((message) => message.type === "system" && message.text.includes("withdrawn")).map((message) => message.id))
}))

it.effect("deferred form decisions enforce the owning Form validation before recording a decision or admitting input", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const reviews = yield* SessionReview.Service
  const item = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16, origin: { requestID: "frm_validated" }, payload: {
    type: "form", title: "Bounded", fields: [
      { key: "count", type: "integer", required: true, minimum: 1, maximum: 3 },
      { key: "plan", type: "string", required: true, options: [{ value: "safe", label: "Safe" }], custom: false },
      { key: "detail", type: "string", required: true, when: [{ key: "count", op: "eq", value: 3 }] },
    ],
  } })
  const invalidAnswers: Form.Answer[] = [{ count: 0, plan: "safe" }, { count: "1", plan: "safe" }, { count: 1, plan: "other" }, { count: 3, plan: "safe" }, { count: 1, plan: "safe", detail: "hidden" }, { count: 1, plan: "safe", unknown: true }]
  for (const answers of invalidAnswers) {
    expect(yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "question", answers } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.InvalidDecisionError)
    expect(yield* reviews.list(root.id)).toHaveLength(1)
  }
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "question", answers: { count: 3, plan: "safe", detail: "literal" } } })
  expect(yield* reviews.list(root.id)).toEqual([])
}))

it.effect("awake review-box state remains visible in instructions and goal reports preserve the retry budget", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const reviews = yield* SessionReview.Service
  const item = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16,
    origin: { requestID: "frm_waiting" }, payload: { type: "form", title: "Waiting", fields } })
  const located = (yield* LocationServiceMap.Service).get(root.location)
  const live = yield* SessionLiveState.Service.pipe(Effect.provide(located))
  const current = yield* live.load(root.id)
  expect(current.text).toContain(item.itemID)
  expect(current.text).toContain("Do not guess outcomes, retry deferred actions, or call goal report")
  expect(current.text).not.toContain("The user decides them after waking")
  const agents = yield* Agent.Service.pipe(Effect.provide(located))
  yield* agents.transform((draft) => draft.update(toolIdentity.agent, (agent) => { agent.permissions = [{ action: "goal", resource: "*", effect: "allow" }] }))
  const database = yield* Database.Service
  const autonomy = SessionAutonomy.make({ db: database.db })
  yield* registerToolPlugin(GoalTool.Plugin).pipe(Effect.provideService(SessionAutonomy.Service, autonomy), Effect.provideService(Database.Service, database), Effect.provide(located))
  const registry = yield* ToolRegistry.Service.pipe(Effect.provide(located))
  yield* autonomy.setGoal({ sessionID: root.id, text: "Verify bounded work" })
  const before = yield* sessions.autonomy.get(root.id)
  const result = yield* settleTool(registry, { sessionID: root.id, ...toolIdentity, call: { type: "tool-call", id: "report", name: "goal", input: { action: "report" } } })
  expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("Not counted") })
  expect(yield* sessions.autonomy.get(root.id)).toEqual(before)
}))

it.effect("sleep-entry child questions remain waiting beyond their timer and accept only the human review decision", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const child = yield* sessions.create({ parentID: root.id })
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
    type: "launched", parentID: root.id, parentAssistantMessageID: "msg_review_parent", toolCallID: "call_child", inputID: "msg_review_child",
    description: "Review child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
  } }))
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(child.id, "Need literal evidence")
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const reviews = yield* SessionReview.Service
  const items = yield* reviews.list(root.id)
  expect(items[0]).toMatchObject({ kind: "subagent_question", sessionID: child.id, reason: "sleep_entry", child: { agent: "build", description: "Review child" } })
  yield* TestClock.adjust("10 minutes")
  expect(yield* orchestration.get(root.id, child.id)).toMatchObject({ state: "waiting", question: { id: question.question.id, deferred: true } })
  expect((yield* orchestration.list(root.id))[0]?.question?.deferred).toBe(true)
  expect((yield* orchestration.page({ parentID: root.id })).data[0]?.question?.deferred).toBe(true)
  const database = yield* Database.Service
  expect((yield* SessionOrchestration.readTeamView(database.db, root.id))?.view.children[0]?.question?.deferred).toBe(true)
  expect(yield* orchestration.answer({ parentID: root.id, childID: child.id, questionID: question.question.id, text: "Agent answer" }).pipe(Effect.flip)).toBeInstanceOf(SessionOrchestration.ConflictError)
  yield* reviews.decide({ sessionID: root.id, itemID: items[0].itemID, decision: { kind: "subagent_question", text: "/literal review answer" } })
  expect((yield* orchestration.get(root.id, child.id)).state).toBe("running")
  expect((yield* sessions.autonomy.get(root.id)).sleep).toEqual({})
  expect((yield* sessions.pending(child.id)).some((input) => input.type === "synthetic" && input.data.text.includes("/literal review answer"))).toBe(true)
}))

it.effect("an already-settled human review decision conflicts even when its answer is identical", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const reviews = yield* SessionReview.Service
  const item = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16,
    origin: { requestID: "frm_once" }, payload: { type: "form", title: "Once", fields } })
  const decision = { sessionID: root.id, itemID: item.itemID, decision: { kind: "question", answers: { text: "literal" } } } as const
  yield* reviews.decide(decision)
  expect(yield* reviews.decide(decision).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
}))

it.effect("a failing Form conversion does not strand other pending producer kinds in a sleeping Session", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const located = (yield* LocationServiceMap.Service).get(root.location)
  const forms = yield* Form.Service.pipe(Effect.provide(located))
  const questions = yield* Question.Service.pipe(Effect.provide(located))
  const events = yield* EventRuntime.Service
  const ready = yield* Deferred.make<void>()
  const seen = new Set<string>()
  const stop = yield* events.listen((event) => Effect.gen(function* () {
    if (event.type === Form.Event.Created.type || event.type === Question.Event.Asked.type) seen.add(event.type)
    if (seen.size === 2) yield* Deferred.succeed(ready, undefined)
    if (event.type === Form.Event.Deferred.type) yield* Effect.die("Synthetic publication failure")
  }))
  yield* Effect.addFinalizer(() => stop)
  yield* forms.ask({ sessionID: root.id, title: "Conversion failure", fields }).pipe(Effect.forkScoped)
  const waiting = yield* questions.ask({ sessionID: root.id, questions: [{ header: "Later", question: "Keep converting", options: [] }] }).pipe(Effect.forkScoped)
  yield* Deferred.await(ready)
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  expect(yield* questions.list()).toEqual([])
  expect(yield* Fiber.join(waiting)).toMatchObject({ status: "deferred" })
  expect((yield* sessions.autonomy.get(root.id)).sleep).toEqual({})
}))

it.effect("a required free-text Form defers while asleep even when it carries a suggested default", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  yield* sessions.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const forms = yield* Form.Service.pipe(Effect.provide(locations.get(root.location)))
  expect(yield* forms.ask({ sessionID: root.id, title: "Literal evidence", fields: [{ key: "text", type: "string", required: true, default: "Suggested" }] })).toMatchObject({ status: "deferred" })
  const reviews = yield* SessionReview.Service
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))
