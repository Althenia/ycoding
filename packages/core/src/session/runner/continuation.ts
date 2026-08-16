export * as SessionContinuation from "./continuation"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../../effect/app-node"
import { ModelV2 } from "../../model"
import { OpenAICodex } from "../../plugin/provider/openai-codex"
import { SessionSchema } from "../schema"

export interface Fingerprint {
  readonly sessionID: SessionSchema.ID
  readonly execution: number
  readonly routeID: string
  readonly model: ModelV2.Ref
  readonly promptCacheKey: string
  readonly systemDigest: string
  readonly toolDigest: string
  readonly optionsDigest: string
}

export interface State extends Fingerprint {
  readonly responseID: string
  readonly representedMessages: number
}

export interface SelectInput extends Fingerprint {
  readonly mode: "auto" | "on" | "off"
  readonly store: boolean
}

export interface Interface {
  readonly select: (input: SelectInput) => Effect.Effect<State | undefined>
  readonly remember: (state: State) => Effect.Effect<void>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionContinuation") {}

const RESPONSE_ROUTES = new Set(["openai-responses", "openai-responses-websocket", "github-copilot-responses", OpenAICodex.routeID])
export const isResponsesRoute = (routeID: string) => RESPONSE_ROUTES.has(routeID)
const DEFAULT_CAPACITY = 1024

const sameModel = (left: ModelV2.Ref, right: ModelV2.Ref) =>
  left.providerID === right.providerID && left.id === right.id && left.variant === right.variant

const sameFingerprint = (left: Fingerprint, right: Fingerprint) =>
  left.sessionID === right.sessionID &&
  left.execution === right.execution &&
  left.routeID === right.routeID &&
  sameModel(left.model, right.model) &&
  left.promptCacheKey === right.promptCacheKey &&
  left.systemDigest === right.systemDigest &&
  left.toolDigest === right.toolDigest &&
  left.optionsDigest === right.optionsDigest

export const layer = (options: { readonly capacity?: number } = {}) =>
  Layer.effect(
    Service,
    Effect.sync(() => {
      const capacity = Math.max(1, Math.floor(options.capacity ?? DEFAULT_CAPACITY))
      const states = new Map<SessionSchema.ID, State>()
      const touch = (state: State) => {
        states.delete(state.sessionID)
        states.set(state.sessionID, state)
        while (states.size > capacity) {
          const oldest = states.keys().next().value
          if (oldest === undefined) break
          states.delete(oldest)
        }
      }
      const clear: Interface["clear"] = (sessionID) => Effect.sync(() => void states.delete(sessionID))
      const select: Interface["select"] = (input) =>
        Effect.sync(() => {
          const state = states.get(input.sessionID)
          if (input.mode === "off" || input.store !== true || !isResponsesRoute(input.routeID)) {
            states.delete(input.sessionID)
            return undefined
          }
          if (!state) return undefined
          if (!sameFingerprint(state, input)) {
            states.delete(input.sessionID)
            return undefined
          }
          touch(state)
          return state
        })
      const remember: Interface["remember"] = (state) => Effect.sync(() => void touch(state))
      return Service.of({ select, remember, clear })
    }),
  )

export const node = makeLocationNode({ service: Service, layer: layer(), deps: [] })
