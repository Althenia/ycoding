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
}

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
          sourceID: extra.requestID ?? extra.itemID ?? extra.taskID ?? identifier(input.id) ?? input.id,
          ...extra,
        }

  switch (input.type) {
    case "guardrail.asked":
      return base("session.guardrail.changed", "pending", { requestID: identifier(data.id) })
    case "guardrail.replied":
      return base("session.guardrail.changed", "resolved", { requestID: identifier(data.requestID), reason: category(data.reply) })
    case "guardrail.deferred":
      return base("session.guardrail.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) })
    case "guardrail.decided":
      return base("session.guardrail.changed", data.decision === "ask" ? "pending" : "resolved", { reason: category(data.decision) })
    case "permission.asked":
      return base("session.permission.changed", "pending", { requestID: identifier(data.id), category: category(data.action) })
    case "permission.replied":
      return base("session.permission.changed", "resolved", { requestID: identifier(data.requestID), reason: category(data.reply) })
    case "permission.deferred":
      return base("session.permission.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) })
    case "question.asked":
      return base("session.question.changed", "pending", { requestID: identifier(data.id) })
    case "question.replied":
      return base("session.question.changed", "resolved", { requestID: identifier(data.requestID) })
    case "question.rejected":
      return base("session.question.changed", "cancelled", { requestID: identifier(data.requestID), reason: "rejected" })
    case "question.timed_out":
      return base("session.question.changed", "cancelled", { requestID: identifier(data.requestID), reason: "timed_out" })
    case "question.deferred":
      return base("session.question.changed", "deferred", { requestID: identifier(data.requestID), itemID: identifier(data.itemID) })
    case "form.created": {
      const form = record(data.form)
      const formSession = sessionID(form.sessionID)
      return formSession === undefined
        ? undefined
        : base("session.form.changed", "pending", { sessionID: formSession, requestID: identifier(form.id) })
    }
    case "form.replied":
      return base("session.form.changed", "resolved", { requestID: identifier(data.id) })
    case "form.cancelled":
      return base("session.form.changed", "cancelled", { requestID: identifier(data.id) })
    case "form.timed_out":
      return base("session.form.changed", "cancelled", { requestID: identifier(data.id), reason: "timed_out" })
    case "form.deferred":
      return base("session.form.changed", "deferred", { requestID: identifier(data.id), itemID: identifier(data.itemID) })
    case "session.guardrail.escalated":
      return base("session.guardrail.changed", "pending", { requestID: identifier(data.requestID) })
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
            : data.kind === "question" || data.kind === "subagent_question"
              ? "session.question.changed"
              : data.kind === "form"
                ? "session.form.changed"
                : undefined
      return name === undefined ? undefined : base(name,
        input.type === "session.review.deferred" ? "deferred" : input.type === "session.review.decided" ? "resolved" : "cancelled", {
          itemID: identifier(data.itemID),
          requestID: identifier(payload.requestID) ?? identifier(origin.requestID) ?? identifier(origin.questionID),
          reason: input.type === "session.review.withdrawn" ? category(data.reason) : category(record(data.decision).reply),
        })
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
      return base("session.completed", "completed")
    case "session.task.updated": {
      if (sid === undefined) return undefined
      const change = record(data.change)
      const extra = { taskID: sid }
      switch (change.type) {
        case "launched":
        case "started":
        case "backgrounded":
        case "resumed":
          return base("session.progress", "running", extra)
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
