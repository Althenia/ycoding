import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { Deferred, Effect, Fiber, Queue, Schema } from "effect"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Form } from "@ycoding-ai/core/form"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Permission } from "@ycoding-ai/core/permission"
import { Question } from "@ycoding-ai/core/question"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Model } from "@ycoding-ai/schema/model"
import { Hash } from "@ycoding-ai/core/util/hash"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())
const source = {
  kind: "dots-client", anchorSessionID: Session.ID.make("ses_anchor"), bindingID: "binding",
  delegationID: "grant", revision: 2, exchangeID: "decision",
  principal: { ownerID: "owner", deviceID: "device", clientID: "client", grantID: "oauth-grant", epoch: "epoch" },
} as const
const setup = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location: yield* reviewLocation })
  const locations = yield* LocationServiceMap.Service
  return { root, sessions, located: locations.get(root.location) }
})
const receipts = Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const result: unknown[] = []
  const stop = yield* events.listen((event) => Effect.sync(() => {
    if (event.type === SessionEvent.DotsDecisionSettled.type) result.push(event.data)
  }))
  yield* Effect.addFinalizer(() => stop)
  return result
})

it.effect("Dots source preserves principal identity and does not change native delegation", () => Effect.sync(() => {
  expect(Schema.decodeUnknownSync(Form.ReplySource)(source)).toEqual(source)
  expect(Schema.is(Form.DelegatedReplySource)(source)).toBe(false)
}))

it.effect("Dots forms validate external acknowledgements, conditional answers, exact state and cancellation", () => Effect.gen(function* () {
  const f = yield* setup
  const forms = yield* Form.Service.pipe(Effect.provide(f.located))
  const seen = yield* receipts
  const form = yield* forms.create({ sessionID: f.root.id, title: "Evidence", fields: [
    { key: "external", type: "external", url: "https://example.com/confirm" },
    { key: "enabled", type: "boolean", required: true },
    { key: "detail", type: "string", required: true, when: [{ key: "enabled", op: "eq", value: true }] },
  ] })
  const input = { id: form.id, fingerprint: Form.fingerprint(form), source, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* forms.replyDelegated({ ...input, explicitDecision: undefined, answer: { external: true, enabled: false } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* forms.replyDelegated({ ...input, answer: { external: true, enabled: true } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* forms.replyDelegated({ ...input, answer: { external: false, enabled: false } }).pipe(Effect.exit))._tag).toBe("Failure")
  yield* forms.replyDelegated({ ...input, answer: { external: true, enabled: false } })
  expect(yield* forms.state(form.id)).toEqual({ status: "answered", answer: { external: true, enabled: false } })
  expect(seen).toHaveLength(1)
  const next = yield* forms.create({ sessionID: f.root.id, title: "Cancel", fields: [{ key: "x", type: "string" }] })
  const cancel = { id: next.id, fingerprint: Form.fingerprint(next), source, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* forms.cancelDelegated({ ...cancel, explicitDecision: undefined }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* forms.cancelDelegated({ ...cancel, validate: () => Effect.succeed(false) }).pipe(Effect.exit))._tag).toBe("Failure")
  yield* forms.cancelDelegated(cancel)
  expect(yield* forms.state(next.id)).toEqual({ status: "cancelled" })
  expect((yield* forms.cancelDelegated(cancel).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toHaveLength(2)
}))

it.effect("Dots questions validate answers and reject with a durable attributed receipt", () => Effect.gen(function* () {
  const f = yield* setup
  const questions = yield* Question.Service.pipe(Effect.provide(f.located))
  const events = yield* EventRuntime.Service
  const seen = yield* receipts
  for (const reject of [false, true]) {
    const asked = yield* Deferred.make<Question.Request>()
    const stop = yield* events.listen((event) => event.type === Question.Event.Asked.type
      ? Deferred.succeed(asked, Schema.decodeUnknownSync(Question.Request)(event.data)).pipe(Effect.asVoid) : Effect.void)
    const waiting = yield* questions.ask({ sessionID: f.root.id, questions: [{ header: "Mode", question: "Which?", options: [{ label: "One", description: "First" }], custom: false }] }).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    yield* stop
    const input = { requestID: request.id, fingerprint: Question.fingerprint(request), source, explicitDecision: true as const, validate: () => Effect.succeed(true) }
    if (reject) expect((yield* questions.rejectDelegated({ ...input, explicitDecision: undefined }).pipe(Effect.exit))._tag).toBe("Failure")
    if (reject) {
      yield* questions.rejectDelegated(input)
      expect((yield* Fiber.join(waiting).pipe(Effect.exit))._tag).toBe("Failure")
      continue
    }
    expect((yield* questions.replyDelegated({ ...input, answers: [["invalid"]] }).pipe(Effect.exit))._tag).toBe("Failure")
    yield* questions.replyDelegated({ ...input, answers: [["One"]] })
    expect(yield* Fiber.join(waiting)).toEqual({ status: "answered", answers: [["One"]], source })
  }
  expect(seen).toHaveLength(2)
}))

it.effect("Dots explicit-decision permission settlement rechecks live policy and validator before settlement", () => Effect.gen(function* () {
  const f = yield* setup
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("dots-native")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const seen = yield* receipts
  const result = yield* permissions.ask({ sessionID: f.root.id, agent, action: "edit", resources: ["src/native.ts"], requireExplicitDecision: true })
  expect(result.effect).toBe("ask")
  const request = (yield* permissions.list())[0]
  const snapshot = yield* permissions.snapshot(request.id)
  const input = { requestID: request.id, fingerprint: snapshot!.fingerprint, source, explicitDecision: true as const, reply: "once" as const, validate: () => Effect.succeed(true) }
  expect((yield* permissions.replyDelegated({ ...input, explicitDecision: undefined }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* permissions.replyDelegated({ ...input, fingerprint: "0".repeat(64) }).pipe(Effect.exit))._tag).toBe("Failure")
  let validation = 0
  expect((yield* permissions.replyDelegated({ ...input, validate: () => Effect.sync(() => ++validation === 1) }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* permissions.snapshot(request.id)).toBeDefined()
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "deny" }] }))
  expect((yield* permissions.replyDelegated(input).pipe(Effect.exit))._tag).toBe("Failure")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  yield* permissions.replyDelegated(input)
  expect(yield* permissions.list()).toEqual([])
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ source, reply: "once" })
}))

const child = Effect.gen(function* () {
  const f = yield* setup
  const child = yield* f.sessions.create({ parentID: f.root.id, model: Schema.decodeUnknownSync(Model.Ref)({ providerID: "test", id: "model" }) })
  const events = yield* EventRuntime.Service
  yield* events.publish(SessionEvent.Task.Updated, Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)({ sessionID: child.id, change: {
    type: "launched", parentID: f.root.id, parentAssistantMessageID: "msg_parent", toolCallID: "call_child", inputID: "msg_child",
    description: "Native child", agent: "build", model: { providerID: "test", id: "model" }, promptDigest: "digest", background: true, delivery: "steer",
  } }))
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: child.id, change: { type: "started" } })
  return { ...f, child }
})

for (const version of [1, 2] as const) for (const change of ["none", "metadata", "resources"] as const) it.effect(`historical permission version ${version} matches only its exact preimage with ${change} changed`, () => Effect.gen(function* () {
  const f = yield* setup
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("historical")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const reviews = yield* SessionReview.Service
  const oldPayload = { type: "permission" as const, requestID: Permission.ID.make("per_historical"), action: "edit", resources: ["src/original.ts"], fingerprint: SessionReview.fingerprint({ action: "edit", resources: ["src/original.ts"], workdir: f.root.location.directory, metadata: { operationDigest: "original", requireHuman: true } }) }
  const item = yield* reviews.open({ sessionID: f.root.id, kind: "permission", reason: "disabled", origin: { requestID: "historical" }, payload: { ...oldPayload, fingerprintVersion: version }, limit: 16 })
  const database = yield* Database.Service
  const folded = (yield* SessionReviewFold.fold(database.db, [f.root.id]))[0]
  expect(SessionReviewFold.pendingFingerprint(folded)).toBe(Hash.json({ ...folded, payload: oldPayload }))
  yield* reviews.decide({ sessionID: f.root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const input = { sessionID: f.root.id, agent, action: "edit", resources: change === "resources" ? ["src/changed.ts"] : ["src/original.ts"], metadata: { operationDigest: change === "metadata" ? "changed" : "original" }, requireExplicitDecision: true }
  expect((yield* permissions.ask(input)).effect).toBe(version === 1 && change === "none" ? "allow" : "ask")
  if (version === 1 && change === "none") expect((yield* permissions.ask(input)).effect).toBe("ask")
}))

it.effect("historical explicit permission approval is consumed once by assert", () => Effect.gen(function* () {
  const f = yield* setup
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("historical-assert")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const reviews = yield* SessionReview.Service
  const item = yield* reviews.open({ sessionID: f.root.id, kind: "permission", reason: "disabled", origin: { requestID: "historical" }, payload: { type: "permission", fingerprintVersion: 1, requestID: Permission.ID.make("per_historical"), action: "edit", resources: ["src/original.ts"], fingerprint: SessionReview.fingerprint({ action: "edit", resources: ["src/original.ts"], workdir: f.root.location.directory, metadata: { operationDigest: "original", requireHuman: true } }) }, limit: 16 })
  yield* reviews.decide({ sessionID: f.root.id, itemID: item.itemID, decision: { kind: "permission", reply: "once" } })
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const events = yield* EventRuntime.Service
  const asked = yield* Deferred.make<"asked">()
  const stop = yield* events.listen((event) => event.type === Permission.Event.Asked.type ? Deferred.succeed(asked, "asked").pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const input = { sessionID: f.root.id, agent, action: "edit", resources: ["src/original.ts"], metadata: { operationDigest: "original" }, requireExplicitDecision: true }
  const waiting = yield* permissions.assert(input).pipe(Effect.forkScoped)
  expect(yield* Effect.race(Deferred.await(asked), Fiber.join(waiting).pipe(Effect.as("allowed" as const)))).toBe("allowed")
  expect((yield* permissions.ask(input)).effect).toBe("ask")
}))

it.effect("explicit client rejection vetoes routine approval and a later explicit approval clears it", () => Effect.gen(function* () {
  const f = yield* setup
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("explicit-rejection")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const request = { sessionID: f.root.id, agent, action: "edit", resources: ["src/explicit.ts"] }
  yield* permissions.ask(request)
  const first = (yield* permissions.snapshots(f.root.id))[0]
  yield* permissions.replyDelegated({ requestID: first.request.id, fingerprint: first.fingerprint, source, explicitDecision: true, reply: "reject", validate: () => Effect.succeed(true) })
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.set({ sessionID: f.root.id, permissions: "auto" })
  expect((yield* permissions.ask(request)).effect).toBe("ask")
  const next = (yield* permissions.snapshots(f.root.id))[0]
  expect(yield* permissions.delegatedEligible({ requestID: next.request.id, fingerprint: next.fingerprint, reply: "once" })).toBe(false)
  yield* permissions.replyDelegated({ requestID: next.request.id, fingerprint: next.fingerprint, source, explicitDecision: true, reply: "once", validate: () => Effect.succeed(true) })
  expect((yield* permissions.ask(request)).effect).toBe("allow")
  yield* autonomy.set({ sessionID: f.root.id, permissions: "manual" })
  yield* permissions.ask(request)
  const last = (yield* permissions.snapshots(f.root.id))[0]
  expect(yield* permissions.delegatedEligible({ requestID: last.request.id, fingerprint: last.fingerprint, reply: "once" })).toBe(true)
}))

for (const transport of ["native", "delegated"] as const) it.effect(`${transport} guardrail approval cannot override a current custom deny`, () => Effect.gen(function* () {
  const location = yield* reviewLocation
  const file = `${location.directory}/.ycoding/guardrails/current.md`
  const document = (decision: "ask" | "deny") => `---\nid: current-policy\ndecision: ${decision}\nactions: [shell]\nresources: [synthetic-command]\nreason: Explicit decision\n---\n`
  yield* Effect.promise(() => fs.mkdir(`${location.directory}/.ycoding/guardrails`, { recursive: true }))
  yield* Effect.promise(() => Bun.write(file, document("ask")))
  const sessions = yield* Session.Service
  const root = yield* sessions.create({ location })
  const locations = yield* LocationServiceMap.Service
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(locations.get(location)))
  const events = yield* EventRuntime.Service
  const asked = yield* Deferred.make<Guardrail.Request>()
  const stop = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type ? Deferred.succeed(asked, event.data as Guardrail.Request).pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* guardrails.assert({ sessionID: root.id, action: "shell", resources: ["synthetic-command"] }).pipe(Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  const snapshot = yield* guardrails.requestSnapshot(root.id, request.id)
  const reply = { sessionID: root.id, requestID: request.id, reply: "once" as const }
  yield* Effect.promise(() => Bun.write(file, document("deny")))
  const approve = () => transport === "native" ? guardrails.reply(reply) : guardrails.replyDelegated({ ...reply, fingerprint: snapshot!.fingerprint, source, explicitDecision: true, validate: () => Effect.succeed(true) })
  expect((yield* approve().pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* guardrails.forSession(root.id)).toEqual([request])
  yield* Effect.promise(() => Bun.write(file, document("ask")))
  yield* approve()
  yield* (yield* Fiber.join(waiting)).release
}))

it.effect("explicit guardrail rejection vetoes Auto and routine delegation until explicit approval", () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
  const asked = yield* Queue.unbounded<Guardrail.Request>()
  const stop = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type ? Queue.offer(asked, event.data as Guardrail.Request).pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const input = { sessionID: f.root.id, action: "file_mutation", resources: ["/synthetic-outside/probe.txt"] }
  const waiting = yield* guardrails.assert(input).pipe(Effect.forkScoped)
  const first = yield* Queue.take(asked)
  const firstSnapshot = yield* guardrails.requestSnapshot(f.root.id, first.id)
  yield* guardrails.replyDelegated({ sessionID: f.root.id, requestID: first.id, fingerprint: firstSnapshot!.fingerprint, source, explicitDecision: true, reply: "reject", validate: () => Effect.succeed(true) })
  expect((yield* Fiber.await(waiting))._tag).toBe("Failure")
  const autonomy = yield* SessionAutonomy.Service
  yield* autonomy.set({ sessionID: f.root.id, guardrails: "auto" })
  const held = yield* guardrails.assert(input).pipe(Effect.forkScoped)
  const next = yield* Queue.take(asked)
  const snapshot = yield* guardrails.requestSnapshot(f.root.id, next.id)
  expect(yield* guardrails.delegatedEligible({ sessionID: f.root.id, requestID: next.id, fingerprint: snapshot!.fingerprint, reply: "once" })).toBe(false)
  yield* guardrails.replyDelegated({ sessionID: f.root.id, requestID: next.id, fingerprint: snapshot!.fingerprint, source, explicitDecision: true, reply: "once", validate: () => Effect.succeed(true) })
  yield* (yield* Fiber.join(held)).release
  const allowed = yield* guardrails.assert(input)
  yield* allowed.release
  expect(yield* guardrails.forSession(f.root.id)).toEqual([])
}))

it.effect("Dots hard guardrail approval rechecks authorization in the receipt transaction", () => Effect.gen(function* () {
  const f = yield* setup
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
  const events = yield* EventRuntime.Service
  const seen = yield* receipts
  const input = { sessionID: f.root.id, action: "shell", resources: ["git reset --hard"] }
  expect((yield* guardrails.evaluate(input)).hardReview).toBe(true)
  const asked = yield* Deferred.make<Guardrail.Request>()
  const stop = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type
    ? Deferred.succeed(asked, Schema.decodeUnknownSync(Guardrail.Request)(event.data)).pipe(Effect.asVoid) : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* guardrails.assert(input).pipe(Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  const snapshot = yield* guardrails.requestSnapshot(f.root.id, request.id)
  const reply = { sessionID: f.root.id, requestID: request.id, reply: "once" as const, fingerprint: snapshot!.fingerprint, source, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* guardrails.replyDelegated({ ...reply, explicitDecision: undefined }).pipe(Effect.exit))._tag).toBe("Failure")
  let validation = 0
  expect((yield* guardrails.replyDelegated({ ...reply, validate: () => Effect.sync(() => ++validation === 1) }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* guardrails.requestSnapshot(f.root.id, request.id)).toBeDefined()
  yield* guardrails.replyDelegated(reply)
  const reservation = yield* Fiber.join(waiting)
  yield* reservation.release
  expect(seen).toHaveLength(1)
}))

it.effect("Dots review-owned subagent dismissals retain provenance and cannot be answered by the ordinary parent path", () => Effect.gen(function* () {
  const f = yield* child
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(f.child.id, "Need evidence")
  yield* f.sessions.autonomy.set({ sessionID: f.root.id, sleep: true })
  expect((yield* orchestration.answer({ parentID: f.root.id, childID: f.child.id, questionID: question.question.id, text: "Parent" }).pipe(Effect.exit))._tag).toBe("Failure")
  const reviews = yield* SessionReview.Service
  const snapshot = (yield* reviews.pendingSnapshots(f.root.id))[0]
  const seen = yield* receipts
  yield* reviews.decideDelegated({ sessionID: f.root.id, itemID: snapshot.item.itemID, fingerprint: snapshot.fingerprint, source, explicitDecision: true, validate: () => Effect.succeed(true), decision: { kind: "subagent_question", dismissed: true } })
  expect((yield* f.sessions.pending(f.child.id))[0]).toMatchObject({ type: "synthetic", data: { metadata: { dotsSource: source } } })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ target: { kind: "review", itemID: snapshot.item.itemID, fingerprint: snapshot.fingerprint } })
}))

for (const kind of ["question", "permission", "guardrail"] as const) it.effect(`Dots deferred ${kind} decisions are exact, atomic, attributed, once-only and reconcile without human identity`, () => Effect.gen(function* () {
  const f = yield* setup
  const reviews = yield* SessionReview.Service
  const seen = yield* receipts
  const payload = kind === "question" ? { type: "form" as const, title: "Evidence", fields: [{ key: "x", type: "string" as const, required: true }] as const }
    : kind === "permission" ? { type: "permission" as const, fingerprintVersion: 2 as const, requestID: Permission.ID.make("per_deferred"), action: "edit", resources: ["file"], fingerprint: SessionReview.fingerprint({ action: "edit", resources: ["file"], workdir: f.root.location.directory }) }
    : { type: "guardrail" as const, requestID: SessionGuardrail.RequestID.make("grq_deferred"), action: "shell", resources: ["git reset --hard"], ruleIDs: ["custom.hard"], reason: "Review", hardReview: true, directories: [], fingerprint: SessionReview.fingerprint({ action: "shell", resources: ["git reset --hard"], workdir: f.root.location.directory }) }
  const item = yield* reviews.open({ sessionID: f.root.id, kind, reason: "sleep_entry", origin: { requestID: "native" }, payload, limit: 16 })
  const snapshot = (yield* reviews.pendingSnapshots(f.root.id)).find((entry) => entry.item.itemID === item.itemID)!
  const decision = kind === "question" ? { kind, answers: { x: "Evidence" } } : { kind, reply: "once" as const }
  const input = { sessionID: f.root.id, itemID: item.itemID, decision, fingerprint: snapshot.fingerprint, source, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* reviews.decideDelegated({ ...input, explicitDecision: undefined }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* reviews.decideDelegated({ ...input, fingerprint: "0".repeat(64) }).pipe(Effect.exit))._tag).toBe("Failure")
  let validation = 0
  expect((yield* reviews.decideDelegated({ ...input, validate: () => Effect.sync(() => ++validation === 1) }).pipe(Effect.exit))._tag).toBe("Failure")
  if (kind !== "question") expect((yield* reviews.decideDelegated({ ...input, decision: { kind, reply: "always" } }).pipe(Effect.exit))._tag).toBe("Failure")
  yield* reviews.decideDelegated(input)
  expect((yield* reviews.decideDelegated(input).pipe(Effect.exit))._tag).toBe("Failure")
  yield* reviews.reconcile
  const pending = yield* SessionPending.lookup((yield* Database.Service).db, f.root.id, SessionReview.promptID(item.itemID))
  expect(pending).toMatchObject({ type: "synthetic", data: { metadata: { dotsSource: source } } })
  expect(JSON.stringify(pending)).not.toContain("The user")
  expect(seen).toHaveLength(1)
  expect((yield* SessionReviewFold.fold((yield* Database.Service).db, [f.root.id]))[0]).toMatchObject({ source })
}))

it.effect("Dots subagent answers preserve task/input provenance with an exact revision fence", () => Effect.gen(function* () {
  const f = yield* child
  const orchestration = yield* SessionOrchestration.Service
  const question = yield* orchestration.question(f.child.id, "Need evidence")
  const snapshot = (yield* orchestration.questionSnapshots(f.root.id))[0]
  const seen = yield* receipts
  const input = { parentID: f.root.id, childID: f.child.id, questionID: question.question.id, text: "External evidence", dots: { source, explicitDecision: true as const, fingerprint: snapshot.fingerprint, validate: () => Effect.succeed(true) } }
  expect((yield* orchestration.answer({ ...input, dots: { ...input.dots, explicitDecision: undefined } }).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* orchestration.answer({ ...input, dots: { ...input.dots, validate: () => Effect.succeed(false) } }).pipe(Effect.exit))._tag).toBe("Failure")
  yield* orchestration.answer(input)
  expect((yield* orchestration.answer(input).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* f.sessions.pending(f.child.id))[0]).toMatchObject({ type: "synthetic", data: { metadata: { dotsSource: source } } })
  expect(seen).toHaveLength(1)
}))

for (const choice of ["continue", "stop"] as const) it.effect(`Dots recovery ${choice} commits receipt with durable recovery decision and truthful actor`, () => Effect.gen(function* () {
  const f = yield* child
  const events = yield* EventRuntime.Service
  const questionID = QuestionID.make("qst_recovery")
  yield* events.publish(SessionEvent.Task.Updated, { sessionID: f.child.id, change: { type: "question_asked", question: { id: questionID, text: "Recovery", time: 1 } } })
  const reviews = yield* SessionReview.Service
  const item = yield* reviews.open({ sessionID: f.child.id, kind: "recovery", reason: "restart", origin: { questionID }, payload: { type: "recovery", tools: [{ messageID: SessionMessage.ID.make("msg_tool"), callID: "call_tool", name: "shell" }] }, limit: 16 })
  const snapshot = (yield* reviews.pendingSnapshots(f.root.id))[0]
  const seen = yield* receipts
  yield* reviews.decideDelegated({ sessionID: f.root.id, itemID: item.itemID, fingerprint: snapshot.fingerprint, decision: { kind: "recovery", choice }, source, explicitDecision: true, validate: () => Effect.succeed(true) })
  expect((yield* SessionReviewFold.fold((yield* Database.Service).db, [f.child.id]))[0]).toMatchObject({ source, decision: { kind: "recovery", choice } })
  expect(JSON.stringify(yield* f.sessions.pending(f.child.id))).not.toContain("The user")
  expect(seen).toHaveLength(1)
}))

for (const kind of ["permission", "guardrail"] as const) it.effect(`${kind} interruption emits one cancellation for its actual pending request and leaves independent requests alive`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("cancel-test")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
  const asked = yield* Deferred.make<string>()
  const cancelled: unknown[] = []
  const stop = yield* events.listen((event) => {
    if (event.type === `${kind}.cancelled`) return Effect.sync(() => { cancelled.push(event.data) })
    if (event.type !== `${kind}.asked`) return Effect.void
    const request = kind === "permission" ? Schema.decodeUnknownSync(Schema.Struct({ id: Permission.ID }))(event.data) : Schema.decodeUnknownSync(Guardrail.Request)(event.data)
    return Deferred.succeed(asked, request.id).pipe(Effect.asVoid)
  })
  yield* Effect.addFinalizer(() => stop)
  const running = kind === "permission"
    ? permissions.assert({ sessionID: f.root.id, agent, action: "read", resources: ["interrupted"], requireExplicitDecision: true }).pipe(Effect.orDie)
    : guardrails.assert({ sessionID: f.root.id, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.asVoid, Effect.orDie)
  const waiting = yield* running.pipe(Effect.forkScoped)
  const id = yield* Effect.raceFirst(Deferred.await(asked), Fiber.await(waiting).pipe(Effect.flatMap((exit) => Effect.die(`Request settled before becoming pending: ${exit._tag === "Failure" ? exit.cause.toString() : "allowed"}`))))
  const independent = yield* permissions.ask({ sessionID: f.root.id, agent, action: "read", resources: ["independent"], requireExplicitDecision: true })
  yield* Fiber.interrupt(waiting)
  expect(cancelled).toEqual([expect.objectContaining({ sessionID: f.root.id, requestID: id })])
  expect(yield* permissions.get(independent.id)).toBeDefined()
  yield* permissions.reply({ requestID: independent.id, reply: "once" })
  expect(cancelled).toHaveLength(1)
}))

test("permission scope close emits cancellation without fabricating a reply", async () => {
  const cancellations: unknown[] = []
  const replies: unknown[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* setup
    const events = yield* EventRuntime.Service
    const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
    const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
    const agent = Agent.ID.make("scope-test")
    yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [{ action: "*", resource: "*", effect: "ask" }] }))
    yield* events.listen((event) => Effect.sync(() => {
      if (event.type === "permission.cancelled") cancellations.push(event.data)
      if (event.type === "permission.replied") replies.push(event.data)
    }))
    expect((yield* permissions.ask({ sessionID: f.root.id, agent, action: "read", resources: ["scope"], requireExplicitDecision: true })).effect).toBe("ask")
  }).pipe(Effect.scoped, Effect.provide(reviewLayer())))
  expect(cancellations).toHaveLength(1)
  expect(replies).toEqual([])
})

test("guardrail scope close emits cancellation once without fabricating a reply", async () => {
  const cancellations: unknown[] = []
  const replies: unknown[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const f = yield* setup
    const events = yield* EventRuntime.Service
    const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
    const asked = yield* Deferred.make<void>()
    yield* events.listen((event) => {
      if (event.type === Guardrail.Event.Asked.type) return Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
      return Effect.sync(() => {
        if (event.type === "guardrail.cancelled") cancellations.push(event.data)
        if (event.type === "guardrail.replied") replies.push(event.data)
      })
    })
    yield* guardrails.assert({ sessionID: f.root.id, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.forkScoped)
    yield* Deferred.await(asked)
  }).pipe(Effect.scoped, Effect.provide(reviewLayer())))
  expect(cancellations).toHaveLength(1)
  expect(replies).toEqual([])
})

for (const kind of ["permission", "guardrail"] as const) it.effect(`${kind} deferral settles its caller without a second cancellation signal`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("defer-test")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [] }))
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
  const asked = yield* Deferred.make<void>()
  const cancelled: unknown[] = []
  const stop = yield* events.listen((event) => event.type === `${kind}.asked` ? Deferred.succeed(asked, undefined).pipe(Effect.asVoid)
    : Effect.sync(() => { if (event.type === `${kind}.cancelled`) cancelled.push(event.data) }))
  yield* Effect.addFinalizer(() => stop)
  const running = kind === "permission"
    ? permissions.assert({ sessionID: f.root.id, agent, action: "edit", resources: ["file"], metadata: {}, save: [] }).pipe(Effect.exit, Effect.map((exit) => exit._tag))
    : guardrails.assert({ sessionID: f.root.id, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.exit, Effect.map((exit) => exit._tag))
  const waiting = yield* running.pipe(Effect.forkScoped)
  yield* Deferred.await(asked)
  yield* (kind === "permission" ? permissions.deferPending(f.root.id) : guardrails.deferPending(f.root.id))
  expect(yield* Fiber.join(waiting)).toBe("Failure")
  expect(cancelled).toEqual([])
}))

for (const cancel of [false, true]) it.effect(`Dots form ${cancel ? "cancellation" : "reply"} remains settled after a notification defect`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const forms = yield* Form.Service.pipe(Effect.provide(f.located))
  const form = yield* forms.create({ sessionID: f.root.id, title: "Notify", fields: [{ type: "string", key: "text" }] })
  const seen = yield* receipts
  const stop = yield* events.listen((event) => event.type === (cancel ? Form.Event.Cancelled.type : Form.Event.Replied.type) ? Effect.die("notification failed") : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const input = { id: form.id, fingerprint: Form.fingerprint(form), source: { ...source, anchorSessionID: f.root.id, exchangeID: `notify-form-${cancel}` }, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* (cancel ? forms.cancelDelegated(input) : forms.replyDelegated({ ...input, answer: { text: "yes" } })).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toHaveLength(1)
  expect((yield* forms.state(form.id)).status).toBe(cancel ? "cancelled" : "answered")
}))

for (const reject of [false, true]) it.effect(`Dots question ${reject ? "rejection" : "reply"} remains settled after a notification defect`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const questions = yield* Question.Service.pipe(Effect.provide(f.located))
  const asked = yield* Deferred.make<Question.Request>()
  const stop = yield* events.listen((event) => event.type === Question.Event.Asked.type ? Deferred.succeed(asked, Schema.decodeUnknownSync(Question.Request)(event.data)).pipe(Effect.asVoid)
    : event.type === (reject ? Question.Event.Rejected.type : Question.Event.Replied.type) ? Effect.die("notification failed") : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* questions.ask({ sessionID: f.root.id, questions: [{ question: "Notify?", header: "Notify", options: [{ label: "Yes", description: "Continue" }], custom: false }] }).pipe(Effect.exit, Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  const seen = yield* receipts
  const input = { requestID: request.id, fingerprint: Question.fingerprint(request), source: { ...source, anchorSessionID: f.root.id, exchangeID: `notify-question-${reject}` }, explicitDecision: true as const, validate: () => Effect.succeed(true) }
  expect((yield* (reject ? questions.rejectDelegated(input) : questions.replyDelegated({ ...input, answers: [["Yes"]] })).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toHaveLength(1)
  expect(yield* questions.list()).toEqual([])
  yield* Effect.yieldNow
  expect(waiting.pollUnsafe()).toBeDefined()
}))

for (const reply of ["once", "reject"] as const) it.effect(`Dots permission ${reply} remains settled after a notification defect`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const agents = yield* Agent.Service.pipe(Effect.provide(f.located))
  const agent = Agent.ID.make("notify-test")
  yield* agents.transform((draft) => draft.update(agent, (entry) => { entry.permissions = [] }))
  const permissions = yield* Permission.Service.pipe(Effect.provide(f.located))
  const admitted = yield* permissions.ask({ sessionID: f.root.id, agent, action: "edit", resources: ["file"], metadata: {}, save: [] })
  const snapshot = yield* permissions.snapshot(admitted.id)
  const seen = yield* receipts
  const stop = yield* events.listen((event) => event.type === Permission.Event.Replied.type ? Effect.die("notification failed") : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  expect((yield* permissions.replyDelegated({ requestID: admitted.id, fingerprint: snapshot!.fingerprint, source: { ...source, anchorSessionID: f.root.id, exchangeID: `notify-permission-${reply}` }, reply, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toHaveLength(1)
  expect(yield* permissions.list()).toEqual([])
}))

for (const reply of ["once", "reject"] as const) it.effect(`Dots guardrail ${reply} remains settled after a notification defect`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const guardrails = yield* SessionGuardrail.Service.pipe(Effect.provide(f.located))
  const asked = yield* Deferred.make<Guardrail.Request>()
  const stop = yield* events.listen((event) => event.type === Guardrail.Event.Asked.type ? Deferred.succeed(asked, Schema.decodeUnknownSync(Guardrail.Request)(event.data)).pipe(Effect.asVoid)
    : event.type === Guardrail.Event.Replied.type ? Effect.die("notification failed") : Effect.void)
  yield* Effect.addFinalizer(() => stop)
  const waiting = yield* guardrails.assert({ sessionID: f.root.id, action: "shell", resources: ["git reset --hard"] }).pipe(Effect.exit, Effect.forkScoped)
  const request = yield* Deferred.await(asked)
  const snapshot = yield* guardrails.requestSnapshot(f.root.id, request.id)
  const seen = yield* receipts
  expect((yield* guardrails.replyDelegated({ sessionID: f.root.id, requestID: request.id, fingerprint: snapshot!.fingerprint, source: { ...source, anchorSessionID: f.root.id, exchangeID: `notify-guardrail-${reply}` }, explicitDecision: true, reply, validate: () => Effect.succeed(true) }).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toHaveLength(1)
  yield* Effect.yieldNow
  expect(waiting.pollUnsafe()).toBeDefined()
}))

for (const failAt of ["input", "receipt"] as const) it.effect(`Dots review admission rolls back its continuation, decision and receipt when ${failAt} publication fails`, () => Effect.gen(function* () {
  const f = yield* setup
  const events = yield* EventRuntime.Service
  const database = yield* Database.Service
  const reviews = yield* SessionReview.Service
  const seen = yield* receipts
  const item = yield* reviews.open({ sessionID: f.root.id, kind: "question", reason: "sleep_entry", origin: { requestID: "native-question" },
    payload: { type: "question", questions: [{ question: "Which evidence?", header: "Evidence", options: [{ label: "Report", description: "Use report" }], custom: false }] }, limit: 16 })
  const snapshot = (yield* reviews.pendingSnapshots(f.root.id))[0]
  let rejectPublication = true
  yield* events.project(failAt === "input" ? SessionEvent.InputAdmitted : SessionEvent.DotsDecisionSettled,
    () => rejectPublication ? Effect.die("admission publication failed") : Effect.void)
  const input = { sessionID: f.root.id, itemID: item.itemID, fingerprint: snapshot.fingerprint, source, explicitDecision: true as const, validate: () => Effect.succeed(true), decision: { kind: "question" as const, answers: [["Report"]] } }
  expect((yield* reviews.decideDelegated(input).pipe(Effect.exit))._tag).toBe("Failure")
  expect(seen).toEqual([])
  expect((yield* SessionReviewFold.fold(database.db, [f.root.id]))[0].decision).toBeUndefined()
  expect(yield* SessionPending.lookup(database.db, f.root.id, SessionReview.promptID(item.itemID))).toBeUndefined()
  rejectPublication = false
  const admittedAtReceipt: boolean[] = []
  const stop = yield* events.listen((event) => event.type !== SessionEvent.DotsDecisionSettled.type ? Effect.void : Effect.gen(function* () {
    admittedAtReceipt.push((yield* SessionPending.lookup(database.db, f.root.id, SessionReview.promptID(item.itemID))) !== undefined)
  }))
  yield* Effect.addFinalizer(() => stop)
  yield* reviews.decideDelegated(input)
  expect(seen).toHaveLength(1)
  expect(admittedAtReceipt).toEqual([true])
  const admitted = yield* SessionPending.lookup(database.db, f.root.id, SessionReview.promptID(item.itemID))
  expect(admitted).toMatchObject({ type: "synthetic", data: { metadata: { dotsSource: source } } })
  expect(JSON.stringify(admitted)).toContain("The authenticated Dots client answered")
  expect(JSON.stringify(admitted)).not.toContain("the user slept")
}))
