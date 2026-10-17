import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionMessageUpdater } from "@ycoding-ai/core/session/message-updater"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import {
  SessionMessageTable,
  SessionTable,
  SessionTaskNotificationTable,
  SessionTaskTable,
} from "@ycoding-ai/core/session/sql"
import { SessionOrchestration as SessionOrchestrationSchema } from "@ycoding-ai/schema/session-orchestration"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, SessionProjector.node])))
const sessionID = SessionSchema.ID.make("ses_contract")
const parentID = SessionSchema.ID.make("ses_contract_parent")
const childID = SessionSchema.ID.make("ses_contract_child")
const build = Agent.defaultID
const modelA = { id: CatalogModel.ID.make("model-a"), providerID: Provider.ID.make("provider") }
const modelB = { id: CatalogModel.ID.make("model-b"), providerID: Provider.ID.make("fallback") }
const modelC = { id: CatalogModel.ID.make("model-c"), providerID: Provider.ID.make("fallback") }
const resumedExcerpt = "The service restarted while this subagent was working; it resumed with one recovery step."
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)

const seed = (sessions: ReadonlyArray<readonly [SessionSchema.ID, SessionSchema.ID | undefined]>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    for (const [id, parent] of sessions)
      yield* db
        .insert(SessionTable)
        .values({ id, project_id: Project.ID.global, parent_id: parent, directory: "/project", title: id })
        .run()
        .pipe(Effect.orDie)
  })

const messages = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, id))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
  })

const eventTypes = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const rows = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => row.type)
  })

const task = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.session_id, childID))
    .get()
    .pipe(Effect.orDie)
})

const notifications = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  return yield* db
    .select()
    .from(SessionTaskNotificationTable)
    .where(eq(SessionTaskNotificationTable.task_session_id, childID))
    .orderBy(asc(SessionTaskNotificationTable.revision))
    .all()
    .pipe(Effect.orDie)
})

const change = (value: SessionOrchestrationSchema.Change) =>
  EventRuntime.Service.use((events) => events.publish(SessionEvent.Task.Updated, { sessionID: childID, change: value }))

const question = {
  id: SessionOrchestrationSchema.QuestionID.make("qst_contract"),
  text: "Proceed?",
  time: 4,
}

const launched = (background: boolean) =>
  Effect.gen(function* () {
    yield* seed([
      [parentID, undefined],
      [childID, parentID],
    ])
    yield* change({
      type: "launched",
      parentID,
      parentAssistantMessageID: SessionMessage.ID.make("msg_contract_parent"),
      toolCallID: "call_contract",
      inputID: SessionMessage.ID.make("msg_contract_input"),
      description: "Contract child",
      agent: build,
      model: modelA,
      promptDigest: "digest",
      background,
      delivery: "steer",
    })
    yield* change({ type: "started" })
  })

const rejected = (value: SessionOrchestrationSchema.Change) =>
  Effect.gen(function* () {
    const before = yield* task
    const sent = yield* notifications
    const sequence = (yield* SessionOrchestration.snapshot((yield* Database.Service).db, parentID)).sequence
    expect(yield* Effect.exit(change(value))).toMatchObject({ _tag: "Failure" })
    expect(yield* task).toEqual(before)
    expect(yield* notifications).toEqual(sent)
    expect((yield* SessionOrchestration.snapshot((yield* Database.Service).db, parentID)).sequence).toBe(sequence)
  })

const deferral = {
  sessionID,
  itemID: SessionReview.ID.make("rvw_contract"),
  kind: "question",
  reason: "free_text",
  origin: { requestID: "frm_contract" },
  payload: { type: "form", title: "Plan", fields: [{ key: "plan", type: "string", required: true }] },
} as const

describe("Session task projection of restart and timeout changes", () => {
  it.effect("a timed-out question returns the waiting child to running and clears the question", () =>
    Effect.gen(function* () {
      yield* launched(true)
      yield* change({ type: "question_asked", question })
      const asked = yield* task
      yield* change({ type: "question_timed_out", questionID: question.id })
      expect(yield* task).toMatchObject({
        state: "running",
        question_id: null,
        question: null,
        question_data: null,
        question_time: null,
        revision: (asked?.revision ?? 0) + 1,
      })
      expect((yield* notifications).map((row) => row.type)).toEqual(["question"])
    }),
  )

  it.effect("a timed-out question is rejected without effects for another question or a running child", () =>
    Effect.gen(function* () {
      yield* launched(true)
      yield* rejected({ type: "question_timed_out", questionID: question.id })
      yield* change({ type: "question_asked", question })
      yield* rejected({
        type: "question_timed_out",
        questionID: SessionOrchestrationSchema.QuestionID.make("qst_other"),
      })
      expect(yield* task).toMatchObject({ state: "waiting", question_id: question.id })
    }),
  )

  it.effect(
    "a restart resume keeps the child running, clears the in-flight attempt, and notifies the parent once",
    () =>
      Effect.gen(function* () {
        yield* launched(false)
        const events = yield* EventRuntime.Service
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: childID,
          assistantMessageID: SessionMessage.ID.make("msg_contract_step"),
          agent: build,
          model: modelA,
        })
        expect((yield* task)?.attempt_started).toBe(true)
        const running = yield* task
        yield* change({ type: "resumed" })
        const revision = (running?.revision ?? 0) + 1
        expect(yield* task).toMatchObject({ state: "running", attempt_started: false, revision })
        expect(yield* notifications).toEqual([
          expect.objectContaining({
            id: `ntf_${childID}_${revision}_resumed`,
            type: "resumed",
            revision,
            excerpt: resumedExcerpt,
            delivered: false,
            parent_id: parentID,
          }),
        ])
      }),
  )

  it.effect("a restart resume is rejected without effects unless the child is running", () =>
    Effect.gen(function* () {
      yield* launched(true)
      yield* change({ type: "question_asked", question })
      yield* rejected({ type: "resumed" })
      yield* change({ type: "question_answered", answer: { questionID: question.id, text: "yes" } })
      yield* change({ type: "completed", excerpt: "done" })
      yield* rejected({ type: "resumed" })
      expect((yield* task)?.state).toBe("completed")
    }),
  )

  it.effect("a lost change still settles an active child with its excerpt", () =>
    Effect.gen(function* () {
      yield* launched(true)
      yield* change({ type: "lost", excerpt: "Process ended" })
      expect((yield* task)?.state).toBe("lost")
      expect((yield* notifications).map((row) => [row.type, row.excerpt])).toEqual([["lost", "Process ended"]])
      yield* rejected({ type: "lost" })
    }),
  )
})

describe("Session message projection of guardrail, review, and reroute events", () => {
  it.effect("an escalated guardrail review projects one System notice with its choice and confidence", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      const graded = yield* events.publish(SessionEvent.GuardrailEscalated, {
        sessionID,
        requestID: "grq_graded",
        choice: "escalate",
        confidence: 0.55,
        grades: [{ choice: "escalate", confidence: 0.55, evidence: "Unclear target" }],
        ruleIDs: ["standard.review.outside"],
        source: { messageID: SessionMessage.ID.make("msg_contract_call"), callID: "call_contract" },
      })
      const bare = yield* events.publish(SessionEvent.GuardrailEscalated, { sessionID, requestID: "grq_bare" })
      expect(yield* messages(sessionID)).toEqual([
        SessionMessage.System.make({
          id: SessionMessage.ID.fromEvent(graded.id),
          type: "system",
          text: "Decision model escalated this guardrail review · choice escalate · confidence 0.55",
          time: { created: graded.created },
        }),
        SessionMessage.System.make({
          id: SessionMessage.ID.fromEvent(bare.id),
          type: "system",
          text: "Decision model escalated this guardrail review · choice unreported · confidence unreported",
          time: { created: bare.created },
        }),
      ])
    }),
  )

  it.effect("a withdrawn review item projects a System notice naming its reason", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      const reverted = yield* events.publish(SessionEvent.Review.Withdrawn, {
        sessionID,
        itemID: SessionReview.ID.make("rvw_reverted"),
        reason: "reverted",
      })
      const closed = yield* events.publish(SessionEvent.Review.Withdrawn, {
        sessionID,
        itemID: SessionReview.ID.make("rvw_closed"),
        reason: "task_closed",
      })
      expect(
        (yield* messages(sessionID)).map((message) => [message.id, message.type === "system" && message.text]),
      ).toEqual([
        [
          SessionMessage.ID.fromEvent(reverted.id),
          "Review item rvw_reverted withdrawn: its originating message was reverted. Any unused approval from this item is invalid.",
        ],
        [
          SessionMessage.ID.fromEvent(closed.id),
          "Review item rvw_closed withdrawn: its subagent task closed. Any unused approval from this item is invalid.",
        ],
      ])
    }),
  )

  it.effect("review lifecycle and guardrail decision facts stay durable without transcript messages", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      yield* events.publish(SessionEvent.Review.Deferred, deferral)
      yield* events.publish(SessionEvent.Review.Decided, {
        sessionID,
        itemID: deferral.itemID,
        decision: { kind: "question", answers: { plan: "A" } },
      })
      yield* events.publish(SessionEvent.Review.Consumed, { sessionID, itemID: deferral.itemID })
      yield* events.publish(SessionEvent.GuardrailDecided, {
        sessionID,
        reviewSessionID: sessionID,
        requestID: "grq_decided",
        reply: "once",
        choice: "approve",
        confidence: 0.85,
      })
      yield* events.publish(SessionEvent.GuardrailDismissed, {
        sessionID,
        reviewSessionID: sessionID,
        ruleID: "standard.review.outside",
        confidence: 0.95,
      })
      expect(yield* messages(sessionID)).toEqual([])
      expect(yield* eventTypes(sessionID)).toEqual([
        "session.review.deferred.1",
        "session.review.decided.1",
        "session.review.consumed.1",
        "session.guardrail.decided.1",
        "session.guardrail.dismissed.1",
      ])
    }),
  )

  it.effect("a reroute moves the owned assistant to the fallback model and records each hop", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      const assistantMessageID = SessionMessage.ID.make("msg_contract_reroute")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model: modelA })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call_abandoned",
        name: "read",
      })
      yield* events.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID,
        attempt: 2,
        at: 2_000,
        error: { type: "provider.quota", message: "Quota exhausted" },
      })
      const quota = { type: "provider.quota", message: "Quota exhausted" }
      const unavailable = { type: "provider.unavailable", message: "Model unavailable" }
      yield* events.publish(SessionEvent.Step.Rerouted, { sessionID, assistantMessageID, model: modelB, error: quota })
      yield* events.publish(SessionEvent.Step.Rerouted, {
        sessionID,
        assistantMessageID,
        model: modelC,
        error: unavailable,
      })
      yield* events.publish(SessionEvent.Step.Rerouted, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_contract_unknown"),
        model: modelA,
        error: quota,
      })
      const projected = yield* messages(sessionID)
      expect(projected).toHaveLength(1)
      const assistant = projected[0]
      if (assistant?.type !== "assistant") throw new Error("Expected the rerouted assistant")
      expect(assistant.id).toBe(assistantMessageID)
      expect(assistant.model).toEqual(modelC)
      expect(assistant.reroutes).toEqual([
        { from: modelA, model: modelB, error: quota },
        { from: modelB, model: modelC, error: unavailable },
      ])
      expect(assistant.content).toEqual([])
      expect(assistant).not.toHaveProperty("retry")
    }),
  )

  it.effect("live tool progress never reaches durable history while settlement still projects", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      const assistantMessageID = SessionMessage.ID.make("msg_contract_tool")
      const tool = { sessionID, assistantMessageID, callID: "call_progress" }
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: build, model: modelA })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...tool, name: "shell" })
      yield* events.publish(SessionEvent.Tool.Called, { ...tool, input: { command: "pwd" }, executed: true })
      yield* events.publish(SessionEvent.Tool.Progress, {
        ...tool,
        structured: { lines: 1 },
        content: [{ type: "text", text: "partial" }],
      })
      const running = (yield* messages(sessionID))[0]
      if (running?.type !== "assistant") throw new Error("Expected the running assistant")
      expect(running.content).toEqual([
        expect.objectContaining({
          id: "call_progress",
          state: { status: "running", input: { command: "pwd" }, structured: {}, content: [] },
        }),
      ])
      expect(yield* eventTypes(sessionID)).not.toContain("session.tool.progress.1")
      expect((yield* eventTypes(sessionID)).filter((type) => type.startsWith("session.tool.progress"))).toEqual([])

      yield* events.publish(SessionEvent.Tool.Success, {
        ...tool,
        structured: { lines: 2 },
        content: [{ type: "text", text: "done" }],
        executed: true,
      })
      const settled = (yield* messages(sessionID))[0]
      if (settled?.type !== "assistant") throw new Error("Expected the settled assistant")
      expect(settled.content).toEqual([
        expect.objectContaining({
          id: "call_progress",
          state: expect.objectContaining({ status: "completed", structured: { lines: 2 } }),
        }),
      ])
    }),
  )

  it.effect("replaying the published events in memory matches the durable projection and keeps live progress", () =>
    Effect.gen(function* () {
      yield* seed([[sessionID, undefined]])
      const events = yield* EventRuntime.Service
      const assistantMessageID = SessionMessage.ID.make("msg_contract_replay")
      const tool = { sessionID, assistantMessageID, callID: "call_replay" }
      const published = [
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: build,
          model: modelA,
        }),
        yield* events.publish(SessionEvent.Review.Deferred, deferral),
        yield* events.publish(SessionEvent.GuardrailEscalated, {
          sessionID,
          requestID: "grq_replay",
          choice: "escalate",
        }),
        yield* events.publish(SessionEvent.Step.Rerouted, {
          sessionID,
          assistantMessageID,
          model: modelB,
          error: { type: "provider.quota", message: "Quota exhausted" },
        }),
        yield* events.publish(SessionEvent.Tool.Input.Started, { ...tool, name: "shell" }),
        yield* events.publish(SessionEvent.Tool.Called, { ...tool, input: { command: "pwd" }, executed: true }),
        yield* events.publish(SessionEvent.Review.Decided, {
          sessionID,
          itemID: deferral.itemID,
          decision: { kind: "question", dismissed: true },
        }),
        yield* events.publish(SessionEvent.Review.Consumed, { sessionID, itemID: deferral.itemID }),
        yield* events.publish(SessionEvent.GuardrailDecided, {
          sessionID,
          reviewSessionID: sessionID,
          requestID: "grq_replay",
          reply: "reject",
        }),
        yield* events.publish(SessionEvent.GuardrailDismissed, {
          sessionID,
          reviewSessionID: sessionID,
          ruleID: "standard.review.outside",
          confidence: 0.9,
        }),
        yield* events.publish(SessionEvent.Review.Withdrawn, {
          sessionID,
          itemID: deferral.itemID,
          reason: "reverted",
        }),
      ]
      const replay: SessionMessageUpdater.MemoryState = { messages: [] }
      for (const event of published) yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(replay), event)
      expect(replay.messages).toEqual(yield* messages(sessionID))

      const progress = yield* events.publish(SessionEvent.Tool.Progress, {
        ...tool,
        structured: { lines: 1 },
        content: [{ type: "text", text: "partial" }],
      })
      yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(replay), progress)
      const live = replay.messages.find((message) => message.type === "assistant")
      if (live?.type !== "assistant") throw new Error("Expected the live assistant")
      expect(live.content).toEqual([
        expect.objectContaining({
          id: "call_replay",
          state: {
            status: "running",
            input: { command: "pwd" },
            structured: { lines: 1 },
            content: [{ type: "text", text: "partial" }],
          },
        }),
      ])
      const durable = (yield* messages(sessionID)).find((message) => message.type === "assistant")
      if (durable?.type !== "assistant") throw new Error("Expected the durable assistant")
      expect(durable.content).toEqual([
        expect.objectContaining({ id: "call_replay", state: expect.objectContaining({ structured: {}, content: [] }) }),
      ])
    }),
  )
})
