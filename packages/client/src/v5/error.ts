export type TransportStatus = "unsent" | "unavailable" | "unknown" | "unsupported" | "resync" | "protocol"

const summaries: Record<TransportStatus, (request: string) => string> = {
  unsent: (request) => `${request} was not sent to the YCoding server, so nothing changed. Try again.`,
  unknown: (request) =>
    `${request} was sent, but the YCoding server did not confirm it. Check whether it took effect before trying again.`,
  unavailable: (request) =>
    `${request} failed because the YCoding server connection is unavailable. Try again after it reconnects.`,
  unsupported: (request) => `${request} is not supported by this YCoding server.`,
  resync: (request) => `${request} was interrupted. Reload the latest state from the YCoding server.`,
  protocol: (request) =>
    `${request} failed because the YCoding server connection broke a protocol rule and closed. Try again after it reconnects.`,
}

export class V5ClientError extends Error {
  override readonly name = "V5ClientError"
  readonly _tag = "V5ClientError"
  constructor(
    readonly status: TransportStatus,
    readonly operation?: string,
    readonly reason?: string,
  ) {
    super(reason ?? summaries[status](operation ? `Request ${operation}` : "The request"))
  }
}
