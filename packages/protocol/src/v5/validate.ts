import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import type { DescMessage, MessageShape } from "@bufbuild/protobuf"
import { messages, enums } from "../generated/v5/contract.js"
import {
  CONTRACT_DIGEST,
  FrameSchema,
  LosslessStringSchema,
  PeerRole,
  WireLimit,
  LedgerClass,
  SenderMask,
  TextPredicate,
} from "../generated/v5/index.js"
import type { Frame, LosslessString } from "../generated/v5/index.js"
import { validateConstraints } from "./constraints.js"
import type { Constraints } from "./constraints.js"

type Field = { integer?: bigint; bytes?: Uint8Array; message?: Node }
type Node = { name: string; fields: Map<number, Field[]> }
type Rule = {
  tag: number
  type: number
  required: boolean
  repeated: boolean
  target: string
  group?: number
  maxCount?: number
  maxCodepoints?: number
  textPolicy?: number
  constraints?: Constraints
}
const rules: Readonly<Record<string, { oneofs: number; fields: readonly Rule[] }>> = messages
const enumValues: Readonly<Record<string, readonly number[]>> = enums
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export function validateBinary(name: string, bytes: Uint8Array) {
  if (bytes.byteLength > WireLimit.BULK_MESSAGE_BYTES) throw new Error("byte limit")
  return scan(name, bytes, { count: 0, frameBytes: name === "ycoding.v5.Frame" ? bytes.length : 0 }, 0, 0)
}

function scan(
  name: string,
  bytes: Uint8Array,
  work: { count: number; frameBytes: number },
  depth: number,
  valueDepth: number,
  collectionLimit?: number,
): Node {
  const rule = rules[name]
  if (!rule) throw new Error("unknown message type")
  const values = valueDepth + Number(name === "ycoding.v5.Value")
  if (values > WireLimit.VALUE_DEPTH || depth > WireLimit.VALUE_DEPTH * 3 + 8) throw new Error("depth limit")
  const fields = new Map<number, Field[]>()
  const groups = new Set<number>()
  let offset = 0
  const varint = () => {
    let value = 0n
    for (let index = 0; index < 10; index++) {
      const byte = bytes[offset++]
      if (byte === undefined) throw new Error("truncated varint")
      if (index === 9 && byte > 1) throw new Error("varint overflow")
      value |= BigInt(byte & 127) << BigInt(index * 7)
      if (!(byte & 128)) return value
    }
    throw new Error("varint overflow")
  }
  while (offset < bytes.length) {
    if (++work.count > WireLimit.TOTAL_FIELDS) throw new Error("field count limit")
    const key = varint()
    if (key > 0xffffffffn || key < 8n) throw new Error("invalid tag")
    const tag = Number(key >> 3n)
    if (name === "ycoding.v5.Frame" && [10, 11].includes(tag) && bytes.length > WireLimit.HANDSHAKE_BYTES)
      throw new Error("handshake byte limit")
    if (name === "ycoding.v5.Frame" && tag === 14 && bytes.length > WireLimit.EVENT_BATCH_BYTES)
      throw new Error("event batch bounds")
    if (name === "ycoding.v5.Control" && tag <= 4 && work.frameBytes > WireLimit.TINY_FRAME_BYTES)
      throw new Error("tiny byte limit")
    const field = rule.fields.find((field) => field.tag === tag)
    if (!field) throw new Error("unknown field")
    const maxCount =
      field.constraints?.countMax ?? field.maxCount ?? (field.repeated && field.tag === 1 ? collectionLimit : undefined)
    if (field.repeated && maxCount !== undefined && (fields.get(tag)?.length ?? 0) >= maxCount)
      throw new Error("collection limit")
    if (!field.repeated && fields.has(tag)) throw new Error("duplicate singular")
    if (field.group !== undefined && groups.has(field.group)) throw new Error("duplicate oneof")
    if (field.group !== undefined) groups.add(field.group)
    const wire = Number(key & 7n)
    const expected = field.type === 1 ? 1 : [9, 11, 12].includes(field.type) ? 2 : 0
    if (wire !== expected) throw new Error("wire type")
    const value: Field = {}
    if (wire === 0) {
      value.integer = varint()
      if (field.type === 8 && value.integer > 1n) throw new Error("boolean")
      if (field.type === 13 && value.integer > 0xffffffffn) throw new Error("uint32 overflow")
      if (field.type === 14 && !enumValues[field.target]?.some((item) => BigInt(item) === value.integer))
        throw new Error("enum")
      if (field.constraints)
        validateConstraints(
          field.constraints,
          [3, 5].includes(field.type) ? BigInt.asIntN(field.type === 5 ? 32 : 64, value.integer) : value.integer,
        )
    }
    if (wire === 1) {
      if (bytes.length - offset < 8) throw new Error("truncated double")
      if (!Number.isFinite(new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true)))
        throw new Error("nonfinite")
      offset += 8
    }
    if (wire === 2) {
      const length = varint()
      if (length > BigInt(bytes.length - offset)) throw new Error("truncated length")
      value.bytes = bytes.subarray(offset, offset + Number(length))
      offset += Number(length)
      if (field.type === 9) utf8.decode(value.bytes)
      if (field.type === 11)
        value.message = scan(
          field.target,
          value.bytes,
          work,
          depth + 1,
          values,
          field.repeated ? undefined : field.maxCount,
        )
      if (value.message && field.maxCodepoints !== undefined) {
        const title = stringFromUnits(units(value.message))
        const policy = field.textPolicy ?? 0
        if (
          Array.from(title).length > field.maxCodepoints ||
          (policy & TextPredicate.NONEMPTY && title.length === 0) ||
          (policy & TextPredicate.TRIM_STABLE && title.trim() !== title) ||
          (policy & TextPredicate.NO_CONTROLS_OR_BIDI &&
            /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(title))
        )
          throw new Error("title constraint")
      }
      if (field.constraints)
        validateConstraints(
          field.constraints,
          undefined,
          field.type === 9
            ? utf8.decode(value.bytes)
            : field.target === "ycoding.v5.LosslessString" && value.message
              ? stringFromUnits(units(value.message))
              : undefined,
        )
    }
    const existing = fields.get(tag)
    if (existing) existing.push(value)
    if (!existing) fields.set(tag, [value])
  }
  if (groups.size !== rule.oneofs || rule.fields.some((field) => field.required && !fields.has(field.tag)))
    throw new Error("required presence")
  const node = { name, fields }
  for (const field of rule.fields) {
    if (field.repeated && field.constraints)
      validateConstraints(field.constraints, undefined, undefined, fields.get(field.tag)?.length ?? 0)
  }
  if (name === "ycoding.v5.Credit" && (integer(node, 1) === BigInt(LedgerClass.TINY) || integer(node, 2) === 0n))
    throw new Error("credit grant")
  if (name === "ycoding.v5.LosslessString") units(node)
  if (name === "ycoding.v5.ValueObject") {
    const keys = new Set<string>()
    for (const entry of fields.get(1) ?? []) {
      if (!entry.message) throw new Error("message field")
      const key = units(child(entry.message, 1)).join(",")
      if (keys.has(key)) throw new Error("duplicate object key")
      keys.add(key)
    }
  }
  return node
}

function requiredField(node: Node, tag: number) {
  const field = node.fields.get(tag)?.[0]
  if (!field) throw new Error("required presence")
  return field
}
function child(node: Node, tag: number) {
  const message = requiredField(node, tag).message
  if (!message) throw new Error("message field")
  return message
}
function integer(node: Node, tag: number) {
  const value = requiredField(node, tag).integer
  if (value === undefined) throw new Error("integer field")
  return value
}
function raw(node: Node, tag: number) {
  const bytes = requiredField(node, tag).bytes
  if (!bytes) throw new Error("bytes field")
  return bytes
}
function text(node: Node, tag: number) {
  return utf8.decode(raw(node, tag))
}

function hasLone(units: readonly number[]) {
  for (let index = 0; index < units.length; index++) {
    const unit = units[index]
    if (unit === undefined) throw new Error("missing code unit")
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1]
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        index++
        continue
      }
      return true
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true
  }
  return false
}

function units(node: Node) {
  if (node.fields.has(1)) {
    const value = text(node, 1)
    return Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))
  }
  const bytes = raw(node, 2)
  if (bytes.length % 2) throw new Error("odd UTF-16")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const value = Array.from({ length: bytes.length / 2 }, (_, index) => view.getUint16(index * 2, true))
  if (!hasLone(value)) throw new Error("noncanonical UTF-16")
  return value
}

export function encodeLossless(value: string): LosslessString {
  const units = Array.from({ length: value.length }, (_, index) => value.charCodeAt(index))
  if (!hasLone(units)) return create(LosslessStringSchema, { encoding: { case: "utf8", value } })
  const bytes = new Uint8Array(units.length * 2)
  units.forEach((unit, index) => {
    bytes[index * 2] = unit & 255
    bytes[index * 2 + 1] = unit >> 8
  })
  return create(LosslessStringSchema, { encoding: { case: "utf16LeUnits", value: bytes } })
}

export function decodeLossless(value: LosslessString, maxUnits = WireLimit.BULK_MESSAGE_BYTES / 2) {
  const decoded = units(validateBinary(LosslessStringSchema.typeName, toBinary(LosslessStringSchema, value)))
  if (decoded.length > maxUnits) throw new Error("string unit limit")
  return stringFromUnits(decoded)
}

function stringFromUnits(decoded: number[]) {
  let output = ""
  for (let index = 0; index < decoded.length; index += 8192)
    output += String.fromCharCode(...decoded.slice(index, index + 8192))
  return output
}

export function decodeStrict<T extends DescMessage>(schema: T, bytes: Uint8Array): MessageShape<T> {
  validateBinary(schema.typeName, bytes)
  return fromBinary(schema, bytes)
}

export function encodeStrict<T extends DescMessage>(schema: T, value: MessageShape<T>) {
  const bytes = toBinary(schema, value)
  validateBinary(schema.typeName, bytes)
  return bytes
}

function direction(node: Node, sender: PeerRole) {
  const name = node.name
    .slice("ycoding.v5.".length)
    .replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter}`)
    .toUpperCase()
  const mask = SenderMask[`${name}_SENDERS` as keyof typeof SenderMask]
  if (typeof mask !== "number" || !(mask & (1 << (sender - 1)))) throw new Error("direction")
}

function frameRules(node: Node, bytes: number, sender: PeerRole) {
  if (integer(node, 1) !== BigInt(WireLimit.REVISION)) throw new Error("revision")
  const tag = [...node.fields.keys()].find((tag) => tag >= 10)
  if (tag === undefined) throw new Error("body")
  const body = child(node, tag)
  const controlTag = tag === 15 ? body.fields.keys().next().value : undefined
  if (tag === 15 && controlTag === undefined) throw new Error("control")
  direction(controlTag === undefined ? body : child(body, controlTag), sender)
  if (tag === 10 || tag === 11) {
    if (bytes > WireLimit.HANDSHAKE_BYTES) throw new Error("handshake byte limit")
    if ([3, 4, 5].some((tag) => node.fields.has(tag))) throw new Error("handshake ledger")
    if (
      integer(body, 1) !== BigInt(WireLimit.REVISION) ||
      BufferHex(raw(body, 2)) !== CONTRACT_DIGEST ||
      integer(body, 3) !== BigInt(sender)
    )
      throw new Error("handshake identity")
    const windows = child(body, 4)
    for (const [tag, limit] of [
      [1, WireLimit.NORMAL_WINDOW_BYTES],
      [2, WireLimit.EVENT_WINDOW_BYTES],
      [3, WireLimit.BULK_WINDOW_BYTES],
    ] as const) {
      if (integer(windows, tag) < 1n || integer(windows, tag) > BigInt(limit)) throw new Error("window limit")
    }
    if (tag === 10 && node.fields.has(2)) throw new Error("Hello epoch")
    if (tag === 11 && (!node.fields.has(2) || !text(body, 5) || !text(body, 6) || text(node, 2) !== text(body, 6)))
      throw new Error("Ready epoch")
    return { tag, body }
  }
  const tiny = controlTag !== undefined && controlTag <= 4
  const ledger = tiny
    ? LedgerClass.TINY
    : tag === 14 || tag === 19
      ? LedgerClass.EVENT
      : tag === 17
        ? LedgerClass.BULK
        : LedgerClass.NORMAL
  if (!node.fields.has(3) || integer(node, 3) !== BigInt(ledger) || !node.fields.has(4) || integer(node, 4) < 1n)
    throw new Error("ledger header")
  if (tiny && bytes > WireLimit.TINY_FRAME_BYTES) throw new Error("tiny byte limit")
  if (tag === 12 && (!text(body, 1) || integer(body, 2) === 0n || raw(body, 4).length > WireLimit.INLINE_BODY_BYTES))
    throw new Error("request bounds")
  if (tag === 13) {
    const payload = child(body, body.fields.has(4) ? 4 : 5)
    if (
      !text(body, 1) ||
      integer(body, 2) === 0n ||
      !text(payload, 1) ||
      raw(payload, 2).length > WireLimit.INLINE_BODY_BYTES
    )
      throw new Error("result bounds")
  }
  if (
    tag === 14 &&
    (bytes > WireLimit.EVENT_BATCH_BYTES ||
      (body.fields.get(4)?.length ?? 0) > WireLimit.EVENT_BATCH_COUNT ||
      !(child(body, 2).fields.has(3) || child(body, 2).fields.has(6)))
  )
    throw new Error("event batch bounds")
  if (
    tag === 16 &&
    (integer(body, 6) > BigInt(WireLimit.BULK_MESSAGE_BYTES) ||
      integer(body, 7) < 1n ||
      integer(body, 7) > BigInt(WireLimit.BULK_PIECES))
  )
    throw new Error("bulk announcement bounds")
  if (
    tag === 17 &&
    (raw(body, 4).length > WireLimit.BULK_PIECE_BYTES ||
      integer(body, 2) >= BigInt(WireLimit.BULK_PIECES) ||
      integer(body, 3) + BigInt(raw(body, 4).length) > BigInt(WireLimit.BULK_MESSAGE_BYTES))
  )
    throw new Error("bulk piece bounds")
  if (tag === 18 && integer(body, 2) > BigInt(WireLimit.BULK_MESSAGE_BYTES)) throw new Error("bulk end bounds")
  if (tag === 19 && !text(body, 1)) throw new Error("stream end subscription")
  return { tag, body }
}

function BufferHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export class WireConnection {
  private phase: "hello" | "ready" | "confirm" | "established" = "hello"
  private epoch = ""
  private initiator?: PeerRole
  private deadline = Infinity

  constructor(
    private readonly clientRole: PeerRole = PeerRole.LOCAL_CLIENT,
    private readonly serverRole: PeerRole = PeerRole.SERVER,
  ) {
    if (
      !(
        (clientRole === PeerRole.LOCAL_CLIENT && serverRole === PeerRole.SERVER) ||
        ([PeerRole.REMOTE_CLIENT, PeerRole.AGENT].includes(clientRole) && serverRole === PeerRole.RELAY)
      )
    )
      throw new Error("peer roles")
  }

  observe(bytes: Uint8Array, sender: PeerRole, nowMs: number): Frame {
    if (!Number.isFinite(nowMs) || nowMs >= this.deadline) throw new Error("handshake timeout")
    if (sender !== this.clientRole && sender !== this.serverRole) throw new Error("authenticated peer role")
    const receiver = sender === this.clientRole ? this.serverRole : this.clientRole
    const cap =
      sender === PeerRole.AGENT || receiver === PeerRole.LOCAL_CLIENT || receiver === PeerRole.REMOTE_CLIENT
        ? WireLimit.SERVER_FRAME_BYTES
        : WireLimit.CLIENT_FRAME_BYTES
    if (bytes.length > cap) throw new Error("frame byte limit")
    if (["hello", "ready"].includes(this.phase) && bytes.length > WireLimit.HANDSHAKE_BYTES)
      throw new Error("handshake byte limit")
    const node = validateBinary(FrameSchema.typeName, bytes)
    const { tag, body } = frameRules(node, bytes.length, sender)
    if (
      (this.phase === "hello" && tag !== 10) ||
      (this.phase === "ready" && tag !== 11) ||
      (["confirm", "established"].includes(this.phase) && tag < 12)
    )
      throw new Error("handshake order")
    if (this.phase === "confirm" && (sender !== this.initiator || !(tag === 12 || (tag === 15 && body.fields.has(1)))))
      throw new Error("Ready confirmation")
    if (tag >= 12 && (!node.fields.has(2) || text(node, 2) !== this.epoch)) throw new Error("connection epoch")
    const frame = fromBinary(FrameSchema, bytes)
    if (tag === 10) {
      this.phase = "ready"
      this.initiator = sender
      this.deadline = nowMs + WireLimit.HANDSHAKE_TIMEOUT_MS
    }
    if (tag === 11) {
      this.phase = "confirm"
      this.epoch = text(body, 6)
      this.deadline = nowMs + WireLimit.HANDSHAKE_TIMEOUT_MS
    }
    if (tag >= 12) {
      this.phase = "established"
      this.deadline = Infinity
    }
    return frame
  }
}
