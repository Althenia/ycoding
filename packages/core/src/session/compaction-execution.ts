export * as SessionCompactionExecution from "./compaction-execution"

import { randomUUID } from "crypto"
import { Cause, Clock, Context, Data, Deferred, Duration, Effect, Exit, FiberSet, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { SessionCompaction } from "./compaction"
import { SessionCompactionJob } from "./compaction-job"
import { SessionContextState } from "./context-state"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import type { SessionCompaction as CompactionSchema } from "@ycoding-ai/schema/session-compaction"

const LeaseDuration = Duration.seconds(30)
const HeartbeatInterval = Duration.seconds(10)
const SettlementPollInterval = Duration.seconds(1)

export interface Interface {
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly wait: (jobID: CompactionSchema.ID) => Effect.Effect<SessionCompactionJob.Job>
  readonly cancel: (jobID: CompactionSchema.ID) => Effect.Effect<SessionCompactionJob.Job | undefined>
  readonly recover: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCompactionExecution") {}

export class Unbound extends Data.TaggedError("SessionCompactionExecution.Unbound")<{
  readonly message: string
}> {}

const Current = Context.Reference<Interface | undefined>("@ycoding/v2/SessionCompactionExecution/Current", {
  defaultValue: () => undefined,
})

/** Reads the process-global executor dynamically without adding it to a Location Layer graph. */
export const use = <A, E, R>(useExecution: (execution: Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const execution = yield* Current
    if (!execution)
      return yield* Effect.die(
        new Unbound({ message: "Session compaction execution is not bound to the current fiber" }),
      )
    return yield* useExecution(execution)
  })

/** Binds execution to this effect and every child fiber it owns. */
export const bind =
  (execution: Interface) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, Current, execution)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* SessionCompactionJob.Service
    const contextState = yield* SessionContextState.Service
    const locations = yield* LocationServiceMap.Service
    const store = yield* SessionStore.Service
    const owner = `compaction-${randomUUID()}`
    const activeJobs = new Map<SessionSchema.ID, SessionCompactionJob.Job>()
    const cancelled = new Set<CompactionSchema.ID>()
    const waiters = new Map<CompactionSchema.ID, Set<Deferred.Deferred<void>>>()
    const delayedRecoveries = new Set<SessionSchema.ID>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    let execution: Interface

    const notify = (jobID: CompactionSchema.ID) =>
      Effect.gen(function* () {
        const current = waiters.get(jobID)
        waiters.delete(jobID)
        if (current) yield* Effect.forEach(current, (waiter) => Deferred.succeed(waiter, undefined), { discard: true })
      })

    const failOwned = (job: SessionCompactionJob.Job, code: CompactionSchema.FailureCode) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => jobs.fail({ id: job.id, owner, code, now })),
        Effect.ignore,
      )

    const runOwned = Effect.fn("SessionCompactionExecution.runOwned")(function* (job: SessionCompactionJob.Job) {
      const session = yield* store.get(job.sessionID)
      if (!session) return yield* new SessionCompaction.ManifestError({ code: "migration_failed" })
      const compact = SessionCompaction.Service.use((compaction) => compaction.manifest(job)).pipe(
        Effect.provide(locations.get(session.location)),
        bind(execution),
        Effect.flatMap((manifest) =>
          contextState.activate({ sessionID: job.sessionID, jobID: job.id, leaseOwner: owner, manifest }),
        ),
      )
      // Live Session progress can stale a background candidate without invalidating its immutable job boundary.
      const work = compact.pipe(
        Effect.catchIf(
          (error) => job.admissionMode === "background" && isProtectedStateChanged(error),
          () => compact,
        ),
      )
      const heartbeat = Effect.sleep(HeartbeatInterval).pipe(
        Effect.andThen(
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => jobs.heartbeat(job.id, owner, now + Duration.toMillis(LeaseDuration))),
          ),
        ),
        Effect.forever,
      )
      return yield* work.pipe(
        Effect.raceFirst(heartbeat),
        Effect.onInterrupt(() => (cancelled.has(job.id) ? failOwned(job, "cancelled") : Effect.void)),
      )
    })

    const settleFailure = (job: SessionCompactionJob.Job, cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.void
      const error = Cause.squash(cause)
      const code =
        error instanceof SessionCompaction.ManifestError
          ? error.code
          : error instanceof SessionContextState.ActivationError
            ? activationFailureCode(error.code)
            : "provider_failed"
      return failOwned(job, code)
    }

    const drain = (sessionID: SessionSchema.ID): Effect.Effect<void, SessionCompactionJob.Conflict> =>
      Effect.gen(function* () {
        while (true) {
          const now = yield* Clock.currentTimeMillis
          const job = yield* jobs.claim({
            sessionID,
            owner,
            now,
            expiresAt: now + Duration.toMillis(LeaseDuration),
          })
          if (!job) return
          activeJobs.set(sessionID, job)
          yield* Effect.gen(function* () {
            const exit = yield* runOwned(job).pipe(Effect.exit)
            if (Exit.isFailure(exit)) yield* settleFailure(job, exit.cause)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeJobs.delete(sessionID)
                cancelled.delete(job.id)
              }).pipe(Effect.andThen(notify(job.id))),
            ),
          )
        }
      })

    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, never, "cancelled">({
      drain: (sessionID) => drain(sessionID).pipe(Effect.orDie),
    })

    const wait: Interface["wait"] = Effect.fn("SessionCompactionExecution.wait")(function* (jobID) {
      while (true) {
        const job = yield* jobs.get(jobID)
        if (!job) return yield* Effect.die(new Error(`Compaction job not found: ${jobID}`))
        if (job.status === "ended" || job.status === "failed") return job
        const waiter = yield* Deferred.make<void>()
        const current = waiters.get(jobID) ?? new Set()
        current.add(waiter)
        waiters.set(jobID, current)
        const unregister = Effect.sync(() => {
          const registered = waiters.get(jobID)
          registered?.delete(waiter)
          if (registered?.size === 0) waiters.delete(jobID)
        })
        const settled = yield* Effect.gen(function* () {
          const checked = yield* jobs.get(jobID)
          if (checked?.status === "ended" || checked?.status === "failed") {
            yield* notify(jobID)
            return checked
          }
          yield* coordinator.wake(job.sessionID)
          yield* Effect.raceFirst(Deferred.await(waiter), Effect.sleep(SettlementPollInterval))
          return undefined
        }).pipe(Effect.ensuring(unregister))
        if (settled) return settled
      }
    })

    const cancel: Interface["cancel"] = Effect.fn("SessionCompactionExecution.cancel")(function* (jobID) {
      const job = yield* jobs.get(jobID)
      if (!job || job.status === "ended" || job.status === "failed") return job
      if (job.status === "pending") {
        const failed = yield* jobs
          .fail({ id: job.id, code: "cancelled", now: yield* Clock.currentTimeMillis })
          .pipe(Effect.orDie)
        yield* notify(job.id)
        return failed
      }
      const active = activeJobs.get(job.sessionID)
      if (active?.id !== job.id || job.leaseOwner !== owner) return job
      cancelled.add(job.id)
      yield* coordinator.interrupt(job.sessionID, "cancelled")
      yield* notify(job.id)
      return yield* jobs.get(job.id)
    })

    function recover(): Effect.Effect<void> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const schedule = yield* jobs.recoverySchedule(now)
        yield* Effect.forEach(
          schedule,
          (recovery) => {
            if (recovery.at <= now) return coordinator.wake(recovery.sessionID)
            return Effect.sync(() => {
              if (delayedRecoveries.has(recovery.sessionID)) return
              delayedRecoveries.add(recovery.sessionID)
              fork(
                Effect.sleep(recovery.at - now).pipe(
                  Effect.ensuring(Effect.sync(() => delayedRecoveries.delete(recovery.sessionID))),
                  Effect.andThen(recover()),
                ),
              )
            })
          },
          { discard: true },
        )
      })
    }

    execution = Service.of({ active: coordinator.active, wake: coordinator.wake, wait, cancel, recover: recover() })
    return execution
  }),
)

function activationFailureCode(code: SessionContextState.ActivationErrorCode): CompactionSchema.FailureCode {
  if (code === "protected_state_changed") return code
  if (code === "invalid_manifest" || code === "selector_mutation") return "invalid_manifest"
  if (code === "unknown_context") return "migration_failed"
  return "context_limit_unresolved"
}

function isProtectedStateChanged(error: unknown) {
  return (
    (error instanceof SessionCompaction.ManifestError || error instanceof SessionContextState.ActivationError) &&
    error.code === "protected_state_changed"
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionCompactionJob.node, SessionContextState.node, SessionStore.node, LocationServiceMap.node],
})
