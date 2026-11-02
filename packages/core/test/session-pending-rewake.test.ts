import { afterAll, describe, expect } from "bun:test"
import { LLMError, TransportReason } from "@ycoding-ai/ai"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Global } from "@ycoding-ai/core/global"
import { Job } from "@ycoding-ai/core/job"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { AppProcess } from "@ycoding-ai/core/process"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { AttachmentStore } from "@ycoding-ai/core/attachment-store"
import { SessionAutonomy } from "@ycoding-ai/core/session/autonomy"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionRunner } from "@ycoding-ai/core/session/runner"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Effect, Layer, Scope, Exit, Deferred } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { fixedLocations } from "./fixture/location-map"
import { testEffect } from "./lib/effect"

const attachmentRoot = await mkdtemp(path.join(tmpdir(), "ycoding-pending-rewake-"))
afterAll(() => rm(attachmentRoot, { recursive: true, force: true }))

const sessionID = Session.ID.make("ses_pending_rewake")

type Harness = { db: Database.Interface["db"]; events: EventRuntime.Interface }
let harness: Harness | undefined
let drains = 0
let beforePromotion: (drain: number) => Effect.Effect<void, SessionRunner.RunError> = () => Effect.void
let afterPromotion: (drain: number) => Effect.Effect<void, SessionRunner.RunError> = () => Effect.void

const providerUnavailable = () =>
  new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider unavailable" }) })

const scriptedDrain: SessionRunner.Interface["drain"] = ({ sessionID: id }) =>
  Effect.gen(function* () {
    const { db, events } = harness!
    const drain = ++drains
    yield* beforePromotion(drain)
    const steers = (yield* SessionPending.list(db, id)).filter((entry) => entry.delivery === "steer").map((entry) => entry.id)
    yield* SessionPending.promoteSteers(db, events, id)
    const [firstSteer, ...otherSteers] = steers
    if (firstSteer !== undefined)
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: id, inputIDs: [firstSteer, ...otherSteers] })
    yield* afterPromotion(drain)
  })

const runnerLocation = (): Layer.Layer<LocationServices> =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ drain: scriptedDrain })) as unknown as Layer.Layer<LocationServices>

const locations = Layer.effect(LocationServiceMap.Service, fixedLocations(runnerLocation))

const noopCompaction = makeGlobalNode({
  service: SessionCompactionExecution.Service,
  layer: Layer.succeed(
    SessionCompactionExecution.Service,
    SessionCompactionExecution.Service.of({ start: () => Effect.die("unused"), run: () => Effect.die("unused") }),
  ),
  deps: [],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      Database.node,
      EventRuntime.node,
      Job.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      Session.node,
      AttachmentStore.node,
    ]),
    [
      [LocationServiceMap.node, locations],
      [SessionCompactionExecution.node, noopCompaction],
      [Global.node, Global.layerWith({ data: attachmentRoot })],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventRuntime.Service
  harness = { db: database.db, events }
  drains = 0
  beforePromotion = () => Effect.void
  afterPromotion = () => Effect.void
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "pending rewake" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { session: yield* Session.Service, execution: yield* SessionExecution.Service, database }
})

const eventsOfType = (database: Database.Service["Service"], prefix: string) =>
  database.db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.filter((row) => row.type.startsWith(prefix))),
    )

const pendingIDs = (database: Database.Service["Service"]) =>
  SessionPending.list(database.db, sessionID).pipe(Effect.map((entries) => entries.map((entry) => entry.id)))

const inputIDsOf = (rows: ReadonlyArray<{ readonly data: unknown }>) =>
  rows.flatMap((row) => {
    const data = row.data as { inputID?: string; inputIDs?: ReadonlyArray<string> }
    return data.inputIDs ?? (data.inputID === undefined ? [] : [data.inputID])
  })

const settle = (execution: SessionExecution.Interface) =>
  Effect.gen(function* () {
    yield* execution.awaitIdle(sessionID)
    yield* TestClock.adjust("10 minutes")
    yield* Effect.yieldNow
    yield* execution.awaitIdle(sessionID)
  })

describe("pending input re-wake", () => {
  it.effect("STOP CONTROL: an explicit user Stop leaves the interrupted steer pending with no successor drain", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const entered = yield* Deferred.make<void>()
      afterPromotion = (drain) => (drain === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void)

      yield* session.prompt({ sessionID, text: "synthetic first prompt" })
      yield* Deferred.await(entered)
      const steer = yield* session.prompt({ sessionID, text: "synthetic steer admitted during the blocked step" })
      expect(yield* pendingIDs(database)).toEqual([steer.id])

      yield* session.interrupt(sessionID)
      yield* settle(execution)

      expect(drains).toBe(1)
      expect(yield* pendingIDs(database)).toEqual([steer.id])
      expect(inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))).not.toContain(steer.id)
      expect(yield* eventsOfType(database, "session.execution.started")).toHaveLength(1)
      expect(yield* eventsOfType(database, "session.execution.interrupted")).toHaveLength(1)
    }),
  )

  it.effect("LOST NON-USER WAKE: a first drain that fails before promotion must not strand the admitted prompt", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      beforePromotion = (drain) => (drain === 1 ? Effect.fail(providerUnavailable()) : Effect.void)

      const admitted = yield* session.prompt({ sessionID, text: "synthetic web prompt, no resume field" })
      yield* settle(execution)

      const failed = yield* eventsOfType(database, "session.execution.failed")
      const promoted = inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))
      const stillPending = yield* pendingIDs(database)
      expect({ failedExecutions: failed.length, drains, promoted: promoted.includes(admitted.id), stillPending }).toEqual({
        failedExecutions: 1,
        drains: 2,
        promoted: true,
        stillPending: [],
      })
    }),
  )

  it.effect("RESTART CONTRACT: startup recovery does not resume a root Session; the admitted row is preserved, not lost", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      yield* execution.shutdown
      const admitted = yield* session.prompt({ sessionID, text: "synthetic prompt admitted as the process dies" })
      expect(drains).toBe(0)
      expect(yield* pendingIDs(database)).toEqual([admitted.id])
      expect(yield* eventsOfType(database, "session.execution.started")).toHaveLength(0)

      const second = yield* Scope.make()
      const autonomy = SessionAutonomy.make({ db: database.db })
      const context = yield* Layer.buildWithScope(
        SessionRestart.layer.pipe(
          Layer.provideMerge(Layer.fresh(SessionExecution.layer)),
          Layer.provide(Layer.succeed(Database.Service, database)),
          Layer.provide(Layer.succeed(EventRuntime.Service, harness!.events)),
          Layer.provide(Layer.succeed(SessionStore.Service, yield* SessionStore.Service)),
          Layer.provide(Layer.succeed(SessionAutonomy.Service, autonomy)),
          Layer.provide(Layer.succeed(Job.Service, yield* Job.Service)),
          Layer.provide(
            Layer.succeed(
              SessionCompactionExecution.Service,
              SessionCompactionExecution.Service.of({ start: () => Effect.die("unused"), run: () => Effect.die("unused") }),
            ),
          ),
          Layer.provide(Layer.effect(LocationServiceMap.Service, fixedLocations(runnerLocation))),
          Layer.provide(LayerNode.compile(AppProcess.node)),
        ),
        second,
      )
      const restart = yield* SessionRestart.Service.use((service) => Effect.succeed(service)).pipe(Effect.provide(context))
      const restarted = yield* SessionExecution.Service.use((service) => Effect.succeed(service)).pipe(Effect.provide(context))
      yield* restart.reconcileInterruptedExecutions
      yield* restart.reconcileShells
      yield* restart.recoverTasks
      yield* settle(restarted)

      expect({
        drains,
        promoted: inputIDsOf(yield* eventsOfType(database, "session.input.promoted")),
        consumed: inputIDsOf(yield* eventsOfType(database, "session.input.consumed")),
        pending: yield* pendingIDs(database),
      }).toEqual({ drains: 0, promoted: [], consumed: [], pending: [admitted.id] })

      yield* restarted.wake(sessionID)
      yield* settle(restarted)
      yield* Scope.close(second, Exit.void)

      expect({
        drains,
        promoted: inputIDsOf(yield* eventsOfType(database, "session.input.promoted")),
        consumed: inputIDsOf(yield* eventsOfType(database, "session.input.consumed")),
        pending: yield* pendingIDs(database),
      }).toEqual({ drains: 1, promoted: [admitted.id], consumed: [admitted.id], pending: [] })
    }),
  )
})
