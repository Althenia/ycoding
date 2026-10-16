export * as SessionRestart from "./restart"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { Database } from "../../database/database"
import { EventRuntime } from "../../event"
import { AppProcess } from "../../process"
import { ShellLedger } from "../../shell/ledger"
import { SessionExecution } from "../execution"
import { SessionInterruptedExecution } from "./interrupted"
import { SessionTaskRecovery } from "./recovery"
import { SessionStore } from "../store"
import { SessionTask } from "../task"

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
  readonly reconcileShells: Effect.Effect<void>
  readonly recoverTasks: Effect.Effect<void>
  readonly loseStaleTasks: Effect.Effect<void>
}

/**
 * Restart continuity actions for the managed server. The service is inert until called: managed
 * startup recovers only managed child tasks, and default, embedded, and stdio servers never suspend
 * or recover.
 */
export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const appProcess = yield* AppProcess.Service
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    const lifetime = yield* Scope.Scope
    return Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* store.suspend(yield* execution.active)
      }),
      reconcileInterruptedExecutions: SessionInterruptedExecution.reconcile(db, events, appProcess),
      reconcileShells: ShellLedger.reconcile(db, appProcess),
      recoverTasks: SessionTaskRecovery.recover({ db, events, appProcess, execution, lifetime }),
      loseStaleTasks: SessionTask.reconcileStaleTasks(db, appProcess).pipe(Effect.provideService(EventRuntime.Service, events)),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, AppProcess.node, SessionStore.node, SessionExecution.node],
})
