import { visibleTranscriptMessages, type RemoteMessageView } from "../projection"
import { mergeGuardrailDecisions, type GuardrailDecisionView } from "../decision-grades"

export type TranscriptRow =
  | { readonly kind: "message"; readonly id: string; readonly message: RemoteMessageView; readonly continued: boolean }
  | { readonly kind: "decision"; readonly id: string; readonly decision: GuardrailDecisionView }

export function rowKey(message: RemoteMessageView): string {
  return message.kind === "compaction" && message.jobID ? message.jobID : message.id
}

export function transcriptRows(messages: readonly RemoteMessageView[], decisions: readonly GuardrailDecisionView[]): readonly TranscriptRow[] {
  const checkpoint = (message: RemoteMessageView) => message.kind === "compaction" && message.status === "completed" || message.kind === "synthetic" && message.metadata?.compactionCheckpoint !== undefined
  const pending = (message: RemoteMessageView) => message.kind === "user" && message.state === "pending" || message.kind === "synthetic" && message.pending === true
  const markers = messages.filter(checkpoint)
  const floor = markers.length === 0 ? undefined : messages.flatMap((message) => message.kind !== "compaction" && !checkpoint(message) && !pending(message) && "created" in message && message.created !== undefined ? [message.created] : [])[0]
    ?? Math.max(...markers.map((message) => "created" in message ? message.created ?? 0 : 0))
  const settlements = mergeGuardrailDecisions([], decisions).filter((decision) => floor === undefined || decision.created >= floor)
  const rows: TranscriptRow[] = []
  let next = 0
  const drain = (through: number) => {
    while (next < settlements.length && settlements[next]!.created <= through) {
      const decision = settlements[next++]!
      rows.push({ kind: "decision", id: `guardrail:${decision.requestID}`, decision })
    }
  }
  const visible = visibleTranscriptMessages(messages)
  for (const message of visible.filter((message) => !pending(message))) {
    if (message.kind !== "compaction") drain("created" in message ? message.created ?? 0 : 0)
    if (message.kind !== "assistant") {
      rows.push({ kind: "message", id: rowKey(message), message, continued: false })
      continue
    }
    let start = 0
    let time = message.created
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index]!
      const at = part.kind === "text" ? time : part.started ?? time
      if (settlements[next] && settlements[next]!.created <= at) {
        if (index > start) rows.push({ kind: "message", id: segmentKey(message, start), message: { ...message, parts: message.parts.slice(start, index) }, continued: true })
        drain(at)
        start = index
      }
      time = Math.max(time, part.kind === "text" ? at : part.completed ?? at)
    }
    rows.push({ kind: "message", id: segmentKey(message, start), message: start === 0 ? message : { ...message, parts: message.parts.slice(start) }, continued: false })
  }
  drain(Infinity)
  return [...rows, ...visible.filter(pending).map((message): TranscriptRow => ({ kind: "message", id: rowKey(message), message, continued: false }))]
}

function segmentKey(message: Extract<RemoteMessageView, { kind: "assistant" }>, start: number): string {
  const part = message.parts[start]
  return start === 0 || part === undefined ? message.id : `${message.id}:${part.kind}:${part.kind === "tool" ? part.callID : part.ordinal}`
}
