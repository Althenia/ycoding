export * as SessionDecisionContext from "./decision-context"

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import type { Database } from "../database/database"
import { DecisionChoice } from "../decision-choice"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { PermissionTable } from "../permission/sql"
import { Hash } from "../util/hash"
import { SessionAutonomy } from "./autonomy"
import { SessionContextState } from "./context-state"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionSummaryToon } from "./summary-toon"
import { SessionMessageTable, SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"

const deferredType = EventRuntime.versionedType(SessionEvent.Review.Deferred.type, 1)
const decidedType = EventRuntime.versionedType(SessionEvent.Review.Decided.type, 1)
const withdrawnType = EventRuntime.versionedType(SessionEvent.Review.Withdrawn.type, 1)
const decodeDeferred = Schema.decodeUnknownOption(SessionEvent.Review.Deferred.data)
const decodeDecided = Schema.decodeUnknownOption(SessionEvent.Review.Decided.data)
const decodeWithdrawn = Schema.decodeUnknownOption(SessionEvent.Review.Withdrawn.data)

const readLocal = Effect.fn("SessionDecisionContext.readLocal")(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const row = yield* db.select({ autonomy: SessionTable.autonomy, permission: SessionTable.permission, projectID: SessionTable.project_id }).from(SessionTable)
    .where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  const grants = row ? yield* db.select({ id: PermissionTable.id, projectID: PermissionTable.project_id, action: PermissionTable.action, resource: PermissionTable.resource })
    .from(PermissionTable).where(eq(PermissionTable.project_id, row.projectID))
    .orderBy(PermissionTable.id).limit(65).all().pipe(Effect.orDie) : []
  const goal = SessionAutonomy.read(row?.autonomy).goal
  const task = yield* db.select({ parentID: SessionTaskTable.parent_id }).from(SessionTaskTable)
    .where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
  const recent = yield* SessionHistory.recent(db, sessionID, 16).pipe(Effect.orDie)
  const floor = yield* SessionHistory.retainedFloor(db, sessionID)
  const userRows = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), gte(SessionMessageTable.seq, floor.seq),
  )).orderBy(desc(SessionMessageTable.seq)).limit(8).all().pipe(Effect.orDie)
  const humanRows = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), gte(SessionMessageTable.seq, floor.seq),
    sql`json_extract(${SessionMessageTable.data}, '$.metadata.inputOrigin') = 'human'`,
  )).orderBy(desc(SessionMessageTable.seq)).limit(8).all().pipe(Effect.orDie)
  const instructionRows = [...new Map([...userRows, ...humanRows].map((item) => [item.id, item])).values()].toSorted((a, b) => a.seq - b.seq)
  const instructions = yield* Effect.forEach(instructionRows, (item) =>
    Schema.decodeUnknownEffect(SessionMessage.User)({ ...item.data, id: item.id, type: item.type }).pipe(Effect.orDie),
  )
  const checkpoint = yield* SessionContextState.checkpoint(db, sessionID)
  const compaction = yield* SessionHistory.latest(db, sessionID, "compaction").pipe(Effect.orDie)
  const compacted = checkpoint?.text ?? (compaction && "summary" in compaction ? compaction.summary : undefined)
  const summary = compacted ? summaryContext(compacted, checkpoint?.coveredThrough.seq ?? floor.seq) : null
  const pending = yield* db.select({ id: SessionPendingTable.id, data: SessionPendingTable.data, seq: SessionPendingTable.admitted_seq })
    .from(SessionPendingTable).where(and(
      eq(SessionPendingTable.session_id, sessionID), eq(SessionPendingTable.type, "user"), eq(SessionPendingTable.delivery, "steer"),
    )).orderBy(desc(SessionPendingTable.admitted_seq)).limit(8).all().pipe(Effect.orDie)
  const humanPending = yield* db.select({ id: SessionPendingTable.id, data: SessionPendingTable.data, seq: SessionPendingTable.admitted_seq })
    .from(SessionPendingTable).where(and(
      eq(SessionPendingTable.session_id, sessionID), eq(SessionPendingTable.type, "user"), eq(SessionPendingTable.delivery, "steer"),
      sql`json_extract(${SessionPendingTable.data}, '$.metadata.inputOrigin') = 'human'`,
    )).orderBy(desc(SessionPendingTable.admitted_seq)).limit(8).all().pipe(Effect.orDie)
  const pendingRows = [...new Map([...pending, ...humanPending].map((item) => [item.id, item])).values()].toSorted((a, b) => a.seq - b.seq)
  const deferred = (yield* db.select({ data: EventTable.data }).from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, deferredType)))
    .orderBy(desc(EventTable.seq)).limit(8).all().pipe(Effect.orDie))
    .flatMap((item) => Option.match(decodeDeferred(item.data), { onNone: () => [], onSome: (value) => [value] }))
  const settlements = deferred.length === 0 ? [] : yield* db.select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable).where(and(
      eq(EventTable.aggregate_id, sessionID),
      inArray(EventTable.type, [decidedType, withdrawnType]),
      inArray(sql<string>`json_extract(${EventTable.data}, '$.itemID')`, deferred.map((item) => item.itemID)),
    )).orderBy(desc(EventTable.seq)).limit(24).all().pipe(Effect.orDie)
  const reviews = deferred.map((item) => {
    const settled = settlements.find((event) => event.data.itemID === item.itemID)
    const decision = settled?.type === decidedType ? decodeDecided(settled.data) : Option.none()
    const withdrawn = settled?.type === withdrawnType ? decodeWithdrawn(settled.data) : Option.none()
    return {
      id: item.itemID,
      kind: item.kind,
      status: Option.isSome(withdrawn) ? "withdrawn" : Option.isSome(decision) ? "decided" : "pending",
      reason: Option.isSome(withdrawn) ? withdrawn.value.reason : item.reason,
      ...("fingerprint" in item.payload ? { fingerprint: item.payload.fingerprint } : {}),
      ...("action" in item.payload ? { action: DecisionChoice.redactText(item.payload.action) } : {}),
      ...(Option.isSome(decision) ? { decision: DecisionChoice.redactText(JSON.stringify(decision.value.decision)).slice(0, 1000) } : {}),
    }
  })
  return {
    version: 1,
    parentID: task?.parentID ?? null,
    goal: goal ? {
      text: DecisionChoice.redactText(goal.text).slice(0, 4096),
      intent: DecisionChoice.redactText(goal.rawText ?? goal.text).slice(0, 4096),
      status: goal.status,
    } : null,
    summary,
    authorization: {
      source: "session-ceiling",
      ceiling: (row?.permission ?? []).slice(0, 64).map((rule) => ({
        action: DecisionChoice.redactText(rule.action).slice(0, 256), resource: DecisionChoice.redactText(rule.resource).slice(0, 1000), effect: rule.effect,
      })),
      truncated: (row?.permission?.length ?? 0) > 64,
      remembered: grants.slice(0, 64).map((grant) => ({
        source: "saved-project-grant", id: grant.id, projectID: grant.projectID,
        action: DecisionChoice.redactText(grant.action).slice(0, 256), resource: DecisionChoice.redactText(grant.resource).slice(0, 1000),
      })),
      rememberedTruncated: grants.length > 64,
    },
    userInstructions: instructions.map((message) => ({
      source: inputSource(message.metadata, task !== undefined), id: message.id,
      text: boundedInput(message.text), truncated: message.text.length > 4096,
    })),
    conversation: recent.flatMap((message) => {
      if (message.type === "assistant") return [{ source: "assistant", text: DecisionChoice.redactText(
        message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
      ).slice(-1024) }]
      if (message.type === "synthetic" || message.type === "system")
        return [{ source: "observation", text: DecisionChoice.redactText(message.text).slice(-1024) }]
      return []
    }),
    progress: recent.flatMap((message) => message.type === "assistant" ? [{
      messageID: message.id,
      status: message.error ? "failed" : message.time.completed === undefined ? "running" : "completed",
      ...(message.error ? { error: {
        type: message.error.type, message: DecisionChoice.redactText(message.error.message).slice(0, 500),
      } } : {}),
      tools: message.content.filter((part) => part.type === "tool").slice(-32).flatMap((part) => part.type === "tool" ? [{
        callID: part.id, name: part.name, status: part.state.status,
        ...(part.state.status === "error" ? { error: {
          type: part.state.error.type, message: DecisionChoice.redactText(part.state.error.message).slice(0, 500),
        } } : {}),
      }] : []),
    }] : []),
    pendingBlockers: [
      ...recent.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool").slice(-32).flatMap((part) =>
        part.type === "tool" && part.state.status === "running" && ["question", "form", "subagent"].includes(part.name)
          ? [{ source: "running-tool", messageID: message.id, callID: part.id, kind: part.name }]
          : [],
      ) : []),
      ...reviews.filter((item) => item.status === "pending"),
    ],
    reviewHistory: reviews.filter((item) => item.status !== "pending"),
    pendingInstructions: pendingRows.map((item) => ({
      id: item.id,
      source: inputSource("metadata" in item.data ? item.data.metadata : undefined, task !== undefined),
      text: "text" in item.data && typeof item.data.text === "string" ? boundedInput(item.data.text) : "",
      truncated: "text" in item.data && typeof item.data.text === "string" && item.data.text.length > 4096,
    })),
    coverage: {
      bounded: true,
      recentMessages: recent.length,
      userInstructions: instructions.length,
      toolPartsPerMessage: 32,
      olderHistory: compacted ? "summary" : "not included",
      summaryTruncated: summary?.truncated ?? false,
      blockers: "recent running tools and the latest eight durable reviews; the request supplies its own active blocker",
      authorization: "session ceiling, remembered project grants and request applicability; unreported input origins do not prove consent; instruction-channel text is not a native control settlement; delegated choices remain bounded by current policy; runtime permission checks remain authoritative",
      toolOutput: "omitted; never user authorization",
    },
  }
})

export const read = Effect.fn("SessionDecisionContext.read")(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const current = yield* readLocal(db, sessionID)
  const ancestors: Array<{
    source: "managed-task-parent"
    goal: typeof current.goal
    userInstructions: typeof current.userInstructions
    pendingInstructions: typeof current.pendingInstructions
    authorization: typeof current.authorization
  }> = []
  let parentID = current.parentID
  for (let depth = 0; parentID && depth < 2; depth++) {
    const parent = yield* readLocal(db, parentID)
    ancestors.push({ source: "managed-task-parent", goal: parent.goal, userInstructions: parent.userInstructions,
      pendingInstructions: parent.pendingInstructions, authorization: parent.authorization })
    parentID = parent.parentID
  }
  return { ...current, ancestors, ancestryTruncated: parentID !== null }
})

export function authorityDigest(context: Effect.Success<ReturnType<typeof read>>) {
  return Hash.json({
    goal: context.goal,
    summary: context.summary,
    authorization: context.authorization,
    userInstructions: context.userInstructions.filter((item) => item.source !== "review-decision"),
    pendingInstructions: context.pendingInstructions.filter((item) => item.source !== "review-decision"),
    ancestors: context.ancestors.map((parent) => ({ ...parent,
      userInstructions: parent.userInstructions.filter((item) => item.source !== "review-decision"),
      pendingInstructions: parent.pendingInstructions.filter((item) => item.source !== "review-decision"),
    })),
    ancestryTruncated: context.ancestryTruncated,
  })
}

function summaryContext(text: string, throughSequence: number) {
  const parsed = SessionSummaryToon.parse(text, { throughSequence, maxSummaryBytes: 8192 })
  if ("_tag" in parsed) return {
    source: "historical-summary", format: "text", text: DecisionChoice.redactText(text).slice(0, 4096), truncated: text.length > 4096,
  }
  const bounded = (values: ReadonlyArray<string>) => values.slice(0, 8).map((value) => DecisionChoice.redactText(value).slice(0, 512))
  return {
    source: "historical-summary", format: "structured", truncated: text.length > 8192 || parsed.objective.length > 2048 ||
      [parsed.requirements, parsed.constraints, parsed.blocked, parsed.completed, parsed.in_progress].some((values) =>
        values.length > 8 || values.some((value) => value.length > 512),
      ) || parsed.decision.length > 8 || parsed.decision.some((item) => item.text.length > 512),
    objective: DecisionChoice.redactText(parsed.objective).slice(0, 2048),
    decisions: parsed.decision.slice(0, 8).map((item) => ({ status: item.status, text: DecisionChoice.redactText(item.text).slice(0, 512) })),
    requirements: bounded(parsed.requirements), constraints: bounded(parsed.constraints), blocked: bounded(parsed.blocked),
    completed: bounded(parsed.completed), inProgress: bounded(parsed.in_progress),
  }
}

function boundedInput(text: string) {
  const redacted = DecisionChoice.redactText(text)
  return redacted.length <= 4096 ? redacted : `${redacted.slice(0, 2048)}\n[bounded input: middle omitted]\n${redacted.slice(-2048)}`
}

function inputSource(metadata: unknown, delegated: boolean) {
  if (metadata && typeof metadata === "object") {
    if ("inputOrigin" in metadata) {
      if (metadata.inputOrigin === "human") return "human"
      if (metadata.inputOrigin === "coordination") return "coordination"
      if (metadata.inputOrigin === "plugin")
        return "remoteMcp" in metadata && Schema.is(McpEvents.RequestContext)(metadata.remoteMcp) ? "remote-mcp" : "plugin"
      if (metadata.inputOrigin === "subagent") return "delegated-task"
      if (metadata.inputOrigin === "review") return "review-decision"
    }
  }
  return delegated ? "delegated-task" : "unreported-input"
}
