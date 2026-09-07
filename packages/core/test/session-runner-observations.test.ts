import { expect, test } from "bun:test"
import { contextObservationBatches } from "@ycoding-ai/core/session/runner/llm"

test("bounds context-observation provenance lookups below SQLite's bind cap", () => {
  const batches = contextObservationBatches(Array.from({ length: 501 }, (_, index) => index))

  expect(batches).toHaveLength(2)
  expect(batches.map((batch) => batch.length)).toEqual([500, 1])
  expect(batches.flat()).toEqual(Array.from({ length: 501 }, (_, index) => index))
})
