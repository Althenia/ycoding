export type TransportStatus = "unsent" | "unavailable" | "unknown" | "unsupported" | "resync" | "protocol"

export class V5ClientError extends Error {
  override readonly name = "V5ClientError"
  readonly _tag = "V5ClientError"
  constructor(
    readonly status: TransportStatus,
    readonly operation?: string,
    readonly reason?: string,
  ) {
    super(reason ?? status)
  }
}
