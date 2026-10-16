export * as SessionFileChangeCleanup from "./file-change-cleanup"

import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "./execution"
import { SessionRecordCleanup } from "./record-cleanup"
import { RetentionSettings } from "../retention-settings"

export interface Interface {
  readonly cleanup: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionFileChangeCleanup") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const execution = yield* SessionExecution.Service
    const settings = yield* RetentionSettings.Service
    return Service.of({
      cleanup: Effect.fn("SessionFileChangeCleanup.cleanup")(function* (now = Date.now()) {
        const cutoff = now - Duration.toMillis(Duration.days((yield* settings.read()).recordsDays))
        return yield* SessionRecordCleanup.cleanup(db, execution.active, "session_file_change", cutoff)
      }),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* Service
    yield* cleanup.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [Database.node, SessionExecution.node, RetentionSettings.node],
})
