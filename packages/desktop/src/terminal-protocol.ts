export type TerminalReplay = { readonly type: "replay"; readonly generation: number; readonly startOffset: number; readonly endOffset: number; readonly gap: boolean }
export type TerminalChunk = { readonly type: "chunk"; readonly generation: number; readonly startOffset: number; readonly endOffset: number }
export type TerminalEnd = { readonly type: "end"; readonly generation: number; readonly reason: "exit" | "timeout" | "terminated" | "service_shutdown" | "overflow"; readonly exitCode?: number }
export type TerminalControl = TerminalReplay | TerminalChunk | TerminalEnd
export type TerminalFrame = { readonly type: "data"; readonly value: Uint8Array } | { readonly type: "control"; readonly value: TerminalControl }

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const reasons = ["exit", "timeout", "terminated", "service_shutdown", "overflow"]
const offset = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const field = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value

function control(value: unknown): TerminalControl | undefined {
  if (!value || typeof value !== "object") return undefined
  const generation = field(value, "generation"), type = field(value, "type")
  if (!offset(generation) || generation === 0) return undefined
  if (type === "replay" || type === "chunk") {
    const startOffset = field(value, "startOffset"), endOffset = field(value, "endOffset"), gap = field(value, "gap")
    if (!offset(startOffset) || !offset(endOffset) || endOffset < startOffset) return undefined
    if (type === "chunk") return { type, generation, startOffset, endOffset }
    return typeof gap === "boolean" ? { type, generation, startOffset, endOffset, gap } : undefined
  }
  if (type !== "end") return undefined
  const reason = field(value, "reason"), exitCode = field(value, "exitCode")
  if (typeof reason !== "string" || !reasons.includes(reason) || (exitCode !== undefined && !offset(exitCode))) return undefined
  return { type, generation, reason: reason as TerminalEnd["reason"], ...(exitCode === undefined ? {} : { exitCode }) }
}

export function decodeTerminalFrame(frame: string | Uint8Array | ArrayBuffer): TerminalFrame | undefined {
  const bytes = typeof frame === "string" ? encoder.encode(frame) : frame instanceof ArrayBuffer ? new Uint8Array(frame) : frame
  if (bytes[0] === 1) return { type: "data", value: bytes.subarray(1) }
  if (bytes[0] !== 0) return undefined
  try {
    const value = control(JSON.parse(decoder.decode(bytes.subarray(1))))
    return value ? { type: "control", value } : undefined
  } catch {
    return undefined
  }
}

export function toBase64(bytes: Uint8Array) {
  let text = ""
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

export function fromBase64(value: string) {
  const text = atob(value)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
  return bytes
}
