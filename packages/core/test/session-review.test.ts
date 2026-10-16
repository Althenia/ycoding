import path from "node:path"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Agent } from "@ycoding-ai/core/agent"
import { Permission } from "@ycoding-ai/core/permission"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { testEffect } from "./lib/effect"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(reviewLayer())
const payload = { type: "form", title: "Plan", fields: [{ key: "plan", type: "string", required: true }] } as const
const openQuestion = (service: SessionReview.Interface, sessionID: Session.ID, limit = 16, conversion = false) => service.open({
  sessionID, kind: "question", reason: "free_text", origin: { requestID: "frm_plan" }, payload, limit, conversion,
})

it.effect("review fold lists open items across the family with canonical child attribution and terminal facts", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const child = yield* session.create({ parentID: root.id })
  const first = yield* openQuestion(reviews, root.id)
  const second = yield* openQuestion(reviews, child.id)
  expect((yield* reviews.list(child.id)).map((item) => [item.itemID, item.sessionID, item.rootSessionID])).toEqual([
    [first.itemID, root.id, root.id], [second.itemID, child.id, root.id],
  ])
  yield* reviews.withdraw(child.id, "task_closed")
  expect((yield* reviews.list(root.id)).map((item) => item.itemID)).toEqual([first.itemID])
  yield* session.remove(root.id)
  expect(yield* reviews.list(root.id).pipe(Effect.flip)).toBeInstanceOf(Session.NotFoundError)
}))

it.effect("the shared family cap rejects new items while sleep-entry conversion remains exempt", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const child = yield* session.create({ parentID: root.id })
  yield* openQuestion(reviews, root.id, 1)
  expect(yield* openQuestion(reviews, child.id, 1).pipe(Effect.flip)).toBeInstanceOf(SessionReview.FullError)
  yield* openQuestion(reviews, child.id, 1, true)
  expect(yield* reviews.list(root.id)).toHaveLength(2)
}))

it.effect("a human decision is admitted once as a user steer without waking a sleeping family", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  yield* session.autonomy.set({ sessionID: root.id, sleep: true })
  const item = yield* openQuestion(reviews, root.id)
  const input = { sessionID: root.id, itemID: item.itemID, decision: { kind: "question", answers: { plan: "A" } } } as const
  yield* reviews.decide(input)
  expect(yield* reviews.decide(input).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
  const db = (yield* Database.Service).db
  const admitted = yield* SessionPending.lookup(db, root.id, SessionReview.promptID(item.itemID))
  expect(admitted?.type).toBe("user")
  if (admitted?.type !== "user") throw new Error("Expected user decision")
  expect(admitted.delivery).toBe("steer")
  expect(admitted.data.text).toContain("A")
  expect(admitted.data.metadata).toMatchObject({ review: { itemID: item.itemID, kind: "question" } })
  expect((yield* session.autonomy.get(root.id)).sleep).toBeDefined()
  expect(yield* reviews.list(root.id)).toEqual([])
  expect(yield* reviews.decide({ ...input, decision: { kind: "question", answers: { plan: "B" } } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
}))

it.effect("decide validates answer fields, kind, owning family, archive state, and hard approval choices before settlement", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const other = yield* session.create({ location: root.location })
  const item = yield* openQuestion(reviews, root.id)
  for (const decision of [{ kind: "question", answers: {} }, { kind: "guardrail", reply: "once" }] as const)
    expect(yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.InvalidDecisionError)
  expect(yield* reviews.decide({ sessionID: other.id, itemID: item.itemID, decision: { kind: "question", dismissed: true } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.NotFoundError)
  yield* session.archive(root.id)
  expect(yield* reviews.list(root.id)).toEqual([])
  expect(yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "question", dismissed: true } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
  yield* session.unarchive(root.id)
  const hard = yield* reviews.open({ sessionID: root.id, kind: "guardrail", reason: "escalated", limit: 16,
    origin: { requestID: "grq_hard" }, payload: { type: "guardrail", requestID: SessionGuardrail.RequestID.make("grq_hard"), action: "shell", resources: ["git reset --hard"],
      ruleIDs: ["hard"], reason: "Review", hardReview: true, directories: [], fingerprint: SessionReview.fingerprint({ action: "shell", resources: ["git reset --hard"], workdir: root.location.directory, ruleIDs: ["hard"], hardReview: true }) } })
  expect(yield* reviews.decide({ sessionID: root.id, itemID: hard.itemID, decision: { kind: "guardrail", reply: "always" } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.InvalidDecisionError)
  expect(yield* reviews.list(root.id)).toHaveLength(2)
}))

it.effect("once grants are exact, Session-bound, single-use durable consumptions", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const child = yield* session.create({ parentID: root.id })
  const fingerprint = SessionReview.fingerprint({ action: "edit", resources: ["file"], workdir: root.location.directory })
  const item = yield* reviews.open({ sessionID: root.id, kind: "permission", reason: "sleep_entry", limit: 16,
    origin: { requestID: "per_exact" }, payload: { type: "permission", action: "edit", resources: ["file"], fingerprint, requestID: Permission.ID.make("per_exact") } })
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  expect(yield* reviews.consume(child.id, "permission", fingerprint)).toBe(false)
  expect(yield* reviews.consume(root.id, "permission", "b".repeat(64))).toBe(false)
  expect(yield* reviews.consume(root.id, "permission", fingerprint)).toBe(true)
  expect(yield* reviews.consume(root.id, "permission", fingerprint)).toBe(false)
}))

it.effect("startup reconciliation delivers a decided item whose prompt was not admitted", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const item = yield* openQuestion(reviews, root.id)
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Review.Decided, { sessionID: root.id, itemID: item.itemID, decision: { kind: "question", answers: { plan: "A" } } })
  yield* reviews.reconcile
  yield* reviews.reconcile
  expect(yield* SessionPending.lookup((yield* Database.Service).db, root.id, SessionReview.promptID(item.itemID))).toMatchObject({ type: "user", sessionID: root.id })
}))

it.effect("sleep conversion settles waiting forms but does not consume create-only forms", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  const forms = yield* Form.Service.pipe(Effect.provide(locations.get(root.location)))
  const created = yield* forms.create({ sessionID: root.id, title: "External creator", fields: payload.fields })
  const waiting = yield* forms.ask({ sessionID: root.id, title: "Waiting caller", fields: payload.fields }).pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  yield* session.autonomy.set({ sessionID: root.id, sleep: true })
  expect(yield* Fiber.join(waiting)).toMatchObject({ status: "deferred" })
  expect((yield* forms.list()).map((form) => form.id)).toEqual([created.id])
  expect(yield* reviews.list(root.id)).toHaveLength(1)
  yield* session.autonomy.set({ sessionID: root.id, sleep: false })
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))

it.effect("revert withdraws both open items and unconsumed grants beyond their origin message", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const before = SessionMessage.ID.make("msg_review_before")
  const after = SessionMessage.ID.make("msg_review_after")
  yield* session.prompt({ id: before, sessionID: root.id, text: "Before", origin: "review", resume: false })
  yield* session.prompt({ id: after, sessionID: root.id, text: "After", origin: "review", resume: false })
  const item = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16, origin: { messageID: after, callID: "call_after" }, payload })
  const fingerprint = SessionReview.fingerprint({ action: "edit", resources: ["file"], workdir: root.location.directory })
  const grant = yield* reviews.open({ sessionID: root.id, kind: "permission", reason: "sleep_entry", limit: 16,
    origin: { messageID: after, callID: "call_grant" }, payload: { type: "permission", action: "edit", resources: ["file"], fingerprint, requestID: Permission.ID.make("per_reverted") } })
  yield* reviews.decide({ sessionID: root.id, itemID: grant.itemID, decision: { kind: "permission", reply: "once" } })
  yield* reviews.withdrawAfter(root.id, before)
  expect(yield* reviews.list(root.id)).toEqual([])
  expect(yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "question", dismissed: true } }).pipe(Effect.flip)).toBeInstanceOf(SessionReview.ConflictError)
  expect(yield* reviews.consume(root.id, "permission", fingerprint)).toBe(false)
}))

it.effect("a later guardrail deny blocks an identical granted request without consuming its approval", () => Effect.gen(function* () {
  const sessions = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(root.location)))
  const input = { sessionID: root.id, action: "shell", resources: ["rm -rf /"] }
  const result = yield* guardrail.evaluate(input)
  const fingerprint = SessionReview.fingerprint({ ...input, workdir: root.location.directory, ruleIDs: result.ruleIDs, hardReview: result.hardReview })
  const item = yield* reviews.open({ sessionID: root.id, kind: "guardrail", reason: "sleep_entry", limit: 16,
    origin: { requestID: "grq_granted" }, payload: { type: "guardrail", requestID: SessionGuardrail.RequestID.make("grq_granted"), action: input.action, resources: input.resources,
      ruleIDs: result.ruleIDs, reason: "Review", hardReview: result.hardReview, directories: [], fingerprint } })
  yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "guardrail", reply: "once" } })
  expect(yield* guardrail.assert(input).pipe(Effect.flip)).toBeInstanceOf(SessionGuardrail.BlockedError)
  expect(yield* reviews.consume(root.id, "guardrail", fingerprint)).toBe(true)
}))

test("a guardrail approval survives rebuilding the runtime and is consumed once after restart", async () => {
  await using directory = await tmpdir("ycoding-review-restart-")
  const build = () => reviewLayer(Database.layer({ path: path.join(directory.path, "state.sqlite") }))
  const saved = await Effect.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const reviews = yield* SessionReview.Service
    const root = yield* sessions.create({ location: yield* reviewLocation })
    const fingerprint = SessionReview.fingerprint({ action: "shell", resources: ["git reset --hard"], workdir: root.location.directory, ruleIDs: ["review"], hardReview: true })
    const item = yield* reviews.open({ sessionID: root.id, kind: "guardrail", reason: "sleep_entry", limit: 16,
      origin: { requestID: "grq_restart" }, payload: { type: "guardrail", requestID: SessionGuardrail.RequestID.make("grq_restart"), action: "shell", resources: ["git reset --hard"],
        ruleIDs: ["review"], reason: "Review", hardReview: true, directories: [], fingerprint } })
    yield* reviews.decide({ sessionID: root.id, itemID: item.itemID, decision: { kind: "guardrail", reply: "once" } })
    return { sessionID: root.id, fingerprint }
  }).pipe(Effect.scoped, Effect.provide(build())))
  await Effect.runPromise(Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    expect(yield* reviews.list(saved.sessionID)).toEqual([])
    expect(yield* reviews.consume(saved.sessionID, "guardrail", saved.fingerprint)).toBe(true)
    expect(yield* reviews.consume(saved.sessionID, "guardrail", saved.fingerprint)).toBe(false)
  }).pipe(Effect.provide(build())))
})

it.effect("reverting one message withdraws only that message's reviews among parallel calls", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  const first = SessionMessage.ID.make("msg_review_parallel_first")
  const second = SessionMessage.ID.make("msg_review_parallel_second")
  yield* session.prompt({ id: first, sessionID: root.id, text: "First", origin: "review", resume: false })
  yield* session.prompt({ id: second, sessionID: root.id, text: "Second", origin: "review", resume: false })
  const kept = yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16, origin: { messageID: first, callID: "call_first" }, payload })
  yield* reviews.open({ sessionID: root.id, kind: "question", reason: "free_text", limit: 16, origin: { messageID: second, callID: "call_second" }, payload })
  yield* reviews.withdrawAfter(root.id, first)
  expect((yield* reviews.list(root.id)).map((item) => item.itemID)).toEqual([kept.itemID])
}))

it.effect("a deferred guardrail action runs once after approval and is reviewed again on a second re-issue", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  yield* session.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const guardrail = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(root.location)))
  const messageID = SessionMessage.ID.make("msg_review_guardrail_call")
  const input = { sessionID: root.id, action: "shell", resources: ["TOKEN=synthetic-secret git reset --hard"], source: { messageID, callID: "call_guardrail" } }
  const deferred = yield* guardrail.assert(input).pipe(Effect.flip)
  expect(deferred).toBeInstanceOf(SessionGuardrail.DeferredError)
  const items = yield* reviews.list(root.id)
  expect(items).toHaveLength(1)
  expect(items[0]?.kind).toBe("guardrail")
  expect(items[0]?.origin).toEqual({ messageID, callID: "call_guardrail" })
  expect(JSON.stringify(items)).not.toContain("synthetic-secret")
  const review = items[0]
  if (review?.kind !== "guardrail") throw new Error("Expected guardrail review")
  expect(review.payload.resources).toEqual(["TOKEN=[redacted] git reset --hard"])
  expect(review.payload.fingerprint).toBe(SessionReview.fingerprint({ ...input, workdir: root.location.directory, ruleIDs: review.payload.ruleIDs, hardReview: true }))
  yield* reviews.decide({ sessionID: root.id, itemID: items[0]!.itemID, decision: { kind: "guardrail", reply: "once" } })
  const reservation = yield* guardrail.assert(input)
  yield* reservation.release
  const again = yield* guardrail.assert(input).pipe(Effect.flip)
  expect(again).toBeInstanceOf(SessionGuardrail.DeferredError)
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))

it.effect("a deferred permission ask runs once after approval and defers again on a second re-issue", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const reviews = yield* SessionReview.Service
  const root = yield* session.create({ location: yield* reviewLocation })
  yield* session.autonomy.set({ sessionID: root.id, sleep: true })
  const locations = yield* LocationServiceMap.Service
  const agents = yield* Agent.Service.pipe(Effect.provide(locations.get(root.location)))
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )
  const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(root.location)))
  const input = {
    sessionID: root.id, agent: Agent.ID.make("test"), action: "edit", resources: ["outside.txt"], save: ["outside.txt"],
    source: { type: "tool" as const, messageID: "msg_review_permission_call", callID: "call_permission" },
  }
  const first = yield* permission.assert(input).pipe(Effect.exit)
  expect(Exit.isFailure(first)).toBe(true)
  if (Exit.isFailure(first))
    expect(first.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeferredError)).toBe(true)
  const items = yield* reviews.list(root.id)
  expect(items).toHaveLength(1)
  expect(items[0]?.kind).toBe("permission")
  yield* reviews.decide({ sessionID: root.id, itemID: items[0]!.itemID, decision: { kind: "permission", reply: "once" } })
  yield* permission.assert(input)
  const second = yield* permission.assert(input).pipe(Effect.exit)
  expect(Exit.isFailure(second)).toBe(true)
  expect(yield* reviews.list(root.id)).toHaveLength(1)
}))
