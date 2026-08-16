import { expect, test } from "bun:test"
import {
  DEFAULT_COMPACTION_CONSTRAINT_MAX_BYTES,
  assembleCompactionConstraints,
} from "@ycoding-ai/core/session/compaction-constraints"

const bytes = (parts: readonly string[]) => new TextEncoder().encode(parts.join("")).byteLength

test("keeps complete ordered constraint blocks within the aggregate budget", () => {
  expect(assembleCompactionConstraints(["agent rules", "project rules"], 1_000)).toEqual([
    "agent rules",
    "project rules",
  ])
})

test("omits whole blocks with a deterministic digest notice", () => {
  const first = "first constraint"
  const oversized = "x".repeat(1_000)
  const result = assembleCompactionConstraints([first, oversized], 256)

  expect(result[0]).toBe(first)
  expect(result.join("\n")).not.toContain(oversized.slice(0, 100))
  expect(result.at(-1)).toMatch(/Omitted 1 compaction constraint block.*sha256=[0-9a-f]{64}/)
  expect(bytes(result)).toBeLessThanOrEqual(256)
})

test("changes the omission digest when hidden constraint content changes", () => {
  const first = assembleCompactionConstraints(["x".repeat(1_000)], 256)
  const second = assembleCompactionConstraints(["y".repeat(1_000)], 256)

  expect(first).not.toEqual(second)
})

test("publishes a bounded default aggregate budget", () => {
  expect(DEFAULT_COMPACTION_CONSTRAINT_MAX_BYTES).toBe(32 * 1024)
})
