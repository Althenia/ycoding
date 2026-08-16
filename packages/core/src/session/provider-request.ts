export * as SessionProviderRequest from "./provider-request"

import { randomUUID } from "node:crypto"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Money } from "@ycoding-ai/schema/money"
import type { TokenUsage } from "@ycoding-ai/schema/token-usage"
import type { TransportAttempt } from "@ycoding-ai/ai/route"
import { asc, desc, eq } from "drizzle-orm"
import { Cause, Context, DateTime, Effect, Layer, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { ProviderRequestObserver } from "./provider-request-observer"
import { SessionProviderRequestTable } from "./sql"

export interface BeginInput {
  readonly sessionID: ProviderRequest.Record["sessionID"]
  readonly inputID?: ProviderRequest.Record["inputID"]
  readonly source: ProviderRequest.Source
  readonly agent: ProviderRequest.Record["agent"]
  readonly model: ProviderRequest.Record["model"]
  readonly routeID: string
  readonly promptCacheKey: string
  readonly systemDigest: string
  readonly toolDigest: string
}

export interface CompleteInput {
  readonly invalidation?: ProviderRequest.Invalidation
  readonly continuation: ProviderRequest.Continuation
  readonly cost?: Money.USD
  readonly tokens: TokenUsage.Info
}

export interface Tracker {
  readonly requestID: string
  readonly observeAttempt: TransportAttempt.Observer
  readonly complete: (input: CompleteInput) => Effect.Effect<void>
}

export interface Interface {
  readonly next: (input: BeginInput) => Effect.Effect<Tracker>
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

const zeroTokens = (): TokenUsage.Info => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const addTokens = (left: TokenUsage.Info, right: TokenUsage.Info): TokenUsage.Info => ({
  input: left.input + right.input,
  output: left.output + right.output,
  reasoning: left.reasoning + right.reasoning,
  cache: { read: left.cache.read + right.cache.read, write: left.cache.write + right.cache.write },
})

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
      list(sessionID).pipe(
        Effect.map((records) => {
          const last = records.at(-1)
          const cost = records.every((record) => record.cost !== undefined)
            ? Money.USD.make(records.reduce((total, record) => total + (record.cost ?? 0), 0))
            : undefined
          return {
            logical: records.length,
            physical: records.reduce((total, record) => total + record.attempts, 0),
            helpers: records.filter((record) => record.source !== "step").length,
            continued: records.filter((record) => record.continuation === "continued").length,
            fallback: records.filter((record) => record.continuation === "fallback").length,
            ...(cost === undefined ? {} : { cost }),
            tokens: records.reduce((total, record) => addTokens(total, record.tokens), zeroTokens()),
            ...(last === undefined
              ? {}
              : {
                  latestInvalidation: last.invalidation,
                  latestNamespace: last.promptCacheKey.slice(0, 8),
                }),
          }
        }),
      )

    const next: Interface["next"] = (input) =>
      lock.withPermit(
        Effect.gen(function* () {
          const last = yield* db
            .select({
              request: SessionProviderRequestTable.request,
              promptCacheKey: SessionProviderRequestTable.prompt_cache_key,
              systemDigest: SessionProviderRequestTable.system_digest,
              toolDigest: SessionProviderRequestTable.tool_digest,
            })
            .from(SessionProviderRequestTable)
            .where(eq(SessionProviderRequestTable.session_id, input.sessionID))
            .orderBy(desc(SessionProviderRequestTable.request))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          const requestID = ProviderRequest.ID.make(`prq_${randomUUID().replaceAll("-", "")}`)
          const state: Pending = {
            input,
            request: (last?.request ?? 0) + 1,
            defaultInvalidation:
              last === undefined
                ? "first-request"
                : last.promptCacheKey === input.promptCacheKey
                  ? "provider-not-reported"
                  : last.systemDigest !== input.systemDigest
                    ? "system-prefix-changed"
                    : last.toolDigest !== input.toolDigest
                      ? "tool-prefix-changed"
                      : "prefix-changed",
            attempts: 0,
            completed: false,
          }
          pending.set(requestID, state)
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
          return { requestID, observeAttempt, complete }
        }),
      )

    return Service.of({ next, observeAttempt, list, summary })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})
