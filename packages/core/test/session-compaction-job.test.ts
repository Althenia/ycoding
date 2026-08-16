import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Schema } from "effect"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import {
  CompactionManifestBlobTable,
  SessionCompactionJobTable,
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionCompactionJob.node])))

const CONFIG_A = "a".repeat(64)
const CONFIG_B = "b".repeat(64)
const MANIFEST = "c".repeat(64)

describe("SessionCompactionJob", () => {
  it.effect("holds admission ordering without blocking lease settlement", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("admission_gate")
      const jobs = yield* SessionCompactionJob.Service
      const first = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_gate_running") }))
      yield* jobs.claim({ jobID: first.id, owner: "worker-a", now: 10, expiresAt: 20 })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const gate = yield* jobs
        .withAdmissionGate(fixture.sessionID, (admitInGate) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              admitInGate(
                admission(fixture, {
                  id: SessionCompaction.ID.make("cmp_gate_successor"),
                  requestedThrough: fixture.boundaries[1],
                }),
              ),
            ),
          ),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(entered)
      const outside = yield* jobs
        .admit(
          admission(fixture, {
            id: SessionCompaction.ID.make("cmp_gate_outside"),
            requestedThrough: fixture.boundaries[2],
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(outside.pollUnsafe()).toBeUndefined()

      expect(yield* jobs.heartbeat(first.id, "worker-a", 30)).toMatchObject({ leaseExpiresAt: 30 })
      expect(yield* jobs.fail({ id: first.id, owner: "worker-a", code: "provider_failed", now: 31 })).toMatchObject({
        status: "failed",
      })

      yield* Deferred.succeed(release, undefined)
      const gated = yield* Fiber.join(gate)
      const coalesced = yield* Fiber.join(outside)
      expect(coalesced.id).toBe(gated.id)
      expect(yield* jobs.pending(fixture.sessionID)).toMatchObject([
        { id: gated.id, status: "pending", requestedThrough: fixture.boundaries[2] },
      ])
    }),
  )

  it.effect("coalesces compatible pending requests by advancing only their boundary", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("coalesce")
      const jobs = yield* SessionCompactionJob.Service
      const first = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_coalesce") }))
      const coalesced = yield* jobs.admit(admission(fixture, { requestedThrough: fixture.boundaries[1] }))

      expect(coalesced.id).toBe(first.id)
      expect(yield* jobs.get(first.id)).toMatchObject({
        id: first.id,
        trigger: "manual",
        admissionMode: "background",
        requestedThrough: fixture.boundaries[1],
        attempts: 0,
      })
      expect(yield* eventTypes(fixture.sessionID)).toEqual(["session.compaction.admitted.2"])
    }),
  )

  it.effect("rejects stale context revisions and non-canonical requested boundaries", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("validation")
      const jobs = yield* SessionCompactionJob.Service
      const stale = yield* jobs
        .admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_stale"), baseContextRevision: 1 }))
        .pipe(Effect.flip)
      const boundary = yield* jobs
        .admit(
          admission(fixture, {
            id: SessionCompaction.ID.make("cmp_boundary_mismatch"),
            requestedThrough: { ...fixture.boundaries[0], seq: 99 },
          }),
        )
        .pipe(Effect.flip)

      expect(stale).toBeInstanceOf(SessionCompactionJob.Conflict)
      expect(boundary).toBeInstanceOf(SessionCompactionJob.Conflict)
      expect(yield* jobs.pending(fixture.sessionID)).toEqual([])
      expect(yield* eventTypes(fixture.sessionID)).toEqual([])
    }),
  )

  it.effect("fails an incompatible pending job as superseded before admitting its replacement", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("supersede")
      const jobs = yield* SessionCompactionJob.Service
      const first = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_superseded") }))
      const replacement = yield* jobs.admit(
        admission(fixture, { id: SessionCompaction.ID.make("cmp_replacement"), configDigest: CONFIG_B }),
      )

      expect(replacement.id).not.toBe(first.id)
      expect(yield* jobs.get(first.id)).toMatchObject({ status: "failed", errorCode: "superseded" })
      expect(yield* jobs.pending(fixture.sessionID)).toMatchObject([{ id: replacement.id, status: "pending" }])
      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.failed.2",
        "session.compaction.admitted.2",
      ])
    }),
  )

  it.effect("keeps a running job immutable and advances one compatible pending successor", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("successor")
      const jobs = yield* SessionCompactionJob.Service
      const first = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_running") }))
      const running = yield* jobs.claim({ jobID: first.id, owner: "worker-a", now: 10, expiresAt: 20 })
      const successor = yield* jobs.admit(
        admission(fixture, {
          id: SessionCompaction.ID.make("cmp_successor"),
          requestedThrough: fixture.boundaries[1],
        }),
      )
      const advanced = yield* jobs.admit(admission(fixture, { requestedThrough: fixture.boundaries[2] }))

      expect(running).toMatchObject({ id: first.id, status: "running", requestedThrough: fixture.boundaries[0] })
      expect(successor.id).not.toBe(first.id)
      expect(advanced.id).toBe(successor.id)
      expect(yield* jobs.pending(fixture.sessionID)).toMatchObject([
        { id: first.id, status: "running", requestedThrough: fixture.boundaries[0] },
        { id: successor.id, status: "pending", requestedThrough: fixture.boundaries[2] },
      ])
    }),
  )

  it.effect("reconciles an exact caller ID retry and rejects conflicting reuse", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("idempotency")
      const jobs = yield* SessionCompactionJob.Service
      const input = admission(fixture, { id: SessionCompaction.ID.make("cmp_exact_retry") })
      const first = yield* jobs.admit(input)
      const retried = yield* jobs.admit(input)
      const conflict = yield* jobs.admit({ ...input, configDigest: CONFIG_B }).pipe(Effect.flip)

      expect(retried).toEqual(first)
      expect(conflict).toBeInstanceOf(SessionCompactionJob.Conflict)
      expect(yield* eventTypes(fixture.sessionID)).toEqual(["session.compaction.admitted.2"])
    }),
  )

  it.effect("claims pending work, fences a live lease, and reclaims expiry without another Started event", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("claim")
      const jobs = yield* SessionCompactionJob.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_claim") }))
      const claimed = yield* jobs.claim({ sessionID: fixture.sessionID, owner: "worker-a", now: 10, expiresAt: 20 })
      const fenced = yield* jobs.claim({ jobID: admitted.id, owner: "worker-b", now: 19, expiresAt: 30 })
      const reclaimed = yield* jobs.claim({ jobID: admitted.id, owner: "worker-b", now: 20, expiresAt: 40 })

      expect(claimed).toMatchObject({ status: "running", leaseOwner: "worker-a", attempts: 1, timeStarted: 10 })
      expect(fenced).toBeUndefined()
      expect(reclaimed).toMatchObject({ status: "running", leaseOwner: "worker-b", attempts: 2, timeStarted: 10 })
      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.started.2",
      ])
    }),
  )

  it.effect("owner-fences heartbeat and successful settlement", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("end")
      const jobs = yield* SessionCompactionJob.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_end") }))
      yield* jobs.claim({ jobID: admitted.id, owner: "worker-a", now: 10, expiresAt: 20 })

      expect(yield* jobs.heartbeat(admitted.id, "worker-b", 30).pipe(Effect.flip)).toBeInstanceOf(
        SessionCompactionJob.Ownership,
      )
      expect(yield* jobs.heartbeat(admitted.id, "worker-a", 30)).toMatchObject({ leaseExpiresAt: 30 })
      yield* insertManifest(MANIFEST)
      const input = {
        id: admitted.id,
        owner: "worker-a",
        manifestDigest: MANIFEST,
        revision: 1,
        boundary: fixture.boundaries[0],
        metrics: { excludedMessages: 1, excludedParts: 2, inputTokens: 100, retainedTokens: 50 },
        now: 40,
      } as const
      expect(yield* jobs.end({ ...input, owner: "worker-b" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionCompactionJob.Ownership,
      )
      expect(yield* jobs.end(input)).toMatchObject({ status: "ended", manifestDigest: MANIFEST, timeEnded: 40 })
      expect(yield* jobs.end(input)).toMatchObject({ status: "ended" })
      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.started.2",
        "session.compaction.ended.2",
      ])
    }),
  )

  it.effect("owner-fences failure settlement and bounds its durable error", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("fail")
      const jobs = yield* SessionCompactionJob.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_fail") }))
      yield* jobs.claim({ jobID: admitted.id, owner: "worker-a", now: 10, expiresAt: 20 })

      expect(
        yield* jobs.fail({ id: admitted.id, owner: "worker-b", code: "provider_failed", now: 30 }).pipe(Effect.flip),
      ).toBeInstanceOf(SessionCompactionJob.Ownership)
      const failed = yield* jobs.fail({ id: admitted.id, owner: "worker-a", code: "provider_failed", now: 30 })
      const retried = yield* jobs.fail({ id: admitted.id, owner: "worker-a", code: "provider_failed", now: 30 })
      const row = yield* rawJob(admitted.id)

      expect(failed).toMatchObject({ status: "failed", errorCode: "provider_failed", timeEnded: 30 })
      expect(retried).toEqual(failed)
      expect(row?.error_message?.length).toBeLessThanOrEqual(256)
      expect(row?.error_message).toBe("Compaction provider request failed")
      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.started.2",
        "session.compaction.failed.2",
      ])
    }),
  )

  it.effect("cancels pending work before start and remains terminal-idempotent", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("cancel")
      const jobs = yield* SessionCompactionJob.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_cancel") }))
      const failed = yield* jobs.fail({ id: admitted.id, code: "cancelled", now: 10 })
      const retried = yield* jobs.fail({ id: admitted.id, code: "cancelled", now: 11 })

      expect(failed).toMatchObject({ status: "failed", timeEnded: 10 })
      expect(failed.timeStarted).toBeUndefined()
      expect(retried).toEqual(failed)
      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.failed.2",
      ])
    }),
  )

  it.effect("returns recoverable Session IDs once in deterministic order", () =>
    Effect.gen(function* () {
      const jobs = yield* SessionCompactionJob.Service
      const z = yield* setup("recover_z")
      const a = yield* setup("recover_a")
      const live = yield* setup("recover_live")
      const expired = yield* setup("recover_expired")
      yield* jobs.admit(admission(z, { id: SessionCompaction.ID.make("cmp_recover_z") }))
      yield* jobs.admit(admission(a, { id: SessionCompaction.ID.make("cmp_recover_a") }))
      const liveJob = yield* jobs.admit(admission(live, { id: SessionCompaction.ID.make("cmp_recover_live") }))
      const expiredJob = yield* jobs.admit(admission(expired, { id: SessionCompaction.ID.make("cmp_recover_expired") }))
      yield* jobs.claim({ jobID: liveJob.id, owner: "worker", now: 10, expiresAt: 30 })
      yield* jobs.claim({ jobID: expiredJob.id, owner: "worker", now: 10, expiresAt: 20 })

      expect(yield* jobs.recoverable(20)).toEqual(
        [a.sessionID, expired.sessionID, z.sessionID].sort((left, right) => left.localeCompare(right)),
      )
    }),
  )

  it.effect("publishes one event for each lifecycle transition across reclaim", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("cardinality")
      const jobs = yield* SessionCompactionJob.Service
      const admitted = yield* jobs.admit(admission(fixture, { id: SessionCompaction.ID.make("cmp_cardinality") }))
      yield* jobs.claim({ jobID: admitted.id, owner: "worker-a", now: 1, expiresAt: 2 })
      yield* jobs.claim({ jobID: admitted.id, owner: "worker-b", now: 2, expiresAt: 3 })
      yield* jobs.fail({ id: admitted.id, owner: "worker-b", code: "context_limit_unresolved", now: 4 })

      expect(yield* eventTypes(fixture.sessionID)).toEqual([
        "session.compaction.admitted.2",
        "session.compaction.started.2",
        "session.compaction.failed.2",
      ])
    }),
  )
})

const setup = Effect.fnUntraced(function* (name: string) {
  const db = (yield* Database.Service).db
  const sessionID = SessionSchema.ID.make(`ses_compaction_job_${name}`)
  const boundaries = [0, 1, 2].map((index) => ({
    messageID: SessionMessage.ID.make(`msg_compaction_job_${name}_${index}`),
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
            text: `boundary ${boundary.seq}`,
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
    configDigest: CONFIG_A,
    ...overrides,
  }
}

const eventTypes = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  return (yield* db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)).map((row) => row.type)
})

const rawJob = Effect.fnUntraced(function* (id: SessionCompaction.ID) {
  const db = (yield* Database.Service).db
  return yield* db
    .select()
    .from(SessionCompactionJobTable)
    .where(eq(SessionCompactionJobTable.id, id))
    .get()
    .pipe(Effect.orDie)
})

const insertManifest = Effect.fnUntraced(function* (digest: string) {
  const db = (yield* Database.Service).db
  yield* db
    .insert(CompactionManifestBlobTable)
    .values({
      digest,
      schema_version: 1,
      content: {},
      input_tokens: 100,
      retained_tokens: 50,
      time_created: 1,
    })
    .run()
    .pipe(Effect.orDie)
})
