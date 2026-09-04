export * as SessionCompactionGate from "./compaction-gate"

import type { LLMRequest } from "@ycoding-ai/ai"
import type { ID } from "@ycoding-ai/schema/session-compaction"
import { desc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { ConfigCompaction } from "../../config/compaction"
import { Database } from "../../database/database"
import { SessionCompaction } from "../compaction"
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
  // Last provider-reported input-side total (uncached input + cache read + cache
  // write) for this Session, if any. The local chars/4 estimate undercounts
  // provider-visible history (tool-result envelope stripping, tokenization drift),
  // so a provider-measured over-cap request must also trip the mandatory gate.
  readonly lastProviderInputTokens?: number
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
  ReloadError,
  Database.Service | SessionCompaction.Service | SessionCompactionJob.Service | ReloadRequirements
> =>
  Effect.gen(function* () {
    const cap = SessionContextPressure.hardInputCapTokens(input.capabilities)
    if (cap <= 0) return { ...input.candidate, compacted: false }
    const initialEstimate = estimate(input.candidate)
    const providerTotal = input.lastProviderInputTokens
    if (!input.force && initialEstimate < cap && (providerTotal === undefined || providerTotal < cap))
      return { ...input.candidate, compacted: false }

    const db = (yield* Database.Service).db
    const jobs = yield* SessionCompactionJob.Service
    const configDigest = ConfigCompaction.admissionDigest(input.policy)
    const targetMaxInputTokens = Math.floor((cap * considerPercent(input.policy)) / 100)

    const gated = yield* jobs
      .withAdmissionGate(input.sessionID, (admit) =>
        Effect.gen(function* () {
          let gateOwnedAdmissions = 0
          let compacted = false
          // Seed with the provider-measured total when it exceeds the local
          // estimate: it is the fresher over-cap evidence until a reload
          // rebuilds the candidate. Later iterations use the rebuilt estimate.
          let currentEstimate =
            providerTotal === undefined ? initialEstimate : Math.max(initialEstimate, providerTotal)
          while (true) {
            if (gateOwnedAdmissions === 2) {
              const rebuilt = yield* input.reload({ fullRebase: false })
              return { ...rebuilt, compacted }
            }
            const boundary = yield* latestCompleteBoundary(db, input.sessionID)
            if (!boundary) return { ...input.candidate, compacted }
            const revision = yield* currentRevision(db, input.sessionID)
            if (revision === undefined) return { ...input.candidate, compacted }
            const pending = yield* jobs.pending(input.sessionID)
            const existing = pending[0]
            if (existing) {
              const settled = yield* waitFor(existing.id)
              const rebuilt = yield* input.reload({ fullRebase: settled.status === "ended" })
              compacted ||= settled.status === "ended"
              currentEstimate = estimate(rebuilt)
              if (currentEstimate < cap) return { ...rebuilt, compacted }
              continue
            }
            if (
              yield* jobs.hasUnchangedDeterministicFailure({
                sessionID: input.sessionID,
                requestedThrough: boundary,
                baseContextRevision: revision,
                targetMaxInputTokens,
                configDigest,
              })
            )
              return { ...input.candidate, compacted }

            const admitted = yield* admit({
              sessionID: input.sessionID,
              trigger: "mandatory",
              requestedThrough: boundary,
              baseContextRevision: revision,
              targetMaxInputTokens,
              configDigest,
              pressure: { estimatedInputTokens: currentEstimate, safeInputTokens: cap },
            })
            gateOwnedAdmissions += 1
            const settled = yield* waitFor(admitted.id)
            const rebuilt = yield* input.reload({ fullRebase: settled.status === "ended" })
            compacted ||= settled.status === "ended"
            currentEstimate = estimate(rebuilt)
            if (currentEstimate < cap) return { ...rebuilt, compacted }
          }
        }),
      )
      .pipe(
        Effect.catchIf(
          (error): error is SessionCompactionJob.Conflict | SessionCompactionJob.Ownership =>
            error instanceof SessionCompactionJob.Conflict || error instanceof SessionCompactionJob.Ownership,
          (error) =>
            Effect.succeed({ ...input.candidate, compacted: false }),
        ),
      )
    return gated
  })

const waitFor = (jobID: ID) =>
  SessionCompactionExecution.use((execution) =>
    execution.run({
      jobID,
      manifest: (job) => SessionCompaction.Service.use((compaction) => compaction.manifest(job)),
    }),
  )

const estimate = <Context, Prepared extends { readonly request: LLMRequest }>(
  candidate: Candidate<Context, Prepared>,
) => SessionContextPressure.estimatedInputTokens(candidate.prepared.request)

const considerPercent = (policy: ConfigCompaction.Resolved) =>
  policy.advisory === false ? 70 : policy.advisory.considerPercent

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
