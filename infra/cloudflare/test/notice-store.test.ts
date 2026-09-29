import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { RemoteLimits } from "../../../packages/remote/src/index"
import { createNoticeStore, type NoticeEvent, type NoticeSql } from "../src/relay/notice-store"

function sqlPort(database: Database, hooks: { readonly beforeExec?: (query: string) => void } = {}): NoticeSql {
  return {
    exec: (query, ...bindings) => {
      hooks.beforeExec?.(query)
      const rows = database.prepare(query).all(...(bindings as never[]))
      return { toArray: () => rows }
    },
  }
}

const event = (index: number, category: NoticeEvent["category"] = "agent-completed"): NoticeEvent => ({
  category, sessionID: `ses_${index}`, createdAt: 1_000 + index,
})
const events = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => event(offset + index))

describe("per-notice SQLite store", () => {
  test("appends in arrival order with monotonic ids and counts every row", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    const added = store.append([event(1, "approval-requested"), event(2), event(3)])
    expect(added.total).toBe(3)
    expect(added.notices).toEqual([
      { id: "ntc_1", category: "approval-requested", sessionID: "ses_1", createdAt: 1_001 },
      { id: "ntc_2", category: "agent-completed", sessionID: "ses_2", createdAt: 1_002 },
      { id: "ntc_3", category: "agent-completed", sessionID: "ses_3", createdAt: 1_003 },
    ])
    expect(store.page().total).toBe(3)
    expect(store.append([])).toEqual({ notices: [], total: 3 })
  })

  test("retains every appended notice without eviction and never reuses an id after a read", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(1_500))
    expect(store.page().total).toBe(1_500)
    expect(store.remove([1_500]).ids).toEqual(["ntc_1500"])
    expect(store.append([event(9_999)]).notices[0]?.id).toBe("ntc_1501")
    store.clear()
    expect(store.append([event(1)]).notices[0]?.id).toBe("ntc_1502")
    expect(store.page().total).toBe(1)
  })

  test("pages newest first, ends without a cursor, and visits each notice once", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(RemoteLimits.noticePageSize * 2 + 7))
    const seen: string[] = []
    let before: number | undefined
    let pages = 0
    for (;;) {
      const page = store.page(before)
      pages += 1
      expect(page.total).toBe(RemoteLimits.noticePageSize * 2 + 7)
      expect(page.notices.length).toBeLessThanOrEqual(RemoteLimits.noticePageSize)
      seen.push(...page.notices.map((notice) => notice.id))
      if (page.next === undefined) break
      before = Number(page.next.slice(4))
    }
    expect(pages).toBe(3)
    expect(seen).toHaveLength(RemoteLimits.noticePageSize * 2 + 7)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen[0]).toBe(`ntc_${RemoteLimits.noticePageSize * 2 + 7}`)
    expect(seen.at(-1)).toBe("ntc_1")
  })

  test("a page of exactly the page size has no next cursor", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(RemoteLimits.noticePageSize))
    expect(store.page().next).toBeUndefined()
    store.append([event(99)])
    expect(store.page().next).toBe("ntc_2")
  })

  test("a cursor stays exact while newer notices arrive and older ones are read between pages", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(120))
    const first = store.page()
    store.append(events(10, 500))
    store.remove([1, 2, 3, 70])
    const second = store.page(Number(first.next?.slice(4)))
    const ids = [...first.notices, ...second.notices].map((notice) => notice.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(second.notices.map((notice) => notice.id)).not.toContain("ntc_70")
    expect(second.notices.every((notice) => Number(notice.id.slice(4)) < Number(first.next?.slice(4)))).toBe(true)
    expect(second.total).toBe(126)
  })

  test("a read removes only notices that exist, reports exactly those, and is idempotent", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(5))
    expect(store.remove([2, 4, 4, 99])).toEqual({ ids: ["ntc_2", "ntc_4"], total: 3 })
    expect(store.remove([2, 4])).toEqual({ ids: [], total: 3 })
    expect(store.page().notices.map((notice) => notice.id)).toEqual(["ntc_5", "ntc_3", "ntc_1"])
  })

  test("a read of a full batch stays inside the bound-parameter limit", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    store.append(events(RemoteLimits.maxNoticeBatch + 20))
    const ids = Array.from({ length: RemoteLimits.maxNoticeBatch }, (_, index) => index + 1)
    expect(store.remove(ids).ids).toHaveLength(RemoteLimits.maxNoticeBatch)
    expect(store.page().total).toBe(20)
  })

  test("clear removes every notice at once and an empty store reads empty", () => {
    const store = createNoticeStore(sqlPort(new Database(":memory:")))
    expect(store.page()).toEqual({ notices: [], total: 0 })
    store.append(events(300))
    store.clear()
    expect(store.page()).toEqual({ notices: [], total: 0 })
  })

  test("a failed append leaves stored notices intact and the count re-derived from storage", () => {
    const database = new Database(":memory:")
    let failNext = false
    const store = createNoticeStore(sqlPort(database, { beforeExec: (query) => {
      if (failNext && query.startsWith("INSERT")) {
        failNext = false
        throw new Error("database or disk is full: SQLITE_FULL")
      }
    } }))
    store.append(events(4))
    failNext = true
    expect(() => store.append(events(3, 10))).toThrow("SQLITE_FULL")
    expect(store.page().total).toBe(4)
    expect(store.page().notices).toHaveLength(4)
    expect(store.append([event(20)]).notices[0]?.id).toBe("ntc_5")
    expect(store.page().total).toBe(5)
  })

  test("a fresh store over existing rows keeps them and derives the count from storage", () => {
    const database = new Database(":memory:")
    createNoticeStore(sqlPort(database)).append(events(6))
    const reopened = createNoticeStore(sqlPort(database))
    expect(reopened.page().total).toBe(6)
    expect(reopened.append([event(7)]).notices[0]?.id).toBe("ntc_7")
  })
})
