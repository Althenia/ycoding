import { expect, test } from "bun:test"
import { compensatesSizeChange, sameKeys, withPinnedIndex } from "./virtual-rows"

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

const row = { start: 100, end: 300, offset: 200 }

test("ordinary growth of a measured row spanning the fold leaves the reader's scroll position alone", () => {
  expect(compensatesSizeChange({ ...row, cached: true, reflow: false })).toBe(false)
})

test("a width reflow compensates every row that starts above the fold, including one spanning it", () => {
  expect(compensatesSizeChange({ ...row, cached: true, reflow: true })).toBe(true)
  expect(compensatesSizeChange({ start: 0, end: 150, offset: 200, cached: true, reflow: true })).toBe(true)
  expect(compensatesSizeChange({ start: 220, end: 400, offset: 200, cached: true, reflow: true })).toBe(false)
})

test("a measured row entirely above the fold always compensates and one below never does", () => {
  for (const reflow of [false, true]) {
    expect(compensatesSizeChange({ start: 0, end: 150, offset: 200, cached: true, reflow })).toBe(true)
    expect(compensatesSizeChange({ start: 250, end: 400, offset: 200, cached: true, reflow })).toBe(false)
  }
})

test("a first measurement compensates a row starting above the fold whatever its end", () => {
  expect(compensatesSizeChange({ ...row, cached: false, reflow: false })).toBe(true)
  expect(compensatesSizeChange({ start: 220, end: 400, offset: 200, cached: false, reflow: false })).toBe(false)
})
