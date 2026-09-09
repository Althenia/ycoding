export * as PtyProtocol from "./protocol"

// Wire protocol for PTY websocket transports. The PTY domain service is transport-free; server
// routes adapt Pty.attach to websockets with these helpers so every surface speaks one protocol.
//
// Every outbound websocket frame is tagged so terminal bytes can never be mistaken for control
// data. Control frames are 0x00 + UTF-8 JSON; terminal data frames are 0x01 + opaque bytes.

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

// Replay can be megabytes; send it in bounded frames.
export const REPLAY_CHUNK = 64 * 1024
export const MAX_INPUT_BYTES = 64 * 1024

export type ReplayControl = {
  readonly type: "replay"
  readonly generation: number
  readonly startOffset: number
  readonly endOffset: number
  readonly gap: boolean
}

export type ChunkControl = {
  readonly type: "chunk"
  readonly generation: number
  readonly startOffset: number
  readonly endOffset: number
}

export type EndControl = {
  readonly type: "end"
  readonly generation: number
  readonly reason: "exit" | "timeout" | "terminated" | "service_shutdown" | "overflow"
  readonly exitCode?: number
}

export type Control = ReplayControl | ChunkControl | EndControl

export function controlFrame(value: Control) {
  const bytes = encoder.encode(JSON.stringify(value))
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

export function dataFrame(data: Uint8Array) {
  const out = new Uint8Array(data.byteLength + 1)
  out[0] = 1
  out.set(data, 1)
  return out
}

export function chunks(data: Uint8Array, startOffset: number) {
  const out: Array<{ readonly startOffset: number; readonly endOffset: number; readonly data: Uint8Array }> = []
  for (let i = 0; i < data.byteLength; i += REPLAY_CHUNK) {
    const chunk = data.subarray(i, i + REPLAY_CHUNK)
    out.push({ startOffset: startOffset + i, endOffset: startOffset + i + chunk.byteLength, data: chunk })
  }
  return out
}

// Inbound client frames are UTF-8 text or binary; invalid UTF-8 input is dropped.
export function decodeInput(message: string | Uint8Array | ArrayBuffer) {
  if (typeof message === "string") return encoder.encode(message).byteLength <= MAX_INPUT_BYTES ? message : undefined
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message
  if (bytes.byteLength > MAX_INPUT_BYTES) return undefined
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

export function decodeServerFrame(frame: string | Uint8Array | ArrayBuffer) {
  const bytes = typeof frame === "string" ? encoder.encode(frame) : frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame
  if (bytes[0] === 1) return { type: "data" as const, value: bytes.subarray(1) }
  if (bytes[0] !== 0) return undefined
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes.subarray(1)))
    return isControl(value) ? { type: "control" as const, value } : undefined
  } catch {
    return undefined
  }
}

function isControl(value: unknown): value is Control {
  if (!value || typeof value !== "object") return false
  const generation = field(value, "generation")
  const type = field(value, "type")
  if (!positive(generation)) return false
  if (type === "replay") {
    const startOffset = field(value, "startOffset")
    const endOffset = field(value, "endOffset")
    return offset(startOffset) && offset(endOffset) && endOffset >= startOffset && typeof field(value, "gap") === "boolean"
  }
  if (type === "chunk") {
    const startOffset = field(value, "startOffset")
    const endOffset = field(value, "endOffset")
    return offset(startOffset) && offset(endOffset) && endOffset >= startOffset
  }
  if (type !== "end") return false
  const reason = field(value, "reason")
  const exitCode = field(value, "exitCode")
  return (
    ["exit", "timeout", "terminated", "service_shutdown", "overflow"].includes(String(reason)) &&
    (exitCode === undefined || offset(exitCode))
  )
}

function field(value: object, key: PropertyKey): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
