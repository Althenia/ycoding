import { expect, test } from "bun:test"
import { followState, promptPreview } from "./transcript-nav"

test("follows only near the end, yields to user scroll, and resets for another Session", () => {
  expect(followState(true, { kind: "scroll", distance: 48 })).toBe(true)
  expect(followState(true, { kind: "scroll", distance: 49 })).toBe(false)
  expect(followState(false, { kind: "content", distance: 0 })).toBe(false)
  expect(followState(false, { kind: "scroll", distance: 20 })).toBe(true)
  expect(followState(false, { kind: "jump", distance: 400 })).toBe(true)
  expect(followState(false, { kind: "session", distance: 400 })).toBe(true)
})

test("bounds prompt previews and normalizes line breaks for the rail", () => {
  expect(promptPreview("First line\nSecond line")).toBe("First line Second line")
  expect(promptPreview("  A ".repeat(30)).length).toBeLessThanOrEqual(90)
})
