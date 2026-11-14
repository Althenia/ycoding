import { describe, expect, test } from "bun:test"
import type { SessionView } from "../projection"
import type { SessionInfoView } from "../store"
import { groupRailSessions, reconcilePresence, sessionFilterCounts, sessionRowSignal, settlePresence, transcriptContextMessages } from "./shell-model"

const session = (patch: Partial<SessionInfoView> = {}): SessionInfoView => ({
  id: "ses_a",
  title: "Stream remote output safely",
  updatedAt: 1_700_000_000_000,
  archived: false,
  ...patch,
})

const view = (patch: Partial<SessionView> = {}): SessionView => ({
  id: "ses_a",
  status: "idle",
  messages: [],
  requests: [],
  unhandledEvents: 0,
  ...patch,
})

describe("rail Session row signal", () => {
  test("marks a busy Session as running with a text alternative", () => {
    expect(sessionRowSignal(session({ running: true }), undefined)).toEqual({ kind: "running", label: "Running" })
  })

  test("prefers waiting over running when a human is needed", () => {
    expect(sessionRowSignal(session({ running: true, attention: true }), undefined)).toEqual({ kind: "waiting", label: "Waiting for you" })
    expect(sessionRowSignal(session(), view({ requests: [{ kind: "permission", id: "per_1", action: "shell", resources: ["bun test"], askedAt: 0 }] }))).toEqual({ kind: "waiting", label: "Waiting for approval" })
  })

  test("marks a failure-only Session as failed and an idle Session with no status", () => {
    expect(sessionRowSignal(session({ failed: true }), undefined)).toEqual({ kind: "failed", label: "Failed" })
    expect(sessionRowSignal(session(), undefined)).toEqual({ kind: "idle" })
  })
})

describe("rail Session filters and workspace groups", () => {
  const waiting = session({ id: "ses_wait", attention: true, running: true })
  const running = session({ id: "ses_run", running: true })
  const idle = session({ id: "ses_idle" })
  const failed = session({ id: "ses_failed", failed: true })

  test("counts every status when all Sessions are loaded, counting a waiting runner only as waiting", () => {
    expect(sessionFilterCounts([waiting, running, idle, failed], undefined, "all")).toEqual({ all: 4, waiting: 1, running: 1, idle: 2 })
    expect(sessionFilterCounts([], undefined, "all")).toEqual({ all: 0, waiting: 0, running: 0, idle: 0 })
  })

  test("treats a Session with a pending request in the loaded view as waiting", () => {
    expect(sessionFilterCounts([idle], view({ id: "ses_idle", requests: [{ kind: "permission", id: "per_1", action: "shell", resources: ["bun test"], askedAt: 0 }] }), "all")).toEqual({ all: 1, waiting: 1, running: 0, idle: 0 })
  })

  test("reports only the active filter's count when the device already filtered the list", () => {
    expect(sessionFilterCounts([running, running], undefined, "running")).toEqual({ running: 2 })
    expect(sessionFilterCounts([], undefined, "waiting")).toEqual({ waiting: 0 })
  })

  test("groups Sessions under their workspace folder in first-seen order and keeps row order", () => {
    const groups = groupRailSessions([
      session({ id: "a", directory: "/work/ycoding" }),
      session({ id: "b", directory: "/work/relay/" }),
      session({ id: "c", directory: "/work/ycoding" }),
      session({ id: "d", projectID: "prj_only" }),
    ])
    expect(groups.map((group) => [group.label, group.sessions.map((item) => item.id)])).toEqual([["ycoding", ["a", "c"]], ["relay", ["b"]], ["prj_only", ["d"]]])
    expect(groupRailSessions([])).toEqual([])
  })
})

describe("transcript context messages", () => {
  test("lists loaded user and assistant turns with a one-line excerpt and skips other entries", () => {
    expect(transcriptContextMessages([
      { kind: "user", id: "msg_u", text: "Fix the\n  header", state: "consumed", created: 1 },
      { kind: "assistant", id: "msg_a", agent: "build", parts: [{ kind: "reasoning", ordinal: 0, text: "hidden" }, { kind: "text", ordinal: 1, text: "Moved both" }, { kind: "text", ordinal: 2, text: "into one row." }], created: 2 },
      { kind: "assistant", id: "msg_b", parts: [], created: 3 },
      { kind: "system", id: "msg_s", text: "Notice", created: 4 },
    ])).toEqual([
      { id: "msg_u", role: "User", summary: "Fix the header" },
      { id: "msg_a", role: "build", summary: "Moved both into one row." },
      { id: "msg_b", role: "Assistant", summary: "No text" },
    ])
  })

  test("shortens a long excerpt to 96 characters ending in an ellipsis", () => {
    const [entry] = transcriptContextMessages([{ kind: "user", id: "msg_long", text: "x".repeat(120), state: "consumed", created: 1 }])
    expect(entry?.summary).toBe(`${"x".repeat(95)}…`)
    expect(entry?.summary.length).toBe(96)
  })
})

describe("request card presence", () => {
  const item = (id: string, text = id) => ({ id, text })
  const ids = (entries: readonly { readonly item: { readonly id: string }; readonly open: boolean }[]) => entries.map((entry) => `${entry.item.id}:${entry.open ? "open" : "closing"}`)

  test("keeps a resolved card closing in its place until its exit settles", () => {
    const shown = reconcilePresence([], [item("a"), item("b")], (entry) => entry.id)
    const resolved = reconcilePresence(shown, [item("a")], (entry) => entry.id)
    expect(ids(resolved)).toEqual(["a:open", "b:closing"])
    expect(ids(settlePresence(resolved, "b"))).toEqual(["a:open"])
  })

  test("reopens a closing card that returns and adds new cards open", () => {
    const closing = reconcilePresence(reconcilePresence([], [item("a"), item("b")], (entry) => entry.id), [item("a")], (entry) => entry.id)
    expect(ids(reconcilePresence(closing, [item("a"), item("b")], (entry) => entry.id))).toEqual(["a:open", "b:open"])
    expect(ids(reconcilePresence(closing, [item("a"), item("c")], (entry) => entry.id))).toEqual(["a:open", "b:closing", "c:open"])
  })

  test("never settles an open card and carries the latest payload while open", () => {
    const shown = reconcilePresence([], [item("a", "first")], (entry) => entry.id)
    expect(ids(settlePresence(shown, "a"))).toEqual(["a:open"])
    expect(reconcilePresence(shown, [item("a", "second")], (entry) => entry.id)[0]?.item.text).toBe("second")
  })
})
