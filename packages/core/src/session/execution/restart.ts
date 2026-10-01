export * as SessionRestart from "./restart"

import { Context, Effect, Layer, Option } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { SessionOrchestration } from "../orchestration"
import { SessionExecution } from "../execution"
import { SessionInterruptedExecution } from "./interrupted"
import { SessionStore } from "../store"

export interface Interface {
  /**
   * Marks every execution active in this process for resumption by the next server start.
   * Call once new work has stopped arriving and before teardown interrupts the drains.
   */
  readonly suspendActiveSessions: Effect.Effect<void>
  /**
   * Settles executions left unterminated by a process that died, so each surfaces as a failed run.
   * Call once at managed startup before any execution begins; it never resumes work.
   */
  readonly reconcileInterruptedExecutions: Effect.Effect<void>
  /** Explicitly resumes suspended Sessions. Each suspension is consumed atomically, so a Session resumes at most once. */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/**
 * Restart continuity actions for the managed server. The service is inert until called: managed
 * startup never resumes suspended Sessions, and default, embedded, and stdio servers never suspend.
 */
export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const orchestration = yield* Effect.serviceOption(SessionOrchestration.Service)
    return Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* store.suspend(yield* execution.active)
      }),
      reconcileInterruptedExecutions: SessionInterruptedExecution.reconcile(db, events),
      resumeSuspendedSessions: Effect.gen(function* () {
        if (Option.isSome(orchestration)) yield* orchestration.value.recover
        const sessions = yield* store.listSuspended()
        yield* Effect.forEach(
          sessions,
          (sessionID) =>
            Effect.gen(function* () {
              if (!(yield* store.consumeSuspended(sessionID))) return
              if (Option.isSome(orchestration) && (yield* orchestration.value.managed(sessionID))) return
              // Drain failures are already logged and durably recorded by the execution layer.
              yield* Effect.ignore(execution.resume(sessionID))
            }),
          // Each suspension is consumed atomically right before its drain; at most four drains run at once.
          { concurrency: 4, discard: true },
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionStore.node, SessionExecution.node, SessionOrchestration.node],
})
