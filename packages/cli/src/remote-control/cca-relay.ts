export const RELAY_MESSAGE_FRAME_VERSION = 1
export const MAX_ACTIVE_NOISE_RELAY_STREAMS = 128
export const MAX_FAILED_NOISE_HANDSHAKES = 8
export const NOISE_HANDSHAKE_FAILURE_COOLDOWN_MS = 10_000
export const MAX_HARNESS_KEY_AUTHORIZATION_BYTES = 4096
export const MAX_PENDING_HANDSHAKE_VALIDATIONS = 32
export const HARNESS_KEY_VALIDATION_TIMEOUT_MS = 10_000
export const MAX_NOISE_RELAY_WEBSOCKET_MESSAGE_SIZE = 256 * 1024
export const MAX_NOISE_JSONRPC_MESSAGE_LEN = 64 * 1024 * 1024
export const NOISE_RECORD_PLAINTEXT_LEN = 60 * 1024
export const MAX_REORDER_DISTANCE = 64
export const MAX_PENDING_BYTES = 1024 * 1024
export const MAX_NOISE_CIPHERTEXT_LEN = 65535
export const NOISE_RELAY_RESET_REASON = "noise_relay_protocol_error"

export type CcaNoisePublicKey = {
  readonly suite: string
  readonly x25519_public_key: string
  readonly mlkem768_public_key: string
}

export type CcaNoiseIdentity = {
  readonly publicKey: CcaNoisePublicKey
}

export type CcaNoiseTransport = {
  encrypt(bytes: Uint8Array): Promise<Uint8Array>
  decrypt(bytes: Uint8Array): Promise<Uint8Array>
}

export type CcaNoiseAcceptHandshakeInput = {
  readonly identity: CcaNoiseIdentity
  readonly environmentID: string
  readonly registrationID: string
  readonly streamID: string
  readonly request: Uint8Array
  readonly authorize: (key: CcaNoisePublicKey, authorization: string) => Promise<void>
}

export type RelayData = {
  readonly seq: number
  readonly segment_index: number
  readonly segment_count: number
  readonly payload: Uint8Array
}

export type RelayFrameBody =
  | { readonly kind: "data"; readonly data: RelayData }
  | { readonly kind: "ack" }
  | { readonly kind: "resume"; readonly resume: { readonly next_seq: number } }
  | { readonly kind: "reset"; readonly reset: { readonly reason: string } }
  | { readonly kind: "heartbeat" }
  | { readonly kind: "handshake"; readonly handshake: { readonly payload: Uint8Array } }

export type RelayMessageFrame = {
  readonly version: number
  readonly stream_id: string
  readonly ack?: number
  readonly ack_bits?: number
  readonly body?: RelayFrameBody
  readonly traceparent?: string
  readonly tracestate?: string
}

export type CcaChannel = {
  readonly streamID: string
  readonly signal: AbortSignal
  readonly send: (applicationBytes: Uint8Array) => Promise<void>
  readonly messages: AsyncIterable<Uint8Array>
  readonly onMessage?: (listener: (bytes: Uint8Array) => Promise<void> | void) => void
}

export type WebSocketLike = {
  readonly readyState?: number
  send(data: Uint8Array | string, callback?: (error?: Error) => void): void
  ping?(data?: unknown, mask?: boolean, callback?: (error?: Error) => void): void
  close(code?: number, reason?: string): void
  on?(event: string, listener: (...args: any[]) => void): void
  off?(event: string, listener: (...args: any[]) => void): void
  removeListener?(event: string, listener: (...args: any[]) => void): void
  addEventListener?(event: string, listener: (...args: any[]) => void): void
  removeEventListener?(event: string, listener: (...args: any[]) => void): void
}

export function encodeVarint(val: number): Uint8Array {
  const bytes: number[] = []
  let v = val >>> 0
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  bytes.push(v & 0x7f)
  return new Uint8Array(bytes)
}

function decodeVarint(bytes: Uint8Array, offset: { pos: number }): number {
  let result = 0
  let shift = 0
  while (offset.pos < bytes.length) {
    const b = bytes[offset.pos++]!
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) {
      return result >>> 0
    }
    shift += 7
    if (shift > 35) {
      throw new Error("Varint too long")
    }
  }
  throw new Error("Unexpected EOF reading varint")
}

function skipField(bytes: Uint8Array, offset: { pos: number }, wireType: number): void {
  switch (wireType) {
    case 0: {
      let count = 0
      while (offset.pos < bytes.length) {
        const b = bytes[offset.pos++]!
        count++
        if ((b & 0x80) === 0) return
        if (count >= 10) throw new Error("Varint overflow")
      }
      throw new Error("Unexpected EOF skipping varint")
    }
    case 1: {
      if (offset.pos + 8 > bytes.length) throw new Error("Unexpected EOF skipping fixed64")
      offset.pos += 8
      return
    }
    case 2: {
      const len = decodeVarint(bytes, offset)
      if (offset.pos + len > bytes.length) throw new Error("Unexpected EOF skipping length-delimited field")
      offset.pos += len
      return
    }
    case 5: {
      if (offset.pos + 4 > bytes.length) throw new Error("Unexpected EOF skipping fixed32")
      offset.pos += 4
      return
    }
    default:
      throw new Error(`Unsupported wire type: ${wireType}`)
  }
}

function encodeLengthDelimited(tag: number, data: Uint8Array): Uint8Array {
  const key = encodeVarint((tag << 3) | 2)
  const len = encodeVarint(data.length)
  const result = new Uint8Array(key.length + len.length + data.length)
  result.set(key, 0)
  result.set(len, key.length)
  result.set(data, key.length + len.length)
  return result
}

function concatBuffers(buffers: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const b of buffers) totalLength += b.length
  const res = new Uint8Array(totalLength)
  let offset = 0
  for (const b of buffers) {
    res.set(b, offset)
    offset += b.length
  }
  return res
}

export function encodeRelayMessageFrame(frame: RelayMessageFrame): Uint8Array {
  const parts: Uint8Array[] = []

  if (frame.version !== undefined) {
    parts.push(encodeVarint((1 << 3) | 0))
    parts.push(encodeVarint(frame.version))
  }

  if (frame.stream_id) {
    const strBytes = new TextEncoder().encode(frame.stream_id)
    parts.push(encodeLengthDelimited(2, strBytes))
  }

  if (frame.ack !== undefined && frame.ack > 0) {
    parts.push(encodeVarint((3 << 3) | 0))
    parts.push(encodeVarint(frame.ack))
  }

  if (frame.ack_bits !== undefined && frame.ack_bits > 0) {
    parts.push(encodeVarint((4 << 3) | 0))
    parts.push(encodeVarint(frame.ack_bits))
  }

  if (frame.body) {
    switch (frame.body.kind) {
      case "data": {
        const d = frame.body.data
        const dataParts: Uint8Array[] = []
        if (d.seq !== 0) {
          dataParts.push(encodeVarint((1 << 3) | 0))
          dataParts.push(encodeVarint(d.seq))
        }
        if (d.segment_index !== 0) {
          dataParts.push(encodeVarint((2 << 3) | 0))
          dataParts.push(encodeVarint(d.segment_index))
        }
        if (d.segment_count !== 0) {
          dataParts.push(encodeVarint((3 << 3) | 0))
          dataParts.push(encodeVarint(d.segment_count))
        }
        dataParts.push(encodeLengthDelimited(4, d.payload))
        const encodedData = concatBuffers(dataParts)
        parts.push(encodeLengthDelimited(5, encodedData))
        break
      }
      case "ack": {
        parts.push(encodeLengthDelimited(6, new Uint8Array(0)))
        break
      }
      case "resume": {
        const r = frame.body.resume
        const rParts: Uint8Array[] = []
        if (r.next_seq !== 0) {
          rParts.push(encodeVarint((1 << 3) | 0))
          rParts.push(encodeVarint(r.next_seq))
        } else {
          rParts.push(encodeVarint((1 << 3) | 0))
          rParts.push(new Uint8Array([0]))
        }
        parts.push(encodeLengthDelimited(7, concatBuffers(rParts)))
        break
      }
      case "reset": {
        const resetParts: Uint8Array[] = []
        if (frame.body.reset.reason) {
          resetParts.push(encodeLengthDelimited(1, new TextEncoder().encode(frame.body.reset.reason)))
        }
        parts.push(encodeLengthDelimited(8, concatBuffers(resetParts)))
        break
      }
      case "heartbeat": {
        parts.push(encodeLengthDelimited(9, new Uint8Array(0)))
        break
      }
      case "handshake": {
        const hsParts: Uint8Array[] = []
        if (frame.body.handshake.payload) {
          hsParts.push(encodeLengthDelimited(1, frame.body.handshake.payload))
        }
        parts.push(encodeLengthDelimited(10, concatBuffers(hsParts)))
        break
      }
    }
  }

  if (frame.traceparent) {
    parts.push(encodeLengthDelimited(11, new TextEncoder().encode(frame.traceparent)))
  }

  if (frame.tracestate) {
    parts.push(encodeLengthDelimited(12, new TextEncoder().encode(frame.tracestate)))
  }

  return concatBuffers(parts)
}

export function decodeRelayMessageFrame(bytes: Uint8Array): RelayMessageFrame {
  if (bytes.length > MAX_NOISE_RELAY_WEBSOCKET_MESSAGE_SIZE) {
    throw new Error(`Relay message frame exceeds maximum length of ${MAX_NOISE_RELAY_WEBSOCKET_MESSAGE_SIZE} bytes`)
  }

  let version: number | undefined
  let streamId: string | undefined
  let ack: number | undefined
  let ackBits: number | undefined
  let body: RelayFrameBody | undefined
  let traceparent: string | undefined
  let tracestate: string | undefined

  const offset = { pos: 0 }
  while (offset.pos < bytes.length) {
    const key = decodeVarint(bytes, offset)
    const fieldNumber = key >>> 3
    const wireType = key & 0x07

    switch (fieldNumber) {
      case 1: {
        if (wireType !== 0) throw new Error("Invalid wire type for version")
        version = decodeVarint(bytes, offset)
        break
      }
      case 2: {
        if (wireType !== 2) throw new Error("Invalid wire type for stream_id")
        const len = decodeVarint(bytes, offset)
        if (offset.pos + len > bytes.length) throw new Error("Unexpected EOF reading stream_id")
        streamId = new TextDecoder().decode(bytes.subarray(offset.pos, offset.pos + len))
        offset.pos += len
        break
      }
      case 3: {
        if (wireType !== 0) throw new Error("Invalid wire type for ack")
        ack = decodeVarint(bytes, offset)
        break
      }
      case 4: {
        if (wireType !== 0) throw new Error("Invalid wire type for ack_bits")
        ackBits = decodeVarint(bytes, offset)
        break
      }
      case 5: {
        if (wireType !== 2) throw new Error("Invalid wire type for data")
        const len = decodeVarint(bytes, offset)
        const end = offset.pos + len
        if (end > bytes.length) throw new Error("Unexpected EOF reading data body")

        let seq = 0
        let segmentIndex = 0
        let segmentCount = 0
        let payload: Uint8Array | undefined

        const innerOffset = { pos: offset.pos }
        while (innerOffset.pos < end) {
          const innerKey = decodeVarint(bytes, innerOffset)
          const innerField = innerKey >>> 3
          const innerWire = innerKey & 0x07
          switch (innerField) {
            case 1:
              seq = decodeVarint(bytes, innerOffset)
              break
            case 2:
              segmentIndex = decodeVarint(bytes, innerOffset)
              break
            case 3:
              segmentCount = decodeVarint(bytes, innerOffset)
              break
            case 4: {
              const pLen = decodeVarint(bytes, innerOffset)
              if (innerOffset.pos + pLen > end) throw new Error("Unexpected EOF reading payload")
              payload = bytes.slice(innerOffset.pos, innerOffset.pos + pLen)
              innerOffset.pos += pLen
              break
            }
            default:
              skipField(bytes, innerOffset, innerWire)
          }
        }
        offset.pos = end
        body = {
          kind: "data",
          data: {
            seq,
            segment_index: segmentIndex,
            segment_count: segmentCount,
            payload: payload ?? new Uint8Array(0),
          },
        }
        break
      }
      case 6: {
        if (wireType !== 2) throw new Error("Invalid wire type for ack_frame")
        const len = decodeVarint(bytes, offset)
        offset.pos += len
        body = { kind: "ack" }
        break
      }
      case 7: {
        if (wireType !== 2) throw new Error("Invalid wire type for resume")
        const len = decodeVarint(bytes, offset)
        const end = offset.pos + len
        let nextSeq = 0
        const innerOffset = { pos: offset.pos }
        while (innerOffset.pos < end) {
          const innerKey = decodeVarint(bytes, innerOffset)
          const innerField = innerKey >>> 3
          const innerWire = innerKey & 0x07
          if (innerField === 1 && innerWire === 0) {
            nextSeq = decodeVarint(bytes, innerOffset)
          } else {
            skipField(bytes, innerOffset, innerWire)
          }
        }
        offset.pos = end
        body = { kind: "resume", resume: { next_seq: nextSeq } }
        break
      }
      case 8: {
        if (wireType !== 2) throw new Error("Invalid wire type for reset")
        const len = decodeVarint(bytes, offset)
        const end = offset.pos + len
        let reason = ""
        const innerOffset = { pos: offset.pos }
        while (innerOffset.pos < end) {
          const innerKey = decodeVarint(bytes, innerOffset)
          const innerField = innerKey >>> 3
          const innerWire = innerKey & 0x07
          if (innerField === 1 && innerWire === 2) {
            const rLen = decodeVarint(bytes, innerOffset)
            if (innerOffset.pos + rLen > end) throw new Error("Unexpected EOF reading reset reason")
            reason = new TextDecoder().decode(bytes.subarray(innerOffset.pos, innerOffset.pos + rLen))
            innerOffset.pos += rLen
          } else {
            skipField(bytes, innerOffset, innerWire)
          }
        }
        offset.pos = end
        body = { kind: "reset", reset: { reason } }
        break
      }
      case 9: {
        if (wireType !== 2) throw new Error("Invalid wire type for heartbeat")
        const len = decodeVarint(bytes, offset)
        offset.pos += len
        body = { kind: "heartbeat" }
        break
      }
      case 10: {
        if (wireType !== 2) throw new Error("Invalid wire type for handshake")
        const len = decodeVarint(bytes, offset)
        const end = offset.pos + len
        let payload: Uint8Array | undefined
        const innerOffset = { pos: offset.pos }
        while (innerOffset.pos < end) {
          const innerKey = decodeVarint(bytes, innerOffset)
          const innerField = innerKey >>> 3
          const innerWire = innerKey & 0x07
          if (innerField === 1 && innerWire === 2) {
            const pLen = decodeVarint(bytes, innerOffset)
            if (innerOffset.pos + pLen > end) throw new Error("Unexpected EOF reading handshake payload")
            payload = bytes.slice(innerOffset.pos, innerOffset.pos + pLen)
            innerOffset.pos += pLen
          } else {
            skipField(bytes, innerOffset, innerWire)
          }
        }
        offset.pos = end
        body = { kind: "handshake", handshake: { payload: payload ?? new Uint8Array(0) } }
        break
      }
      case 11: {
        if (wireType !== 2) throw new Error("Invalid wire type for traceparent")
        const len = decodeVarint(bytes, offset)
        traceparent = new TextDecoder().decode(bytes.subarray(offset.pos, offset.pos + len))
        offset.pos += len
        break
      }
      case 12: {
        if (wireType !== 2) throw new Error("Invalid wire type for tracestate")
        const len = decodeVarint(bytes, offset)
        tracestate = new TextDecoder().decode(bytes.subarray(offset.pos, offset.pos + len))
        offset.pos += len
        break
      }
      default:
        skipField(bytes, offset, wireType)
        break
    }
  }

  if (version !== RELAY_MESSAGE_FRAME_VERSION) {
    throw new Error(`Unsupported relay message frame version ${version}`)
  }

  if (!streamId || !streamId.trim()) {
    throw new Error("Relay message frame is missing stream_id")
  }

  if (!body) {
    throw new Error("Relay message frame is missing body")
  }

  if (body.kind === "data") {
    if (body.data.segment_index !== 0 || body.data.segment_count !== 1) {
      throw new Error("Relay data frame has invalid segmentation")
    }
    if (body.data.payload.length === 0) {
      throw new Error("Relay data frame has empty payload")
    }
  } else if (body.kind === "reset") {
    if (!body.reset.reason) {
      throw new Error("Relay reset frame is missing reason")
    }
  } else if (body.kind === "handshake") {
    if (body.handshake.payload.length === 0) {
      throw new Error("Relay handshake frame is missing payload")
    }
  }

  return {
    version,
    stream_id: streamId,
    ack,
    ack_bits: ackBits,
    body,
    traceparent,
    tracestate,
  }
}

export function frameMessage(message: Uint8Array, declaredLength?: number): Uint8Array {
  const len = declaredLength ?? message.length
  if (len === 0 || len > MAX_NOISE_JSONRPC_MESSAGE_LEN) {
    throw new Error("Noise relay JSON-RPC message exceeds maximum length")
  }
  const prefix = new Uint8Array(4)
  const view = new DataView(prefix.buffer)
  view.setUint32(0, len, false)
  const result = new Uint8Array(4 + message.length)
  result.set(prefix, 0)
  result.set(message, 4)
  return result
}

export class MessageDecoder {
  private buffered = new Uint8Array(0)

  get bufferedByteCount(): number {
    return this.buffered.length
  }

  push(plaintextRecord: Uint8Array): Uint8Array[] {
    if (plaintextRecord.length > NOISE_RECORD_PLAINTEXT_LEN) {
      throw new Error("Noise relay plaintext record exceeds maximum length")
    }

    const nextBuffer = new Uint8Array(this.buffered.length + plaintextRecord.length)
    nextBuffer.set(this.buffered, 0)
    nextBuffer.set(plaintextRecord, this.buffered.length)
    this.buffered = nextBuffer

    const messages: Uint8Array[] = []
    while (this.buffered.length >= 4) {
      const view = new DataView(this.buffered.buffer, this.buffered.byteOffset, this.buffered.byteLength)
      const msgLen = view.getUint32(0, false)

      if (msgLen === 0 || msgLen > MAX_NOISE_JSONRPC_MESSAGE_LEN) {
        throw new Error("Noise relay JSON-RPC message has invalid length")
      }

      const framedLen = 4 + msgLen
      if (this.buffered.length < framedLen) {
        break
      }

      messages.push(this.buffered.slice(4, framedLen))
      this.buffered = this.buffered.subarray(framedLen)
    }

    if (this.buffered.length > 4 + MAX_NOISE_JSONRPC_MESSAGE_LEN) {
      throw new Error("Noise relay JSON-RPC reassembly buffer exceeds maximum length")
    }

    return messages
  }
}

export class OrderedCiphertextFrames {
  private nextSeq = 0
  private pending = new Map<number, Uint8Array>()
  private pendingBytes = 0

  get pendingByteCount(): number {
    return this.pendingBytes
  }

  push(seq: number, payload: Uint8Array): Uint8Array[] {
    if (seq < this.nextSeq || this.pending.has(seq)) {
      return []
    }

    if (seq > this.nextSeq) {
      if (seq - this.nextSeq > MAX_REORDER_DISTANCE) {
        throw new Error("Noise relay ciphertext exceeds reorder window")
      }
      const newPendingBytes = this.pendingBytes + payload.length
      if (newPendingBytes > MAX_PENDING_BYTES) {
        throw new Error("Noise relay pending ciphertext buffer is full")
      }
      this.pending.set(seq, payload)
      this.pendingBytes = newPendingBytes
      return []
    }

    const ready: Uint8Array[] = [payload]
    this.advance()

    while (this.pending.has(this.nextSeq)) {
      const buffered = this.pending.get(this.nextSeq)!
      this.pending.delete(this.nextSeq)
      this.pendingBytes -= buffered.length
      ready.push(buffered)
      this.advance()
    }

    return ready
  }

  private advance(): void {
    if (this.nextSeq >= 0xffffffff) {
      throw new Error("Noise relay sequence number exhausted")
    }
    this.nextSeq++
  }
}

export const DEFAULT_MAX_STREAM_QUEUED_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_CARRIER_INBOUND_BYTES = 32 * 1024 * 1024

type StreamState = {
  readonly streamID: string
  readonly instanceID: number
  readonly transport: CcaNoiseTransport
  readonly abortController: AbortController
  nextOutboundSeq: number
  readonly inboundCiphertexts: OrderedCiphertextFrames
  readonly inboundDecoder: MessageDecoder
  sendMutex: Promise<void>
  readonly messageQueue: Uint8Array[]
  queuedBytes: number
  messageResolver?: (val: { value: Uint8Array; done: false } | { value: undefined; done: true }) => void
  onMessageListener?: (bytes: Uint8Array) => Promise<void> | void
}

export type CcaRelayCarrierOptions = {
  readonly environmentID: string
  readonly executorRegistrationID: string
  readonly identity: CcaNoiseIdentity
  readonly socket: WebSocketLike
  readonly authorize: (key: CcaNoisePublicKey, authorization: string, streamID: string) => Promise<void>
  readonly acceptHandshake: (input: CcaNoiseAcceptHandshakeInput) => Promise<{
    readonly response: Uint8Array
    readonly transport: CcaNoiseTransport
  }>
  readonly maxStreamQueuedBytes?: number
  readonly maxCarrierInboundBytes?: number
}

export class CcaRelayCarrier {
  private readonly environmentID: string
  private readonly executorRegistrationID: string
  private readonly identity: CcaNoiseIdentity
  private readonly socket: WebSocketLike
  private readonly authorize: (key: CcaNoisePublicKey, authorization: string, streamID: string) => Promise<void>
  private readonly acceptHandshake: (input: CcaNoiseAcceptHandshakeInput) => Promise<{
    readonly response: Uint8Array
    readonly transport: CcaNoiseTransport
  }>
  private readonly maxStreamQueuedBytes: number
  private readonly maxCarrierInboundBytes: number

  private readonly streams = new Map<string, StreamState>()
  private readonly pendingValidations = new Map<string, number>()
  private readonly streamInboundQueues = new Map<string, Promise<void>>()
  private failedHandshakes = 0
  private handshakeCooldownUntil: number | null = null
  private isClosed = false
  private closeSucceeded = true
  private channelCallback?: (channel: CcaChannel) => void | Promise<void>
  private nextInstanceID = 1
  private nextAttemptToken = 1

  private carrierInboundBytes(): number {
    let total = 0
    for (const stream of this.streams.values()) {
      total +=
        stream.queuedBytes + stream.inboundCiphertexts.pendingByteCount + stream.inboundDecoder.bufferedByteCount
    }
    return total
  }

  constructor(options: CcaRelayCarrierOptions) {
    this.environmentID = options.environmentID
    this.executorRegistrationID = options.executorRegistrationID
    this.identity = options.identity
    this.socket = options.socket
    this.authorize = options.authorize
    this.acceptHandshake = options.acceptHandshake
    this.maxStreamQueuedBytes = options.maxStreamQueuedBytes ?? DEFAULT_MAX_STREAM_QUEUED_BYTES
    this.maxCarrierInboundBytes = options.maxCarrierInboundBytes ?? DEFAULT_MAX_CARRIER_INBOUND_BYTES
  }

  onChannel(callback: (channel: CcaChannel) => void | Promise<void>): void {
    this.channelCallback = callback
  }

  private sendReset(streamID: string): void {
    try {
      const resetFrame = encodeRelayMessageFrame({
        version: RELAY_MESSAGE_FRAME_VERSION,
        stream_id: streamID,
        body: { kind: "reset", reset: { reason: NOISE_RELAY_RESET_REASON } },
      })
      this.socket.send(resetFrame)
    } catch {
    }
  }

  private recordFailedHandshake(): void {
    if (this.handshakeCooldownUntil !== null) return
    this.failedHandshakes++
    if (this.failedHandshakes >= MAX_FAILED_NOISE_HANDSHAKES) {
      this.handshakeCooldownUntil = Date.now() + NOISE_HANDSHAKE_FAILURE_COOLDOWN_MS
    }
  }

  handleIncomingFrame(bytes: Uint8Array): Promise<void> {
    if (this.isClosed) return Promise.resolve()

    let frame: RelayMessageFrame
    try {
      frame = decodeRelayMessageFrame(bytes)
    } catch {
      return Promise.resolve()
    }

    const streamID = frame.stream_id

    if (frame.body?.kind === "reset") {
      this.pendingValidations.delete(streamID)
      this.closeStream(streamID)
      return Promise.resolve()
    }

    const prev = this.streamInboundQueues.get(streamID) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        if (this.isClosed) return
        await this.processFrame(frame)
      })
      .catch(() => {})
    this.streamInboundQueues.set(streamID, next)
    void next.then(() => {
      if (this.streamInboundQueues.get(streamID) === next) {
        this.streamInboundQueues.delete(streamID)
      }
    })
    return next
  }

  private async processFrame(frame: RelayMessageFrame): Promise<void> {
    const streamID = frame.stream_id

    switch (frame.body?.kind) {
      case "handshake": {
        if (this.handshakeCooldownUntil !== null) {
          if (Date.now() < this.handshakeCooldownUntil) {
            this.sendReset(streamID)
            return
          }
          this.failedHandshakes = 0
          this.handshakeCooldownUntil = null
        }

        if (this.streams.has(streamID)) {
          this.sendReset(streamID)
          return
        }

        if (this.pendingValidations.has(streamID)) {
          this.pendingValidations.delete(streamID)
          this.sendReset(streamID)
          this.recordFailedHandshake()
          return
        }

        if (
          this.streams.size >= MAX_ACTIVE_NOISE_RELAY_STREAMS ||
          this.pendingValidations.size >= MAX_PENDING_HANDSHAKE_VALIDATIONS
        ) {
          this.sendReset(streamID)
          return
        }

        const attemptToken = this.nextAttemptToken++
        this.pendingValidations.set(streamID, attemptToken)

        let authorized = false
        const wrappedAuthorize = async (key: CcaNoisePublicKey, authorization: string) => {
          const authBytes = new TextEncoder().encode(authorization)
          if (authBytes.length === 0 || authBytes.length > MAX_HARNESS_KEY_AUTHORIZATION_BYTES) {
            throw new Error("Noise relay handshake authorization is invalid")
          }
          await this.authorize(key, authorization, streamID)
          authorized = true
        }

        let completed: { response: Uint8Array; transport: CcaNoiseTransport }
        try {
          completed = await this.acceptHandshake({
            identity: this.identity,
            environmentID: this.environmentID,
            registrationID: this.executorRegistrationID,
            streamID,
            request: frame.body.handshake.payload,
            authorize: wrappedAuthorize,
          })
        } catch {
          if (this.pendingValidations.get(streamID) === attemptToken) {
            this.pendingValidations.delete(streamID)
            this.sendReset(streamID)
            this.recordFailedHandshake()
          }
          return
        }

        if (this.pendingValidations.get(streamID) !== attemptToken || this.isClosed) {
          return
        }

        if (!authorized) {
          this.pendingValidations.delete(streamID)
          this.sendReset(streamID)
          this.recordFailedHandshake()
          return
        }

        this.pendingValidations.delete(streamID)

        const responseFrame = encodeRelayMessageFrame({
          version: RELAY_MESSAGE_FRAME_VERSION,
          stream_id: streamID,
          body: { kind: "handshake", handshake: { payload: completed.response } },
        })
        try {
          this.socket.send(responseFrame)
        } catch {
          this.sendReset(streamID)
          this.recordFailedHandshake()
          return
        }

        const instanceID = this.nextInstanceID++
        const abortController = new AbortController()
        const streamState: StreamState = {
          streamID,
          instanceID,
          transport: completed.transport,
          abortController,
          nextOutboundSeq: 0,
          inboundCiphertexts: new OrderedCiphertextFrames(),
          inboundDecoder: new MessageDecoder(),
          sendMutex: Promise.resolve(),
          messageQueue: [],
          queuedBytes: 0,
        }

        this.streams.set(streamID, streamState)

        const channel: CcaChannel = {
          streamID,
          signal: abortController.signal,
          send: async (applicationBytes: Uint8Array) => {
            if (abortController.signal.aborted) {
              throw new Error("Noise virtual stream is closed")
            }
            return new Promise<void>((resolve, reject) => {
              streamState.sendMutex = streamState.sendMutex
                .then(async () => {
                  if (abortController.signal.aborted) {
                    throw new Error("Noise virtual stream is closed")
                  }
                  const framed = frameMessage(applicationBytes)
                  for (let i = 0; i < framed.length; i += NOISE_RECORD_PLAINTEXT_LEN) {
                    const chunk = framed.subarray(i, i + NOISE_RECORD_PLAINTEXT_LEN)
                    const seq = streamState.nextOutboundSeq
                    if (seq >= 0xffffffff) {
                      throw new Error("Noise virtual stream sequence exhausted")
                    }
                    streamState.nextOutboundSeq++
                    const ciphertext = await streamState.transport.encrypt(chunk)
                    const dataWire = encodeRelayMessageFrame({
                      version: RELAY_MESSAGE_FRAME_VERSION,
                      stream_id: streamID,
                      body: {
                        kind: "data",
                        data: {
                          seq,
                          segment_index: 0,
                          segment_count: 1,
                          payload: ciphertext,
                        },
                      },
                    })
                    this.socket.send(dataWire)
                  }
                  resolve()
                })
                .catch((err) => {
                  this.retireStream(streamID, instanceID)
                  reject(err)
                })
            })
          },
          messages: {
            [Symbol.asyncIterator]() {
              return {
                next: async (): Promise<IteratorResult<Uint8Array>> => {
                  if (streamState.messageQueue.length > 0) {
                    const val = streamState.messageQueue.shift()!
                    streamState.queuedBytes -= val.length
                    return { value: val, done: false }
                  }
                  if (abortController.signal.aborted) {
                    return { value: undefined, done: true }
                  }
                  return new Promise((resolve) => {
                    streamState.messageResolver = resolve
                  })
                },
              }
            },
          },
          onMessage: (listener) => {
            streamState.onMessageListener = listener
          },
        }

        if (this.channelCallback) {
          try {
            const callbackResult = this.channelCallback(channel)
            if (callbackResult) {
              const retire = () => this.retireStream(streamID, instanceID)
              void Promise.resolve(callbackResult).then(retire, retire)
            }
          } catch {
            this.retireStream(streamID, instanceID)
          }
        }
        break
      }
      case "data": {
        const streamState = this.streams.get(streamID)
        if (!streamState) {
          if (this.pendingValidations.has(streamID)) {
            this.pendingValidations.delete(streamID)
            this.recordFailedHandshake()
          }
          this.sendReset(streamID)
          return
        }

        if (frame.body.data.payload.length > MAX_NOISE_CIPHERTEXT_LEN) {
          this.closeStream(streamID, streamState.instanceID)
          this.sendReset(streamID)
          return
        }

        if (this.carrierInboundBytes() + frame.body.data.payload.length > this.maxCarrierInboundBytes) {
          this.closeStream(streamID, streamState.instanceID)
          this.sendReset(streamID)
          return
        }

        let readyCiphertexts: Uint8Array[]
        try {
          readyCiphertexts = streamState.inboundCiphertexts.push(
            frame.body.data.seq,
            frame.body.data.payload,
          )
        } catch {
          this.closeStream(streamID, streamState.instanceID)
          this.sendReset(streamID)
          return
        }

        for (const ciphertext of readyCiphertexts) {
          if (this.streams.get(streamID) !== streamState) return
          let plaintext: Uint8Array
          try {
            plaintext = await streamState.transport.decrypt(ciphertext)
          } catch {
            this.closeStream(streamID, streamState.instanceID)
            this.sendReset(streamID)
            return
          }
          if (this.streams.get(streamID) !== streamState) return

          let messages: Uint8Array[]
          try {
            messages = streamState.inboundDecoder.push(plaintext)
          } catch {
            this.closeStream(streamID, streamState.instanceID)
            this.sendReset(streamID)
            return
          }

          for (const msg of messages) {
            if (this.streams.get(streamID) !== streamState) return
            if (streamState.onMessageListener) {
              try {
                await streamState.onMessageListener(msg)
              } catch {
                this.closeStream(streamID, streamState.instanceID)
                return
              }
            } else if (streamState.messageResolver) {
              const res = streamState.messageResolver
              streamState.messageResolver = undefined
              res({ value: msg, done: false })
            } else {
              if (streamState.queuedBytes + msg.length > this.maxStreamQueuedBytes) {
                this.closeStream(streamID, streamState.instanceID)
                this.sendReset(streamID)
                return
              }
              streamState.messageQueue.push(msg)
              streamState.queuedBytes += msg.length
            }
          }
        }
        break
      }
      case "reset": {
        this.pendingValidations.delete(streamID)
        this.closeStream(streamID)
        break
      }
      case "ack":
      case "resume":
      case "heartbeat":
        break
    }
  }

  private retireStream(streamID: string, instanceID: number): void {
    if (this.streams.get(streamID)?.instanceID !== instanceID) return
    this.closeStream(streamID, instanceID)
    this.sendReset(streamID)
  }

  private closeStream(streamID: string, instanceID?: number): void {
    const stream = this.streams.get(streamID)
    if (!stream) return
    if (instanceID !== undefined && stream.instanceID !== instanceID) return
    this.streams.delete(streamID)
    stream.queuedBytes = 0
    stream.abortController.abort()
    if (stream.messageResolver) {
      const res = stream.messageResolver
      stream.messageResolver = undefined
      res({ value: undefined, done: true })
    }
  }

  close(): boolean {
    if (this.isClosed) return this.closeSucceeded
    this.isClosed = true
    for (const streamID of Array.from(this.streams.keys())) {
      this.closeStream(streamID)
    }
    this.pendingValidations.clear()
    this.streamInboundQueues.clear()
    try {
      if (this.socket.readyState !== 3) this.socket.close()
    } catch {
      this.closeSucceeded = false
    }
    return this.closeSucceeded
  }
}
