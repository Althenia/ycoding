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
import { SessionMessageTable, SessionTable } from "@ycoding-ai/core/session/sql"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Effect, Layer, Scope, Exit, Deferred } from "effect"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { fixedLocations } from "./fixture/location-map"
import { testEffect } from "./lib/effect"

const attachmentRoot = await mkdtemp(path.join(tmpdir(), "ycoding-pending-controls-"))
afterAll(() => rm(attachmentRoot, { recursive: true, force: true }))

const sessionID = Session.ID.make("ses_pending_controls")

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
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "pending controls" })
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


const messageIDs = (database: Database.Service["Service"]) =>
  database.db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.id)),
    )

const deliveryOf = (database: Database.Service["Service"], id: string) =>
  SessionPending.list(database.db, sessionID).pipe(Effect.map((entries) => entries.find((entry) => entry.id === id)?.delivery))

describe("pending input controls", () => {
  it.effect("withdraw removes an unconsumed user input durably without waking or promoting it", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const queued = yield* session.prompt({ sessionID, text: "synthetic queued draft", delivery: "queue", resume: false })
      const kept = yield* session.prompt({ sessionID, text: "synthetic kept draft", delivery: "queue", resume: false })

      yield* session.withdrawPending({ sessionID, inputID: queued.id })
      yield* settle(execution)

      expect(yield* pendingIDs(database)).toEqual([kept.id])
      expect(yield* eventsOfType(database, "session.input.withdrawn")).toMatchObject([{ data: { sessionID, inputID: queued.id } }])
      expect(inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))).toEqual([])
      expect(yield* messageIDs(database)).not.toContain(queued.id)
      expect(drains).toBe(0)
      expect(yield* eventsOfType(database, "session.execution.started")).toHaveLength(0)
    }),
  )

  it.effect("withdraw leaves a running drain untouched", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      afterPromotion = (drain) =>
        drain === 1 ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void

      yield* session.prompt({ sessionID, text: "synthetic first prompt" })
      yield* Deferred.await(entered)
      const later = yield* session.prompt({ sessionID, text: "synthetic later draft", delivery: "queue", resume: false })
      yield* session.withdrawPending({ sessionID, inputID: later.id })
      yield* Deferred.succeed(release, undefined)
      yield* settle(execution)

      expect(drains).toBe(1)
      expect(yield* eventsOfType(database, "session.execution.interrupted")).toHaveLength(0)
      expect(yield* pendingIDs(database)).toEqual([])
      expect(inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))).not.toContain(later.id)
    }),
  )

  it.effect("steer turns a queued input into a steer and wakes the idle Session to promote it", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const queued = yield* session.prompt({ sessionID, text: "synthetic queued draft", delivery: "queue", resume: false })
      expect(yield* deliveryOf(database, queued.id)).toBe("queue")

      yield* session.steerPending({ sessionID, inputID: queued.id })
      yield* settle(execution)

      expect(yield* eventsOfType(database, "session.input.steered")).toMatchObject([{ data: { sessionID, inputID: queued.id } }])
      expect(inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))).toEqual([queued.id])
      expect(yield* messageIDs(database)).toContain(queued.id)
      expect(yield* pendingIDs(database)).toEqual([])
      expect(drains).toBe(1)
    }),
  )

  it.effect("steering an input that already steers appends no event and still wakes", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const steer = yield* session.prompt({ sessionID, text: "synthetic admit-only steer", resume: false })

      yield* session.steerPending({ sessionID, inputID: steer.id })
      yield* settle(execution)

      expect(yield* eventsOfType(database, "session.input.steered")).toHaveLength(0)
      expect(inputIDsOf(yield* eventsOfType(database, "session.input.promoted"))).toEqual([steer.id])
      expect(drains).toBe(1)
    }),
  )

  it.effect("an already promoted input is not found for both operations", () =>
    Effect.gen(function* () {
      const { session, execution, database } = yield* setup
      const admitted = yield* session.prompt({ sessionID, text: "synthetic prompt" })
      yield* settle(execution)
      expect(yield* messageIDs(database)).toContain(admitted.id)

      const withdraw = yield* session.withdrawPending({ sessionID, inputID: admitted.id }).pipe(Effect.flip)
      const steer = yield* session.steerPending({ sessionID, inputID: admitted.id }).pipe(Effect.flip)

      expect(withdraw._tag).toBe("Session.PendingInputNotFoundError")
      expect(steer._tag).toBe("Session.PendingInputNotFoundError")
      expect(yield* eventsOfType(database, "session.input.withdrawn")).toHaveLength(0)
      expect(yield* eventsOfType(database, "session.input.steered")).toHaveLength(0)
      expect(yield* messageIDs(database)).toContain(admitted.id)
    }),
  )

  it.effect("an unknown input ID is not found and a withdrawn input cannot be withdrawn again", () =>
    Effect.gen(function* () {
      const { session, database } = yield* setup
      const queued = yield* session.prompt({ sessionID, text: "synthetic queued draft", delivery: "queue", resume: false })
      yield* session.withdrawPending({ sessionID, inputID: queued.id })

      const again = yield* session.withdrawPending({ sessionID, inputID: queued.id }).pipe(Effect.flip)
      const unknown = yield* session.steerPending({ sessionID, inputID: SessionMessage.ID.make("msg_unknown_pending") }).pipe(Effect.flip)

      expect(again._tag).toBe("Session.PendingInputNotFoundError")
      expect(unknown._tag).toBe("Session.PendingInputNotFoundError")
      expect(yield* eventsOfType(database, "session.input.withdrawn")).toHaveLength(1)
    }),
  )

  it.effect("a synthetic pending input is invalid for both operations and stays pending", () =>
    Effect.gen(function* () {
      const { session, database } = yield* setup
      const synthetic = yield* session.synthetic({ sessionID, text: "synthetic notice", delivery: "queue", resume: false })

      const withdraw = yield* session.withdrawPending({ sessionID, inputID: synthetic.id }).pipe(Effect.flip)
      const steer = yield* session.steerPending({ sessionID, inputID: synthetic.id }).pipe(Effect.flip)

      expect(withdraw._tag).toBe("Session.PendingInputInvalidError")
      expect(steer._tag).toBe("Session.PendingInputInvalidError")
      expect(yield* pendingIDs(database)).toEqual([synthetic.id])
      expect(yield* deliveryOf(database, synthetic.id)).toBe("queue")
    }),
  )

  it.effect("an unknown Session fails with the Session not-found error", () =>
    Effect.gen(function* () {
      const { session } = yield* setup
      const missing = Session.ID.make("ses_pending_controls_missing")
      const inputID = SessionMessage.ID.make("msg_any")

      expect((yield* session.withdrawPending({ sessionID: missing, inputID }).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
      expect((yield* session.steerPending({ sessionID: missing, inputID }).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
    }),
  )

  it.effect("a pending input of another Session is not found", () =>
    Effect.gen(function* () {
      const { session, database } = yield* setup
      const other = Session.ID.make("ses_pending_controls_other")
      yield* database.db
        .insert(SessionTable)
        .values({ id: other, project_id: Project.ID.global, directory: "/project", title: "other" })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const foreign = yield* session.prompt({ sessionID: other, text: "synthetic foreign draft", delivery: "queue", resume: false })

      const error = yield* session.withdrawPending({ sessionID, inputID: foreign.id }).pipe(Effect.flip)

      expect(error._tag).toBe("Session.PendingInputNotFoundError")
      expect((yield* SessionPending.list(database.db, other)).map((entry) => entry.id)).toEqual([foreign.id])
    }),
  )
})
