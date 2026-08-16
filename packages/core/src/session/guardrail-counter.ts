export * as SessionGuardrailCounter from "./guardrail-counter"

import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Effect, Schema } from "effect"

export type Kind = "shell" | "subagent" | "review"

export interface Limits {
  readonly shells: number
  readonly subagents: number
  readonly reviews: number
}

export interface Reservation {
  readonly release: Effect.Effect<void>
}

export class CapExceededError extends Schema.TaggedErrorClass<CapExceededError>()("Guardrail.CapExceededError", {
  rootSessionID: Session.ID,
  counter: Schema.String,
  current: Schema.Int,
  limit: Schema.Int,
}) {}

export interface Interface {
  readonly reserve: (rootSessionID: Session.ID, kind: Kind) => Effect.Effect<Reservation, CapExceededError>
  readonly snapshot: (rootSessionID: Session.ID) => Effect.Effect<ReadonlyArray<Guardrail.Counter>>
}

export function make(limits: Limits): Interface {
  const counts = new Map<string, number>()
  const id = (rootSessionID: Session.ID, kind: Kind) => `${rootSessionID}\u0000${kind}`
  const limit = (kind: Kind) => (kind === "shell" ? limits.shells : kind === "subagent" ? limits.subagents : limits.reviews)
  const label = (kind: Kind) => (kind === "shell" ? "shells" : kind === "subagent" ? "subagents" : "reviews")

  return {
    reserve: Effect.fn("SessionGuardrailCounter.reserve")(function* (rootSessionID, kind) {
      const key = id(rootSessionID, kind)
      const current = counts.get(key) ?? 0
      const maximum = limit(kind)
      if (current >= maximum)
        return yield* new CapExceededError({
          rootSessionID,
          counter: label(kind),
          current,
          limit: maximum,
        })
      counts.set(key, current + 1)
      let released = false
      return {
        release: Effect.sync(() => {
          if (released) return
          released = true
          const next = Math.max((counts.get(key) ?? 1) - 1, 0)
          if (next === 0) counts.delete(key)
          else counts.set(key, next)
        }),
      }
    }),
    snapshot: Effect.fn("SessionGuardrailCounter.snapshot")((rootSessionID) =>
      Effect.succeed(
        (["shell", "subagent", "review"] as const).map(
          (kind) =>
            new Guardrail.Counter({
              id: label(kind),
              current: counts.get(id(rootSessionID, kind)) ?? 0,
              limit: limit(kind),
              scope: "family",
            }),
        ),
      ),
    ),
  }
}
