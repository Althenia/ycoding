export * as TransportAttempt from "./attempt"

import { Cause, Effect, Exit, Stream } from "effect"

export interface Info {
  readonly requestID: string
  readonly routeID: string
  readonly transport: string
  readonly attempt: number
  readonly phase: "started" | "succeeded" | "failed"
  readonly time: number
  readonly stage?: "request" | "stream"
  readonly elapsedMs?: number
  readonly status?: number
  readonly failure?: "request" | "response-read"
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
            ...(Exit.isFailure(exit) ? { failure: "request" as const } : {}),
          }),
        ),
      ),
    ),
  )
}

export const trackStream = <A, E, R, R2>(
  input: TrackInput,
  response: Effect.Effect<{ readonly status: number; readonly stream: Stream.Stream<A, E, R> }, E, R2>,
): Stream.Stream<A, E, R | R2> => {
  if (input.observer === undefined) return Stream.unwrap(response.pipe(Effect.map((value) => value.stream)))
  const now = input.now ?? Date.now
  const startedAt = now()
  const base = {
    requestID: input.requestID,
    routeID: input.routeID,
    transport: input.transport,
    attempt: input.attempt,
  } as const
  const observed = response.pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void
      const time = now()
      return observe(input.observer, {
        ...base,
        phase: "failed",
        stage: "request",
        time,
        elapsedMs: time - startedAt,
        failure: "request",
      })
    }),
  )
  return Stream.unwrap(
    observe(input.observer, { ...base, phase: "started", stage: "request", time: startedAt }).pipe(
      Effect.andThen(observed),
      Effect.map((value) =>
        value.stream.pipe(
          Stream.onExit((exit) => {
            const time = now()
            const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
            return observe(input.observer, {
              ...base,
              phase: Exit.isSuccess(exit) || interrupted ? "succeeded" : "failed",
              stage: "stream",
              status: value.status,
              time,
              elapsedMs: time - startedAt,
              ...(Exit.isFailure(exit) && !interrupted ? { failure: "response-read" as const } : {}),
            })
          }),
        ),
      ),
    ),
  )
}
