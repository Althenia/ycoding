import { expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Money } from "@ycoding-ai/schema/money"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { ModelIncidentTable } from "@ycoding-ai/core/model-incident/sql"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Permission } from "@ycoding-ai/core/permission"
import { Provider } from "@ycoding-ai/core/provider"
import { Session } from "@ycoding-ai/core/session"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { reviewLayer, reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

const it = testEffect(reviewLayer())
const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("code-mode") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const codeModeCall = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: Agent.ID.make("build"), model })
    yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID: "call_execute", name: "execute" })
    yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, callID: "call_execute", input: {}, executed: false })
    yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, finish: "tool-calls", cost: Money.USD.zero, tokens })
    return assistantMessageID
  })

const guardrailItem = (
  sessionID: Session.ID,
  requestID: string,
  input: { readonly origin: SessionReviewFold.OpenInput["origin"]; readonly reason: SessionReviewFold.OpenInput["reason"]; readonly limit?: number },
) =>
  Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    return yield* reviews.open({
      sessionID,
      kind: "guardrail",
      reason: input.reason,
      origin: input.origin,
      limit: input.limit ?? 16,
      payload: {
        type: "guardrail",
        requestID: SessionGuardrail.RequestID.make(requestID),
        action: "shell",
        resources: ["/outside"],
        ruleIDs: ["standard.review.outside"],
        reason: "Review",
        hardReview: false,
        directories: [],
        fingerprint: SessionReview.fingerprint({ action: "shell", resources: ["/outside"], workdir: "/project", ruleIDs: ["standard.review.outside"] }),
      },
    })
  })

const incidents = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db
      .select({
        kind: ModelIncidentTable.kind,
        providerID: ModelIncidentTable.provider_id,
        modelID: ModelIncidentTable.model_id,
        agent: ModelIncidentTable.agent,
        requestID: ModelIncidentTable.request_id,
        category: ModelIncidentTable.category,
        decidedBy: ModelIncidentTable.decided_by,
      })
      .from(ModelIncidentTable)
      .where(eq(ModelIncidentTable.session_id, sessionID))
      .orderBy(ModelIncidentTable.time_created, ModelIncidentTable.id)
      .all()
      .pipe(Effect.orDie)
  })

const deferredEvents = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return (yield* db.select({ type: EventTable.type }).from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)).filter(
      (row) => row.type.startsWith(SessionEvent.Review.Deferred.type),
    )
  })

const escalated = {
  kind: "guardrail-escalated" as const,
  providerID: Provider.ID.make("test"),
  modelID: CatalogModel.ID.make("code-mode"),
  agent: Agent.ID.make("build"),
  category: "ordinary",
  decidedBy: null,
}

it.effect("a guardrail deferral records its escalation against the canonical Code Mode tool-call source with the review event", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const root = yield* session.create({ location: yield* reviewLocation })
    const messageID = yield* codeModeCall(root.id)
    yield* guardrailItem(root.id, "grq_code_mode", { origin: { messageID, callID: "call_execute" }, reason: "refused" })
    expect(yield* incidents(root.id)).toEqual([{ ...escalated, requestID: "grq_code_mode" }])
    expect(yield* deferredEvents(root.id)).toHaveLength(1)

    yield* guardrailItem(root.id, "grq_sleep_entry", { origin: { messageID, callID: "call_execute" }, reason: "sleep_entry" })
    yield* guardrailItem(root.id, "grq_no_source", { origin: { requestID: "grq_no_source" }, reason: "escalated" })
    const full = yield* guardrailItem(root.id, "grq_full", { origin: { messageID, callID: "call_execute" }, reason: "escalated", limit: 3 }).pipe(
      Effect.flip,
    )
    expect(full).toBeInstanceOf(SessionReview.FullError)
    expect(yield* incidents(root.id)).toEqual([{ ...escalated, requestID: "grq_code_mode" }])
    expect(yield* deferredEvents(root.id)).toHaveLength(3)
  }),
)

it.effect("a guardrail deferred because model review is disabled records no model escalation", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const root = yield* session.create({ location: yield* reviewLocation })
    const messageID = yield* codeModeCall(root.id)
    yield* guardrailItem(root.id, "grq_disabled", { origin: { messageID, callID: "call_execute" }, reason: "disabled" })
    expect(yield* deferredEvents(root.id)).toHaveLength(1)
    expect(yield* incidents(root.id)).toEqual([])
  }),
)

it.effect("a human guardrail rejection records one rejection while approvals and other kinds record none", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const reviews = yield* SessionReview.Service
    const root = yield* session.create({ location: yield* reviewLocation })
    const messageID = yield* codeModeCall(root.id)
    const rejected = yield* guardrailItem(root.id, "grq_reject", { origin: { messageID, callID: "call_execute" }, reason: "escalated" })
    const approved = yield* guardrailItem(root.id, "grq_approve", { origin: { messageID, callID: "call_execute" }, reason: "escalated" })
    const unsourced = yield* guardrailItem(root.id, "grq_unsourced", { origin: { requestID: "grq_unsourced" }, reason: "sleep_entry" })
    yield* guardrailItem(root.id, "grq_converted", { origin: { messageID, callID: "call_execute" }, reason: "escalated" })
    const converted = yield* guardrailItem(root.id, "grq_converted", { origin: { requestID: "grq_converted" }, reason: "sleep_entry" })
    const fingerprint = SessionReview.fingerprint({ action: "edit", resources: ["file"], workdir: root.location.directory })
    const permission = yield* reviews.open({
      sessionID: root.id,
      kind: "permission",
      reason: "sleep_entry",
      limit: 16,
      origin: { messageID, callID: "call_execute" },
      payload: { type: "permission", action: "edit", resources: ["file"], fingerprint, requestID: Permission.ID.make("per_reject") },
    })
    yield* reviews.decide({ sessionID: root.id, itemID: rejected.itemID, decision: { kind: "guardrail", reply: "reject" } })
    yield* reviews.decide({ sessionID: root.id, itemID: approved.itemID, decision: { kind: "guardrail", reply: "once" } })
    yield* reviews.decide({ sessionID: root.id, itemID: unsourced.itemID, decision: { kind: "guardrail", reply: "reject" } })
    yield* reviews.decide({ sessionID: root.id, itemID: converted.itemID, decision: { kind: "guardrail", reply: "reject" } })
    yield* reviews.decide({ sessionID: root.id, itemID: permission.itemID, decision: { kind: "permission", reply: "reject" } })
    expect((yield* incidents(root.id)).filter((row) => row.kind === "guardrail-rejected")).toEqual([
      { ...escalated, kind: "guardrail-rejected", requestID: "grq_reject", decidedBy: "human" },
      { ...escalated, kind: "guardrail-rejected", requestID: "grq_converted", decidedBy: "human" },
    ])
  }),
)
