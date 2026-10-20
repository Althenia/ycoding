import { expect } from "bun:test"
import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import { Effect, Layer, Schema } from "effect"
import { SessionReviewFold } from "@ycoding-ai/core/session/review-fold"
import { eq } from "drizzle-orm"
import { Money } from "@ycoding-ai/schema/money"
import { Agent } from "@ycoding-ai/core/agent"
import { Database } from "@ycoding-ai/core/database/database"
import { Decision } from "@ycoding-ai/core/decision"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { KeepAwake } from "@ycoding-ai/core/keep-awake"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { AppProcess } from "@ycoding-ai/core/process"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { Session } from "@ycoding-ai/core/session"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionOrchestration } from "@ycoding-ai/core/session/orchestration"
import { SessionOrchestrationNotifier } from "@ycoding-ai/core/session/orchestration-notifier"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionReview } from "@ycoding-ai/core/session/review"
import { SessionPendingTable, SessionTaskNotificationTable, SessionTaskTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTask } from "@ycoding-ai/core/session/task"
import { ShellLedger } from "@ycoding-ai/core/shell/ledger"
import { QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { reviewLocation } from "./fixture/review"
import { testEffect } from "./lib/effect"

const resumed: Session.ID[] = []
const woken: Session.ID[] = []
const decisions: unknown[] = []

const graph = (database?: ReturnType<typeof Database.layer>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Database.node,
      EventRuntime.node,
      Session.node,
      SessionStore.node,
      SessionAutonomy.node,
      SessionOrchestration.node,
      SessionReview.node,
      SessionOrchestrationNotifier.node,
      SessionRestart.node,
      LocationServiceMap.node,
    ]),
    [
      [
        Project.node,
        Layer.mock(Project.Service, {
          resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
          recordOpened: () => Effect.void,
        }),
      ],
      [
        SessionExecution.node,
        Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            active: Effect.succeed(new Set()),
            resume: (sessionID) => Effect.sync(() => void resumed.push(sessionID)),
            wake: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
            interrupt: () => Effect.void,
            awaitIdle: () => Effect.void,
            withTransition: (_sessionID, effect) => effect,
          }),
        ),
      ],
      [
        KeepAwake.node,
        Layer.mock(KeepAwake.Service, {
          hold: () => Effect.succeed({ state: "off" as const }),
          release: () => Effect.succeed({ state: "off" as const }),
          get: Effect.succeed({ state: "off", lid: "off", sleepHold: false } as const),
        }),
      ],
      [
        Decision.node,
        Layer.mock(Decision.Service, {
          evaluate: (input: Decision.Input) =>
            Effect.sync(() => void decisions.push(input)).pipe(Effect.andThen(Effect.die("decision model must not run"))),
        }),
      ],
      ...(database ? [[Database.node, database] as const] : []),
    ],
  )

const it = testEffect(graph())

const agent = Agent.ID.make("build")
const model = CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("child") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const deadOwner = { owner_pid: 2_000_000_000, owner_started: "Thu Jan  1 00:00:00 1970" }

type ToolSeed = { readonly callID: string; readonly name: string; readonly called: boolean; readonly executed?: boolean; readonly result?: boolean }

const reset = Effect.sync(() => {
  resumed.length = 0
  woken.length = 0
  decisions.length = 0
})

const family = (state: "starting" | "running" | "waiting" | "cancelling" = "running", location?: Location.Ref) =>
  Effect.gen(function* () {
    yield* reset
    const session = yield* Session.Service
    const root = yield* session.create({ location: location ?? (yield* reviewLocation) })
    const child = yield* addChild(root.id, state)
    return { root, child }
  })

const addChild = (rootID: Session.ID, state: "starting" | "running" | "waiting" | "cancelling" = "running") =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const db = (yield* Database.Service).db
    const child = yield* session.create({ parentID: rootID })
    yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: child.id,
        parent_id: rootID,
        parent_assistant_message_id: SessionMessage.ID.make(`msg_launch_${child.id}`),
        tool_call_id: `call_launch_${child.id}`,
        input_id: SessionMessage.ID.make(`msg_input_${child.id}`),
        description: "recover me",
        agent,
        model,
        prompt_digest: "digest",
        background: true,
        delivery: "steer",
        state,
        revision: 1,
        time_created: 1,
        time_updated: 1,
        ...deadOwner,
      })
      .run()
      .pipe(Effect.orDie)
    return child
  })

const step = (sessionID: Session.ID, input: { readonly text?: string; readonly tools?: ReadonlyArray<ToolSeed>; readonly ended?: boolean }) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const assistantMessageID = SessionMessage.ID.create()
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent, model })
    if (input.text !== undefined) {
      yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
      yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: input.text })
    }
    for (const tool of input.tools ?? []) {
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID: tool.callID, name: tool.name })
      if (!tool.called) continue
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID: tool.callID,
        input: {},
        executed: tool.executed ?? false,
      })
      if (tool.result)
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          callID: tool.callID,
          structured: {},
          content: [{ type: "text", text: "done" }],
          executed: tool.executed ?? false,
        })
    }
    if (input.ended)
      yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, finish: "stop", cost: Money.USD.zero, tokens })
    return assistantMessageID
  })

const crash = (sessionID: Session.ID, input: Parameters<typeof step>[1]) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    const assistantMessageID = yield* step(sessionID, input)
    yield* reconcile
    return assistantMessageID
  })

const graceful = (sessionID: Session.ID, input: Parameters<typeof step>[1], reason: "shutdown" | "user" = "shutdown") =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const store = yield* SessionStore.Service
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    const assistantMessageID = yield* step(sessionID, input)
    for (const tool of input.tools ?? [])
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID,
        assistantMessageID,
        callID: tool.callID,
        error: { type: "aborted", message: "Tool execution interrupted" },
        executed: tool.executed ?? false,
      })
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID,
      assistantMessageID,
      error: { type: "aborted", message: "Step interrupted" },
    })
    if (reason === "shutdown") yield* store.suspend([sessionID])
    yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID, reason })
    return assistantMessageID
  })

const task = (childID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, childID)).get().pipe(Effect.orDie)
  })

const kill = (childID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.update(SessionTaskTable).set(deadOwner).where(eq(SessionTaskTable.session_id, childID)).run().pipe(Effect.orDie)
  })

const recover = Effect.gen(function* () {
  const restart = yield* SessionRestart.Service
  yield* restart.recoverTasks
})

const reconcile = Effect.gen(function* () {
  const restart = yield* SessionRestart.Service
  yield* restart.reconcileInterruptedExecutions
})

const taskEvents = (childID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const rows = yield* db
      .select({ id: EventTable.id, type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, childID))
      .orderBy(EventTable.seq)
      .all()
      .pipe(Effect.orDie)
    return rows
      .filter((row) => row.type.startsWith(SessionEvent.Task.Updated.type))
      .map((row) => ({ id: String(row.id), change: Schema.decodeUnknownSync(SessionEvent.Task.Updated.data)(row.data).change }))
  })

const notifications = (childID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const notifier = yield* SessionOrchestrationNotifier.Service
    yield* notifier.dispatch
    return yield* db
      .select({ type: SessionTaskNotificationTable.type, delivered: SessionTaskNotificationTable.delivered })
      .from(SessionTaskNotificationTable)
      .where(eq(SessionTaskNotificationTable.task_session_id, childID))
      .orderBy(SessionTaskNotificationTable.revision)
      .all()
      .pipe(Effect.orDie)
  })

const toolParts = (sessionID: Session.ID, messageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const found = yield* store.message(messageID)
    if (found?.message.type !== "assistant") throw new Error(`Missing assistant ${messageID} in ${sessionID}`)
    return found.message.content.filter((part) => part.type === "tool")
  })

const pendingIDs = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return (yield* db
      .select({ id: SessionPendingTable.id })
      .from(SessionPendingTable)
      .where(eq(SessionPendingTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)).map((row) => String(row.id))
  })

const ask = (location?: Location.Ref) => Effect.gen(function* () {
  const ids = yield* family("running", location)
  const messageID = yield* crash(ids.child.id, {
    text: "Checking",
    tools: [
      { callID: "call_read", name: "read", called: true },
      { callID: "call_search", name: "websearch", called: true, executed: true },
      { callID: "call_edit", name: "edit", called: false },
    ],
  })
  yield* recover
  const reviews = yield* SessionReview.Service
  const item = (yield* reviews.list(ids.root.id)).find((candidate) => candidate.kind === "recovery")
  if (!item) throw new Error("Expected a recovery review item")
  return { ...ids, messageID, item }
})

it.effect("a crash during a provider request resumes once with one recovery Step and notifies the parent", () =>
  Effect.gen(function* () {
    const ids = yield* family()
    yield* crash(ids.child.id, { text: "partial" })
    yield* recover
    const recovered = yield* task(ids.child.id)
    expect(recovered?.state).toBe("running")
    expect(recovered?.owner_pid).toBe(process.pid)
    expect(resumed).toEqual([ids.child.id])
    expect((yield* taskEvents(ids.child.id)).map((event) => [event.id, event.change.type])).toEqual([
      [`evt_task_restart_resumed_${ids.child.id}_2`, "resumed"],
    ])
    expect(yield* notifications(ids.child.id)).toEqual([{ type: "resumed", delivered: true }])
    expect(woken).toContain(ids.root.id)
    yield* recover
    expect(resumed).toEqual([ids.child.id])
    expect(yield* taskEvents(ids.child.id)).toHaveLength(1)
    expect(decisions).toEqual([])
  }),
)

it.effect("every executed tool left unsettled, including reads and provider tools, waits for a human-only decision", () =>
  Effect.gen(function* () {
    const ids = yield* ask()
    const orchestration = yield* SessionOrchestration.Service
    const waiting = yield* task(ids.child.id)
    expect(waiting?.state).toBe("waiting")
    expect(resumed).toEqual([])
    expect(ids.item).toMatchObject({
      kind: "recovery",
      reason: "restart",
      sessionID: ids.child.id,
      rootSessionID: ids.root.id,
      origin: { questionID: waiting?.question_id },
      payload: {
        type: "recovery",
        tools: [
          { messageID: ids.messageID, callID: "call_read", name: "read" },
          { messageID: ids.messageID, callID: "call_search", name: "websearch" },
        ],
      },
      child: { agent, description: "recover me" },
    })
    const parts = yield* toolParts(ids.child.id, ids.messageID)
    expect(parts.map((part) => [part.id, part.state.status === "error" ? part.state.error.type : part.state.status])).toEqual([
      ["call_read", "aborted"],
      ["call_search", "aborted"],
      ["call_edit", "tool.input-json"],
    ])
    for (const part of parts.slice(0, 2))
      expect(part.state.status === "error" && part.state.error.message).toContain("its effect is unknown and it was not retried")
    expect(parts[2]?.state.status === "error" && parts[2].state.error.message).toContain("were not executed")
    expect((yield* orchestration.get(ids.root.id, ids.child.id)).question?.deferred).toBe(true)
    expect(yield* notifications(ids.child.id)).toEqual([{ type: "question", delivered: true }])
    expect(woken).toContain(ids.root.id)

    const session = yield* Session.Service
    yield* session.autonomy.set({ sessionID: ids.root.id, yolo: true })
    yield* session.autonomy.set({ sessionID: ids.root.id, sleep: true })
    const answer = yield* orchestration
      .answer({ parentID: ids.root.id, childID: ids.child.id, questionID: QuestionID.make(waiting!.question_id!), text: "Continue" })
      .pipe(Effect.flip)
    expect(answer).toBeInstanceOf(SessionOrchestration.ConflictError)
    const spoofed = yield* orchestration
      .answer({
        parentID: ids.root.id,
        childID: ids.child.id,
        questionID: QuestionID.make(waiting!.question_id!),
        text: "Continue",
        origin: "human-review",
        reviewDecision: { itemID: ids.item.itemID, decision: { kind: "recovery", choice: "continue" } },
      })
      .pipe(Effect.flip)
    expect(spoofed).toBeInstanceOf(SessionOrchestration.ConflictError)
    const sent = yield* orchestration
      .send({ parentID: ids.root.id, childID: ids.child.id, messageID: SessionMessage.ID.create(), text: "Go on", delivery: "steer" })
      .pipe(Effect.flip)
    expect(sent).toBeInstanceOf(SessionOrchestration.ConflictError)
    yield* kill(ids.child.id)
    yield* recover
    expect((yield* task(ids.child.id))?.state).toBe("waiting")
    const reviews = yield* SessionReview.Service
    expect((yield* reviews.list(ids.root.id)).map((item) => item.itemID)).toEqual([ids.item.itemID])
    expect(resumed).toEqual([])
    expect(decisions).toEqual([])
  }),
)

it.effect("a graceful shutdown follows the crash rules and a user interruption is not recovered", () =>
  Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    const asked = yield* family()
    yield* graceful(asked.child.id, { tools: [{ callID: "call_shell", name: "shell", called: true }] })
    const resumedChild = yield* family()
    yield* graceful(resumedChild.child.id, { text: "partial", tools: [{ callID: "call_late", name: "shell", called: false }] })
    const interrupted = yield* family()
    yield* graceful(interrupted.child.id, { text: "partial" }, "user")
    yield* recover
    expect((yield* task(asked.child.id))?.state).toBe("waiting")
    expect((yield* reviews.list(asked.root.id)).map((item) => item.payload)).toEqual([
      { type: "recovery", tools: [expect.objectContaining({ callID: "call_shell", name: "shell" })] },
    ])
    expect((yield* task(resumedChild.child.id))?.state).toBe("running")
    expect(resumed).toEqual([resumedChild.child.id])
    expect((yield* task(interrupted.child.id))?.state).toBe("lost")
    expect((yield* taskEvents(interrupted.child.id)).map((event) => event.id)).toEqual([
      `evt_task_restart_lost_${interrupted.child.id}_2`,
    ])
  }),
)

it.effect("only a nonempty final answer without local continuation settles a child as completed", () =>
  Effect.gen(function* () {
    const final = yield* family()
    yield* crash(final.child.id, { text: "All checks pass.", ended: true })
    const empty = yield* family()
    yield* crash(empty.child.id, { text: "   ", ended: true })
    const continuing = yield* family()
    yield* crash(continuing.child.id, { text: "Reading", tools: [{ callID: "call_done", name: "read", called: true, result: true }], ended: true })
    yield* recover
    const completed = yield* task(final.child.id)
    expect(completed?.state).toBe("completed")
    expect((yield* taskEvents(final.child.id)).map((event) => event.change)).toEqual([
      { type: "completed", excerpt: "All checks pass." },
    ])
    expect((yield* task(empty.child.id))?.state).toBe("running")
    expect((yield* task(continuing.child.id))?.state).toBe("running")
    expect(resumed.toSorted()).toEqual([empty.child.id, continuing.child.id].toSorted())
    expect(resumed).not.toContain(final.child.id)
    const store = yield* SessionStore.Service
    const latest = (yield* store.context(continuing.child.id)).filter((message) => message.type === "assistant").at(-1)
    const parts = yield* toolParts(continuing.child.id, latest!.id)
    expect(parts.map((part) => part.state.status)).toEqual(["completed"])
  }),
)

it.effect("pending input before the first drain starts the child, and stale tasks without work are lost", () =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const starting = yield* family("starting")
    yield* session.synthetic({ sessionID: starting.child.id, text: "Begin", description: "Initial", delivery: "steer", resume: false })
    const idle = yield* family("starting")
    const waiting = yield* family("waiting")
    const cancelling = yield* family("cancelling")
    yield* recover
    const started = yield* task(starting.child.id)
    expect(started?.state).toBe("running")
    expect(started?.owner_pid).toBe(process.pid)
    expect(woken).toContain(starting.child.id)
    for (const lost of [idle, waiting, cancelling]) {
      expect((yield* task(lost.child.id))?.state).toBe("lost")
      expect((yield* taskEvents(lost.child.id)).at(-1)?.id).toBe(`evt_task_restart_lost_${lost.child.id}_2`)
      expect(yield* notifications(lost.child.id)).toEqual([{ type: "lost", delivered: false }])
    }
    const db = (yield* Database.Service).db
    expect(yield* SessionTask.lostSessions(db)).toEqual(new Set([idle.root.id, waiting.root.id, cancelling.root.id]))
  }),
)

it.effect("a second restart before a recovered Step completes marks the child lost, and a completed Step re-arms recovery", () =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const looping = yield* family()
    yield* crash(looping.child.id, { text: "partial" })
    yield* recover
    yield* kill(looping.child.id)
    yield* crash(looping.child.id, { text: "again" })
    yield* recover
    expect((yield* task(looping.child.id))?.state).toBe("lost")
    expect((yield* taskEvents(looping.child.id)).map((event) => event.id)).toEqual([
      `evt_task_restart_resumed_${looping.child.id}_2`,
      `evt_task_restart_lost_${looping.child.id}_3`,
    ])
    expect(resumed).toEqual([looping.child.id])

    const progressing = yield* family()
    yield* crash(progressing.child.id, { text: "partial" })
    yield* recover
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: progressing.child.id })
    yield* step(progressing.child.id, { text: "progress", tools: [{ callID: "call_more", name: "read", called: true, result: true }], ended: true })
    yield* kill(progressing.child.id)
    yield* step(progressing.child.id, { text: "next" })
    yield* reconcile
    yield* recover
    expect((yield* task(progressing.child.id))?.state).toBe("running")
    expect(resumed.filter((id) => id === progressing.child.id)).toHaveLength(2)
  }),
)

it.effect("concurrent startup passes record one recovery and leave a live foreign owner untouched", () =>
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const contested = yield* family()
    yield* crash(contested.child.id, { text: "partial" })
    const foreign = yield* family()
    yield* crash(foreign.child.id, { text: "partial" })
    const owner = spawn("sleep", ["60"], { stdio: "ignore" })
    yield* Effect.addFinalizer(() => Effect.sync(() => void owner.kill("SIGKILL")))
    const identity = yield* ShellLedger.identify(appProcess, owner.pid!)
    expect(identity).toBeDefined()
    yield* db
      .update(SessionTaskTable)
      .set({ owner_pid: identity!.pid, owner_started: identity!.started })
      .where(eq(SessionTaskTable.session_id, foreign.child.id))
      .run()
      .pipe(Effect.orDie)
    yield* Effect.all([recover, recover], { concurrency: 2 })
    expect((yield* taskEvents(contested.child.id)).map((event) => event.change.type)).toEqual(["resumed"])
    expect(resumed).toEqual([contested.child.id])
    const untouched = yield* task(foreign.child.id)
    expect(untouched?.state).toBe("running")
    expect(untouched?.revision).toBe(1)
  }),
)

it.effect("startup reconciliation leaves the open execution of a live foreign owner untouched", () =>
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const foreign = yield* family()
    const owner = spawn("sleep", ["60"], { stdio: "ignore" })
    yield* Effect.addFinalizer(() => Effect.sync(() => void owner.kill("SIGKILL")))
    const identity = yield* ShellLedger.identify(appProcess, owner.pid!)
    expect(identity).toBeDefined()
    yield* db
      .update(SessionTaskTable)
      .set({ owner_pid: identity!.pid, owner_started: identity!.started })
      .where(eq(SessionTaskTable.session_id, foreign.child.id))
      .run()
      .pipe(Effect.orDie)
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: foreign.child.id })
    yield* step(foreign.child.id, { text: "working", tools: [{ callID: "call_live", name: "shell", called: true }] })
    yield* reconcile
    yield* recover
    const history = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, foreign.child.id))
      .all()
      .pipe(Effect.orDie)
    expect(
      history.filter(
        (row) => row.type.startsWith(SessionEvent.Step.Failed.type) || row.type.startsWith(SessionEvent.Execution.Failed.type),
      ),
    ).toEqual([])
    expect((yield* task(foreign.child.id))?.revision).toBe(1)
  }),
)

it.effect("a human Continue resumes the child once and a later restart does not ask again", () =>
  Effect.gen(function* () {
    const ids = yield* ask()
    const reviews = yield* SessionReview.Service
    const decision = { kind: "recovery", choice: "continue" } as const
    yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision })
    const continued = yield* task(ids.child.id)
    expect(continued?.state).toBe("running")
    expect(continued?.owner_pid).toBe(process.pid)
    expect(continued?.question_id).toBeNull()
    expect(yield* pendingIDs(ids.child.id)).toEqual([SessionReview.promptID(ids.item.itemID)])
    const admitted = yield* SessionPending.lookup((yield* Database.Service).db, ids.child.id, SessionReview.promptID(ids.item.itemID))
    expect(admitted?.type).toBe("synthetic")
    expect(admitted?.type === "synthetic" && admitted.delivery).toBe("steer")
    expect(admitted?.type === "synthetic" && admitted.data.text).toContain("effects are unknown")
    expect(woken).toContain(ids.child.id)
    expect(yield* reviews.list(ids.root.id)).toEqual([])
    expect(yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision }).pipe(Effect.flip)).toBeInstanceOf(
      SessionReview.ConflictError,
    )
    expect(
      yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision: { kind: "recovery", choice: "stop" } }).pipe(Effect.flip),
    ).toBeInstanceOf(SessionReview.ConflictError)

    yield* kill(ids.child.id)
    const events = yield* EventRuntime.Service
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: ids.child.id })
    yield* reconcile
    yield* recover
    expect((yield* task(ids.child.id))?.state).toBe("running")
    expect(resumed).toEqual([ids.child.id])
    expect(yield* reviews.list(ids.root.id)).toEqual([])
    expect(decisions).toEqual([])
  }),
)

it.effect("Stop keeps the child stopped until a fresh human Continue, and no agent path can release it", () =>
  Effect.gen(function* () {
    const ids = yield* ask()
    const reviews = yield* SessionReview.Service
    const orchestration = yield* SessionOrchestration.Service
    const session = yield* Session.Service
    yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision: { kind: "recovery", choice: "stop" } })
    expect((yield* task(ids.child.id))?.state).toBe("lost")
    expect((yield* orchestration.get(ids.root.id, ids.child.id)).stoppedRecovery).toEqual({ itemID: ids.item.itemID })
    expect((yield* orchestration.list(ids.root.id)).map((item) => item.stoppedRecovery)).toEqual([{ itemID: ids.item.itemID }])
    expect(yield* reviews.list(ids.root.id)).toEqual([])
    expect(yield* notifications(ids.child.id)).toEqual([
      { type: "question", delivered: true },
      { type: "lost", delivered: true },
    ])
    woken.length = 0

    for (const delivery of ["steer", "queue"] as const) {
      const messageID = SessionMessage.ID.create()
      const blocked = yield* orchestration
        .send({ parentID: ids.root.id, childID: ids.child.id, messageID, text: "Continue anyway", delivery })
        .pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(SessionOrchestration.ConflictError)
      expect(yield* pendingIDs(ids.child.id)).not.toContain(messageID)
    }
    yield* session.synthetic({
      sessionID: ids.child.id,
      text: "Spoofed release",
      metadata: { review: { itemID: ids.item.itemID, kind: "recovery" }, source: "subagent_parent", kind: "message" },
      delivery: "steer",
      resume: false,
    })
    yield* orchestration.recover
    yield* kill(ids.child.id)
    yield* recover
    expect((yield* task(ids.child.id))?.state).toBe("lost")
    expect(woken).not.toContain(ids.child.id)
    expect(resumed).toEqual([])
    expect((yield* orchestration.get(ids.root.id, ids.child.id)).stoppedRecovery).toEqual({ itemID: ids.item.itemID })
    expect(
      yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision: { kind: "recovery", choice: "stop" } }).pipe(Effect.flip),
    ).toBeInstanceOf(SessionReview.ConflictError)

    const decision = { kind: "recovery", choice: "continue" } as const
    yield* reviews.decide({ sessionID: ids.child.id, itemID: ids.item.itemID, decision })
    const continued = yield* task(ids.child.id)
    expect(continued?.state).toBe("running")
    expect(continued?.owner_pid).toBe(process.pid)
    expect((yield* orchestration.get(ids.root.id, ids.child.id)).stoppedRecovery).toBeUndefined()
    expect(yield* pendingIDs(ids.child.id)).toContain(SessionReview.promptID(ids.item.itemID))
    expect(woken).toContain(ids.child.id)
    expect(yield* reviews.decide({ sessionID: ids.root.id, itemID: ids.item.itemID, decision }).pipe(Effect.flip)).toBeInstanceOf(
      SessionReview.ConflictError,
    )
    yield* orchestration.send({
      parentID: ids.root.id,
      childID: ids.child.id,
      messageID: SessionMessage.ID.create(),
      text: "Thanks",
      delivery: "steer",
    })
    expect(decisions).toEqual([])
  }),
)

it.live("a stopped child stays stopped after the service graph restarts and an archived child cannot be continued", () =>
  Effect.gen(function* () {
    const file = `/tmp/ycoding-recovery-stop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })
      }),
    )
    const location = yield* reviewLocation
    const stopped = yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const ids = yield* ask(location)
          const reviews = yield* SessionReview.Service
          yield* reviews.decide({
            sessionID: ids.root.id,
            itemID: ids.item.itemID,
            decision: { kind: "recovery", choice: "stop" },
          })
          return { rootID: ids.root.id, childID: ids.child.id, itemID: ids.item.itemID }
        }).pipe(Effect.provide(Layer.fresh(graph(Database.layer({ path: file })))), Effect.scoped),
      ),
    )
    yield* reset
    yield* Effect.promise(() =>
      Effect.runPromise(
        Effect.gen(function* () {
          const orchestration = yield* SessionOrchestration.Service
          const reviews = yield* SessionReview.Service
          const session = yield* Session.Service
          yield* recover
          expect((yield* orchestration.get(stopped.rootID, stopped.childID)).stoppedRecovery).toEqual({ itemID: stopped.itemID })
          const blocked = yield* orchestration
            .send({ parentID: stopped.rootID, childID: stopped.childID, messageID: SessionMessage.ID.create(), text: "Retry", delivery: "steer" })
            .pipe(Effect.flip)
          expect(blocked).toBeInstanceOf(SessionOrchestration.ConflictError)
          yield* session.archive(stopped.childID)
          expect(
            yield* reviews
              .decide({ sessionID: stopped.rootID, itemID: stopped.itemID, decision: { kind: "recovery", choice: "continue" } })
              .pipe(Effect.flip),
          ).toBeInstanceOf(SessionReview.ConflictError)
          yield* session.unarchive(stopped.childID)
          yield* reviews.decide({ sessionID: stopped.rootID, itemID: stopped.itemID, decision: { kind: "recovery", choice: "continue" } })
          expect((yield* orchestration.get(stopped.rootID, stopped.childID)).state).toBe("running")
        }).pipe(Effect.provide(Layer.fresh(graph(Database.layer({ path: file })))), Effect.scoped),
      ),
    )
    expect(woken.filter((id) => id === stopped.childID)).toHaveLength(1)
    expect(resumed).toEqual([])
  }),
)

const openQuestion = (sessionID: Session.ID, limit: number) =>
  Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    return yield* reviews.open({
      sessionID,
      kind: "question",
      reason: "free_text",
      origin: { requestID: "frm_cap" },
      payload: { type: "form", title: "Plan", fields: [{ key: "plan", type: "string", required: true }] },
      limit,
    })
  })

it.effect("restart recovery holds exceed a full review cap once per startup while new deferrals still wait for capacity", () =>
  Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    const ids = yield* family()
    const second = (yield* addChild(ids.root.id)).id
    const first = yield* openQuestion(ids.root.id, 2)
    yield* openQuestion(ids.root.id, 2)
    expect(yield* openQuestion(ids.root.id, 2).pipe(Effect.flip)).toBeInstanceOf(SessionReview.FullError)
    yield* crash(ids.child.id, { tools: [{ callID: "call_first", name: "shell", called: true }] })
    yield* crash(second, { tools: [{ callID: "call_second", name: "read", called: true }] })
    yield* Effect.all([recover, recover], { concurrency: 2 })
    yield* kill(ids.child.id)
    yield* kill(second)
    yield* recover
    const held = (yield* reviews.list(ids.root.id)).filter((item) => item.kind === "recovery")
    expect(held.map((item) => item.sessionID).toSorted()).toEqual([ids.child.id, second].toSorted())
    expect(yield* reviews.list(ids.root.id)).toHaveLength(4)
    expect(yield* openQuestion(ids.root.id, 2).pipe(Effect.flip)).toBeInstanceOf(SessionReview.FullError)
    expect(resumed).toEqual([])
    expect(decisions).toEqual([])

    const stopped = held.find((item) => item.sessionID === ids.child.id)!
    const continued = held.find((item) => item.sessionID === second)!
    yield* reviews.decide({ sessionID: ids.root.id, itemID: stopped.itemID, decision: { kind: "recovery", choice: "stop" } })
    yield* reviews.decide({ sessionID: ids.root.id, itemID: continued.itemID, decision: { kind: "recovery", choice: "continue" } })
    expect((yield* task(ids.child.id))?.state).toBe("lost")
    expect((yield* task(second))?.state).toBe("running")
    expect(yield* openQuestion(ids.root.id, 2).pipe(Effect.flip)).toBeInstanceOf(SessionReview.FullError)
    yield* reviews.decide({ sessionID: ids.root.id, itemID: first.itemID, decision: { kind: "question", answers: { plan: "A" } } })
    yield* openQuestion(ids.root.id, 2)
    expect(yield* reviews.list(ids.root.id)).toHaveLength(2)
  }),
)

it.live("a restart recovery hold is recorded only while it holds the family review lock", () =>
  Effect.gen(function* () {
    const reviews = yield* SessionReview.Service
    const ids = yield* family()
    yield* crash(ids.child.id, { tools: [{ callID: "call_locked", name: "shell", called: true }] })
    const blocked = yield* SessionReviewFold.withFamilyLock(ids.root.id)(recover.pipe(Effect.timeoutOption("1 second")))
    expect(blocked._tag).toBe("None")
    expect(yield* reviews.list(ids.root.id)).toEqual([])
    expect((yield* task(ids.child.id))?.state).toBe("running")
    yield* recover
    expect((yield* reviews.list(ids.root.id)).map((item) => item.kind)).toEqual(["recovery"])
    expect((yield* task(ids.child.id))?.state).toBe("waiting")
  }),
)
