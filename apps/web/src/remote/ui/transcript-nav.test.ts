import { expect, test } from "bun:test"
import { followState, navigationTargets, promptPreview } from "./transcript-nav"

test("follows only near the end, yields to user scroll, and resets for another Session", () => {
  expect(followState(true, { kind: "scroll", distance: 48 })).toBe(true)
  expect(followState(true, { kind: "scroll", distance: 49 })).toBe(false)
  expect(followState(false, { kind: "content", distance: 0 })).toBe(false)
  expect(followState(false, { kind: "scroll", distance: 20 })).toBe(true)
  expect(followState(false, { kind: "jump", distance: 400 })).toBe(true)
  expect(followState(false, { kind: "session", distance: 400 })).toBe(true)
  expect(followState(true, { kind: "top", distance: 0 })).toBe(false)
  expect(navigationTargets(0, true)).toEqual({ top: false, bottom: false })
  expect(navigationTargets(0, false)).toEqual({ top: false, bottom: true })
  expect(navigationTargets(100, false)).toEqual({ top: true, bottom: true })
  expect(navigationTargets(100, true)).toEqual({ top: true, bottom: false })
})

test("bounds prompt previews and normalizes line breaks for the rail", () => {
  expect(promptPreview("First line\nSecond line")).toBe("First line Second line")
  expect(promptPreview("  A ".repeat(30)).length).toBeLessThanOrEqual(90)
})

test("uses a grid item for cross-browser user-bubble end alignment", async () => {
  expect(await Bun.file(new URL("./transcript-nav.css", import.meta.url)).text()).toMatch(/\.transcript-navigation__item\s*\{[^}]*display:\s*grid/)
})
