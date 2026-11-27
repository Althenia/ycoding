import { expect, test } from "bun:test"
import { emptyRecall, foldRecallEvent, foldRecallEvents, recallDetails, recallSummary, recallVisible, type RecallEntry } from "../src/cue-recall"

const memory = {
  kind: "memory",
  id: "build/linker",
  stage: "injected",
  method: "rrf",
  scores: { bm25: 1.5, semantic: 0.25, rrf: 0.03, rank: 0 },
  reason: "matched cue",
  source: { id: "memory:repository/build/linker", revision: "sha256:abc" },
  okf: { type: "Decision", trust: "trusted", freshness: "fresh", lifecycle: "active" },
  tokens: 120,
}
const skill = {
  kind: "skill",
  id: "rust-build",
  stage: "injected",
  method: "cue",
  reason: "command cargo build",
  source: { id: "skill:project/rust-build", revision: "pav_1" },
  artifact: { kind: "skill", id: "rust-build", sourceScope: "project", scopeID: "pas_x", versionID: "pav_1" },
  tokens: 220,
}
const cue = { type: "session.cue.detected", id: "evt_cue", created: 90, data: { sessionID: "ses_a", cueID: "c1", kind: "command", subject: "cargo build" } }
const recorded = (data: Record<string, unknown> = {}, id = "evt_r1", created = 100) => ({
  type: "session.recall.recorded",
  id,
  created,
  data: { sessionID: "ses_a", key: "k1", trigger: "cue", cueID: "c1", methods: ["cue", "rrf"], outcome: "injected", items: [memory, skill], elapsedMs: 18, injectedTokens: 340, budgetTokens: 2048, ...data },
})
const entry = (data: Record<string, unknown> = {}): RecallEntry => {
  const state = foldRecallEvents([cue, recorded(data)])
  if (state.entries.length !== 1) throw new Error("fixture rejected")
  return state.entries[0]!
}

test("summary counts injected memories and activated skills with elapsed time and tokens", () => {
  const summary = recallSummary(entry())
  expect(summary).toMatchObject({ memories: 1, skills: 1, elapsed: "18 ms", tokens: "~340 tokens" })
  expect(summary.label).toBe("Recalled 1 memory · 1 skill · 18 ms · ~340 tokens")
})

test("summary pluralizes, formats seconds and labels restoration", () => {
  const two = { ...memory, id: "build/other" }
  expect(recallSummary(entry({ items: [memory, two, skill], elapsedMs: 1250, injectedTokens: 1 })).label).toBe("Recalled 2 memories · 1 skill · 1.3 s · ~1 token")
  expect(recallSummary(entry({ outcome: "restored", trigger: "compaction", items: [{ ...memory, stage: "restored" }] })).label.startsWith("Restored 1 memory")).toBe(true)
})

test("detail exposes trigger, cue, methods, relevance, provenance, trust, freshness and lifecycle", () => {
  const detail = recallDetails(entry())
  expect(detail.header).toEqual([
    { label: "trigger", value: "cue" },
    { label: "cue", value: "command · cargo build" },
    { label: "method", value: "cue, rrf" },
    { label: "budget", value: "340 of 2048 tokens" },
  ])
  const [first, second] = detail.items
  expect(first!.title).toBe("memory build/linker")
  expect(first!.rows).toEqual([
    { label: "method", value: "rrf" },
    { label: "relevance", value: "bm25 1.5 · semantic 0.25 · rrf 0.03 · rank 1" },
    { label: "reason", value: "matched cue" },
    { label: "source", value: "memory:repository/build/linker @ sha256:abc" },
    { label: "type", value: "Decision" },
    { label: "trust", value: "trusted" },
    { label: "freshness", value: "fresh" },
    { label: "lifecycle", value: "active" },
    { label: "tokens", value: "~120" },
  ])
  expect(second!.rows).toContainEqual({ label: "artifact", value: "skill rust-build · project · pav_1" })
  expect(first!.target).toEqual({ kind: "memory", id: "build/linker", sourceID: "memory:repository/build/linker", revision: "sha256:abc" })
})

test("rejected, selected-only and candidate items stay in a separate diagnostics list", () => {
  const rejected = { ...memory, id: "old/note", stage: "rejected", rejection: "stale" }
  const overBudget = { ...memory, id: "over/budget", stage: "selected", rejection: "over_budget" }
  const candidate = { ...memory, id: "weak/hit", stage: "candidate" }
  const view = entry({ items: [memory, rejected, overBudget, candidate] })
  const detail = recallDetails(view)
  expect(detail.items.map((item) => item.title)).toEqual(["memory build/linker"])
  expect(detail.withheld.map((item) => item.title)).toEqual(["memory old/note", "memory over/budget", "memory weak/hit"])
  expect(detail.withheld[0]!.rows).toContainEqual({ label: "outcome", value: "rejected · stale" })
  expect(detail.counts).toEqual({ candidates: 4, selected: 2, injected: 1 })
})

test("abstentions and entries with nothing injected are not transcript rows", () => {
  expect(recallVisible(entry({ outcome: "abstained", abstention: "no_match", items: [{ ...memory, stage: "candidate" }], injectedTokens: 0 }))).toBe(false)
  expect(recallVisible(entry({ items: [] }))).toBe(false)
  expect(recallVisible(entry())).toBe(true)
})

test("folding replaces a repeated record by key, orders by time and ignores malformed events", () => {
  const state = foldRecallEvents([recorded({}, "evt_a", 100), recorded({ key: "k2" }, "evt_b", 50), recorded({ items: [{ ...memory, stage: "restored" }], outcome: "restored" }, "evt_c", 120)])
  expect(state.entries.map((item) => item.id)).toEqual(["evt_b", "evt_c"])
  expect(foldRecallEvent(emptyRecall, { type: "session.recall.recorded", id: "x", created: 1, data: { key: "k" } })).toBe(emptyRecall)
  expect(foldRecallEvent(emptyRecall, { type: "session.text.delta", data: {} })).toBe(emptyRecall)
  expect(foldRecallEvent(emptyRecall, undefined)).toBe(emptyRecall)
})

test("unknown methods, stages and kinds drop the item rather than displaying it", () => {
  const view = entry({ items: [memory, { ...memory, id: "a", method: "llm" }, { ...memory, id: "b", stage: "approved" }, { ...skill, kind: "tool" }, { ...memory, id: "c", source: {} }] })
  expect(view.items.map((item) => item.id)).toEqual(["build/linker"])
})

test("a cue arriving after its record does not attach, and control characters are escaped", () => {
  const late = foldRecallEvents([recorded(), cue])
  expect(late.entries[0]!.cue).toBeUndefined()
  const hostile = entry({ items: [{ ...memory, id: "a\u0007b", reason: "x\u001b[2Jy" }] })
  const detail = recallDetails(hostile)
  expect(detail.items[0]!.title).toBe("memory a\\u0007b")
  expect(detail.items[0]!.rows).toContainEqual({ label: "reason", value: "x\\u001b[2Jy" })
})
