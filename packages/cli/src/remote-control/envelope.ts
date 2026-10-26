import { chunkThresholdBytes, maxChunkEnvelopeBytes, maxMessageBytes, maxSegmentCount } from "./types"

// Text-frame envelopes, controller-verbatim field sets:
//   server (host->controller): ack | server_message | server_message_chunk | pong,
//     each with client_id, seq_id, stream_id, env_id (cursor/skip_history omitted).
//   client (controller->host): client_message | client_message_chunk | ping | client_closed,
//     each with client_id, stream_id, env_id and NO seq_id; chunk reassembly is by stream_id.

export type EnvelopeEvent =
  | { readonly kind: "message"; readonly clientID: string; readonly streamID: string; readonly envID: string; readonly text: string }
  | { readonly kind: "pending" }
  | { readonly kind: "ping"; readonly clientID: string; readonly streamID: string; readonly envID: string }
  | { readonly kind: "closed"; readonly clientID: string; readonly streamID: string; readonly envID: string }
  | { readonly kind: "drop"; readonly reason: string }

type Address = { readonly clientID: string; readonly streamID: string; readonly envID: string }

export function encodeOutbound(input: {
  readonly text: string
  readonly clientID: string
  readonly streamID: string
  readonly envID: string
  readonly seqID: number
}): string[] {
  const bytes = new TextEncoder().encode(input.text)
  const base = { client_id: input.clientID, seq_id: input.seqID, stream_id: input.streamID, env_id: input.envID }
  if (bytes.byteLength <= chunkThresholdBytes)
    return [JSON.stringify({ type: "server_message", ...base, message: input.text })]
  let segmentBytes = chunkThresholdBytes
  for (;;) {
    const segmentCount = Math.ceil(bytes.byteLength / segmentBytes)
    if (segmentCount > maxSegmentCount) throw new Error("Remote-control message exceeds the segment bound")
    const frames: string[] = []
    for (let index = 0; index < segmentCount; index++) {
      const slice = bytes.subarray(index * segmentBytes, (index + 1) * segmentBytes)
      frames.push(
        JSON.stringify({
          type: "server_message_chunk",
          ...base,
          segment_id: index,
          segment_count: segmentCount,
          message_size_bytes: bytes.byteLength,
          message_chunk_base64: Buffer.from(slice).toString("base64"),
        }),
      )
    }
    const largest = frames.reduce((max, frame) => Math.max(max, new TextEncoder().encode(frame).byteLength), 0)
    if (largest <= maxChunkEnvelopeBytes) return frames
    segmentBytes = Math.max(1, Math.floor((segmentBytes * maxChunkEnvelopeBytes) / largest))
  }
}

export function encodePong(input: Address & { readonly seqID: number }) {
  return JSON.stringify({
    type: "pong",
    client_id: input.clientID,
    seq_id: input.seqID,
    stream_id: input.streamID,
    env_id: input.envID,
    status: "active",
  })
}

export function encodeAck(input: Address & { readonly seqID: number }) {
  return JSON.stringify({
    type: "ack",
    client_id: input.clientID,
    seq_id: input.seqID,
    stream_id: input.streamID,
    env_id: input.envID,
  })
}

type Partial = {
  readonly segmentCount: number
  readonly sizeBytes: number
  nextSegment: number
  received: number
  readonly parts: Buffer[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function address(record: Record<string, unknown>): Address | undefined {
  const clientID = record.client_id
  const streamID = record.stream_id
  const envID = record.env_id
  if (typeof clientID !== "string" || clientID.length === 0) return undefined
  if (typeof streamID !== "string" || streamID.length === 0) return undefined
  if (typeof envID !== "string" || envID.length === 0) return undefined
  return { clientID, streamID, envID }
}

export class Reassembler {
  readonly #partials = new Map<string, Partial>()
  readonly #maxMessageBytes: number
  readonly #maxSegmentCount: number

  constructor(options: { readonly maxMessageBytes?: number; readonly maxSegmentCount?: number } = {}) {
    this.#maxMessageBytes = options.maxMessageBytes ?? maxMessageBytes
    this.#maxSegmentCount = options.maxSegmentCount ?? maxSegmentCount
  }

  push(frame: string): EnvelopeEvent {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      return { kind: "drop", reason: "invalid_json" }
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return { kind: "drop", reason: "invalid_envelope" }
    if (parsed.type === "ping") {
      const target = address(parsed)
      return target === undefined ? { kind: "drop", reason: "missing_address" } : { kind: "ping", ...target }
    }
    if (parsed.type === "client_closed") {
      const target = address(parsed)
      return target === undefined ? { kind: "drop", reason: "missing_address" } : { kind: "closed", ...target }
    }
    if (parsed.type === "client_message") {
      const target = address(parsed)
      if (target === undefined) return { kind: "drop", reason: "missing_address" }
      const message = parsed.message
      const text = typeof message === "string" ? message : message === undefined ? undefined : JSON.stringify(message)
      if (text === undefined) return { kind: "drop", reason: "missing_message" }
      if (new TextEncoder().encode(text).byteLength > this.#maxMessageBytes) return { kind: "drop", reason: "overflow" }
      return { kind: "message", ...target, text }
    }
    if (parsed.type !== "client_message_chunk") return { kind: "drop", reason: "unknown_type" }
    const target = address(parsed)
    if (target === undefined) return { kind: "drop", reason: "missing_address" }
    return this.#chunk(target, parsed)
  }

  #chunk(target: Address, record: Record<string, unknown>): EnvelopeEvent {
    const segmentID = record.segment_id
    const segmentCount = record.segment_count
    const sizeBytes = record.message_size_bytes
    const base64 = record.message_chunk_base64
    if (
      typeof segmentID !== "number" || !Number.isInteger(segmentID) || segmentID < 0 ||
      typeof segmentCount !== "number" || !Number.isInteger(segmentCount) || segmentCount < 1 ||
      typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0 ||
      typeof base64 !== "string"
    )
      return { kind: "drop", reason: "invalid_chunk_metadata" }
    if (sizeBytes > this.#maxMessageBytes || segmentCount > this.#maxSegmentCount) return { kind: "drop", reason: "overflow" }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      return { kind: "drop", reason: "invalid_base64" }
    const part = Buffer.from(base64, "base64")
    const mapKey = `${target.clientID}\0${target.streamID}`
    const existing = this.#partials.get(mapKey)
    if (existing === undefined) {
      if (segmentID !== 0) return { kind: "drop", reason: "out_of_order" }
      const created: Partial = { segmentCount, sizeBytes, nextSegment: 1, received: part.byteLength, parts: [part] }
      if (segmentCount === 1) return this.#finish(target, created)
      this.#partials.set(mapKey, created)
      return { kind: "pending" }
    }
    if (existing.segmentCount !== segmentCount || existing.sizeBytes !== sizeBytes) {
      this.#partials.delete(mapKey)
      return { kind: "drop", reason: "metadata_mismatch" }
    }
    if (segmentID !== existing.nextSegment) {
      this.#partials.delete(mapKey)
      return { kind: "drop", reason: "out_of_order" }
    }
    existing.parts.push(part)
    existing.received += part.byteLength
    existing.nextSegment++
    if (existing.received > existing.sizeBytes) {
      this.#partials.delete(mapKey)
      return { kind: "drop", reason: "overflow" }
    }
    if (existing.nextSegment < existing.segmentCount) return { kind: "pending" }
    this.#partials.delete(mapKey)
    return this.#finish(target, existing)
  }

  #finish(target: Address, partial: Partial): EnvelopeEvent {
    const bytes = Buffer.concat(partial.parts)
    if (bytes.byteLength !== partial.sizeBytes) return { kind: "drop", reason: "size_mismatch" }
    return { kind: "message", ...target, text: bytes.toString("utf8") }
  }
}
