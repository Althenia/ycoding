export * as TransportAttempt from "./attempt"

import { Cause, Effect, Exit } from "effect"

export interface Info {
  readonly requestID: string
  readonly routeID: string
  readonly transport: string
  readonly attempt: number
  readonly phase: "started" | "succeeded" | "failed"
  readonly time: number
  readonly status?: number
  readonly error?: string
}

export type Observer = (info: Info) => Effect.Effect<void, never>

export interface TrackInput {
  readonly requestID: string
  readonly routeID: string
  readonly transport: string
  readonly attempt: number
  readonly observer?: Observer
  readonly now?: () => number
}

const observe = (observer: Observer | undefined, info: Info) =>
  observer === undefined ? Effect.void : observer(info).pipe(Effect.catchCause(() => Effect.void))

export const track = <A, E, R>(input: TrackInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
  if (input.observer === undefined) return effect
  const now = input.now ?? Date.now
  const base = {
    requestID: input.requestID,
    routeID: input.routeID,
    transport: input.transport,
    attempt: input.attempt,
  } as const
  return observe(input.observer, { ...base, phase: "started", time: now() }).pipe(
    Effect.andThen(
      effect.pipe(
        Effect.onExit((exit) =>
          observe(input.observer, {
            ...base,
            phase: Exit.isSuccess(exit) ? "succeeded" : "failed",
            time: now(),
            ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
          }),
        ),
      ),
    ),
  )
}
