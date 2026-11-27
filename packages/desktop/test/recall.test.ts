import { expect, test } from "bun:test"
import { foldRecallEvents } from "@ycoding-ai/client/cue-recall"
import type { Messages } from "../src/contract"
import { recallPlacements } from "../src/recall"

const item = (stage: string) => ({ kind: "memory", id: "build/linker", stage, method: "bm25", reason: "matched", source: { id: "memory:repository/build/linker", revision: "sha256:aa" } })
const recorded = (id: string, created: number, stage = "injected", outcome = "injected") => ({
  type: "session.recall.recorded",
  id,
  created,
  data: { sessionID: "ses_a", key: id, trigger: "prompt", methods: ["bm25"], outcome, items: [item(stage)], elapsedMs: 3, injectedTokens: 40 },
})
const turn = (id: string, created: number) => ({ type: "user", id, text: id, time: { created } }) as unknown as Messages[number]

test("entries sit before the first later turn, trailing entries stay at the tail, empty entries vanish", () => {
  const entries = foldRecallEvents([recorded("r1", 15), recorded("r2", 99), recorded("r3", 16, "candidate", "abstained")]).entries
  const placed = recallPlacements([turn("u1", 10), turn("a1", 30)], entries)
  expect([...placed.before.entries()].map(([id, list]) => [id, list.map((entry) => entry.id)])).toEqual([["a1", ["r1"]]])
  expect(placed.tail.map((entry) => entry.id)).toEqual(["r2"])
})
