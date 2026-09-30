import type { RemoteRequestOutcome } from "./transport"

export function describeOutcome(outcome: Exclude<RemoteRequestOutcome, { status: "ok" }>, label: string): string {
  if (outcome.status === "unavailable")
    return outcome.reason === "not-connected"
      ? `${label} is unavailable while the relay connection is closed.`
      : `${label} is unavailable because the relay request limit was reached.`
  return `${label}: ${outcome.error.message}`
}
