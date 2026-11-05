export * as StandalonePermissionService from "./standalone"

import { Context, Effect, Layer } from "effect"
import { StandaloneConfig } from "../config/standalone"
import { CoordinationService } from "../coordination/index"
import { Database } from "../database/database"
import { StandaloneDecision } from "../decision/standalone"
import { makeLocationNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { Location } from "../location"
import { Permission } from "../permission"
import { PermissionSaved } from "./saved"
import { PermissionSession } from "./session"
import { StandaloneAgent } from "../plugin/standalone-agent"
import { SessionAutonomy } from "../session/autonomy"
import { SessionStore } from "../session/store"

export class Service extends Context.Service<Service, Permission.Interface<StandaloneConfig.InvalidError>>()("@ycoding/Permission.Standalone") {}

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const config = yield* StandaloneConfig.Service
    const agents = yield* StandaloneAgent.Service
    return yield* Permission.make({
      entries: () => config.snapshot().pipe(Effect.map((snapshot) => snapshot.entries)),
      capture: () => Effect.gen(function* () {
        const generation = yield* agents.refresh()
        yield* config.assert(generation)
        return config.assert(generation)
      }),
    }, yield* StandaloneDecision.Service)
  })),
  deps: [EventRuntime.node, Database.node, StandaloneConfig.node, Location.node, StandaloneDecision.node, StandaloneAgent.node, SessionAutonomy.node, SessionStore.node, PermissionSaved.node, PermissionSession.node, CoordinationService.node],
})
