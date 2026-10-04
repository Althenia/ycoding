import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Money } from "@ycoding-ai/schema/money"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { AppProcess } from "@ycoding-ai/core/process"
import { ShellLedger } from "@ycoding-ai/core/shell/ledger"
import { Shell as ShellSchema } from "@ycoding-ai/schema/shell"
import { Agent } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Job } from "@ycoding-ai/core/job"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Project } from "@ycoding-ai/core/project"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionInterruptedExecution } from "@ycoding-ai/core/session/execution/interrupted"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable, SessionTaskNotificationTable } from "@ycoding-ai/core/session/sql"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(Project.Service, Project.Service.of({
  list: () => Effect.succeed([]),
  resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
  directories: () => Effect.succeed([]),
  recordOpened: () => Effect.void,
  commit: () => Effect.void,
}))
const executing = Session.ID.make("ses_executing")
const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
  active: Effect.succeed(new Set([executing])),
  resume: () => Effect.void,
  wake: () => Effect.void,
  interrupt: () => Effect.void,
  awaitIdle: () => Effect.void,
  withTransition: (_sessionID, effect) => effect,
}))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  AppProcess.node, Database.node, EventRuntime.node, SessionProjector.node, SessionStore.node, Session.node, LocationServiceMap.node, Job.node,
]), [[Project.node, projects], [SessionExecution.node, execution]]))

it.effect("derives outstanding Sessions from pending input, active goal, tasks, notices, and shell jobs", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    const location = { directory: AbsolutePath.make("/project") }
    const pending = Session.ID.make("ses_pending")
    const goal = Session.ID.make("ses_goal")
    const parent = Session.ID.make("ses_parent")
    const child = Session.ID.make("ses_child")
    const shell = Session.ID.make("ses_shell")
    for (const id of [pending, goal, parent, shell, executing]) yield* sessions.create({ id, location })
    yield* sessions.create({ id: child, parentID: parent })
    yield* sessions.synthetic({ sessionID: pending, text: "queued", resume: false })
    yield* db.update(SessionTable).set({ autonomy: { mode: "normal", yolo: 0, goal: {
      text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3,
    } } }).where(eq(SessionTable.id, goal)).run()
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "launched", parentID: parent,
      parentAssistantMessageID: SessionMessage.ID.make("msg_parent"), toolCallID: "call_1",
      inputID: SessionMessage.ID.make("msg_child"), description: "child", agent: Agent.ID.make("build"),
      model: CatalogModel.Ref.make({ providerID: Provider.ID.make("test"), id: CatalogModel.ID.make("model") }), promptDigest: "digest", background: true,
      delivery: "steer" } })
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "started" } })
    const release = yield* Deferred.make<void>()
    const job = yield* jobs.start({ type: "shell", metadata: { sessionID: shell }, run: Deferred.await(release).pipe(Effect.as("done")) })
    yield* jobs.background(job.id)
    expect([...(yield* sessions.outstanding()).running].toSorted()).toEqual([executing, shell].toSorted())
    expect([...(yield* sessions.active)]).toEqual([executing])
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending, shell].toSorted())
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "completed" } })
    expect((yield* db.select().from(SessionTaskNotificationTable).all())).toHaveLength(1)
    yield* Deferred.succeed(release, undefined)
    yield* jobs.wait({ id: job.id })
    expect([...(yield* sessions.outstanding()).running]).toEqual([executing])
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending, shell].toSorted())
    yield* sessions.synthetic({ sessionID: parent, text: "child done", resume: false })
    yield* db.update(SessionTaskNotificationTable).set({ delivered: true }).run()
    yield* jobs.noticeAdmitted(job.id)
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending].toSorted())
  }),
)

it.effect("reports no lost shell notices for a fresh Session", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    yield* sessions.create({ id: Session.ID.make("ses_fresh_shell"), location: { directory: AbsolutePath.make("/project") } })
    expect([...(yield* sessions.outstanding()).lost]).toEqual([])
  }),
)

it.effect("a lost notice is cleared by the next execution even in the same millisecond", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const appProcess = yield* AppProcess.Service
    const db = (yield* Database.Service).db
    const sessionID = Session.ID.make("ses_same_millisecond")
    yield* sessions.create({ id: sessionID, location: { directory: AbsolutePath.make("/project") } })
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    const id = ShellSchema.ID.create()
    yield* ShellLedger.record(db, { id, pid: 2_000_000_000,
      owner: { pid: 2_000_000_000, pgid: 2_000_000_000, started: "Thu Jan  1 00:00:00 1970" } })
    yield* ShellLedger.noticeOwed(db, id, sessionID)
    yield* ShellLedger.reconcile(db, appProcess)
    expect([...(yield* sessions.outstanding()).lost]).toEqual([sessionID])
    yield* events.publish(SessionEvent.Execution.Started, { sessionID })
    expect([...(yield* sessions.outstanding()).lost]).toEqual([])
    expect([...(yield* sessions.outstanding(true)).failed]).toEqual([])
  }),
)

for (const terminal of ["completed", "cancelled", "timeout"] as const) {
  it.effect(`keeps a child's background shell running only until it is ${terminal}, not while its notice is pending`, () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const parent = Session.ID.make("ses_shell_parent")
      const child = Session.ID.make("ses_shell_child")
      yield* sessions.create({ id: parent, location: { directory: AbsolutePath.make("/project") } })
      yield* sessions.create({ id: child, parentID: parent })
      const release = yield* Deferred.make<void>()
      const run = Deferred.await(release).pipe(Effect.as("done"))
      const job = yield* jobs.start({ type: "shell", metadata: { sessionID: child },
        run: terminal === "timeout" ? run.pipe(Effect.timeout("1 second")) : run })
      yield* jobs.background(job.id)
      const busy = yield* sessions.outstanding(true)
      expect([...busy.running].toSorted()).toEqual([executing, child].toSorted())
      expect(busy.sessions.has(child)).toBe(true)
      expect([...busy.failed]).toEqual([])
      expect([...(yield* sessions.active)]).toEqual([executing])
      if (terminal === "cancelled") yield* jobs.cancel(job.id)
      if (terminal === "completed") yield* Deferred.succeed(release, undefined)
      if (terminal === "timeout") yield* adjust("1 second")
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe(terminal === "timeout" ? "error" : terminal)
      const settled = yield* sessions.outstanding(true)
      expect([...settled.running]).toEqual([executing])
      expect(settled.sessions.has(child)).toBe(true)
      expect([...settled.failed]).toEqual([])
      yield* jobs.noticeAdmitted(job.id)
      expect((yield* sessions.outstanding()).sessions.has(child)).toBe(false)
    }),
  )
}

it.effect("does not count nonshell jobs or malformed shell owners as running", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const jobs = yield* Job.Service
    const owner = Session.ID.make("ses_other_job")
    yield* sessions.create({ id: owner, location: { directory: AbsolutePath.make("/project") } })
    const release = yield* Deferred.make<void>()
    for (const input of [
      { type: "verification", metadata: { sessionID: owner } },
      { type: "shell", metadata: { sessionID: 42 } },
      { type: "shell", metadata: { sessionID: "not-a-session" } },
      { type: "shell", metadata: {} },
    ]) {
      const job = yield* jobs.start({ ...input, run: Deferred.await(release).pipe(Effect.as("done")) })
      yield* jobs.background(job.id)
    }
    expect([...(yield* sessions.outstanding()).running]).toEqual([executing])
    expect([...(yield* sessions.active)]).toEqual([executing])
    yield* Deferred.succeed(release, undefined)
  }),
)

it.effect("rehydrates a failed family until any member starts a later execution", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const parent = Session.ID.make("ses_failed_parent")
    const child = Session.ID.make("ses_failed_child")
    yield* sessions.create({ id: parent, location: { directory: AbsolutePath.make("/project") } })
    yield* sessions.create({ id: child, parentID: parent })
    yield* events.publish(SessionEvent.Execution.Failed, { sessionID: child, error: { type: "unknown", message: "failed" } })
    expect([...(yield* sessions.outstanding(true)).failed]).toEqual([parent])
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: parent })
    expect([...(yield* sessions.outstanding(true)).failed]).toEqual([])
  }),
)

it.effect("settles an execution that never reached a terminal event as failed, once, without resuming work", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventRuntime.Service
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const location = { directory: AbsolutePath.make("/project") }
    const model = { id: CatalogModel.ID.make("model"), providerID: Provider.ID.make("provider") }
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const killedParent = Session.ID.make("ses_killed_parent")
    const killedChild = Session.ID.make("ses_killed_child")
    const killedIdle = Session.ID.make("ses_killed_between_steps")
    const retried = Session.ID.make("ses_killed_after_failure")
    const settled = ["ses_run_succeeded", "ses_run_interrupted", "ses_run_failed", "ses_never_ran"].map((id) => Session.ID.make(id))
    for (const id of [killedParent, killedIdle, retried, ...settled]) yield* sessions.create({ id, location })
    yield* sessions.create({ id: killedChild, parentID: killedParent })
    const openStep = SessionMessage.ID.make("msg_open_step")
    const closedStep = SessionMessage.ID.make("msg_closed_step")
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: killedChild })
    yield* events.publish(SessionEvent.Step.Started, { sessionID: killedChild, assistantMessageID: openStep, agent: Agent.defaultID, model })
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: killedIdle })
    yield* events.publish(SessionEvent.Step.Started, { sessionID: killedIdle, assistantMessageID: closedStep, agent: Agent.defaultID, model })
    yield* events.publish(SessionEvent.Step.Ended, { sessionID: killedIdle, assistantMessageID: closedStep, finish: "tool-calls", cost: Money.USD.zero, tokens })
    yield* events.publish(SessionEvent.Execution.Failed, { sessionID: retried, error: { type: "unknown", message: "earlier failure" } })
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: retried })
    for (const [id, end] of [[settled[0], SessionEvent.Execution.Succeeded], [settled[2], SessionEvent.Execution.Failed]] as const) {
      yield* events.publish(SessionEvent.Execution.Started, { sessionID: id })
      yield* events.publish(end, end === SessionEvent.Execution.Failed ? { sessionID: id, error: { type: "unknown", message: "failed" } } : { sessionID: id })
    }
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: settled[1] })
    yield* events.publish(SessionEvent.Execution.Interrupted, { sessionID: settled[1], reason: "shutdown" })
    expect([...(yield* sessions.outstanding(true)).failed].toSorted()).toEqual([settled[2]])

    yield* SessionInterruptedExecution.reconcile(db, events)

    const history = (id: Session.ID) => db.select({ type: EventTable.type, data: EventTable.data }).from(EventTable)
      .where(eq(EventTable.aggregate_id, id)).orderBy(EventTable.seq).all().pipe(Effect.map((rows) => rows.map((row) => row.type).filter((type) => !type.startsWith("session.created"))))
    expect((yield* history(killedChild))).toEqual(["session.execution.started.1", "session.step.started.1", "session.step.failed.1", "session.execution.failed.1"])
    expect((yield* history(killedIdle)).slice(-2)).toEqual(["session.step.ended.1", "session.execution.failed.1"])
    expect((yield* history(retried)).slice(-2)).toEqual(["session.execution.started.1", "session.execution.failed.1"])
    expect(yield* history(settled[0])).toEqual(["session.execution.started.1", "session.execution.succeeded.1"])
    expect(yield* history(settled[1])).toEqual(["session.execution.started.1", "session.execution.interrupted.1"])
    expect(yield* history(settled[3])).toEqual([])
    const assistant = (yield* store.context(killedChild)).findLast((message) => message.type === "assistant")
    expect(assistant?.time.completed).toBeDefined()
    expect(assistant?.error?.type).toBe("interrupted")
    expect([...(yield* sessions.outstanding(true)).failed].toSorted()).toEqual([killedParent, killedIdle, retried, settled[2]].toSorted())
    expect([...(yield* sessions.outstanding(true)).running]).toEqual([executing])

    const before = yield* db.select({ id: EventTable.id }).from(EventTable).all()
    yield* SessionInterruptedExecution.reconcile(db, events)
    expect(yield* db.select({ id: EventTable.id }).from(EventTable).all()).toEqual(before)
  }),
)
