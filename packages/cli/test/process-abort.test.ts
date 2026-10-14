import { expect, test } from "bun:test"
import { Effect } from "effect"
import { getEventListeners } from "node:events"
import { waitForAbort } from "../src/util/process"

test("authorization cancellation handles an already-aborted signal", async () => {
  const signal = AbortSignal.abort("cancelled")
  await expect(Effect.runPromise(waitForAbort(signal))).rejects.toThrow("Aborted")
  expect(getEventListeners(signal, "abort")).toHaveLength(0)
})

test("authorization cancellation settles on abort and releases its listener", async () => {
  const controller = new AbortController()
  const pending = Effect.runPromise(waitForAbort(controller.signal))
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
  controller.abort()
  await expect(pending).rejects.toThrow("Aborted")
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

test("interrupting the authorization waiter releases its signal listener", async () => {
  const controller = new AbortController()
  const interrupt = new AbortController()
  const pending = Effect.runPromise(waitForAbort(controller.signal), { signal: interrupt.signal })
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
  interrupt.abort()
  await expect(pending).rejects.toBeDefined()
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})
