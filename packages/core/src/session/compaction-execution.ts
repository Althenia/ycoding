export * as SessionCompactionExecution from "./compaction-execution"

import { randomUUID } from "crypto"
import type { SessionCompaction as CompactionSchema } from "@ycoding-ai/schema/session-compaction"
import { Cause, Clock, Context, Data, DateTime, Deferred, Effect, Exit, Layer, Option, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionCompaction } from "./compaction"
import { SessionCompactionJob } from "./compaction-job"
import type { ContextManifest } from "./context-manifest"
import { SessionContextState } from "./context-state"

const LeaseDurationMillis = 30_000
const ActivationAttempts = 3

export interface RunInput<E, R> {
  readonly jobID: CompactionSchema.ID
  readonly manifest: (job: SessionCompactionJob.Job) => Effect.Effect<ContextManifest.Manifest, E, R>
}

export interface Interface {
  readonly start: <E, R>(
    input: RunInput<E, R>,
  ) => Effect.Effect<void, SessionCompactionJob.Conflict | SessionCompactionJob.Ownership, R>
  readonly run: <E, R>(
    input: RunInput<E, R>,
  ) => Effect.Effect<CompactionSchema.Result, SessionCompactionJob.Conflict | SessionCompactionJob.Ownership, R>
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
    const lifetime = yield* Scope.Scope
    const active = new Map<CompactionSchema.ID, Deferred.Deferred<void>>()

    const start: Interface["start"] = (input) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = yield* jobs.get(input.jobID)
          if (!existing) return yield* conflict(input.jobID, "Compaction job does not exist")
          if (isTerminal(existing)) return yield* Effect.void

          const signal = yield* Deferred.make<void>()
          const registration = yield* Effect.sync(() => {
            const current = active.get(input.jobID)
            if (current) return { signal: current, launch: false } as const
            active.set(input.jobID, signal)
            return { signal, launch: true } as const
          })
          if (!registration.launch) return yield* Effect.void

          const owner = `compaction-${randomUUID()}`
          const now = yield* Clock.currentTimeMillis
          const claimed = yield* jobs.claim({
            jobID: input.jobID,
            owner,
            now,
            expiresAt: now + LeaseDurationMillis,
          })
          if (!claimed) {
            active.delete(input.jobID)
            yield* Deferred.succeed(signal, undefined)
            const current = yield* jobs.get(input.jobID)
            if (isTerminal(current) || current?.status === "running") return yield* Effect.void
            return yield* conflict(input.jobID, "Compaction job is not claimable by this process")
          }

          const heartbeat = Effect.sleep("10 seconds").pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((currentTime) => jobs.heartbeat(claimed.id, owner, currentTime + LeaseDurationMillis)),
            Effect.forever,
          )
          yield* activate(contextState, claimed, owner, input.manifest, ActivationAttempts).pipe(
            Effect.raceFirst(heartbeat),
            Effect.exit,
            Effect.flatMap((exit) => settle(jobs, claimed, owner, exit)),
            Effect.ensuring(
              Effect.sync(() => active.delete(claimed.id)).pipe(Effect.andThen(Deferred.succeed(signal, undefined))),
            ),
            Effect.forkIn(lifetime, { startImmediately: false }),
          )
        }),
      )

    const run: Interface["run"] = (input) =>
      Effect.gen(function* () {
        yield* start(input)
        while (true) {
          const job = yield* jobs.get(input.jobID)
          if (isTerminal(job)) return result(job)
          if (!job) return yield* conflict(input.jobID, "Compaction job does not exist")
          const signal = active.get(input.jobID)
          if (signal) {
            yield* Deferred.await(signal)
            continue
          }
          yield* Effect.sleep("100 millis")
          yield* start(input)
        }
      })

    return Service.of({ start, run })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionCompactionJob.node, SessionContextState.node],
})

const activate = <E, R>(
  contextState: SessionContextState.Interface,
  job: SessionCompactionJob.Job,
  owner: string,
  manifest: (job: SessionCompactionJob.Job) => Effect.Effect<ContextManifest.Manifest, E, R>,
  attempts: number,
): Effect.Effect<void, E | SessionContextState.ActivationError, R> =>
  manifest(job).pipe(
    Effect.flatMap((candidate) =>
      contextState.activate({ sessionID: job.sessionID, jobID: job.id, leaseOwner: owner, manifest: candidate }),
    ),
    Effect.catchIf(
      (error) => attempts > 1 && recoverableActivation(error),
      () => activate(contextState, job, owner, manifest, attempts - 1),
    ),
  )

function recoverableActivation(error: unknown) {
  if (error instanceof SessionCompaction.ManifestError) return error.code === "protected_state_changed"
  return (
    error instanceof SessionContextState.ActivationError &&
    (error.code === "boundary_changed" || error.code === "protected_state_changed")
  )
}

const settle = Effect.fnUntraced(function* <E>(
  jobs: SessionCompactionJob.Interface,
  claimed: SessionCompactionJob.Job,
  owner: string,
  exit: Exit.Exit<unknown, E>,
) {
  if (Exit.isSuccess(exit)) return
  const current = yield* jobs.get(claimed.id)
  if (isTerminal(current) || Cause.hasInterrupts(exit.cause)) return
  yield* jobs.fail({
    id: claimed.id,
    owner,
    code: terminalFailureCode(exit.cause),
    now: yield* Clock.currentTimeMillis,
  })
})

function isTerminal(
  job: SessionCompactionJob.Job | undefined,
): job is SessionCompactionJob.Job & { readonly status: "ended" | "failed" } {
  return job?.status === "ended" || job?.status === "failed"
}

function result(job: SessionCompactionJob.Job & { readonly status: "ended" | "failed" }): CompactionSchema.Result {
  return {
    id: job.id,
    sessionID: job.sessionID,
    trigger: job.trigger,
    status: job.status,
    requestedThrough: job.requestedThrough,
    timeCreated: DateTime.makeUnsafe(job.timeCreated),
    ...(job.errorCode === undefined ? {} : { failure: job.errorCode }),
  }
}

function terminalFailureCode(cause: Cause.Cause<unknown>): CompactionSchema.FailureCode {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause)) ?? Cause.squash(cause)
  if (error instanceof SessionCompaction.ManifestError) return error.code
  if (!(error instanceof SessionContextState.ActivationError)) return "migration_failed"
  if (
    error.code === "stale_base_revision" ||
    error.code === "boundary_changed" ||
    error.code === "protected_state_changed"
  )
    return "protected_state_changed"
  if (error.code === "selector_mutation" || error.code === "invalid_manifest" || error.code === "job_conflict")
    return "invalid_manifest"
  return "migration_failed"
}

const conflict = (id: CompactionSchema.ID, message: string) =>
  Effect.fail(new SessionCompactionJob.Conflict({ id, message }))
