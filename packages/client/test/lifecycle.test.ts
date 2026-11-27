import { expect, test } from "bun:test"
import { emptyLifecycle, foldLifecycleEvent, foldLifecycleEvents, lifecycleDetails, lifecycleEventType, lifecycleSummary, lifecycleVisible } from "../src/lifecycle"

const recorded = (data: Record<string, unknown> = {}, id = "evt_l1", created = 100) => ({
  type: "session.lifecycle.recorded",
  id,
  created,
  data: { sessionID: "ses_a", step: 2, decision: "recover", basis: "silent", recovery: false, recalled: true, ...data },
})
const only = (event: unknown) => {
  const state = foldLifecycleEvent(emptyLifecycle, event)
  if (state.entries.length !== 1) throw new Error("fixture rejected")
  return state.entries[0]!
}

test("folds lifecycle records in chronological order and replaces a repeated id", () => {
  const state = foldLifecycleEvents([recorded({}, "evt_b", 200), recorded({ step: 1 }, "evt_a", 100), recorded({ step: 3 }, "evt_b", 200)])
  expect(state.entries.map((entry) => [entry.id, entry.step])).toEqual([["evt_a", 1], ["evt_b", 3]])
})

test("rejects malformed records and other event types", () => {
  for (const data of [{ step: -1 }, { step: 1.5 }, { decision: "stop" }, { basis: "other" }, { recovery: "no" }, { recalled: undefined }]) {
    expect(foldLifecycleEvent(emptyLifecycle, recorded(data))).toBe(emptyLifecycle)
  }
  expect(foldLifecycleEvent(emptyLifecycle, { ...recorded(), type: "session.recall.recorded" })).toBe(emptyLifecycle)
  expect(foldLifecycleEvent(emptyLifecycle, { ...recorded(), id: "" })).toBe(emptyLifecycle)
})

test("only recoveries and abnormal endings produce a transcript row", () => {
  const visible = (data: Record<string, unknown>) => lifecycleVisible(only(recorded(data)))
  expect(visible({ decision: "continue", basis: "tool_results" })).toBe(false)
  expect(visible({ decision: "complete", basis: "answered" })).toBe(false)
  expect(visible({ decision: "recover", basis: "silent" })).toBe(true)
  expect(visible({ decision: "recover", basis: "unsettled" })).toBe(true)
  expect(visible({ decision: "complete", basis: "truncated" })).toBe(true)
  expect(visible({ decision: "complete", basis: "silent" })).toBe(true)
})

test("summary and details name the step, decision and ending", () => {
  expect(lifecycleSummary(only(recorded())).label).toBe("Retried for a reply · step 2 · no reply")
  expect(lifecycleSummary(only(recorded({ decision: "complete", basis: "truncated" }))).label).toBe("Stopped at the output limit · step 2 · output limit reached")
  expect(lifecycleSummary(only(recorded({ decision: "complete", basis: "unsettled" }))).title).toBe("Ended without a reply")
  expect(lifecycleDetails(only(recorded()))).toEqual([
    { label: "step", value: "2" },
    { label: "decision", value: "recover" },
    { label: "ending", value: "no reply" },
    { label: "recovery step", value: "no" },
    { label: "recall injected", value: "yes" },
  ])
})

const harness = (type: string, data: Record<string, unknown>, id = "evt_h", created = 100) => ({ type: `session.harness.${type}`, id, created, data: { sessionID: "ses_a", ...data } })

test("harness events fold into the same ordered state and name their own event types", () => {
  expect(["session.lifecycle.recorded", "session.harness.evaluated", "session.harness.rolled-back"].every(lifecycleEventType)).toBe(true)
  expect(lifecycleEventType("session.recall.recorded")).toBe(false)
  const state = foldLifecycleEvents([
    harness("adopted", { version: "hv_2", parent: "hv_1" }, "evt_b", 200),
    harness("probed", { candidate: "cand_1", outcome: "completed", tokens: 40, latencyMs: 12 }, "evt_a", 100),
  ])
  expect(state.entries.map((entry) => entry.id)).toEqual(["evt_a", "evt_b"])
  expect(state.entries.every(lifecycleVisible)).toBe(true)
  expect(lifecycleSummary(state.entries[1]!)).toEqual({ label: "Adopted a harness version", title: "Adopted a harness version", meta: "adopted" })
  expect(lifecycleDetails(state.entries[0]!)).toEqual([
    { label: "candidate", value: "cand_1" },
    { label: "outcome", value: "completed" },
    { label: "tokens", value: "40" },
    { label: "latency", value: "12 ms" },
  ])
})

test("a sufficient baseline stays out of the transcript while a skip, rollback or experience shows", () => {
  const visible = (type: string, data: Record<string, unknown>) => {
    const state = foldLifecycleEvent(emptyLifecycle, harness(type, data))
    if (state.entries.length !== 1) throw new Error("fixture rejected")
    return lifecycleVisible(state.entries[0]!)
  }
  expect(visible("evaluated", { stage: "baseline", mode: "adaptive", signals: 0, insufficient: false })).toBe(false)
  expect(visible("evaluated", { stage: "baseline", mode: "adaptive", signals: 3, insufficient: true })).toBe(true)
  expect(visible("evaluated", { stage: "baseline", mode: "disabled", signals: 0, insufficient: false, skipReason: "disabled" })).toBe(true)
  expect(visible("rolled-back", { from: "hv_2", to: "hv_1" })).toBe(true)
  expect(visible("reflected", { experiences: ["exp_1", "exp_2"] })).toBe(true)
  expect(visible("reflected", { experiences: [] })).toBe(false)
})

test("malformed harness records are rejected", () => {
  for (const event of [
    harness("adopted", { version: "hv_2" }),
    harness("probed", { candidate: "c", outcome: "completed", tokens: -1, latencyMs: 0 }),
    harness("reflected", { experiences: ["exp_1", 7] }),
    harness("evaluated", { stage: "baseline", mode: "adaptive", signals: 1 }),
    harness("unknown", {}),
  ]) expect(foldLifecycleEvent(emptyLifecycle, event)).toBe(emptyLifecycle)
})
