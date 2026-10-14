import {
  Connection,
  PeerRole,
  remoteDescriptors,
  relayDescriptors,
  remoteEventTypes,
  decodeStrict,
  FrameSchema,
  remotePayloadCodecs,
  type Frame,
} from "@ycoding-ai/remote"
import { BinarySocket } from "./wire-peer"

export function createAgentPeer(now: () => number, handler: BinarySocket["handler"]) {
  return new BinarySocket(
    now,
    handler,
    "web-fixture-backend",
    new Connection({
      role: PeerRole.AGENT,
      peer: PeerRole.RELAY,
      now: now(),
      operations: [
        ...new Map(
          [...remoteDescriptors, ...relayDescriptors].map((operation) => [operation.operationId, operation]),
        ).values(),
      ],
      eventTypes: remoteEventTypes,
    }),
  )
}

export function binaryData(raw: string | Uint8Array): string | ArrayBuffer {
  return typeof raw === "string" ? raw : Uint8Array.from(raw).buffer
}

export function binaryFrame(raw: string | Uint8Array): Frame {
  if (typeof raw === "string") throw new Error("The v5 relay requires binary frames")
  return decodeStrict(FrameSchema, Uint8Array.from(raw))
}

export function binaryOperation(raw: string | Uint8Array) {
  const frame = binaryFrame(raw)
  if (frame.body.case !== "request") return undefined
  const operationID = frame.body.value.operationId
  return [...remotePayloadCodecs.values()].find((codec) => codec.operation.operationId === operationID)?.operation
    .diagnosticName
}

export function startAgent(peer: BinarySocket) {
  peer.open()
  peer.connection.start(peer.now())
  peer.flush()
}
