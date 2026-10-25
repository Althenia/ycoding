import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { SessionStepBoundary } from "../src/session/step-boundary"
import { Session } from "../src/session"
import { it } from "./lib/effect"

it.effect("Step selection waits for the complete Step and cancellation leaves no late mutation", () => Effect.gen(function* () {
  const gate = SessionStepBoundary.make()
  const id = Session.ID.make("ses_boundary")
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const changes: string[] = []
  const step = yield* gate.withStep(id, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  const switcher = yield* gate.withStep(id, Effect.sync(() => changes.push("changed"))).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  expect(changes).toEqual([])
  yield* Fiber.interrupt(switcher)
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(step)
  yield* gate.withStep(id, Effect.sync(() => changes.push("next")))
  expect(changes).toEqual(["next"])
}))

it.effect("different Sessions retain independent Step gates", () => Effect.gen(function* () {
  const gate = SessionStepBoundary.make()
  const entered = yield* Deferred.make<void>()
  const held = yield* gate.withStep(Session.ID.make("ses_first"), Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  expect(yield* gate.withStep(Session.ID.make("ses_second"), Effect.succeed("independent"))).toBe("independent")
  yield* Fiber.interrupt(held)
}))

it.effect("selection preparation reserves the next Step and releases it on cancellation", () => Effect.gen(function* () {
  const gate = SessionStepBoundary.make()
  const id = Session.ID.make("ses_preparing")
  const preparing = yield* Deferred.make<void>()
  const calls: string[] = []
  const selection = yield* gate.withSelection(id, Deferred.succeed(preparing, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild)
  yield* Deferred.await(preparing)
  const next = yield* gate.withStep(id, Effect.sync(() => calls.push("next"))).pipe(Effect.forkChild)
  yield* Effect.yieldNow
  expect(calls).toEqual([])
  yield* Fiber.interrupt(selection)
  yield* Fiber.join(next)
  expect(calls).toEqual(["next"])
}))
