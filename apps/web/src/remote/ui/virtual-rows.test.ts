import { expect, test } from "bun:test"
import { sameKeys, withPinnedIndex } from "./virtual-rows"

test("compares row keys by order and value", () => {
  expect(sameKeys(["a", "b"], ["a", "b"])).toBe(true)
  expect(sameKeys(["a", "b"], ["b", "a"])).toBe(false)
  expect(sameKeys(["a"], ["a", "b"])).toBe(false)
})

test("keeps the focused row mounted and the mounted rows in document order", () => {
  const range = { startIndex: 20, endIndex: 24, overscan: 2, count: 100 }
  expect(withPinnedIndex(range, undefined)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26])
  expect(withPinnedIndex(range, 21)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26])
  expect(withPinnedIndex(range, 3)).toEqual([3, 18, 19, 20, 21, 22, 23, 24, 25, 26])
  expect(withPinnedIndex(range, 90)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 90])
  expect(withPinnedIndex(range, -1)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26])
  expect(withPinnedIndex(range, 100)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26])
})
