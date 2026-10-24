export * as CoordinationDecisionRuntime from "./decisions"

import { Clock, Effect, Layer } from "effect"
import { CoordinationService } from "./index"
import { CoordinationSettings } from "../coordination-settings"
import { Node, makeGlobalNode } from "../effect/app-node"
import { Form } from "../form"
import { LocationServiceMap } from "../location-service-map"
import type { Location } from "../location"
import { Permission } from "../permission"
import { CoordinationDecisions } from "../session/coordination-decisions"
import { SessionGuardrail } from "../session/guardrail"
import { SessionStore } from "../session/store"

export const layerWith = (getLocation: (location: Location.Ref) => Layer.Layer<Permission.Service | Form.Service | SessionGuardrail.Service>) =>
  Layer.effect(CoordinationDecisions.Service, Effect.gen(function* () {
    const coordination = yield* CoordinationService.Service
    const settings = yield* CoordinationSettings.Service
    const store = yield* SessionStore.Service
    const inLocation = <A>(input: Pick<CoordinationDecisions.EvaluateInput, "groupID" | "targetSessionID">, run: (service: CoordinationDecisions.Interface) => Effect.Effect<A>) => Effect.gen(function* () {
      const target = yield* store.get(input.targetSessionID)
      if (target === undefined) return yield* Effect.die(new Error("Coordination target Session is unavailable"))
      return yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        const form = yield* Form.Service
        const guardrail = yield* SessionGuardrail.Service
        return yield* run(CoordinationDecisions.make({
          policy: settings.read,
          scopeOf: coordination.scopeOf,
          permission,
          form,
          guardrail,
          now: Clock.currentTimeMillis,
        }))
      }).pipe(Effect.provide(getLocation(target.location)), Effect.orDie)
    })
    return CoordinationDecisions.Service.of({
      pending: (input) => inLocation(input, (service) => service.pending(input)),
      evaluate: (input) => inLocation(input, (service) => service.evaluate(input)),
      escalate: (input) => inLocation(input, (service) => service.escalate(input)),
    })
  }))

export const node: Node.GlobalNode<CoordinationDecisions.Service> = makeGlobalNode({
  service: CoordinationDecisions.Service,
  layer: Layer.unwrap(Effect.map(LocationServiceMap.Service, (locations) => layerWith(locations.get))),
  deps: [CoordinationService.node, CoordinationSettings.node, SessionStore.node, LocationServiceMap.node],
})
