export * as SessionProviderRequest from "./provider-request"

import { randomUUID } from "node:crypto"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Money } from "@ycoding-ai/schema/money"
import { Model } from "@ycoding-ai/schema/model"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { TransportAttempt } from "@ycoding-ai/ai/route"
import { and, asc, desc, eq, gt } from "drizzle-orm"
import { Cause, Context, Data, DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { ProviderRequestObserver } from "./provider-request-observer"
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
  readonly invalidation?: ProviderRequest.Invalidation
  readonly continuation: ProviderRequest.Continuation
  readonly cacheReadReported?: boolean
  readonly cost?: Money.USD
  readonly tokens: TokenUsage.Info
}

export interface Tracker {
  readonly requestID: string
  readonly defaultInvalidation: ProviderRequest.Invalidation
  readonly observeAttempt: TransportAttempt.Observer
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
  readonly summary: (sessionID: ProviderRequest.Record["sessionID"]) => Effect.Effect<ProviderRequest.Summary>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionProviderRequest") {}

type Pending = {
  readonly input: BeginInput
  readonly request: number
  readonly defaultInvalidation: ProviderRequest.Invalidation
  attempts: number
  completed: boolean
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

type CostedRecord = ProviderRequest.Record & { readonly costProvenance?: ProviderRequest.CostProvenance }

export function summarize(records: readonly CostedRecord[]): ProviderRequest.Summary {
  const models = new Map<
    string,
    {
      model: ProviderRequest.Record["model"]
      requests: number
      tokens: TokenUsage.Info
      priced: boolean
      cost: Money.USD
      currentCatalog: boolean
    }
  >()
  for (const record of records) {
    const key = JSON.stringify([record.model.providerID, record.model.id, record.model.variant])
    const current = models.get(key)
    if (!current) {
      models.set(key, {
        model: record.model,
        requests: 1,
        tokens: record.tokens,
        priced: record.cost !== undefined,
        cost: record.cost ?? Money.USD.zero,
        currentCatalog: record.costProvenance === "current_catalog",
      })
      continue
    }
    current.requests += 1
    current.tokens = addTokens(current.tokens, record.tokens)
    current.priced &&= record.cost !== undefined
    current.cost = Money.USD.make(current.cost + (record.cost ?? 0))
    current.currentCatalog ||= record.costProvenance === "current_catalog"
  }
  const items = Array.from(models.values())
    .map((item) => ({
      model: item.model,
      requests: item.requests,
      tokens: item.tokens,
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
        (left.model.variant ?? "").localeCompare(right.model.variant ?? ""),
    )
  const cost = records.every((record) => record.cost !== undefined)
    ? Money.USD.make(records.reduce((total, record) => total + (record.cost ?? 0), 0))
    : undefined
  const latest = records.at(-1)
  return {
    logical: records.length,
    physical: records.reduce((total, record) => total + record.attempts, 0),
    helpers: records.reduce((total, record) => total + (record.source === "step" ? 0 : 1), 0),
    continued: records.reduce((total, record) => total + (record.continuation === "continued" ? 1 : 0), 0),
    fallback: records.reduce((total, record) => total + (record.continuation === "fallback" ? 1 : 0), 0),
    ...(cost === undefined ? {} : { cost }),
    ...(items.length === 0 ? {} : { models: items }),
    tokens: records.reduce((total, record) => addTokens(total, record.tokens), zeroTokens()),
    ...(latest === undefined
      ? {}
      : { latestInvalidation: latest.invalidation, latestNamespace: latest.promptCacheKey.slice(0, 8) }),
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
  if (previous.model && (previous.model.variant ?? "default") !== (input.model.variant ?? "default"))
    return "model-variant-switched"
  if (previous.promptCacheKey === input.promptCacheKey) return "provider-not-reported"
  if (previous.systemDigest !== input.systemDigest) return "system-prefix-changed"
  if (previous.toolDigest !== input.toolDigest) return "tool-prefix-changed"
  return "prefix-changed"
}

const rowRecord = (row: typeof SessionProviderRequestTable.$inferSelect): ProviderRequest.Record => ({
  id: row.id,
  sessionID: row.session_id,
  ...(row.input_id === null ? {} : { inputID: row.input_id }),
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
  ...(row.cost === null ? {} : { cost: Money.USD.make(row.cost) }),
  tokens: row.tokens,
  time: DateTime.makeUnsafe(row.time_created),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const lock = Semaphore.makeUnsafe(1)
    const pending = new Map<string, Pending>()

    const observeAttempt: TransportAttempt.Observer = (info) =>
      Effect.sync(() => {
        if (info.phase !== "started") return
        const current = pending.get(info.requestID)
        if (current && !current.completed) current.attempts += 1
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
              (left.model.variant ?? "").localeCompare(right.model.variant ?? ""),
          )
        const cost = rows.every((row) => row.cost !== null)
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
            : { latestInvalidation: last.invalidation, latestNamespace: last.promptCacheKey.slice(0, 8) }),
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
                    yield* events.publish(SessionEvent.ProviderRequestRecorded, {
                      id: requestID,
                      sessionID: input.sessionID,
                      inputID: input.inputID,
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
                      ...(completion.cacheReadReported === undefined ? {} : { cacheReadReported: completion.cacheReadReported }),
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
              complete,
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))) as unknown as Interface["next"]

    return Service.of({ next, observeAttempt, list, summary })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})
