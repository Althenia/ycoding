import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type {
  Approval,
  EngineeringPlan,
  Finding,
  KnowledgeProposal,
  KnowledgeReference,
  Meeting,
  ProcessingJob,
  SummaryCheckpoint,
  TranscriptSegment,
} from "./types"

const id = z.string().min(1)
const timestamp = z.iso.datetime({ offset: true })
const nonnegative = z.number().finite().nonnegative()
const sequence = nonnegative.int()
const meetingSchema: z.ZodType<Meeting> = z.strictObject({
  id,
  title: z.string(),
  sessionID: id,
  status: z.enum(["ready", "recording", "stopping", "stopped", "interrupted", "error"]),
  createdAt: timestamp,
  updatedAt: timestamp,
  captureID: id.optional(),
  error: z.string().optional(),
})
const segmentSchema: z.ZodType<TranscriptSegment> = z
  .strictObject({
    id,
    meetingID: id,
    sequence,
    source: z.enum(["remote", "microphone"]),
    speakerID: id,
    startMs: nonnegative,
    endMs: nonnegative,
    rawText: z.string().refine((value) => value.trim().length > 0, "Raw text is required"),
    text: z.string(),
    state: z.enum(["temporary", "final"]),
    model: id,
    createdAt: timestamp,
  })
  .refine((value) => value.endMs >= value.startMs, "Invalid segment time range")
const findingSchema: z.ZodType<Finding> = z.strictObject({
  id,
  meetingID: id,
  kind: z.enum([
    "topic",
    "decision",
    "proposal",
    "requirement",
    "action",
    "risk",
    "blocker",
    "disagreement",
    "question",
    "claim",
  ]),
  summary: z.string(),
  sourceSegmentIds: z.array(id),
  speakerId: id.optional(),
  owner: z.string().optional(),
  deadline: z.string().optional(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["unconfirmed", "confirmed", "rejected"]),
  createdAt: timestamp,
})
const referenceSchema: z.ZodType<KnowledgeReference> = z.strictObject({
  server: id,
  target: id,
  revision: z.string(),
  content: z.string(),
  retrievedAt: timestamp,
})
const proposalSchema: z.ZodType<KnowledgeProposal> = z.strictObject({
  id,
  meetingID: id,
  server: id,
  target: id,
  operation: z.literal("replace"),
  existingContent: z.string(),
  suggestedContent: z.string(),
  explanation: z.string(),
  sourceSegmentIds: z.array(id),
  references: z.array(referenceSchema),
  expectedRevision: z.string(),
  confidence: z.number().min(0).max(1),
  status: z.enum(["pending", "approved", "rejected", "stale", "applying", "applied", "uncertain", "failed", "manual"]),
  createdAt: timestamp,
  error: z.string().optional(),
})
const checkpointSchema: z.ZodType<SummaryCheckpoint> = z.strictObject({
  id,
  meetingID: id,
  throughSequence: sequence,
  summary: z.string(),
  final: z.boolean(),
  createdAt: timestamp,
  latencyMs: nonnegative,
})
const planSchema: z.ZodType<EngineeringPlan> = z.strictObject({
  meetingID: id,
  content: z.string(),
  findingIds: z.array(id),
  sourceSegmentIds: z.array(id),
  status: z.enum(["proposed", "approved", "rejected"]),
  createdAt: timestamp,
})
const approvalSchema: z.ZodType<Approval> = z.strictObject({
  id,
  meetingID: id,
  targetID: id,
  decision: z.enum(["approve", "reject", "correct"]),
  detail: z.string(),
  createdAt: timestamp,
})
const jobSchema: z.ZodType<ProcessingJob> = z.strictObject({
  id,
  meetingID: id,
  kind: z.enum(["transcription", "analysis", "knowledge"]),
  status: z.enum(["pending", "running", "done", "failed", "interrupted"]),
  attempts: sequence,
  error: z.string().optional(),
  updatedAt: timestamp,
})

type Table = "findings" | "checkpoints" | "proposals" | "plans" | "approvals" | "jobs"
type RecordRow = { id: string; meeting_id: string; data: string }

function decode<T>(data: string, schema: z.ZodType<T>): T {
  const result = schema.safeParse(JSON.parse(data))
  if (!result.success) throw new Error(`Corrupt or invalid meeting record: ${result.error.message}`)
  return result.data
}

function limit(value = 2147483647) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid result limit")
  return value
}

export class MeetingStore {
  private readonly db: Database

  constructor(file: string) {
    if (!file || file === ":memory:") throw new Error("MeetingStore requires a separate SQLite file")
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    chmodSync(path.dirname(file), 0o700)
    this.db = new Database(file, { create: true, strict: true })
    try {
      chmodSync(file, 0o600)
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000")
      this.transaction(() => {
        const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
        if (version > 1) throw new Error(`Unsupported meeting database version ${version}`)
        if (version === 1) {
          const names = this.db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all()
            .map((row) => row.name)
          const expected = [
            "meetings",
            "segments",
            "knowledge_references",
            "findings",
            "checkpoints",
            "proposals",
            "plans",
            "approvals",
            "jobs",
          ]
          if (names.length !== expected.length || expected.some((name) => !names.includes(name)))
            throw new Error("Invalid isolated meeting database schema")
          return
        }
        if (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
          throw new Error("MeetingStore requires its own empty database for schema version 1")
        }
        this.db.exec(`
          CREATE TABLE meetings (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
          CREATE TABLE segments (
            id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, state TEXT NOT NULL, original_text TEXT NOT NULL,
            data TEXT NOT NULL CHECK(json_valid(data))
          );
          CREATE UNIQUE INDEX final_sequence ON segments(meeting_id, sequence) WHERE state='final';
          CREATE INDEX segment_order ON segments(meeting_id, sequence);
          CREATE TABLE knowledge_references (
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            server TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
            PRIMARY KEY(meeting_id, server, target)
          );
        `)
        for (const table of ["findings", "checkpoints", "proposals", "plans", "approvals", "jobs"]) {
          this.db.exec(
            `CREATE TABLE ${table} (id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data))); CREATE INDEX ${table}_meeting ON ${table}(meeting_id)`,
          )
        }
        this.db.exec("PRAGMA user_version=1")
      })
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  createMeeting(input: Pick<Meeting, "id" | "title" | "sessionID">): Meeting {
    const now = new Date().toISOString()
    const meeting = meetingSchema.parse({ ...input, status: "ready", createdAt: now, updatedAt: now })
    return this.transaction(() => {
      const existing = this.getMeeting(meeting.id)
      if (existing) {
        if (existing.title !== meeting.title || existing.sessionID !== meeting.sessionID)
          throw new Error("Changed meeting replay")
        return existing
      }
      this.db.query("INSERT INTO meetings(id,data) VALUES (?,?)").run(meeting.id, JSON.stringify(meeting))
      return meeting
    })
  }

  getMeeting(meetingID: string): Meeting | undefined {
    const row = this.db
      .query<{ id: string; data: string }, [string]>("SELECT id,data FROM meetings WHERE id=?")
      .get(meetingID)
    if (!row) return undefined
    const value = decode(row.data, meetingSchema)
    if (value.id !== row.id) throw new Error("Corrupt meeting identity")
    return value
  }

  listMeetings(options: { query?: string; limit?: number } = {}): Meeting[] {
    return this.db
      .query<{ id: string; data: string }, [string, number]>(
        "SELECT id,data FROM meetings WHERE instr(lower(json_extract(data,'$.title')),lower(?))>0 ORDER BY json_extract(data,'$.updatedAt') DESC,id LIMIT ?",
      )
      .all(options.query ?? "", limit(options.limit))
      .map((row) => {
        const meeting = decode(row.data, meetingSchema)
        if (meeting.id !== row.id) throw new Error("Corrupt meeting identity")
        return meeting
      })
  }

  updateMeeting(meetingID: string, patch: Partial<Pick<Meeting, "status" | "captureID" | "error">>): Meeting {
    const validated = z
      .strictObject({
        status: z.enum(["ready", "recording", "stopping", "stopped", "interrupted", "error"]).optional(),
        captureID: id.optional(),
        error: z.string().optional(),
      })
      .parse(patch)
    return this.transaction(() => {
      const existing = this.getMeeting(meetingID)
      if (!existing) throw new Error("Unknown meeting")
      const meeting = meetingSchema.parse({ ...existing, ...validated, updatedAt: new Date().toISOString() })
      this.db.query("UPDATE meetings SET data=? WHERE id=?").run(JSON.stringify(meeting), meetingID)
      return meeting
    })
  }

  putSegment(input: TranscriptSegment): void {
    const segment = segmentSchema.parse(input)
    this.transaction(() => {
      const row = this.db
        .query<
          RecordRow & { original_text: string; sequence: number; state: string },
          [string]
        >("SELECT * FROM segments WHERE id=?")
        .get(segment.id)
      if (row) {
        const existing = decode(row.data, segmentSchema)
        if (
          existing.id !== row.id ||
          existing.meetingID !== row.meeting_id ||
          existing.sequence !== row.sequence ||
          existing.state !== row.state
        )
          throw new Error("Corrupt segment identity")
        const promoted = existing.state === "temporary" && segment.state === "final"
        if (
          JSON.stringify({ ...existing, text: row.original_text, state: promoted ? "final" : existing.state }) !==
          JSON.stringify(segment)
        ) {
          throw new Error("Changed segment replay or raw text; use correctSegment for corrections")
        }
        if (!promoted) return
      }
      if (segment.state === "final" && segment.sequence < this.nextSequence(segment.meetingID))
        throw new Error("Final segment sequence must be unique and monotonic")
      this.db
        .query(
          "INSERT INTO segments(id,meeting_id,sequence,state,original_text,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data",
        )
        .run(segment.id, segment.meetingID, segment.sequence, segment.state, segment.text, JSON.stringify(segment))
    })
  }

  nextSequence(meetingID: string): number {
    return (
      (this.db
        .query<
          { sequence: number | null },
          [string]
        >("SELECT MAX(sequence) AS sequence FROM segments WHERE meeting_id=? AND state='final'")
        .get(meetingID)?.sequence ?? 0) + 1
    )
  }

  segments(meetingID: string, options: { after?: number; limit?: number } = {}): TranscriptSegment[] {
    const after = options.after ?? -1
    if (!Number.isSafeInteger(after) || after < -1) throw new Error("Invalid segment cursor")
    return this.db
      .query<RecordRow & { sequence: number; state: string }, [string, number, number]>(
        "SELECT * FROM segments WHERE meeting_id=? AND sequence>? ORDER BY sequence,id LIMIT ?",
      )
      .all(meetingID, after, limit(options.limit))
      .map((row) => {
        const value = decode(row.data, segmentSchema)
        if (
          value.id !== row.id ||
          value.meetingID !== row.meeting_id ||
          value.sequence !== row.sequence ||
          value.state !== row.state
        )
          throw new Error("Corrupt segment identity")
        return value
      })
  }

  correctSegment(segmentID: string, text: string): void {
    z.string().parse(text)
    this.transaction(() => {
      const row = this.db.query<RecordRow, [string]>("SELECT * FROM segments WHERE id=?").get(segmentID)
      if (!row) throw new Error("Unknown segment")
      const existing = decode(row.data, segmentSchema)
      if (existing.id !== row.id || existing.meetingID !== row.meeting_id) throw new Error("Corrupt segment identity")
      this.db.query("UPDATE segments SET data=? WHERE id=?").run(JSON.stringify({ ...existing, text }), segmentID)
    })
  }

  findings(meetingID: string): Finding[] {
    return this.read("findings", meetingID, findingSchema)
  }
  putFinding(value: Finding): void {
    this.write("findings", findingSchema.parse(value))
  }
  checkpoints(meetingID: string): SummaryCheckpoint[] {
    return this.read("checkpoints", meetingID, checkpointSchema)
  }
  putCheckpoint(value: SummaryCheckpoint): void {
    this.write("checkpoints", checkpointSchema.parse(value))
  }
  proposals(meetingID: string): KnowledgeProposal[] {
    return this.read("proposals", meetingID, proposalSchema)
  }
  putProposal(value: KnowledgeProposal): void {
    this.write("proposals", proposalSchema.parse(value))
  }
  plan(meetingID: string): EngineeringPlan | undefined {
    return this.read("plans", meetingID, planSchema)[0]
  }
  putPlan(value: EngineeringPlan): void {
    this.write("plans", { ...planSchema.parse(value), id: value.meetingID })
  }
  approvals(meetingID: string): Approval[] {
    return this.read("approvals", meetingID, approvalSchema)
  }
  putApproval(value: Approval): void {
    this.write("approvals", approvalSchema.parse(value), true)
  }
  jobs(meetingID: string): ProcessingJob[] {
    return this.read("jobs", meetingID, jobSchema)
  }
  putJob(value: ProcessingJob): void {
    this.write("jobs", jobSchema.parse(value))
  }

  references(meetingID: string): KnowledgeReference[] {
    return this.db
      .query<{ server: string; target: string; data: string }, [string]>(
        "SELECT server,target,data FROM knowledge_references WHERE meeting_id=? ORDER BY server,target",
      )
      .all(meetingID)
      .map((row) => {
        const reference = decode(row.data, referenceSchema)
        if (reference.server !== row.server || reference.target !== row.target)
          throw new Error("Corrupt knowledge reference identity")
        return reference
      })
  }

  putReference(meetingID: string, input: KnowledgeReference): void {
    const reference = referenceSchema.parse(input)
    this.db
      .query(
        "INSERT INTO knowledge_references(meeting_id,server,target,data) VALUES (?,?,?,?) ON CONFLICT(meeting_id,server,target) DO UPDATE SET data=excluded.data",
      )
      .run(meetingID, reference.server, reference.target, JSON.stringify(reference))
  }

  transaction<T>(callback: () => T): T {
    if (callback.constructor.name === "AsyncFunction") throw new Error("MeetingStore transactions must be synchronous")
    return this.db
      .transaction(() => {
        const value = callback()
        if (value && typeof value === "object" && "then" in value)
          throw new Error("MeetingStore transactions must be synchronous")
        return value
      })
      .immediate()
  }

  deleteMeeting(meetingID: string): void {
    this.db.query("DELETE FROM meetings WHERE id=?").run(meetingID)
    if (!this.db.inTransaction) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  }

  retain(days: number): void {
    if (!Number.isFinite(days) || days < 0) throw new Error("Invalid retention days")
    const cutoff = new Date(Date.now() - days * 86400000).toISOString()
    this.transaction(() => {
      for (const row of this.db.query<{ id: string; data: string }, []>("SELECT id,data FROM meetings").all()) {
        const meeting = decode(row.data, meetingSchema)
        if (meeting.id !== row.id) throw new Error("Corrupt meeting identity")
        if (meeting.updatedAt >= cutoff || meeting.status === "recording" || meeting.status === "stopping") continue
        this.db.query("DELETE FROM meetings WHERE id=?").run(meeting.id)
      }
    })
    if (!this.db.inTransaction) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  }

  recover(): void {
    this.transaction(() => {
      for (const row of this.db.query<{ id: string; data: string }, []>("SELECT id,data FROM meetings").all()) {
        const meeting = decode(row.data, meetingSchema)
        if (meeting.id !== row.id) throw new Error("Corrupt meeting identity")
        if (meeting.status === "recording" || meeting.status === "stopping") {
          this.updateMeeting(meeting.id, {
            status: "interrupted",
            error: `${meeting.error ? `${meeting.error}; ` : ""}Capture interrupted; volatile raw audio is unavailable after restart`,
          })
        }
        for (const job of this.jobs(meeting.id).filter((value) => value.status === "running")) {
          this.putJob({
            ...job,
            status: "interrupted",
            updatedAt: new Date().toISOString(),
            error: "Processing interrupted by restart",
          })
        }
        for (const proposal of this.proposals(meeting.id).filter((value) => value.status === "applying")) {
          this.putProposal({
            ...proposal,
            status: "uncertain",
            error: "External write outcome must be checked before retry",
          })
        }
      }
    })
  }

  private read<T extends { meetingID: string }>(table: Table, meetingID: string, schema: z.ZodType<T>): T[] {
    return this.db
      .query<RecordRow, [string]>(`SELECT * FROM ${table} WHERE meeting_id=? ORDER BY rowid`)
      .all(meetingID)
      .map((row) => {
        const value = decode(row.data, schema)
        if (
          value.meetingID !== row.meeting_id ||
          ("id" in value && value.id !== row.id) ||
          (table === "plans" && value.meetingID !== row.id)
        )
          throw new Error("Corrupt record identity")
        return value
      })
  }

  private write(table: Table, value: { id: string; meetingID: string }, immutable = false): void {
    this.transaction(() => {
      const row = this.db.query<RecordRow, [string]>(`SELECT * FROM ${table} WHERE id=?`).get(value.id)
      const data = JSON.stringify(
        table === "plans" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id")) : value,
      )
      if (row && row.meeting_id !== value.meetingID) throw new Error("Record id belongs to another meeting")
      if (immutable && row && row.data !== data) throw new Error("Approval history cannot change on replay")
      this.db
        .query(
          `INSERT INTO ${table}(id,meeting_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
        )
        .run(value.id, value.meetingID, data)
    })
  }

  close() {
    this.db.close()
  }
}
