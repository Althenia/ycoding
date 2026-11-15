import { expect, test } from "bun:test"
import { Cause } from "effect"
import { inspectProviderError, transportFailureReason } from "../src/provider-error"

test("bounds cyclic and oversized error graphs and ignores throwing accessors", () => {
  const graph: Record<string, unknown> = { errors: Array.from({ length: 1000 }, () => ({ code: "EPIPE" })) }
  graph.cause = graph
  Object.defineProperty(graph, "lastError", {
    get() {
      throw new Error("Synthetic accessor")
    },
  })
  const inspected = inspectProviderError(graph)
  expect(inspected.chain.length).toBeLessThanOrEqual(64)
  expect(transportFailureReason(inspected.chain)?.kind).toBe("EPIPE")
})

test("Effect interruption and aborted signals dominate nested socket evidence", () => {
  const controller = new AbortController()
  controller.abort()
  expect(inspectProviderError({ code: "ECONNRESET" }, controller.signal).cancelled).toBe(true)
  expect(inspectProviderError({ cause: Cause.interrupt(), code: "ECONNRESET" }).cancelled).toBe(true)
  expect(inspectProviderError({ signal: controller.signal, code: "ECONNRESET" }).cancelled).toBe(true)
  expect(inspectProviderError({ cause: { code: "ABORT_ERR" }, code: "ECONNRESET" }).cancelled).toBe(true)
})

test("historical RetryError cancellation still dominates its final transient failure", () => {
  const lastError = { code: "ECONNRESET" }
  expect(
    inspectProviderError({ lastError, errors: [new DOMException("Synthetic cancel", "AbortError"), lastError] })
      .cancelled,
  ).toBe(true)
})
