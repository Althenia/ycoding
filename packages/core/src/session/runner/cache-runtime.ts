export * as SessionCacheRuntime from "./cache-runtime"

import { cacheProfile } from "@ycoding-ai/ai/cache-profile"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export type ConfiguredTTL = "adaptive" | "5m" | "1h"

export interface PolicyInput {
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
}

const REUSE_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_CAPACITY = 1024

export const layer = (options: Options = {}) =>
  Layer.succeed(
    Service,
    Service.of(
      (() => {
        const capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CAPACITY))
        const states = new Map<string, State>()

        const touch = (namespace: string, state: State) => {
          states.delete(namespace)
          states.set(namespace, state)
          while (states.size > capacity) states.delete(states.keys().next().value as string)
        }

        const policy: Interface["policy"] = (input) =>
          Effect.sync(() => {
            const extended = cacheProfile(input.modelID)?.extendedTtl === true
            if (input.configured === "1h")
              return extended ? { ttlSeconds: 3600, promoted: true } : { ttlSeconds: 300, promoted: false }
            if (input.configured === "5m") return { ttlSeconds: 300, promoted: false }
            const now = input.now ?? Date.now()
            const state = states.get(input.namespace)
            if (!state) return { ttlSeconds: 300, promoted: false }
            if (now - state.lastObservedAt > REUSE_WINDOW_MS) {
              states.delete(input.namespace)
              return { ttlSeconds: 300, promoted: false }
            }
            touch(input.namespace, state)
            return extended && state.observations >= 2
              ? { ttlSeconds: 3600, promoted: true }
              : { ttlSeconds: 300, promoted: false }
          })

        const observe: Interface["observe"] = (input) =>
          Effect.sync(() => {
            const now = input.now ?? Date.now()
            const reusable = input.eligible > 0 && (input.cacheRead > 0 || input.cacheWrite > 0)
            if (!reusable) {
              states.delete(input.namespace)
              return
            }
            const current = states.get(input.namespace)
            const state =
              current && now - current.lastObservedAt <= REUSE_WINDOW_MS
                ? { ...current, observations: current.observations + 1, lastObservedAt: now }
                : { observations: 1, firstObservedAt: now, lastObservedAt: now }
            touch(input.namespace, state)
          })

        return { policy, observe }
      })(),
    ),
  )

export const node = makeGlobalNode({ service: Service, layer: layer(), deps: [] })
