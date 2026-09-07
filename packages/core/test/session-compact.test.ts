import { describe, expect } from "bun:test"
import { Model } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
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
import { SessionStore } from "@ycoding-ai/core/session/store"
import { SessionCompactionJobTable, SessionMessageTable } from "@ycoding-ai/core/session/sql"
import { Hash } from "@ycoding-ai/core/util/hash"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { eq } from "drizzle-orm"
import { Clock, Deferred, Effect, Exit, Fiber, Layer, LayerMap } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = Model.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 10_000, output: 1_000 } }),
})
const compactionPolicy = ConfigCompaction.resolve([])
const advisoryTargetMaxInputTokens = Math.floor(
  (10_000 * (compactionPolicy.advisory === false ? 100 : compactionPolicy.advisory.considerPercent)) / 100,
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    list: () => Effect.succeed([]),
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
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
const workerControls = new Map<
  SessionCompaction.ID,
  {
    readonly started: Deferred.Deferred<void>
    readonly release: Deferred.Deferred<void>
    readonly failures?: ReadonlyArray<SessionCompaction.FailureCode>
    attempts?: number
  }
>()
const worker = Layer.mock(SessionCompactionService)({
  manifest: (job) =>
    Effect.gen(function* () {
      const control = workerControls.get(job.id)
      if (!control) return yield* Effect.die(new Error(`Missing compaction worker control for ${job.id}`))
      control.attempts = (control.attempts ?? 0) + 1
      yield* Deferred.succeed(control.started, undefined)
      const failure = control.failures?.[control.attempts - 1]
      if (failure) return yield* new ManifestError({ code: failure })
      yield* Deferred.await(control.release)
      return yield* new ManifestError({ code: "provider_failed" })
    }),
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
      [LocationServiceMap.node, integratedLocations],
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)

describe("SessionV2.compact", () => {
  it.effect("claims and executes a stale pending job from an earlier process", () =>
    Effect.gen(function* () {
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

      const id = SessionCompaction.ID.make("cmp_stale_pending")
      const boundary = yield* (yield* Database.Service).db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!boundary) return yield* Effect.die("Missing stale compaction boundary")
      yield* jobs.admit({
        id,
        sessionID: created.id,
        trigger: "manual",
        requestedThrough: { messageID, seq: boundary.seq },
        baseContextRevision: 0,
        targetMaxInputTokens: 7_000,
        configDigest: "a".repeat(64),
      })
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)
      const compacting = yield* session
        .compact({ sessionID: created.id })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(control.started)
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "running", attempts: 1 })
      expect(yield* SessionPending.compaction((yield* Database.Service).db, created.id)).toBeUndefined()
      yield* Deferred.succeed(control.release, undefined)
      expect(yield* Fiber.join(compacting)).toMatchObject({ id, status: "failed", failure: "provider_failed" })
    }),
  )

  it.effect("reclaims and executes an expired running job from an earlier process", () =>
    Effect.gen(function* () {
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
          data: { text: "Reclaim this expired compaction job." },
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_expired_running")
      const boundary = yield* (yield* Database.Service).db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (!boundary) return yield* Effect.die("Missing expired compaction boundary")
      yield* jobs.admit({
        id,
        sessionID: created.id,
        trigger: "manual",
        requestedThrough: { messageID, seq: boundary.seq },
        baseContextRevision: 0,
        targetMaxInputTokens: 7_000,
        configDigest: "a".repeat(64),
      })
      const now = yield* Clock.currentTimeMillis
      yield* jobs.claim({
        jobID: id,
        owner: "crashed-process",
        now,
        expiresAt: now + 30_000,
      })
      yield* (yield* Database.Service).db
        .update(SessionCompactionJobTable)
        .set({ lease_expires_at: 1 })
        .where(eq(SessionCompactionJobTable.id, id))
        .run()
        .pipe(Effect.orDie)
      yield* TestClock.adjust(2)
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "running", leaseOwner: "crashed-process" })
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)
      const compacting = yield* session
        .compact({ sessionID: created.id })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(control.started)
      expect(compacting.pollUnsafe()).toBeUndefined()
      expect(yield* jobs.get(id)).toMatchObject({
        id,
        status: "running",
        leaseOwner: expect.not.stringMatching("crashed-process"),
      })
      yield* Deferred.succeed(control.release, undefined)

      expect(yield* Fiber.join(compacting)).toMatchObject({ id, status: "failed", failure: "provider_failed" })
      expect((yield* jobs.get(id))?.leaseOwner).toBeUndefined()
      expect(
        yield* (yield* Database.Service).db
          .select({ leaseOwner: SessionCompactionJobTable.lease_owner })
          .from(SessionCompactionJobTable)
          .where(eq(SessionCompactionJobTable.id, id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ leaseOwner: null })
    }),
  )

  it.effect("returns only after foreground compaction reaches a terminal status", () =>
    Effect.gen(function* () {
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
          data: { text: "Compact in the foreground." },
          delivery: "steer",
        },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_foreground")
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)

      const compacting = yield* session
        .compact({ id, sessionID: created.id })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(control.started)
      expect(compacting.pollUnsafe()).toBeUndefined()
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "running" })
      yield* Deferred.succeed(control.release, undefined)

      expect(yield* Fiber.join(compacting)).toMatchObject({ id, status: "failed", failure: "provider_failed" })
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "failed", errorCode: "provider_failed" })
    }),
  )

  it.effect("returns an advisory admission after its background worker starts and before settlement", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const jobs = yield* SessionCompactionJob.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID: messageID,
        input: { type: "user", data: { text: "Compact this history in the background." }, delivery: "steer" },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_advisor_background")
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)
      const advisory = yield* session
        .compact({ id, sessionID: created.id, trigger: "consider" })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(control.started)
      const returnedBeforeSettlement = advisory.pollUnsafe()
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "running", attempts: 1 })
      yield* Deferred.succeed(control.release, undefined)
      yield* Fiber.await(advisory)

      expect(returnedBeforeSettlement).toBeDefined()
      if (returnedBeforeSettlement && Exit.isSuccess(returnedBeforeSettlement))
        expect(returnedBeforeSettlement.value).toMatchObject({ id, status: "pending", trigger: "consider" })
    }),
  )

  it.effect("suppresses unchanged deterministic advisory failures but allows an explicit manual retry", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(["context_limit_unresolved", "invalid_manifest"] as const, (failure) =>
        Effect.gen(function* () {
          const fixture = yield* setupSession(`advisory_${failure}`)
          const jobs = yield* SessionCompactionJob.Service
          const first = yield* jobs.admit({
            id: SessionCompaction.ID.make(`cmp_${failure}_first`),
            sessionID: fixture.sessionID,
            trigger: "consider",
            requestedThrough: fixture.boundary,
            baseContextRevision: 0,
            targetMaxInputTokens: advisoryTargetMaxInputTokens,
            configDigest: ConfigCompaction.admissionDigest(compactionPolicy),
          })
          yield* jobs.claim({ jobID: first.id, owner: "failed-worker", now: 10, expiresAt: 20 })
          yield* jobs.fail({ id: first.id, owner: "failed-worker", code: failure, now: 11 })
          const advisoryID = SessionCompaction.ID.make(`cmp_${failure}_advisory_retry`)
          workerControls.set(advisoryID, {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          })

          expect(
            yield* fixture.session.compact({ id: advisoryID, sessionID: fixture.sessionID, trigger: "consider" }),
          ).toBeUndefined()
          expect(yield* sessionJobIDs(fixture.sessionID)).toEqual([first.id])

          const manualID = SessionCompaction.ID.make(`cmp_${failure}_manual_retry`)
          workerControls.set(manualID, {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
            failures: [failure],
          })
          expect(yield* fixture.session.compact({ id: manualID, sessionID: fixture.sessionID })).toMatchObject({
            id: manualID,
            status: "failed",
            failure,
          })
          expect(yield* sessionJobIDs(fixture.sessionID)).toEqual([first.id, manualID])
        }),
      )
    }),
  )

  it.effect("admits advisory recovery after a legacy policy-only deterministic failure", () =>
    Effect.gen(function* () {
      const fixture = yield* setupSession("legacy_advisory_digest")
      const jobs = yield* SessionCompactionJob.Service
      const first = yield* jobs.admit({
        id: SessionCompaction.ID.make("cmp_legacy_advisory_first"),
        sessionID: fixture.sessionID,
        trigger: "consider",
        requestedThrough: fixture.boundary,
        baseContextRevision: 0,
        targetMaxInputTokens: advisoryTargetMaxInputTokens,
        configDigest: Hash.sha256(JSON.stringify(compactionPolicy)),
      })
      yield* jobs.claim({ jobID: first.id, owner: "legacy-worker", now: 10, expiresAt: 20 })
      yield* jobs.fail({ id: first.id, owner: "legacy-worker", code: "invalid_manifest", now: 11 })
      const recoveryID = SessionCompaction.ID.make("cmp_legacy_advisory_recovery")
      const control = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        failures: ["invalid_manifest" as const],
      }
      workerControls.set(recoveryID, control)

      expect(
        yield* fixture.session.compact({ id: recoveryID, sessionID: fixture.sessionID, trigger: "consider" }),
      ).toMatchObject({ id: recoveryID, status: "pending" })
      yield* Deferred.await(control.started)
      expect(yield* sessionJobIDs(fixture.sessionID)).toEqual([first.id, recoveryID])
    }),
  )

  it.effect("keeps background compaction alive when its requesting fiber is interrupted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const jobs = yield* SessionCompactionJob.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID: messageID,
        input: { type: "user", data: { text: "Interrupt foreground compaction." }, delivery: "steer" },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_foreground_interrupted")
      const control = { started: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() }
      workerControls.set(id, control)
      const compacting = yield* session
        .compact({ id, sessionID: created.id })
        .pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(control.started)
      yield* Fiber.interrupt(compacting)

      expect(yield* jobs.get(id)).toMatchObject({ id, status: "running", attempts: 1 })
      const joined = yield* session
        .compact({ id, sessionID: created.id })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(control.release, undefined)

      expect(yield* Fiber.join(joined)).toMatchObject({ id, status: "failed", failure: "provider_failed" })
      expect(yield* jobs.get(id)).toMatchObject({ id, status: "failed", attempts: 1, errorCode: "provider_failed" })
    }),
  )

  it.effect("retries a protected-state manifest race without publishing a failed job", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const jobs = yield* SessionCompactionJob.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.InputAdmitted, {
        sessionID: created.id,
        inputID: messageID,
        input: { type: "user", data: { text: "Retry a concurrent protected-state change." }, delivery: "steer" },
      })
      yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
      yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
      const id = SessionCompaction.ID.make("cmp_manifest_race_retry")
      const control = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
        failures: ["protected_state_changed" as const],
        attempts: 0,
      }
      workerControls.set(id, control)

      expect(yield* session.compact({ id, sessionID: created.id, trigger: "consider" })).toMatchObject({
        id,
        status: "pending",
      })
      yield* Deferred.await(control.started)
      yield* TestClock.adjust(1)
      yield* Effect.yieldNow

      expect(control.attempts).toBe(2)
      const running = yield* jobs.get(id)
      expect(running).toMatchObject({ id, status: "running" })
      expect(running?.errorCode).toBeUndefined()
      yield* Deferred.succeed(control.release, undefined)
    }),
  )
})

const setupSession = Effect.fnUntraced(function* (name: string) {
  const session = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const created = yield* session.create({ location })
  const messageID = SessionMessage.ID.make(`msg_${name}`)
  yield* events.publish(SessionEvent.InputAdmitted, {
    sessionID: created.id,
    inputID: messageID,
    input: { type: "user", data: { text: name }, delivery: "steer" },
  })
  yield* events.publish(SessionEvent.InputPromoted, { sessionID: created.id, inputID: messageID })
  yield* events.publish(SessionEvent.InputConsumed, { sessionID: created.id, inputIDs: [messageID] })
  const stored = yield* (yield* Database.Service).db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, messageID))
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die("Missing compaction boundary")
  return { session, sessionID: created.id, boundary: { messageID, seq: stored.seq } }
})

const sessionJobIDs = Effect.fnUntraced(function* (sessionID: SessionV2.ID) {
  return (yield* (yield* Database.Service).db
    .select({ id: SessionCompactionJobTable.id })
    .from(SessionCompactionJobTable)
    .where(eq(SessionCompactionJobTable.session_id, sessionID))
    .orderBy(SessionCompactionJobTable.id)
    .all()
    .pipe(Effect.orDie)).map((row) => row.id)
})
