export * as PermissionSession from "./session"

import { Context, Effect, Layer, Schema } from "effect"
import { Permission } from "@ycoding-ai/schema/permission"
import { Session } from "@ycoding-ai/schema/session"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { SessionEvent } from "../session/event"

type Input = { readonly sessionID: Session.ID; readonly action: string }

export interface Interface {
  readonly rules: (input: Input) => Effect.Effect<Permission.Ruleset>
  readonly remember: (input: Input & { readonly resources: ReadonlyArray<string> }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/PermissionSession") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const events = yield* EventRuntime.Service
  const grants = new Map<Session.ID, Permission.Ruleset>()
  const stop = yield* events.listen((event) => {
    if (event.type !== SessionEvent.Deleted.type || !Schema.is(SessionEvent.Deleted.data)(event.data))
      return Effect.void
    const sessionID = event.data.sessionID
    return Effect.sync(() => { grants.delete(sessionID) })
  })
  yield* Effect.addFinalizer(() => stop)
  return Service.of({
    rules: (input) => Effect.sync(() => (grants.get(input.sessionID) ?? []).filter((rule) => rule.action === input.action)),
    remember: (input) => Effect.sync(() => {
      const current = grants.get(input.sessionID) ?? []
      const added = input.resources.filter((resource) => !current.some((rule) => rule.action === input.action && rule.resource === resource))
      grants.set(input.sessionID, [...current, ...added.map((resource): Permission.Rule => ({ action: input.action, resource, effect: "allow" }))])
    }),
  })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [EventRuntime.node] })
