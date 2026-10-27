import { createHash } from "node:crypto"
import { chunkThresholdBytes, maxChunkEnvelopeBytes, maxMessageBytes, maxSegmentCount } from "./types"

export type EnvelopeEvent =
  | ({ readonly kind: "message"; readonly text: string } & Receipt)
  | ({ readonly kind: "pending" | "ack" | "ping" | "closed" } & Receipt)
  | { readonly kind: "drop"; readonly reason: string }

type Address = { readonly clientID: string; readonly streamID: string; readonly envID: string }
type Receipt = Address & { readonly seqID: number; readonly segmentID?: number; readonly segmentCount?: number }

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
    return [JSON.stringify({ type: "server_message", ...base, message: JSON.parse(input.text) })]
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

export function encodeAck(input: Receipt) {
  return JSON.stringify({
    type: "ack",
    client_id: input.clientID,
    seq_id: input.seqID,
    stream_id: input.streamID,
    env_id: input.envID,
    ...(input.segmentID === undefined ? {} : { segment_id: input.segmentID, segment_count: input.segmentCount }),
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
  readonly #receipts = new Map<string, { readonly seqID: number; readonly fingerprints: string[] }>()
  readonly #maxMessageBytes: number
  readonly #maxSegmentCount: number

  constructor(options: { readonly maxMessageBytes?: number; readonly maxSegmentCount?: number } = {}) {
    this.#maxMessageBytes = options.maxMessageBytes ?? maxMessageBytes
    this.#maxSegmentCount = options.maxSegmentCount ?? maxSegmentCount
  }

  forget(target: Address) {
    const key = JSON.stringify([target.envID, target.clientID, target.streamID])
    this.#partials.delete(key)
    this.#receipts.delete(key)
  }

  clear() {
    this.#partials.clear()
    this.#receipts.clear()
  }

  push(frame: string): EnvelopeEvent {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      return { kind: "drop", reason: "invalid_json" }
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") return { kind: "drop", reason: "invalid_envelope" }
    if (!["ping", "client_closed", "client_message", "client_message_chunk"].includes(parsed.type))
      return { kind: "drop", reason: "unknown_type" }
    const target = address(parsed)
    if (target === undefined) return { kind: "drop", reason: "missing_address" }
    const seqID = parsed.seq_id
    if (typeof seqID !== "number" || !Number.isSafeInteger(seqID) || seqID < 0)
      return { kind: "drop", reason: "invalid_sequence" }
    const receipt = { ...target, seqID }
    if (parsed.type === "ping")
      return this.#accept(receipt, "ping", () => ({ kind: "ping", ...receipt }))
    if (parsed.type === "client_closed") {
      this.forget(target)
      return { kind: "closed", ...receipt }
    }
    if (parsed.type === "client_message") {
      const message = parsed.message
      const text = typeof message === "string" ? message : message === undefined ? undefined : JSON.stringify(message)
      if (text === undefined) return { kind: "drop", reason: "missing_message" }
      if (new TextEncoder().encode(text).byteLength > this.#maxMessageBytes) return { kind: "drop", reason: "overflow" }
      return this.#accept(receipt, `message:${text}`, () => ({ kind: "message", ...receipt, text }))
    }
    return this.#chunk(receipt, parsed)
  }

  #accept(receipt: Receipt, content: string, accept: () => EnvelopeEvent): EnvelopeEvent {
    const key = JSON.stringify([receipt.envID, receipt.clientID, receipt.streamID])
    const previous = this.#receipts.get(key)
    const fingerprint = createHash("sha256").update(content).digest("hex")
    if (previous !== undefined) {
      if (receipt.seqID < previous.seqID) return { kind: "ack", ...receipt }
      if (receipt.seqID === previous.seqID) {
        const seen = previous.fingerprints[receipt.segmentID ?? 0]
        if (seen !== undefined) {
          if (seen !== fingerprint) return { kind: "drop", reason: "sequence_conflict" }
          return content === "ping" ? { kind: "ping", ...receipt } : { kind: "ack", ...receipt }
        }
        if (!this.#partials.has(key)) return { kind: "drop", reason: "sequence_conflict" }
      }
      if (receipt.seqID > previous.seqID && this.#partials.has(key)) return { kind: "drop", reason: "out_of_order" }
    }
    const event = accept()
    if (event.kind === "drop") return event
    const current = previous?.seqID === receipt.seqID ? previous : { seqID: receipt.seqID, fingerprints: [] }
    current.fingerprints[receipt.segmentID ?? 0] = fingerprint
    this.#receipts.set(key, current)
    return event
  }

  #chunk(target: Receipt, record: Record<string, unknown>): EnvelopeEvent {
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
    if (segmentID >= segmentCount) return { kind: "drop", reason: "invalid_chunk_metadata" }
    if (sizeBytes > this.#maxMessageBytes || segmentCount > this.#maxSegmentCount) return { kind: "drop", reason: "overflow" }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
      return { kind: "drop", reason: "invalid_base64" }
    const part = Buffer.from(base64, "base64")
    const receipt = { ...target, segmentID, segmentCount }
    return this.#accept(receipt, `chunk:${segmentCount}:${sizeBytes}:${base64}`, () => this.#append(receipt, part, sizeBytes))
  }

  #append(target: Receipt & { readonly segmentID: number; readonly segmentCount: number }, part: Buffer, sizeBytes: number): EnvelopeEvent {
    const { segmentID, segmentCount } = target
    const mapKey = JSON.stringify([target.envID, target.clientID, target.streamID])
    const existing = this.#partials.get(mapKey)
    if (existing === undefined) {
      if (segmentID !== 0) return { kind: "drop", reason: "out_of_order" }
      if (part.byteLength > sizeBytes) return { kind: "drop", reason: "overflow" }
      const created: Partial = { segmentCount, sizeBytes, nextSegment: 1, received: part.byteLength, parts: [part] }
      if (segmentCount === 1) return this.#finish(target, created)
      this.#partials.set(mapKey, created)
      return { kind: "pending", ...target }
    }
    if (existing.segmentCount !== segmentCount || existing.sizeBytes !== sizeBytes) {
      return { kind: "drop", reason: "metadata_mismatch" }
    }
    if (segmentID !== existing.nextSegment) {
      return { kind: "drop", reason: "out_of_order" }
    }
    if (existing.received + part.byteLength > existing.sizeBytes) return { kind: "drop", reason: "overflow" }
    if (existing.nextSegment + 1 === existing.segmentCount && existing.received + part.byteLength !== existing.sizeBytes)
      return { kind: "drop", reason: "size_mismatch" }
    existing.parts.push(part)
    existing.received += part.byteLength
    existing.nextSegment++
    if (existing.nextSegment < existing.segmentCount) return { kind: "pending", ...target }
    this.#partials.delete(mapKey)
    return this.#finish(target, existing)
  }

  #finish(target: Receipt, partial: Partial): EnvelopeEvent {
    const bytes = Buffer.concat(partial.parts)
    if (bytes.byteLength !== partial.sizeBytes) return { kind: "drop", reason: "size_mismatch" }
    return { kind: "message", ...target, text: bytes.toString("utf8") }
  }
}
