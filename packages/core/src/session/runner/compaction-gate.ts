export * as SessionCompactionGate from "./compaction-gate"

import type { LLMRequest } from "@ycoding-ai/ai"
import { SessionCompaction } from "@ycoding-ai/schema/session-compaction"
import type { SessionError } from "@ycoding-ai/schema/session-error"
import { desc, eq } from "drizzle-orm"
import { Duration, Effect, Option } from "effect"
import type { ConfigCompaction } from "../../config/compaction"
import { Database } from "../../database/database"
import { Hash } from "../../util/hash"
import { SessionCompactionExecution } from "../compaction-execution"
import { SessionCompactionJob } from "../compaction-job"
import { SessionContextPressure } from "../context-pressure"
import type { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionContextStateTable, SessionMessageTable } from "../sql"

type Candidate<Context, Prepared extends { readonly request: LLMRequest }> = {
  readonly context: Context
  readonly prepared: Prepared
}

export interface Input<
  Context,
  Prepared extends { readonly request: LLMRequest },
  ReloadError = never,
  ReloadRequirements = never,
> {
  readonly sessionID: SessionSchema.ID
  readonly policy: ConfigCompaction.Resolved
  readonly capabilities: {
    readonly contextWindowTokens: number
    readonly maxOutputTokens: number
    readonly contextSafetyMarginTokens: number
  }
  readonly candidate: Candidate<Context, Prepared>
  readonly force?: boolean
  readonly reload: (options: {
    readonly fullRebase: boolean
  }) => Effect.Effect<Candidate<Context, Prepared>, ReloadError, ReloadRequirements>
}

export interface Result<Context, Prepared extends { readonly request: LLMRequest }>
  extends Candidate<Context, Prepared> {
  readonly compacted: boolean
}

/** The sole foreground compaction wait path before an ordinary provider request. */
export const ensureWithinLimit = <
  Context,
  Prepared extends { readonly request: LLMRequest },
  ReloadError,
  ReloadRequirements,
>(
  input: Input<Context, Prepared, ReloadError, ReloadRequirements>,
): Effect.Effect<
  Result<Context, Prepared>,
  SessionError.Error | ReloadError,
  Database.Service | SessionCompactionJob.Service | ReloadRequirements
> =>
  Effect.gen(function* () {
    const cap = SessionContextPressure.hardInputCapTokens(input.capabilities)
    if (cap <= 0) return yield* limit("The selected model has no positive safe input capacity")
    if (!input.force && estimate(input.candidate) < cap) return { ...input.candidate, compacted: false }

    const db = (yield* Database.Service).db
    const jobs = yield* SessionCompactionJob.Service
    const configDigest = Hash.sha256(JSON.stringify(input.policy))
    const targetMaxInputTokens = Math.floor((cap * considerPercent(input.policy)) / 100)

    const gated = yield* jobs
      .withAdmissionGate(input.sessionID, (admit) =>
        Effect.gen(function* () {
          let gateOwnedAdmissions = 0
          let compacted = false
          while (true) {
            if (gateOwnedAdmissions === 2) {
              const rebuilt = yield* input.reload({ fullRebase: false })
              if (estimate(rebuilt) < cap) return { ...rebuilt, compacted }
              return yield* limit("Context compaction could not reduce the rebuilt request below the safe input cap")
            }
            const boundary = yield* latestCompleteBoundary(db, input.sessionID)
            if (!boundary) return yield* limit("Session has no complete message boundary for mandatory compaction")
            const revision = yield* currentRevision(db, input.sessionID)
            if (revision === undefined) return yield* limit("Session has no active context revision")
            const pending = yield* jobs.pending(input.sessionID)
            const compatible = pending.find((job) =>
              isCompatible(job, {
                sessionID: input.sessionID,
                boundary,
                baseContextRevision: revision,
                targetMaxInputTokens,
                configDigest,
              }),
            )
            if (compatible) {
              const settled = yield* waitFor(input.sessionID, compatible.id)
              const rebuilt = yield* input.reload({ fullRebase: settled.status === "ended" })
              compacted ||= settled.status === "ended"
              if (estimate(rebuilt) < cap) return { ...rebuilt, compacted }
              continue
            }

            const running = pending.find((job) => job.status === "running")
            if (running) {
              const settled = yield* waitFor(input.sessionID, running.id)
              const rebuilt = yield* input.reload({ fullRebase: settled.status === "ended" })
              compacted ||= settled.status === "ended"
              if (estimate(rebuilt) < cap) return { ...rebuilt, compacted }
              continue
            }

            const admitted = yield* admit({
              sessionID: input.sessionID,
              trigger: "mandatory",
              admissionMode: "mandatory",
              requestedThrough: boundary,
              baseContextRevision: revision,
              targetMaxInputTokens,
              configDigest,
            })
            gateOwnedAdmissions += 1
            const settled = yield* waitFor(input.sessionID, admitted.id)
            const rebuilt = yield* input.reload({ fullRebase: settled.status === "ended" })
            compacted ||= settled.status === "ended"
            if (estimate(rebuilt) < cap) return { ...rebuilt, compacted }
          }
        }),
      )
      .pipe(
        Effect.catchIf(
          (error): error is SessionCompactionJob.Conflict => error instanceof SessionCompactionJob.Conflict,
          (error) => limit(`Mandatory context compaction admission failed: ${error.message}`),
        ),
        Effect.timeoutOption(Duration.seconds(61)),
      )
    if (Option.isSome(gated)) return gated.value

    const rebuilt = yield* input.reload({ fullRebase: false })
    if (estimate(rebuilt) < cap) return { ...rebuilt, compacted: false }
    return yield* limit("Mandatory context compaction exceeded the 61-second foreground deadline")
  })

const waitFor = (sessionID: SessionSchema.ID, jobID: SessionCompaction.ID) =>
  SessionCompactionExecution.use((execution) => execution.wake(sessionID).pipe(Effect.andThen(execution.wait(jobID))))

const estimate = <Context, Prepared extends { readonly request: LLMRequest }>(
  candidate: Candidate<Context, Prepared>,
) => SessionContextPressure.estimatedInputTokens(candidate.prepared.request)

const considerPercent = (policy: ConfigCompaction.Resolved) =>
  policy.advisory === false ? 70 : policy.advisory.considerPercent

const isCompatible = (
  job: SessionCompactionJob.Job,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly boundary: SessionCompaction.Boundary
    readonly baseContextRevision: number
    readonly targetMaxInputTokens: number
    readonly configDigest: string
  },
) =>
  job.sessionID === expected.sessionID &&
  job.baseContextRevision === expected.baseContextRevision &&
  job.configDigest === expected.configDigest &&
  job.requestedThrough.messageID === expected.boundary.messageID &&
  job.requestedThrough.seq === expected.boundary.seq &&
  job.targetMaxInputTokens !== undefined &&
  job.targetMaxInputTokens <= expected.targetMaxInputTokens

const latestCompleteBoundary = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      type: SessionMessageTable.type,
      data: SessionMessageTable.data,
    })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, sessionID))
    .orderBy(desc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const boundary = rows.find((row) => isComplete(row.type, row.data))
  if (!boundary) return undefined
  return { messageID: boundary.id, seq: boundary.seq }
})

const currentRevision = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const state = yield* db
    .select({ revision: SessionContextStateTable.revision })
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return state?.revision
})

function isComplete(type: SessionMessage.Type, data: unknown) {
  if (type === "user") return hasTime(data, "consumed")
  if (type === "assistant" || type === "shell") return hasTime(data, "completed")
  if (type !== "compaction") return true
  if (!isRecord(data)) return false
  return data.status === "completed" || data.status === "failed"
}

function hasTime(data: unknown, key: string) {
  return isRecord(data) && isRecord(data.time) && typeof data.time[key] === "number"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const limit = (message: string) => Effect.fail(limitError(message))

const limitError = (message: string): SessionError.Error => ({ type: "context.limit", message })
