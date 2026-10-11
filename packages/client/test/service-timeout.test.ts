import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, FileSystem } from "effect"
import { TestClock } from "effect/testing"
import { ensure } from "../src/effect/service"

test("effect startup has an absolute two-minute deadline even when registration reading stalls", async () => {
  let released = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ensure({ command: [] }).pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    released = true
                  }),
                ),
              ),
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      try {
        yield* TestClock.adjust("119999 millis")
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(released).toBe(false)
        yield* TestClock.adjust("1 millis")
        const result = fiber.pollUnsafe()
        expect(result).toBeDefined()
        if (result === undefined || Exit.isSuccess(result)) throw new Error("Expected startup deadline failure")
        expect(Cause.prettyErrors(result.cause).map((error) => error.message)).toContain(
          "Timed out waiting for the background service to start",
        )
        expect(released).toBe(true)
      } finally {
        yield* Fiber.interrupt(fiber)
      }
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test("effect startup interruption releases pending registration work without waiting for the deadline", async () => {
  let released = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* ensure({ command: [] }).pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.never.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    released = true
                  }),
                ),
              ),
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("100 millis")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
      expect(released).toBe(true)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})
