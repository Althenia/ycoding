export * as InteractionRuntime from "./index"

import { Interaction } from "@ycoding-ai/schema/interaction"
export { Interaction } from "@ycoding-ai/schema/interaction"
import { SessionEvent } from "@ycoding-ai/schema/session-event"
import { Context, Effect, Layer, Stream } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { SessionStore } from "../session/store"
import { makeAuthority } from "./authority"

export class Service extends Context.Service<Service, ReturnType<typeof makeAuthority>>()("@ycoding/Interaction") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const sessions = yield* SessionStore.Service
  const events = yield* EventRuntime.Service
  const authority = makeAuthority({
    currentlyUsable: async (sessionID) => {
      const info = await Effect.runPromise(sessions.get(sessionID))
      return info?.scope === "bound" && info.time.archived === undefined
    },
    changed: (sessionID, generation) => { Effect.runFork(events.publish(Interaction.Changed, { sessionID, generation })) },
  })
  yield* Effect.addFinalizer(() => Effect.sync(authority.shutdown))
  yield* events.subscribe([SessionEvent.Moved, SessionEvent.Deleted, SessionEvent.Archived]).pipe(
    Stream.runForEach((event) => Effect.sync(() => authority.revoke(event.data.sessionID))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return authority
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [SessionStore.node, EventRuntime.node] })
