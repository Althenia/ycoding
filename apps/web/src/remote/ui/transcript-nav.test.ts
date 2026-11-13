import { expect, test } from "bun:test"
import { estimateRowHeight, rowKey } from "./transcript-nav"
import { followState, navigationTargets, pillClearance, promptPreview, promptTicks, promptsInView, sameSet } from "./transcript-rail"

test("follows only near the end, yields to user scroll, and resets for another Session", () => {
  expect(followState(true, { kind: "scroll", distance: 48 })).toBe(true)
  expect(followState(true, { kind: "scroll", distance: 49 })).toBe(false)
  expect(followState(false, { kind: "content", distance: 0 })).toBe(false)
  expect(followState(false, { kind: "scroll", distance: 20 })).toBe(false)
  expect(followState(false, { kind: "scroll", distance: 1 })).toBe(true)
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

test("reserves a turn head's height for unmeasured user and assistant rows", () => {
  expect(estimateRowHeight({ kind: "user", id: "u", text: "", state: "consumed", created: 1 })).toBeGreaterThanOrEqual(64)
  expect(estimateRowHeight({ kind: "assistant", id: "a", parts: [], created: 1 })).toBeGreaterThanOrEqual(176)
})

test("ticks only user prompts, in order, from any row shape", () => {
  const rows = [{ id: "a", kind: "user", text: "first" }, { id: "b", kind: "assistant", text: "reply" }, { id: "c", kind: "compaction", text: "" }, { id: "d", kind: "user", text: "second" }]
  const pick = (row: (typeof rows)[number]) => row.kind === "user" ? { id: row.id, text: row.text } : undefined
  expect(promptTicks(rows, pick)).toEqual([{ id: "a", text: "first" }, { id: "d", text: "second" }])
  expect(promptTicks([], pick)).toEqual([])
  expect(promptTicks(rows.filter((row) => row.kind !== "user"), pick)).toEqual([])
})

test("marks as active exactly the prompts that intersect the scroll viewport", () => {
  const viewport = { top: 100, bottom: 500 }
  const prompts = [{ id: "above", top: 0, bottom: 100 }, { id: "clipTop", top: 50, bottom: 101 }, { id: "inside", top: 200, bottom: 260 }, { id: "clipBottom", top: 499, bottom: 700 }, { id: "below", top: 500, bottom: 560 }]
  expect([...promptsInView(viewport, prompts)]).toEqual(["clipTop", "inside", "clipBottom"])
  expect(promptsInView(viewport, []).size).toBe(0)
  expect(sameSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true)
  expect(sameSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false)
  expect(sameSet(new Set(["a", "c"]), new Set(["a", "b"]))).toBe(false)
})

test("shows the jump pill only when the transcript is scrolled or not following, and hides it when everything fits", () => {
  expect(navigationTargets(8, true)).toEqual({ top: false, bottom: false })
  expect(navigationTargets(9, true)).toEqual({ top: true, bottom: false })
  expect(navigationTargets(0, false)).toEqual({ top: false, bottom: true })
  let following = true
  for (const distance of [0, 48, 49, 20, 2, 1]) {
    following = followState(following, { kind: "scroll", distance })
  }
  expect(following).toBe(true)
  following = followState(true, { kind: "scroll", distance: 49 })
  expect(following).toBe(false)
  expect(followState(following, { kind: "scroll", distance: 48 })).toBe(false)
  expect(followState(following, { kind: "scroll", distance: 1 })).toBe(true)
})

test("lifts the jump pill above the nearest overlapping control and leaves it in place otherwise", () => {
  const pill = { left: 700, width: 80, bottom: 500, height: 44, gap: 8 }
  expect(pillClearance(pill, [])).toBe(0)
  expect(pillClearance(pill, [{ left: 0, right: 600, top: 480, bottom: 520 }])).toBe(0)
  expect(pillClearance(pill, [{ left: 650, right: 720, top: 480, bottom: 520 }])).toBe(28)
  expect(pillClearance(pill, [{ left: 650, right: 720, top: 600, bottom: 640 }])).toBe(0)
})
