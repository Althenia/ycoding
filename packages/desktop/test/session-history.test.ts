import { expect, test } from "bun:test"
import type { YCodingEvent } from "@ycoding-ai/client"
import type { SessionSnapshot } from "../src/contract"
import { acceptsHistoryEvent, reconcileSessionHistory } from "../src/session-history"

const sessionID = "ses_history"
const user = (id: string, text = id) => ({ id, type: "user", text, time: { created: 1 } })
const checkpoint = (id: string) => ({ id, type: "synthetic", text: "<conversation-checkpoint>", metadata: { compactionCheckpoint: { jobID: "cmp_1" } }, time: { created: 1 } })
const compacted = (id: string, boundary: string) => ({ id, type: "compaction", jobID: "cmp_1", trigger: "manual", status: "completed", revision: 1, boundary: { messageID: boundary, seq: 4 }, metrics: {}, time: { created: 1 } })
const item = (title: string) => ({ id: sessionID, title, location: { directory: "/synthetic/repo" }, time: { updated: 1 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 })
const snapshot = (messages: readonly object[], options: { seq?: number; before?: string; revision?: number; sourceEpoch?: string; sessionID?: string; title?: string } = {}): SessionSnapshot => ({
  revision: options.revision ?? 1,
  sessionID: options.sessionID ?? sessionID,
  sourceEpoch: options.sourceEpoch ?? "epoch",
  item: item(options.title ?? "Current"),
  messages: messages as SessionSnapshot["messages"],
  watermark: options.seq === undefined ? {} : { seq: options.seq },
  ...(options.before === undefined ? {} : { before: options.before }),
})
const ids = (history: SessionSnapshot) => history.messages.map((message) => message.id)
const texts = (history: SessionSnapshot) => history.messages.map((message) => "text" in message ? message.text : message.id)

test("opening and refreshing keep a loaded older prefix, replace stale versions and keep the prefix cursor", () => {
  const newest = snapshot([user("m3"), user("m4"), user("m5")], { seq: 10, before: "c3" })
  expect(reconcileSessionHistory(undefined, newest, "refresh")).toEqual(newest)
  const loaded = reconcileSessionHistory(newest, snapshot([user("m1"), user("m2"), user("m3", "stale")], { seq: 4, before: "c1", title: "Older" }), "older")
  expect(ids(loaded)).toEqual(["m1", "m2", "m3", "m4", "m5"])
  expect(texts(loaded)[2]).toBe("m3")
  expect(loaded.before).toBe("c1")
  expect(loaded.watermark).toEqual({ seq: 10 })
  expect(loaded.item.title).toBe("Current")

  const refreshed = reconcileSessionHistory(loaded, snapshot([user("m3", "m3 edited"), user("m4"), user("m5"), user("m6")], { seq: 12, before: "c3b", title: "Renamed" }), "refresh")
  expect(ids(refreshed)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"])
  expect(texts(refreshed)[2]).toBe("m3 edited")
  expect(refreshed.before).toBe("c1")
  expect(refreshed.watermark).toEqual({ seq: 12 })
  expect(refreshed.item.title).toBe("Renamed")

  const unloaded = reconcileSessionHistory(newest, snapshot([user("m3"), user("m4"), user("m5"), user("m6")], { seq: 11, before: "c3b" }), "refresh")
  expect(unloaded.before).toBe("c3b")
})

test("a nonoverlapping newest window or a different Session, revision or epoch replaces resident history", () => {
  const loaded = snapshot([user("m1"), user("m2"), user("m3")], { seq: 5, before: "c1" })
  const jumped = snapshot([user("m8"), user("m9")], { seq: 20, before: "c8" })
  expect(reconcileSessionHistory(loaded, jumped, "refresh")).toEqual(jumped)
  for (const next of [snapshot([user("m3")], { seq: 1, sessionID: "ses_other" }), snapshot([user("m3")], { seq: 1, revision: 2 }), snapshot([user("m3")], { seq: 1, sourceEpoch: "epoch-2" })])
    expect(reconcileSessionHistory(loaded, next, "refresh")).toEqual(next)
})

test("a fresh snapshot behind the resident watermark is rejected", () => {
  const loaded = snapshot([user("m1")], { seq: 5 })
  expect(() => reconcileSessionHistory(loaded, snapshot([user("m1")], { seq: 4 }), "refresh")).toThrow("older than the resident history")
  expect(() => reconcileSessionHistory(loaded, snapshot([user("m1")]), "refresh")).toThrow("older than the resident history")
  expect(reconcileSessionHistory(loaded, snapshot([user("m1", "same")], { seq: 5 }), "refresh").messages).toHaveLength(1)
})

test("completed compaction checkpoints never resurrect removed history and stop paging", () => {
  const loaded = snapshot([user("m1"), user("m2"), user("m3"), user("m4")], { seq: 6, before: "c1" })
  const afterCompaction = reconcileSessionHistory(loaded, snapshot([checkpoint("k1"), user("m4"), user("m5")], { seq: 9, before: "ignored" }), "refresh")
  expect(ids(afterCompaction)).toEqual(["k1", "m4", "m5"])
  expect(afterCompaction.before).toBeUndefined()

  const marker = reconcileSessionHistory(loaded, snapshot([user("m3"), user("m4"), compacted("cm", "m3"), user("m5")], { seq: 9, before: "c3" }), "refresh")
  expect(ids(marker)).toEqual(["m4", "cm", "m5"])
  expect(marker.before).toBeUndefined()

  const tail = snapshot([user("m5"), user("m6")], { seq: 9, before: "c5" })
  const reached = reconcileSessionHistory(tail, snapshot([checkpoint("k1"), user("m4")], { seq: 3 }), "older")
  expect(ids(reached)).toEqual(["k1", "m4", "m5", "m6"])
  expect(reached.before).toBeUndefined()
  expect(() => reconcileSessionHistory(reached, snapshot([user("m0")], { seq: 1 }), "older")).toThrow()
})

test("older pages dedupe by ID, keep the newest version, keep current watermark and require the resident cursor to advance", () => {
  const current = snapshot([user("m3", "newest m3"), user("m4")], { seq: 10, before: "c3" })
  const merged = reconcileSessionHistory(current, snapshot([user("m1"), user("m2"), user("m2", "dup"), user("m3", "old m3")], { seq: 15, before: "c1", title: "Later" }), "older")
  expect(ids(merged)).toEqual(["m1", "m2", "m3", "m4"])
  expect(texts(merged)).toEqual(["m1", "dup", "newest m3", "m4"])
  expect(merged.watermark).toEqual({ seq: 10 })
  expect(merged.item.title).toBe("Current")
  expect(merged.before).toBe("c1")
  const end = reconcileSessionHistory(merged, snapshot([user("m0")], { seq: 15 }), "older")
  expect(end.before).toBeUndefined()
  expect(ids(end)).toEqual(["m0", "m1", "m2", "m3", "m4"])

  expect(() => reconcileSessionHistory(undefined, snapshot([user("m1")]), "older")).toThrow()
  expect(() => reconcileSessionHistory(current, snapshot([user("m1")], { before: "c3" }), "older")).toThrow("did not advance")
  for (const next of [snapshot([user("m1")], { sourceEpoch: "epoch-2" }), snapshot([user("m1")], { revision: 2 }), snapshot([user("m1")], { sessionID: "ses_other" })])
    expect(() => reconcileSessionHistory(current, next, "older")).toThrow("does not belong")
})

test("history events ignore foreign epochs and durable events already in the snapshot except task updates", () => {
  const history = snapshot([user("m1")], { seq: 10 })
  const durable = (type: string, seq: number, aggregateID = sessionID, sourceEpoch?: string) => ({ id: "evt", created: 1, type, durable: { aggregateID, seq, version: 1 }, ...(sourceEpoch ? { sourceEpoch } : {}), data: {} }) as unknown as YCodingEvent
  const volatile = (sourceEpoch?: string) => ({ id: "evt", created: 1, type: "server.connected", ...(sourceEpoch ? { sourceEpoch } : {}), data: {} }) as unknown as YCodingEvent
  expect(acceptsHistoryEvent(undefined, durable("session.message.updated", 1))).toBe(true)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 10))).toBe(false)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 9))).toBe(false)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 11))).toBe(true)
  expect(acceptsHistoryEvent(history, durable("session.task.updated", 9))).toBe(true)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 3, "ses_other"))).toBe(true)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 11, sessionID, "epoch-2"))).toBe(false)
  expect(acceptsHistoryEvent(history, durable("session.message.updated", 11, sessionID, "epoch"))).toBe(true)
  expect(acceptsHistoryEvent(history, volatile("epoch-2"))).toBe(false)
  expect(acceptsHistoryEvent(history, volatile())).toBe(true)
  expect(acceptsHistoryEvent(snapshot([user("m1")]), durable("session.message.updated", 0))).toBe(true)
})
