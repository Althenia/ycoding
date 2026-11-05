export * as StandaloneDecision from "./standalone"

import { Context, Effect, Layer } from "effect"
import { StandaloneConfig } from "../config/standalone"
import { Decision } from "../decision"
import { StandaloneDecisionAgent } from "../decision-agent/standalone"
import { makeLocationNode } from "../effect/app-node"

export class Service extends Context.Service<Service, Decision.Interface<StandaloneConfig.InvalidError>>()("@ycoding/Decision.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    return yield* Decision.make(yield* StandaloneDecisionAgent.Service)
  })),
  deps: [StandaloneDecisionAgent.node],
})
