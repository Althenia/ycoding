export * as CoordinationEscalation from "./coordination-escalation"

import { Coordination } from "@ycoding-ai/schema/coordination"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DecisionChoice } from "../decision-choice"
import { SessionReviewFold } from "./review-fold"

export interface Source {
  readonly coordinatorSessionID: Coordination.EscalationReason["sessionID"]
  readonly groupID: string
  readonly rationale: string
}

export interface Input {
  readonly fingerprint: string
  readonly source: Source
  readonly handoff: boolean
}

export interface Result<ID extends string = string> {
  readonly outcome: "escalated" | "stale"
  readonly requestID: ID
  readonly fingerprint: string
  readonly settled: false
  readonly coordinationEscalation?: Coordination.Escalation
  readonly reason?: "escalation-chain-full" | "deferred-to-review-box"
  readonly reviewItemID?: SessionReviewFold.ID
}

export type Appended =
  | { readonly type: "appended"; readonly value: Coordination.Escalation }
  | { readonly type: "unchanged" | "full"; readonly value: Coordination.Escalation }

export function append(current: Coordination.Escalation | undefined, source: Source): Appended {
  const reasons = current?.reasons ?? []
  if (current !== undefined && reasons.some((item) => item.sessionID === source.coordinatorSessionID && item.reason === source.rationale))
    return { type: "unchanged", value: current }
  if (current !== undefined && reasons.length >= Coordination.maxEscalationReasons) return { type: "full", value: current }
  return {
    type: "appended",
    value: { reasons: [...reasons, { sessionID: source.coordinatorSessionID, reason: source.rationale }] },
  }
}

export function result<ID extends string>(requestID: ID, input: Input, appended?: Appended): Result<ID> {
  const base = { requestID, fingerprint: input.fingerprint, settled: false as const }
  if (appended === undefined) return { ...base, outcome: "stale" }
  return {
    ...base,
    outcome: "escalated",
    coordinationEscalation: appended.value,
    ...(appended.type === "full" ? { reason: "escalation-chain-full" as const } : {}),
  }
}

export const deferredItem = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  input: { readonly sessionID: Coordination.EscalationReason["sessionID"]; readonly type: "permission" | "guardrail"; readonly requestID: string; readonly fingerprint: string },
) {
  const family = yield* SessionReviewFold.familyFold(db, input.sessionID)
  return family?.folded.find(
    (item) =>
      SessionReviewFold.isOpen(item) &&
      item.sessionID === input.sessionID &&
      item.payload.type === input.type &&
      "requestID" in item.payload &&
      item.payload.requestID === input.requestID &&
      item.payload.fingerprint === input.fingerprint,
  )
})

export function deferred<ID extends string>(
  requestID: ID,
  input: Input,
  item: { readonly itemID: SessionReviewFold.ID; readonly coordinationEscalation?: Coordination.Escalation },
): Result<ID> {
  return {
    requestID,
    fingerprint: input.fingerprint,
    settled: false,
    outcome: "escalated",
    reason: "deferred-to-review-box",
    reviewItemID: item.itemID,
    ...(item.coordinationEscalation === undefined ? {} : { coordinationEscalation: item.coordinationEscalation }),
  }
}

export function redacted(value: Coordination.Escalation | undefined) {
  if (value === undefined) return {}
  return {
    coordinationEscalation: {
      reasons: value.reasons.map((item) => ({ sessionID: item.sessionID, reason: DecisionChoice.redactText(item.reason).slice(0, 500) })),
    },
  }
}
