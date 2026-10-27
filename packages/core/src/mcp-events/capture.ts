export * as McpEventsCapture from "./capture"

import type { McpEvents } from "@ycoding-ai/schema/mcp-events"

export interface Notification {
  readonly name: McpEvents.Name
  readonly sessionID: string
  readonly state: McpEvents.State
  readonly sourceID: string
  readonly requestID?: string
  readonly itemID?: string
  readonly taskID?: string
  readonly category?: string
  readonly reason?: string
  readonly attention?: McpEvents.Attention
}

type AttentionOrigin = { readonly tool?: ToolSource; readonly fallback: "native" | "review" | "unreported" | "managed_task" }
type ToolSource = { readonly message_id: string; readonly call_id: string }

const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : undefined

const sessionID = (value: unknown): string | undefined => {
  const id = identifier(value)
  return id !== undefined && id.startsWith("ses") ? id : undefined
}

const category = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : undefined

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const toolSource = (value: unknown): ToolSource | undefined => {
  const source = record(value)
  const message_id = identifier(source.messageID)
  const call_id = identifier(source.callID)
  return message_id === undefined || call_id === undefined ? undefined : { message_id, call_id }
}

const firstToolSource = (...values: ReadonlyArray<unknown>) => values.map(toolSource).find((source) => source !== undefined)

const classify = (data: Record<string, unknown>): McpEvents.Attention["review"] =>
  data.hardReview === true ? "hard" : data.standard === false ? "custom" : data.standard === true ? "ordinary" : "unreported"

const attach = (
  notification: Notification | undefined,
  eventID: string,
  kind: McpEvents.Attention["kind"],
  origin: AttentionOrigin,
  review?: McpEvents.Attention["review"],
): Notification | undefined => {
  const source_event_id = identifier(eventID)
  if (notification === undefined || source_event_id === undefined) return notification
  return {
    ...notification,
    attention: {
      kind,
      origin: origin.tool
        ? { type: "tool", source_event_id, ...origin.tool }
        : { type: origin.fallback, source_event_id },
      ...(review ? { review } : {}),
      actions: ["inspect", "respond"],
    },
  }
}

export function mapEvent(input: {
  readonly type: string
  readonly id: string
  readonly data: Record<string, unknown>
}): Notification | undefined {
  const data = input.data
  const sid = sessionID(data.sessionID)
  const base = (name: McpEvents.Name, state: McpEvents.State, extra: Partial<Notification> = {}): Notification | undefined =>
    sid === undefined && extra.sessionID === undefined
      ? undefined
      : {
          name,
          sessionID: extra.sessionID ?? sid ?? "",
          state,
          sourceID: input.id,
          ...extra,
        }

  switch (input.type) {
    case "guardrail.asked": {
      const metadata = record(data.metadata)
      return attach(base("session.guardrail.changed", "pending", { requestID: identifier(data.id) }), input.id, "guardrail",
        { tool: firstToolSource(data.source, metadata.source, metadata.tool), fallback: "unreported" }, classify(data))
    }
    case "guardrail.replied":
      return base("session.guardrail.changed", "resolved", { requestID: identifier(data.requestID), reason: category(data.reply) })
    case "guardrail.cancelled":
      return base("session.guardrail.changed", "cancelled", { requestID: identifier(data.requestID) })
    case "guardrail.deferred":
      return attach(base("session.guardrail.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) }), input.id, "guardrail", { fallback: "review" }, "unreported")
    case "guardrail.decided":
      return base("session.guardrail.changed", data.decision === "ask" ? "pending" : "resolved", { reason: category(data.decision) })
    case "permission.asked": {
      const source = record(data.source)
      return attach(base("session.permission.changed", "pending", { requestID: identifier(data.id), category: category(data.action) }), input.id, "permission",
        { tool: source.type === "tool" ? toolSource(source) : undefined, fallback: "unreported" })
    }
    case "permission.replied":
      return base("session.permission.changed", "resolved", { requestID: identifier(data.requestID), reason: category(data.reply) })
    case "permission.cancelled":
      return base("session.permission.changed", "cancelled", { requestID: identifier(data.requestID) })
    case "permission.deferred":
      return attach(base("session.permission.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) }), input.id, "permission", { fallback: "review" })
    case "question.asked":
      return attach(base("session.question.changed", "pending", { requestID: identifier(data.id) }), input.id, "question", { tool: toolSource(data.tool), fallback: "native" })
    case "question.replied":
      return base("session.question.changed", "resolved", { requestID: identifier(data.requestID) })
    case "question.rejected":
      return base("session.question.changed", "cancelled", { requestID: identifier(data.requestID), reason: "rejected" })
    case "question.timed_out":
      return base("session.question.changed", "cancelled", { requestID: identifier(data.requestID), reason: "timed_out" })
    case "question.deferred":
      return attach(base("session.question.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) }), input.id, "question", { fallback: "review" })
    case "form.created": {
      const form = record(data.form)
      const formSession = sessionID(form.sessionID)
      return formSession === undefined
        ? undefined
        : attach(base("session.form.changed", "pending", { sessionID: formSession, requestID: identifier(form.id) }), input.id, "form",
            { tool: toolSource(record(form.metadata).tool), fallback: "native" })
    }
    case "form.replied":
      return base("session.form.changed", "resolved", { requestID: identifier(data.id) })
    case "form.cancelled":
      return base("session.form.changed", "cancelled", { requestID: identifier(data.id) })
    case "form.timed_out":
      return base("session.form.changed", "cancelled", { requestID: identifier(data.id), reason: "timed_out" })
    case "form.deferred":
      return attach(base("session.form.changed", "deferred", { requestID: identifier(data.id), itemID: identifier(data.itemID) }), input.id, "form", { fallback: "review" })
    case "session.guardrail.decided":
      return base("session.guardrail.changed", "resolved", {
        sessionID: sessionID(data.reviewSessionID) ?? sid,
        requestID: identifier(data.requestID),
        reason: category(data.reply),
      })
    case "session.guardrail.approved":
      return base("session.guardrail.changed", "resolved", { reason: "approved" })
    case "session.guardrail.dismissed":
      return base("session.guardrail.changed", "resolved", {
        sessionID: sessionID(data.reviewSessionID) ?? sid,
        category: category(data.ruleID),
        reason: "dismissed",
      })
    case "session.review.deferred":
    case "session.review.decided":
    case "session.review.withdrawn": {
      const payload = record(data.payload)
      const origin = record(data.origin)
      const name: McpEvents.Name | undefined =
        payload.type === "form"
          ? "session.form.changed"
          : data.kind === "guardrail"
          ? "session.guardrail.changed"
          : data.kind === "permission"
            ? "session.permission.changed"
            : data.kind === "question" || data.kind === "subagent_question" || data.kind === "recovery"
              ? "session.question.changed"
              : data.kind === "form"
                ? "session.form.changed"
                : undefined
      if (name === undefined) return undefined
      const notification = base(name,
        input.type === "session.review.deferred" ? "deferred" : input.type === "session.review.decided" ? "resolved" : "cancelled", {
          itemID: identifier(data.itemID),
          requestID: identifier(payload.requestID) ?? identifier(origin.requestID) ?? identifier(origin.questionID),
          reason: input.type === "session.review.withdrawn" ? category(data.reason) : category(record(data.decision).reply),
        })
      if (input.type !== "session.review.deferred") return notification
      const kind = payload.type === "form" ? "form" : data.kind
      if (kind !== "guardrail" && kind !== "permission" && kind !== "question" && kind !== "form" && kind !== "subagent_question" && kind !== "recovery") return notification
      return attach(notification, input.id, kind, { tool: kind === "recovery" ? undefined : toolSource(data.origin), fallback: "review" }, kind === "guardrail" ? classify(payload) : undefined)
    }
    case "session.execution.started":
      return base("session.progress", "running")
    case "session.execution.succeeded":
      return base("session.progress", "completed")
    case "session.execution.interrupted":
      return base("session.progress", "interrupted", { reason: category(data.reason) })
    case "session.execution.failed":
      return base("session.error", "failed", { category: category(record(data.error).type) })
    case "session.work.completed":
      return base("session.completed", "completed", { requestID: identifier(data.inputID), sourceID: identifier(input.id) ?? input.id })
    case "session.dots.report.recorded": {
      const envelope = record(data.envelope)
      const requestID = identifier(envelope.replyToMessageID)
      if (!requestID || !["progress", "blocker", "decision_request"].includes(String(envelope.kind))) return undefined
      return base("session.progress", "running", { requestID, category: category(envelope.kind), sourceID: identifier(input.id) ?? input.id })
    }
    case "session.task.updated": {
      if (sid === undefined) return undefined
      const change = record(data.change)
      const extra = { taskID: sid }
      switch (change.type) {
        case "launched":
        case "started":
        case "backgrounded":
        case "resumed":
        case "progressed":
          return base("session.progress", "running", extra)
        case "question_asked":
          return attach(base("session.question.changed", "pending", { ...extra, requestID: identifier(record(change.question).id) }), input.id, "subagent_question", { fallback: "managed_task" })
        case "question_answered":
          return base("session.question.changed", "resolved", { ...extra, requestID: identifier(record(change.answer).questionID) })
        case "question_timed_out":
          return base("session.question.changed", "cancelled", { ...extra, requestID: identifier(change.questionID), reason: "timed_out" })
        case "completed":
          return base("session.progress", "completed", extra)
        case "cancelled":
          return base("session.progress", "cancelled", extra)
        case "lost":
          return base("session.progress", "cancelled", { ...extra, reason: "lost" })
        case "failed":
          return base("session.error", "failed", extra)
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

export const REPLAYABLE: ReadonlySet<McpEvents.Name> = new Set(["session.progress", "session.completed", "session.error"])
export const ATTENTION: ReadonlySet<McpEvents.Name> = new Set([
  "session.guardrail.changed",
  "session.permission.changed",
  "session.question.changed",
  "session.form.changed",
])
export const EPHEMERAL_ATTENTION: ReadonlySet<McpEvents.Name> = new Set([
  "session.guardrail.changed",
  "session.permission.changed",
  "session.question.changed",
  "session.form.changed",
])
