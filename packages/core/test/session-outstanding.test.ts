import { expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@ycoding-ai/core/database/database"
import { AgentV2 } from "@ycoding-ai/core/agent"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Job } from "@ycoding-ai/core/job"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { ModelV2 } from "@ycoding-ai/core/model"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionTable, SessionTaskNotificationTable } from "@ycoding-ai/core/session/sql"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
  list: () => Effect.succeed([]),
  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  directories: () => Effect.succeed([]),
  recordOpened: () => Effect.void,
  commit: () => Effect.void,
}))
const executing = SessionV2.ID.make("ses_executing")
const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
  active: Effect.succeed(new Set([executing])),
  resume: () => Effect.void,
  wake: () => Effect.void,
  interrupt: () => Effect.void,
  awaitIdle: () => Effect.void,
  withTransition: (_sessionID, effect) => effect,
}))
const it = testEffect(AppNodeBuilder.build(LayerNode.group([
  Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node, LocationServiceMap.node, Job.node,
]), [[ProjectV2.node, projects], [SessionExecution.node, execution]]))

it.effect("derives outstanding Sessions from pending input, active goal, tasks, notices, and shell jobs", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const jobs = yield* Job.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    const location = { directory: AbsolutePath.make("/project") }
    const pending = SessionV2.ID.make("ses_pending")
    const goal = SessionV2.ID.make("ses_goal")
    const parent = SessionV2.ID.make("ses_parent")
    const child = SessionV2.ID.make("ses_child")
    const shell = SessionV2.ID.make("ses_shell")
    for (const id of [pending, goal, parent, shell, executing]) yield* sessions.create({ id, location })
    yield* sessions.create({ id: child, parentID: parent })
    yield* sessions.synthetic({ sessionID: pending, text: "queued", resume: false })
    yield* db.update(SessionTable).set({ autonomy: { mode: "normal", yolo: 0, goal: {
      text: "Finish", status: "active", iteration: 1, noProgress: 0, maxNoProgress: 3,
    } } }).where(eq(SessionTable.id, goal)).run()
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "launched", parentID: parent,
      parentAssistantMessageID: SessionMessage.ID.make("msg_parent"), toolCallID: "call_1",
      inputID: SessionMessage.ID.make("msg_child"), description: "child", agent: AgentV2.ID.make("build"),
      model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("model") }), promptDigest: "digest", background: true,
      delivery: "steer" } })
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "started" } })
    const release = yield* Deferred.make<void>()
    const job = yield* jobs.start({ type: "shell", metadata: { sessionID: shell }, run: Deferred.await(release).pipe(Effect.as("done")) })
    yield* jobs.background(job.id)
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending, shell].toSorted())
    yield* events.publish(SessionEvent.Task.Updated, { sessionID: child, change: { type: "completed" } })
    expect((yield* db.select().from(SessionTaskNotificationTable).all())).toHaveLength(1)
    yield* Deferred.succeed(release, undefined)
    yield* jobs.wait({ id: job.id })
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending, shell].toSorted())
    yield* sessions.synthetic({ sessionID: parent, text: "child done", resume: false })
    yield* db.update(SessionTaskNotificationTable).set({ delivered: true }).run()
    yield* jobs.noticeAdmitted(job.id)
    expect([...(yield* sessions.outstanding()).sessions].toSorted()).toEqual([executing, goal, parent, pending].toSorted())
  }),
)

it.effect("rehydrates a failed family until any member starts a later execution", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const parent = SessionV2.ID.make("ses_failed_parent")
    const child = SessionV2.ID.make("ses_failed_child")
    yield* sessions.create({ id: parent, location: { directory: AbsolutePath.make("/project") } })
    yield* sessions.create({ id: child, parentID: parent })
    yield* events.publish(SessionEvent.Execution.Failed, { sessionID: child, error: { type: "unknown", message: "failed" } })
    expect([...(yield* sessions.outstanding(true)).failed]).toEqual([parent])
    yield* events.publish(SessionEvent.Execution.Started, { sessionID: parent })
    expect([...(yield* sessions.outstanding(true)).failed]).toEqual([])
  }),
)
