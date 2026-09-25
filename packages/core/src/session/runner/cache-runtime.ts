export * as SessionCacheRuntime from "./cache-runtime"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionSchema } from "../schema"

export interface GenerationInput {
  readonly sessionID: SessionSchema.ID
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly routeID: string
  readonly apiModelID: string
  readonly systemDigest: string
  readonly toolDigest: string
  readonly baselineKey: string
  readonly now?: number
}

export interface Interface {
  readonly generation: (input: GenerationInput) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionCacheRuntime") {}

export const layer = Layer.succeed(Service, Service.of({ generation: () => Effect.succeed(0) }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
