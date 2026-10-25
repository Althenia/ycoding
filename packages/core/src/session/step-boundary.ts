export * as SessionStepBoundary from "./step-boundary"

import { Context, Deferred, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import type { SessionSchema } from "./schema"

export const make = () => {
  const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
  const selections = new Map<SessionSchema.ID, { users: number; settled: Deferred.Deferred<void> }>()
  const withStep = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const pending = selections.get(sessionID)
      if (pending) return Deferred.await(pending.settled).pipe(Effect.andThen(withStep(sessionID, effect)))
      return locks.withLock(sessionID)(Effect.suspend(() => selections.has(sessionID)
        ? Effect.succeed(undefined)
        : effect.pipe(Effect.map(value => ({ value }))))).pipe(
        Effect.flatMap(result => result === undefined ? withStep(sessionID, effect) : Effect.succeed(result.value)),
      )
    })
  return {
    withStep,
    atBoundary: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => locks.withLock(sessionID)(effect),
    withSelection: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => Effect.suspend(() => {
      const entry = selections.get(sessionID) ?? { users: 0, settled: Deferred.makeUnsafe<void>() }
      entry.users++
      selections.set(sessionID, entry)
      return effect.pipe(Effect.ensuring(Effect.gen(function* () {
        entry.users--
        if (entry.users !== 0) return
        selections.delete(sessionID)
        yield* Deferred.succeed(entry.settled, undefined)
      })))
    }),
  }
}

export class Service extends Context.Service<Service, ReturnType<typeof make>>()("@ycoding/SessionStepBoundary") {}

export const node = makeGlobalNode({ service: Service, layer: Layer.sync(Service, make), deps: [] })
