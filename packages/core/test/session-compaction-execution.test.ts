import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Schema } from "effect"
import { TestClock } from "effect/testing"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventSequenceTable, EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { ManifestError, Service } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionEvent } from "@ycoding-ai/core/session/event"
import { SessionExecution } from "@ycoding-ai/core/session/execution"
import { SessionRestart } from "@ycoding-ai/core/session/execution/restart"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import { SessionStore } from "@ycoding-ai/core/session/store"
import {
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionPendingTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

type WorkerControl = {
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly results: Array<ContextManifest.Manifest | ManifestError>
  runs: number
}
const controls = new Map<SessionCompaction.ID, WorkerControl>()
const worker = Layer.mock(Service)({
  manifest: (job) =>
    Effect.gen(function* () {
      const control = controls.get(job.id)
      if (!control) return yield* Effect.die(new Error(`Missing worker control for ${job.id}`))
      return yield* Effect.gen(function* () {
        yield* SessionCompactionExecution.use((execution) => execution.active)
        const result = control.results[Math.min(control.runs, control.results.length - 1)]
        control.runs += 1
        if (control.runs === 1) {
          yield* Deferred.succeed(control.started, undefined)
          yield* Deferred.await(control.release)
        }
        if (!result) return yield* Effect.die(new Error(`Missing compaction worker result for ${job.id}`))
        if (result instanceof ManifestError) return yield* result
        return result
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (control.runs >= control.results.length) controls.delete(job.id)
          }),
        ),
      )
    }),
})
const guardrailSnapshot = { sequence: 0, digest: ContextManifest.payloadDigest(null) }
const guardrails = Layer.mock(SessionGuardrail.Service)({
  withSnapshot: (_sessionID, use) => use(guardrailSnapshot),
})
const location = Layer.merge(worker, guardrails)
const resolvedLocations: string[] = []
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make((ref) => {
    resolvedLocations.push(ref.directory)
    return (
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      location as unknown as Layer.Layer<LocationServices>
    )
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionCompactionJob.node,
      SessionContextState.node,
      SessionStore.node,
      SessionCompactionExecution.node,
    ]),
    [[LocationServiceMap.node, locations]],
  ),
)

const CONFIG_DIGEST = "a".repeat(64)

describe("SessionCompactionExecution", () => {
  it.effect("fails explicitly when the fiber-local execution gateway is unbound", () =>
    Effect.gen(function* () {
      const exit = yield* SessionCompactionExecution.use(() => Effect.void).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionCompactionExecution.Unbound)
    }),
  )

  it.effect("binds execution to child fibers and propagates waiter cancellation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const execution = SessionCompactionExecution.Service.of({
        active: Effect.succeed(new Set()),
        wake: () => Effect.void,
        wait: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        cancel: () => Effect.succeed(undefined),
        recover: Effect.void,
      })
      const fiber = yield* SessionCompactionExecution.use((bound) =>
        bound.wait(SessionCompaction.ID.make("cmp_bound_gateway")),
      ).pipe(SessionCompactionExecution.bind(execution), Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.await(interrupted)

      const exit = yield* SessionCompactionExecution.use(() => Effect.void).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("claims pending work and resolves wait after one activation terminal", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("wake_wait")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const contextState = yield* SessionContextState.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_wake_wait") }))
      const control = yield* makeControl(yield* requireJob(jobs, admitted.id))

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(control.started)
      expect((yield* jobs.get(admitted.id))?.status).toBe("running")
      expect(resolvedLocations).toContain("/project")

      yield* Deferred.succeed(control.release, undefined)
      expect((yield* execution.wait(admitted.id)).status).toBe("ended")
      expect(yield* contextState.current(fixture.sessionID)).toMatchObject({ status: "active", revision: 1 })
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toHaveLength(1)
    }),
  )

  it.effect("refreshes one background candidate after legitimate post-boundary Session progress", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("refresh_protected_state")
      const db = (yield* Database.Service).db
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const contextState = yield* SessionContextState.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_refresh_protected_state") }),
      )
      const job = yield* requireJob(jobs, admitted.id)
      const control = yield* makeControl(job)

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(control.started)
      yield* db
        .insert(SessionPendingTable)
        .values({
          id: SessionMessage.ID.make("msg_refresh_protected_state_pending"),
          session_id: fixture.sessionID,
          type: "user",
          data: { text: "legitimate post-boundary input" },
          delivery: "steer",
          admitted_seq: 3,
          time_created: 3,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSequenceTable)
        .values({ aggregate_id: fixture.sessionID, seq: 3 })
        .onConflictDoUpdate({ target: EventSequenceTable.aggregate_id, set: { seq: 3 } })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id: EventV2.ID.make("evt_refresh_protected_state_pending"),
          aggregate_id: fixture.sessionID,
          seq: 3,
          created: 3,
          type: EventV2.versionedType(SessionEvent.InputAdmitted.type, SessionEvent.InputAdmitted.durable.version),
          data: { sessionID: fixture.sessionID, inputID: "msg_refresh_protected_state_pending" },
        })
        .run()
        .pipe(Effect.orDie)
      control.results.push(yield* successfulManifest(job))

      yield* Deferred.succeed(control.release, undefined)
      const settled = yield* execution.wait(admitted.id)

      expect(settled).toMatchObject({ status: "ended", attempts: 1 })
      expect(control.runs).toBe(2)
      expect(yield* contextState.current(fixture.sessionID)).toMatchObject({ status: "active", revision: 1 })
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toEqual([
        expect.objectContaining({ type: "session.compaction.ended.2" }),
      ])
    }),
  )

  it.effect("fails a background job after a second protected-state mismatch without another refresh", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("refresh_protected_state_twice")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_refresh_protected_state_twice") }),
      )
      const control = yield* makeControl(
        yield* requireJob(jobs, admitted.id),
        new ManifestError({ code: "protected_state_changed" }),
      )

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(control.started)
      control.results.push(new ManifestError({ code: "protected_state_changed" }))
      yield* Deferred.succeed(control.release, undefined)
      const settled = yield* execution.wait(admitted.id)

      expect(settled).toMatchObject({ status: "failed", errorCode: "protected_state_changed", attempts: 1 })
      expect(control.runs).toBe(2)
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toEqual([
        expect.objectContaining({ type: "session.compaction.failed.2" }),
      ])
    }),
  )

  it.effect("does not refresh a mandatory job after a protected-state mismatch", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("mandatory_protected_state")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, {
          id: SessionCompaction.ID.make("cmp_mandatory_protected_state"),
          trigger: "mandatory",
          admissionMode: "mandatory",
        }),
      )
      const control = yield* makeControl(
        yield* requireJob(jobs, admitted.id),
        new ManifestError({ code: "protected_state_changed" }),
      )

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(control.started)
      yield* Deferred.succeed(control.release, undefined)
      const settled = yield* execution.wait(admitted.id)

      expect(settled).toMatchObject({ status: "failed", errorCode: "protected_state_changed", attempts: 1 })
      expect(control.runs).toBe(1)
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toEqual([
        expect.objectContaining({ type: "session.compaction.failed.2" }),
      ])
    }),
  )

  it.effect("coalesces same-Session wakes while different Sessions own concurrent drains", () =>
    Effect.gen(function* () {
      const first = yield* setup("coalesce_first")
      const second = yield* setup("coalesce_second")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const firstJob = yield* jobs.admit(admission(first, { id: SessionCompaction.ID.make("cmp_coalesce_first") }))
      const secondJob = yield* jobs.admit(admission(second, { id: SessionCompaction.ID.make("cmp_coalesce_second") }))
      const firstControl = yield* makeControl(yield* requireJob(jobs, firstJob.id))
      const secondControl = yield* makeControl(yield* requireJob(jobs, secondJob.id))

      yield* Effect.all(
        [execution.wake(first.sessionID), execution.wake(first.sessionID), execution.wake(second.sessionID)],
        {
          concurrency: "unbounded",
        },
      )
      yield* Effect.all([Deferred.await(firstControl.started), Deferred.await(secondControl.started)], {
        concurrency: "unbounded",
      })

      expect((yield* jobs.get(firstJob.id))?.attempts).toBe(1)
      expect((yield* jobs.get(secondJob.id))?.attempts).toBe(1)
      yield* Effect.all(
        [Deferred.succeed(firstControl.release, undefined), Deferred.succeed(secondControl.release, undefined)],
        {
          concurrency: "unbounded",
        },
      )
      yield* Effect.all([execution.wait(firstJob.id), execution.wait(secondJob.id)], { concurrency: "unbounded" })
    }),
  )

  it.effect("recovers pending and expired leases without stealing a live lease", () =>
    Effect.gen(function* () {
      const pending = yield* setup("recover_pending")
      const expired = yield* setup("recover_expired")
      const live = yield* setup("recover_live")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const pendingJob = yield* jobs.admit(admission(pending, { id: SessionCompaction.ID.make("cmp_recover_pending") }))
      const expiredJob = yield* jobs.admit(admission(expired, { id: SessionCompaction.ID.make("cmp_recover_expired") }))
      const liveJob = yield* jobs.admit(admission(live, { id: SessionCompaction.ID.make("cmp_recover_live") }))
      yield* jobs.claim({ jobID: expiredJob.id, owner: "expired-owner", now: 1, expiresAt: 2 })
      yield* jobs.claim({ jobID: liveJob.id, owner: "live-owner", now: 1, expiresAt: Number.MAX_SAFE_INTEGER })
      const pendingControl = yield* makeControl(yield* requireJob(jobs, pendingJob.id))
      const expiredControl = yield* makeControl(yield* requireJob(jobs, expiredJob.id))

      yield* TestClock.setTime(10)
      yield* execution.recover
      yield* Effect.all([Deferred.await(pendingControl.started), Deferred.await(expiredControl.started)], {
        concurrency: "unbounded",
      })

      expect((yield* jobs.get(expiredJob.id))?.attempts).toBe(2)
      expect(yield* jobs.get(liveJob.id)).toMatchObject({ status: "running", leaseOwner: "live-owner", attempts: 1 })
      expect(yield* startedEvents(expired.sessionID, expiredJob.id)).toHaveLength(1)
      yield* Effect.all(
        [Deferred.succeed(pendingControl.release, undefined), Deferred.succeed(expiredControl.release, undefined)],
        {
          concurrency: "unbounded",
        },
      )
      yield* Effect.all([execution.wait(pendingJob.id), execution.wait(expiredJob.id)], { concurrency: "unbounded" })
    }),
  )

  it.effect("reconsiders an unexpired foreign lease at its durable expiry", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("recover_foreign_lease")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_recover_foreign_lease") }),
      )
      const now = Date.now()
      yield* TestClock.setTime(now)
      yield* jobs.claim({ jobID: admitted.id, owner: "foreign-owner", now, expiresAt: now + 1_000 })
      const control = yield* makeControl(yield* requireJob(jobs, admitted.id))

      yield* execution.recover
      yield* Effect.yieldNow
      expect(yield* jobs.get(admitted.id)).toMatchObject({
        status: "running",
        leaseOwner: "foreign-owner",
        attempts: 1,
      })

      yield* TestClock.adjust("999 millis")
      expect(yield* jobs.get(admitted.id)).toMatchObject({ leaseOwner: "foreign-owner", attempts: 1 })

      yield* TestClock.adjust("1 millis")
      yield* Effect.yieldNow
      expect(yield* jobs.get(admitted.id)).toMatchObject({ status: "running", attempts: 2 })
      expect((yield* jobs.get(admitted.id))?.leaseOwner).not.toBe("foreign-owner")
      yield* Deferred.succeed(control.release, undefined)
      expect((yield* execution.wait(admitted.id)).status).toBe("ended")
    }),
  )

  it.effect("observes terminal settlement performed by a foreign lease owner", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("wait_foreign_settlement")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_wait_foreign_settlement") }),
      )
      yield* jobs.claim({ jobID: admitted.id, owner: "foreign-owner", now: 1, expiresAt: 10_000 })
      const waiter = yield* execution.wait(admitted.id).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(waiter.pollUnsafe()).toBeUndefined()

      yield* jobs.fail({ id: admitted.id, owner: "foreign-owner", code: "provider_failed", now: 2 })
      expect(waiter.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")

      expect(yield* Fiber.join(waiter)).toMatchObject({ status: "failed", errorCode: "provider_failed" })
    }),
  )

  it.effect("re-wakes an expired foreign lease while waiting without an explicit recovery call", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("wait_expired_foreign_lease")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_wait_expired_foreign_lease") }),
      )
      const now = Date.now()
      yield* TestClock.setTime(now)
      yield* jobs.claim({ jobID: admitted.id, owner: "foreign-owner", now, expiresAt: now + 30_000 })
      const control = yield* makeControl(yield* requireJob(jobs, admitted.id))
      const waiter = yield* execution.wait(admitted.id).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Effect.yieldNow
      yield* TestClock.adjust("31 seconds")
      yield* Effect.yieldNow
      expect(yield* jobs.get(admitted.id)).toMatchObject({ status: "running", attempts: 2 })
      expect((yield* jobs.get(admitted.id))?.leaseOwner).not.toBe("foreign-owner")

      yield* Deferred.succeed(control.release, undefined)
      expect((yield* Fiber.join(waiter)).status).toBe("ended")
    }),
  )

  it.effect("recovers durable compaction work through restart continuity", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("restart_recovery")
      const store = yield* SessionStore.Service
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_restart_recovery") }))
      const control = yield* makeControl(yield* requireJob(jobs, admitted.id))
      const context = yield* Layer.build(
        SessionRestart.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SessionStore.Service, store),
              Layer.succeed(SessionCompactionExecution.Service, execution),
              Layer.succeed(
                SessionExecution.Service,
                SessionExecution.Service.of({
                  active: Effect.succeed(new Set()),
                  resume: () => Effect.void,
                  wake: () => Effect.void,
                  interrupt: () => Effect.void,
                  awaitIdle: () => Effect.void,
                }),
              ),
            ),
          ),
        ),
      )

      yield* Context.get(context, SessionRestart.Service).resumeSuspendedSessions
      yield* Deferred.await(control.started)
      yield* Deferred.succeed(control.release, undefined)

      expect((yield* execution.wait(admitted.id)).status).toBe("ended")
    }),
  )

  it.effect("repairs invalid manifests only through the configured pass budget then fails", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("invalid_manifest")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_invalid_manifest") }))
      const control = yield* makeControl(
        yield* requireJob(jobs, admitted.id),
        new ManifestError({ code: "invalid_manifest" }),
      )

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(control.started)
      yield* Deferred.succeed(control.release, undefined)
      expect(yield* execution.wait(admitted.id)).toMatchObject({ status: "failed", errorCode: "invalid_manifest" })
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toHaveLength(1)
    }),
  )

  it.effect("cancels pending work and interrupts owned work into one cancelled terminal", () =>
    Effect.gen(function* () {
      const pending = yield* setup("cancel_pending")
      const running = yield* setup("cancel_running")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const pendingJob = yield* jobs.admit(admission(pending, { id: SessionCompaction.ID.make("cmp_cancel_pending") }))
      const runningJob = yield* jobs.admit(admission(running, { id: SessionCompaction.ID.make("cmp_cancel_running") }))
      const runningControl = yield* makeControl(yield* requireJob(jobs, runningJob.id))

      yield* execution.cancel(pendingJob.id)
      yield* execution.wake(running.sessionID)
      yield* Deferred.await(runningControl.started)
      yield* execution.cancel(runningJob.id)

      expect(yield* execution.wait(pendingJob.id)).toMatchObject({ status: "failed", errorCode: "cancelled" })
      expect(yield* execution.wait(runningJob.id)).toMatchObject({ status: "failed", errorCode: "cancelled" })
      expect(yield* terminalEvents(pending.sessionID, pendingJob.id)).toHaveLength(1)
      expect(yield* terminalEvents(running.sessionID, runningJob.id)).toHaveLength(1)
    }),
  )

  it.effect("drains the single pending successor only after its immutable running predecessor settles", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("successor")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const first = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_successor_first") }))
      const firstControl = yield* makeControl(
        yield* requireJob(jobs, first.id),
        new ManifestError({ code: "provider_failed" }),
      )

      yield* execution.wake(fixture.sessionID)
      yield* Deferred.await(firstControl.started)
      const successor = yield* jobs.admit(
        admission(fixture, {
          id: SessionCompaction.ID.make("cmp_successor_next"),
          requestedThrough: fixture.boundaries[1],
        }),
      )
      const successorControl = yield* makeControl(yield* requireJob(jobs, successor.id))
      yield* execution.wake(fixture.sessionID)

      expect((yield* jobs.get(first.id))?.requestedThrough).toEqual(fixture.boundaries[0])
      expect((yield* jobs.get(successor.id))?.status).toBe("pending")
      yield* Deferred.succeed(firstControl.release, undefined)
      expect((yield* execution.wait(first.id)).status).toBe("failed")
      yield* Deferred.await(successorControl.started)
      yield* Deferred.succeed(successorControl.release, undefined)
      expect((yield* execution.wait(successor.id)).status).toBe("ended")
    }),
  )

  it.effect("publishes exactly one started and one terminal lifecycle event for each started job", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("cardinality")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const admitted = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_cardinality_execution") }),
      )
      const control = yield* makeControl(yield* requireJob(jobs, admitted.id))

      yield* Effect.all([execution.wake(fixture.sessionID), execution.wake(fixture.sessionID)], {
        concurrency: "unbounded",
      })
      yield* Deferred.await(control.started)
      yield* Deferred.succeed(control.release, undefined)
      yield* execution.wait(admitted.id)

      expect(yield* startedEvents(fixture.sessionID, admitted.id)).toHaveLength(1)
      expect(yield* terminalEvents(fixture.sessionID, admitted.id)).toHaveLength(1)
    }),
  )
})

const setup = Effect.fnUntraced(function* (name: string) {
  const db = (yield* Database.Service).db
  const sessionID = SessionSchema.ID.make(`ses_compaction_execution_${name}`)
  const boundaries = [0, 1].map((index) => ({
    messageID: SessionMessage.ID.make(`msg_compaction_execution_${name}_${index}`),
    seq: index + 1,
  }))
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: name })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionContextRevisionTable)
    .values({ session_id: sessionID, revision: 0, time_created: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionContextStateTable)
    .values({ session_id: sessionID, status: "active", revision: 0 })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionMessageTable)
    .values(
      boundaries.map((boundary) => {
        const encoded = Schema.encodeSync(SessionMessage.Info)(
          SessionMessage.User.make({
            id: boundary.messageID,
            type: "user",
            text: `message ${boundary.seq}`,
            time: { created: DateTime.makeUnsafe(boundary.seq) },
          }),
        )
        const { id, type, ...data } = encoded
        return {
          id: SessionMessage.ID.make(id),
          session_id: sessionID,
          type,
          seq: boundary.seq,
          time_created: boundary.seq,
          time_updated: boundary.seq,
          data,
        }
      }),
    )
    .run()
    .pipe(Effect.orDie)
  return { sessionID, boundaries }
})

function admission(
  fixture: Effect.Success<ReturnType<typeof setup>>,
  overrides?: Partial<SessionCompactionJob.AdmitInput>,
): SessionCompactionJob.AdmitInput {
  return {
    sessionID: fixture.sessionID,
    trigger: "manual",
    admissionMode: "background",
    requestedThrough: fixture.boundaries[0],
    baseContextRevision: 0,
    targetMaxInputTokens: 4_096,
    configDigest: CONFIG_DIGEST,
    ...overrides,
  }
}

const makeControl = Effect.fnUntraced(function* (
  job: SessionCompactionJob.Job,
  result?: ContextManifest.Manifest | ManifestError,
) {
  const control = {
    started: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
    results: [result ?? (yield* successfulManifest(job))],
    runs: 0,
  }
  controls.set(job.id, control)
  return control
})

const requireJob = Effect.fnUntraced(function* (jobs: SessionCompactionJob.Interface, id: SessionCompaction.ID) {
  const job = yield* jobs.get(id)
  if (!job) return yield* Effect.die(new Error(`Compaction job not found: ${id}`))
  return job
})

const successfulManifest = Effect.fnUntraced(function* (job: SessionCompactionJob.Job) {
  const capture = yield* SessionLiveState.captureDatabase((yield* Database.Service).db, job.sessionID)
  return Object.freeze({
    schemaVersion: 1,
    baseContextRevision: job.baseContextRevision,
    coveredThrough: Object.freeze({
      messageID: job.requestedThrough.messageID,
      seq: EventV2.Seq.make(job.requestedThrough.seq),
    }),
    protectedState: Object.freeze(
      SessionLiveState.toProtectedState({ ...capture.sources, guardrails: guardrailSnapshot }).map((entry) =>
        Object.freeze(entry),
      ),
    ),
    exclusions: Object.freeze([]),
    inputTokens: 1,
    retainedTokens: 0,
  })
})

const startedEvents = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, jobID: SessionCompaction.ID) {
  return yield* lifecycleEvents(sessionID, jobID, "session.compaction.started.2")
})

const terminalEvents = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, jobID: SessionCompaction.ID) {
  const events = yield* lifecycleEvents(sessionID, jobID)
  return events.filter(
    (event) => event.type === "session.compaction.ended.2" || event.type === "session.compaction.failed.2",
  )
})

const lifecycleEvents = Effect.fnUntraced(function* (
  sessionID: SessionSchema.ID,
  jobID: SessionCompaction.ID,
  type?: string,
) {
  const db = (yield* Database.Service).db
  return yield* db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((events) =>
        events.filter(
          (event) =>
            (type === undefined || event.type === type) &&
            typeof event.data === "object" &&
            event.data !== null &&
            "jobID" in event.data &&
            event.data.jobID === jobID,
        ),
      ),
    )
})
