import { describe, expect, test } from "bun:test"
import { LLM, Message, Model, type LLMRequest } from "@ycoding-ai/ai"
import { OpenAIChat } from "@ycoding-ai/ai/protocols"
import { ConfigCompaction } from "@ycoding-ai/core/config/compaction"
import { Database } from "@ycoding-ai/core/database/database"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventV2 } from "@ycoding-ai/core/event"
import { EventTable } from "@ycoding-ai/core/event/sql"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { Project } from "@ycoding-ai/core/project"
import { ProjectTable } from "@ycoding-ai/core/project/sql"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionCompaction } from "@ycoding-ai/core/session/compaction"
import { SessionCompactionExecution } from "@ycoding-ai/core/session/compaction-execution"
import { SessionCompactionJob } from "@ycoding-ai/core/session/compaction-job"
import { ContextManifest } from "@ycoding-ai/core/session/context-manifest"
import { hardInputCapTokens } from "@ycoding-ai/core/session/context-pressure"
import { SessionContextState } from "@ycoding-ai/core/session/context-state"
import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { SessionLiveState } from "@ycoding-ai/core/session/live-state"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { ensureWithinLimit } from "@ycoding-ai/core/session/runner/compaction-gate"
import { SessionSchema } from "@ycoding-ai/core/session/schema"
import {
  SessionCompactionJobTable,
  SessionContextRevisionTable,
  SessionContextStateTable,
  SessionMessageTable,
  SessionTable,
} from "@ycoding-ai/core/session/sql"
import { SessionStore } from "@ycoding-ai/core/session/store"
import { Hash } from "@ycoding-ai/core/util/hash"
import { and, asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, LayerMap, Schema } from "effect"
import { testEffect } from "./lib/effect"

const model = Model.make({
  id: "cap-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 1_000, output: 100 } }),
})
const policy = ConfigCompaction.resolve([
  new ConfigCompaction.Info({
    context_safety_margin_tokens: 100,
    advisory: { consider_percent: 50, strongly_advised_percent: 80 },
  }),
])
const disabledPolicy = ConfigCompaction.resolve([
  new ConfigCompaction.Info({ context_safety_margin_tokens: 100, advisory: false }),
])
const guardrailSnapshot = { sequence: 0, digest: ContextManifest.payloadDigest(null) }

type Worker = (
  db: Database.Interface["db"],
  job: SessionCompactionJob.Job,
) => Effect.Effect<ContextManifest.Manifest, SessionCompaction.ManifestError>
let worker: Worker = (db, job) => successfulManifest(db, job)
const compaction = Layer.effect(
  SessionCompaction.Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    return SessionCompaction.Service.of({ manifest: (job) => worker(db, job) })
  }),
)
const guardrails = Layer.mock(SessionGuardrail.Service)({
  withSnapshot: (_sessionID, use) => use(guardrailSnapshot),
})
const location = Layer.merge(compaction, guardrails)
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // The executor resolves only the compaction worker and guardrail snapshot in this focused harness.
      location as unknown as Layer.Layer<LocationServices>,
  ),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionCompactionJob.node,
      SessionCompaction.node,
      SessionContextState.node,
      SessionStore.node,
      SessionCompactionExecution.node,
    ]),
    [
      [LocationServiceMap.node, locations],
      [SessionCompaction.node, compaction],
    ],
  ),
)

describe("Session hard context gate", () => {
  test("calculates the exact absolute input cap", () => {
    expect(
      hardInputCapTokens({
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000,
        contextSafetyMarginTokens: 4_096,
      }),
    ).toBe(107_904)
  })

  it.effect("returns below the cap without admission, waiting, or rebuilding", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("below")
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(10),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(false)
      expect(reloads).toEqual([])
      expect(yield* allJobs()).toEqual([])
    }),
  )

  it.effect("admits mandatory work when the last provider-reported input total reaches the cap", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("provider_total")
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(10),
        lastProviderInputTokens: 800,
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true])
      expect(yield* allJobs()).toMatchObject([{ status: "ended", trigger: "mandatory" }])
    }),
  )

  it.effect("does not admit compaction for encoded tool-result image bytes", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("tool_image")
      const result = yield* runGate({
        fixture,
        candidate: {
          context: { revision: 0 },
          prepared: {
            request: LLM.request({
              model,
              messages: [
                Message.tool({
                  id: "call-image",
                  name: "read",
                  result: {
                    type: "content",
                    value: [
                      {
                        type: "file",
                        uri: `data:image/png;base64,${"a".repeat(100_000)}`,
                        mime: "image/png",
                      },
                    ],
                  },
                }),
              ],
            }),
          },
        },
        reload: () => Effect.die("reload must not run"),
      })

      expect(result.compacted).toBe(false)
      expect(yield* allJobs()).toEqual([])
    }),
  )

  it.effect("continues without admission when the exact cap is non-positive", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("non_positive")

      const result = yield* runGate({
        fixture,
        candidate: candidate(10),
        capabilities: { contextWindowTokens: 200, maxOutputTokens: 100, contextSafetyMarginTokens: 100 },
        reload: () => Effect.die("reload must not run"),
      })

      expect(result.compacted).toBe(false)
      expect(yield* allJobs()).toEqual([])
    }),
  )

  it.effect("continues when no complete message boundary exists", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("no_boundary", false)

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.die("reload must not run"),
      })

      expect(result.compacted).toBe(false)
      expect(yield* allJobs()).toEqual([])
    }),
  )

  it.effect("joins one compatible pending job with an equal or stricter target instead of admitting another", () =>
    Effect.gen(function* () {
      worker = (db, job) => successfulManifest(db, job)
      const fixture = yield* setup("compatible")
      const jobs = yield* SessionCompactionJob.Service
      const existing = yield* jobs.admit(
        admission(fixture, {
          trigger: "consider",
          targetMaxInputTokens: 300,
        }),
      )
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true])
      expect(yield* allJobs()).toMatchObject([{ id: existing.id, status: "ended" }])
    }),
  )

  it.effect("admits and waits one mandatory job at consider headroom even when advisories are disabled", () =>
    Effect.gen(function* () {
      worker = (db, job) => successfulManifest(db, job)
      const fixture = yield* setup("advisory_false")
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        policy: disabledPolicy,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true])
      expect(yield* allJobs()).toMatchObject([
        {
          status: "ended",
          trigger: "mandatory",
          targetMaxInputTokens: 560,
          configDigest: ConfigCompaction.admissionDigest(disabledPolicy),
        },
      ])
      const event = yield* (yield* Database.Service).db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, fixture.sessionID),
            eq(EventTable.type, "session.compaction.admitted.2"),
          ),
        )
        .get()
      expect(event?.data).toMatchObject({
        pressure: { safeInputTokens: 800, estimatedInputTokens: expect.any(Number) },
      })
      const pressure = event?.data.pressure
      if (
        pressure &&
        typeof pressure === "object" &&
        "estimatedInputTokens" in pressure &&
        typeof pressure.estimatedInputTokens === "number"
      )
        expect(pressure.estimatedInputTokens).toBeGreaterThanOrEqual(800)
    }),
  )

  it.effect("reloads after a compatible job settles with a local checkpoint", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("compatible_failure_rebuild")
      const jobs = yield* SessionCompactionJob.Service
      const existing = yield* jobs.admit(admission(fixture, { trigger: "consider" }))
      worker = (db, job) => successfulManifest(db, job)
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true])
      expect(yield* allJobs()).toMatchObject([{ id: existing.id, status: "ended" }])
    }),
  )

  it.effect("returns the successful rebuild after one gate-owned job settles", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("failed_owned_replacement")
      worker = (db, job) => successfulManifest(db, job)
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(10)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true])
      expect(yield* allJobs()).toMatchObject([{ status: "ended", trigger: "mandatory" }])
    }),
  )

  it.effect("bounds gate-owned admissions after joined work when compaction cannot reduce the request", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("owned_admission_bound")
      const jobs = yield* SessionCompactionJob.Service
      const existing = yield* jobs.admit(admission(fixture, { trigger: "consider" }))
      worker = (db, job) => successfulManifest(db, job)
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(8_000)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true, true, true, false])
      expect(yield* allJobs()).toMatchObject([
        { id: existing.id, status: "ended", trigger: "consider" },
        { status: "ended", trigger: "mandatory" },
        { status: "ended", trigger: "mandatory" },
      ])
    }),
  )

  it.effect("releases an oversized candidate after two insufficient ended jobs", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("insufficient_ended")
      worker = (db, job) => successfulManifest(db, job)
      const reloads: boolean[] = []

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: (fullRebase) =>
          Effect.sync(() => {
            reloads.push(fullRebase)
            return candidate(8_000)
          }),
      })

      expect(result.compacted).toBe(true)
      expect(reloads).toEqual([true, true, false])
      expect(yield* allJobs()).toMatchObject([{ status: "ended" }, { status: "ended" }])
    }),
  )

  it.effect("does not readmit unchanged context after context_limit_unresolved", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("unresolved_deduplication")
      worker = () => new SessionCompaction.ManifestError({ code: "context_limit_unresolved" })
      const oversized = {
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.succeed(candidate(8_000)),
      }

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toHaveLength(1)

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toHaveLength(1)
    }),
  )

  it.effect("does not readmit an unchanged deterministic invalid manifest across mandatory gate invocations", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("invalid_manifest_deduplication")
      worker = () => new SessionCompaction.ManifestError({ code: "invalid_manifest" })
      const oversized = {
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.succeed(candidate(8_000)),
      }

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toMatchObject([{ status: "failed", errorCode: "invalid_manifest" }])

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toHaveLength(1)

      expect((yield* runGate({ ...oversized, policy: disabledPolicy })).compacted).toBe(false)
      expect(yield* allJobs()).toMatchObject([
        { status: "failed", targetMaxInputTokens: 400 },
        { status: "failed", targetMaxInputTokens: 560 },
      ])
    }),
  )

  it.effect("does not let a legacy policy-only failure suppress the repaired algorithm", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("legacy_invalid_manifest_digest")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const legacyDigest = Hash.sha256(JSON.stringify(policy))
      const legacy = yield* jobs.admit(admission(fixture, { configDigest: legacyDigest }))
      worker = () => new SessionCompaction.ManifestError({ code: "invalid_manifest" })
      yield* execution.run({
        jobID: legacy.id,
        manifest: (job) => SessionCompaction.Service.use((service) => service.manifest(job)),
      })
      const oversized = {
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.succeed(candidate(8_000)),
      }

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toMatchObject([
        { status: "failed", errorCode: "invalid_manifest", configDigest: legacyDigest },
        {
          status: "failed",
          errorCode: "invalid_manifest",
          configDigest: ConfigCompaction.admissionDigest(policy),
        },
      ])

      expect((yield* runGate(oversized)).compacted).toBe(false)
      expect(yield* allJobs()).toHaveLength(2)
    }),
  )

  it.effect("does not let an algorithm revision 2 failure suppress the repaired revision 3 job", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("revision_two_failure")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const revisionTwoDigest = ConfigCompaction.admissionDigest(policy, 2)
      const legacy = yield* jobs.admit(admission(fixture, { configDigest: revisionTwoDigest }))
      worker = () => new SessionCompaction.ManifestError({ code: "context_limit_unresolved" })
      yield* execution.run({
        jobID: legacy.id,
        manifest: (job) => SessionCompaction.Service.use((service) => service.manifest(job)),
      })
      worker = (db, job) => successfulManifest(db, job)

      const result = yield* runGate({
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.succeed(candidate(10)),
      })

      expect(result.compacted).toBe(true)
      expect(yield* allJobs()).toMatchObject([
        { status: "failed", errorCode: "context_limit_unresolved", configDigest: revisionTwoDigest },
        { status: "ended", configDigest: ConfigCompaction.admissionDigest(policy) },
      ])
    }),
  )

  it.effect("joins concurrent equivalent mandatory gates on one repaired job without repeating it", () =>
    Effect.gen(function* () {
      const fixture = yield* setup("concurrent_repaired_revision")
      const jobs = yield* SessionCompactionJob.Service
      const execution = yield* SessionCompactionExecution.Service
      const revisionTwoDigest = ConfigCompaction.admissionDigest(policy, 2)
      const legacy = yield* jobs.admit(admission(fixture, { configDigest: revisionTwoDigest }))
      worker = () => new SessionCompaction.ManifestError({ code: "context_limit_unresolved" })
      yield* execution.run({
        jobID: legacy.id,
        manifest: (job) => SessionCompaction.Service.use((service) => service.manifest(job)),
      })
      let calls = 0
      worker = (db, job) => {
        calls += 1
        return successfulManifest(db, job)
      }
      const oversized = {
        fixture,
        candidate: candidate(8_000),
        reload: () => Effect.succeed(candidate(10)),
      }

      const results = yield* Effect.all([runGate(oversized), runGate(oversized)], { concurrency: "unbounded" })

      expect(results.every((result) => result.compacted)).toBe(true)
      expect(calls).toBe(2)
      expect(yield* allJobs()).toMatchObject([
        { status: "failed", errorCode: "context_limit_unresolved", configDigest: revisionTwoDigest },
        { status: "ended", configDigest: ConfigCompaction.admissionDigest(policy) },
        { status: "ended", configDigest: ConfigCompaction.admissionDigest(policy) },
      ])
    }),
  )
})

type Candidate = {
  readonly context: { readonly revision: number }
  readonly prepared: { readonly request: LLMRequest }
}

function candidate(chars: number): Candidate {
  return {
    context: { revision: 0 },
    prepared: { request: LLM.request({ model, messages: [Message.user("x".repeat(chars))] }) },
  }
}

const runGate = (input: {
  readonly fixture: Effect.Success<ReturnType<typeof setup>>
  readonly candidate: Candidate
  readonly policy?: ConfigCompaction.Resolved
  readonly capabilities?: {
    readonly contextWindowTokens: number
    readonly maxOutputTokens: number
    readonly contextSafetyMarginTokens: number
  }
  readonly lastProviderInputTokens?: number
  readonly reload: (fullRebase: boolean) => Effect.Effect<Candidate>
}) =>
  Effect.gen(function* () {
    const execution = yield* SessionCompactionExecution.Service
    return yield* ensureWithinLimit({
      sessionID: input.fixture.sessionID,
      policy: input.policy ?? policy,
      capabilities: input.capabilities ?? {
        contextWindowTokens: 1_000,
        maxOutputTokens: 100,
        contextSafetyMarginTokens: 100,
      },
      candidate: input.candidate,
      ...(input.lastProviderInputTokens === undefined ? {} : { lastProviderInputTokens: input.lastProviderInputTokens }),
      reload: ({ fullRebase }) => input.reload(fullRebase),
    }).pipe(SessionCompactionExecution.bind(execution))
  })

const setup = Effect.fnUntraced(function* (name: string, complete = true) {
  worker = (db, job) => successfulManifest(db, job)
  const db = (yield* Database.Service).db
  const sessionID = SessionSchema.ID.make(`ses_context_cap_${name}`)
  const boundary = {
    messageID: SessionMessage.ID.make(`msg_context_cap_${name}`),
    seq: 1,
  }
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
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.User.make({
      id: boundary.messageID,
      type: "user",
      text: "boundary",
      time: {
        created: DateTime.makeUnsafe(1),
        ...(complete ? { consumed: DateTime.makeUnsafe(1) } : {}),
      },
    }),
  )
  const { id, type, ...data } = encoded
  yield* db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: sessionID,
      type,
      seq: boundary.seq,
      time_created: 1,
      time_updated: 1,
      data,
    })
    .run()
    .pipe(Effect.orDie)
  return { sessionID, boundary }
})

function admission(
  fixture: Effect.Success<ReturnType<typeof setup>>,
  overrides?: Partial<SessionCompactionJob.AdmitInput>,
): SessionCompactionJob.AdmitInput {
  return {
    sessionID: fixture.sessionID,
    trigger: "mandatory",
    requestedThrough: fixture.boundary,
    baseContextRevision: 0,
    targetMaxInputTokens: 400,
    configDigest: ConfigCompaction.admissionDigest(policy),
    ...overrides,
  }
}

const successfulManifest = Effect.fnUntraced(function* (db: Database.Interface["db"], job: SessionCompactionJob.Job) {
  const capture = yield* SessionLiveState.captureDatabase(db, job.sessionID).pipe(Effect.orDie)
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
    inputTokens: 100,
    retainedTokens: 50,
  })
})

const allJobs = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db
  return (yield* db
    .select()
    .from(SessionCompactionJobTable)
    .orderBy(asc(SessionCompactionJobTable.time_created))
    .all()).map((row) => ({
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    baseContextRevision: row.base_context_revision,
    targetMaxInputTokens: row.target_max_input_tokens,
    configDigest: row.config_digest,
    errorCode: row.error_code,
  }))
})
