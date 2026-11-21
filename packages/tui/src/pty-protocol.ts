export * as PtyProtocol from "./pty-protocol"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
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
  return frame(0, encoder.encode(JSON.stringify(value)))
}
export function dataFrame(data: Uint8Array) {
  return frame(1, data)
}
function frame(tag: number, data: Uint8Array) {
  const out = new Uint8Array(data.length + 1)
  out[0] = tag
  out.set(data, 1)
  return out
}
export function chunks(data: Uint8Array, startOffset: number) {
  const out: { readonly startOffset: number; readonly endOffset: number; readonly data: Uint8Array }[] = []
  for (let i = 0; i < data.byteLength; i += REPLAY_CHUNK) {
    const chunk = data.subarray(i, i + REPLAY_CHUNK)
    out.push({ startOffset: startOffset + i, endOffset: startOffset + i + chunk.length, data: chunk })
  }
  return out
}
export function decodeInput(message: string | Uint8Array | ArrayBuffer) {
  if (typeof message === "string") return encoder.encode(message).length <= MAX_INPUT_BYTES ? message : undefined
  const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : message
  if (bytes.length > MAX_INPUT_BYTES) return undefined
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}
export function decodeServerFrame(message: string | Uint8Array | ArrayBuffer) {
  const bytes =
    typeof message === "string"
      ? encoder.encode(message)
      : message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : message
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
  if (!integer(generation) || generation === 0) return false
  if (type === "chunk" || type === "replay") {
    const start = field(value, "startOffset"),
      end = field(value, "endOffset")
    return (
      integer(start) && integer(end) && end >= start && (type !== "replay" || typeof field(value, "gap") === "boolean")
    )
  }
  return (
    type === "end" &&
    ["exit", "timeout", "terminated", "service_shutdown", "overflow"].includes(String(field(value, "reason"))) &&
    (field(value, "exitCode") === undefined || integer(field(value, "exitCode")))
  )
}
function field(value: object, name: string): unknown {
  return Object.getOwnPropertyDescriptor(value, name)?.value
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
