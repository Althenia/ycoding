import type { YCodingEvent } from "@ycoding-ai/client"
import { DesktopError, type SessionSnapshot } from "./contract"

type Message = SessionSnapshot["messages"][number]

const isCheckpoint = (message: Message) =>
  (message.type === "synthetic" && message.metadata?.compactionCheckpoint !== undefined) || (message.type === "compaction" && message.status === "completed")

function settle(history: SessionSnapshot, messages: readonly Message[], before: string | undefined): SessionSnapshot {
  const boundary = messages.reduce((latest, message) => message.type === "compaction" && message.status === "completed" && "boundary" in message
    ? Math.max(latest, messages.findIndex((item) => item.id === message.boundary.messageID)) : latest, -1)
  const resident = boundary === -1 ? [...messages] : messages.filter((message, position) => position > boundary || message.type === "compaction")
  const stop = resident.some(isCheckpoint) || before === undefined
  const { before: _, ...rest } = history
  return { ...rest, messages: resident, ...(stop ? {} : { before }) }
}

function unique(messages: readonly Message[]) {
  const latest = new Map(messages.map((message) => [message.id, message]))
  return [...latest.values()]
}

export function reconcileSessionHistory(current: SessionSnapshot | undefined, next: SessionSnapshot, kind: "refresh" | "older"): SessionSnapshot {
  const same = current !== undefined && current.sessionID === next.sessionID && current.revision === next.revision && current.sourceEpoch === next.sourceEpoch
  if (kind === "older") {
    if (!same) throw new DesktopError("The older history page does not belong to the resident Session. Refresh history.")
    if (current.before === undefined) throw new DesktopError("No older history remains for this Session.")
    if (next.before !== undefined && next.before === current.before) throw new DesktopError("The older history cursor did not advance. Refresh history.")
    const known = new Map(current.messages.map((message) => [message.id, message]))
    const older = unique(next.messages).map((message) => known.get(message.id) ?? message)
    const olderIDs = new Set(older.map((message) => message.id))
    return settle(current, [...older, ...current.messages.filter((message) => !olderIDs.has(message.id))], next.before)
  }
  const messages = unique(next.messages)
  if (!same) return settle(next, messages, next.before)
  if (current.watermark.seq !== undefined && (next.watermark.seq === undefined || next.watermark.seq < current.watermark.seq))
    throw new DesktopError("The Session snapshot is older than the resident history. Refresh history.")
  const oldest = messages[0]
  const overlap = oldest === undefined || next.before === undefined || messages.some(isCheckpoint) ? -1 : current.messages.findIndex((message) => message.id === oldest.id)
  if (overlap <= 0) return settle(next, messages, next.before)
  const nextIDs = new Set(messages.map((message) => message.id))
  return settle(next, [...current.messages.slice(0, overlap).filter((message) => !nextIDs.has(message.id)), ...messages], current.before)
}

export function acceptsHistoryEvent(history: SessionSnapshot | undefined, event: YCodingEvent): boolean {
  if (history === undefined) return true
  const epoch = "sourceEpoch" in event ? event.sourceEpoch : undefined
  if (epoch !== undefined && epoch !== history.sourceEpoch) return false
  if (!("durable" in event) || event.durable.aggregateID !== history.sessionID) return true
  return history.watermark.seq === undefined || event.durable.seq > history.watermark.seq || event.type === "session.task.updated"
}
