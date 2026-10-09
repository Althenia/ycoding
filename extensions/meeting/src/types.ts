export type AudioSource = "remote" | "microphone"

export interface Meeting {
  id: string
  title: string
  sessionID: string
  status: "ready" | "recording" | "stopping" | "stopped" | "interrupted" | "error"
  createdAt: string
  updatedAt: string
  captureID?: string
  error?: string
}

export interface TranscriptSegment {
  id: string
  meetingID: string
  sequence: number
  source: AudioSource
  speakerID: string
  startMs: number
  endMs: number
  rawText: string
  text: string
  state: "temporary" | "final"
  model: string
  createdAt: string
}

export interface Finding {
  id: string
  meetingID: string
  kind:
    | "topic"
    | "decision"
    | "proposal"
    | "requirement"
    | "action"
    | "risk"
    | "blocker"
    | "disagreement"
    | "question"
    | "claim"
  summary: string
  sourceSegmentIds: string[]
  speakerId?: string
  owner?: string
  deadline?: string
  confidence: number
  status: "unconfirmed" | "confirmed" | "rejected"
  createdAt: string
}

export interface KnowledgeReference {
  server: string
  target: string
  revision: string
  content: string
  retrievedAt: string
}

export interface KnowledgeProposal {
  id: string
  meetingID: string
  server: string
  target: string
  operation: "replace"
  existingContent: string
  suggestedContent: string
  explanation: string
  sourceSegmentIds: string[]
  references: KnowledgeReference[]
  expectedRevision: string
  confidence: number
  status: "pending" | "approved" | "rejected" | "stale" | "applying" | "applied" | "uncertain" | "failed" | "manual"
  createdAt: string
  error?: string
}

export interface SummaryCheckpoint {
  id: string
  meetingID: string
  throughSequence: number
  summary: string
  final: boolean
  createdAt: string
  latencyMs: number
}

export interface EngineeringPlan {
  meetingID: string
  content: string
  findingIds: string[]
  sourceSegmentIds: string[]
  status: "proposed" | "approved" | "rejected"
  createdAt: string
}

export interface Approval {
  id: string
  meetingID: string
  targetID: string
  decision: "approve" | "reject" | "correct"
  detail: string
  createdAt: string
}

export interface ProcessingJob {
  id: string
  meetingID: string
  kind: "transcription" | "analysis" | "knowledge"
  status: "pending" | "running" | "done" | "failed" | "interrupted"
  attempts: number
  error?: string
  updatedAt: string
}

export interface MeetingView {
  meeting?: Meeting
  meetings: Meeting[]
  segments: TranscriptSegment[]
  findings: Finding[]
  summary?: SummaryCheckpoint
  plan?: EngineeringPlan
  proposals: KnowledgeProposal[]
  health: { model: string; provider: string; device: string; status: string; warning?: string; error?: string }
  audio: {
    bufferedSeconds: number
    processedSeconds: number
    backlog: number
    error?: string
    sources?: { remote: string; microphone: string }
  }
  analysis: { status: string; error?: string; latencyMs?: number }
  pairing?: { url: string; code: string; expiresAt: number }
  config: Record<string, unknown>
}
