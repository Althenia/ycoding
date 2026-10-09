import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MeetingStore } from "../src/store"
import type { TranscriptSegment } from "../src/types"

const resources: { dir: string; store?: MeetingStore }[] = []
afterEach(() =>
  resources.splice(0).forEach((resource) => {
    resource.store?.close()
    rmSync(resource.dir, { recursive: true, force: true })
  }),
)

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "meeting-store-"))
  const file = path.join(dir, "private", "meetings.sqlite")
  const store = new MeetingStore(file)
  const resource = { dir, store }
  resources.push(resource)
  store.createMeeting({ id: "m", title: "Design meeting", sessionID: "session" })
  return { file, store, resource }
}

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "s",
    meetingID: "m",
    sequence: 1,
    source: "remote",
    speakerID: "remote",
    startMs: 100,
    endMs: 400,
    rawText: "สวัสดี",
    text: "สวัสดี",
    state: "final",
    model: "whisper",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe("MeetingStore real SQLite integration", () => {
  it("rejects changed replay, preserves raw text on correction, and survives restart", () => {
    const { file, store, resource } = fixture()
    const original = segment()
    store.putSegment(original)
    store.putSegment(original)
    expect(() => store.putSegment({ ...original, rawText: "changed" })).toThrow(/replay|raw/i)
    store.correctSegment("s", "Corrected")
    store.putSegment(original)
    store.close()
    const reopened = new MeetingStore(file)
    resource.store = reopened
    expect(reopened.segments("m")).toEqual([{ ...original, text: "Corrected" }])
    expect(reopened.nextSequence("m")).toBe(2)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it("enforces final meeting-global sequence and pages by sequence", () => {
    const { store } = fixture()
    store.putSegment(segment())
    expect(() => store.putSegment(segment({ id: "duplicate", source: "microphone" }))).toThrow(/sequence/i)
    store.putSegment(segment({ id: "later", sequence: 3, source: "microphone" }))
    expect(() => store.putSegment(segment({ id: "earlier", sequence: 2 }))).toThrow(/sequence/i)
    expect(store.segments("m", { after: 1, limit: 1 }).map((value) => value.id)).toEqual(["later"])
    expect(store.nextSequence("m")).toBe(4)
    expect(() => store.putSegment(segment({ id: "invalid", sequence: 4, endMs: 0 }))).toThrow()
    expect(() => store.putSegment(segment({ id: "orphan", meetingID: "missing", sequence: 4 }))).toThrow()
  })

  it("preserves raw whitespace and permits immutable temporary segment finalization", () => {
    const { store } = fixture()
    const original = segment({ rawText: "  สวัสดี  ", text: "สวัสดี", state: "temporary" })
    store.putSegment(original)
    expect(store.segments("m")[0]?.rawText).toBe(original.rawText)
    expect(store.nextSequence("m")).toBe(1)
    store.putSegment({ ...original, state: "final" })
    expect(store.segments("m")[0]?.state).toBe("final")
    expect(store.nextSequence("m")).toBe(2)
  })

  it("persists and refreshes knowledge references before any proposal exists", () => {
    const { file, store, resource } = fixture()
    const reference = {
      server: "wiki",
      target: "page",
      revision: "1",
      content: "Original",
      retrievedAt: new Date().toISOString(),
    }
    store.putReference("m", reference)
    store.putReference("m", { ...reference, revision: "2", content: "Updated" })
    store.putReference("m", { ...reference, server: "other" })
    store.close()
    const reopened = new MeetingStore(file)
    resource.store = reopened
    expect(reopened.proposals("m")).toEqual([])
    expect(reopened.references("m")).toHaveLength(2)
    expect(reopened.references("m").find((value) => value.server === "wiki")).toMatchObject({
      revision: "2",
      content: "Updated",
    })
    reopened.deleteMeeting("m")
    expect(reopened.references("m")).toEqual([])
  })

  it("persists findings, references, checkpoints, plan, proposals, approvals and jobs", () => {
    const { file, store, resource } = fixture()
    const createdAt = new Date().toISOString()
    const finding = {
      id: "f",
      meetingID: "m",
      kind: "decision",
      summary: "Use SQLite",
      sourceSegmentIds: ["s"],
      confidence: 0.9,
      status: "confirmed",
      createdAt,
    } as const
    store.putFinding({ ...finding, sourceSegmentIds: [...finding.sourceSegmentIds] })
    store.putCheckpoint({
      id: "c",
      meetingID: "m",
      throughSequence: 1,
      summary: "Summary",
      final: true,
      createdAt,
      latencyMs: 50,
    })
    store.putPlan({
      meetingID: "m",
      content: "Plan",
      findingIds: ["f"],
      sourceSegmentIds: ["s"],
      status: "approved",
      createdAt,
    })
    store.putProposal({
      id: "p",
      meetingID: "m",
      server: "wiki",
      target: "page",
      operation: "replace",
      existingContent: "Old",
      suggestedContent: "New",
      explanation: "Agreed",
      sourceSegmentIds: ["s"],
      references: [{ server: "wiki", target: "page", revision: "1", content: "Old", retrievedAt: createdAt }],
      expectedRevision: "1",
      confidence: 0.9,
      status: "applying",
      createdAt,
    })
    store.putApproval({ id: "a", meetingID: "m", targetID: "p", decision: "approve", detail: "Reviewed", createdAt })
    store.putJob({ id: "j", meetingID: "m", kind: "knowledge", status: "running", attempts: 1, updatedAt: createdAt })
    store.updateMeeting("m", { status: "recording", captureID: "capture" })
    store.close()
    const reopened = new MeetingStore(file)
    resource.store = reopened
    reopened.recover()
    expect(reopened.getMeeting("m")?.status).toBe("interrupted")
    expect(reopened.findings("m")[0]?.summary).toBe("Use SQLite")
    expect(reopened.checkpoints("m")[0]?.summary).toBe("Summary")
    expect(reopened.plan("m")?.status).toBe("approved")
    expect(reopened.proposals("m")[0]).toMatchObject({
      status: "uncertain",
      references: [{ revision: "1", content: "Old" }],
    })
    expect(reopened.approvals("m")[0]?.decision).toBe("approve")
    expect(reopened.jobs("m")[0]?.status).toBe("interrupted")
    reopened.recover()
    expect(reopened.approvals("m")).toHaveLength(1)
    reopened.deleteMeeting("m")
    expect(reopened.checkpoints("m")).toEqual([])
    expect(reopened.plan("m")).toBeUndefined()
    expect(reopened.proposals("m")).toEqual([])
    expect(reopened.jobs("m")).toEqual([])
  })

  it("rolls back transactions and restricts id ownership and approval history changes", () => {
    const { store } = fixture()
    expect(() =>
      store.transaction(() => {
        store.createMeeting({ id: "rollback", title: "Rollback", sessionID: "session" })
        throw new Error("rollback")
      }),
    ).toThrow("rollback")
    expect(store.getMeeting("rollback")).toBeUndefined()
    store.putSegment(segment())
    store.createMeeting({ id: "other", title: "Other", sessionID: "session" })
    expect(() => store.putSegment(segment({ meetingID: "other" }))).toThrow()
    const approval = {
      id: "a",
      meetingID: "m",
      targetID: "p",
      decision: "approve",
      detail: "OK",
      createdAt: new Date().toISOString(),
    } as const
    store.putApproval(approval)
    store.putApproval(approval)
    expect(() => store.putApproval({ ...approval, decision: "reject" })).toThrow(/history|replay/i)
  })

  it("rejects asynchronous transactions before invoking their callback", () => {
    const { store } = fixture()
    let called = false
    expect(() =>
      store.transaction(async () => {
        called = true
      }),
    ).toThrow(/synchronous/i)
    expect(called).toBe(false)
  })

  it("retains active meetings and cascades explicit deletion and expired retention", () => {
    const { file, store } = fixture()
    const createdAt = new Date().toISOString()
    store.putSegment(segment())
    store.putFinding({
      id: "f",
      meetingID: "m",
      kind: "topic",
      summary: "Topic",
      sourceSegmentIds: ["s"],
      confidence: 1,
      status: "confirmed",
      createdAt,
    })
    store.putApproval({ id: "a", meetingID: "m", targetID: "f", decision: "approve", detail: "OK", createdAt })
    store.createMeeting({ id: "active", title: "Active", sessionID: "session" })
    store.updateMeeting("active", { status: "recording" })
    store.createMeeting({ id: "expired", title: "Expired", sessionID: "session" })
    const db = new Database(file)
    for (const id of ["expired", "active"]) {
      db.query(
        "UPDATE meetings SET data=json_set(data, '$.createdAt', '2000-01-01T00:00:00.000Z', '$.updatedAt', '2000-01-01T00:00:00.000Z') WHERE id=?",
      ).run(id)
    }
    db.close()
    store.retain(30)
    expect(store.getMeeting("expired")).toBeUndefined()
    expect(store.getMeeting("active")?.status).toBe("recording")
    store.deleteMeeting("m")
    expect(store.segments("m")).toEqual([])
    expect(store.findings("m")).toEqual([])
    expect(store.approvals("m")).toEqual([])
    expect(store.listMeetings({ query: "active", limit: 1 }).map((value) => value.id)).toEqual(["active"])
  })

  it("rejects corrupt/incomplete stored segments and future schema versions", () => {
    const { file, store } = fixture()
    store.putSegment(segment())
    const db = new Database(file)
    db.query("UPDATE segments SET data=? WHERE id='s'").run(JSON.stringify({ id: "s", meetingID: "m" }))
    expect(() => store.segments("m")).toThrow(/invalid|corrupt/i)
    db.exec("PRAGMA user_version=99")
    db.close()
    store.close()
    expect(() => new MeetingStore(file)).toThrow(/version/i)
    const verify = new Database(file)
    expect(verify.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(99)
    verify.close()
  })

  it("initializes version 1 transactionally and rejects unrelated SQLite databases untouched", () => {
    const { file, store } = fixture()
    const db = new Database(file)
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(1)
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal")
    db.close()
    store.close()
    const unrelatedFile = path.join(path.dirname(file), "unrelated.sqlite")
    const unrelated = new Database(unrelatedFile)
    unrelated.exec("CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES ('unchanged')")
    expect(() => new MeetingStore(unrelatedFile)).toThrow(/own empty database/i)
    expect(unrelated.query<{ id: string }, []>("SELECT id FROM session").get()?.id).toBe("unchanged")
    expect(unrelated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(0)
    unrelated.exec("PRAGMA user_version=1")
    expect(() => new MeetingStore(unrelatedFile)).toThrow(/isolated.*schema/i)
    expect(unrelated.query<{ id: string }, []>("SELECT id FROM session").get()?.id).toBe("unchanged")
    unrelated.close()
  })
})
