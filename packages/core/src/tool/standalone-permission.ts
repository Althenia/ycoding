export * as StandalonePermission from "./standalone-permission"

import { Context, Effect, Layer } from "effect"
import { StandaloneConfig } from "../config/standalone"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { Permission } from "../permission"
import { StandalonePermissionService } from "../permission/standalone"
import { SessionErrors } from "../session/error"
import { SessionStore } from "../session/store"

export type AssertError = Permission.Error | SessionErrors.NotFoundError | SessionErrors.ScopeUnavailableError | StandaloneConfig.InvalidError
export interface Interface {
  readonly assert: (input: Permission.AssertInput) => Effect.Effect<void, AssertError>
}
export interface Scoped extends Interface {
  readonly check: (input: Permission.AssertInput, generation: number) => Effect.Effect<void, SessionErrors.ScopeUnavailableError | StandaloneConfig.InvalidError>
}
export class Service extends Context.Service<Service, Scoped>()("@ycoding/StandaloneToolPermission") {}

export const DispatchGeneration = Context.Reference<number | undefined>("@ycoding/StandaloneToolPermission/DispatchGeneration", { defaultValue: () => undefined })

export const node = makeLocationNode({
  service: Service,
  layer: Layer.effect(Service, Effect.gen(function* () {
    const permission = yield* StandalonePermissionService.Service
    const config = yield* StandaloneConfig.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const owner = (input: Permission.AssertInput) => Effect.gen(function* () {
      const session = yield* sessions.get(input.sessionID)
      if (!session || session.scope !== "standalone" || session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* new SessionErrors.ScopeUnavailableError({ operation: "standalone tool" })
    })
    const check = (input: Permission.AssertInput, generation: number) => owner(input).pipe(Effect.andThen(config.assert(generation)))
    return Service.of({ check, assert: (input) => Effect.gen(function* () {
      const generation = yield* DispatchGeneration
      if (generation === undefined) return yield* new SessionErrors.ScopeUnavailableError({ operation: "standalone tool dispatch" })
      yield* check(input, generation)
      yield* permission.assert(input)
      yield* check(input, generation)
    }) })
  })),
  deps: [StandalonePermissionService.node, StandaloneConfig.node, SessionStore.node, Location.node],
})
