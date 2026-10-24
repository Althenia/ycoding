export type ProjectEscalationView = readonly { readonly sessionID: string; readonly reason: string }[]
export type ProjectEscalationKind = "question" | "permission" | "review"
export type ProjectEscalationEvent = { readonly kind: ProjectEscalationKind; readonly requestID: string; readonly projectEscalation: ProjectEscalationView }

const maxReasons = 4
const maxReasonLength = 500
const maxSessionIDLength = 96

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export function readProjectEscalation(value: unknown): ProjectEscalationView | undefined {
  if (!record(value) || !Array.isArray(value.reasons) || value.reasons.length < 1 || value.reasons.length > maxReasons) return undefined
  const reasons = value.reasons.flatMap((entry): ProjectEscalationView => {
    if (!record(entry) || typeof entry.sessionID !== "string" || !entry.sessionID.startsWith("ses_") || entry.sessionID.length === 4 || entry.sessionID.length > maxSessionIDLength) return []
    if (typeof entry.reason !== "string" || entry.reason.trim() === "" || entry.reason.length > maxReasonLength) return []
    return [{ sessionID: entry.sessionID, reason: entry.reason }]
  })
  return reasons.length === value.reasons.length ? reasons : undefined
}

export function readProjectEscalationEvent(data: Record<string, unknown>): ProjectEscalationEvent | undefined {
  const projectEscalation = readProjectEscalation(data.coordinationEscalation)
  if (projectEscalation === undefined || typeof data.requestID !== "string" || data.requestID === "") return undefined
  if (data.kind !== "question" && data.kind !== "permission" && data.kind !== "review") return undefined
  return { kind: data.kind, requestID: data.requestID, projectEscalation }
}

export function projectEscalationLines(escalation: ProjectEscalationView, titleOf: (sessionID: string) => string | undefined) {
  return escalation.map((entry) => ({ sessionID: entry.sessionID, label: titleOf(entry.sessionID) ?? entry.sessionID, reason: entry.reason }))
}
