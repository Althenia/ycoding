export * as BrowserAdmission from "./admission"

import { SessionID } from "@ycoding-ai/schema/session-id"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"

export type Mode = "selected" | "isolated"

export interface Interface {
  readonly current: (sessionID: SessionID) => Mode | undefined
  readonly claim: (sessionID: SessionID, mode: Mode) => boolean
  readonly release: (sessionID: SessionID, mode: Mode) => void
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/BrowserAdmission") {}

export const layer = Layer.sync(Service, () => {
  const modes = new Map<SessionID, Mode>()
  return Service.of({
    current: (sessionID) => modes.get(sessionID),
    claim: (sessionID, mode) => {
      const current = modes.get(sessionID)
      if (current !== undefined && current !== mode) return false
      modes.set(sessionID, mode)
      return true
    },
    release: (sessionID, mode) => {
      if (modes.get(sessionID) === mode) modes.delete(sessionID)
    },
  })
})

export class CoordinatorService extends Context.Service<CoordinatorService, Interface>()(
  "@ycoding/v2/BrowserAdmissionCoordinator",
) {}

const coordinatorLayer = Layer.effect(
  CoordinatorService,
  Effect.map(Service, (admission) => CoordinatorService.of(admission)),
).pipe(Layer.provide(layer))

export const coordinatorNode = makeGlobalNode({ service: CoordinatorService, layer: coordinatorLayer, deps: [] })

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.map(CoordinatorService, (admission) => Service.of(admission)),
  ),
  deps: [coordinatorNode],
})
