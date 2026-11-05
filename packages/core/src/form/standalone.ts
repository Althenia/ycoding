export * as StandaloneForm from "./standalone"

import { Context, Effect, Layer } from "effect"
import { StandaloneConfig } from "../config/standalone"
import { Database } from "../database/database"
import { StandaloneDecision } from "../decision/standalone"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { Form } from "../form"
import { SessionAutonomy } from "../session/autonomy"

export class Service extends Context.Service<Service, Form.Interface<StandaloneConfig.InvalidError>>()("@ycoding/Form.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const config = yield* StandaloneConfig.Service
    return yield* Form.make({
      entries: () => config.snapshot().pipe(Effect.map((snapshot) => snapshot.entries)),
      capture: () => config.snapshot().pipe(Effect.map((snapshot) => config.assert(snapshot.generation))),
      cancelOnFailure: true,
    }, yield* StandaloneDecision.Service)
  })),
  deps: [StandaloneConfig.node, Database.node, EventRuntime.node, SessionAutonomy.node, StandaloneDecision.node],
})
