import { Connection, ReservationBudget } from "@ycoding-ai/protocol/v5/connection"
import type { Decision } from "@ycoding-ai/protocol/v5/connection"
import {
  FrameSchema,
  FailureCategory,
  PeerRole,
  WireLimit,
  operations,
  decodeStrict,
  encodeStrict,
} from "@ycoding-ai/protocol/v5"
import type { Frame } from "@ycoding-ai/protocol/v5"

export const RemoteProtocolVersion = 5
export const RemoteWebSocketPath = {
  client: "/ws/v5/client",
  agent: "/ws/v5/agent",
} as const

export const RelayLimits = Object.freeze({
  applicationBytes: 32 * 1024 * 1024,
  browserPeers: 64,
  peerMetadataBytes: 1024,
  forwardingMetadataBytes: 256,
  nativeReceiveBytes: 32 * 1024 * 1024,
})

export const remoteDescriptors = operations.filter((operation) => operation.roles.includes(PeerRole.REMOTE_CLIENT))
export const relayDescriptors = operations.filter((operation) => operation.roles.includes(PeerRole.RELAY))
export const remoteEventTypes = ["ycoding.v5.PublicEvent", "ycoding.v5.SessionLogItem"]

export function createRelayConnection(
  peer: PeerRole.AGENT | PeerRole.REMOTE_CLIENT,
  epoch: string,
  sourceEpoch: string,
  now: number,
  reservation: ReservationBudget,
) {
  return new Connection({
    role: PeerRole.RELAY,
    peer,
    epoch,
    sourceEpoch,
    now,
    reservation,
    operations,
    eventTypes: remoteEventTypes,
  })
}

export function receiveBinary(
  connection: Connection,
  data: ArrayBuffer | string,
  now: number,
): { frame?: Frame; decisions: Decision[] } {
  if (typeof data === "string") {
    return { decisions: connection.close(FailureCategory.MALFORMED) }
  }
  const token = connection.admitIncoming(data.byteLength)
  if (!token) return { decisions: connection.takeDecisions() }
  if (!connection.reservation.reserve(data.byteLength)) return { decisions: connection.close(FailureCategory.LIMIT) }
  try {
    const frame = decodeStrict(FrameSchema, new Uint8Array(data))
    return { frame, decisions: connection.acceptIncoming(token, frame, now) }
  } catch {
    return { decisions: connection.rejectIncoming(token) }
  } finally {
    connection.reservation.release(data.byteLength)
  }
}

export function frameReservation(body: Frame["body"]) {
  return encodeStrict(FrameSchema, {
    $typeName: "ycoding.v5.Frame",
    revision: 5,
    connectionEpoch: "x".repeat(64),
    ledger: body.case === "bulkPiece" ? 3 : 1,
    deliveryOrdinal: (1n << 64n) - 1n,
    tinyConsumedThrough: (1n << 64n) - 1n,
    body,
  }).byteLength
}

export function handoffBinary(
  connection: Connection,
  send: (bytes: Uint8Array, frame: Frame) => void,
  now: number,
): Decision[] {
  const decisions: Decision[] = []
  for (;;) {
    const prepared = connection.prepareHandoff(now)
    decisions.push(...connection.takeDecisions())
    if (!prepared) return decisions
    if (!connection.reservation.reserve(prepared.reservedBytes)) {
      connection.abortPrepared(prepared)
      return [...decisions, ...connection.close(FailureCategory.LIMIT)]
    }
    try {
      const bytes = encodeStrict(FrameSchema, prepared.frame)
      const accepted = connection.handoff(prepared, bytes.byteLength, now)
      decisions.push(...accepted)
      if (connection.state === "closed") return decisions
      send(bytes, prepared.frame)
    } finally {
      connection.reservation.release(prepared.reservedBytes)
    }
  }
}

export { Connection, ReservationBudget, FailureCategory, PeerRole, WireLimit }
