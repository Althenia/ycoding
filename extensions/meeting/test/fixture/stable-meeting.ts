import { MeetingStore } from "../../src/store"

const file = process.argv[2]
if (!file) throw new Error("A synthetic Meeting SQLite path is required")
const store = new MeetingStore(file)
const createdAt = "2026-01-01T00:00:00.000Z"
store.createMeeting({ id: "imported", title: "Stable meeting history", sessionID: "ses_imported" })
store.updateMeeting("imported", { status: "stopped" })
store.putSegment({
  id: "segment",
  meetingID: "imported",
  sequence: 1,
  source: "remote",
  speakerID: "remote",
  startMs: 0,
  endMs: 1000,
  rawText: "  สวัสดี stable  ",
  text: "สวัสดี stable",
  state: "final",
  model: "whisper",
  createdAt,
})
store.putFinding({
  id: "finding",
  meetingID: "imported",
  kind: "decision",
  summary: "Preserve stable history",
  sourceSegmentIds: ["segment"],
  confidence: 0.9,
  status: "confirmed",
  createdAt,
})
store.putCheckpoint({
  id: "checkpoint",
  meetingID: "imported",
  throughSequence: 1,
  summary: "Imported summary",
  final: true,
  latencyMs: 12,
  createdAt,
})
store.putReference("imported", {
  server: "wiki",
  target: "page",
  revision: "revision-1",
  content: "Stable knowledge",
  retrievedAt: createdAt,
})
store.putProposal({
  id: "proposal",
  meetingID: "imported",
  server: "wiki",
  target: "page",
  operation: "replace",
  existingContent: "Stable knowledge",
  suggestedContent: "Proposed knowledge",
  explanation: "Meeting evidence",
  sourceSegmentIds: ["segment"],
  references: [],
  expectedRevision: "revision-1",
  confidence: 0.9,
  status: "pending",
  createdAt,
})
store.putPlan({
  meetingID: "imported",
  content: "Imported plan",
  findingIds: ["finding"],
  sourceSegmentIds: ["segment"],
  status: "proposed",
  createdAt,
})
store.putApproval({
  id: "approval",
  meetingID: "imported",
  targetID: "proposal",
  decision: "reject",
  detail: "Retain review history",
  createdAt,
})
store.putJob({
  id: "job",
  meetingID: "imported",
  kind: "analysis",
  status: "done",
  attempts: 1,
  updatedAt: createdAt,
})
if (process.argv[3] !== "wal") {
  store.close()
  process.stdout.write("ready\n")
}
if (process.argv[3] === "wal") {
  process.stdin.resume()
  process.stdin.once("end", () => store.close())
  process.stdout.write("ready\n")
}
