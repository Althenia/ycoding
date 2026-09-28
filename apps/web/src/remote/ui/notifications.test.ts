import { describe, expect, test } from "bun:test"
import { enqueueToasts, groupNotifications, notificationAge, newlyAddedNotifications } from "./notifications"
import type { RemoteNotificationView } from "../notifications"

const today = new Date(2026, 8, 27, 12).getTime()
const notice = (id: string, at: number, read = false): RemoteNotificationView => ({
  id, at, read, category: "approval-requested", title: "YCoding — approval needed", body: "A session is waiting for your decision.",
  sessionID: "ses_a", sessionTitle: "Alpha",
})

describe("notification presentation", () => {
  test("groups ordered entries by calendar day without changing read state or identity", () => {
    const entries = [notice("today", today), notice("yesterday", new Date(2026, 8, 26, 23).getTime(), true), notice("older", new Date(2026, 8, 20).getTime())]
    const groups = groupNotifications(entries, today)
    expect(groups.map((group) => group.label).slice(0, 2)).toEqual(["Today", "Yesterday"])
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["today"], ["yesterday"], ["older"]])
    expect(groups[1]?.items[0]).toBe(entries[1])
  })

  test("uses short relative labels before calendar dates and clamps future timestamps", () => {
    expect(notificationAge(today + 1000, today)).toBe("now")
    expect(notificationAge(today - 2 * 60_000, today)).toBe("2m")
    expect(notificationAge(today - 3 * 3_600_000, today)).toBe("3h")
    expect(notificationAge(today - 25 * 3_600_000, today)).not.toMatch(/^\d+[mh]$/)
  })

  test("only new IDs enter the newest-first three-toast queue", () => {
    const initial = [notice("already", today)]
    const seen = new Set(initial.map((item) => item.id))
    expect(newlyAddedNotifications(seen, initial)).toEqual([])
    const added = [notice("four", today + 4), notice("three", today + 3), notice("two", today + 2), notice("one", today + 1), ...initial]
    expect(newlyAddedNotifications(seen, added).map((item) => item.id)).toEqual(["four", "three", "two", "one"])
    expect(enqueueToasts([notice("prior", today)], added.slice(0, 4)).map((item) => item.id)).toEqual(["four", "three", "two"])
    expect(enqueueToasts(added.slice(0, 3), [added[0]!]).map((item) => item.id)).toEqual(["four", "three", "two"])
  })

  test("reduces notification motion through the global reduced-motion rule", async () => {
    const css = await Bun.file(new URL("./notifications.css", import.meta.url)).text()
    const base = await Bun.file(new URL("../../styles/base.css", import.meta.url)).text()
    expect(css).not.toContain("prefers-reduced-motion")
    const reduced = base.slice(base.indexOf("@media (prefers-reduced-motion: reduce)"))
    expect(reduced).toContain("animation-name: none !important")
    expect(reduced).toContain("transition-duration: 0s !important")
  })
})
