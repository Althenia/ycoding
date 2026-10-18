import type { RemoteRequestOutcome } from "./transport"

export function describeOutcome(outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): string {
  if (outcome.status === "unavailable") {
    if (outcome.reason === "not-connected") return `${label} is unavailable while the relay connection is closed.`
    if (outcome.reason === "cancelled") return `${label} is unavailable because the request was cancelled.`
    if (outcome.reason === "in-flight-limit")
      return `${label} is unavailable because too many requests are already pending.`
    return `${label} is unavailable because the relay request limit was reached.`
  }
  return `${label}: ${outcome.error.message}`
}
