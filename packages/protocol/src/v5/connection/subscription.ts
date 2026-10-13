import type { Scope, EventBatch } from "../../generated/v5/index.js"

export type Subscription = {
  scope: Scope
  eventTypes: readonly string[]
  sourceEpoch: string
  hydrating: boolean
  invalidated: boolean
  ending: boolean
  resyncRequired: boolean
  buffered: { batch: EventBatch; bytes: number }[]
}

export function sameScope(left: Scope, right: Scope | undefined) {
  if (!right || left.target.case !== right.target.case) return false
  if (left.target.case === "global" || left.target.case === "machine") return true
  return left.target.value === right.target.value
}
