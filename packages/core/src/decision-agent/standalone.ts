export * as StandaloneDecisionAgent from "./standalone"

import { Context, Effect, Layer } from "effect"
import { StandaloneConfig } from "../config/standalone"
import { Database } from "../database/database"
import { DecisionAgent } from "../decision-agent"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { StandaloneHelperPolicy } from "../session/standalone-helper-policy"
import { SessionProviderRequest } from "../session/provider-request"
import { SessionStore } from "../session/store"

export class Service extends Context.Service<Service, DecisionAgent.Interface<StandaloneConfig.InvalidError>>()("@ycoding/DecisionAgent.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const helpers = yield* StandaloneHelperPolicy.Service
    const config = yield* StandaloneConfig.Service
    const agents = yield* StandaloneAgent.Service
    return yield* DecisionAgent.make(helpers, () => Effect.gen(function* () {
      const generation = yield* agents.refresh()
      const snapshot = yield* config.snapshot()
      if (generation !== snapshot.generation) return yield* new StandaloneConfig.InvalidError({ reason: "stale" })
      return { entries: snapshot.entries, revision: snapshot.generation, assert: () => config.assert(snapshot.generation) }
    }))
  })),
  deps: [StandaloneAgent.node, StandaloneHelperPolicy.node, SessionStore.node, StandaloneConfig.node, SessionProviderRequest.node, EventRuntime.node, Database.node, llmClient],
})
