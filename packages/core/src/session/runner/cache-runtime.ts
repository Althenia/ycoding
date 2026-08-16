export * as SessionCacheRuntime from "./cache-runtime"

import { cacheProfile } from "@ycoding-ai/ai/cache-profile"
import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../../database/database"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionSchema } from "../schema"
import { SessionProviderRequestTable } from "../sql"

export type ConfiguredTTL = "adaptive" | "5m" | "1h"

export interface PolicyInput {
  readonly sessionID: SessionSchema.ID
  readonly namespace: string
  readonly modelID: string
  readonly configured: ConfiguredTTL
  readonly now?: number
}

export interface Policy {
  readonly ttlSeconds: 300 | 3600
  readonly promoted: boolean
}

export interface Observation {
  readonly namespace: string
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly eligible: number
  readonly now?: number
}

export interface Interface {
  readonly policy: (input: PolicyInput) => Effect.Effect<Policy>
  readonly observe: (input: Observation) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCacheRuntime") {}

export interface Options {
  readonly capacity?: number
}

type State = {
  observations: number
  firstObservedAt: number
  lastObservedAt: number
  promotedUntil?: number
}

const REUSE_WINDOW_MS = 5 * 60 * 1000
const PROMOTED_RETENTION_MS = 60 * 60 * 1000
const DEFAULT_CAPACITY = 1024

export const layer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CAPACITY))
      const states = new Map<string, State>()

      const touch = (namespace: string, state: State) => {
        states.delete(namespace)
        states.set(namespace, state)
        while (states.size > capacity) {
          const oldest = states.keys().next().value
          if (oldest === undefined) break
          states.delete(oldest)
        }
      }

      const restore = (input: PolicyInput, now: number) =>
        db
          .select({ tokens: SessionProviderRequestTable.tokens, time: SessionProviderRequestTable.time_created })
          .from(SessionProviderRequestTable)
          .where(
            and(
              eq(SessionProviderRequestTable.session_id, input.sessionID),
              eq(SessionProviderRequestTable.prompt_cache_key, input.namespace),
            ),
          )
          .orderBy(asc(SessionProviderRequestTable.request))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => restoreState(rows, now)),
          )

      const policy: Interface["policy"] = (input) =>
        Effect.gen(function* () {
          const extended = cacheProfile(input.modelID)?.extendedTtl === true
          if (input.configured === "1h")
            return extended ? { ttlSeconds: 3600, promoted: true } : { ttlSeconds: 300, promoted: false }
          if (input.configured === "5m") return { ttlSeconds: 300, promoted: false }
          if (!extended) return { ttlSeconds: 300, promoted: false }
          const now = input.now ?? Date.now()
          const cached = states.get(input.namespace)
          const state =
            !cached || (cached.observations === 0 && now - cached.lastObservedAt > REUSE_WINDOW_MS)
              ? yield* restore(input, now)
              : cached
          if (!state) {
            touch(input.namespace, { observations: 0, firstObservedAt: now, lastObservedAt: now })
            return { ttlSeconds: 300, promoted: false }
          }
          if (state.promotedUntil !== undefined && now <= state.promotedUntil) {
            touch(input.namespace, state)
            return extended ? { ttlSeconds: 3600, promoted: true } : { ttlSeconds: 300, promoted: false }
          }
          if (now - state.lastObservedAt > REUSE_WINDOW_MS) {
            states.delete(input.namespace)
            return { ttlSeconds: 300, promoted: false }
          }
          touch(input.namespace, state)
          return { ttlSeconds: 300, promoted: false }
        })

      const observe: Interface["observe"] = (input) =>
        Effect.sync(() => {
          const now = input.now ?? Date.now()
          if (input.eligible <= 0 || (input.cacheRead <= 0 && input.cacheWrite <= 0)) return
          const current = states.get(input.namespace)
          if (current?.promotedUntil !== undefined && now <= current.promotedUntil) {
            touch(input.namespace, { ...current, lastObservedAt: now, promotedUntil: now + PROMOTED_RETENTION_MS })
            return
          }
          const observed =
            current && now - current.lastObservedAt <= REUSE_WINDOW_MS
              ? { ...current, observations: current.observations + 1, lastObservedAt: now }
              : { observations: 1, firstObservedAt: now, lastObservedAt: now }
          const state =
            observed.observations >= 2 ? { ...observed, promotedUntil: now + PROMOTED_RETENTION_MS } : observed
          touch(input.namespace, state)
        })

      return Service.of({ policy, observe })
    }),
  )

export const node = makeGlobalNode({ service: Service, layer: layer(), deps: [Database.node] })

function restoreState(
  rows: ReadonlyArray<{
    readonly tokens: { readonly cache: { readonly read: number; readonly write: number } }
    readonly time: number
  }>,
  now: number,
): State | undefined {
  const reusable = rows.filter((row) => row.tokens.cache.read > 0 || row.tokens.cache.write > 0)
  const state = reusable.reduce<State | undefined>((current, row) => {
    if (
      !current ||
      (current.promotedUntil === undefined && row.time - current.lastObservedAt > REUSE_WINDOW_MS) ||
      (current.promotedUntil !== undefined && row.time > current.promotedUntil)
    )
      return { observations: 1, firstObservedAt: row.time, lastObservedAt: row.time }
    if (current.promotedUntil !== undefined)
      return { ...current, lastObservedAt: row.time, promotedUntil: row.time + PROMOTED_RETENTION_MS }
    const observations = current.observations + 1
    return {
      ...current,
      observations,
      lastObservedAt: row.time,
      ...(observations >= 2 ? { promotedUntil: row.time + PROMOTED_RETENTION_MS } : {}),
    }
  }, undefined)
  if (!state) return undefined
  if (state.promotedUntil !== undefined) return now <= state.promotedUntil ? state : undefined
  return now - state.lastObservedAt <= REUSE_WINDOW_MS ? state : undefined
}
