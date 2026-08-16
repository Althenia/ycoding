import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { ModelV2 } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionOrchestrationNotifier } from "@ycoding-ai/core/session/orchestration-notifier"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionTable, SessionTaskNotificationTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { SessionOrchestration as SessionOrchestrationSchema } from "@ycoding-ai/schema/session-orchestration"
import { Money } from "@ycoding-ai/schema/money"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const parentID = SessionSchema.ID.make("ses_parent")
const childID = SessionSchema.ID.make("ses_child")
const model = ModelV2.Ref.make({
  providerID: ProviderV2.ID.make("openai"),
  id: ModelV2.ID.make("gpt-5.6"),
  variant: ModelV2.VariantID.make("high"),
})

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  for (const sessionID of [parentID, childID]) {
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        parent_id: sessionID === childID ? parentID : undefined,
        directory: "/project",
        title: sessionID,
      })
      .run()
  }
})

const update = (change: SessionOrchestrationSchema.Change) =>
  EventV2.Service.use((events) => events.publish(SessionEvent.Task.Updated, { sessionID: childID, change }))

const launch = (background = true) =>
  update({
    type: "launched",
    parentID,
    parentAssistantMessageID: SessionMessage.ID.make("msg_parent"),
    toolCallID: "call_1",
    inputID: SessionMessage.ID.make("msg_input"),
    description: "Implement projection",
    agent: AgentV2.ID.make("build"),
    model,
    promptDigest: "digest",
    background,
    delivery: "steer",
  })

describe("Session orchestration projection", () => {
  it.effect("snapshots direct-child versions with a durable membership fence", () =>
    Effect.gen(function* () {
      yield* seed
      const db = (yield* Database.Service).db
      const initial = yield* SessionOrchestration.snapshot(db, parentID)
      expect(initial).toEqual({
        sequence: 0,
        digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      })

      yield* launch()
      const launched = yield* SessionOrchestration.snapshot(db, parentID)
      expect(launched.sequence).toBe(1)
      expect(launched.digest).not.toBe(initial.digest)

      yield* update({ type: "started" })
      const started = yield* SessionOrchestration.snapshot(db, parentID)
      expect(started.sequence).toBe(2)
      expect(started.digest).not.toBe(launched.digest)

      expect(
        yield* Effect.exit(
          update({
            type: "question_answered",
            answer: { questionID: SessionOrchestrationSchema.QuestionID.make("qst_missing"), text: "no" },
          }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      expect(yield* SessionOrchestration.snapshot(db, parentID)).toEqual(started)

      yield* update({ type: "progressed", progress: { text: "halfway", time: 3 } })
      expect((yield* SessionOrchestration.snapshot(db, parentID)).sequence).toBe(3)

      yield* (yield* EventV2.Service).publish(SessionEvent.Deleted, { sessionID: childID })
      const deleted = yield* SessionOrchestration.snapshot(db, parentID)
      expect(deleted).toEqual({ sequence: 4, digest: initial.digest })

      yield* db
        .insert(SessionTable)
        .values({
          id: childID,
          project_id: Project.ID.global,
          parent_id: parentID,
          directory: "/project",
          title: childID,
        })
        .run()
      yield* launch()
      const relaunched = yield* SessionOrchestration.snapshot(db, parentID)
      expect(relaunched).toEqual({ sequence: 5, digest: launched.digest })
      expect(relaunched).not.toEqual(launched)
    }),
  )

  it.effect("projects launch, running state, and bounded progress without waking the parent", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch()
      yield* update({ type: "started" })
      yield* update({ type: "progressed", progress: { text: "halfway", time: 3 } })

      const db = (yield* Database.Service).db
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({
        parent_id: parentID,
        state: "running",
        progress: "halfway",
        progress_time: 3,
        revision: 2,
      })
      expect(yield* db.select().from(SessionTaskNotificationTable).all()).toEqual([])
    }),
  )

  it.effect("allows exactly one durable question and one matching answer", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch()
      yield* update({ type: "started" })
      const question = {
        id: SessionOrchestrationSchema.QuestionID.make("qst_1"),
        text: "Proceed?",
        data: { risk: "low" },
        time: 4,
      }
      yield* update({ type: "question_asked", question })
      expect(yield* Effect.exit(update({ type: "question_asked", question }))).toMatchObject({ _tag: "Failure" })
      expect(
        yield* Effect.exit(
          update({
            type: "question_answered",
            answer: { questionID: SessionOrchestrationSchema.QuestionID.make("qst_other"), text: "yes" },
          }),
        ),
      ).toMatchObject({ _tag: "Failure" })
      yield* update({ type: "question_answered", answer: { questionID: question.id, text: "yes" } })

      const db = (yield* Database.Service).db
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({
        state: "running",
        question_id: null,
        revision: 3,
      })
      expect(yield* db.select().from(SessionTaskNotificationTable).all()).toHaveLength(1)
    }),
  )

  it.effect("orders cancel against terminal settlement by the first valid transition", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch()
      yield* update({ type: "started" })
      yield* update({ type: "completed", excerpt: "done" })
      expect(yield* Effect.exit(update({ type: "cancel_requested" }))).toMatchObject({ _tag: "Failure" })

      const db = (yield* Database.Service).db
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({
        state: "completed",
        revision: 2,
      })
      expect(yield* db.select().from(SessionTaskNotificationTable).all()).toEqual([
        expect.objectContaining({ task_session_id: childID, parent_id: parentID, type: "completed", revision: 2 }),
      ])
    }),
  )

  it.effect("reactivates every terminal task and clears stale execution state", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch()
      yield* update({ type: "started" })
      yield* update({ type: "progressed", progress: { text: "stale", time: 3 } })
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        assistantMessageID: SessionMessage.ID.make("msg_reused_assistant"),
        agent: AgentV2.ID.make("build"),
        model,
      })
      yield* update({ type: "completed", excerpt: "done" })
      yield* update({ type: "started" })

      const db = (yield* Database.Service).db
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({
        state: "running",
        progress: null,
        progress_time: null,
        question_id: null,
        question: null,
        question_data: null,
        question_time: null,
        attempt_started: false,
      })
      yield* update({ type: "completed", excerpt: "done again" })
      yield* update({ type: "started" })
      yield* update({ type: "failed", error: "failed" })
      yield* update({ type: "started" })
      yield* update({ type: "lost" })
      yield* update({ type: "started" })
      const question = {
        id: SessionOrchestrationSchema.QuestionID.make("qst_reuse"),
        text: "Proceed?",
        time: 4,
      }
      yield* update({ type: "question_asked", question })
      yield* update({ type: "cancel_requested" })
      yield* update({ type: "cancelled" })
      yield* update({ type: "started" })
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({ state: "running", question_id: null, revision: 14 })
      expect((yield* SessionOrchestration.snapshot(db, parentID)).sequence).toBe(15)
    }),
  )

  it.effect("durably detaches a foreground task before terminal notification", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch(false)
      yield* update({ type: "started" })
      yield* update({ type: "backgrounded" })
      yield* update({ type: "completed", excerpt: "done" })

      const db = (yield* Database.Service).db
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get(),
      ).toMatchObject({
        background: true,
        state: "completed",
        revision: 3,
      })
      expect(yield* db.select().from(SessionTaskNotificationTable).all()).toEqual([
        expect.objectContaining({ task_session_id: childID, type: "completed", revision: 3 }),
      ])
    }),
  )

  it.effect("tracks whether a managed child has an in-flight physical attempt", () =>
    Effect.gen(function* () {
      yield* seed
      yield* launch()
      yield* update({ type: "started" })
      const events = yield* EventV2.Service
      const assistantMessageID = SessionMessage.ID.make("msg_assistant")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: childID,
        assistantMessageID,
        agent: AgentV2.ID.make("build"),
        model,
      })
      const db = (yield* Database.Service).db
      expect(
        (yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get())
          ?.attempt_started,
      ).toBe(true)
      expect((yield* SessionOrchestration.snapshot(db, parentID)).sequence).toBe(2)
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: childID,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      expect(
        (yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get())
          ?.attempt_started,
      ).toBe(false)
      expect((yield* SessionOrchestration.snapshot(db, parentID)).sequence).toBe(2)
    }),
  )
})

describe("Session orchestration helpers", () => {
  it.effect("pages direct children by actionable state, durable activity, and stable ID", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const pageParentID = SessionSchema.ID.make("ses_page_parent")
      const rows = [
        ["ses_wait_b", "waiting", 20],
        ["ses_wait_a", "waiting", 20],
        ["ses_start", "starting", 19],
        ["ses_run", "running", 18],
        ["ses_cancel", "cancelling", 17],
        ["ses_terminal_7", "failed", 16],
        ["ses_terminal_6", "completed", 15],
        ["ses_terminal_5", "lost", 14],
        ["ses_terminal_4", "cancelled", 13],
        ["ses_terminal_3", "completed", 12],
        ["ses_terminal_2", "failed", 11],
        ["ses_terminal_1", "lost", 10],
      ] as const satisfies ReadonlyArray<readonly [string, SessionOrchestrationSchema.State, number]>

      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/page"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values([
          { id: pageParentID, project_id: Project.ID.global, directory: "/page", title: "parent" },
          ...rows.map(([id]) => ({
            id: SessionSchema.ID.make(id),
            project_id: Project.ID.global,
            parent_id: pageParentID,
            directory: "/page",
            title: id,
          })),
        ])
        .run()
      yield* db
        .insert(SessionTaskTable)
        .values(
          rows.map(
            ([id, state, updated], index) =>
              ({
                session_id: SessionSchema.ID.make(id),
                parent_id: pageParentID,
                parent_assistant_message_id: SessionMessage.ID.make(`msg_page_${index}`),
                tool_call_id: `call_page_${index}`,
                input_id: SessionMessage.ID.make(`msg_page_input_${index}`),
                description: id,
                agent: AgentV2.ID.make("build"),
                model,
                prompt_digest: `digest_${index}`,
                background: true,
                delivery: "steer",
                state,
                time_created: index,
                time_updated: updated,
              }) satisfies typeof SessionTaskTable.$inferInsert,
          ),
        )
        .run()

      const first = yield* SessionOrchestration.page(db, { parentID: pageParentID })
      expect(first.data).toHaveLength(10)
      expect(first.data.map((task) => task.sessionID)).toEqual(
        [
          "ses_wait_a",
          "ses_wait_b",
          "ses_start",
          "ses_run",
          "ses_cancel",
          "ses_terminal_7",
          "ses_terminal_6",
          "ses_terminal_5",
          "ses_terminal_4",
          "ses_terminal_3",
        ].map((id) => SessionSchema.ID.make(id)),
      )
      expect(first.summary).toEqual({ total: 12, active: 5, running: 1, waiting: 2 })
      expect(first.cursor.next).toBeDefined()
      expect(first.cursor.previous).toBeUndefined()

      const second = yield* SessionOrchestration.page(db, {
        parentID: pageParentID,
        cursor: first.cursor.next,
      })
      expect(second.data.map((task) => task.sessionID)).toEqual(
        ["ses_terminal_2", "ses_terminal_1"].map((id) => SessionSchema.ID.make(id)),
      )
      expect(second.cursor.previous).toBeDefined()

      const roundTrip = yield* SessionOrchestration.page(db, {
        parentID: pageParentID,
        cursor: second.cursor.previous,
      })
      expect(roundTrip.data.map((task) => task.sessionID)).toEqual(first.data.map((task) => task.sessionID))
      expect(
        (yield* Effect.exit(SessionOrchestration.page(db, { parentID: SessionSchema.ID.make("ses_missing") })))._tag,
      ).toBe("Failure")
      expect(
        yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.parent_id, pageParentID)).all(),
      ).toHaveLength(12)
    }),
  )

  it.effect("exposes the Session-owned orchestration service contract", () =>
    Effect.sync(() => {
      expect(SessionOrchestration.Service).toBeDefined()
    }),
  )

  it.effect("exposes the durable parent-notification dispatcher", () =>
    Effect.sync(() => {
      expect(SessionOrchestrationNotifier.Service).toBeDefined()
    }),
  )

  it.effect("uses spawn, agent, parent, then catalog model precedence", () =>
    Effect.sync(() => {
      const spawn = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("p"), id: ModelV2.ID.make("spawn") })
      const agent = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("p"), id: ModelV2.ID.make("agent") })
      const parent = ModelV2.Ref.make({ providerID: ProviderV2.ID.make("p"), id: ModelV2.ID.make("parent") })
      expect(SessionOrchestration.selectModel(spawn, agent, parent)).toBe(spawn)
      expect(SessionOrchestration.selectModel(undefined, agent, parent)).toBe(agent)
      expect(SessionOrchestration.selectModel(undefined, undefined, parent)).toBe(parent)
      expect(SessionOrchestration.selectModel(undefined, undefined, undefined)).toBeUndefined()
    }),
  )

  it.effect("derives deterministic launch, input, answer, and notification identities", () =>
    Effect.sync(() => {
      const first = SessionOrchestration.identities(parentID, SessionMessage.ID.make("msg_parent"), "call_1")
      const retry = SessionOrchestration.identities(parentID, SessionMessage.ID.make("msg_parent"), "call_1")
      const other = SessionOrchestration.identities(parentID, SessionMessage.ID.make("msg_parent"), "call_2")
      expect(retry.childID).toBe(first.childID)
      expect(retry.inputID).toBe(first.inputID)
      expect(retry.launchEventID).toBe(first.launchEventID)
      expect(retry.answer(SessionOrchestrationSchema.QuestionID.make("qst_1"))).toBe(
        first.answer(SessionOrchestrationSchema.QuestionID.make("qst_1")),
      )
      expect(other.childID).not.toBe(first.childID)
      expect(String(first.childID)).toStartWith("ses_")
      expect(String(first.inputID)).toStartWith("msg_")
      expect(String(first.answer(SessionOrchestrationSchema.QuestionID.make("qst_1")))).toStartWith("msg_")
      expect(String(first.notification(2, "completed"))).toStartWith("msg_")
    }),
  )

  it.effect("truncates bounded excerpts and failures on UTF-8 code point boundaries", () =>
    Effect.sync(() => {
      const truncated = SessionOrchestration.truncateUtf8("€".repeat(4096), 4 * 1024)
      expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(4 * 1024)
      expect(truncated.endsWith("€")).toBe(true)
      const failure = SessionOrchestration.failureText("€".repeat(16 * 1024))
      expect(Buffer.byteLength(failure)).toBeLessThanOrEqual(16 * 1024)
      expect(failure.endsWith("€")).toBe(true)
    }),
  )

  it.effect("renders a stable bounded TeamView with active children first", () =>
    Effect.sync(() => {
      const tasks = Array.from({ length: 40 }, (_, index) =>
        SessionOrchestrationSchema.Task.make({
          sessionID: SessionSchema.ID.make(`ses_${String(index).padStart(2, "0")}`),
          parentID,
          description: `task ${index} ${"d".repeat(900)}`,
          agent: AgentV2.ID.make("build"),
          model,
          background: true,
          state: index % 3 === 0 ? "running" : "completed",
          progress: { text: "p".repeat(4096), time: index },
          revision: index,
          time: { created: index, updated: index },
        }),
      )
      const rendered = SessionOrchestration.renderTeamView(tasks)
      const ordered = SessionOrchestration.renderTeamView([
        { ...tasks[1]!, state: "completed", time: { ...tasks[1]!.time, updated: 1 } },
        { ...tasks[3]!, state: "running", time: { ...tasks[3]!.time, updated: 3 } },
        { ...tasks[0]!, state: "running", time: { ...tasks[0]!.time, updated: 3 } },
        { ...tasks[2]!, state: "completed", time: { ...tasks[2]!.time, updated: 9 } },
      ])
      expect(ordered.view.children.map((task) => task.sessionID)).toEqual([
        SessionSchema.ID.make("ses_00"),
        SessionSchema.ID.make("ses_03"),
        SessionSchema.ID.make("ses_02"),
        SessionSchema.ID.make("ses_01"),
      ])
      expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(32 * 1024)
      expect(rendered.text).toContain("Internal orchestration context")
      expect(rendered.text).toContain("Do not surface subagent status unless the user explicitly asks")
      const payload = JSON.parse(rendered.text.slice(rendered.text.indexOf("\n") + 1))
      expect(payload.children[0]?.sessionID).toBe(rendered.view.children[0]?.sessionID)
      expect(payload.children[0]?.state).toBe(rendered.view.children[0]?.state)
      expect(
        rendered.view.children.every(
          (task, index, items) => index === 0 || items[index - 1]!.state === "running" || task.state !== "running",
        ),
      ).toBe(true)
      expect(rendered.view.omitted).toBeGreaterThan(0)
      expect(SessionOrchestration.renderTeamView(tasks).text).toBe(rendered.text)
    }),
  )
})
