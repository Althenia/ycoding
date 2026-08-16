import { describe, expect, test } from "bun:test"
import { LLMError, TransportReason } from "@ycoding-ai/ai"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { UserInterruptedError } from "@ycoding-ai/core/session/error"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionMessageTable, SessionTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Hash } from "@ycoding-ai/core/util/hash"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Schema, Scope } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionStore.node])))

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
      const first = SessionV2.ID.make("ses_recover_first")
      const second = SessionV2.ID.make("ses_recover_second")
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
      const interrupted = SessionV2.ID.make("ses_suspend_interrupted")
      const completed = SessionV2.ID.make("ses_suspend_completed")
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

  it.effect("resumes each suspended Session at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const first = SessionV2.ID.make("ses_resume_first")
      const second = SessionV2.ID.make("ses_resume_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      const drained: string[] = []
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, ({ sessionID }) => Effect.sync(() => void drained.push(sessionID)))
      const restart = Context.get(context, SessionRestart.Service)

      yield* restart.resumeSuspendedSessions
      expect(drained.toSorted()).toEqual([first, second])
      expect(yield* suspensions(database)).toEqual({ [first]: false, [second]: false })

      yield* restart.resumeSuspendedSessions
      expect(drained.length).toBe(2)
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("does not invoke the runner for a waiting managed child", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const parentID = SessionV2.ID.make("ses_waiting_parent")
      const childID = SessionV2.ID.make("ses_waiting_child")
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
          agent: AgentV2.ID.make("reviewer"),
          model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") }),
          prompt_digest: "digest",
          background: false,
          delivery: "steer",
          state: "waiting",
          question_id: SessionOrchestration.QuestionID.make("qst_waiting"),
          question: "Proceed?",
          question_time: 1,
        })
        .run()
      const drained: SessionV2.ID[] = []
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          drained.push(sessionID)
        }),
      )
      yield* Context.get(context, SessionExecution.Service).resume(childID)
      expect(drained).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("stops goal continuations after three repeated no-progress responses", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_goal_loop")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix", maxNoProgress: 3 })

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.gen(function* () {
          drains += 1
          yield* recordAssistant(database, sessionID, drains, [{ type: "text", text: "Still investigating." }])
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(4)
      expect(yield* autonomy.get(sessionID)).toMatchObject({
        mode: "normal",
        goal: { status: "exhausted", iteration: 4, noProgress: 3 },
      })
      expect(yield* admittedInputs(database)).toEqual(
        Array.from({ length: 3 }, (_, index) => ({
          inputID: `msg_goal_${Hash.sha256(`${sessionID}\0${index + 1}`).slice(0, 24)}`,
          delivery: "steer",
        })),
      )
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("completes a goal when the final assistant turn carries the completion marker", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_goal_completed")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      let drains = 0
      const scope = yield* Scope.make()
      const context = yield* buildExecution(scope, () =>
        Effect.gen(function* () {
          drains += 1
          // A real turn ends on prose interleaved with tool calls; the marker rides the last text part.
          yield* recordAssistant(database, sessionID, drains, [
            { type: "text", text: "Ran the suite." },
            { type: "text", text: `All green. ${SessionAutonomy.CompletionMarker}` },
          ])
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(drains).toBe(1)
      expect(yield* autonomy.get(sessionID)).toMatchObject({
        mode: "normal",
        goal: { status: "completed", iteration: 1 },
      })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("settles the goal before publishing the terminal execution event", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_goal_settled_first")
      yield* seedSessions(database, [sessionID])
      const autonomy = SessionAutonomy.make({ db: database.db })
      yield* autonomy.setGoal({ sessionID, text: "Ship the fix" })

      // Clients re-read autonomy when execution settles, so the goal must be final by then.
      const observed: Array<{ type: string; state: SessionAutonomy.State }> = []
      const scope = yield* Scope.make()
      const context = yield* buildExecution(
        scope,
        () =>
          recordAssistant(database, sessionID, 1, [
            { type: "text", text: `Verified. ${SessionAutonomy.CompletionMarker}` },
          ]),
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
        goal: { status: "completed", iteration: 1 },
      })
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("leaves an active goal untouched when a drain fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_goal_failed")
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

      expect(yield* autonomy.get(sessionID)).toMatchObject({ mode: "goal", goal: { status: "active", iteration: 0 } })
      expect(yield* admittedInputs(database)).toEqual([])
      yield* Scope.close(scope, Exit.void)
    }),
  )

  it.effect("queues no continuation once the goal left goal mode", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_goal_stopped")
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
  sessionID: SessionV2.ID,
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
      agent: AgentV2.defaultID,
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
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

function seedSessions(
  database: Database.Service["Service"],
  sessionIDs: ReadonlyArray<SessionV2.ID>,
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

/** Builds the local execution layer plus the restart actions against the test harness services. */
function buildExecution(
  scope: Scope.Closeable,
  drain: SessionRunner.Interface["drain"],
  observePublish?: (type: string) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const published = yield* EventV2.Service
    const events = observePublish
      ? EventV2.Service.of({
          ...published,
          publish: (definition, data, options) =>
            observePublish(definition.type).pipe(Effect.andThen(published.publish(definition, data, options))),
        })
      : published
    const store = yield* SessionStore.Service
    const autonomy = SessionAutonomy.make({ db: database.db })
    const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ drain }))
    const locations = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make(
        () =>
          // The local execution test only needs the Session runner from the Location graph.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          runner as unknown as Layer.Layer<LocationServices>,
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer.pipe(
        Layer.provideMerge(SessionExecution.layer),
        Layer.provide(Layer.succeed(Database.Service, database)),
        Layer.provide(Layer.succeed(EventV2.Service, events)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(Layer.succeed(SessionAutonomy.Service, autonomy)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}
