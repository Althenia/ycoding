import { expect, test } from "bun:test"
import { ordinarySession, projectSessionRecord, projectSessions } from "../src/sessions"
import { railGroups, sessionState } from "../src/form-rules"
import { syntheticDesktop } from "./synthetic-desktop"

const record = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, location: { directory: "/synthetic/repo" }, time: { updated: 2 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0, ...extra })
const leaked = [record("ses_helper", { agent: "compaction" }), record("ses_compaction_0123456789abcdef01234567"), record("ses_offpage", { parentID: "ses_outside_page" }), record("ses_internal", { parentID: "ses_outside_page", agent: "compaction", title: "Compaction cmp_synthetic" })]

test("bounded Session snapshots retain validated family rows while ordinary consumers exclude helpers and children without filtering titles", () => {
  const roots = [record("ses_root"), record("ses_discussion", { title: "Compaction discussion" })]
  const page = projectSessions({ data: [...roots, ...leaked], cursor: { next: "next" } }, 7)
  expect(page).toMatchObject({ revision: 7, next: "next", items: [...roots, ...leaked] })
  expect(page.items.filter(ordinarySession)).toEqual(roots)
})

test("rail groups exclude helpers and off-page children from every group and archived count while rolling child activity to roots", () => {
  const values = [...leaked, record("ses_root"), record("ses_worker", { parentID: "ses_root" }), record("ses_grandchild", { parentID: "ses_worker" }), record("ses_archive", { time: { updated: 1, archived: 3 } }), record("ses_hidden_archive", { parentID: "ses_missing", time: { updated: 1, archived: 3 } })]
  const rows = values.map(value => projectSessionRecord(value.id, value))
  for (const state of [{ busy: new Set(["ses_grandchild", "ses_helper", "ses_offpage"]), waiting: new Map<string, Set<string>>() }, { busy: new Set<string>(), waiting: new Map([["ses_worker", new Set(["review"])], ["ses_internal", new Set(["helper-review"])]]) }]) {
    const result = railGroups(rows, state)
    expect(result.groups.map(group => [group.key, group.rows.map(row => row.id)])).toEqual([[state.busy.size ? "running" : "needs", ["ses_root"]]])
    expect(result.archived).toBe(1)
  }
})

test("bounded mixed list requests preserve first search cursor background semantics and directory activity rollup", async () => {
  const owned = await syntheticDesktop(call => {
    if (call.route === "/api/session") return { data: [record(call.query.has("cursor") ? "ses_older" : "ses_root"), ...leaked], cursor: call.query.has("cursor") ? {} : { next: "next" } }
    if (call.route === "/api/session/outstanding") return { data: [], running: ["ses_root"], failed: [], lost: [] }
    if (call.route === "/api/decision") return { data: [{ sessionID: "ses_worker" }] }
    if (call.route === "/api/session/ses_worker") return { data: record("ses_worker", { parentID: "ses_root" }) }
    if (call.route === "/api/session/ses_root") return { data: record("ses_root") }
    return undefined
  })
  try {
    const first = await owned.controller.sessions({})
    const more = await owned.controller.sessions({ revision: first.revision, cursor: first.next })
    await owned.controller.sessions({ search: "synthetic" })
    expect(owned.calls.filter(call => call.route === "/api/session").map(call => Object.fromEntries(call.query))).toEqual([
      { limit: "40", background: "exclude" },
      { limit: "40", cursor: "next", background: "exclude" },
      { limit: "40", search: "synthetic", background: "exclude" },
    ])
    expect(first.items.filter(ordinarySession).map(item => item.id)).toEqual(["ses_root"])
    expect(first.items.map(item => item.id)).toEqual(["ses_root", ...leaked.map(item => item.id)])
    expect({ running: first.running, waiting: first.waiting }).toEqual({ running: ["ses_root"], waiting: ["ses_root"] })
    expect(more.items.filter(ordinarySession).map(item => item.id)).toEqual(["ses_older"])
    expect(more.items.map(item => item.id)).toEqual(["ses_older", ...leaked.map(item => item.id)])
  } finally { await owned.close() }
})

test("projected root rows use confirmed family status without requiring child rows in the rail", async () => {
  const owned = await syntheticDesktop(call => {
    if (call.route === "/api/session") return { data: [record("ses_waiting"), record("ses_running"), record("ses_idle"), ...leaked], cursor: {} }
    if (call.route === "/api/session/outstanding") return { data: [], running: ["ses_running", "ses_running_worker"], failed: [], lost: [] }
    if (call.route === "/api/decision") return { data: [{ sessionID: "ses_waiting_worker" }] }
    if (call.route === "/api/session/ses_waiting_worker") return { data: record("ses_waiting_worker", { parentID: "ses_waiting" }) }
    if (call.route === "/api/session/ses_waiting") return { data: record("ses_waiting") }
    return undefined
  })
  try {
    const page = await owned.controller.sessions({})
    const live = { busy: new Set<string>(), waiting: new Map<string, Set<string>>() }
    expect(page.items.filter(ordinarySession).map(row => row.id)).toEqual(["ses_waiting", "ses_running", "ses_idle"])
    expect(railGroups(page.items, live, page).groups.map(group => [group.key, group.rows.map(row => row.id)])).toEqual([
      ["needs", ["ses_waiting"]], ["running", ["ses_running"]], ["recent", ["ses_idle"]],
    ])
    expect(railGroups(page.items, live, page, new Map([["ses_running", "idle"]])).groups.some(group => group.key === "running")).toBe(false)
    expect(railGroups(page.items, { ...live, busy: new Set(["ses_idle"]) }, page).groups.find(group => group.key === "running")?.rows.map(row => row.id)).toEqual(["ses_idle", "ses_running"])
  } finally { await owned.close() }
})

test("root status preserves unknown reads and gives current live execution precedence over retained vectors", () => {
  const live = { busy: new Set<string>(), waiting: new Map<string, Set<string>>() }
  const snapshot = { running: ["ses_root"], waiting: ["ses_root"] }
  expect(sessionState("ses_root", live)).toBe("unknown")
  expect(sessionState("ses_root", live, { running: [] })).toBe("unknown")
  expect(sessionState("ses_root", live, { waiting: ["ses_root"] })).toBe("waiting")
  expect(sessionState("ses_root", live, { running: [], waiting: [] })).toBe("idle")
  expect(sessionState("ses_root", live, snapshot, new Map([["ses_root", "idle"]]))).toBe("idle")
  expect(sessionState("ses_root", live, snapshot, new Map([["ses_root", "failed"]]))).toBe("failed")
  expect(sessionState("ses_root", { ...live, busy: new Set(["ses_root"]) }, snapshot, new Map([["ses_root", "idle"]]))).toBe("running")
  expect(sessionState("ses_root", { busy: new Set(["ses_root"]), waiting: new Map([["ses_root", new Set(["review"])]]) }, snapshot)).toBe("waiting")
})

test("direct subagent BTW and fork records keep parent identity even when absent from ordinary lists", async () => {
  const children = [record("ses_subagent", { agent: "build", parentID: "ses_root" }), record("ses_btw", { agent: "btw", parentID: "ses_root" }), record("ses_fork", { parentID: "ses_root" })]
  const owned = await syntheticDesktop(call => {
    const found = children.find(child => call.route === `/api/session/${child.id}`)
    return found ? { data: found } : undefined
  })
  try {
    for (const child of children) {
      expect((await owned.controller.session({ sessionID: child.id })).item).toMatchObject(child)
      const page = projectSessions({ data: [child] }, owned.revision)
      expect(page.items).toMatchObject([child])
      expect(page.items.filter(ordinarySession)).toEqual([])
    }
    expect(owned.calls.map(call => call.route)).toEqual(children.map(child => `/api/session/${child.id}`))
  } finally { await owned.close() }
})
