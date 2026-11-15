import { expect, test } from "bun:test"
import { isInternalTranscriptEnvelope } from "../src/transcript-visibility"

test("internal envelopes stay hidden without filtering user or assistant prose", () => {
  for (const text of ["Authoritative current Session state (JSON):\n{}", "Internal orchestration context (JSON).\n{}", "<system-update>state</system-update>", "## Guardrail decision history\nFamily root: ses_example\n[]"]) {
    expect(isInternalTranscriptEnvelope({ type: "system", text })).toBe(true)
    expect(isInternalTranscriptEnvelope({ type: "synthetic", text })).toBe(true)
    expect(isInternalTranscriptEnvelope({ type: "user", text })).toBe(false)
    expect(isInternalTranscriptEnvelope({ type: "assistant", text })).toBe(false)
  }
  for (const metadata of [{ contextSource: "session-state" }, { contextSource: "team-view" }, { decisionInputID: "d" }, { compactionCheckpoint: {} }])
    expect(isInternalTranscriptEnvelope({ type: "synthetic", text: "context", metadata })).toBe(true)
  expect(isInternalTranscriptEnvelope({ type: "system", text: "[]" })).toBe(false)
  expect(isInternalTranscriptEnvelope({ type: "synthetic", text: "Project notification", metadata: { source: "project_notification" } })).toBe(false)
})
