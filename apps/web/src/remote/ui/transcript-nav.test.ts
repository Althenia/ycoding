import { expect, test } from "bun:test"
import { estimateRowHeight, followState, navigationTargets, promptPreview, rowKey } from "./transcript-nav"

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

test("keys a compaction row by its job so the row keeps its identity when the message ID appears", () => {
  expect(rowKey({ kind: "compaction", id: "msg_compact", jobID: "cmp_1", status: "completed", created: 1 })).toBe("cmp_1")
  expect(rowKey({ kind: "compaction", id: "cmp_live", jobID: "", status: "running", created: 1 })).toBe("cmp_live")
  expect(rowKey({ kind: "user", id: "msg_1", text: "", state: "consumed", created: 1 })).toBe("msg_1")
})

test("estimates rows so the compaction divider keeps its reserved height before measurement", () => {
  expect(estimateRowHeight({ kind: "compaction", id: "cmp_live", jobID: "cmp_live", status: "running", created: 1 })).toBeGreaterThanOrEqual(196)
  expect(estimateRowHeight(undefined)).toBeGreaterThan(0)
})
