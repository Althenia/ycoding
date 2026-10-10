export * as SessionProviderRequest from "./provider-request"

import { randomUUID } from "node:crypto"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Money } from "@ycoding-ai/schema/money"
import { Model } from "@ycoding-ai/schema/model"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { TransportAttempt } from "@ycoding-ai/ai/route"
import type { LLMEvent } from "@ycoding-ai/ai"
import { and, asc, desc, eq, gt, gte, lt } from "drizzle-orm"
import { Cause, Clock, Context, Data, DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { SessionEvent } from "./event"
import { ProviderRequestObserver } from "./provider-request-observer"
import { TelemetryConsent } from "../telemetry-consent"
import { SessionCacheDiagnostics } from "./cache-diagnostics"
import {
  SessionCompactionJobTable,
  SessionContextStateTable,
  SessionProviderRequestTable,
  SessionUsageTable,
} from "./sql"

export interface BeginInput {
  readonly sessionID: ProviderRequest.Record["sessionID"]
  readonly expectedContextRevision?: number
  readonly inputID?: ProviderRequest.Record["inputID"]
  readonly assistantMessageID?: ProviderRequest.Record["assistantMessageID"]
  readonly connectionIdentityDigest?: string
  readonly source: ProviderRequest.Source
  readonly agent: ProviderRequest.Record["agent"]
  readonly model: ProviderRequest.Record["model"]
  readonly routeID: string
  readonly promptCacheKey: string
  readonly systemDigest: string
  readonly toolDigest: string
}

export class StaleContextRevision extends Data.TaggedError("SessionProviderRequest.StaleContextRevision")<{
  readonly expected: number
  readonly actual: number
}> {}

export interface CompleteInput {
  readonly assistantMessageID?: ProviderRequest.Record["assistantMessageID"]
  readonly connectionIdentityDigest?: string | null
  readonly invalidation?: ProviderRequest.Invalidation
  readonly continuation: ProviderRequest.Continuation
  readonly cacheReadReported?: boolean
  readonly timing?: ProviderRequest.Timing
  readonly cost?: Money.USD
  readonly tokens: TokenUsage.Info
}

export interface Tracker {
  readonly requestID: string
  readonly defaultInvalidation: ProviderRequest.Invalidation
  readonly observeAttempt: TransportAttempt.Observer
  readonly observeEvent: (event: LLMEvent) => Effect.Effect<void>
  readonly retryWait: () => Effect.Effect<void>
  readonly retryResume: () => Effect.Effect<void>
  readonly settle: () => Effect.Effect<void>
  readonly complete: (input: CompleteInput) => Effect.Effect<void>
}

export interface Interface {
  readonly next: {
    (input: BeginInput & { readonly expectedContextRevision: number }): Effect.Effect<Tracker, StaleContextRevision>
    (input: BeginInput): Effect.Effect<Tracker>
  }
  readonly observeAttempt: TransportAttempt.Observer
  readonly list: (
    sessionID: ProviderRequest.Record["sessionID"],
  ) => Effect.Effect<ReadonlyArray<ProviderRequest.Record>>
  readonly recentSteps: (
    sessionID: ProviderRequest.Record["sessionID"],
  ) => Effect.Effect<ReadonlyArray<ProviderRequest.Record>>
  readonly listAll: (range?: {
    readonly from?: number
    readonly to?: number
  }) => Effect.Effect<ReadonlyArray<ProviderRequest.Record>>
  readonly summary: (sessionID: ProviderRequest.Record["sessionID"]) => Effect.Effect<ProviderRequest.Summary>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionProviderRequest") {}

type Pending = {
  readonly input: BeginInput
  readonly request: number
  readonly defaultInvalidation: ProviderRequest.Invalidation
  attempts: number
  completed: boolean
  readonly started: bigint
  firstOutput?: bigint
  ended?: bigint
  waiting?: bigint
  retryWaitNs: bigint
}

type PreviousRequest = {
  readonly request: number
  readonly source: ProviderRequest.Source
  readonly model?: ProviderRequest.Record["model"]
  readonly promptCacheKey: string
  readonly systemDigest: string
  readonly toolDigest: string
  readonly timeCreated: number
}

const decodeModel = Schema.decodeUnknownOption(Model.Ref)

const zeroTokens = (): TokenUsage.Info => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const addTokens = (left: TokenUsage.Info, right: TokenUsage.Info): TokenUsage.Info => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cache: { read: left.cache.read + right.cache.read, write: left.cache.write + right.cache.write },
})

export type CostedRecord = ProviderRequest.Record & { readonly costProvenance?: ProviderRequest.CostProvenance }

export function reportSpeed(records: readonly CostedRecord[]): ProviderRequest.Speed | undefined {
  const first = records
    .flatMap((record) => (record.timing?.firstOutputMs === undefined ? [] : [record.timing.firstOutputMs]))
    .toSorted((a, b) => a - b)
  const total = records
    .flatMap((record) => (record.timing?.totalMs === undefined ? [] : [record.timing.totalMs]))
    .toSorted((a, b) => a - b)
  const generation = records.flatMap((record) => {
    const sample = SessionCacheDiagnostics.generationSample(record.timing)
    return sample === undefined ? [] : [sample]
  })
  const duration = generation.reduce((sum, sample) => sum + sample.durationNs, 0)
  if (first.length === 0 && total.length === 0 && duration === 0) return undefined
  return {
    samples: first.length,
    ...(first.length === 0
      ? {}
      : {
          firstOutputP50Ms: first[Math.ceil(first.length * 0.5) - 1]!,
          firstOutputP95Ms: first[Math.ceil(first.length * 0.95) - 1]!,
        }),
    ...(total.length === 0
      ? {}
      : {
          totalP50Ms: total[Math.ceil(total.length * 0.5) - 1]!,
          totalP95Ms: total[Math.ceil(total.length * 0.95) - 1]!,
        }),
    ...(duration === 0
      ? {}
      : {
          outputTokensPerSecond:
            generation.reduce((sum, sample) => sum + sample.tokens, 0) / (duration / 1_000_000_000),
        }),
  }
}

export function reportMetrics(records: readonly CostedRecord[]): ProviderRequest.ReportMetrics {
  const priced = records.some((record) => record.cost !== undefined)
  return {
    logical: records.length,
    physical: records.reduce((total, record) => total + record.attempts, 0),
    helpers: records.reduce((total, record) => total + (record.source === "step" ? 0 : 1), 0),
    continued: records.reduce((total, record) => total + (record.continuation === "continued" ? 1 : 0), 0),
    fallback: records.reduce((total, record) => total + (record.continuation === "fallback" ? 1 : 0), 0),
    tokens: records.reduce((total, record) => addTokens(total, record.tokens), zeroTokens()),
    ...(priced
      ? {
          cost: Money.USD.make(records.reduce((total, record) => total + (record.cost ?? 0), 0)),
          costProvenance: ProviderRequest.CostProvenance.make(
            records.some((record) => record.costProvenance === "current_catalog") ? "current_catalog" : "recorded",
          ),
        }
      : {}),
    ...(records.length === 0
      ? {}
      : { cacheReadReported: records.every((record) => record.cacheReadReported === true) }),
  }
}

export function summarize(records: readonly CostedRecord[]): ProviderRequest.Summary {
  const metrics = reportMetrics(records)
  const models = new Map<
    string,
    {
      model: ProviderRequest.Record["model"]
      requests: number
      tokens: TokenUsage.Info
      priced: boolean
      cost: Money.USD
      currentCatalog: boolean
      cacheReadReported: boolean
    }
  >()
  for (const record of records) {
    const key = JSON.stringify([record.model.providerID, record.model.id, record.model.variant, record.model.profile])
    const current = models.get(key)
    if (!current) {
      models.set(key, {
        model: record.model,
        requests: 1,
        tokens: record.tokens,
        priced: record.cost !== undefined,
        cost: record.cost ?? Money.USD.zero,
        currentCatalog: record.costProvenance === "current_catalog",
        cacheReadReported: record.cacheReadReported === true,
      })
      continue
    }
    current.requests += 1
    current.tokens = addTokens(current.tokens, record.tokens)
    current.priced ||= record.cost !== undefined
    current.cost = Money.USD.make(current.cost + (record.cost ?? 0))
    current.currentCatalog ||= record.costProvenance === "current_catalog"
    current.cacheReadReported &&= record.cacheReadReported === true
  }
  const items = Array.from(models.values())
    .map((item) => ({
      model: item.model,
      requests: item.requests,
      tokens: item.tokens,
      cacheReadReported: item.cacheReadReported,
      ...(item.priced ? { cost: item.cost } : {}),
      ...(item.priced
        ? { costProvenance: ProviderRequest.CostProvenance.make(item.currentCatalog ? "current_catalog" : "recorded") }
        : {}),
    }))
    .sort(
      (left, right) =>
        (left.cost === undefined
          ? right.cost === undefined
            ? 0
            : 1
          : right.cost === undefined
            ? -1
            : right.cost - left.cost) ||
        left.model.providerID.localeCompare(right.model.providerID) ||
        left.model.id.localeCompare(right.model.id) ||
        (left.model.variant ?? "").localeCompare(right.model.variant ?? "") ||
        (left.model.profile ?? "").localeCompare(right.model.profile ?? ""),
    )
  const latest = records.at(-1)
  return {
    logical: metrics.logical,
    physical: metrics.physical,
    helpers: metrics.helpers,
    continued: metrics.continued,
    fallback: metrics.fallback,
    ...(metrics.cacheReadReported === undefined ? {} : { cacheReadReported: metrics.cacheReadReported }),
    ...(metrics.cost === undefined ? {} : { cost: metrics.cost }),
    ...(items.length === 0 ? {} : { models: items }),
    tokens: metrics.tokens,
    ...(latest === undefined
      ? {}
      : {
          latestInvalidation: latest.invalidation,
          latestNamespace: latest.promptCacheKey.slice(0, 8),
          ...(latest.timing === undefined ? {} : { latestTiming: latest.timing }),
        }),
  }
}

function readPreviousRequest(
  row:
    | {
        readonly request: number
        readonly source: ProviderRequest.Source
        readonly model: unknown
        readonly promptCacheKey: string
        readonly systemDigest: string
        readonly toolDigest: string
        readonly timeCreated: number
      }
    | undefined,
): PreviousRequest | undefined {
  if (!row) return undefined
  return {
    ...row,
    model: Option.getOrUndefined(decodeModel(row.model)),
  }
}

function defaultInvalidation(
  previous: PreviousRequest | undefined,
  input: BeginInput,
  compactedSincePrevious: boolean,
): ProviderRequest.Invalidation {
  if (!previous) return "first-request"
  if (previous.source === "compaction" || compactedSincePrevious) return "compaction-reset"
  if (previous.model && (previous.model.providerID !== input.model.providerID || previous.model.id !== input.model.id))
    return "model-switched"
  if (previous.model && previous.model.variant !== input.model.variant) return "model-variant-switched"
  if (previous.model && previous.model.profile !== input.model.profile) return "model-switched"
  if (previous.promptCacheKey === input.promptCacheKey) return "provider-not-reported"
  if (previous.systemDigest !== input.systemDigest) return "system-prefix-changed"
  if (previous.toolDigest !== input.toolDigest) return "tool-prefix-changed"
  return "prefix-changed"
}

const rowRecord = (row: typeof SessionProviderRequestTable.$inferSelect): ProviderRequest.Record => ({
  id: row.id,
  sessionID: row.session_id,
  ...(row.input_id === null ? {} : { inputID: row.input_id }),
  ...(row.assistant_message_id === null ? {} : { assistantMessageID: row.assistant_message_id }),
  ...(row.connection_identity_digest === null ? {} : { connectionIdentityDigest: row.connection_identity_digest }),
  source: row.source,
  agent: row.agent,
  model: row.model,
  routeID: row.route_id,
  promptCacheKey: row.prompt_cache_key,
  systemDigest: row.system_digest,
  toolDigest: row.tool_digest,
  request: row.request,
  attempts: row.attempts,
  invalidation: row.invalidation,
  continuation: row.continuation,
  ...(row.cache_read_reported === null ? {} : { cacheReadReported: row.cache_read_reported }),
  ...(row.timing === null ? {} : { timing: row.timing }),
  ...(row.cost === null ? {} : { cost: Money.USD.make(row.cost) }),
  tokens: row.tokens,
  time: DateTime.makeUnsafe(row.time_created),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const consent = yield* TelemetryConsent.Service
    const lock = Semaphore.makeUnsafe(1)
    const pending = new Map<string, Pending>()

    const observeAttempt: TransportAttempt.Observer = (info) =>
      Effect.sync(() => {
        if (info.phase !== "started") return
        const current = pending.get(info.requestID)
        if (!current || current.completed) return
        current.attempts += 1
        current.ended = undefined
      })

    yield* ProviderRequestObserver.register(observeAttempt)

    const list: Interface["list"] = (sessionID) =>
      db
        .select()
        .from(SessionProviderRequestTable)
        .where(eq(SessionProviderRequestTable.session_id, sessionID))
        .orderBy(asc(SessionProviderRequestTable.request))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(rowRecord)),
        )

    const recentSteps: Interface["recentSteps"] = (sessionID) =>
      db
        .select()
        .from(SessionProviderRequestTable)
        .where(
          and(eq(SessionProviderRequestTable.session_id, sessionID), eq(SessionProviderRequestTable.source, "step")),
        )
        .orderBy(desc(SessionProviderRequestTable.request))
        .limit(8)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.toReversed().map(rowRecord)),
        )

    const listAll: Interface["listAll"] = (range) =>
      db
        .select()
        .from(SessionProviderRequestTable)
        .where(
          and(
            range?.from === undefined ? undefined : gte(SessionProviderRequestTable.time_created, range.from),
            range?.to === undefined ? undefined : lt(SessionProviderRequestTable.time_created, range.to),
          ),
        )
        .orderBy(asc(SessionProviderRequestTable.session_id), asc(SessionProviderRequestTable.request))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map(rowRecord)),
        )

    const summary: Interface["summary"] = (sessionID) =>
      Effect.gen(function* () {
        const [rows, last] = yield* Effect.all([
          db
            .select()
            .from(SessionUsageTable)
            .where(eq(SessionUsageTable.session_id, sessionID))
            .all()
            .pipe(Effect.orDie),
          db
            .select({
              invalidation: SessionProviderRequestTable.invalidation,
              promptCacheKey: SessionProviderRequestTable.prompt_cache_key,
              timing: SessionProviderRequestTable.timing,
            })
            .from(SessionProviderRequestTable)
            .where(eq(SessionProviderRequestTable.session_id, sessionID))
            .orderBy(desc(SessionProviderRequestTable.request))
            .limit(1)
            .get()
            .pipe(Effect.orDie),
        ])
        const models = rows
          .map((row) => ({
            model: row.model,
            requests: row.logical,
            tokens: {
              input: row.input,
              output: row.output,
              reasoning: row.reasoning,
              cache: { read: row.cache_read, write: row.cache_write },
            },
            ...(row.cost === null ? {} : { cost: Money.USD.make(row.cost), costProvenance: "recorded" as const }),
          }))
          .sort(
            (left, right) =>
              (left.cost === undefined
                ? right.cost === undefined
                  ? 0
                  : 1
                : right.cost === undefined
                  ? -1
                  : right.cost - left.cost) ||
              left.model.providerID.localeCompare(right.model.providerID) ||
              left.model.id.localeCompare(right.model.id) ||
              (left.model.variant ?? "").localeCompare(right.model.variant ?? "") ||
              (left.model.profile ?? "").localeCompare(right.model.profile ?? ""),
          )
        const cost = rows.some((row) => row.cost !== null)
          ? Money.USD.make(rows.reduce((total, row) => total + (row.cost ?? 0), 0))
          : undefined
        return {
          logical: rows.reduce((total, row) => total + row.logical, 0),
          physical: rows.reduce((total, row) => total + row.physical, 0),
          helpers: rows.reduce((total, row) => total + row.helpers, 0),
          continued: rows.reduce((total, row) => total + row.continued, 0),
          fallback: rows.reduce((total, row) => total + row.fallback, 0),
          ...(cost === undefined ? {} : { cost }),
          ...(models.length === 0 ? {} : { models }),
          tokens: rows.reduce(
            (total, row) =>
              addTokens(total, {
                input: row.input,
                output: row.output,
                reasoning: row.reasoning,
                cache: { read: row.cache_read, write: row.cache_write },
              }),
            zeroTokens(),
          ),
          ...(last === undefined
            ? {}
            : {
                latestInvalidation: last.invalidation,
                latestNamespace: last.promptCacheKey.slice(0, 8),
                ...(last.timing === null ? {} : { latestTiming: last.timing }),
              }),
        }
      })

    // The overload keeps helper requests infallible; only revision-bound Step ownership can be stale.
    const next = ((input: BeginInput) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const requestID = yield* db.transaction(
              () =>
                Effect.gen(function* () {
                  if (input.expectedContextRevision !== undefined) {
                    const state = yield* db
                      .select({ revision: SessionContextStateTable.revision })
                      .from(SessionContextStateTable)
                      .where(eq(SessionContextStateTable.session_id, input.sessionID))
                      .get()
                      .pipe(Effect.orDie)
                    if (!state)
                      return yield* Effect.die(new Error(`Context state not found for Session ${input.sessionID}`))
                    if (state.revision !== input.expectedContextRevision)
                      return yield* new StaleContextRevision({
                        expected: input.expectedContextRevision,
                        actual: state.revision,
                      })
                  }
                  const last = yield* db
                    .select({
                      request: SessionProviderRequestTable.request,
                      source: SessionProviderRequestTable.source,
                      model: SessionProviderRequestTable.model,
                      promptCacheKey: SessionProviderRequestTable.prompt_cache_key,
                      systemDigest: SessionProviderRequestTable.system_digest,
                      toolDigest: SessionProviderRequestTable.tool_digest,
                      timeCreated: SessionProviderRequestTable.time_created,
                    })
                    .from(SessionProviderRequestTable)
                    .where(eq(SessionProviderRequestTable.session_id, input.sessionID))
                    .orderBy(desc(SessionProviderRequestTable.request))
                    .limit(1)
                    .get()
                    .pipe(Effect.orDie)
                  const previous = readPreviousRequest(last)
                  const compactedSincePrevious =
                    previous === undefined
                      ? false
                      : (yield* db
                          .select({ id: SessionCompactionJobTable.id })
                          .from(SessionCompactionJobTable)
                          .where(
                            and(
                              eq(SessionCompactionJobTable.session_id, input.sessionID),
                              eq(SessionCompactionJobTable.status, "ended"),
                              gt(SessionCompactionJobTable.time_ended, previous.timeCreated),
                            ),
                          )
                          .orderBy(desc(SessionCompactionJobTable.time_ended))
                          .limit(1)
                          .get()
                          .pipe(Effect.orDie)) !== undefined
                  const requestID = ProviderRequest.ID.make(`prq_${randomUUID().replaceAll("-", "")}`)
                  pending.set(requestID, {
                    input,
                    request: (previous?.request ?? 0) + 1,
                    defaultInvalidation: defaultInvalidation(previous, input, compactedSincePrevious),
                    attempts: 0,
                    completed: false,
                    started: yield* Clock.currentTimeNanos,
                    retryWaitNs: 0n,
                  })
                  return requestID
                }),
              { behavior: "immediate" },
            )
            const complete: Tracker["complete"] = (completion) =>
              lock
                .withPermit(
                  Effect.gen(function* () {
                    const current = pending.get(requestID)
                    if (!current || current.completed) return
                    current.completed = true
                    const time = yield* DateTime.now
                    const now = yield* Clock.currentTimeNanos
                    const alwaysOn =
                      completion.timing === undefined
                        ? {}
                        : {
                            ...(completion.timing.promptEvalDurationNs === undefined
                              ? {}
                              : { promptEvalDurationNs: completion.timing.promptEvalDurationNs }),
                            ...(completion.timing.generationDurationNs === undefined
                              ? {}
                              : { generationDurationNs: completion.timing.generationDurationNs }),
                            ...(completion.timing.observedGenerationDurationNs === undefined
                              ? {}
                              : { observedGenerationDurationNs: completion.timing.observedGenerationDurationNs }),
                            ...(completion.timing.generatedTokens === undefined
                              ? {}
                              : { generatedTokens: completion.timing.generatedTokens }),
                            ...(completion.timing.loadDurationNs === undefined
                              ? {}
                              : { loadDurationNs: completion.timing.loadDurationNs }),
                          }
                    const millis = (duration: bigint) => Math.max(0, Number(duration / 1_000_000n))
                    const timing = {
                      ...alwaysOn,
                      ...((yield* consent.enabled())
                        ? {
                            ...(current.firstOutput === undefined
                              ? {}
                              : { firstOutputMs: millis(current.firstOutput - current.started) }),
                            totalMs: millis((current.ended ?? now) - current.started),
                            retryWaitMs: millis(
                              current.retryWaitNs + (current.waiting === undefined ? 0n : now - current.waiting),
                            ),
                          }
                        : {}),
                    }
                    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
                      id: requestID,
                      sessionID: input.sessionID,
                      inputID: input.inputID,
                      assistantMessageID: completion.assistantMessageID ?? input.assistantMessageID,
                      connectionIdentityDigest:
                        completion.connectionIdentityDigest === null
                          ? undefined
                          : (completion.connectionIdentityDigest ?? input.connectionIdentityDigest),
                      source: input.source,
                      agent: input.agent,
                      model: input.model,
                      routeID: input.routeID,
                      promptCacheKey: input.promptCacheKey,
                      systemDigest: input.systemDigest,
                      toolDigest: input.toolDigest,
                      request: current.request,
                      attempts: Math.max(1, current.attempts),
                      invalidation: completion.invalidation ?? current.defaultInvalidation,
                      continuation: completion.continuation,
                      ...(completion.cacheReadReported === undefined
                        ? {}
                        : { cacheReadReported: completion.cacheReadReported }),
                      ...(Object.keys(timing).length === 0 ? {} : { timing }),
                      ...(completion.cost === undefined ? {} : { cost: completion.cost }),
                      tokens: completion.tokens,
                      time,
                    })
                  }),
                )
                .pipe(
                  Effect.ensuring(Effect.sync(() => pending.delete(requestID))),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to record provider request", {
                      requestID,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                )
            return {
              requestID,
              defaultInvalidation: pending.get(requestID)?.defaultInvalidation ?? "first-request",
              observeAttempt,
              observeEvent: Effect.fnUntraced(function* (event) {
                const current = pending.get(requestID)
                if (!current || current.completed) return
                if (
                  current.firstOutput === undefined &&
                  (((event.type === "text-delta" ||
                    event.type === "reasoning-delta" ||
                    event.type === "tool-input-delta") &&
                    event.text.length > 0) ||
                    event.type === "tool-call")
                )
                  current.firstOutput = yield* Clock.currentTimeNanos
                if (event.type === "step-finish" || event.type === "finish")
                  current.ended ??= yield* Clock.currentTimeNanos
              }),
              retryWait: Effect.fnUntraced(function* () {
                const current = pending.get(requestID)
                if (current && !current.completed && current.waiting === undefined)
                  current.waiting = yield* Clock.currentTimeNanos
              }),
              retryResume: Effect.fnUntraced(function* () {
                const current = pending.get(requestID)
                if (!current || current.completed || current.waiting === undefined) return
                current.retryWaitNs += (yield* Clock.currentTimeNanos) - current.waiting
                current.waiting = undefined
              }),
              settle: Effect.fnUntraced(function* () {
                const current = pending.get(requestID)
                if (current && !current.completed) current.ended ??= yield* Clock.currentTimeNanos
              }),
              complete,
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))) as unknown as Interface["next"]

    return Service.of({ next, observeAttempt, list, recentSteps, listAll, summary })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventRuntime.node, TelemetryConsent.node],
})
