import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { SessionGuardrailCounter } from "@ycoding-ai/core/session/guardrail-counter"
import { Session } from "@ycoding-ai/schema/session"
import { it } from "./lib/effect"

const root = Session.ID.descending("ses_root")

const current = (counter: SessionGuardrailCounter.Interface) =>
  counter.snapshot(root).pipe(Effect.map((counters) => counters.find((item) => item.id === "shells")?.current))

describe("SessionGuardrailCounter", () => {
  test("enforces a family cap and releases idempotently", async () => {
    const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
    const first = await Effect.runPromise(counter.reserve(root, "shell"))
    expect(await Effect.runPromise(counter.snapshot(root))).toContainEqual({ id: "shells", current: 1, limit: 1, scope: "family" })
    await expect(Effect.runPromise(counter.reserve(root, "shell"))).rejects.toMatchObject({ _tag: "Guardrail.CapExceededError" })
    await Effect.runPromise(first.release)
    await Effect.runPromise(first.release)
    expect(await Effect.runPromise(counter.snapshot(root))).toContainEqual({ id: "shells", current: 0, limit: 1, scope: "family" })
  })

  test("names the immediate subagent limit and its setting", async () => {
    const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
    const running = await Effect.runPromise(counter.reserve(root, "subagent"))
    const error = await Effect.runPromise(counter.reserve(root, "subagent").pipe(Effect.flip))
    expect(error.message).toBe(
      "Subagent limit reached: 1/1 subagents running in this session family. Wait for or stop a running subagent, or raise guardrails.max_concurrent_subagents.",
    )
    await Effect.runPromise(running.release)
  })

  test("tracks shell, subagent, and review reservations independently", async () => {
    const counter = SessionGuardrailCounter.make({ shells: 2, subagents: 3, reviews: 4 })
    const shell = await Effect.runPromise(counter.reserve(root, "shell"))
    const subagent = await Effect.runPromise(counter.reserve(root, "subagent"))
    const review = await Effect.runPromise(counter.reserve(root, "review"))
    expect(await Effect.runPromise(counter.snapshot(root))).toEqual([
      { id: "shells", current: 1, limit: 2, scope: "family" },
      { id: "subagents", current: 1, limit: 3, scope: "family" },
      { id: "reviews", current: 1, limit: 4, scope: "family" },
    ])
    await Effect.runPromise(Effect.all([shell.release, subagent.release, review.release], { discard: true }))
  })

  it.effect("a waiting reservation takes the slot released by a running one", () =>
    Effect.gen(function* () {
      const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
      const running = yield* counter.reserve(root, "shell", { holder: "call-running" })
      const waiting = yield* counter.reserve(root, "shell", { holder: "call-waiting", wait: "60 seconds" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* running.release
      const granted = yield* Fiber.join(waiting)
      expect(yield* current(counter)).toBe(1)
      yield* granted.release
      expect(yield* current(counter)).toBe(0)
    }),
  )

  it.effect("fails with the limit and running holders after the bounded wait", () =>
    Effect.gen(function* () {
      const counter = SessionGuardrailCounter.make({ shells: 2, subagents: 1, reviews: 1 })
      yield* counter.reserve(root, "shell", { holder: "call-a" })
      yield* counter.reserve(root, "shell", { holder: "call-b" })
      const waiting = yield* counter.reserve(root, "shell", { holder: "call-c", wait: "60 seconds" })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("59 seconds")
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(waiting)
      expect(error).toMatchObject({
        _tag: "Guardrail.CapExceededError",
        counter: "shells",
        current: 2,
        limit: 2,
        holders: ["call-a", "call-b"],
        waitedMs: 60_000,
      })
      expect(error.message).toBe(
        "Shell limit reached: 2/2 shells running in this session family (call-a, call-b); waited 60s. Wait for or stop a running shell, or raise guardrails.max_concurrent_shells.",
      )
      expect(yield* current(counter)).toBe(2)
    }),
  )

  it.effect("interrupting a waiting reservation leaves no reservation behind", () =>
    Effect.gen(function* () {
      const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
      const running = yield* counter.reserve(root, "shell")
      const waiting = yield* counter.reserve(root, "shell", { wait: "60 seconds" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.interrupt(waiting)
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true)
      expect(yield* current(counter)).toBe(1)
      yield* running.release
      expect(yield* current(counter)).toBe(0)
      const next = yield* counter.reserve(root, "shell")
      expect(yield* current(counter)).toBe(1)
      yield* next.release
    }),
  )

  it.effect("a reservation granted just before an interrupt is handed to the caller, not lost", () =>
    Effect.gen(function* () {
      const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
      const running = yield* counter.reserve(root, "shell")
      const waiting = yield* counter.reserve(root, "shell", { wait: "60 seconds" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* running.release
      yield* Fiber.interrupt(waiting)
      const exit = yield* Fiber.await(waiting)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(yield* current(counter)).toBe(1)
      if (Exit.isSuccess(exit)) yield* exit.value.release
      expect(yield* current(counter)).toBe(0)
    }),
  )

  it.effect("grants released slots to waiting reservations in arrival order", () =>
    Effect.gen(function* () {
      const counter = SessionGuardrailCounter.make({ shells: 1, subagents: 1, reviews: 1 })
      const running = yield* counter.reserve(root, "shell", { holder: "call-running" })
      const first = yield* counter.reserve(root, "shell", { holder: "call-first", wait: "60 seconds" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* counter.reserve(root, "shell", { holder: "call-second", wait: "60 seconds" })
        .pipe(Effect.forkChild({ startImmediately: true }))
      const immediate = yield* counter.reserve(root, "shell").pipe(Effect.flip)
      expect(immediate).toMatchObject({ holders: ["call-running"], waitedMs: 0 })
      yield* running.release
      const firstGrant = yield* Fiber.join(first)
      expect(second.pollUnsafe()).toBeUndefined()
      yield* firstGrant.release
      const secondGrant = yield* Fiber.join(second)
      expect(yield* current(counter)).toBe(1)
      yield* secondGrant.release
      expect(yield* current(counter)).toBe(0)
    }),
  )
})
