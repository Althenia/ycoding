import { describe, expect, test } from "bun:test"
import { LLMError, TransportReason } from "@ycoding-ai/ai"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { Job } from "@ycoding-ai/core/job"
import { SessionCompletion } from "@ycoding-ai/core/session/completion"
import { Money } from "@ycoding-ai/schema/money"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionGoal } from "@ycoding-ai/core/session/goal"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { AppProcess } from "@ycoding-ai/core/process"
import { UserInterruptedError } from "@ycoding-ai/core/session/error"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionMessageTable, SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Hash } from "@ycoding-ai/core/util/hash"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { Shell } from "@ycoding-ai/core/shell"
import { ID, Info } from "@ycoding-ai/schema/shell"
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Logger, Schema, Scope } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([AppProcess.node, Database.node, EventRuntime.node, SessionStore.node, Job.node])))
const completionIt = testEffect(AppNodeBuilder.build(LayerNode.group([
  AppProcess.node, Database.node, EventRuntime.node, SessionStore.node, SessionProjector.node, Job.node,
])))

completionIt.effect("records verified work once after an explicit declaration and the final response settle", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const sessionID = Session.ID.make("ses_verified_work")
    yield* seedSessions(database, [sessionID])
    const inputID = SessionMessage.ID.make("msg_verified_input")
    yield* SessionPending.admit(database.db, events, { id: inputID, sessionID, input: SessionPending.Message.make({
      type: "user", delivery: "steer", data: { text: "Implement and verify the change" },
    }) })
    const scope = yield* Scope.make()
    const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID))
    yield* Context.get(context, SessionExecution.Service).resume(sessionID)
    const history = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
    const completed = history.filter((row) => row.type === "session.work.completed.1")
    expect(completed).toHaveLength(1)
    expect(completed[0].data).toEqual({ sessionID, inputID, assistantMessageID: "msg_work_final" })
    expect(completed[0].seq).toBeGreaterThan(history.findLast((row) => row.type === "session.step.ended.1")!.seq)
    expect(completed[0].seq).toBeGreaterThan(history.findLast((row) => row.type === "session.execution.succeeded.1")!.seq)
    const jobs = yield* Job.Service
    const completion = SessionCompletion.make({ db: database.db, events, jobs })
    yield* Effect.all([
      completion.complete(sessionID, Effect.succeed(new Set([sessionID]))),
      completion.complete(sessionID, Effect.succeed(new Set([sessionID]))),
    ], { concurrency: "unbounded" })
    expect(SessionCompletion).toHaveProperty("latest")
    const page = yield* SessionCompletion.latest(database.db, { limit: 1 })
    expect(page).toEqual({ data: [{ id: completed[0].id, seq: EventRuntime.Seq.make(completed[0].seq), created: completed[0].created,
      sessionID, inputID, assistantMessageID: SessionMessage.ID.make("msg_work_final") }] })
    expect(yield* SessionCompletion.latest(database.db, { after: sessionID, limit: 1 })).toEqual({ data: [] })
    yield* Scope.close(scope, Exit.void)
  }),
)

function completionExchange(
  database: Database.Service["Service"], events: EventRuntime.Interface, sessionID: Session.ID,
  options: {
    declaration?: boolean; text?: string; finish?: "stop" | "length"; phase?: "commentary";
    providerExecuted?: boolean; beforeDeclaration?: Effect.Effect<void>; afterDeclaration?: Effect.Effect<void>; failedStep?: boolean;
    suffix?: string;
  } = {},
) {
  return Effect.gen(function* () {
    yield* SessionPending.promoteSteers(database.db, events, sessionID)
    const model = { id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") }
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    if (options.declaration !== false) {
      const assistantMessageID = SessionMessage.ID.make(`msg_work_declaration${options.suffix ?? ""}`)
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: Agent.defaultID, model })
      yield* options.beforeDeclaration ?? Effect.void
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID: "complete", name: "task_complete" })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, callID: "complete", input: {}, executed: options.providerExecuted ?? false })
      yield* events.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID, callID: "complete", structured: { recorded: true }, content: [], executed: options.providerExecuted ?? false })
      yield* options.afterDeclaration ?? Effect.void
      yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, finish: "tool-calls", cost: Money.USD.zero, tokens })
    }
    const finalID = SessionMessage.ID.make(`msg_work_final${options.suffix ?? ""}`)
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: finalID, agent: Agent.defaultID, model })
    yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID: finalID, ordinal: 0 })
    yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID: finalID, ordinal: 0,
      text: options.text ?? "Implemented and verified.", ...(options.phase ? { phase: options.phase } : {}) })
    if (options.failedStep) {
      yield* events.publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID: finalID, error: { type: "aborted", message: "Final response interrupted" } })
      return
    }
    yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: finalID, finish: options.finish ?? "stop", cost: Money.USD.zero, tokens })
  })
}

for (const scenario of [
  { name: "ordinary reply", options: { declaration: false } },
  { name: "blank final reply", options: { text: " \n\t" } },
  { name: "commentary without final reply", options: { phase: "commentary" as const } },
  { name: "truncated final reply", options: { finish: "length" as const } },
  { name: "failed final step", options: { failedStep: true } },
  { name: "provider-executed declaration", options: { providerExecuted: true } },
]) {
  completionIt.effect(`does not certify ${scenario.name} as verified work`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const sessionID = Session.ID.make("ses_unverified_reply")
      yield* seedSessions(database, [sessionID])
      yield* admitCompletionInput(database, events, sessionID)
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID, scenario.options))
      yield* Context.get(context, SessionExecution.Service).resume(sessionID)
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
}

for (const outcome of ["failed", "interrupted"] as const) {
  completionIt.effect(`does not certify an execution that ${outcome} after declaring completion`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const sessionID = Session.ID.make("ses_unverified_execution")
      yield* seedSessions(database, [sessionID])
      yield* admitCompletionInput(database, events, sessionID)
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID).pipe(
        Effect.andThen(outcome === "interrupted" ? Effect.fail(new UserInterruptedError()) : Effect.die(new Error("run failed"))),
      ))
      expect(Exit.isFailure(yield* Effect.exit(Context.get(context, SessionExecution.Service).resume(sessionID)))).toBe(true)
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
}

for (const delivery of ["queue", "steer"] as const) {
  completionIt.effect(`a ${delivery} admitted during the declaring step requires a fresh declaration`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const sessionID = Session.ID.make("ses_stale_completion")
      yield* seedSessions(database, [sessionID])
      yield* admitCompletionInput(database, events, sessionID)
      const changed = admitCompletionInput(database, events, sessionID, "msg_new_work", delivery).pipe(
        Effect.andThen(delivery === "steer" ? SessionPending.promoteSteers(database.db, events, sessionID) : Effect.void),
        Effect.asVoid,
      )
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID, { afterDeclaration: changed }))
      yield* Context.get(context, SessionExecution.Service).resume(sessionID)
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
}

completionIt.effect("a late tool declaration is scoped to its invoking step rather than a newer admitted input", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const sessionID = Session.ID.make("ses_late_declaration")
    yield* seedSessions(database, [sessionID])
    yield* admitCompletionInput(database, events, sessionID)
    const scope = yield* Scope.make()
    const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID, {
      beforeDeclaration: admitCompletionInput(database, events, sessionID, "msg_newer_steer").pipe(
        Effect.andThen(SessionPending.promoteSteers(database.db, events, sessionID)), Effect.asVoid,
      ),
    }))
    yield* Context.get(context, SessionExecution.Service).resume(sessionID)
    expect(yield* completionReceipts(database, sessionID)).toEqual([])
    yield* Scope.close(scope, Exit.void)
  }),
)

for (const change of ["admission", "revert"] as const) {
  completionIt.effect(`atomically rejects a completion raced by ${change} before publication`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const sessionID = Session.ID.make("ses_raced_completion")
      yield* seedSessions(database, [sessionID])
      yield* admitCompletionInput(database, events, sessionID)
      let attempted = false
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID), (type) =>
        Effect.gen(function* () {
          if (type !== "session.work.completed") return
          attempted = true
          if (change === "admission") {
            yield* admitCompletionInput(database, events, sessionID, "msg_racing_work", "queue")
            return
          }
          yield* events.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: SessionMessage.ID.make("msg_work_final") })
        }),
      )
      yield* Context.get(context, SessionExecution.Service).resume(sessionID)
      expect(attempted).toBe(true)
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
}

completionIt.effect("restart does not backfill an old declaration; completion reads survive a new owner and compacted projections", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const jobs = yield* Job.Service
    const sessionID = Session.ID.make("ses_restart_completion")
    yield* seedSessions(database, [sessionID])
    yield* admitCompletionInput(database, events, sessionID)
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    yield* completionExchange(database, events, sessionID)
    yield* database.db.delete(SessionMessageTable).run().pipe(Effect.orDie)
    const scope = yield* Scope.make()
    const context = yield* buildExecution(scope, () => completionExchange(database, events, sessionID, { declaration: false }))
    yield* Context.get(context, SessionExecution.Service).resume(sessionID)
    expect(yield* completionReceipts(database, sessionID)).toEqual([])
    yield* Scope.close(scope, Exit.void)
    yield* database.db.delete(SessionMessageTable).run().pipe(Effect.orDie)
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    yield* completionExchange(database, events, sessionID)
    yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* database.db.delete(SessionMessageTable).run().pipe(Effect.orDie)
    yield* SessionCompletion.make({ db: database.db, events, jobs }).complete(sessionID, Effect.succeed(new Set([sessionID])))
    const completed = yield* completionReceipts(database, sessionID)
    expect(completed).toHaveLength(1)
    yield* SessionCompletion.make({ db: database.db, events, jobs }).complete(sessionID, Effect.succeed(new Set([sessionID])))
    expect(yield* completionReceipts(database, sessionID)).toEqual(completed)
  }),
)

completionIt.effect("a child declaration never certifies the parent's work", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const parentID = Session.ID.make("ses_completion_parent")
    const childID = Session.ID.make("ses_completion_child")
    yield* seedSessions(database, [parentID, childID])
    yield* database.db.update(SessionTable).set({ parent_id: parentID }).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
    yield* admitCompletionInput(database, events, childID)
    const scope = yield* Scope.make()
    const context = yield* buildExecution(scope, () => completionExchange(database, events, childID))
    yield* Context.get(context, SessionExecution.Service).resume(childID)
    expect(yield* completionReceipts(database, parentID)).toEqual([])
    expect(yield* completionReceipts(database, childID)).toHaveLength(1)
    yield* Scope.close(scope, Exit.void)
  }),
)

for (const blocker of ["goal", "task", "waiting task", "pending child", "notice", "shell notice", "job", "active grandchild"] as const) {
  completionIt.effect(`refuses completion while ${blocker} remains unfinished in the family`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventRuntime.Service
      const jobs = yield* Job.Service
      const sessionID = Session.ID.make("ses_work_family")
      const childID = Session.ID.make("ses_work_child")
      const grandchildID = Session.ID.make("ses_work_grandchild")
      yield* seedSessions(database, [sessionID, childID, grandchildID])
      yield* database.db.update(SessionTable).set({ parent_id: sessionID }).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
      yield* database.db.update(SessionTable).set({ parent_id: childID }).where(eq(SessionTable.id, grandchildID)).run().pipe(Effect.orDie)
      yield* admitCompletionInput(database, events, sessionID)
      yield* events.publish(SessionEvent.Execution.Started, { sessionID })
      yield* completionExchange(database, events, sessionID)
      yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
      const active = new Set([sessionID])
      if (blocker === "active grandchild") active.add(grandchildID)
      if (blocker === "goal") yield* SessionAutonomy.make({ db: database.db }).setGoal({ sessionID: childID, text: "Unfinished" })
      if (blocker === "task" || blocker === "waiting task" || blocker === "notice") {
        yield* seedTask(database, { parentID: sessionID, childID, state: blocker === "waiting task" ? "waiting" : "running" })
        if (blocker === "notice") yield* events.publish(SessionEvent.Task.Updated, { sessionID: childID, change: { type: "completed" } })
      }
      if (blocker === "pending child") yield* admitCompletionInput(database, events, grandchildID, "msg_child_work", "queue")
      const released = yield* Deferred.make<void>()
      if (blocker === "shell notice" || blocker === "job") {
        const job = yield* jobs.start({ type: blocker === "job" ? "verification" : "shell", metadata: { sessionID: grandchildID }, run: Deferred.await(released).pipe(Effect.as("done")) })
        yield* jobs.background(job.id)
        if (blocker === "shell notice") {
          yield* Deferred.succeed(released, undefined)
          yield* jobs.wait({ id: job.id })
        }
      }
      yield* SessionCompletion.make({ db: database.db, events, jobs }).complete(sessionID, Effect.succeed(active))
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Deferred.succeed(released, undefined)
    }),
  )
}

function admitCompletionInput(database: Database.Service["Service"], events: EventRuntime.Interface,
  sessionID: Session.ID, id = "msg_work_input", delivery: "steer" | "queue" = "steer") {
  return SessionPending.admit(database.db, events, { id: SessionMessage.ID.make(id), sessionID,
    input: SessionPending.Message.make({ type: "user", delivery, data: { text: "Do and verify this work" } }),
  }).pipe(Effect.asVoid)
}

function completionReceipts(database: Database.Service["Service"], sessionID: Session.ID) {
  return database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(EventTable.seq).all().pipe(Effect.orDie, Effect.map((rows) => rows.filter((row) => row.type === "session.work.completed.1")
      .map((row) => ({ id: row.id, seq: EventRuntime.Seq.make(row.seq), created: row.created,
        ...Schema.decodeUnknownSync(SessionEvent.Work.Completed.data)(row.data) }))))
}

completionIt.effect("does not resurrect a completion declaration outside its settling execution", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const jobs = yield* Job.Service
    const sessionID = Session.ID.make("ses_idle_declaration")
    yield* seedSessions(database, [sessionID])
    yield* admitCompletionInput(database, events, sessionID)
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    yield* completionExchange(database, events, sessionID)
    yield* events.publish(SessionEvent.Execution.Succeeded, { sessionID })
    yield* SessionCompletion.make({ db: database.db, events, jobs }).complete(sessionID, Effect.succeed(new Set()))
    expect(yield* completionReceipts(database, sessionID)).toEqual([])
  }),
)

for (const completedGoal of [false, true]) {
  completionIt.effect(`idle success${completedGoal ? " with a completed goal" : ""} is not verified work`, () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_ordinary_idle")
      yield* seedSessions(database, [sessionID])
      if (completedGoal) {
        const autonomy = SessionAutonomy.make({ db: database.db })
        yield* autonomy.setGoal({ sessionID, text: "Already done" })
        yield* autonomy.complete(sessionID)
      }
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () => Effect.void)
      yield* Context.get(context, SessionExecution.Service).resume(sessionID)
      expect(yield* completionReceipts(database, sessionID)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
}

completionIt.effect("pages latest root receipts by Session ID without unrelated-job suppression or child receipts", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventRuntime.Service
    const jobs = yield* Job.Service
    const sessionID = Session.ID.make("ses_completed_pages")
    const otherID = Session.ID.make("ses_other_completed")
    const childID = Session.ID.make("ses_completed_child")
    const unrelated = Session.ID.make("ses_unrelated_work")
    yield* seedSessions(database, [sessionID, otherID, childID, unrelated])
    yield* database.db.update(SessionTable).set({ parent_id: sessionID }).where(eq(SessionTable.id, childID)).run().pipe(Effect.orDie)
    const release = yield* Deferred.make<void>()
    const job = yield* jobs.start({ type: "verification", metadata: { sessionID: unrelated }, run: Deferred.await(release).pipe(Effect.as("done")) })
    const scope = yield* Scope.make()
    let exchange = 0
    const context = yield* buildExecution(scope, (input) => completionExchange(database, events, input.sessionID, { suffix: String(exchange++) }))
    const execution = Context.get(context, SessionExecution.Service)
    yield* admitCompletionInput(database, events, sessionID, "msg_first_work")
    yield* execution.resume(sessionID)
    yield* admitCompletionInput(database, events, sessionID, "msg_second_work")
    yield* execution.resume(sessionID)
    yield* admitCompletionInput(database, events, otherID, "msg_other_work")
    yield* execution.resume(otherID)
    yield* admitCompletionInput(database, events, childID, "msg_child_work")
    yield* execution.resume(childID)
    expect(SessionCompletion).toHaveProperty("latest")
    const first = yield* SessionCompletion.latest(database.db, { limit: 1 })
    expect(first.data).toHaveLength(1)
    expect(first.data[0].sessionID).toBe(sessionID)
    expect(first.data[0].inputID).toBe(SessionMessage.ID.make("msg_second_work"))
    expect(first.next).toBe(sessionID)
    const second = yield* SessionCompletion.latest(database.db, { after: first.next, limit: 1 })
    expect(second.data).toHaveLength(1)
    expect(second.data[0].sessionID).toBe(otherID)
    expect(second.data[0].inputID).toBe(SessionMessage.ID.make("msg_other_work"))
    expect(second.next).toBeUndefined()
    expect(yield* SessionCompletion.latest(database.db, { after: otherID, limit: 1 })).toEqual({ data: [] })
    expect((yield* completionReceipts(database, sessionID)).map((row) => row.inputID)).toEqual([
      SessionMessage.ID.make("msg_first_work"), SessionMessage.ID.make("msg_second_work"),
    ])
    expect(yield* completionReceipts(database, childID)).toHaveLength(1)
    expect(yield* completionReceipts(database, unrelated)).toEqual([])
    yield* Deferred.succeed(release, undefined)
    yield* jobs.wait({ id: job.id })
    yield* Scope.close(scope, Exit.void)
  }),
)

describe("SessionExecution lifecycle", () => {
  test("classifies success and typed failure terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(
      SessionExecution.terminal(
        Exit.fail(
          new LLMError({
            module: "test",
            method: "stream",
            reason: new TransportReason({ message: "Disconnected" }),
          }),
        ),
      ),
    ).toEqual({ type: "failed", error: { type: "provider.transport", message: "Disconnected" } })
    const storage = new ToolOutputStore.StorageError({ operation: "encode", cause: new Error("invalid output") })
    expect(SessionExecution.terminal(Exit.fail(storage))).toEqual({
      type: "failed",
      error: { type: "unknown", message: storage.message },
    })
  })

  test("defaults owner-scope interruption to shutdown and preserves explicit reasons", () => {
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
    expect(SessionExecution.terminal(interrupted, "superseded")).toEqual({ type: "interrupted", reason: "superseded" })
    expect(SessionExecution.terminal(Exit.fail(new UserInterruptedError()))).toEqual({
      type: "interrupted",
      reason: "user",
    })
  })

  it.effect("atomically consumes each suspension at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const first = Session.ID.make("ses_recover_first")
      const second = Session.ID.make("ses_recover_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      expect(yield* store.consumeSuspended(first)).toBe(true)
      expect(yield* store.consumeSuspended(first)).toBe(false)
      expect(yield* store.consumeSuspended(second)).toBe(true)
      expect(yield* suspensions(database)).toEqual({ [first]: false, [second]: false })
    }),
  )

  it.effect("suspension survives teardown interruption and clears when a drain finishes on its own", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const interrupted = Session.ID.make("ses_suspend_interrupted")
      const completed = Session.ID.make("ses_suspend_completed")
      yield* seedSessions(database, [interrupted, completed])

      const draining = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        sessionID === completed
          ? Deferred.await(release)
          : Deferred.succeed(draining, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* execution.resume(interrupted).pipe(Effect.forkScoped)
      const completing = yield* execution.resume(completed).pipe(Effect.forkIn(scope))
      yield* Deferred.await(draining)

      yield* restart.suspendActiveSessions
      expect(yield* suspensions(database)).toEqual({ [interrupted]: true, [completed]: true })

      // A drain that finishes on its own after suspension clears its stale suspension.
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(completing)
      yield* execution.awaitIdle(completed)
      expect((yield* suspensions(database))[completed]).toBe(false)

      // Teardown interruption preserves suspension for the next server start.
      yield* Scope.close(scope, Exit.void)
      expect((yield* suspensions(database))[interrupted]).toBe(true)
    }),
  )

  it.effect("starts a fresh drain after an interrupt so an admitted steer is not stranded", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_interrupt_steer")
      yield* seedSessions(database, [sessionID])

      let drains = 0
      const firstDrainEntered = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.gen(function* () {
          drains += 1
          // The first drain models a long-running step. Interruption ends it; a later wake must
          // schedule a successor, otherwise a steer admitted during the step waits for nothing.
          if (drains > 1) return
          yield* Deferred.succeed(firstDrainEntered, undefined)
          yield* Effect.never
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(firstDrainEntered)
      expect(drains).toBe(1)

      // Steer-now admits the input first, then interrupts the active step, then wakes.
      yield* execution.interrupt(sessionID)
      yield* execution.resume(sessionID)

      expect(drains).toBe(2)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("does not invoke the runner for a waiting managed child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parentID = Session.ID.make("ses_waiting_parent")
      const childID = Session.ID.make("ses_waiting_child")
      yield* seedSessions(database, [parentID, childID])
      yield* database.db
        .insert(SessionTaskTable)
        .values({
          session_id: childID,
          parent_id: parentID,
          parent_assistant_message_id: SessionMessage.ID.make("msg_parent"),
          tool_call_id: "call_waiting",
          input_id: SessionMessage.ID.make("msg_input"),
          description: "waiting",
          agent: Agent.ID.make("reviewer"),
          model: CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("model") }),
          prompt_digest: "digest",
          background: false,
          delivery: "steer",
          state: "waiting",
          question_id: SessionOrchestration.QuestionID.make("qst_waiting"),
          question: "Proceed?",
          question_time: 1,
        })
        .run()
      const drained: Session.ID[] = []
      const warnings: string[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        const message = Array.isArray(entry.message) ? entry.message[0] : entry.message
        if (typeof message === "string" && message.includes("non-running managed task"))
          warnings.push(JSON.stringify(entry))
      })
      // The drain fiber is forked from a runtime built during layer
      // construction, so the logger must be provided around the build —
      // providing it only around `resume` never reaches the fork.
      yield* Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* buildExecution(scope, ({ sessionID }) =>
          Effect.sync(() => {
            drained.push(sessionID)
          }),
        )
        yield* Context.get(context, SessionExecution.Service).resume(childID)
        yield* Scope.close(scope, Exit.void)
      }).pipe(Effect.provide(Logger.layer([logger])))
      expect(drained).toEqual([])
      // The silent gate used to strand admitted prompts with no trace.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("waiting")
      expect(warnings[0]).toContain(childID)
    }),
  )

  it.effect("binds the process-global compaction executor to Location runner drains", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_compaction_execution_binding")
      yield* seedSessions(database, [sessionID])
      const compactionExecution = noopCompactionExecution()
      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () =>
          SessionCompactionExecution.use((bound) =>
            Effect.sync(() => {
              expect(bound).toBe(compactionExecution)
            }),
          ),
        undefined,
        compactionExecution,
      )

      yield* Context.get(context, SessionExecution.Service).resume(sessionID)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("stops goal continuations after three unresolved-blocker reports", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_loop")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.gen(function* () {
          drains += 1
          yield* autonomy.report({ sessionID }).pipe(Effect.orDie)
          yield* recordAssistant(database, sessionID, drains, [{ type: "text", text: "Still investigating." }])
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(3)
      expect(yield* autonomy.get(sessionID)).toMatchObject({
        mode: "normal",
        goal: { status: "exhausted", iteration: 2, noProgress: 3 },
      })
      expect(yield* admittedInputs(database)).toEqual(
        Array.from({ length: 2 }, (_, index) => ({
          inputID: `msg_goal_${Hash.sha256(`${sessionID}\0${index + 1}`).slice(0, 24)}`,
          delivery: "steer",
        })),
      )
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("continues without reports or marker inference until the agent explicitly completes the goal", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_completed")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.gen(function* () {
          drains += 1
          if (drains === 3) yield* autonomy.complete(sessionID).pipe(Effect.orDie)
          yield* recordAssistant(database, sessionID, drains, [
            { type: "text", text: "Made useful progress. <goal-complete/>" },
          ])
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(3)
      expect(yield* autonomy.get(sessionID)).toMatchObject({
        mode: "normal",
        goal: { status: "completed", iteration: 2, noProgress: 0 },
      })
      expect(yield* admittedInputs(database)).toEqual(
        Array.from({ length: 2 }, (_, index) => ({
          inputID: `msg_goal_${Hash.sha256(`${sessionID}\0${index + 1}`).slice(0, 24)}`,
          delivery: "steer",
        })),
      )
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("uses only the newest assistant question for goal continuations", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_latest_question")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      let drains = 0
      const steers: Array<{ readonly latestAssistantText?: string; readonly goal: SessionAutonomy.Goal }> = []
      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () =>
          Effect.gen(function* () {
            drains += 1
            const text = drains === 1 ? "Which database should I use?" : "The database is selected."
            yield* recordAssistant(database, sessionID, drains, [{ type: "text", text }])
            if (drains === 3) yield* autonomy.stop(sessionID).pipe(Effect.orDie)
          }),
        undefined,
        undefined,
        undefined,
        (input) =>
          Effect.sync(() => {
            steers.push(input)
            return `Proxy steer for: ${input.latestAssistantText}`
          }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(3)
      const continuations = yield* admittedInputTexts(database)
      expect(continuations).toEqual([
        "Proxy steer for: Which database should I use?",
        "Proxy steer for: The database is selected.",
      ])
      expect(steers.map((input) => input.latestAssistantText)).toEqual([
        "Which database should I use?",
        "The database is selected.",
      ])
      expect(steers.map((input) => input.goal)).toMatchObject([
        { text: "Ship the fix", status: "active", iteration: 0 },
        { text: "Ship the fix", status: "active", iteration: 1 },
      ])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("leaves the active goal unchanged when continuation steer generation fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_steer_failure")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () => recordAssistant(database, sessionID, 1, [{ type: "text", text: "Made progress." }]),
        undefined,
        undefined,
        undefined,
        () => Effect.fail(new SessionGoal.Error({ code: "goal.calculation_failed" })),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(yield* autonomy.get(sessionID)).toMatchObject({
        goal: { text: "Ship the fix", status: "active", iteration: 0, noProgress: 0 },
      })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("does not admit a late steer after the user stops the goal during generation", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_stale_steer")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () => recordAssistant(database, sessionID, 1, [{ type: "text", text: "Made progress." }]),
        undefined,
        undefined,
        undefined,
        () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("Late steer")),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const running = yield* execution.resume(sessionID).pipe(Effect.forkScoped)
      yield* Deferred.await(entered)

      yield* autonomy.stop(sessionID)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* execution.awaitIdle(sessionID)

      expect(yield* autonomy.get(sessionID)).toMatchObject({
        goal: { text: "Ship the fix", status: "stopped", iteration: 0 },
      })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("does not spin a parent goal while its background shell is still running", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_background_shell")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () =>
          Effect.gen(function* () {
            drains += 1
          }),
        undefined,
        noopCompactionExecution(),
        () =>
          Effect.succeed([
            Info.make({
              id: ID.make("sh_goal_background_shell"),
              status: "running",
              command: "sleep",
              cwd: "/project",
              shell: "/bin/sh",
              file: "/tmp/sh_goal_background_shell.log",
              metadata: { sessionID },
              time: { started: 1 },
            }),
          ]),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(1)
      expect(yield* autonomy.get(sessionID)).toMatchObject({
        goal: { status: "active", iteration: 0, noProgress: 0 },
      })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  for (const state of ["running", "waiting"] as const) {
    for (const terminal of ["completed", "failed", "lost"] as const) {
      it.effect(`continues a goal after a direct ${terminal} child settles from ${state}`, () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const parentID = Session.ID.make(`ses_goal_${state}_parent`)
          const childID = Session.ID.make(`ses_goal_${state}_child`)
          yield* seedSessions(database, [parentID, childID])
          yield* seedTask(database, { parentID, childID, state })
          const autonomy = SessionAutonomy.make({ db: database.db })
          yield* autonomy.setGoal({ sessionID: parentID, text: "Ship the fix" })

          let drains = 0
          const scope = yield* Scope.make()
          const context = yield* buildExecution(scope, () =>
            Effect.gen(function* () {
              drains += 1
              if (drains === 2) yield* autonomy.complete(parentID).pipe(Effect.orDie)
              yield* recordAssistant(database, parentID, drains, [
                { type: "text", text: "Verified." },
              ])
            }),
          )
          const execution = Context.get(context, SessionExecution.Service)

          yield* execution.resume(parentID)
          yield* execution.awaitIdle(parentID)

          expect(drains).toBe(1)
          expect(yield* autonomy.get(parentID)).toMatchObject({
            mode: "normal",
            yolo: 0,
            goal: { status: "active", iteration: 0 },
          })
          expect(yield* admittedInputs(database)).toEqual([])

          yield* database.db
            .update(SessionTaskTable)
            .set({ state: terminal })
            .where(eq(SessionTaskTable.session_id, childID))
            .run()
            .pipe(Effect.orDie)
          yield* execution.wake(parentID)
          yield* execution.awaitIdle(parentID)

          expect(drains).toBe(2)
          expect(yield* autonomy.get(parentID)).toMatchObject({
            mode: "normal",
            goal: { status: "completed", iteration: 0 },
          })
          expect(yield* admittedInputs(database)).toEqual([])
          yield* Scope.close(scope, Exit.void)
        }),
      )
    }
  }

  it.effect("settles the goal before publishing the terminal execution event", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_settled_first")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      // Clients re-read autonomy when execution settles, so the goal must be final by then.
      const observed: Array<{ type: string; state: SessionAutonomy.State }> = []
      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () =>
          autonomy
            .complete(sessionID)
            .pipe(Effect.orDie, Effect.andThen(recordAssistant(database, sessionID, 1, [{ type: "text", text: "Verified." }]))),
        (type) =>
          autonomy.get(sessionID).pipe(
            Effect.tap((state) => Effect.sync(() => void observed.push({ type, state }))),
            Effect.ignore,
          ),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(observed.find((entry) => entry.type === "session.execution.succeeded")?.state).toMatchObject({
        mode: "normal",
        goal: { status: "completed", iteration: 0 },
      })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("leaves an active goal untouched when a drain fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_failed")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.fail(
          new LLMError({
            module: "test",
            method: "stream",
            reason: new TransportReason({ message: "Disconnected" }),
          }),
        ),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID).pipe(Effect.exit)
      yield* execution.awaitIdle(sessionID)

      expect(yield* autonomy.get(sessionID)).toMatchObject({ mode: "normal", yolo: 0, goal: { status: "active", iteration: 0 } })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("queues no continuation once the goal left goal mode", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = Session.ID.make("ses_goal_stopped")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })
      yield* autonomy.stop(sessionID)

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.sync(() => {
          drains += 1
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(1)
      expect(yield* autonomy.get(sessionID)).toMatchObject({ mode: "normal", goal: { status: "stopped" } })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )
})

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

/** Writes the assistant message a real drain would leave behind for the goal loop to read. */
function recordAssistant(
  database: Database.Service["Service"],
  sessionID: Session.ID,
  seq: number,
  content: ReadonlyArray<{ type: "text"; text: string }>,
) {
  const created = DateTime.makeUnsafe(seq)
  const {
    id: _id,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make(`msg_assistant_${seq}`),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") },
      content,
      time: { created, completed: created },
    }),
  )
  return database.db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(`msg_assistant_${seq}`),
      session_id: sessionID,
      type,
      seq,
      time_created: DateTime.toEpochMillis(created),
      data,
    })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

function seedTask(
  database: Database.Service["Service"],
  input: { parentID: Session.ID; childID: Session.ID; state: "running" | "waiting" },
) {
  return database.db
    .insert(SessionTaskTable)
    .values({
      session_id: input.childID,
      parent_id: input.parentID,
      parent_assistant_message_id: SessionMessage.ID.make("msg_parent"),
      tool_call_id: "call_goal_child",
      input_id: SessionMessage.ID.make("msg_goal_child_input"),
      description: "goal child",
      agent: Agent.ID.make("reviewer"),
      model: CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("model") }),
      prompt_digest: "digest",
      background: true,
      delivery: "steer",
      state: input.state,
    })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<Session.ID>,
  values: { time_suspended?: number } = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          directory: "/project",
          title: id,
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function suspensions(database: Database.Service["Service"]) {
  return database.db
    .select({ id: SessionTable.id, suspended: SessionTable.time_suspended })
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.suspended !== null]))),
    )
}

/** Durable admissions for a Session. The pending projection is not built by this harness. */
function admittedInputs(database: Database.Service["Service"]) {
  return database.db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows
          .filter((row) => row.type.startsWith("session.input.admitted"))
          .map((row) => ({
            inputID: row.data.inputID,
            delivery: (row.data.input as { delivery?: string } | undefined)?.delivery,
          })),
      ),
    )
}

function admittedInputTexts(database: Database.Service["Service"]) {
  return database.db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows
          .filter((row) => row.type.startsWith("session.input.admitted"))
          .map((row) => (row.data.input as { data?: { text?: unknown } } | undefined)?.data?.text)
          .filter((text): text is string => typeof text === "string"),
      ),
    )
}

/** Builds the local execution layer plus the restart actions against the test harness services. */
function buildExecution(
  scope: Scope.Closeable,
  drain: SessionRunner.Interface["drain"],
  observePublish?: (type: string) => Effect.Effect<void>,
  compactionExecution = noopCompactionExecution(),
  shells: Shell.Interface["list"] = () => Effect.succeed([]),
  steer: (input: {
    readonly session: Session.Info
    readonly goal: SessionAutonomy.Goal
    readonly phase: "start" | "continue"
    readonly latestAssistantText?: string
  }) => Effect.Effect<string, SessionGoal.Error> = ({ goal }) => Effect.succeed(`Continue work on ${goal.text}`),
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const published = yield* EventRuntime.Service
    const events = observePublish
      ? EventRuntime.Service.of({
          ...published,
          publish: (definition, data, options) =>
            observePublish(definition.type).pipe(Effect.andThen(published.publish(definition, data, options))),
        })
      : published
    const store = yield* SessionStore.Service
    const autonomy = SessionAutonomy.make({ db: database.db })
    const jobs = yield* Job.Service
    const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ drain }))
    const shell = Layer.mock(Shell.Service, { list: shells })
    const goals = Layer.succeed(
      SessionGoal.Service,
      SessionGoal.Service.of({
        synthesize: () => Effect.die("unused"),
        steer,
      }),
    )
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The local execution test only needs the Session runner from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(runner, shell, goals) as unknown as Layer.Layer<LocationServices>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer.pipe(
        Layer.provideMerge(SessionExecution.layer),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(EventRuntime.Service, events)),
        Layer.provide(AppNodeBuilder.build(LayerNode.group([AppProcess.node]))),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(SessionAutonomy.Service, autonomy)),
        Layer.provide(Layer.succeed(Job.Service, jobs)),
        Layer.provide(Layer.succeed(SessionCompactionExecution.Service, compactionExecution)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}

function noopCompactionExecution() {
  const start: SessionCompactionExecution.Interface["start"] = () => Effect.die("unused")
  const run: SessionCompactionExecution.Interface["run"] = () => Effect.die("unused")
  return SessionCompactionExecution.Service.of({ start, run })
}
