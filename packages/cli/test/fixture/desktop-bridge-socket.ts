import { EventEmitter } from "node:events"
import { Connection } from "@ycoding-ai/protocol/v5/connection"
import {
  PeerRole,
  operations,
  encodeStrict,
  FrameSchema,
  decodeStrict,
  PublicEventSchema,
  SessionLogItemSchema,
} from "@ycoding-ai/protocol/v5"

const server = new Connection({
  role: PeerRole.SERVER,
  peer: PeerRole.LOCAL_CLIENT,
  operations,
  eventTypes: [PublicEventSchema.typeName, SessionLogItemSchema.typeName],
  now: 0,
  epoch: "synthetic-connection",
  sourceEpoch: "synthetic-source",
})
export const sockets: WebSocket[] = []
export class WebSocket extends EventEmitter {
  closed = false
  paused = false
  constructor() {
    super()
    sockets.push(this)
    queueMicrotask(() => this.emit("open"))
  }
  send(bytes: Uint8Array, _options: unknown, callback: (cause?: Error) => void) {
    const reservation = server.admitIncoming(bytes.length)
    if (!reservation) throw new Error("Fixture Hello was not admitted")
    server.acceptIncoming(reservation, decodeStrict(FrameSchema, bytes), 0)
    const ready = server.prepareHandoff(0)
    if (!ready) throw new Error("Fixture Ready was not prepared")
    const payload = encodeStrict(FrameSchema, ready.frame)
    server.handoff(ready, payload.length, 0)
    callback()
    queueMicrotask(() => this.emit("message", Buffer.from(payload), true))
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
  }
  terminate() {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }
}
