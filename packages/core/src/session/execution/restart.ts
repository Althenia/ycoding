export * as SessionRestart from "./restart"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Database } from "../../database/database"
import { EventRuntime } from "../../event"
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
}

/**
 * Restart continuity actions for the managed server. The service is inert until called: managed
 * startup never resumes suspended Sessions, and default, embedded, and stdio servers never suspend.
 */
export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    return Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* store.suspend(yield* execution.active)
      }),
      reconcileInterruptedExecutions: SessionInterruptedExecution.reconcile(db, events),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, SessionStore.node, SessionExecution.node],
})
