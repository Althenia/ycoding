import { expect, test } from "bun:test"
import { foldRecallEvents } from "@ycoding-ai/client/cue-recall"
import { foldLifecycleEvents } from "@ycoding-ai/client/lifecycle"
import type { Messages } from "../src/contract"
import { recordPlacements, transcriptRecords } from "../src/recall"

const item = (stage: string) => ({ kind: "memory", id: "build/linker", stage, method: "bm25", reason: "matched", source: { id: "memory:repository/build/linker", revision: "sha256:aa" } })
const recorded = (id: string, created: number, stage = "injected", outcome = "injected") => ({
  type: "session.recall.recorded",
  id,
  created,
  data: { sessionID: "ses_a", key: id, trigger: "prompt", methods: ["bm25"], outcome, items: [item(stage)], elapsedMs: 3, injectedTokens: 40 },
})
const lifecycle = (id: string, created: number, decision: string, basis: string) => ({
  type: "session.lifecycle.recorded",
  id,
  created,
  data: { sessionID: "ses_a", step: 2, decision, basis, recovery: decision === "recover", recalled: false },
})
const turn = (id: string, created: number) => ({ type: "user", id, text: id, time: { created } }) as unknown as Messages[number]

const place = (events: unknown[], turns: Messages[number][]) =>
  recordPlacements(turns, transcriptRecords(foldRecallEvents(events).entries, foldLifecycleEvents(events).entries))

test("entries sit before the first later turn, trailing entries stay at the tail, empty entries vanish", () => {
  const placed = place([recorded("r1", 15), recorded("r2", 99), recorded("r3", 16, "candidate", "abstained")], [turn("u1", 10), turn("a1", 30)])
  expect([...placed.before.entries()].map(([id, list]) => [id, list.map((record) => record.id)])).toEqual([["a1", ["r1"]]])
  expect(placed.tail.map((record) => record.id)).toEqual(["r2"])
})

test("lifecycle and recall records interleave chronologically from one event list; invisible lifecycle entries produce no row", () => {
  const events = [
    lifecycle("l2", 20, "recover", "silent"),
    recorded("r1", 15),
    lifecycle("l1", 12, "continue", "tool_results"),
    lifecycle("l3", 17, "complete", "answered"),
    lifecycle("l4", 99, "complete", "truncated"),
    { type: "session.lifecycle.recorded", id: "bad", created: 18, data: { step: 1 } },
  ]
  const placed = place(events, [turn("u1", 10), turn("a1", 30)])
  expect(placed.before.get("a1")?.map((record) => [record.kind, record.id])).toEqual([["recall", "r1"], ["lifecycle", "l2"]])
  expect(placed.tail.map((record) => [record.kind, record.id])).toEqual([["lifecycle", "l4"]])
})

test("replaying the same lifecycle event replaces its entry", () => {
  const placed = place([lifecycle("l1", 20, "recover", "silent"), lifecycle("l1", 20, "recover", "silent")], [turn("u1", 10)])
  expect(placed.tail).toHaveLength(1)
})
