import { describe, expect, test } from "bun:test"
import { NOTICE_WINDOW } from "../notifications"
import { enqueueToasts, groupNotifications, noticeCenterView, notificationAge, newlyAddedNotifications } from "./notifications"
import type { RemoteNotificationView } from "../notifications"

const today = new Date(2026, 8, 27, 12).getTime()
const notice = (id: string, at: number, live = true): RemoteNotificationView => ({
  id, at, synced: true, live, category: "approval-requested", title: "YCoding — needs your attention", body: "A session is waiting for you.",
  sessionID: "ses_a", sessionTitle: "Alpha",
})

describe("notification presentation", () => {
  test("groups ordered entries by calendar day without changing identity", () => {
    const entries = [notice("today", today), notice("yesterday", new Date(2026, 8, 26, 23).getTime()), notice("older", new Date(2026, 8, 20).getTime())]
    const groups = groupNotifications(entries, today)
    expect(groups.map((group) => group.label).slice(0, 2)).toEqual(["Today", "Yesterday"])
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["today"], ["yesterday"], ["older"]])
    expect(groups[1]?.items[0]).toBe(entries[1])
  })

  test("keeps notice IDs and day groups stable across re-reads and minute updates", () => {
    const entries = [notice("first", today - 3 * 60_000), notice("second", today - 8 * 60_000)]
    const before = groupNotifications(entries, today)
    const after = groupNotifications(entries, today + 60_000)
    expect(after.map((group) => group.label)).toEqual(before.map((group) => group.label))
    expect(after.flatMap((group) => group.items.map((entry) => entry.id))).toEqual(["first", "second"])
  })

  test("uses short relative labels before calendar dates and clamps future timestamps", () => {
    expect(notificationAge(today + 1000, today)).toBe("now")
    expect(notificationAge(today - 2 * 60_000, today)).toBe("2m")
    expect(notificationAge(today - 3 * 3_600_000, today)).toBe("3h")
    expect(notificationAge(today - 25 * 3_600_000, today)).not.toMatch(/^\d+[mh]$/)
  })

  test("only new IDs enter the newest-first three-toast queue", () => {
    const block = (id: string, at: number) => ({ ...notice(id, at), synced: false })
    const initial = [block("already", today)]
    const seen = new Set(initial.map((item) => item.id))
    expect(newlyAddedNotifications(seen, initial)).toEqual([])
    const added = [block("four", today + 4), block("three", today + 3), block("two", today + 2), block("one", today + 1), ...initial]
    expect(newlyAddedNotifications(seen, added).map((item) => item.id)).toEqual(["four", "three", "two", "one"])
    expect(enqueueToasts([notice("prior", today)], added.slice(0, 4)).map((item) => item.id)).toEqual(["four", "three", "two"])
    expect(enqueueToasts(added.slice(0, 3), [added[0]!]).map((item) => item.id)).toEqual(["four", "three", "two"])
  })

  test("an entry restored from a relay snapshot never enters the toast queue", () => {
    const seen = new Set<string>()
    const entries = [{ ...notice("live", today), synced: false }, { ...notice("snapshot", today - 1, false), synced: false }]
    expect(newlyAddedNotifications(seen, entries).map((item) => item.id)).toEqual(["live"])
  })

  test("only a guardrail block raised live in this page pops a toast; finished work, machine status, and relay attention stay in the center", () => {
    const entries: RemoteNotificationView[] = [
      { ...notice("guardrail-block", today), synced: false },
      { ...notice("relay-attention", today), synced: true },
      { ...notice("finished", today), category: "agent-completed", title: "YCoding — work finished", body: "A session finished all its work." },
      { ...notice("offline_dev_1_1", today), synced: false, category: "machine-offline", title: "YCoding — machine offline", body: "The connected machine stopped reporting.", sessionID: undefined },
    ]
    expect(newlyAddedNotifications(new Set(), entries).map((item) => item.id)).toEqual(["guardrail-block"])
    expect(noticeCenterView({ status: "ready", total: 2, loaded: 2, hidden: 0, loadingMore: false, message: undefined }, entries).unread).toBe(4)
  })

  test("counts every stored unread notice even when its in-app category is muted", () => {
    const sync = { status: "ready", total: 7, loaded: 3, hidden: 1, loadingMore: false, message: undefined } as const
    const local = { ...notice("local", today), synced: false }
    expect(noticeCenterView(sync, [notice("a", today), local])).toMatchObject({ unread: 8, badge: "8", label: "Notifications, 8 unread", failed: false })
    expect(noticeCenterView({ ...sync, total: 12 }, [])).toMatchObject({ unread: 12, badge: "9+" })
    expect(noticeCenterView({ ...sync, total: 0, loaded: 0, hidden: 0 }, [])).toMatchObject({ unread: 0, badge: "", label: "Notifications" })
  })

  test("offers Load more while older relay notices remain and the window has room, then states the cap", () => {
    const sync = { status: "ready", total: 90, loaded: 50, hidden: 0, loadingMore: false, message: undefined } as const
    expect(noticeCenterView(sync, [])).toMatchObject({ hasMore: true, capped: false, remaining: 40 })
    expect(noticeCenterView({ ...sync, loaded: 90 }, [])).toMatchObject({ hasMore: false, capped: false, remaining: 0 })
    expect(noticeCenterView({ ...sync, total: NOTICE_WINDOW + 5, loaded: NOTICE_WINDOW }, [])).toMatchObject({ hasMore: false, capped: true, remaining: 5 })
  })

  test("a sync error is never displayed as synced: the badge, label, and failure flag all say so", () => {
    const sync = { status: "error", total: 0, loaded: 0, hidden: 0, loadingMore: false, message: "Notifications: unavailable" } as const
    expect(noticeCenterView(sync, [])).toMatchObject({ failed: true, badge: "!", label: "Notifications, sync unavailable" })
    expect(noticeCenterView({ ...sync, total: 2, loaded: 2 }, [])).toMatchObject({ failed: true, badge: "!", label: "Notifications, 2 unread, sync unavailable" })
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
