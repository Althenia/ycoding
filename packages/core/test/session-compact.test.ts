import { describe, expect } from "bun:test"
import { Model } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Config } from "@ycoding-ai/core/config"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { ProjectV2 } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { ManifestError, Service as SessionCompactionService } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionPending } from "@ycoding-ai/core/session/pending"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionProjector } from "@ycoding-ai/core/session/projector"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Deferred, Effect, Layer, LayerMap } from "effect"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
let compactionWakes: SessionSchema.ID[] = []
const config = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(SessionRunnerModel.resolved(model)))
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
    awaitIdle: () => Effect.void,
  }),
)
const compactionExecution = Layer.succeed(
  SessionCompactionExecution.Service,
  SessionCompactionExecution.Service.of({
    active: Effect.succeed(new Set()),
    wake: (sessionID) => Effect.sync(() => compactionWakes.push(sessionID)),
    wait: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    recover: Effect.void,
  }),
)
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Layer.mergeAll(config, models) as unknown as Layer.Layer<LocationServices>,
  ),
)
const workerControls = new Map<
  SessionCompaction.ID,
  { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
>()
const worker = Layer.mock(SessionCompactionService)({
  manifest: (job) =>
    Effect.gen(function* () {
      const control = workerControls.get(job.id)
      if (!control) return yield* Effect.die(new Error(`Missing compaction worker control for ${job.id}`))
      yield* Deferred.succeed(control.started, undefined)
      yield* Deferred.await(control.release)
      return yield* new ManifestError({ code: "provider_failed" })
    }).pipe(Effect.ensuring(Effect.sync(() => workerControls.delete(job.id)))),
})
const integratedLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Layer.mergeAll(config, models, worker) as unknown as Layer.Layer<LocationServices>,
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionCompactionExecution.node,
      SessionCompactionJob.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [LocationServiceMap.node, locations],
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
      [SessionCompactionExecution.node, compactionExecution],
    ],
  ),
)
const itIntegrated = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionCompactionExecution.node,
      SessionCompactionJob.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [LocationServiceMap.node, integratedLocations],
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)

describe("SessionV2.compact", () => {
  it.effect("durably admits, coalesces, and wakes manual compaction", () =>
    Effect.gen(function* () {
      compactionWakes = []
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const jobs = yield* SessionCompactionJob.Service
      const created = yield* session.create({ location })

      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID: messageID,
        input: {
          type: "user",
          data: { text: "Please compact this session history." },
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.InputPromoted, {
        sessionID: created.id,
        inputID: messageID,
      })
      yield* events.publish(SessionEvent.InputConsumed, {
        sessionID: created.id,
        inputIDs: [messageID],
      })

      const id = SessionCompaction.ID.make("cmp_manual")
      const first = yield* session.compact({ id, sessionID: created.id })
      const second = yield* session.compact({ sessionID: created.id })

      expect(second.id).toBe(first.id)
      expect(first).toMatchObject({
        id,
        sessionID: created.id,
        trigger: "manual",
        admissionMode: "background",
        status: "pending",
        requestedThrough: { messageID, seq: expect.any(Number) },
      })
      expect(compactionWakes).toEqual([created.id, created.id])
      expect(yield* SessionPending.compaction((yield* Database.Service).db, created.id)).toBeUndefined()
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "pending", baseContextRevision: 0 })
      expect((yield* session.context(created.id)).find((message) => message.type === "compaction")).toBeUndefined()
    }),
  )

  itIntegrated.effect("returns after admission while the process-global worker drains asynchronously", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const execution = yield* SessionCompactionExecution.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID: messageID,
        input: {
          type: "user",
          data: { text: "Compact asynchronously." },
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_async_worker")
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)

      const admitted = yield* session.compact({ id, sessionID: created.id })

      expect(admitted).toMatchObject({ id, status: "pending" })
      yield* Deferred.await(control.started)
      yield* Deferred.succeed(control.release, undefined)
      expect(yield* execution.wait(id)).toMatchObject({ status: "failed", errorCode: "provider_failed" })
    }),
  )
})
