export * as SessionGuardrailCounter from "./guardrail-counter"

import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Deferred, Duration, Effect, Option, Schema } from "effect"

export type Kind = "shell" | "subagent" | "review"

export interface Limits {
  readonly shells: number
  readonly subagents: number
  readonly reviews: number
}

export interface Reservation {
  readonly release: Effect.Effect<void>
}

export interface ReserveOptions {
  readonly holder?: string
  readonly wait?: Duration.Input
}

export class CapExceededError extends Schema.TaggedErrorClass<CapExceededError>()("Guardrail.CapExceededError", {
  rootSessionID: Session.ID,
  counter: Schema.Literals(["shells", "subagents", "reviews"]),
  current: Schema.Int,
  limit: Schema.Int,
  holders: Schema.Array(Schema.String),
  waitedMs: Schema.Int,
}) {
  override get message() {
    const capacity = capacities[this.counter]
    const holders = this.holders.length === 0 ? "" : ` (${this.holders.join(", ")})`
    const waited = this.waitedMs === 0 ? "" : `; waited ${Math.round(this.waitedMs / 1000)}s`
    return `${capacity.subject} limit reached: ${this.current}/${this.limit} ${this.counter} ${capacity.state} in this session family${holders}${waited}. Wait for or stop a ${capacity.state} ${capacity.item}, or raise guardrails.${capacity.setting}.`
  }
}

const capacities = {
  shells: { subject: "Shell", state: "running", item: "shell", setting: "max_concurrent_shells" },
  subagents: { subject: "Subagent", state: "running", item: "subagent", setting: "max_concurrent_subagents" },
  reviews: { subject: "Pending review", state: "pending", item: "review", setting: "max_pending_reviews" },
}

export interface Interface {
  readonly reserve: (
    rootSessionID: Session.ID,
    kind: Kind,
    options?: ReserveOptions,
  ) => Effect.Effect<Reservation, CapExceededError>
  readonly snapshot: (rootSessionID: Session.ID) => Effect.Effect<ReadonlyArray<Guardrail.Counter>>
}

interface Slot {
  readonly holder?: string
}

interface Waiter {
  readonly slot: Slot
  readonly deferred: Deferred.Deferred<void>
  granted: boolean
}

interface Pool {
  readonly slots: Slot[]
  readonly waiters: Waiter[]
}

export function make(limits: Limits): Interface {
  const pools = new Map<string, Pool>()
  const id = (rootSessionID: Session.ID, kind: Kind) => `${rootSessionID}\u0000${kind}`
  const limit = (kind: Kind) => (kind === "shell" ? limits.shells : kind === "subagent" ? limits.subagents : limits.reviews)
  const label = (kind: Kind) => ({ shell: "shells", subagent: "subagents", review: "reviews" } as const)[kind]

  const pool = (key: string) => {
    const existing = pools.get(key)
    if (existing) return existing
    const created: Pool = { slots: [], waiters: [] }
    pools.set(key, created)
    return created
  }

  const release = (key: string, slot: Slot) => {
    let released = false
    return Effect.suspend(() => {
      if (released) return Effect.void
      released = true
      const current = pool(key)
      current.slots.splice(current.slots.indexOf(slot), 1)
      const next = current.waiters.shift()
      if (!next) {
        if (current.slots.length === 0) pools.delete(key)
        return Effect.void
      }
      next.granted = true
      current.slots.push(next.slot)
      return Deferred.succeed(next.deferred, undefined).pipe(Effect.asVoid)
    })
  }

  return {
    reserve: Effect.fn("SessionGuardrailCounter.reserve")(function* (rootSessionID, kind, options) {
      const key = id(rootSessionID, kind)
      const current = pool(key)
      const slot: Slot = { holder: options?.holder }
      const exceeded = (waitedMs: number) =>
        new CapExceededError({
          rootSessionID,
          counter: label(kind),
          current: current.slots.length,
          limit: limit(kind),
          holders: current.slots.flatMap((item) => (item.holder === undefined ? [] : [item.holder])),
          waitedMs,
        })
      if (current.slots.length < limit(kind)) {
        current.slots.push(slot)
        return { release: release(key, slot) }
      }
      if (options?.wait === undefined) return yield* exceeded(0)
      const wait = Duration.fromInputUnsafe(options.wait)
      const waiter: Waiter = { slot, deferred: yield* Deferred.make<void>(), granted: false }
      current.waiters.push(waiter)
      const abandon = Effect.suspend(() => {
        if (waiter.granted) return release(key, slot)
        current.waiters.splice(current.waiters.indexOf(waiter), 1)
        if (current.slots.length === 0 && current.waiters.length === 0) pools.delete(key)
        return Effect.void
      })
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(Deferred.await(waiter.deferred).pipe(Effect.timeoutOption(wait))).pipe(
          Effect.onInterrupt(() => abandon),
          Effect.flatMap(
            Option.match({
              onNone: () => abandon.pipe(Effect.andThen(Effect.fail(exceeded(Duration.toMillis(wait))))),
              onSome: () => Effect.succeed<Reservation>({ release: release(key, slot) }),
            }),
          ),
        ),
      )
    }),
    snapshot: Effect.fn("SessionGuardrailCounter.snapshot")((rootSessionID) =>
      Effect.succeed(
        (["shell", "subagent", "review"] as const).map(
          (kind) =>
            new Guardrail.Counter({
              id: label(kind),
              current: pools.get(id(rootSessionID, kind))?.slots.length ?? 0,
              limit: limit(kind),
              scope: "family",
            }),
        ),
      ),
    ),
  }
}
