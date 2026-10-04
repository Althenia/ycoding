export * as EventLogger from "./event-logger"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { EventRuntime } from "./event"

const Types = new Set([
  "agent.updated",
  "catalog.updated",
  "command.updated",
  "config.updated",
])

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const unsubscribe = yield* events.listen((event) =>
      Types.has(event.type) ? Effect.logInfo("event", { event }) : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
  }),
)

export const node = makeGlobalNode({ name: "event-logger", layer, deps: [EventRuntime.node] })
