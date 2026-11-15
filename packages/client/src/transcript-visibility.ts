export function isInternalTranscriptEnvelope(message: {
  readonly type: string
  readonly text?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}): boolean {
  if (message.type !== "system" && message.type !== "synthetic") return false
  const metadata = message.metadata
  if (metadata?.contextSource === "session-state" || metadata?.contextSource === "team-view" || metadata?.compactionCheckpoint !== undefined || metadata?.decisionInputID !== undefined) return true
  const text = message.text?.trimStart() ?? ""
  return text.startsWith("Authoritative current Session state (JSON):") ||
    text.startsWith("Internal orchestration context (JSON).") ||
    text.startsWith("<system-update>") || text.startsWith("<conversation-checkpoint>") ||
    text.startsWith("Instructions from: ") || /^(?:#{1,6}\s+)?Guardrail decision history\s*\n+Family root:/.test(text)
}
