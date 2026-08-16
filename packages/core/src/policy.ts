export * as Policy from "./policy"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { Wildcard } from "./util/wildcard"

const Decision = Schema.Literals(["allow", "deny"]).annotate({ identifier: "Policy.Effect" })
export { Decision as Effect }
export type Effect = typeof Decision.Type

export class Info extends Schema.Class<Info>("Policy.Info")({
  action: Schema.String,
  effect: Decision,
  resource: Schema.String,
}) {}

export interface Interface {
  readonly load: (statements: readonly Info[]) => Effect.Effect<void>
  readonly evaluate: (action: string, resource: string, fallback: Effect) => Effect.Effect<Effect>
  readonly hasStatements: () => boolean
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/Policy") {}

export const make = (): Interface => {
  let statements: readonly Info[] = []
  return Service.of({
    load: Effect.fn("Policy.load")(function* (input) {
      statements = input
    }),
    hasStatements: () => statements.length > 0,
    evaluate: Effect.fn("Policy.evaluate")(function* (action, resource, fallback) {
      return (
        statements.findLast(
          (statement) => Wildcard.match(action, statement.action) && Wildcard.match(resource, statement.resource),
        )?.effect ?? fallback
      )
    }),
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    yield* Location.Service
    return make()
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [Location.node] })
