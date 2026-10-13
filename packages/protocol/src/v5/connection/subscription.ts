import type { Scope, EventBatch } from "../../generated/v5/index.js"
import { decodeLossless } from "../validate.js"

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
  if (left.target.case === "globalForm" && right.target.case === "globalForm") {
    if (!left.target.value.directory || !right.target.value.directory) return false
    return (
      decodeLossless(left.target.value.directory) === decodeLossless(right.target.value.directory) &&
      (left.target.value.workspaceId ? decodeLossless(left.target.value.workspaceId) : undefined) ===
        (right.target.value.workspaceId ? decodeLossless(right.target.value.workspaceId) : undefined)
    )
  }
  return left.target.value === right.target.value
}
