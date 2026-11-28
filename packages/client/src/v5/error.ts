export type TransportStatus = "unsent" | "unavailable" | "unknown" | "unsupported" | "resync" | "protocol"

export const unsentReason = {
  cancelled: "Request cancelled before transmission",
  allocation: "Request allocation limit",
  unrepresentable: "Input cannot be represented by v5",
  notAdmitted: "Request was not admitted to transport",
  busy: "Too many requests are waiting to be sent",
  closed: "Connection closed before the request was sent",
  changed: "Connection changed before the request could be sent again",
} as const

const subject = (operation: string | undefined) =>
  operation === "session.prompt" ? "Your message" : operation ? `Request ${operation}` : "The request"

function describe(status: TransportStatus, operation: string | undefined, reason: string | undefined) {
  const who = subject(operation)
  if (status === "unsent") {
    if (reason === unsentReason.cancelled) return `${who} was cancelled before it was sent.`
    if (reason === unsentReason.allocation)
      return `${who} was not sent: too much data is queued. Wait for pending requests to finish, then try again.`
    if (reason === unsentReason.unrepresentable)
      return `${who} was not sent: its input cannot be encoded for the server. Shorten or change it, then try again.`
    if (reason === unsentReason.changed)
      return `${who} was not sent again because the connection changed. Check the current state, then try again.`
    if (reason === unsentReason.notAdmitted || reason === unsentReason.busy)
      return `${who} was not sent: the server connection is busy. Try again in a moment.`
    const detail = reason && reason !== unsentReason.closed ? ` (${reason})` : ""
    return `${who} was not sent because the connection to the server was lost${detail}. Nothing changed; try again once it reconnects.`
  }
  if (status === "unknown" && (operation || !reason))
    return `${who} may not have completed: the connection changed after it was sent. Check the current state before repeating it.`
  if (reason) return reason
  if (status === "unavailable") return `${who} could not reach the server.`
  if (status === "unsupported") return `${who} is not supported by this server.`
  if (status === "resync") return `${who} needs a fresh snapshot of server state.`
  return `${who} failed because the server sent an invalid reply.`
}

export class V5ClientError extends Error {
  override readonly name = "V5ClientError"
  readonly _tag = "V5ClientError"
  constructor(
    readonly status: TransportStatus,
    readonly operation?: string,
    readonly reason?: string,
    readonly resendable = false,
    readonly sourceEpoch?: string,
  ) {
    super(describe(status, operation, reason))
  }
}
