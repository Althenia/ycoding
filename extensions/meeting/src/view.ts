import type { MeetingView } from "./types"

export const meetingCommands = [
  "start",
  "stop",
  "status",
  "summary",
  "plan",
  "transcript",
  "knowledge-review",
  "models",
  "config",
  "retry",
  "reconcile",
] as const

export function parseMeetingCommand(input: string) {
  const [command, ...args] = input.trim().split(/\s+/).filter(Boolean)
  return { command, args }
}

export function isMeetingView(value: unknown): value is MeetingView {
  if (typeof value !== "object" || value === null) return false
  return (
    "meetings" in value &&
    Array.isArray(value.meetings) &&
    "segments" in value &&
    Array.isArray(value.segments) &&
    "findings" in value &&
    Array.isArray(value.findings) &&
    "proposals" in value &&
    Array.isArray(value.proposals) &&
    "config" in value &&
    typeof value.config === "object" &&
    value.config !== null &&
    "health" in value &&
    typeof value.health === "object" &&
    value.health !== null &&
    "audio" in value &&
    typeof value.audio === "object" &&
    value.audio !== null &&
    "analysis" in value &&
    typeof value.analysis === "object" &&
    value.analysis !== null
  )
}

export function displayValue(value: unknown): string {
  const text =
    typeof value === "string" ? value : value === undefined || value === null ? "—" : (JSON.stringify(value) ?? "—")
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

export function configCommand(config: Record<string, unknown>) {
  return `/meeting configure ${JSON.stringify(config)}`
}

export function meetingTranscript(view: MeetingView) {
  return view.segments.slice(-100).map((segment) => ({
    id: segment.id,
    source: segment.source,
    speaker: segment.speakerID,
    original: segment.rawText,
    corrected: segment.text,
    correctedChanged: segment.rawText !== segment.text,
    state: segment.state,
  }))
}
